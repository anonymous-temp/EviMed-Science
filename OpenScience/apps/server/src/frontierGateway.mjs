// 「前沿动态」 search, for the runtime's `frontier_search` tool (plan
// 2026-09-21 §4.8, §7.3, §10.5.4).
//
// A copy of `kbSearchGateway.mjs`, the same shape as every internal gateway
// (layer 3): one path, one handler, one allowlist of fields, and the runtime's
// own gateway token as the only credential. The token — not anything the
// runtime says — names the account, and the answer is what that account's
// 「前沿动态」 page lists for the same filters, read through the page's own
// service method (`FrontierService.listItems`). So the tool and the page never
// disagree about what is published, withdrawn, hidden by this reader, or open
// to them at all.
//
// Hidden knowledge:
//
// - `mode: "selected"` means the editors' picks, with a query too. The page
//   widens a search of 精选 to 全部 and marks what was selected (§4.2); the
//   tool's contract is "only the picks unless asked for all" (§10.5.4). So a
//   selected search reads the widened ranking fifty at a time, drops the
//   unselected and says how many it dropped, which tells a run that found
//   nothing selected that `mode: "all"` has more. Three pages cover the whole
//   fused ranking (three legs of fifty); the later pages reuse the first
//   page's ranking, so the question is embedded once.
// - Switched off answers `frontier_disabled`, and so does "on for operators
//   only, and this account is not one" (the dry-run week, §10.5.10): to a run
//   both mean "this conversation has no feed". The runtime is normally not
//   even given the route then (`runtimeManager.mjs`), and the tool says the
//   same without asking; this answer is for a runtime started before the
//   switch moved. Either way the conversation goes on with the other tools.
// - The answer is a projection, never the page's item: what a lead needs —
//   the titles, the digest and the reason to read it, the source and its
//   type, the evidence type, the two times, the original's address and
//   identifiers, the flags, whether it was selected — and nothing of the
//   reader's own marks, the levels, entities or events. What leaves the
//   control plane is decided here; how the model is shown it is the tool's
//   (`frontier_search.py`).
// - Five seconds for the whole answer (§10.5.4). A search that embeds its
//   question and runs three legs answers well inside it; past it the tool
//   says so and the run carries on with the bibliographic channels. The
//   service's statement timeout is five seconds as well, per statement.

import { FRONTIER_LANES, FRONTIER_SPECIALTIES } from "@evimed/domain";
import { FRONTIER_WINDOWS } from "./frontierService.mjs";

const gatewayPath = "/internal/frontier/v1/search";
const allowedFields = new Set(["q", "lane", "specialty", "window", "mode", "limit"]);
/** The page's own bound on a search (`frontierService.mjs`). */
const maxQueryLength = 200;
const maxLimit = 20;
const defaultLimit = 8;
const defaultWindow = "30d";
const modes = Object.freeze(["selected", "all"]);
const defaultMode = "selected";
/** The whole answer's budget: the plan's five seconds (§10.5.4). */
const answerBudgetMs = 5_000;
/** Searches one project may make per minute. A run asks a handful of times;
 *  this is the ceiling of a loop, not of a researcher — half of
 *  `kb_search`'s, because one call may read three pages and embed once. */
const windowLimit = 60;
/** Reading the widened ranking for the selected: a page of fifty (the
 *  service's largest), at most three of them. */
const filterPageSize = 50;
const filterPages = 3;

class FrontierGatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function gatewayError(status, code, message) {
  return new FrontierGatewayError(status, code, message);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
  res.end(body);
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw gatewayError(413, "frontier_search_request_too_large", "The frontier search request was too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw gatewayError(400, "frontier_search_request_invalid", "The frontier search request was not a JSON object.");
  }
}

/** @param {string} value */
const hasControlCharacter = (value) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/**
 * One closed-vocabulary field: absent is its default, anything else must be
 * one of the vocabulary's own words. The code is spelled out at each call so
 * every code this gateway can answer is a literal a reader (and the test that
 * holds every emitted code classified) can find.
 * @param {Record<string, unknown>} body @param {string} field @param {readonly string[]} allowed
 * @param {string | null} fallback @param {string} code
 */
