/**
 * Reading one public web page for a run: tier 2 (direct fetch and main-text
 * extraction) with tier 3 (a remote browser) on demand, PDFs and office
 * documents through the document parser. Tier 1 — the ~70 biomedical APIs —
 * is the public-source gateway's API mode and does not pass through here.
 *
 * The contract a run relies on, in order:
 *
 *   1. every hop is a public http(s) URL on a default port, and the socket
 *      connects only to addresses that were checked (webReadNetwork);
 *   2. robots.txt is honoured when it can be read (webReadRobots);
 *   3. one site hears from us at most once a second, and a bounded number of
 *      reads run at once (webReadLimits);
 *   4. a page that is a JavaScript challenge or an empty application shell is
 *      opened in AgentBay's cloud browser — never a browser on this host — and
 *      a page still unreadable after that is a named error, so the run moves to
 *      another source instead of citing a shell;
 *   5. whatever is returned carries a receipt: where the bytes came from, when,
 *      whether a browser drew them, their sha256, and whether the source is an
 *      authority's (a label that never decides whether a page is read).
 *
 * @module webRead
 */

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { decodePage, extractHtmlIsolated, HTML_EXTRACTOR, renderReason, SHELL_VISIBLE_CHARS } from "./webReadExtract.mjs";
import { ConcurrencyGate, HostPacer, KeyedConcurrencyGate } from "./webReadLimits.mjs";
import {
  assertPublicWebHost,
  fetchWebTransport,
  headerValue,
  nodeWebTransport,
  validatedWebUrl,
  webReadError,
  WebReadError,
} from "./webReadNetwork.mjs";
import { isOfficialWebSource } from "./webReadOfficial.mjs";
import { RobotsPolicy, WEB_READ_PRODUCT_TOKEN } from "./webReadRobots.mjs";

/** Redirect hops one read follows, meta refresh included. */
export const WEB_READ_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * HTML beyond this is cut before parsing. A parsed DOM costs ten to twenty
 * times its source in memory, and eight concurrent 16 MiB pages would ask a
 * shared 15.5 GB host for gigabytes; no document page is anywhere near this.
 * The render tier holds a browser's HTML to it too (agentbay/browser.mjs).
 */
export const HTML_MAX_BYTES = 5 * 1024 * 1024;

/**
 * One page's parse, in its own thread (webReadExtract.extractHtmlIsolated).
 * The most HTML a read parses, 5 MiB, takes 0.4–0.7 s here (measured
 * 2026-09-19: a 5 MiB table of notices 0.44 s, 5 MiB of prose 0.64 s); the
 * security review's 360 KB of nested tags took 16 s. Ten seconds is over ten
 * times the real worst case, and stops a hostile page holding a parse slot
 * and a core for the read's whole budget. Counted, with pages nested past
 * what the thread's stack can walk, in
 * open_science_web_read_limits_total{limit="parse"}.
 */
const HTML_PARSE_TIMEOUT_MS = 10_000;

/**
 * Parses at once, each a thread with its own heap — about 150 MB for 5 MiB of
 * real HTML, 300 MB for 5 MiB of bare tags (measured) — and a core. On the
 * event loop they ran one at a time; two keep the worst case near that, and a
 * parse is short enough that a queue behind two is brief. Counted in
 * open_science_web_read_limits_total{limit="parse_concurrency"}.
 */
const HTML_PARSES_AT_ONCE = 2;

/**
 * Media types handed to the document parser: PDFs — society guidelines,
 * regulator attachments — and the office formats regulators attach to notices,
 * all of which the parser reads. Anything that is neither this, HTML nor plain
 * text is refused by name.
 */
const DOCUMENT_MEDIA_TYPES = new Map([
  ["application/pdf", "pdf"],
  ["application/msword", "doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.ms-excel", "xls"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.ms-powerpoint", "ppt"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/rtf", "rtf"],
  ["text/rtf", "rtf"],
  ["application/epub+zip", "epub"],
]);
const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
/** Labels servers put on a download they did not bother to type. */
const UNTYPED_MEDIA_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/force-download", "application/x-download"]);

