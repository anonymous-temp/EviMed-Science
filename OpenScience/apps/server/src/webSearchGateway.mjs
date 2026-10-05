// Open-web search, through a self-hosted SearXNG the platform owns.
//
// Every other evidence channel is a bibliographic API: it answers about papers
// that are already indexed. This one answers about everything else — a funding
// call, a conference programme, a registry a field uses, a method described on
// a lab's own pages — which is what a scoping run needs to widen a direction
// before it narrows one.
//
// It is a metasearch aggregator rather than a search API for two reasons: no
// API key has to be minted or stored, and which engines answer is a deployment
// fact rather than a code fact. From the current host Google, DuckDuckGo,
// Brave, and Startpage do not resolve at all, so an integration pinned to any
// single one of them would return nothing; SearXNG degrades to whichever
// engines do answer and says which ones those were.
//
// The runtime never names the search host, exactly as it never names a
// bibliographic host: it posts a query and the server builds the request.
//
// Two sources since 2026-09-22, when this host's SearXNG answered 1 of 20
// medical queries (Quark suspended by CAPTCHA, the rest unreachable from
// Beijing) and the same SearXNG on the Tokyo node answered 20 of 20 through
// Bing and Google: the node's SearXNG, reached through the edge proxy
// (edgeProxy.mjs), with this host's as the fallback; and Qwen's own web search
// on Bailian, asked in parallel, which reaches the Chinese web — 公众号 articles
// and this year's news — that no SearXNG engine reaches from either place.
//
// The Bailian half is a paid model call, and it is metered like one (purpose
// `web-search`, 2026-09-28): until then its spend reached no ledger.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isPeak, priceUsage, REFERENCE_PRICE_LIST } from "@evimed/domain";
import { edgeFetch, edgeStats } from "./edgeProxy.mjs";
import { closeUnsettledReservation } from "./usageLedger.mjs";

const gatewayPath = "/internal/search/v1/query";
const maxQueryLength = 512;
const maxResults = 25;
const maxSnippetLength = 700;
const maxResponseBytes = 4 * 1024 * 1024;
const bailianUrl = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
// SearXNG passes `categories` straight to its engine selection; only the ones
// this platform has a use for are accepted, so a runtime cannot reach an
// engine set the deployment did not intend.
const allowedCategories = new Set(["general", "science", "news", "it", "files"]);
const allowedTimeRanges = new Set(["day", "week", "month", "year"]);
const allowedLanguages = /^[a-z]{2}(?:-[A-Z]{2})?$/;

class WebSearchGatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function gatewayError(status, code, message) {
  return new WebSearchGatewayError(status, code, message);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, error, onFailure) {
  const status = error instanceof WebSearchGatewayError ? error.status : 500;
  const code = error instanceof WebSearchGatewayError ? error.code : "web_search_gateway_failed";
  const message = error instanceof WebSearchGatewayError ? error.message : "Web search failed.";
  // See the note in modelGateway.sendError.
  if (typeof onFailure === "function") {
    onFailure({ code, status, truncated: res.headersSent && !res.writableEnded, upstream: error?.upstream ?? null });
  }
  sendJson(res, status, { error: message, code });
}

function bearerToken(req) {
  const header = String(req.headers?.authorization ?? "");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw gatewayError(401, "web_search_gateway_token_missing", "Web search authentication failed.");
  return match[1].trim();
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw gatewayError(413, "web_search_request_too_large", "The web-search request was too large.");
    chunks.push(chunk);
  }
  if (total === 0) throw gatewayError(400, "web_search_request_invalid", "The web-search request body was empty.");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw gatewayError(400, "web_search_request_invalid", "The web-search request body was not a JSON object.");
  }
}

