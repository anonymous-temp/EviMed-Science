import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SOURCE_TEXT_SAMPLE_BYTES, sourceFileFormat, sourceFormatRoute, sourceReadRoute } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/**
 * The document parser boundary: a byte-exact local read for everything that is
 * text, the parser team's own parsing API for PDF, Office and images, a local
 * reading of PDF, Word, slides and workbooks for when that API cannot answer,
 * and — for a file none of these takes — the engine's own parsers, when the
 * caller hands one in.
 *
 * Where a file is read is `sourceReadRoute`'s answer (`@evimed/domain`): its
 * name, corrected by its bytes where the name cannot know. No file is refused
 * here for what it is called. A file nothing reads answers
 * `source_format_unsupported`, which the ingestion worker turns into a document
 * kept as an original with no text and every other caller (a pasted link, a
 * public page's file) reports as it is.
 *
 * What is true of the service now (API v1.0.0, 2026-10-27; its address and key
 * come from the environment and are written nowhere in this repository):
 *
 * - There are two engines, each its own route: `/api/v1/parse/engine-a/file` and
 *   `/api/v1/parse/engine-b/file`. They are not a primary and a standby — the
 *   service never switches between them — so which one a deployment uses is one
 *   setting (`OPEN_SCIENCE_DOCUMENT_PARSER_ENGINE`, default `engine-a`). Engine A
 *   writes `[Page N]` lines into a PDF's text, which is where the page map comes
 *   from, and a `parse_info` block; engine B sends neither. The routes the client
 *   used before 2026-10-27 (`/extract/text/file`, `/parse/file`) answer 404.
 * - Every business route needs `Authorization: Bearer sk-…`. A key carries scopes:
 *   `parse` for the text, `extract` for the optional metadata (`extract_metadata`
 *   = true), and one is enough — a key with `parse` alone is answered 403
 *   `insufficient_scope` on the metadata request, so that answer falls back once
 *   to the plain parse and the document arrives without metadata. `/health` is
 *   the one route that takes no key and answers 200 whatever the key is, so
 *   health alone says nothing about whether this deployment can parse: the
 *   credential and the route are probed separately (`probe`, see `status`).
 * - The envelope is `{code, message, uuid, timestamp, elapsed_ms, data}` and the
 *   HTTP status equals `code`; a failure carries `data.error_code`. Every decision
 *   here is keyed on the HTTP status first and the error code second, because an
 *   older build answered without the code. Quota arrives in `X-Quota-Cost` and
 *   `X-Quota-Remaining` (a number, or the string `unlimited`).
 * - The metadata (title, authors, DOI …) is written by a language model over the
 *   first and last 8,000 characters. It is a label, never evidence: the text is
 *   what quotations are checked against, and a DOI is re-checked against Crossref
 *   before anything shows it as the document's own. A failed analysis is still a
 *   200 with the whole text and `metadata_status: "failed"`.
 *
 * When the service cannot give a PDF, Word, slides or workbook (not configured,
 * 401, 403, 404, quota, rate limit, 5xx, timeout, an unusable answer) the same
 * text is read from the original bytes in the runtime controller's disposable
 * intake container (`documentLocalReader.mjs`), the extractor says so
 * (`evimed-local-reader`, parser `local-fallback`), and the remaining failure is
 * the service's own if that read fails too. A scan has no text layer there and
 * yields no text, never a guess; a file the service refused as such (415, 422)
 * is not read again locally, because the same bytes would be refused.
 *
 * The result keeps protocol v1 — `{protocolVersion, extractor, units, summary,
 * facts, methods, text, pageMap?, metadata?}` — so nothing downstream changes
 * when the parser does.
 */

const ENGINES = Object.freeze({ "engine-a": "/api/v1/parse/engine-a/file", "engine-b": "/api/v1/parse/engine-b/file" });
export const DOCUMENT_PARSER_ENGINES = Object.freeze(Object.keys(ENGINES));
const HEALTH_PATH = "/health";
/** The service refuses larger uploads with 413 (`MAX_FILE_SIZE`, 100 MB);
 *  refusing here saves sending 100 MB to be told so. */
