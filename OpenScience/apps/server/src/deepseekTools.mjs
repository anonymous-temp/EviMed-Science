// DeepSeek's two tool APIs, opened on 2026-10-17, as backends of the control plane's own gateways.
//
// Search (`POST /v1/tools/search`) answers beside SearXNG and Bailian in the web-search gateway; Fetch
// (`POST /v1/tools/fetch`) is the second reader of `web_read`, asked only after our own read — robots.txt, the pinned
// public address, the size caps — has run and ended unreadable for a reason a server-side fetcher can overcome. The
// runtime never reaches either: it names a query or a page, the control plane calls DeepSeek with the deployment's own
// key, and the kernel's container holds no provider key (the same rule as the model gateway).
//
// What the wire looked like when this was written (recorded 2026-10-17 from the live API; test/fixtures/deepseek-tools):
// a search answers `{results:[{title,url,site_name,site_icon,authority,rerank_score,date,summary,snippet,content}]}` in
// 0.4–0.7 s, `rerank_score` 0–3 and `authority` 0–4 (−1 unknown); a query over 128 characters is a 400; a fetch answers
// `{title,content}` with the page as backslash-escaped Markdown, and gives up on a page it cannot get with a 504 after
// 30 s. Errors are `{error:{message,type,code}}`; a 401 masks the key (`****0000`), and no message of DeepSeek's is
// passed on here regardless — only its status.
//
// Each tool is limited to five requests a second per account (fetch also per site) and billed $0.75 per thousand
// successful requests. The limit is held here by one pacer per tool for the whole process; the bill is booked like a
// model call (`reserveGatewaySpend`, purpose `web-search`), and a request that fails is released, because DeepSeek
// bills only the ones that succeed.
import { createHash } from "node:crypto";
import { priceUsage } from "@evimed/domain";
import { GatewaySpendRefusal, reserveGatewaySpend } from "./gatewaySpend.mjs";
import { recordProviderRefusal } from "./providerRefusals.mjs";
import { PROVIDER_REFUSAL_STATUSES } from "./usageLedger.mjs";
import { HostPacer } from "./webReadLimits.mjs";
import { isOfficialWebSource } from "./webReadOfficial.mjs";

export const DEEPSEEK_SEARCH_PATH = "/v1/tools/search";
export const DEEPSEEK_FETCH_PATH = "/v1/tools/fetch";
/** DeepSeek's limit for each tool, per account. */
export const DEEPSEEK_TOOL_REQUESTS_PER_SECOND = 5;
/** The longest query DeepSeek's search accepts; a longer one is not sent (the other engines still answer it). */
export const DEEPSEEK_SEARCH_MAX_QUERY = 128;
/** DeepSeek's own deadline for a fetch, plus the round trip: the time a read keeps back for its second reader. */
export const DEEPSEEK_FETCH_RESERVE_MS = 35_000;
/** The most a request waits for the pacer; one that would wait longer is shed and its gateway answers without it. */
const LIMITER_MAX_WAIT_MS = 2_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** `/v1/tools/search` returns at most fifty results. */
const MAX_SEARCH_COUNT = 50;
const API_HOST = "api.deepseek.com";

/** How a tool request ended, for the operator's metrics; a closed list so the label set stays closed. */
export const DEEPSEEK_TOOL_OUTCOMES = Object.freeze([
  "ok", "shed", "budget", "unrecordable", "rate_limited", "content_refused", "timeout", "refused", "upstream_error", "unavailable", "response_invalid",
]);

/** Why a tool request gave no answer. `outcome` is one of `DEEPSEEK_TOOL_OUTCOMES`; `status` is DeepSeek's HTTP status, 0 when none came. */
export class DeepSeekToolError extends Error {
  /** @param {string} outcome @param {string} message @param {number} [status] */
  constructor(outcome, message, status = 0) {
    super(message);
    this.outcome = outcome;
    this.status = status;
    this.upstream = status ? { host: API_HOST, status } : null;
  }
}

/** @param {number} status */
function outcomeOfStatus(status) {
  if (status === 403) return "content_refused";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 400 && status < 500) return "refused";
  return "upstream_error";
}

/**
 * The page as text: DeepSeek's Fetch escapes every ASCII punctuation mark with a backslash (`Search \/ Fetch API is now
 * available\,`), which a quotation copied from the page would never match. CommonMark's own rule undoes it — a backslash
 * before ASCII punctuation is that character — and touches nothing else. Deterministic, so the same answer always gives
 * the same text.
 * @param {string} markdown @returns {string}
 */
