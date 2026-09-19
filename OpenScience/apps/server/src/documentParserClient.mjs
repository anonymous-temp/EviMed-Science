import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sourceFileFormat, sourceFormatRoute } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/**
 * The document parser boundary: the team's own parsing API for everything a
 * text read cannot do, and a byte-exact local read for everything it can.
 *
 * Hidden knowledge, from the service's own source (`server.py`) and the one
 * deployment we can reach:
 *
 * - The envelope is `{code, message, uuid, timestamp, elapsed_ms, data}` and
 *   the HTTP status equals `code`. Errors carry `data.error_code` on the
 *   current branch, but the deployed test build answered a request with no file
 *   with `data: null` and no code at all (recorded 2026-09-19), so every
 *   decision here is keyed on the HTTP status first and the error code second.
 * - A request with no `Authorization` header came back as HTTP 500 with
 *   `'AttributeError' object has no attribute 'message'` — their bug. A 500 is
 *   therefore retried once and then named, not retried like an outage.
 * - On `develop`, `DocumentMetadataExtractor.__init__` names an undefined
 *   `chat_client`, so every metadata extraction would fail upstream and answer
 *   502 `upstream_error`. The text itself does not need that model call, so a
 *   502 that survives its retries falls back once to `/api/v1/parse/file` and
 *   the document still arrives, without metadata (principle 19).
 * - Metadata (title, authors, DOI …) is written by a language model over the
 *   first and last 8,000 characters. It is a label, never evidence: the text is
 *   what quotations are checked against, and a DOI is re-checked against
 *   Crossref before anything shows it as the document's own.
 *
 * The result keeps protocol v1 — `{protocolVersion, extractor, units, summary,
 * facts, methods, text, pageMap?, metadata?}` — so nothing downstream changes
 * when the parser does.
 */

const EXTRACT_PATH = "/api/v1/extract/text/file";
const PARSE_PATH = "/api/v1/parse/file";
const HEALTH_PATH = "/health";
/** The service refuses larger uploads with 413 (`MAX_FILE_SIZE`, 100 MB);
 *  refusing here saves sending 100 MB to be told so. */
const API_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Attempts per endpoint for a status worth retrying, and for a 500. */
const MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_INTERNAL_ERROR = 2;
/** The wait between attempts when the service names none, and the most a
 *  `Retry-After` is honoured for: a longer one is a service that is not
 *  coming back inside this parse. */
const RETRY_DELAYS_MS = Object.freeze([1_000, 4_000]);
const MAX_RETRY_AFTER_MS = 30_000;
const SUMMARY_FALLBACK = "The source contains no extractable text.";

/** @param {number} status @param {string} code @param {string} message */
function parserError(status, code, message) {
  return new HttpError(status, code, message);
}

/** How one HTTP answer is treated. Status first: the deployed build does not
 *  always say `error_code`, and the status is what it always says.
 * @param {number} status @param {string} errorCode */
function classifyFailure(status, errorCode) {
  if (status === 413) return { status: 413, code: "source_parser_payload_too_large", retry: false, message: "The document exceeds the parser's upload limit." };
  if (status === 415) return { status: 415, code: "source_format_unsupported", retry: false, message: "The parser does not support this document format." };
  if (status === 422) return { status: 422, code: "source_parser_checksum_failed", retry: false, message: "The parser could not verify the uploaded bytes." };
  if (status === 401 || status === 403) return { status: 502, code: "source_parser_auth_failed", retry: false, message: "The document parser refused this deployment's credential." };
  if (status === 429 && errorCode === "quota_exhausted") return { status: 503, code: "source_parser_quota_exhausted", retry: false, message: "The document parser's quota is exhausted." };
  if (status === 429) return { status: 503, code: "source_parser_rate_limited", retry: true, message: "The document parser is rate limiting requests." };
  if (status === 500) return { status: 502, code: "source_parser_internal_error", retry: true, attempts: MAX_ATTEMPTS_INTERNAL_ERROR, message: "The document parser failed internally." };
  if (status === 503) return { status: 503, code: "source_parser_unavailable", retry: true, message: "The document parser is unavailable." };
  if (status >= 500) return { status: 502, code: "source_parser_upstream_error", retry: true, message: "The document parser's upstream failed." };
  return { status: 502, code: "source_parser_rejected", retry: false, message: `The document parser rejected the request with HTTP ${status}.` };
}