function validatedRequest(body) {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > maxQueryLength || /[\r\n\0]/.test(query)) {
    throw gatewayError(400, "web_search_query_invalid", "The web-search query is missing or malformed.");
  }
  const limitValue = body.limit == null ? 10 : Number(body.limit);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > maxResults) {
    throw gatewayError(400, "web_search_limit_invalid", `The web-search limit must be an integer between 1 and ${maxResults}.`);
  }
  let categories = ["general"];
  if (body.categories != null) {
    const requested = Array.isArray(body.categories) ? body.categories : [body.categories];
    categories = requested.map((value) => String(value).trim().toLowerCase());
    if (categories.length === 0 || categories.length > allowedCategories.size || categories.some((value) => !allowedCategories.has(value))) {
      throw gatewayError(400, "web_search_categories_invalid", `The web-search categories must be drawn from: ${[...allowedCategories].join(", ")}.`);
    }
  }
  let language = null;
  if (body.language != null) {
    language = String(body.language).trim();
    if (!allowedLanguages.test(language)) {
      throw gatewayError(400, "web_search_language_invalid", "The web-search language must be an IETF tag such as zh or en-US.");
    }
  }
  let timeRange = null;
  if (body.timeRange != null) {
    timeRange = String(body.timeRange).trim().toLowerCase();
    if (!allowedTimeRanges.has(timeRange)) {
      throw gatewayError(400, "web_search_time_range_invalid", `The web-search timeRange must be one of: ${[...allowedTimeRanges].join(", ")}.`);
    }
  }
  return { query, limit: limitValue, categories, language, timeRange };
}

/** @param {string} value @returns {URL} A SearXNG endpoint: this host's, or the node's as the node sees it. */
function searchEndpoint(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw gatewayError(
      503,
      "web_search_unconfigured",
      "Open-web search is not configured for this deployment. The bibliographic channels remain available.",
    );
  }
  let base;
  try {
    base = new URL(raw);
  } catch {
    throw gatewayError(503, "web_search_endpoint_invalid", "The configured web-search endpoint is invalid.");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw gatewayError(503, "web_search_endpoint_invalid", "The configured web-search endpoint is invalid.");
  }
  // The deployment writes the search endpoint itself
  // (`http://open-science-web-search:8080/search`), and this appended
  // `search` to it: every query went to `/search/search`, which SearXNG's
  // router answers 404, and every open-web search on production failed as
  // `web_search_upstream_error` — 138 in twelve hours on 2026-09-21, found the
  // day the error ledger began recording the upstream's status. A base URL
  // still gets `search` added; an endpoint that already names it is used as
  // it is.
  base.search = "";
  base.hash = "";
  if (/\/search\/?$/.test(base.pathname)) return new URL(base.pathname.replace(/\/$/, ""), base);
  return new URL("search", base.pathname.endsWith("/") ? base : new URL(`${base.pathname}/`, base));
}

/** Trim one result to what a reader of the report needs. Raw SearXNG results
 *  carry parsed engine internals, per-engine scores, and repeated metadata;
 *  passing that through would spend the run's context on bookkeeping.
 *  @returns {{ title: string, url: string, snippet: string, engine: string | null, publishedDate: string | null } | null} */