/**
 * The User-Agent every direct fetch sends: the product token robots.txt is
 * matched against, and where to find who we are. The deployment's own public
 * address is that place; a deployment that never set one names the company.
 * @param {any} config
 */
export function webReadUserAgent(config) {
  const contact = String(config?.publicUrl ?? "").trim() || "https://www.evimed.com";
  return `${WEB_READ_PRODUCT_TOKEN}/1.0 (+${contact}; reads the pages a researcher's run asks for)`;
}

/**
 * The transport a deployment reads the web with: the pinned one, unless the
 * evaluation corpus has the gateway replaying or recording
 * (`OPEN_SCIENCE_GATEWAY_FIXTURES` / `_RECORD`), in which case web reads go
 * through the same replaying fetch as every other upstream answer.
 * @param {Record<string, string | undefined>} env @param {typeof fetch} gatewayFetch
 * @returns {import("./webReadNetwork.mjs").WebTransport}
 */
export function webReadTransportFor(env, gatewayFetch) {
  const replaying = String(env?.OPEN_SCIENCE_GATEWAY_FIXTURES ?? "").trim() || String(env?.OPEN_SCIENCE_GATEWAY_RECORD ?? "").trim();
  return replaying ? fetchWebTransport(gatewayFetch) : nodeWebTransport();
}

/** @param {Buffer | Uint8Array} bytes */
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {URL} url @param {string} extension */
function documentFilename(url, extension) {
  const last = decodeURIComponent(url.pathname.split("/").pop() ?? "").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120);
  if (last && last.toLowerCase().endsWith(`.${extension}`)) return last;
  return `${last || url.hostname}.${extension}`;
}

/**
 * @typedef {object} WebReadReceipt
 * @property {string} url the URL the run asked for
 * @property {string} finalUrl where the bytes came from, after redirects
 * @property {string} title
 * @property {string} site the final URL's host
 * @property {string} fetchedAt ISO time
 * @property {boolean} official
 * @property {boolean} rendered whether a browser drew the page
 * @property {"html" | "text" | "document"} contentType
 * @property {string} mediaType
 * @property {number} status HTTP status of the answer read
 * @property {string} sha256 of the exact bytes the text was taken from
 * @property {number} bytes
 * @property {{ name: string, version: string, parser?: string }} extractor
 * @property {boolean} [truncated]
 */

/**
 * @typedef {object} WebReadResult
 * @property {WebReadReceipt} receipt
 * @property {string} text
 * @property {Array<{ text: string, url: string }>} links
 * @property {any[]} [pageMap]
 * @property {Record<string, any>} [metadata]
 * @property {string} [notice] what the reader should know about completeness
 */

/**
 * @typedef {object} WebRenderer
 * @property {boolean} enabled
 * @property {(request: { url: URL, signal?: AbortSignal }) => Promise<{ html: string, finalUrl: string, status: number }>} render
 * @property {() => Promise<void>} [close]
 * @property {() => Record<string, number>} [stats]
 */

/**
 * `documentParser` is the document-parser client (contract X2): its
 * `parseBytes({ bytes, filename, mediaType, sha256 })` returns protocol v1.
 * A client without that method means documents are refused by name.
 *
 * @param {any} config
 * @param {{
 *   transport?: import("./webReadNetwork.mjs").WebTransport,
 *   resolveImpl?: (hostname: string, options: { all: true }) => Promise<any>,
 *   renderer?: WebRenderer | null,
 *   documentParser?: any,
 *   now?: () => Date,
 *   parseTimeoutMs?: number,
 * }} [dependencies]
 */