/** `Retry-After` in seconds or as an HTTP date, bounded; `null` when absent.
 * @param {Headers} headers */
function retryAfterMs(headers) {
  const value = String(headers.get("retry-after") ?? "").trim();
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)) : null;
}

/** @param {Response} response @param {number} limit */
async function boundedBody(response, limit) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw parserError(502, "source_parser_response_too_large", "Document parser response exceeded its limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      throw parserError(502, "source_parser_response_too_large", "Document parser response exceeded its limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** A bounded string, or undefined. @param {unknown} value @param {number} max */
function metadataText(value, max) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

/** A list of bounded strings. A model asked for an array sometimes answers a
 *  single string; that is one entry, not an invalid field.
 * @param {unknown} value @param {number} maxItems @param {number} maxChars */
function metadataList(value, maxItems, maxChars) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const list = [...new Set(items.map((item) => metadataText(item, maxChars)).filter((item) => item !== undefined))];
  return list.length ? list.slice(0, maxItems) : undefined;
}

/** A DOI in its bare form, or undefined. Shape only — whether it names this
 *  document is Crossref's to say, later. @param {unknown} value */
export function normalizeDoi(value) {
  const text = metadataText(value, 300)?.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").replace(/[.,;]+$/, "");
  return text && /^10\.\d{4,9}\/\S+$/.test(text) ? text : undefined;
}

/** The bibliographic block the extract endpoint returns, typed defensively:
 *  the fields are a model's JSON, and the service passes them through as-is.
 * @param {Record<string, unknown>} data */
function mapMetadata(data) {
  /** @type {Record<string, string | string[]>} */
  const metadata = {};
  const title = metadataText(data.title, 1000);
  const authors = metadataList(data.authors, 100, 200);
  const abstract = metadataText(data.abstract, 16_000);
  const keywords = metadataList(data.keywords, 50, 100);
  const publicationDate = metadataText(data.publication_date, 100);
  const source = metadataText(data.source, 500);
  const doi = normalizeDoi(data.doi);
  if (title) metadata.title = title;
  if (authors) metadata.authors = authors;
  if (abstract) metadata.abstract = abstract;
  if (keywords) metadata.keywords = keywords;
  if (publicationDate) metadata.publicationDate = publicationDate;
  if (source) metadata.source = source;
  if (doi) metadata.doi = doi;
  return Object.keys(metadata).length ? metadata : undefined;
}

/**
 * The parser's `pages` as a page map in UTF-16 offsets of `text`.
 *
 * Nothing sends `pages` yet; it was asked for (plan §2.4) and this is what makes
 * jump-to-page light up the day it arrives. The service is Python, where a
 * string offset counts code points while ours count UTF-16 units, so offsets
 * are converted unless the answer says they are UTF-16 already. The two agree
 * on any text without characters outside the BMP, which is nearly all of it.
 * An unusable map is dropped with its reason; the document is kept.
 * @param {unknown} pages @param {string} text @param {unknown} unit
 * @returns {{ pageMap?: { page: number, start: number, end: number, status: string }[], dropped?: string }}
 */