const API_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Attempts per request for a status worth retrying, and for a 500. */
const MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_INTERNAL_ERROR = 2;
/** The wait between attempts when the service names none, and the most a
 *  `Retry-After` is honoured for: a longer one is a service that is not
 *  coming back inside this parse. */
const RETRY_DELAYS_MS = Object.freeze([1_000, 4_000]);
const MAX_RETRY_AFTER_MS = 30_000;
/** How long a key that lacks the `extract` scope is not asked for metadata again, and how long a probe answer stands. */
const METADATA_DENIED_MS = 600_000;
const PROBE_TTL_MS = 300_000;
const SUMMARY_FALLBACK = "The source contains no extractable text.";
/** The formats the intake container reads locally when the service cannot. */
const LOCAL_FORMATS = Object.freeze(["pdf", "docx", "pptx", "xlsx", "xlsm"]);
/** The failures after which the same bytes are read locally: the service could not answer, which is not a verdict on the file. */
const FALLBACK_CODES = Object.freeze(new Set([
  "source_parser_unconfigured", "source_parser_auth_failed", "source_parser_scope_denied", "source_parser_route_missing",
  "source_parser_quota_exhausted", "source_parser_rate_limited", "source_parser_internal_error", "source_parser_upstream_error",
  "source_parser_unavailable", "source_parser_timeout", "source_parser_response_invalid",
]));
const PAGE_MARKER = /^\[Page (\d+)\][ \t]*$/gm;

/** @param {number} status @param {string} code @param {string} message */
function parserError(status, code, message) {
  return new HttpError(status, code, message);
}

/** How one HTTP answer is treated. Status first: an older build did not always
 *  say `error_code`, and the status is what it always says.
 * @param {number} status @param {string} errorCode */
function classifyFailure(status, errorCode) {
  if (status === 401) return { status: 502, code: "source_parser_auth_failed", retry: false, message: "The document parser refused this deployment's credential." };
  if (status === 403) return { status: 502, code: "source_parser_scope_denied", retry: false, message: "The document parser's credential lacks the scope this request needs." };
  if (status === 404) return { status: 502, code: "source_parser_route_missing", retry: false, message: "The document parser has no such route; its API has moved." };
  if (status === 413) return { status: 413, code: "source_parser_payload_too_large", retry: false, message: "The document exceeds the parser's limits." };
  if (status === 415) return { status: 415, code: "source_format_unsupported", retry: false, message: "The parser does not support this document format." };
  if (status === 422 && ["corrupt_document", "encrypted_document", "parse_failed"].includes(errorCode)) {
    return { status: 422, code: "source_parser_document_unreadable", retry: false, message: "The parser could not read text out of this document." };
  }
  if (status === 422) return { status: 422, code: "source_parser_checksum_failed", retry: false, message: "The parser could not verify the uploaded bytes." };
  if (status === 429 && errorCode === "quota_exhausted") return { status: 503, code: "source_parser_quota_exhausted", retry: false, message: "The document parser's quota is exhausted." };
  if (status === 429) return { status: 503, code: "source_parser_rate_limited", retry: true, message: "The document parser is rate limiting requests." };
  if (status === 500) return { status: 502, code: "source_parser_internal_error", retry: true, attempts: MAX_ATTEMPTS_INTERNAL_ERROR, message: "The document parser failed internally." };
  if (status === 503) return { status: 503, code: "source_parser_unavailable", retry: true, message: "The document parser is unavailable." };
  // The parse outran the service's own limit: the same bytes would again.
  if (status === 504) return { status: 503, code: "source_parser_timeout", retry: false, message: "The document parser timed out on this document." };
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

/** Abort both response headers and streamed body reads, including injected transports. */
async function abortable(operation, signal) {
  signal.throwIfAborted();
  let listener;
  const canceled = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([operation(), canceled]); }
  finally { signal.removeEventListener("abort", listener); }
}