export function unescapedRendition(markdown) {
  return String(markdown ?? "").replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/**
 * A result's day as a reader means it. DeepSeek writes a day as its midnight in Beijing, in UTC: an article of
 * 2026-10-17 16:34 CST comes back `2026-10-16T16:00:00+00:00` (recorded 2026-10-17), and passed on as it is, a model
 * reports the day before. A midnight at +08:00 is given as that day; any other instant is passed on unchanged.
 * @param {unknown} value @returns {string | null}
 */
export function deepseekResultDate(value) {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const beijing = at + 8 * 3_600_000;
  if (beijing % 86_400_000 === 0) return new Date(beijing).toISOString().slice(0, 10);
  return value.slice(0, 40);
}

/**
 * One search result in the gateway's row shape, keeping what DeepSeek knows that the other engines do not: the day, the
 * site's name and DeepSeek's authority rating of it. `summary` is the page's lead, `snippet` the excerpt around the query.
 * @param {any} row
 */
function searchRow(row) {
  const authority = Number(row?.authority);
  return {
    url: row?.url,
    title: row?.title,
    content: String(row?.summary ?? "").trim() || String(row?.snippet ?? ""),
    engine: "deepseek",
    publishedDate: deepseekResultDate(row?.date),
    site: typeof row?.site_name === "string" && row.site_name.trim() ? row.site_name.trim().slice(0, 120) : null,
    authority: Number.isInteger(authority) && authority >= 0 && authority <= 4 ? authority : null,
    rerankScore: Number.isFinite(Number(row?.rerank_score)) ? Number(row.rerank_score) : 0,
  };
}

/** Which documents stay on the parser path: a URL that names one is never sent to the second reader. */
const DOCUMENT_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|pptx?|rtf|epub)$/i;

/**
 * Why our own read of a page may be retried through DeepSeek's Fetch, or null when it may not. Only reasons a fetcher
 * elsewhere can plausibly overcome: the page is a challenge or an application shell and no browser could open it, the
 * site refused us (403) or rate-limited us (429), our read ran out of time, or the site could not be reached from here.
 * Never a robots.txt refusal, a private or unresolvable host, a malformed or forbidden URL, a size cap, a login, a page
 * that does not exist, our own pacing or concurrency limit, or a document (PDFs and office files stay on the parser path).
 * @param {any} error what our read threw @param {string} url the page asked for @param {{ timedOut?: boolean }} [options]
 *   `timedOut`: our read's own deadline ended it
 * @returns {string | null}
 */
export function webReadFallbackReason(error, url, { timedOut = false } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (DOCUMENT_EXTENSIONS.test(parsed.pathname)) return null;
  if (timedOut) return "timeout";
  switch (error?.code) {
    case "web_read_needs_browser": return "needs_browser";
    case "web_read_unreadable":
    case "web_render_failed":
    case "web_render_timeout": return "unreadable_after_render";
    case "web_read_timeout": return "timeout";
    case "web_read_upstream_unavailable": return "unreachable";
    case "web_read_upstream_error": return error?.siteStatus === 403 || error?.siteStatus === 429 ? `site_${error.siteStatus}` : null;
    default: return null;
  }
}

/**
 * The page as DeepSeek's Fetch rendered it, in `web_read`'s result shape. The receipt says so (`via`), carries why our
 * own read did not give the page (`fallbackReason`), and its sha256 is of the rendition exactly as the platform received
 * it — the bytes the text was taken from, as for any read. There are no page bytes to keep beside it: a rendition is not
 * the page.
 * @param {{ url: string, title: string, content: string, reason: string, now?: () => Date }} input
 */
export function deepseekRenditionResult({ url, title, content, reason, now = () => new Date() }) {
  const requested = new URL(url);
  const received = Buffer.from(String(content ?? ""), "utf8");
  return {
    receipt: {
      url: requested.href,
      finalUrl: requested.href,
      title: String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || requested.hostname,
      site: requested.hostname,
      fetchedAt: now().toISOString(),
      official: isOfficialWebSource(requested.href),
      rendered: false,
      contentType: "text",
      mediaType: "text/markdown",
      status: 200,
      sha256: createHash("sha256").update(received).digest("hex"),
      bytes: received.length,
      extractor: { name: "deepseek-fetch", version: "1" },
      via: "deepseek-fetch",
      fallbackReason: reason,
    },
    text: unescapedRendition(content),
    links: [],
  };
}

