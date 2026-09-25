// 「循证 GEO」 for the runtime's `geo_read`, `geo_write` and
// `social_posts_search` tools (build spec 2026-09-25 §4).
//
// The same shape as every internal gateway (layer 3): one path prefix, one
// handler, closed fields, and the runtime's own model-gateway token as the
// only credential. The token — never anything the runtime says — names the
// account and the project, and the project names the GEO project: there is no
// id parameter a run could point at another account's data.
//
//   POST /internal/geo/v1/read    {what, filter?}          → the page's shapes (geoService.runtimeRead)
//   POST /internal/geo/v1/write   {what, items? | data?}   → {ok, ids, issues[]} (geoWrites.mjs)
//   POST /internal/geo/v1/social  {query, platforms?, sort?, limit?} → minimised posts (socialCrawlClient.mjs)
//
// Hidden knowledge:
//
// - Switched off, or not open to this account, answers `geo_disabled`; a read
//   or write from a conversation outside a GEO project answers
//   `geo_no_project` (the tool reports that as a warning: nothing is wrong,
//   there is simply no project data here). The social search reads no project
//   data and answers in any conversation of an account the module is open to.
//   The runtime is normally not even given the address when the module is off
//   (`runtimeManager.mjs`); `geo_disabled` is for a runtime started before the
//   switch moved. Either way the run goes on with its other tools.
// - A write refuses item by item: a 200 with `ok: false` and the issues is a
//   write that wrote nothing, not an error. An error code here means the call
//   itself could not be read — a `what` outside the vocabulary, a payload of
//   the wrong shape, a filter with an unknown engine.
// - What failed underneath (a database's SQLSTATE) is the operator's to know
//   and never the run's: its code goes to `report`, the run hears
//   `geo_gateway_unavailable`.
// - Only this file's error codes are double-quoted string literals starting
//   `geo_` or `social_posts_`: `agentRuns.test.mjs` scans them and holds every
//   one classified recoverable or terminal.

import {
  GEO_ENGINES, GEO_POOLS, GEO_READ_WHATS, GEO_SOCIAL_PLATFORMS, GEO_SOCIAL_SORTS, GEO_WRITE_WHATS,
} from "@evimed/domain";
import { geoRowIdShape, geoRuntimeWrite } from "./geoWrites.mjs";
import { GEO_READ_MAX_ITEMS } from "./geoService.mjs";
import { HttpError } from "./security.mjs";
import { SOCIAL_DEFAULT_LIMIT, SOCIAL_MAX_LIMIT, SOCIAL_MAX_QUERY_LENGTH } from "./socialCrawlClient.mjs";

const gatewayPath = "/internal/geo/v1";
const operations = Object.freeze(["read", "write", "social"]);
/** Calls one project may make per minute, per operation: the ceiling of a loop, not of a run. */
const windowLimits = Object.freeze({ read: 120, write: 60, social: 12 });
const requestLimits = Object.freeze({ read: 16 * 1024, write: 300 * 1024, social: 8 * 1024 });
/** Reads and writes answer within ten seconds; a social crawl within the channel's own timeout. */
const answerBudgetMs = 10_000;
const readFilterFields = Object.freeze(["round", "engine", "pool", "groupId", "questionId", "limit", "offset"]);
/** The write module's refusals of a whole call, which reach the run as they are. */
const passThroughCodes = new Set(["geo_write_what_invalid", "geo_write_payload_invalid", "geo_request_too_large", "geo_read_what_invalid"]);

class GeoGatewayError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** @param {number} status @param {string} code @param {string} message */
const gatewayError = (status, code, message) => new GeoGatewayError(status, code, message);

/** @param {any} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
  res.end(body);
}

/** Past this, a body is not drained but cut off. */
const drainLimit = 4 * 1024 * 1024;

/**
 * A request body as one JSON object. A body over the limit is drained (up to
 * four megabytes) before the 413 goes out: answering mid-upload resets the
 * connection, and the run would read a reset as an unreachable gateway — a
 * retry — instead of a write it has to make smaller.
 * @param {any} req @param {number} maxBytes
 */
async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > drainLimit) throw gatewayError(413, "geo_request_too_large", "The GEO request was too large.");
    if (total <= maxBytes) chunks.push(chunk);
  }
  if (total > maxBytes) throw gatewayError(413, "geo_request_too_large", "The GEO request was too large.");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return /** @type {Record<string, any>} */ (value);
  } catch {
    throw gatewayError(400, "geo_request_invalid", "The GEO request was not a JSON object.");
  }
}

/** @param {Record<string, any>} body @param {readonly string[]} allowed */
function onlyFields(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw gatewayError(400, "geo_request_invalid", `The GEO request takes only: ${allowed.join(", ")}.`);
  }
}