function closedField(body, field, allowed, fallback, code) {
  const value = body[field];
  if (value == null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw gatewayError(400, code, `${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

/** @param {Record<string, unknown>} body */
function validatedRequest(body) {
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    throw gatewayError(400, "frontier_search_request_invalid", "The frontier search request has unsupported fields.");
  }
  let q = null;
  if (body.q != null) {
    q = typeof body.q === "string" ? body.q.trim().replace(/\s+/g, " ") : "";
    if (!q || q.length > maxQueryLength || hasControlCharacter(q)) {
      throw gatewayError(400, "frontier_search_query_invalid", `q must be non-empty text of at most ${maxQueryLength} characters.`);
    }
  }
  const lane = closedField(body, "lane", FRONTIER_LANES, null, "frontier_search_lane_invalid");
  const specialty = closedField(body, "specialty", FRONTIER_SPECIALTIES, null, "frontier_search_specialty_invalid");
  const window = closedField(body, "window", Object.keys(FRONTIER_WINDOWS), defaultWindow, "frontier_search_window_invalid");
  const mode = closedField(body, "mode", modes, defaultMode, "frontier_search_mode_invalid");
  const limit = body.limit == null ? defaultLimit : Number(body.limit);
  if (typeof body.limit === "boolean" || !Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw gatewayError(400, "frontier_search_limit_invalid", `limit must be an integer between 1 and ${maxLimit}.`);
  }
  return { q, lane, specialty, window, mode, limit };
}

/** @param {unknown} value */
const text = (value) => (typeof value === "string" && value.trim() ? value : null);

/**
 * What of one page item may leave the control plane (see the module note).
 * @param {Record<string, any>} item a `FrontierService` list item
 */
function projectedItem(item) {
  const url = text(item.url);
  return {
    title: text(item.title) ?? text(item.titleRaw),
    titleRaw: text(item.titleRaw),
    summary: text(item.summary),
    reason: text(item.reason),
    source: { name: text(item.source?.name), type: text(item.sourceType), typeLabel: text(item.sourceTypeLabel) },
    evidenceType: text(item.evidenceType),
    evidenceTypeLabel: text(item.evidenceTypeLabel),
    publishedAt: text(item.publishedAt),
    datePrecision: text(item.datePrecision),
    visibleAt: text(item.visibleAt),
    // The original's own address is the one thing a lead is for; anything
    // that is not a web address is not one a reader can open.
    url: url && /^https?:\/\//i.test(url) ? url : null,
    doi: text(item.doi),
    pmid: text(item.pmid),
    registryIds: Array.isArray(item.registryIds) ? item.registryIds.filter((id) => text(id)).slice(0, 10) : [],
    flags: Array.isArray(item.flags)
      ? item.flags.filter((flag) => text(flag?.key)).map((flag) => ({ key: flag.key, label: text(flag.label) ?? flag.key }))
      : [],
    selected: item.selected === true,
    safetyAlert: item.safetyAlert === true,
  };
}

/**
 * The search itself: the page's list read for this account, cut to the
 * tool's contract.
 * @param {any} service @param {{ id: string }} user @param {ReturnType<typeof validatedRequest>} request
 */
async function search(service, user, request) {
  // Only a search widens the selected view; a plain list of the picks is
  // exactly what the page's 精选 already lists.
  const dropUnselected = request.mode === "selected" && request.q != null;
  const params = new URLSearchParams({
    view: request.mode, window: request.window, limit: String(dropUnselected ? filterPageSize : request.limit),
  });
  if (request.lane) params.set("lane", request.lane);
  if (request.specialty) params.set("specialty", request.specialty);
  if (request.q) params.set("q", request.q);
  /** @type {ReturnType<typeof projectedItem>[]} */
  const items = [];
  let unselected = 0;
  let searchMode = null;
  let more = false;
  let cursor = null;
  for (let page = 0; page < (dropUnselected ? filterPages : 1); page += 1) {
    if (cursor) params.set("cursor", cursor);
    let answer;
    try {
      answer = await service.listItems(user, params);
    } catch (error) {
      // The list moved between two pages (something was published or
      // withdrawn): what was read stands, and the answer says there may be
      // more rather than restarting against the clock.
      if (page > 0 && /** @type {any} */ (error)?.code === "invalid_cursor") { more = true; break; }
      throw error;
    }
    const body = answer?.body;
    if (!body || !Array.isArray(body.items)) throw new Error("The frontier list answered without items.");
    searchMode ??= typeof body.mode === "string" ? body.mode : null;
    for (const item of body.items) {
      if (dropUnselected && item?.selected !== true) { unselected += 1; continue; }
      if (items.length < request.limit) items.push(projectedItem(item));
      else more = true;
    }
    cursor = typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null;
    if (!cursor || items.length >= request.limit) break;
  }
  if (cursor) more = true;
  return {
    query: request,
    searchMode,
    asOf: new Date().toISOString(),
    items,
    more,
    ...(dropUnselected ? { unselectedSkipped: unselected } : {}),
  };
}

/**
 * The gateway's URL as the runtime may know it: empty when the module is off,
 * so the tool answers "disabled" without a request, exactly as when the
 * gateway itself refuses. Derived from the model gateway's address, as the
 * capsule and revision gateways' are (`runtimeManager.mjs`): it is the same
 * server at the same address, and a second lever for that one fact is a lever
 * that can disagree with it.
 * @param {any} config @returns {string}
 */
export function frontierGatewayProviderUrl(config) {
  if (!config?.frontierEnabled) return "";
  let url;
  try { url = new URL(String(config.modelGatewayInternalUrl ?? "")); } catch { return ""; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
  url.pathname = gatewayPath;
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * @param {any} config
 * @param {any} runtimeManager
 * @param {{ service: any, report?: (code: string) => void, budgetMs?: number }} dependencies the frontier service,
 *   or null when the module is off; `report` hears the code of a failure the run is only told was one; `budgetMs`
 *   is the plan's five seconds everywhere but in a test that would otherwise wait them out
 */
export function createFrontierGatewayHandler(config, runtimeManager, { service, report = () => {}, budgetMs = answerBudgetMs }) {
  const windows = new Map();
  return async function frontierGatewayHandler(req, res, onFailure) {
    try {
      if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== gatewayPath) {
        throw gatewayError(404, "not_found", "Not found.");
      }
      const header = String(req.headers?.authorization ?? "").trim();
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
      if (!token) throw gatewayError(401, "frontier_search_gateway_token_missing", "Frontier search authentication failed.");
      let identity;
      try { identity = runtimeManager.assertActiveModelGatewayToken(token); } catch {
        throw gatewayError(401, "frontier_search_gateway_token_invalid", "Frontier search authentication failed.");
      }
      if (!config.frontierEnabled || !service) {
        throw gatewayError(503, "frontier_disabled",
          "前沿动态 (the frontier feed) is switched off for this deployment; answer with the literature, guideline and regulatory tools instead.");
      }
      const user = { id: String(identity.userId) };
      if (!service.allows(user)) {
        throw gatewayError(503, "frontier_disabled",
          "前沿动态 (the frontier feed) is not open to this account yet; answer with the literature, guideline and regulatory tools instead.");
      }
      const now = Date.now();
      for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
      const key = `${identity.userId}\u0000${identity.projectId}`;
      const window = windows.get(key) ?? { until: now + 60_000, count: 0 };
      windows.set(key, window);
      if (++window.count > windowLimit) throw gatewayError(429, "frontier_search_rate_limited", "Too many frontier searches in a minute.");
      const request = validatedRequest(await readJsonBody(req, 16 * 1024));
      let timer;
      const result = await Promise.race([
        search(service, user, request),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(gatewayError(504, "frontier_search_timeout", "Frontier search timed out.")), budgetMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      sendJson(res, 200, { data: result });
    } catch (error) {
      const known = error instanceof FrontierGatewayError;
      const status = known ? error.status : 503;
      const code = known ? error.code : "frontier_search_unavailable";
      // What failed underneath is the operator's to know and never the run's:
      // its code only (a database's SQLSTATE, a service's named code), not its
      // message, which can carry an internal address.
      if (!known) report(typeof error?.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(error.code) ? error.code : error?.name ?? "error");
      onFailure?.({ code, status });
      sendJson(res, status, { error: known ? error.message : "Frontier search is unavailable; answer with the literature, guideline and regulatory tools instead.", code });
    }
  };
}

export const FRONTIER_GATEWAY_PATH = gatewayPath;
export const FRONTIER_SEARCH_MAX_LIMIT = maxLimit;
export const FRONTIER_SEARCH_DEFAULT_LIMIT = defaultLimit;
export const FRONTIER_SEARCH_MAX_QUERY_LENGTH = maxQueryLength;
export const FRONTIER_SEARCH_MODES = modes;