export function createWebReader(config, {
  resolveImpl = dnsLookup,
  transport = nodeWebTransport({ resolveImpl }),
  renderer = null,
  documentParser = null,
  now = () => new Date(),
  parseTimeoutMs = HTML_PARSE_TIMEOUT_MS,
} = {}) {
  const userAgent = webReadUserAgent(config);
  const maxBytes = Math.max(1024, Number(config.publicSourceGatewayMaxResponseBytes) || 16 * 1024 * 1024);
  const robots = new RobotsPolicy({ transport, userAgent });
  const pacer = new HostPacer({ intervalMs: Number(config.webReadHostIntervalMs ?? 1_000) });
  const gate = new ConcurrencyGate({ limit: Number(config.webReadConcurrency ?? 8), busyCode: "web_read_busy" });
  const parseGate = new ConcurrencyGate({ limit: HTML_PARSES_AT_ONCE, busyCode: "web_read_busy" });
  // A whole read — fetch, render, parse — holds one of its runtime's slots.
  const runtimeGates = new KeyedConcurrencyGate({
    limit: Number(config.webReadRuntimeConcurrency ?? 3),
    maxQueue: 16,
    busyCode: "web_read_runtime_busy",
    busyMessage: "This project already has as many web reads under way as it may queue; let them finish before reading more.",
  });
  /** Parses refused: out of time, or nested past what the thread can walk. */
  let parsesRefused = 0;
  /** How each read ended, for the operator's metrics. */
  const outcomes = { html: 0, rendered: 0, document: 0, text: 0, thin: 0, refused: 0, failed: 0 };

  /**
   * An HTML page's text, parsed off the event loop.
   * @param {string} html @param {URL} baseUrl @param {AbortSignal | undefined} signal
   */
  async function extract(html, baseUrl, signal) {
    try {
      return await parseGate.run(() => extractHtmlIsolated(html, { baseUrl, timeoutMs: parseTimeoutMs, signal }), { signal });
    } catch (error) {
      if (error?.code === "web_read_page_too_complex") parsesRefused += 1;
      throw error;
    }
  }

  /**
   * Fetch, following redirects by hand so every hop is validated, robots
   * checked on every origin it lands on, and paced per host.
   * @param {URL} start @param {AbortSignal | undefined} signal @param {number} budget hops left
   */
  async function fetchPage(start, signal, budget) {
    let url = start;
    for (let hop = 0; hop <= budget; hop += 1) {
      url = validatedWebUrl(url);
      const verdict = await robots.check(url, { signal });
      if (!verdict.allowed) {
        throw webReadError(403, "web_read_robots_disallowed", `${url.hostname}'s robots.txt does not allow reading this page; use another source for it.`);
      }
      await pacer.acquire(url.hostname, { crawlDelayMs: verdict.crawlDelayMs, signal });
      const target = url;
      const response = await gate.run(() => transport({
        url: target,
        headers: {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal,
        maxBytes,
      }), { signal });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = headerValue(response.headers, "location");
        if (!location) return { url, response, hopsLeft: budget - hop };
        url = new URL(location, url);
        continue;
      }
      return { url, response, hopsLeft: budget - hop };
    }
    throw webReadError(502, "web_read_too_many_redirects", "The web page redirected too many times.");
  }

  /**
   * @param {URL} requested @param {URL} finalUrl @param {Buffer} bytes
   * @param {{ title: string, rendered: boolean, contentType: "html" | "text" | "document", mediaType: string, status: number, extractor: any, truncated?: boolean }} facts
   * @returns {WebReadReceipt}
   */
  function receipt(requested, finalUrl, bytes, facts) {
    return {
      url: requested.href,
      finalUrl: finalUrl.href,
      title: String(facts.title || finalUrl.hostname).slice(0, 300),
      site: finalUrl.hostname,
      fetchedAt: now().toISOString(),
      official: isOfficialWebSource(finalUrl.href),
      rendered: facts.rendered,
      contentType: facts.contentType,
      mediaType: facts.mediaType,
      status: facts.status,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      extractor: facts.extractor,
      ...(facts.truncated ? { truncated: true } : {}),
    };
  }

  /**
   * The page after a browser has run it, or the named reason it is still
   * unreadable. The browser's final address is checked against this
   * network's DNS as well: the page's script ran on AgentBay's machine, but
   * what it ended up showing is returned from here.
   * @param {URL} requested @param {URL} finalUrl @param {AbortSignal | undefined} signal
   * @returns {Promise<WebReadResult>}
   */
  async function renderedRead(requested, finalUrl, signal) {
    const rendered = await /** @type {WebRenderer} */ (renderer).render({ url: finalUrl, signal });
    const renderedUrl = validatedWebUrl(rendered.finalUrl || finalUrl.href);
    await assertPublicWebHost(renderedUrl.hostname, resolveImpl);
    // Held to the fetched page's cap: after a browser, the page's own script
    // decided how large its document grew.
    const drawn = Buffer.from(String(rendered.html ?? ""), "utf8");
    const bytes = drawn.length > HTML_MAX_BYTES ? drawn.subarray(0, HTML_MAX_BYTES) : drawn;
    const html = bytes.toString("utf8");
    const page = await extract(html, renderedUrl, signal);
    const status = Number(rendered.status) || 200;
    const still = renderReason({ status, html, visibleChars: page.visibleChars });
    // After a browser, a short page that is a real 2xx document with no
    // challenge in it is simply short.
    const readable = !still || (still.kind === "shell" && !still.vendor && page.visibleChars > 0);
    if (!readable || status < 200 || status >= 300) {
      throw webReadError(422, "web_read_unreadable", `${renderedUrl.hostname} is still unreadable after rendering; use another source for this page.`);
    }
    outcomes.rendered += 1;
    return {
      receipt: receipt(requested, renderedUrl, bytes, {
        title: page.title, rendered: true, contentType: "html", mediaType: "text/html", status,
        extractor: HTML_EXTRACTOR, truncated: page.truncated || bytes.length < drawn.length,
      }),
      text: page.text,
      links: page.links,
    };
  }

  /**
   * @param {URL} requested
   * @param {{ url: URL, response: import("./webReadNetwork.mjs").TransportResponse, hopsLeft: number }} fetched
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<WebReadResult>}
   */
  async function interpret(requested, fetched, signal) {
    const { url: finalUrl, response } = fetched;
    const contentTypeHeader = headerValue(response.headers, "content-type");
    let mediaType = contentTypeHeader.split(";", 1)[0].trim().toLowerCase();
    if (UNTYPED_MEDIA_TYPES.has(mediaType)) {
      const head = response.body.subarray(0, 1024).toString("latin1");
      if (head.startsWith("%PDF-")) mediaType = "application/pdf";
      else if (/^\s*(?:<!doctype html|<html)/i.test(head)) mediaType = "text/html";
    }
    const ok = response.status >= 200 && response.status < 300;

    if (HTML_MEDIA_TYPES.has(mediaType)) {
      const bytes = response.body.length > HTML_MAX_BYTES ? response.body.subarray(0, HTML_MAX_BYTES) : response.body;
      const html = decodePage(bytes, contentTypeHeader);
      const page = await extract(html, finalUrl, signal);
      // An empty page that says where the document is: one more hop, the
      // same way a 3xx is followed.
      if (ok && page.visibleChars < SHELL_VISIBLE_CHARS && page.refreshUrl && fetched.hopsLeft > 0) {
        return interpret(requested, await fetchPage(new URL(page.refreshUrl), signal, fetched.hopsLeft - 1), signal);
      }
      const reason = renderReason({ status: response.status, html, visibleChars: page.visibleChars });
      const direct = () => {
        outcomes.html += 1;
        return {
          receipt: receipt(requested, finalUrl, bytes, {
            title: page.title, rendered: false, contentType: /** @type {"html"} */ ("html"), mediaType, status: response.status,
            extractor: HTML_EXTRACTOR, truncated: page.truncated || bytes.length < response.body.length,
          }),
          text: page.text,
          links: page.links,
        };
      };
      if (!reason) {
        if (!ok) throw upstreamStatusError(response.status, finalUrl);
        return direct();
      }
      // A thin but real page is kept when no browser can do better
      // (principle 19): the run is told it may be incomplete.
      const thin = ok && reason.kind === "shell" && page.visibleChars > 0;
      if (renderer?.enabled) {
        try {
          return await renderedRead(requested, finalUrl, signal);
        } catch (error) {
          if (!thin || error?.code === "web_read_unreadable" || error?.code === "web_read_host_forbidden") throw error;
          outcomes.thin += 1;
          return { ...direct(), notice: "The page draws most of its text in script and the browser could not open it; this text may be incomplete." };
        }
      }
      if (thin) {
        outcomes.thin += 1;
        return { ...direct(), notice: "The page draws most of its text in script and this deployment has no browser to run it; this text may be incomplete." };
      }
      throw webReadError(422, "web_read_needs_browser", `${finalUrl.hostname} answers a plain client with a ${reason.kind === "shell" ? "blank application page" : "JavaScript challenge"} and this deployment cannot render pages; use another source for it.`);
    }

    if (!ok) throw upstreamStatusError(response.status, finalUrl);

    const extension = DOCUMENT_MEDIA_TYPES.get(mediaType);
    if (extension) {
      if (typeof documentParser?.parseBytes !== "function") {
        throw webReadError(503, "web_read_document_parser_unavailable", "Reading PDFs and office documents needs the document parser, which this deployment has not configured.");
      }
      const sha256 = sha256Hex(response.body);
      const filename = documentFilename(finalUrl, extension);
      let parsed;
      try {
        parsed = await documentParser.parseBytes({ bytes: response.body, filename, mediaType, sha256 });
      } catch (error) {
        // The parser client's own codes (`source_parser_*`,
        // `source_format_unsupported`) and messages are ours to repeat; a
        // bare exception is not.
        if (typeof error?.code === "string" && /^source_[a-z_]+$/.test(error.code)) {
          const status = Number.isSafeInteger(error.status) ? error.status : 502;
          throw webReadError(status, error.code, String(error.message ?? "The document parser failed."), { retryable: status === 429 || status >= 500 });
        }
        throw webReadError(502, "source_parser_failed", "The document parser failed on this document.", { retryable: true });
      }
      const title = String(parsed?.metadata?.title ?? "").trim() || filename;
      outcomes.document += 1;
      return {
        receipt: receipt(requested, finalUrl, response.body, {
          title, rendered: false, contentType: "document", mediaType, status: response.status,
          extractor: parsed?.extractor ?? { name: "document-parser", version: "unknown" },
        }),
        text: String(parsed?.text ?? ""),
        links: [],
        ...(Array.isArray(parsed?.pageMap) ? { pageMap: parsed.pageMap } : {}),
        ...(parsed?.metadata && typeof parsed.metadata === "object" ? { metadata: parsed.metadata } : {}),
      };
    }

    if (TEXT_MEDIA_TYPES.has(mediaType)) {
      const text = decodePage(response.body, contentTypeHeader);
      outcomes.text += 1;
      return {
        receipt: receipt(requested, finalUrl, response.body, {
          title: documentFilename(finalUrl, "txt").replace(/\.txt$/, ""), rendered: false, contentType: "text", mediaType,
          status: response.status, extractor: { name: "plain-text", version: "1.0.0" },
        }),
        text,
        links: [],
      };
    }

    throw webReadError(415, "web_read_content_type_unsupported", `The page is ${mediaType || "an untyped download"}, which web reading does not read (HTML, plain text, PDF and office documents are read).`);
  }

  /**
   * @param {string | URL} rawUrl
   * @param {{ signal?: AbortSignal, runtime?: { userId: string, projectId: string } }} [options]
   *   `runtime`: the project runtime asking, whose reads share one limit
   * @returns {Promise<WebReadResult>}
   */
  async function read(rawUrl, { signal, runtime } = {}) {
    try {
      const requested = validatedWebUrl(rawUrl);
      const whole = async () => interpret(requested, await fetchPage(requested, signal, WEB_READ_MAX_REDIRECTS), signal);
      if (!runtime) return await whole();
      return await runtimeGates.run(`${runtime.userId}\u0000${runtime.projectId}`, whole, { signal });
    } catch (error) {
      if (error instanceof WebReadError && error.status < 500) outcomes.refused += 1;
      else outcomes.failed += 1;
      throw error;
    }
  }

  return {
    read,
    /** Counters for the operator's metrics endpoint. */
    stats() {
      return {
        outcomes: { ...outcomes },
        robots: { ...robots.counts },
        pacing: { ...pacer.counts },
        concurrency: { ...gate.counts, active: gate.active },
        parsing: { ...parseGate.counts, active: parseGate.active, refusedPages: parsesRefused },
        runtimeConcurrency: { ...runtimeGates.counts, runtimes: runtimeGates.gates.size },
        render: renderer?.stats?.() ?? null,
      };
    },
    async close() {
      await renderer?.close?.();
    },
  };
}