function normalizedRow(row) {
  const url = typeof row?.url === "string" ? row.url.trim() : "";
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const snippet = String(row?.content ?? "").replace(/\s+/g, " ").trim();
  return {
    title: String(row?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || url,
    url,
    snippet: snippet.length > maxSnippetLength ? `${snippet.slice(0, maxSnippetLength)}…` : snippet,
    engine: String(row?.engine ?? "").trim() || null,
    publishedDate: typeof row?.publishedDate === "string" ? row.publishedDate : null,
  };
}

/** Interleave the sources' results, first-come per URL, up to `limit`: neither
 *  source's ranking outranks the other's, and a page both found appears once. */
function mergedResults(lists, limit) {
  const seen = new Set();
  const results = [];
  const queues = lists.map((rows) => rows.map(normalizedRow).filter(Boolean));
  for (let index = 0; results.length < limit && queues.some((queue) => index < queue.length); index += 1) {
    for (const queue of queues) {
      const row = queue[index];
      if (!row) continue;
      const key = row.url.replace(/[#?].*$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(row);
      if (results.length >= limit) break;
    }
  }
  return results;
}

/** @param {any} payload */
function unresponsiveEnginesOf(payload) {
  return Array.isArray(payload?.unresponsive_engines)
    ? payload.unresponsive_engines.map((entry) => (Array.isArray(entry) ? String(entry[0]) : String(entry))).filter(Boolean)
    : [];
}

async function readBoundedJson(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw gatewayError(502, "web_search_response_too_large", "The web-search response exceeded the gateway limit.");
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw gatewayError(502, "web_search_response_too_large", "The web-search response exceeded the gateway limit.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw gatewayError(502, "web_search_response_invalid", "The web-search backend returned a non-JSON response.");
  }
}

/** One SearXNG query, with the single retry an aggregator needs: one slow
 *  engine takes the whole response with it, and a second try recovers the
 *  common case without turning a dead backend into a minutes-long stall. */
async function searxngSearch(endpoint, request, fetcher, signal) {
  endpoint.searchParams.set("q", request.query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("categories", request.categories.join(","));
  if (request.language) endpoint.searchParams.set("language", request.language);
  if (request.timeRange) endpoint.searchParams.set("time_range", request.timeRange);
  let upstream = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await delay(500);
    try {
      upstream = await fetcher(endpoint, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "EviMed-Research/1.2 (server web-search gateway)" },
        redirect: "error",
        signal,
      });
      if (upstream.ok) break;
      await upstream.body?.cancel().catch(() => {});
      // The backend's own status goes to the error ledger: 138 of these in
      // twelve hours on 2026-09-21 were recorded without it, and every
      // replayed query answered 200.
      lastError = Object.assign(gatewayError(
        upstream.status === 429 ? 429 : 502,
        upstream.status === 429 ? "web_search_rate_limited" : "web_search_upstream_error",
        `The web-search backend returned HTTP ${upstream.status}.`,
      ), { upstream: { host: endpoint.hostname, status: upstream.status } });
      upstream = null;
    } catch (error) {
      if (signal.reason?.name === "TimeoutError") {
        throw gatewayError(504, "web_search_timeout", "The web-search backend timed out.");
      }
      lastError = gatewayError(502, "web_search_unavailable", "The web-search backend is temporarily unavailable.");
    }
  }
  if (!upstream) throw lastError ?? gatewayError(502, "web_search_unavailable", "The web-search backend is temporarily unavailable.");
  return readBoundedJson(upstream, maxResponseBytes);
}

/** The answer the Bailian call is allowed: a few tokens, dropped. */
const bailianMaxTokens = 8;
/**
 * The prompt a Bailian search is reserved at before its answer gives the
 * count: the query and the pages `turbo` retrieves into the prompt, which
 * bill as input tokens. A ceiling for the spend windows while the call is in
 * flight, not a price — the row settles on the provider's own `usage`. At
 * Qwen-Plus's ¥0.8 per million it holds ¥0.0128.
 */
const bailianReservedPromptTokens = 16_000;

/** @param {...unknown} values the smallest positive limit, or 0 for none */
function minimumPositive(...values) {
  const positive = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return positive.length ? Math.min(...positive) : 0;
}

/** The provider's own count from a DashScope answer, or null when it sent none.
 *  @param {any} usage */
function bailianUsage(usage) {
  const input = Number(usage?.input_tokens);
  const output = Number(usage?.output_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  const cached = Math.min(input, Math.max(0, Number(usage?.prompt_tokens_details?.cached_tokens) || 0));
  return { cacheHitTokens: cached, cacheMissTokens: input - cached, completionTokens: output };
}

/** Qwen's web search on Bailian as a second engine. Measured 2026-09-22 from
 *  the production host: 3–4 s and 8–9 sourced results a query, 公众号 articles
 *  and 2026 Chinese news among them. The model call only carries the search:
 *  `max_tokens` keeps its answer to a few tokens and the answer is dropped;
 *  what is kept is `search_info.search_results` (title, url, site name) and
 *  the call's `usage`, which the ledger is settled on. The key is the
 *  deployment's DashScope key the reranker already uses.
 *  `onDispatch` is told when the request leaves, so a failure after it is
 *  booked as possibly spent rather than released. */
async function bailianSearch(config, request, fetcher, signal, onDispatch = () => {}) {
  const key = String(config.dashscopeApiKey ?? "").trim();
  onDispatch();
  const response = await fetcher(bailianUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: String(config.webSearchBailianModel ?? "").trim() || "qwen-plus",
      input: { messages: [{ role: "user", content: request.query }] },
      parameters: {
        result_format: "message",
        enable_search: true,
        max_tokens: bailianMaxTokens,
        search_options: { forced_search: true, enable_source: true, search_strategy: "turbo" },
      },
    }),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(gatewayError(502, "web_search_upstream_error", `The Bailian search returned HTTP ${response.status}.`), {
      upstream: { host: "dashscope.aliyuncs.com", status: response.status },
    });
  }
  const payload = await readBoundedJson(response, maxResponseBytes);
  const rows = Array.isArray(payload?.output?.search_info?.search_results) ? payload.output.search_info.search_results : [];
  return {
    rows: rows.map((row) => ({ url: row?.url, title: row?.title, content: String(row?.site_name ?? "").trim(), engine: "bailian" })),
    usage: bailianUsage(payload?.usage),
    requestId: typeof payload?.request_id === "string" && payload.request_id ? payload.request_id.slice(0, 512) : null,
  };
}

