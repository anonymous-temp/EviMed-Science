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
import { setTimeout as delay } from "node:timers/promises";

const gatewayPath = "/internal/search/v1/query";
const maxQueryLength = 512;
const maxResults = 25;
const maxSnippetLength = 700;
const maxResponseBytes = 4 * 1024 * 1024;
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

function sendError(res, error) {
  const status = error instanceof WebSearchGatewayError ? error.status : 500;
  const code = error instanceof WebSearchGatewayError ? error.code : "web_search_gateway_failed";
  const message = error instanceof WebSearchGatewayError ? error.message : "Web search failed.";
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

/** @returns {URL} The SearXNG endpoint this deployment is configured with. */
function searchEndpoint(config) {
  const raw = String(config.webSearchUrl ?? "").trim();
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
  return new URL("search", base.pathname.endsWith("/") ? base : new URL(`${base.pathname}/`, base));
}

/** Trim SearXNG's per-result payload to what a reader of the report needs.
 *  Raw responses carry parsed engine internals, per-engine scores, and repeated
 *  metadata; passing that through would spend the run's context on bookkeeping. */
function normalizeResults(payload, limit) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const url = typeof row?.url === "string" ? row.url.trim() : "";
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const key = url.replace(/[#?].*$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = String(row?.content ?? "").replace(/\s+/g, " ").trim();
    results.push({
      title: String(row?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || url,
      url,
      snippet: snippet.length > maxSnippetLength ? `${snippet.slice(0, maxSnippetLength)}…` : snippet,
      engine: String(row?.engine ?? "").trim() || null,
      publishedDate: typeof row?.publishedDate === "string" ? row.publishedDate : null,
    });
    if (results.length >= limit) break;
  }
  // Which engines actually answered is part of the finding, not diagnostics: a
  // result set assembled from one engine that happened to be up is a different
  // claim about the web than one assembled from four.
  const engines = [...new Set(results.map((row) => row.engine).filter(Boolean))].sort();
  const unresponsive = Array.isArray(payload?.unresponsive_engines)
    ? payload.unresponsive_engines.map((entry) => (Array.isArray(entry) ? String(entry[0]) : String(entry))).filter(Boolean)
    : [];
  return { results, engines, unresponsiveEngines: [...new Set(unresponsive)].sort() };
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

export function createWebSearchGatewayHandler(config, runtimeManager, { fetchImpl = fetch } = {}) {
  return async function webSearchGatewayHandler(req, res) {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== gatewayPath) {
      sendError(res, gatewayError(404, "not_found", "Not found."));
      return;
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1_000, Number(config.webSearchTimeoutMs) || 30_000);
    const timeout = setTimeout(() => controller.abort(new DOMException("Web search timed out.", "TimeoutError")), timeoutMs);
    timeout.unref?.();
    try {
      const token = bearerToken(req);
      try {
        runtimeManager.assertActiveModelGatewayToken(token);
      } catch {
        throw gatewayError(401, "web_search_gateway_token_invalid", "Web search authentication failed.");
      }
      const request = validatedRequest(await readJsonBody(req, 8 * 1024));
      const endpoint = searchEndpoint(config);
      endpoint.searchParams.set("q", request.query);
      endpoint.searchParams.set("format", "json");
      endpoint.searchParams.set("categories", request.categories.join(","));
      if (request.language) endpoint.searchParams.set("language", request.language);
      if (request.timeRange) endpoint.searchParams.set("time_range", request.timeRange);

      // Aggregators answer from many upstreams at once, and one slow engine
      // takes the whole response with it. A single retry recovers the common
      // case without turning a dead backend into a minutes-long stall.
      let upstream = null;
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) await delay(500);
        try {
          upstream = await fetchImpl(endpoint, {
            method: "GET",
            headers: { accept: "application/json", "user-agent": "EviMed-Research/1.2 (server web-search gateway)" },
            redirect: "error",
            signal: controller.signal,
          });
          if (upstream.ok) break;
          await upstream.body?.cancel().catch(() => {});
          lastError = gatewayError(
            upstream.status === 429 ? 429 : 502,
            upstream.status === 429 ? "web_search_rate_limited" : "web_search_upstream_error",
            `The web-search backend returned HTTP ${upstream.status}.`,
          );
          upstream = null;
        } catch (error) {
          if (controller.signal.reason?.name === "TimeoutError") {
            throw gatewayError(504, "web_search_timeout", "The web-search backend timed out.");
          }
          lastError = gatewayError(502, "web_search_unavailable", "The web-search backend is temporarily unavailable.");
        }
      }
      if (!upstream) throw lastError ?? gatewayError(502, "web_search_unavailable", "The web-search backend is temporarily unavailable.");

      const payload = await readBoundedJson(upstream, maxResponseBytes);
      const { results, engines, unresponsiveEngines } = normalizeResults(payload, request.limit);
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
      sendError(res, error);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export const WEB_SEARCH_GATEWAY_PATH = gatewayPath;
export const WEB_SEARCH_MAX_RESULTS = maxResults;
export const WEB_SEARCH_ALLOWED_CATEGORIES = allowedCategories;