/** @param {Response} response @returns {Promise<any>} */
async function boundedJson(response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new DeepSeekToolError("response_invalid", "DeepSeek's answer exceeded the gateway limit.", response.status);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new DeepSeekToolError("response_invalid", "DeepSeek's answer exceeded the gateway limit.", response.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new DeepSeekToolError("response_invalid", "DeepSeek returned a non-JSON answer.", response.status);
  }
}

/**
 * @param {any} config
 * @param {{ fetchImpl?: typeof fetch, usageLedger?: any, attributeRun?: any, runPurpose?: any, runScope?: any,
 *   now?: () => number, wait?: (ms: number, signal?: AbortSignal) => Promise<unknown> }} [options]
 *   `usageLedger` / `attributeRun` / `runPurpose` / `runScope`: where a request is booked and which run it is charged
 *   to, as for the Bailian search; `now` / `wait` drive the pacers (a test's clock)
 */
export function createDeepSeekTools(config, { fetchImpl = fetch, usageLedger = null, attributeRun = null, runPurpose = null, runScope = null, now = Date.now, wait } = {}) {
  const key = String(config.deepseekApiKey ?? "").trim();
  const base = String(config.deepseekBaseUrl ?? "").trim().replace(/\/+$/, "") || `https://${API_HOST}`;
  const interval = Math.ceil(1_000 / DEEPSEEK_TOOL_REQUESTS_PER_SECOND);
  /** One pacer per tool for the whole process: DeepSeek counts each tool's requests per account. */
  const pacers = {
    search: new HostPacer({ intervalMs: interval, maxWaitMs: LIMITER_MAX_WAIT_MS, now, ...(wait ? { wait } : {}) }),
    fetch: new HostPacer({ intervalMs: interval, maxWaitMs: LIMITER_MAX_WAIT_MS, now, ...(wait ? { wait } : {}) }),
  };
  /** @type {Record<"search" | "fetch", Record<string, number>>} */
  const outcomes = {
    search: Object.fromEntries(DEEPSEEK_TOOL_OUTCOMES.map((name) => [name, 0])),
    fetch: Object.fromEntries(DEEPSEEK_TOOL_OUTCOMES.map((name) => [name, 0])),
  };

  /**
   * One request: paced, reserved, sent, and its reservation closed by how it ended.
   * @param {"search" | "fetch"} tool @param {Record<string, unknown>} body @param {any} caller @param {AbortSignal} signal
   */
  async function call(tool, body, caller, signal) {
    try {
      try {
        await pacers[tool].acquire("deepseek", { signal });
      } catch (error) {
        if (error?.code === "web_read_host_busy") throw new DeepSeekToolError("shed", `DeepSeek's ${tool} is at its request rate; this request was not sent.`);
        throw error;
      }
      const model = `deepseek-${tool}`;
      const price = priceUsage({ resourceType: "tool-request", tool: model, requests: 1, peak: true });
      let reservation;
      try {
        reservation = await reserveGatewaySpend({
          config, usageLedger, caller, attributeRun, runPurpose, runScope, model, estimatedCost: price.cost,
          fingerprint: { tool: model, ...body },
        });
      } catch (error) {
        if (!(error instanceof GatewaySpendRefusal)) throw error;
        throw new DeepSeekToolError(error.reason === "budget" ? "budget" : "unrecordable", `The DeepSeek ${tool} is unavailable: ${error.message}`);
      }
      /** @param {(ledger: any) => Promise<unknown>} write */
      const close = (write) => (reservation ? write(usageLedger).catch(() => { /* the reconciliation sweep books what this could not */ }) : undefined);
      let response;
      try {
        response = await fetchImpl(`${base}${tool === "search" ? DEEPSEEK_SEARCH_PATH : DEEPSEEK_FETCH_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          redirect: "error",
          signal,
        });
      } catch {
        // Sent, and no answer: DeepSeek may have served it, so it may be billed.
        await close((ledger) => ledger.markUncertain(caller.userId, reservation.id, "provider_response_incomplete", { estimatedCost: price.cost }));
        if (signal.aborted && signal.reason?.name === "TimeoutError") throw new DeepSeekToolError("timeout", `DeepSeek's ${tool} did not answer in time.`);
        if (signal.aborted) throw signal.reason;
        throw new DeepSeekToolError("unavailable", `DeepSeek's ${tool} could not be reached.`);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        recordProviderRefusal("deepseek", response.status);
        // Only a successful request is billed: an answer that is an error releases its reservation, whatever the status.
        const code = PROVIDER_REFUSAL_STATUSES.includes(response.status) ? `provider_refused_${response.status}` : `provider_failed_${response.status}`;
        await close((ledger) => ledger.release(caller.userId, reservation.id, code));
        throw new DeepSeekToolError(outcomeOfStatus(response.status), `DeepSeek's ${tool} answered HTTP ${response.status}.`, response.status);
      }
      // A 2xx is a request DeepSeek counts as served and bills, whether or not its body is usable.
      await close((ledger) => ledger.settleModel(caller.userId, reservation.id, {
        usage: { cacheHitTokens: 0, cacheMissTokens: 0, completionTokens: 0 }, actualCost: price.cost, priced: price.priced,
      }));
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof DeepSeekToolError) outcomes[tool][error.outcome] += 1;
      throw error;
    }
  }

  return {
    /** Whether the web-search gateway asks DeepSeek: its lever, and a key to ask with. */
    searchEnabled: config.webSearchDeepseekEnabled !== false && Boolean(key),
    /** Whether `web_read` has DeepSeek's Fetch as its second reader. */
    fetchEnabled: config.webReadDeepseekFallbackEnabled !== false && Boolean(key),

    /**
     * Rows for the web-search gateway, DeepSeek's best first. The caller sends no query longer than
     * `DEEPSEEK_SEARCH_MAX_QUERY`.
     * @param {{ query: string, limit: number }} request @param {{ caller: any, signal: AbortSignal }} context
     */
    async search(request, { caller, signal }) {
      const payload = await call("search", { query: request.query, count: Math.min(MAX_SEARCH_COUNT, Math.max(1, request.limit)) }, caller, signal);
      if (!Array.isArray(payload?.results)) {
        outcomes.search.response_invalid += 1;
        throw new DeepSeekToolError("response_invalid", "DeepSeek's search answer carried no results.", 200);
      }
      outcomes.search.ok += 1;
      return payload.results.map(searchRow).sort((left, right) => right.rerankScore - left.rerankScore);
    },

    /**
     * The page as DeepSeek's Fetch renders it.
     * @param {string} url @param {{ caller: any, signal: AbortSignal }} context
     * @returns {Promise<{ title: string, content: string }>}
     */
    async fetch(url, { caller, signal }) {
      const payload = await call("fetch", { url }, caller, signal);
      if (typeof payload?.content !== "string" || !payload.content.trim()) {
        outcomes.fetch.response_invalid += 1;
        throw new DeepSeekToolError("response_invalid", "DeepSeek's fetch answer carried no text.", 200);
      }
      outcomes.fetch.ok += 1;
      return { title: typeof payload.title === "string" ? payload.title : "", content: payload.content };
    },

    /** Counters for the operator's metrics endpoint. */
    stats() {
      return {
        outcomes: { search: { ...outcomes.search }, fetch: { ...outcomes.fetch } },
        limiter: { search: { ...pacers.search.counts }, fetch: { ...pacers.fetch.counts } },
      };
    },
  };
}