function mapPages(pages, text, unit) {
  if (pages == null) return {};
  if (!Array.isArray(pages) || pages.length === 0) return { dropped: "pages_invalid" };
  const utf16 = ["utf16", "utf-16", "utf16_code_unit"].includes(String(unit ?? "").toLowerCase());
  /** @type {number[]} */
  const offsets = [];
  for (const entry of pages) {
    if (!entry || typeof entry !== "object") return { dropped: "pages_invalid" };
    const { start, end } = /** @type {Record<string, unknown>} */ (entry);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { dropped: "pages_invalid" };
    offsets.push(/** @type {number} */ (start), /** @type {number} */ (end));
  }
  /** @type {Map<number, number>} */
  const converted = new Map();
  if (utf16) {
    for (const offset of offsets) converted.set(offset, offset);
  } else {
    const wanted = new Set(offsets);
    let codePoints = 0;
    let units = 0;
    for (const character of text) {
      if (wanted.has(codePoints)) converted.set(codePoints, units);
      codePoints += 1;
      units += character.length;
    }
    if (wanted.has(codePoints)) converted.set(codePoints, units);
  }
  const pageMap = [];
  for (const entry of /** @type {Record<string, unknown>[]} */ (pages)) {
    const start = converted.get(/** @type {number} */ (entry.start));
    const end = converted.get(/** @type {number} */ (entry.end));
    const page = entry.index ?? entry.page;
    if (start === undefined || end === undefined || !Number.isSafeInteger(page)) return { dropped: "pages_out_of_range" };
    pageMap.push({ page: /** @type {number} */ (page), start, end, status: String(entry.status ?? "") });
  }
  let previousEnd = 0;
  let previousPage = 0;
  for (const entry of pageMap) {
    if (entry.page <= previousPage || entry.start < previousEnd || entry.end < entry.start
      || !["ok", "empty", "ocr_failed"].includes(entry.status)) return { dropped: "pages_inconsistent" };
    previousEnd = entry.end;
    previousPage = entry.page;
  }
  return { pageMap };
}

/** What a parse covered: a unit per page when pages arrived, one unit for the
 *  whole document until then. @param {string} text @param {any[] | undefined} pageMap */
function apiUnits(text, pageMap) {
  if (pageMap?.length) {
    return pageMap.map((entry) => ({ id: `page-${entry.page}`, unitType: "page",
      status: entry.status === "ok" ? "extracted" : entry.status === "empty" ? "no_content" : "failed", itemIds: [] }));
  }
  return [{ id: "document", unitType: "segment", status: text.trim() ? "extracted" : "no_content", itemIds: [] }];
}

/** @param {string} text */
function leadingSummary(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || SUMMARY_FALLBACK;
}

/**
 * Text as the file wrote it. UTF-8 first; a CSV saved by Excel on a Chinese
 * Windows machine is GB18030, and decoding it as UTF-8 would store replacement
 * characters where every drug name was. Anything neither decodes as keeps the
 * UTF-8 reading with replacement characters rather than failing the source.
 * @param {Uint8Array} bytes */