/**
 * The Bailian search, metered like every model call the platform pays for
 * (purpose `web-search`): reserved against the researcher's caps before it
 * leaves, settled on the provider's own count at the reference price, or
 * closed by the ledger's one rule when no count came back
 * (`closeUnsettledReservation`). Without a ledger (a deployment with no
 * PostgreSQL) the call is simply made; where the ledger is required it is not
 * made at all, because a spend nobody records is the defect this exists for.
 * A reservation the caps refuse leaves Bailian out of this search — the other
 * engines still answer.
 *
 * @param {{ config: any, request: any, fetcher: typeof fetch, signal: AbortSignal, usageLedger: any, caller: any, attributeRun: any, runPurpose: any }} options
 * @returns {Promise<any[]>}
 */
async function meteredBailianSearch({ config, request, fetcher, signal, usageLedger, caller, attributeRun, runPurpose }) {
  if (!usageLedger) {
    if (config.requireDurableUsageLedger === true) {
      throw gatewayError(503, "web_search_unavailable", "The Bailian search is unavailable: its spend cannot be recorded right now.");
    }
    return (await bailianSearch(config, request, fetcher, signal)).rows;
  }
  const model = String(config.webSearchBailianModel ?? "").trim() || "qwen-plus";
  const at = new Date();
  const peak = isPeak(at);
  const attributed = caller.runId == null && attributeRun
    ? await attributeRun({ userId: caller.userId, projectId: caller.projectId, sessionId: null }).catch(() => null)
    : null;
  const runId = caller.runId ?? attributed ?? null;
  const purpose = runPurpose && await runPurpose({ userId: caller.userId, projectId: caller.projectId, runId }) === "evolution" ? "evolution" : "web-search";
  const estimate = priceUsage({ resourceType: "model", model, cacheMiss: bailianReservedPromptTokens, output: bailianMaxTokens, peak });
  let reservation;
  try {
    reservation = await usageLedger.reserveModel({
      id: randomUUID(), userId: caller.userId, projectId: caller.projectId, runId, purpose, model,
      priceVersion: REFERENCE_PRICE_LIST.version, currency: "CNY",
      requestFingerprint: createHash("sha256").update(JSON.stringify({ model, query: request.query, strategy: "turbo" })).digest("hex"),
      estimatedCost: estimate.cost,
      dailyLimit: purpose === "evolution" ? Number(config.evolutionDailyBudgetCny) || 0 : minimumPositive(caller.dailyLimit, config.userDailySpendLimit),
      weeklyLimit: purpose === "evolution" ? 0 : minimumPositive(caller.weeklyLimit, config.userWeeklySpendLimit),
      runLimit: purpose === "evolution" ? 0 : caller.runId != null ? Number(caller.runLimit) || 0 : (attributed ? Number(config.userRunSpendLimit) || 0 : 0),
      now: at,
    });
  } catch (error) {
    throw gatewayError(503, "web_search_unavailable", error?.code === "usage_budget_exceeded"
      ? "The Bailian search is unavailable: this account's spending limit is reached."
      : "The Bailian search is unavailable: its spend cannot be recorded right now.");
  }
  let dispatched = false;
  let outcome;
  try {
    outcome = await bailianSearch(config, request, fetcher, signal, () => { dispatched = true; });
  } catch (error) {
    await closeUnsettledReservation(usageLedger, caller.userId, reservation.id, {
      dispatched, status: Number(error?.upstream?.status) || 0,
    }).catch(() => { /* the reconciliation sweep books what this could not */ });
    throw error;
  }
  // The results stand whatever the bookkeeping does next (principle 19); a
  // write that fails leaves the reservation to the reconciliation sweep, which
  // books it `reservation_expired` where the operator's metric counts it.
  const { usage, requestId } = outcome;
  if (usage) {
    const priced = priceUsage({ resourceType: "model", model, cacheHit: usage.cacheHitTokens,
      cacheMiss: usage.cacheMissTokens, output: usage.completionTokens, peak });
    await usageLedger.settleModel(caller.userId, reservation.id, {
      usage, actualCost: priced.cost, priced: priced.priced, providerRequestId: requestId,
    }).catch(() => {});
  } else {
    await usageLedger.markUncertain(caller.userId, reservation.id, "response_usage_missing", { providerRequestId: requestId }).catch(() => {});
  }
  return outcome.rows;
}