/**
 * The tools' counters as metric families: every request by how it ended, and every time the per-account rate made one
 * wait or shed it (principle 15).
 * @param {ReturnType<ReturnType<typeof createDeepSeekTools>["stats"]> | null | undefined} stats
 * @returns {Array<{ name: string, help: string, type: "counter", series: Array<{ value: number, labels: Record<string, string> }> }>}
 */
export function deepseekToolMetricFamilies(stats) {
  if (!stats) return [];
  return [
    {
      name: "open_science_deepseek_tool_requests_total",
      help: "Requests to DeepSeek's Search (the web-search gateway) and Fetch (web_read's second reader), by how they ended. Only ok is billed.",
      type: "counter",
      series: /** @type {const} */ (["search", "fetch"]).flatMap((tool) => DEEPSEEK_TOOL_OUTCOMES.map((outcome) => ({ value: stats.outcomes[tool][outcome] ?? 0, labels: { tool, outcome } }))),
    },
    {
      name: "open_science_deepseek_tool_limiter_total",
      help: "Times DeepSeek's per-account limit of five requests a second made a tool request wait, or shed it so its gateway answered without DeepSeek.",
      type: "counter",
      series: /** @type {const} */ (["search", "fetch"]).flatMap((tool) => [
        { value: stats.limiter[tool].waited ?? 0, labels: { tool, action: "waited" } },
        { value: stats.limiter[tool].refused ?? 0, labels: { tool, action: "shed" } },
      ]),
    },
  ];
}