/** @param {Record<string, any>} body */
function readRequest(body) {
  onlyFields(body, ["what", "filter"]);
  if (typeof body.what !== "string" || !GEO_READ_WHATS.includes(body.what)) {
    throw gatewayError(400, "geo_read_what_invalid", `what must be one of: ${GEO_READ_WHATS.join(", ")}.`);
  }
  const raw = body.filter ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !readFilterFields.includes(key))) {
    throw gatewayError(400, "geo_read_filter_invalid", `filter takes only: ${readFilterFields.join(", ")}.`);
  }
  /** @type {{ round?: string, engine?: string, pool?: string, groupId?: string, questionId?: string, limit?: number, offset?: number }} */
  const filter = {};
  for (const key of ["round", "groupId", "questionId"]) {
    if (raw[key] == null) continue;
    if (!geoRowIdShape(raw[key])) throw gatewayError(400, "geo_read_filter_invalid", `filter.${key} is not an id.`);
    /** @type {any} */ (filter)[key] = raw[key];
  }
  if (raw.engine != null) {
    if (!GEO_ENGINES.includes(raw.engine)) throw gatewayError(400, "geo_read_filter_invalid", `filter.engine must be one of: ${GEO_ENGINES.join(", ")}.`);
    filter.engine = raw.engine;
  }
  if (raw.pool != null) {
    if (!GEO_POOLS.includes(raw.pool)) throw gatewayError(400, "geo_read_filter_invalid", `filter.pool must be one of: ${GEO_POOLS.join(", ")}.`);
    filter.pool = raw.pool;
  }
  if (raw.limit != null) {
    if (!Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > GEO_READ_MAX_ITEMS) {
      throw gatewayError(400, "geo_read_filter_invalid", `filter.limit must be a whole number from 1 to ${GEO_READ_MAX_ITEMS}.`);
    }
    filter.limit = raw.limit;
  }
  if (raw.offset != null) {
    if (!Number.isSafeInteger(raw.offset) || raw.offset < 0 || raw.offset > 10_000) {
      throw gatewayError(400, "geo_read_filter_invalid", "filter.offset must be a whole number from 0 to 10000.");
    }
    filter.offset = raw.offset;
  }
  return { what: body.what, filter };
}

/** @param {Record<string, any>} body */
function writeRequest(body) {
  onlyFields(body, ["what", "items", "data"]);
  if (typeof body.what !== "string" || !GEO_WRITE_WHATS.includes(body.what)) {
    throw gatewayError(400, "geo_write_what_invalid", `what must be one of: ${GEO_WRITE_WHATS.join(", ")}.`);
  }
  if (body.items != null && body.data != null) throw gatewayError(400, "geo_write_payload_invalid", "A write carries items or data, not both.");
  return { what: body.what, body: { items: body.items, data: body.data } };
}

/** @param {Record<string, any>} body */
function socialRequest(body) {
  onlyFields(body, ["query", "platforms", "sort", "limit"]);
  const query = typeof body.query === "string" ? body.query.replace(/\s+/g, " ").trim() : "";
  if (!query || [...query].length > SOCIAL_MAX_QUERY_LENGTH || [...query].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw gatewayError(400, "social_posts_query_invalid", `query must be text of 1 to ${SOCIAL_MAX_QUERY_LENGTH} characters.`);
  }
  // One platform per call: the crawler serves one request at a time and one
  // crawl takes 30–120 s (production, 2026-09-25), so more than one does not
  // fit under the kernel's 180 s tool-call ceiling.
  if (!Array.isArray(body.platforms) || body.platforms.length !== 1 || !GEO_SOCIAL_PLATFORMS.includes(body.platforms[0])) {
    throw gatewayError(400, "social_posts_platform_invalid", `Name one platform per call, one of: ${GEO_SOCIAL_PLATFORMS.join(", ")}.`);
  }
  const platforms = body.platforms;
  if (body.sort != null && !GEO_SOCIAL_SORTS.includes(body.sort)) {
    throw gatewayError(400, "social_posts_sort_invalid", `sort must be one of: ${GEO_SOCIAL_SORTS.join(", ")}.`);
  }
  const limit = body.limit == null ? SOCIAL_DEFAULT_LIMIT : body.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOCIAL_MAX_LIMIT) {
    throw gatewayError(400, "social_posts_limit_invalid", `limit must be a whole number from 1 to ${SOCIAL_MAX_LIMIT}.`);
  }
  return { query, platforms, sort: body.sort ?? "hot", limit };
}

/**
 * The gateway's base address as the runtime may know it: empty when the
 * module is off, so the tools answer "disabled" without a request. Derived
 * from the model gateway's address, as the frontier gateway's is — the same
 * server at the same address.
 * @param {any} config @returns {string}
 */