/**
 * @param {any} config @param {any} runtimeManager
 * @param {{ fetchImpl?: typeof fetch, edge?: ReturnType<typeof import("./edgeProxy.mjs").edgeProxyFromConfig>, edgeFetchImpl?: typeof fetch | null, usageLedger?: any, evaluationIsolation?: any, runPurpose?: any, attributeRun?: ((input: { userId: string, projectId: string, sessionId: string | null }) => Promise<string | null>) | null }} [options]
 *   `usageLedger` / `attributeRun`: what the Bailian call is booked in and
 *   which run it is charged to, as for the model gateway
 */
export function createWebSearchGatewayHandler(config, runtimeManager, { fetchImpl = fetch, edge = null, edgeFetchImpl = null, usageLedger = null, attributeRun = null, evaluationIsolation = null, runPurpose = null } = {}) {
  const throughEdge = edgeFetchImpl ?? ((url, init) => edgeFetch(/** @type {any} */ (edge), /** @type {URL} */ (url), /** @type {any} */ (init)));
  return async function webSearchGatewayHandler(req, res, onFailure) {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== gatewayPath) {
      sendError(res, gatewayError(404, "not_found", "Not found."), onFailure);
      return;
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1_000, Number(config.webSearchTimeoutMs) || 30_000);
    const timeout = setTimeout(() => controller.abort(new DOMException("Web search timed out.", "TimeoutError")), timeoutMs);
    timeout.unref?.();
    try {
      const token = bearerToken(req);
      let caller;
      try {
        caller = runtimeManager.assertActiveModelGatewayToken(token);
      } catch {
        throw gatewayError(401, "web_search_gateway_token_invalid", "Web search authentication failed.");
      }
      const request = validatedRequest(await readJsonBody(req, 8 * 1024));
      const localUrl = String(config.webSearchUrl ?? "").trim();
      const edgeUrl = edge ? String(config.webSearchEdgeUrl ?? "").trim() : "";
      const bailianOn = config.webSearchBailianEnabled === true && Boolean(String(config.dashscopeApiKey ?? "").trim());
      if (!localUrl && !edgeUrl && !bailianOn) {
        throw gatewayError(
          503,
          "web_search_unconfigured",
          "Open-web search is not configured for this deployment. The bibliographic channels remain available.",
        );
      }
      const searx = localUrl || edgeUrl ? (async () => {
        if (edgeUrl) {
          edgeStats.requests += 1;
          try {
            return await searxngSearch(searchEndpoint(edgeUrl), request, throughEdge, controller.signal);
          } catch (error) {
            edgeStats.failures += 1;
            if (!localUrl || controller.signal.reason?.name === "TimeoutError") throw error;
            edgeStats.directFallbacks += 1;
          }
        }
        return searxngSearch(searchEndpoint(localUrl), request, fetchImpl, controller.signal);
      })() : Promise.resolve(null);
      const bailian = bailianOn
        ? meteredBailianSearch({ config, request, fetcher: fetchImpl, signal: controller.signal, usageLedger, caller, attributeRun, runPurpose })
        : Promise.resolve(null);
      const [searxOutcome, bailianOutcome] = await Promise.allSettled([searx, bailian]);
      const bailianAnswered = bailianOn && bailianOutcome.status === "fulfilled";
      // One source failing is a thinner answer, not a failed search; only when
      // nothing answered is the search itself refused, with the first reason.
      if (searxOutcome.status === "rejected" && !bailianAnswered) {
        const error = searxOutcome.reason;
        if (controller.signal.reason?.name === "TimeoutError" && !(error instanceof WebSearchGatewayError)) {
          throw gatewayError(504, "web_search_timeout", "The web-search backend timed out.");
        }
        throw error;
      }
      const payload = searxOutcome.status === "fulfilled" ? searxOutcome.value : null;
      if (!payload && bailianOutcome.status === "rejected") throw bailianOutcome.reason;
      const bailianRows = bailianAnswered ? bailianOutcome.value ?? [] : [];
      let results = mergedResults([Array.isArray(payload?.results) ? payload.results : [], bailianRows], request.limit);
      // Which engines actually answered is part of the finding, not
      // diagnostics: a result set assembled from one engine that happened to be
      // up is a different claim about the web than one assembled from four.
      if (evaluationIsolation) results = await evaluationIsolation.filter(caller, "web-search", results);
      const engines = [...new Set(results.map((row) => row.engine).filter(Boolean))].sort();
      const unresponsiveEngines = [...new Set([
        ...unresponsiveEnginesOf(payload),
        ...(searxOutcome.status === "rejected" ? ["searxng"] : []),
        ...(bailianOn && bailianOutcome.status === "rejected" ? ["bailian"] : []),
      ])].sort();
      sendJson(res, 200, {
        data: {
          query: request.query,
          categories: request.categories,
          language: request.language,
          timeRange: request.timeRange,
          results,
          engines,
          unresponsiveEngines,
        },
        warnings: [
          "Open-web results are unreviewed pages, not indexed literature; a claim taken from one needs the primary source before it enters a report.",
          ...(results.length === 0
            ? ["No engine returned a result for this query; this is not evidence that the topic is unoccupied."]
            : []),
        ],
      });
    } catch (error) {
      sendError(res, error, onFailure);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export const WEB_SEARCH_GATEWAY_PATH = gatewayPath;
export const WEB_SEARCH_MAX_RESULTS = maxResults;
export const WEB_SEARCH_ALLOWED_CATEGORIES = allowedCategories;