/** @param {number} status @param {URL} url */
function upstreamStatusError(status, url) {
  if (status === 404 || status === 410) {
    return webReadError(404, "web_read_not_found", `${url.hostname} says this page does not exist (HTTP ${status}).`);
  }
  if (status === 401) {
    return webReadError(403, "web_read_login_required", `${url.hostname} requires a login for this page; web reading never logs in.`);
  }
  return webReadError(status >= 500 ? 502 : 400, "web_read_upstream_error", `${url.hostname} answered HTTP ${status}.`, { retryable: status >= 500 || status === 429 });
}

/**
 * The reader's counters as metric families for the operator endpoint: what
 * each read came to, and every limit that made a read wait or refused it
 * (principle 15 — a limit nobody can see biting is a limit nobody can tune).
 * @param {ReturnType<ReturnType<typeof createWebReader>["stats"]> | null | undefined} stats
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function webReadMetricFamilies(stats) {
  if (!stats) return [];
  const render = stats.render ?? {};
  return [
    {
      name: "open_science_web_read_outcomes_total",
      help: "Web reads by how they ended: read directly, rendered, parsed as a document, kept thin, refused, or failed.",
      type: "counter",
      series: Object.entries(stats.outcomes).map(([outcome, value]) => ({ value, labels: { outcome } })),
    },
    {
      name: "open_science_web_read_limits_total",
      help: "Times a web-reading limit made a read wait or refused it, by limit and action.",
      type: "counter",
      series: [
        { value: stats.pacing.waited, labels: { limit: "host_interval", action: "waited" } },
        { value: stats.pacing.refused, labels: { limit: "host_interval", action: "refused" } },
        { value: stats.concurrency.queued, labels: { limit: "concurrency", action: "queued" } },
        { value: stats.concurrency.refused, labels: { limit: "concurrency", action: "refused" } },
        { value: stats.robots.disallowed, labels: { limit: "robots", action: "refused" } },
        { value: stats.robots.unreachable, labels: { limit: "robots", action: "unreachable_allowed" } },
        { value: stats.parsing.queued, labels: { limit: "parse_concurrency", action: "queued" } },
        { value: stats.parsing.refused, labels: { limit: "parse_concurrency", action: "refused" } },
        { value: stats.parsing.refusedPages, labels: { limit: "parse", action: "refused" } },
        { value: stats.runtimeConcurrency.queued, labels: { limit: "runtime_concurrency", action: "queued" } },
        { value: stats.runtimeConcurrency.refused, labels: { limit: "runtime_concurrency", action: "refused" } },
      ],
    },
    {
      name: "open_science_web_render_events_total",
      help: "Cloud-browser renders, requests refused inside a rendered page, and warm-session lifecycle events.",
      type: "counter",
      series: [
        { value: Number(render.renders ?? 0), labels: { event: "render" } },
        { value: Number(render.failures ?? 0), labels: { event: "render_failed" } },
        { value: Number(render.requestsRefused ?? 0), labels: { event: "request_refused" } },
        { value: Number(render.sessionsCreated ?? 0), labels: { event: "session_created" } },
        { value: Number(render.sessionsReleased ?? 0), labels: { event: "session_released" } },
        { value: Number(render.sessionFailures ?? 0), labels: { event: "session_failed" } },
      ],
    },
    {
      name: "open_science_web_read_in_flight",
      help: "Web reads, HTML parses and renders in progress right now.",
      type: "gauge",
      series: [
        { value: stats.concurrency.active, labels: { tier: "read" } },
        { value: stats.parsing.active, labels: { tier: "parse" } },
        { value: Number(render.inFlight ?? 0), labels: { tier: "render" } },
      ],
    },
  ];
}