export function geoGatewayProviderUrl(config) {
  if (!config?.geoEnabled) return "";
  let url;
  try { url = new URL(String(config.modelGatewayInternalUrl ?? "")); } catch { return ""; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
  url.pathname = gatewayPath;
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * The bounded metric label of a gateway path.
 * @param {string} pathname
 */
export function geoGatewayRoutePattern(pathname) {
  const operation = pathname.slice(gatewayPath.length + 1);
  return operations.includes(operation) ? pathname : `${gatewayPath}/:operation`;
}

/**
 * @param {any} config
 * @param {any} runtimeManager
 * @param {{ geo: { service: any, store: any, social?: any, renameProject?: any, articleGate?: any } | null, report?: (code: string) => void, budgetMs?: number }} dependencies
 *   `geo` is the composed module or null when it is off; `report` hears the code of a failure the run is only told was one
 */
export function createGeoGatewayHandler(config, runtimeManager, { geo, report = () => {}, budgetMs = answerBudgetMs }) {
  /** @type {Map<string, { until: number, count: number }>} */
  const windows = new Map();
  return async function geoGatewayHandler(/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ onFailure) {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const operation = pathname.startsWith(`${gatewayPath}/`) ? pathname.slice(gatewayPath.length + 1) : "";
      if (req.method !== "POST" || !operations.includes(operation)) throw gatewayError(404, "not_found", "Not found.");
      const header = String(req.headers?.authorization ?? "").trim();
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
      if (!token) throw gatewayError(401, "geo_gateway_token_missing", "GEO gateway authentication failed.");
      let identity;
      try { identity = runtimeManager.assertActiveModelGatewayToken(token); } catch {
        throw gatewayError(401, "geo_gateway_token_invalid", "GEO gateway authentication failed.");
      }
      if (!config.geoEnabled || !geo?.service) {
        throw gatewayError(503, "geo_disabled", "循证 GEO is switched off for this deployment; answer without the platform's GEO data.");
      }
      const user = { id: String(identity.userId) };
      if (!geo.service.allows(user)) {
        throw gatewayError(503, "geo_disabled", "循证 GEO is not open to this account; answer without the platform's GEO data.");
      }
      const now = Date.now();
      for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
      const key = `${identity.userId}\u0000${identity.projectId}\u0000${operation}`;
      const window = windows.get(key) ?? { until: now + 60_000, count: 0 };
      windows.set(key, window);
      if (++window.count > /** @type {Record<string, number>} */ (windowLimits)[operation]) {
        throw gatewayError(429, "geo_gateway_rate_limited", "Too many GEO calls in a minute.");
      }
      const body = await readJsonBody(req, /** @type {Record<string, number>} */ (requestLimits)[operation]);
      const project = operation === "social" ? null : await geo.store.projectByControlProject(String(identity.userId), String(identity.projectId));
      if (operation !== "social" && !project) {
        throw gatewayError(404, "geo_no_project", "This conversation is not in a 循证 GEO project; open the GEO project's conversation to read or write its data.");
      }
      let work;
      let budget = budgetMs;
      if (operation === "read") {
        const request = readRequest(body);
        work = async () => ({ what: request.what, ...(await geo.service.runtimeRead(project, request.what, request.filter)) });
      } else if (operation === "write") {
        const request = writeRequest(body);
        work = async () => {
          const result = await geoRuntimeWrite({ store: geo.store, project, what: request.what, body: request.body, renameProject: geo.renameProject ?? null,
            articleGate: geo.articleGate ?? null });
          geo.service.counters.writes += 1;
          geo.service.counters.writeIssues += result.issues.length;
          return { what: request.what, ...result };
        };
      } else {
        const request = socialRequest(body);
        if (!geo.social?.configured) {
          throw gatewayError(503, "social_posts_unconfigured", "The social channel is not configured on this deployment; say 「无信号」 for real phrasings, never zero.");
        }
        budget = Math.max(budgetMs, Number(config.geoSocialTimeoutMs ?? 120_000) + 5_000);
        work = async () => ({ query: request.query, sort: request.sort, ...(await geo.social.search(request)) });
      }
      /** @type {any} */
      let timer;
      const result = await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(gatewayError(504, "geo_gateway_timeout", "The GEO gateway timed out.")), budget);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      sendJson(res, 200, { data: result });
    } catch (caught) {
      let error = caught;
      // The service and the write module speak in HttpErrors. The ones about
      // the call's own shape pass through; a filter naming a round or a set
      // version the project does not have is the filter being wrong; nothing
      // else of theirs is a code the run's verdict knows.
      if (error instanceof HttpError) {
        if (passThroughCodes.has(error.code)) error = gatewayError(error.status, error.code, error.message);
        else if (error.status === 404) error = gatewayError(400, "geo_read_filter_invalid", error.message);
      }
      const known = error instanceof GeoGatewayError;
      const status = known ? /** @type {any} */ (error).status : 503;
      const code = known ? /** @type {any} */ (error).code : "geo_gateway_unavailable";
      if (!known) report(typeof /** @type {any} */ (error)?.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(/** @type {any} */ (error).code) ? /** @type {any} */ (error).code : /** @type {any} */ (error)?.name ?? "error");
      onFailure?.({ code, status });
      sendJson(res, status, { error: known ? /** @type {any} */ (error).message : "The GEO gateway is unavailable; go on without the platform's GEO data.", code });
    }
  };
}

export const GEO_GATEWAY_PATH = gatewayPath;
export const GEO_GATEWAY_OPERATIONS = operations;
export const GEO_GATEWAY_WINDOW_LIMITS = windowLimits;