function decodeText(bytes) {
  for (const encoding of ["utf-8", "gb18030"]) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { /* next encoding */ }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export class DocumentParserClient {
  /**
   * @param {{baseUrl?:string,token?:string,revision?:string,fetchImpl?:typeof fetch,timeoutMs?:number,
   *   maxResponseBytes?:number,maxTextBytes?:number,maxUploadBytes?:number,chunkChars?:number,
   *   sleep?:(ms:number,signal:AbortSignal)=>Promise<unknown>}} config
   */
  constructor({ baseUrl = "", token = "", revision = "evimed-extract@0.5.0", fetchImpl = globalThis.fetch, timeoutMs = 300_000,
    maxResponseBytes = 64 * 1024 * 1024, maxTextBytes = 16 * 1024 * 1024, maxUploadBytes = API_MAX_UPLOAD_BYTES,
    chunkChars = 8_000, sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
    this.baseUrl = String(baseUrl).trim().replace(/\/+$/, "");
    if (this.baseUrl) {
      let parsed;
      try { parsed = new URL(this.baseUrl); } catch { throw new TypeError("Document parser URL is invalid."); }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new TypeError("Document parser URL is invalid.");
      }
    }
    if (![timeoutMs, maxResponseBytes, maxTextBytes, maxUploadBytes, chunkChars].every(Number.isSafeInteger)
      || timeoutMs < 1000 || maxResponseBytes < 1024 || maxTextBytes < 1024 || maxUploadBytes < 1024 || chunkChars < 256) {
      throw new TypeError("Document parser limits are invalid.");
    }
    const label = String(revision ?? "").trim();
    if (!label || label.length > 80 || /[\s\0]/.test(label)) throw new TypeError("Document parser revision is invalid.");
    this.token = String(token ?? "");
    this.revision = label;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxTextBytes = maxTextBytes;
    this.maxUploadBytes = Math.min(maxUploadBytes, API_MAX_UPLOAD_BYTES);
    this.chunkChars = chunkChars;
    this.sleep = sleep;
  }

  get configured() { return Boolean(this.baseUrl); }

  /**
   * Parse a file the ingestion worker already resolved inside the project. Its
   * bytes are read once, without following a link, and checked against the
   * digest the source was registered under.
   * @param {{path:string,mimeType?:string,sha256:string,sourceId?:string}} input
   */
  async parse(input) {
    const filename = path.basename(String(input.path ?? ""));
    const route = sourceFormatRoute(filename);
    // Refused before a byte is read: a recording can be gigabytes.
    if (route === "media") throw parserError(415, "source_media_unsupported", "Audio and video cannot be parsed yet.");
    if (route === "unsupported") throw parserError(415, "source_format_unsupported", "This document format cannot be parsed.");
    const limit = route === "local" ? this.maxTextBytes : this.maxUploadBytes;
    const handle = await fsp.open(input.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw parserError(400, "source_format_unsupported", "The source is not a regular file.");
      if (stat.size > limit) throw parserError(413, "source_parser_input_too_large", "The source exceeds the parser's size limit.");
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    return this.parseBytes({ bytes, filename, mediaType: input.mimeType, sha256: input.sha256 });
  }

  /**
   * Parse bytes that never became a file — the entry point for a caller that
   * holds a download in memory (contract X2).
   * @param {{bytes:Uint8Array,filename:string,mediaType?:string,sha256?:string}} input
   */
  async parseBytes({ bytes, filename, mediaType = "application/octet-stream", sha256 = "" }) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Document bytes are required.");
    const name = path.basename(String(filename ?? "")).trim();
    if (!name || name.length > 255 || name.includes("\0")) throw parserError(400, "source_format_unsupported", "The document needs a file name with its extension.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (sha256 && String(sha256).toLowerCase() !== digest) {
      throw parserError(409, "source_changed", "The document bytes do not match the digest they were registered under.");
    }
    const route = sourceFormatRoute(name);
    if (route === "media") throw parserError(415, "source_media_unsupported", "Audio and video cannot be parsed yet.");
    if (route === "unsupported") throw parserError(415, "source_format_unsupported", "This document format cannot be parsed.");
    if (route === "local") {
      if (bytes.byteLength > this.maxTextBytes) throw parserError(413, "source_parser_input_too_large", "The text source exceeds its size limit.");
      return this.#localText(bytes);
    }
    if (!this.baseUrl) throw parserError(503, "source_parser_unconfigured", "Document parsing is not configured for this deployment.");
    if (bytes.byteLength > this.maxUploadBytes) throw parserError(413, "source_parser_payload_too_large", "The document exceeds the parser's upload limit.");
    const request = { bytes, filename: name, format: sourceFileFormat(name), mediaType: String(mediaType || "application/octet-stream"), sha256: digest };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      let answer;
      let endpoint = "extract";
      try {
        answer = await this.#withRetries(EXTRACT_PATH, request, controller.signal);
      } catch (error) {
        // The metadata model failing is not the text failing: fall back once to
        // the text-only endpoint rather than lose the document (see the header).
        if (error?.code !== "source_parser_upstream_error") throw error;
        answer = await this.#withRetries(PARSE_PATH, request, controller.signal);
        endpoint = "parse";
      }
      return this.#apiResult(answer, endpoint);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof HttpError && error.status < 500)) {
        throw parserError(503, "source_parser_timeout", "Document parsing timed out.");
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** @param {any} request @param {string} endpointPath @param {AbortSignal} signal */
  async #withRetries(endpointPath, request, signal) {
    let failure = null;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        const form = new FormData();
        form.append("file", new Blob([request.bytes], { type: request.mediaType }), request.filename);
        form.append("checksum", request.sha256);
        form.append("filename", request.filename);
        form.append("format", request.format);
        response = await this.fetch(`${this.baseUrl}${endpointPath}`, {
          method: "POST",
          headers: { accept: "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
          body: form,
          redirect: "error",
          signal,
        });
      } catch {
        if (signal.aborted) throw parserError(503, "source_parser_timeout", "Document parsing timed out.");
        failure = { status: 503, code: "source_parser_unavailable", retry: true, message: "The document parser is unreachable." };
      }
      let wait = null;
      if (response) {
        const body = await boundedBody(response, this.maxResponseBytes);
        let envelope = null;
        try { envelope = JSON.parse(body.toString("utf8")); } catch { envelope = null; }
        if (response.ok) {
          if (!envelope || typeof envelope !== "object" || !envelope.data || typeof envelope.data !== "object"
            || typeof envelope.data.content !== "string") {
            throw parserError(502, "source_parser_response_invalid", "Document parser returned an unsupported response.");
          }
          return { envelope, headers: response.headers };
        }
        failure = classifyFailure(response.status, String(envelope?.data?.error_code ?? ""));
        wait = retryAfterMs(response.headers);
      }
      const attempts = failure.attempts ?? MAX_ATTEMPTS;
      if (!failure.retry || attempt >= attempts) throw parserError(failure.status, failure.code, failure.message);
      await this.sleep(wait ?? RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)], signal)
        .catch(() => { throw parserError(503, "source_parser_timeout", "Document parsing timed out."); });
    }
  }

  /** @param {{envelope:any,headers:Headers}} answer @param {string} endpoint */
  #apiResult({ envelope, headers }, endpoint) {
    const data = envelope.data;
    const text = data.content;
    if (text.length > this.maxTextBytes) throw parserError(502, "source_parser_response_too_large", "Parser full text exceeded its limit.");
    const metadata = endpoint === "extract" ? mapMetadata(data) : undefined;
    const { pageMap, dropped } = mapPages(data.pages, text, data.offset_unit ?? data.offsetUnit);
    const cost = Number(headers.get("x-quota-cost"));
    const remaining = Number(headers.get("x-quota-remaining"));
    // The quota headers and the request id are for operations: what a parse
    // cost, what is left, and the handle the parser team needs to find it.
    const extractor = {
      name: "evimed-extract", version: this.revision, parser: "api", endpoint,
      ...(typeof envelope.uuid === "string" && envelope.uuid.length <= 80 ? { requestId: envelope.uuid } : {}),
      ...(headers.get("x-quota-cost") != null && Number.isFinite(cost) ? { quota: {
        unit: String(headers.get("x-quota-unit") ?? "credit").slice(0, 32), cost,
        ...(Number.isFinite(remaining) ? { remaining } : {}),
      } } : {}),
      ...(dropped ? { pageMapDropped: dropped } : {}),
    };
    const abstract = typeof metadata?.abstract === "string" ? metadata.abstract : "";
    return {
      protocolVersion: 1,
      extractor,
      units: apiUnits(text, pageMap),
      summary: abstract ? abstract.slice(0, 16_000) : leadingSummary(text),
      facts: [],
      methods: [],
      text,
      ...(pageMap ? { pageMap } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  /** @param {Uint8Array} bytes */
  #localText(bytes) {
    const text = decodeText(bytes);
    const units = [];
    for (let offset = 0, index = 1; offset < text.length; offset += this.chunkChars, index += 1) {
      units.push({ id: `chunk-${index}`, unitType: "chunk", status: "extracted", itemIds: [] });
    }
    if (!units.length) units.push({ id: "chunk-1", unitType: "chunk", status: "no_content", itemIds: [] });
    return { protocolVersion: 1, extractor: { name: "plain-text", version: "1.0.0", parser: "local" },
      units, summary: leadingSummary(text), facts: [], methods: [], text };
  }

  /** The service's own liveness answer. No credential: `/health` is the one
   *  route that does not take one, and sending it there would only widen where
   *  the key travels. */
  async health() {
    if (!this.baseUrl) return { configured: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5000));
    timer.unref?.();
    try {
      const response = await this.fetch(`${this.baseUrl}${HEALTH_PATH}`, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
      const body = await boundedBody(response, 16 * 1024);
      let envelope = null;
      try { envelope = JSON.parse(body.toString("utf8")); } catch { envelope = null; }
      const status = envelope?.data?.status;
      if (!response.ok || status !== "healthy") {
        throw parserError(503, status === "draining" ? "source_parser_draining" : "source_parser_unavailable",
          "Document parser health check failed.");
      }
      return { configured: true, status, authenticated: Boolean(this.token), revision: this.revision,
        ...(typeof envelope.data.environment === "string" ? { environment: envelope.data.environment.slice(0, 40) } : {}) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw parserError(503, "source_parser_unavailable", "Document parser is unavailable.");
    } finally { clearTimeout(timer); }
  }
}