/** @param {Response} response @param {number} limit @param {AbortSignal} signal */
async function boundedBody(response, limit, signal) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    void response.body?.cancel().catch(() => {});
    throw parserError(502, "source_parser_response_too_large", "Document parser response exceeded its limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw parserError(502, "source_parser_response_too_large", "Document parser response exceeded its limit.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { void reader.cancel().catch(() => {}); }
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
 * The page map of a PDF text that carries engine A's `[Page N]` lines, and the
 * text with those lines taken out, in UTF-16 offsets — which is what JavaScript
 * counts, so no conversion is needed. The markers are the service's way of saying
 * where a page starts, not part of the document: left in, they came back in search
 * snippets and broke a quotation that crossed a page (2026-11-05). A page's span is
 * its own text and nothing else. A page with nothing on it, or that the service said OCR
 * found nothing on (`pdf_ocr_empty_page`), is `empty`. Markers that are not
 * strictly increasing are no page map: it is dropped with its reason and the
 * document is kept. No marker at all (engine B, a Word file, a plain text) is no
 * map and no reason. `parse_info.page_count` is not used to invent pages the text
 * does not mark.
 * @param {string} text @param {unknown} warnings parse_info.warnings
 * @returns {{ text: string, pageMap?: { page: number, start: number, end: number, status: string }[], dropped?: string }}
 */
function pagesFromMarkers(text, warnings) {
  const markers = [...text.matchAll(PAGE_MARKER)];
  if (!markers.length) return { text };
  const emptyByWarning = new Set(Array.isArray(warnings)
    ? warnings.filter((entry) => entry?.code === "pdf_ocr_empty_page" && Number.isSafeInteger(entry.source_number)).map((entry) => entry.source_number)
    : []);
  const pageMap = [];
  let previousPage = 0;
  let stripped = text.slice(0, markers[0].index ?? 0);
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const page = Number(marker[1]);
    if (!Number.isSafeInteger(page) || page <= previousPage) return { text, dropped: "pages_inconsistent" };
    previousPage = page;
    const bodyStart = (marker.index ?? 0) + marker[0].length + (text[(marker.index ?? 0) + marker[0].length] === "\n" ? 1 : 0);
    const bodyEnd = index + 1 < markers.length ? (markers[index + 1].index ?? text.length) : text.length;
    if (bodyEnd < bodyStart) return { text, dropped: "pages_inconsistent" };
    const body = text.slice(bodyStart, bodyEnd);
    const start = stripped.length;
    stripped += body;
    pageMap.push({ page, start, end: stripped.length, status: !body.trim() || emptyByWarning.has(page) ? "empty" : "ok" });
  }
  return { text: stripped, pageMap };
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

/** What the engine's parsers made of a file is named apart from the two readers above; the capture keys its text by this. */
const ENGINE_EXTRACTOR = Object.freeze({ name: "openviking-parse", version: "1.0.0", parser: "engine" });

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


/** A sleeping that a signal can end. */
const defaultSleep = (/** @type {number} */ ms, /** @type {AbortSignal} */ signal) => delay(ms, undefined, { signal });

export class DocumentParserClient {
  /**
   * @param {{baseUrl?:string,token?:string,engine?:string,revision?:string,fetchImpl?:typeof fetch,timeoutMs?:number,
   *   maxResponseBytes?:number,maxTextBytes?:number,maxUploadBytes?:number,chunkChars?:number,
   *   sleep?:(ms:number,signal:AbortSignal)=>Promise<unknown>,now?:()=>number,
   *   localReader?:{read:Function}|null,report?:(code:string,fields?:Record<string,unknown>)=>void}} config
   */
  constructor({ baseUrl = "", token = "", engine = "engine-a", revision = "evimed-extract@1.0.0", fetchImpl = globalThis.fetch, timeoutMs = 300_000,
    maxResponseBytes = 64 * 1024 * 1024, maxTextBytes = 16 * 1024 * 1024, maxUploadBytes = API_MAX_UPLOAD_BYTES,
    chunkChars = 8_000, sleep = defaultSleep, now = Date.now, localReader = null, report = () => {} } = {}) {
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
    if (!Object.hasOwn(ENGINES, String(engine))) throw new TypeError("Document parser engine is invalid.");
    const label = String(revision ?? "").trim();
    if (!label || label.length > 80 || /[\s\0]/.test(label)) throw new TypeError("Document parser revision is invalid.");
    this.engine = String(engine);
    this.token = String(token ?? "");
    this.revision = label;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxTextBytes = maxTextBytes;
    this.maxUploadBytes = Math.min(maxUploadBytes, API_MAX_UPLOAD_BYTES);
    this.chunkChars = chunkChars;
    this.sleep = sleep;
    this.now = now;
    /** The intake container's reader for PDF, Word, slides and workbooks; null where there is no controller. */
    this.localReader = localReader;
    this.report = report;
    /** @type {Map<string, number>} outcome|code -> count, for the operator's counter */
    this.counts = new Map();
    /** What the service last showed about this deployment's credential and route. */
    this.observed = { auth: "unknown", route: "unknown", at: 0, lastFailure: /** @type {string | null} */ (null) };
    this.metadataDeniedUntil = 0;
    /** @type {{ at: number, result: { auth: string, route: string } } | null} */
    this.probed = null;
  }

  get configured() { return Boolean(this.baseUrl); }

  /** Attach the local reader once the intake controller exists. @param {{read:Function}|null} reader */
  useLocalReader(reader) { this.localReader = reader; }

  /** @param {string} outcome @param {string} [code] */
  #count(outcome, code = "") {
    const key = `${outcome}|${code}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** What an HTTP answer shows of the credential and the route; a 5xx shows neither. @param {number} status */
  #observe(status) {
    if (status >= 500) return;
    this.observed.at = this.now();
    if (status === 401) { this.observed.auth = "rejected"; this.observed.route = "ok"; }
    else if (status === 404) this.observed.route = "missing";
    else if (status === 403) this.observed.route = "ok";
    else { this.observed.auth = "ok"; this.observed.route = "ok"; }
  }

  /**
   * Parse a file the ingestion worker already resolved inside the project. Its
   * bytes are read once, without following a link, and checked against the
   * digest the source was registered under.
   *
   * `engine` reads a file neither the local reader nor the API takes — the
   * engine's own parsers, bound by the caller to the account and the document —
   * and answers `{ text }`. Without one such a file is `source_format_unsupported`.
   * @param {{path:string,mimeType?:string,sha256:string,sourceId?:string,signal?:AbortSignal,
   *   engine?:((file:{name:string,bytes:Buffer,signal?:AbortSignal})=>Promise<{text?:string}>)|null}} input
   */
  async parse(input) {
    if (input.signal?.aborted) throw parserError(409, "source_parser_canceled", "Document parsing was canceled.");
    const filename = path.basename(String(input.path ?? ""));
    // Known by name, before a byte is read: a recording can be gigabytes.
    if (sourceFormatRoute(filename) === "media") throw parserError(415, "source_format_unsupported", "Nothing here reads audio or video.");
    const handle = await fsp.open(input.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw parserError(400, "source_format_unsupported", "The source is not a regular file.");
      // The first bytes say where the file is read when its name cannot, and so which limit it is held to. Read at
      // a position of their own, they leave the whole-file read below where it starts.
      const sample = Buffer.alloc(Math.min(stat.size, SOURCE_TEXT_SAMPLE_BYTES));
      await handle.read(sample, 0, sample.length, 0);
      const route = sourceReadRoute(filename, sample);
      // Nothing to read it with is the answer whatever its size: a file no parser here takes is not made readable by
      // being split.
      if (route === "engine" && typeof input.engine !== "function") throw parserError(415, "source_format_unsupported", "Nothing here parses this document format.");
      const limit = route === "local" ? this.maxTextBytes : this.maxUploadBytes;
      if (stat.size > limit) throw parserError(413, "source_parser_input_too_large", "The source exceeds the parser's size limit.");
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    return this.parseBytes({ bytes, filename, mediaType: input.mimeType, sha256: input.sha256, signal: input.signal, engine: input.engine });
  }

  /**
   * Parse bytes that never became a file — the entry point for a caller that
   * holds a download in memory (contract X2), and the one path the knowledge base
   * and the public-page reader share. `engine` as for `parse`.
   * `textOnly` asks for the text and not the bibliographic metadata a model writes over its first and last pages: what a patient's record is read with.
   * @param {{bytes:Uint8Array,filename:string,mediaType?:string,sha256?:string,signal?:AbortSignal,textOnly?:boolean,
   *   engine?:((file:{name:string,bytes:Buffer,signal?:AbortSignal})=>Promise<{text?:string}>)|null}} input
   */
  async parseBytes({ bytes, filename, mediaType = "application/octet-stream", sha256 = "", signal: callerSignal = undefined, engine = null, textOnly = false }) {
    if (callerSignal?.aborted) throw parserError(409, "source_parser_canceled", "Document parsing was canceled.");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Document bytes are required.");
    const name = path.basename(String(filename ?? "")).trim();
    if (!name || name.length > 255 || name.includes("\0")) throw parserError(400, "source_format_unsupported", "The document needs a file name.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (sha256 && String(sha256).toLowerCase() !== digest) {
      throw parserError(409, "source_changed", "The document bytes do not match the digest they were registered under.");
    }
    let route = sourceReadRoute(name, bytes);
    if (route === "media") throw parserError(415, "source_format_unsupported", "Nothing here reads audio or video.");
    if (route === "local") {
      if (bytes.byteLength > this.maxTextBytes) throw parserError(413, "source_parser_input_too_large", "The text source exceeds its size limit.");
      const text = decodeText(bytes);
      // A NUL past the sampled prefix: not text after all, and nothing PostgreSQL could hold.
      if (!text.includes("\0")) return this.#localText(text);
      route = "engine";
    }
    if (route === "engine") return this.#engineText({ bytes, name, engine, signal: callerSignal });
    if (bytes.byteLength > this.maxUploadBytes) throw parserError(413, "source_parser_payload_too_large", "The document exceeds the parser's upload limit.");
    const request = { bytes, filename: name, format: sourceFileFormat(name), mediaType: String(mediaType || "application/octet-stream"), sha256: digest };
    /** @type {any} */
    let failure;
    try {
      return await this.#remote(request, callerSignal);
    } catch (error) {
      if (callerSignal?.aborted) throw parserError(409, "source_parser_canceled", "Document parsing was canceled.");
      failure = error;
    }
    this.#count("failed", failure?.code ?? "unknown");
    this.observed.lastFailure = String(failure?.code ?? "unknown");
    // The service could not give this document: read it from its own bytes where that is possible. The failure that
    // stands if that fails too is the service's, which is the one an operator can act on.
    if (this.localReader && LOCAL_FORMATS.includes(request.format) && FALLBACK_CODES.has(failure?.code)) {
      try {
        const local = await this.localReader.read({ bytes, name, sha256: digest, format: request.format, signal: callerSignal });
        this.#count("local_fallback", failure.code);
        try { this.report("document_parser_local_fallback", { code: failure.code, format: request.format }); } catch { /* a report never fails a parse */ }
        return this.#localResult(local, failure.code);
      } catch (localError) {
        if (callerSignal?.aborted) throw parserError(409, "source_parser_canceled", "Document parsing was canceled.");
        this.#count("local_failed", /** @type {any} */ (localError)?.code ?? "unknown");
      }
    }
    throw failure;
  }

  /** One request to the configured engine, with its retries and the one metadata fallback.
   * @param {any} request @param {AbortSignal | undefined} callerSignal */
  async #remote(request, callerSignal) {
    if (!this.baseUrl) throw parserError(503, "source_parser_unconfigured", "Document parsing is not configured for this deployment.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    try {
      let answer;
      let metadataAsked = !textOnly && this.now() >= this.metadataDeniedUntil;
      try {
        answer = await this.#withRetries(request, metadataAsked, signal);
      } catch (error) {
        // A key without the `extract` scope is answered 403 on the metadata request. The text does not need it: ask
        // once more for the text alone, and leave metadata alone for a while.
        if (!metadataAsked || /** @type {any} */ (error)?.code !== "source_parser_scope_denied") throw error;
        this.metadataDeniedUntil = this.now() + METADATA_DENIED_MS;
        this.#count("metadata_scope_denied");
        metadataAsked = false;
        answer = await this.#withRetries(request, false, signal);
      }
      const result = this.#apiResult(answer, metadataAsked);
      this.#count(answer.empty ? "api_empty" : "api");
      this.observed.lastFailure = null;
      return result;
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (controller.signal.aborted && !(error instanceof HttpError && error.status < 500)) {
        throw parserError(503, "source_parser_timeout", "Document parsing timed out.");
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** @param {any} request @param {boolean} metadata @param {AbortSignal} signal */
  async #withRetries(request, metadata, signal) {
    let failure = null;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        const form = new FormData();
        form.append("file", new Blob([request.bytes], { type: request.mediaType }), request.filename);
        form.append("checksum", request.sha256);
        form.append("filename", request.filename);
        form.append("format", request.format);
        form.append("extract_metadata", metadata ? "true" : "false");
        response = await abortable(() => this.fetch(`${this.baseUrl}${ENGINES[this.engine]}`, {
          method: "POST",
          headers: { accept: "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
          body: form,
          redirect: "error",
          signal,
        }), signal);
      } catch {
        if (signal.aborted) throw parserError(503, "source_parser_timeout", "Document parsing timed out.");
        failure = { status: 503, code: "source_parser_unavailable", retry: true, message: "The document parser is unreachable." };
      }
      let wait = null;
      if (response) {
        const body = await boundedBody(response, this.maxResponseBytes, signal);
        let envelope = null;
        try { envelope = JSON.parse(body.toString("utf8")); } catch { envelope = null; }
        this.#observe(response.status);
        const errorCode = String(envelope?.data?.error_code ?? "");
        if (response.ok) {
          if (!envelope || typeof envelope !== "object" || !envelope.data || typeof envelope.data !== "object"
            || typeof envelope.data.content !== "string") {
            throw parserError(502, "source_parser_response_invalid", "Document parser returned an unsupported response.");
          }
          return { envelope, headers: response.headers };
        }
        // Read, and nothing in it: a document, not a failure. It is kept as an original with no text.
        if (response.status === 422 && errorCode === "empty_content") {
          return { envelope: { ...(envelope ?? {}), data: { content: "" } }, headers: response.headers, empty: true };
        }
        failure = classifyFailure(response.status, errorCode);
        if (failure.code === "source_parser_scope_denied" && !metadata) this.observed.auth = "scope_denied";
        wait = retryAfterMs(response.headers);
      }
      const attempts = failure.attempts ?? MAX_ATTEMPTS;
      if (!failure.retry || attempt >= attempts) throw parserError(failure.status, failure.code, failure.message);
      await this.sleep(wait ?? RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)], signal)
        .catch(() => { throw parserError(503, "source_parser_timeout", "Document parsing timed out."); });
    }
  }

  /** @param {{envelope:any,headers:Headers,empty?:boolean}} answer @param {boolean} metadataAsked */
  #apiResult({ envelope, headers, empty = false }, metadataAsked) {
    const data = envelope.data;
    if (data.content.length > this.maxTextBytes) throw parserError(502, "source_parser_response_too_large", "Parser full text exceeded its limit.");
    // A failed analysis is a 200 with the whole text and `metadata: null`: the document arrives without metadata.
    const metadata = metadataAsked && data.metadata && typeof data.metadata === "object" ? mapMetadata(data.metadata) : undefined;
    const info = data.parse_info && typeof data.parse_info === "object" ? data.parse_info : null;
    const { text, pageMap, dropped } = pagesFromMarkers(data.content, info?.warnings);
    const cost = Number(headers.get("x-quota-cost"));
    const remainingHeader = headers.get("x-quota-remaining");
    const remaining = Number(remainingHeader);
    // The quota headers, the diagnosis and the request id are for operations: what a parse cost, what is left, what the
    // service said about the pages, and the handle the parser team needs to find the request.
    const extractor = {
      name: "evimed-extract", version: this.revision, parser: "api", endpoint: this.engine,
      ...(typeof envelope.uuid === "string" && envelope.uuid.length <= 80 ? { requestId: envelope.uuid } : {}),
      ...(headers.get("x-quota-cost") != null && Number.isFinite(cost) ? { quota: {
        unit: String(headers.get("x-quota-unit") ?? "credit").slice(0, 32), cost,
        ...(remainingHeader === "unlimited" ? { unlimited: true } : Number.isFinite(remaining) ? { remaining } : {}),
      } } : {}),
      ...(info ? { parseInfo: {
        ...(typeof info.parser === "string" ? { parser: info.parser.slice(0, 40) } : {}),
        ...(typeof info.parser_version === "string" ? { parserVersion: info.parser_version.slice(0, 20) } : {}),
        ...(Number.isSafeInteger(info.page_count) ? { pageCount: info.page_count } : {}),
        ...(Array.isArray(info.ocr_pages) ? { ocrPages: info.ocr_pages.length } : {}),
        ...(Array.isArray(info.warnings) ? { warnings: info.warnings.slice(0, 20)
          .filter((entry) => typeof entry?.code === "string").map((entry) => ({ code: entry.code.slice(0, 60), page: Number.isSafeInteger(entry.source_number) ? entry.source_number : null })) } : {}),
      } } : {}),
      ...(typeof data.metadata_status === "string" ? { metadataStatus: data.metadata_status.slice(0, 20) } : {}),
      ...(empty ? { empty: true } : {}),
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

  /**
   * What the intake container read from the original bytes, as the same protocol-v1 result.
   * @param {{ text: string, pageMap?: any[], version?: string, partial?: { read: number, of: number } }} read @param {string} reason
   */
  #localResult(read, reason) {
    const text = String(read.text ?? "");
    if (text.length > this.maxTextBytes) throw parserError(502, "source_parser_response_too_large", "Parser full text exceeded its limit.");
    const units = apiUnits(text, read.pageMap);
    // Pages the container did not get to are failed units, so the source says it was read in part.
    if (read.partial && read.pageMap) {
      for (let page = read.partial.read + 1; page <= Math.min(read.partial.of, read.partial.read + 1000); page += 1) {
        units.push({ id: `page-${page}`, unitType: "page", status: "failed", itemIds: [] });
      }
    }
    return {
      protocolVersion: 1,
      extractor: { name: "evimed-local-reader", version: String(read.version ?? "1.1.0").slice(0, 40), parser: "local-fallback", fallbackFor: reason },
      units,
      summary: leadingSummary(text),
      facts: [],
      methods: [],
      text,
      ...(read.pageMap?.length ? { pageMap: read.pageMap } : {}),
    };
  }

  /** @param {string} text @param {Record<string, string>} [extractor] the file's own text, decoded */
  #localText(text, extractor = { name: "plain-text", version: "1.0.0", parser: "local" }) {
    const units = [];
    for (let offset = 0, index = 1; offset < text.length; offset += this.chunkChars, index += 1) {
      units.push({ id: `chunk-${index}`, unitType: "chunk", status: "extracted", itemIds: [] });
    }
    if (!units.length) units.push({ id: "chunk-1", unitType: "chunk", status: "no_content", itemIds: [] });
    return { protocolVersion: 1, extractor, units, summary: leadingSummary(text), facts: [], methods: [], text };
  }

  /**
   * A file neither reader above takes, read by the engine's own parsers: an
   * archive, a binary with a name nobody listed. The text is the Markdown the
   * engine wrote — what a quotation of such a document is checked against —
   * and never the file's own bytes, so a NUL in it is dropped: nothing a
   * quotation could match, and nothing PostgreSQL can hold.
   *
   * `source_format_unsupported` when there is no engine to ask;
   * `source_original_engine_failed` when the engine was asked and did not
   * answer with a reading. Neither is retried here. The limit is the one any
   * parser is sent a file under.
   * @param {{bytes:Uint8Array,name:string,engine:Function|null,signal?:AbortSignal}} input
   */
  async #engineText({ bytes, name, engine, signal }) {
    if (typeof engine !== "function") throw parserError(415, "source_format_unsupported", "Nothing here parses this document format.");
    if (bytes.byteLength > this.maxUploadBytes) throw parserError(413, "source_parser_payload_too_large", "The document exceeds the parser's upload limit.");
    let parsed;
    try {
      parsed = await engine({ name, bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), signal });
    } catch {
      if (signal?.aborted) throw parserError(409, "source_parser_canceled", "Document parsing was canceled.");
      throw parserError(502, "source_original_engine_failed", "The engine's parsers could not read the document.");
    }
    const text = String(parsed?.text ?? "").replaceAll("\0", "");
    if (text.length > this.maxTextBytes) throw parserError(502, "source_parser_response_too_large", "Parser full text exceeded its limit.");
    return this.#localText(text, { ...ENGINE_EXTRACTOR });
  }

  /**
   * The service's own liveness answer. No credential: `/health` is the one
   * route that does not take one, and sending it there would only widen where
   * the key travels. It says nothing about the key or the route (it answers 200
   * whatever they are), which is what `probe` is for.
   */
  async health() {
    if (!this.baseUrl) return { configured: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5000));
    timer.unref?.();
    try {
      const response = await this.fetch(`${this.baseUrl}${HEALTH_PATH}`, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
      const body = await boundedBody(response, 16 * 1024, controller.signal);
      let envelope = null;
      try { envelope = JSON.parse(body.toString("utf8")); } catch { envelope = null; }
      const status = envelope?.data?.status;
      if (!response.ok || status !== "healthy") {
        throw parserError(503, status === "draining" ? "source_parser_draining" : "source_parser_unavailable",
          "Document parser health check failed.");
      }
      return { configured: true, status, credential: this.token ? "file" : "none", revision: this.revision, engine: this.engine,
        ...(typeof envelope.data.environment === "string" ? { environment: envelope.data.environment.slice(0, 40) } : {}) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw parserError(503, "source_parser_unavailable", "Document parser is unavailable.");
    } finally { clearTimeout(timer); }
  }

  /**
   * Whether this deployment's key and route are usable, asked without a document
   * and without a charge: the engine's route is called with the credential and
   * no file. The service authenticates before it reads the request, so a bad key
   * is a 401 and a moved route a 404, and a good pair is refused for the missing
   * file (400) — a parameter failure, which is never charged. The scope is only
   * checked when a document is parsed, so a missing scope shows from the first
   * parse (`observed.auth`) and not here. Cached for a few minutes.
   */
  async probe() {
    if (!this.baseUrl) return { auth: "unknown", route: "unknown" };
    if (this.probed && this.now() - this.probed.at < PROBE_TTL_MS) return this.probed.result;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5000));
    timer.unref?.();
    /** @type {{ auth: string, route: string }} */
    let result = { auth: "unknown", route: "unknown" };
    try {
      const form = new FormData();
      form.append("extract_metadata", "false");
      const response = await this.fetch(`${this.baseUrl}${ENGINES[this.engine]}`, {
        method: "POST", headers: { accept: "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: form, redirect: "error", signal: controller.signal,
      });
      void response.body?.cancel().catch(() => {});
      if (response.status === 401) result = { auth: "rejected", route: "ok" };
      else if (response.status === 404) result = { auth: "unknown", route: "missing" };
      else if (response.status < 500) result = { auth: "ok", route: "ok" };
      if (response.status < 500) this.#observe(response.status);
      this.probed = { at: this.now(), result };
    } catch { /* unreachable is /health's to say */ } finally { clearTimeout(timer); }
    return result;
  }

  /**
   * What an operator reads: the engine, what the service last showed of the
   * credential and the route (from a probe or from a real parse, whichever is
   * newer), whether metadata is being skipped for a missing scope, and the counts.
   * It never throws and holds no secret.
   */
  status() {
    return {
      configured: this.configured,
      engine: this.engine,
      credential: this.token ? "file" : "none",
      auth: this.observed.auth,
      route: this.observed.route,
      metadata: this.now() < this.metadataDeniedUntil ? "scope_denied" : "available",
      localReader: Boolean(this.localReader),
      lastFailure: this.observed.lastFailure,
    };
  }

  /** The counts as `{ outcome, code, value }` rows for a counter. */
  counters() {
    return [...this.counts].map(([key, value]) => {
      const [outcome, code] = key.split("|");
      return { outcome, code: code || "none", value };
    });
  }
}
