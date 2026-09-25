import fs from "node:fs";
import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { HttpError } from "./security.mjs";

/**
 * The media marketplace boundary (「开放平台API」, build spec §7): the one place
 * the platform talks to the vendor that places press articles, and the only
 * holder of its key. The runtime never sees the key, the base URL, the balance
 * or the order API (ruling 7: money is code, never the model).
 *
 * Hidden knowledge, from the vendor's OpenAPI pages (outputs/…/media-api):
 *
 * - Every call is `POST multipart/form-data` with `api_key` in the form, and
 *   every answer is the envelope `{code, msg, time, data}`: `code: 1` is done,
 *   `code: 0` is a refusal whose `msg` says why ("投稿订单不存在或条件不符合").
 *   A refusal is final for that request; it is not an outage.
 * - Two product lines share one shape: website media under `/api/media/*` and
 *   third-party self-media under `/api/zi_media_api/*`. Balance and the 「GEO
 *   查收录」 trio live under `/api/geo/*`.
 * - `send` has no idempotency key and there is no list-orders endpoint. So a
 *   send is attempted exactly once: a timeout, a dropped connection, a 5xx or
 *   an unreadable answer after the form may have reached the vendor is
 *   `media_market_send_unknown` — the caller records the order as `unknown`
 *   and never sends it again. Only a failure that provably happened before a
 *   connection existed (refused, no DNS answer, no route) is "not sent".
 *   Reads (catalogue, order info, balance, fields, task status) are retried
 *   once on a network failure or a 502/503/504; no mutation is ever retried.
 * - `order_info` is documented as returning an array and exemplified with a
 *   single object; both are read. `order_nid` is an integer in `send`'s answer
 *   and a 22-digit string in `order_info`'s; it is kept as a string.
 * - The key is read from its file on every call, so a rotation is a file
 *   write. Neither the key nor the form is ever logged, and the vendor's `msg`
 *   is cut, stripped of control characters and scrubbed of the key before it
 *   is carried anywhere: a vendor that echoes what it received would otherwise
 *   put the key into an error (it happened with another vendor's SDK).
 * - Calls are paced (default 600 ms apart, the low end of the 100–300/min the
 *   vendor's marketing names) and every answer is size-bounded.
 *
 * @module mediaMarketClient
 */

/** Every code this module throws. */
export const MEDIA_MARKET_ERROR_CODES = Object.freeze([
  "media_market_unconfigured",
  "media_market_unreachable",
  "media_market_timeout",
  "media_market_send_unknown",
  "media_market_refused",
  "media_market_unauthorized",
  "media_market_rate_limited",
  "media_market_http_error",
  "media_market_response_invalid",
  "media_market_response_too_large",
  "media_market_request_invalid",
]);

/** The two product lines and their path prefixes. */
export const MEDIA_TYPES = Object.freeze(["website", "wemedia"]);
const PREFIX = Object.freeze({ website: "/api/media", wemedia: "/api/zi_media_api" });

/** The category fields the vendor names (`get_field`'s `field_type`). */
export const MEDIA_FIELD_TYPES = Object.freeze(["field_1", "field_2", "field_3", "field_4", "field_5", "field_6", "field_7", "field_8", "field_9"]);

/** Appeal reasons (`rejection`'s `title_id`). The self-media page labels 4 like 1; 4 is sent as "other" only. */
export const APPEAL_REASONS = Object.freeze({ notIndexed: 1, resultMismatch: 2, linkUnreachable: 3, other: 4 });

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_KEY_BYTES = 8 * 1024;
const RETRY_DELAY_MS = 500;
const MAX_PAGE_SIZE = 100;
const MAX_ORDER_NIDS = 50;
const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_REMARK_CHARS = 500;
const MAX_MSG_CHARS = 300;
/** Failures that happen before any connection exists: nothing reached the vendor. */
const NOT_SENT_CAUSES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const ORDER_NID = /^[0-9A-Za-z_-]{1,64}$/;
const THIRD_ID = /^[0-9A-Za-z_-]{1,64}$/;
const REQUEST_ID = /^[0-9A-Za-z_-]{1,64}$/;

/** @param {number} status @param {string} code @param {string} message */
function marketError(status, code, message) {
  return new HttpError(status, code, message);
}

/** @param {unknown} value */
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The key file: a regular file, not a link, owner-only, bounded, one line of
 * visible ASCII (it becomes a form field). The error names the defect of the
 * file, never its content.
 * @param {string} file
 * @returns {Promise<{ value: string, error: string | null }>}
 */
export async function readMediaMarketKey(file) {
  if (!file) return { value: "", error: "key_file_unconfigured" };
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return { value: "", error: "key_file_not_regular" };
    if (stat.size > MAX_KEY_BYTES + 2) return { value: "", error: "key_file_too_large" };
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return { value: "", error: "key_file_permissions" };
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (!value) return { value: "", error: "key_file_empty" };
    if (!/^[\x21-\x7e]+$/.test(value) || Buffer.byteLength(value) > MAX_KEY_BYTES) return { value: "", error: "key_file_invalid" };
    return { value, error: null };
  } catch (error) {
    return { value: "", error: /** @type {any} */ (error)?.code === "ELOOP" ? "key_file_symlink" : "key_file_unavailable" };
  } finally {
    await handle?.close();
  }
}

/** A bounded, trimmed string, or "" (tabs and control characters removed). @param {unknown} value @param {number} max */
function text(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  // eslint-disable-next-line no-control-regex -- the vendor's own titles carry tabs ("\t（腾讯网新闻）…")
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

/** A finite non-negative number from the vendor's string or number, or null. @param {unknown} value */
function amount(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*\d{1,12}(?:\.\d{1,4})?\s*$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

/** A safe non-negative integer from a number or a digit string, or null. @param {unknown} value */
function whole(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*\d{1,15}\s*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** An absolute http(s) URL of bounded length, or null. @param {unknown} value */
function httpUrl(value) {
  const candidate = text(value, 2048);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

/**
 * One `media_list` row, in the platform's own words. A row without a usable
 * resource id is dropped (and counted); every other field degrades to null.
 * `field_N` is kept as the list of category ids it carries (`"9001,9002"`).
 * @param {unknown} raw
 * @returns {null | { resourceId: string, title: string, remarks: string, caseLink: string | null,
 *   fields: Record<string, string[]>, pcWeight: number | null, wapWeight: number | null,
 *   publishRate: number | null, publishSeconds: number | null, available: boolean, priceCny: number | null }}
 */
export function normalizeMediaRow(raw) {
  if (!isObject(raw)) return null;
  const value = /** @type {Record<string, any>} */ (raw);
  const resourceId = text(value.resource_id, 64);
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(resourceId)) return null;
  /** @type {Record<string, string[]>} */
  const fields = {};
  for (const field of MEDIA_FIELD_TYPES) {
    const ids = text(value[field], 400).split(/[,，\s]+/).filter((id) => /^[0-9A-Za-z_-]{1,32}$/.test(id));
    if (ids.length) fields[field] = [...new Set(ids)].slice(0, 30);
  }
  const rate = amount(value.publish_rate);
  const seconds = whole(value.publish_time);
  return {
    resourceId,
    title: text(value.title, 300),
    remarks: text(value.remarks, 2_000),
    caseLink: httpUrl(value.case_link),
    fields,
    pcWeight: whole(value.pc_weigh),
    wapWeight: whole(value.wap_weigh),
    publishRate: rate != null && rate <= 100 ? rate : null,
    // 0 is the vendor's "no observation", not "instant".
    publishSeconds: seconds ? Math.min(seconds, 365 * 86_400) : null,
    available: whole(value.status) === 1,
    priceCny: amount(value.price),
  };
}

/**
 * One `order_info` row. `status` is kept raw; the platform's mapping table
 * (`geoMarket.mjs`) turns it into a state and refuses to guess an unknown one.
 * @param {unknown} raw
 */
export function normalizeOrderRow(raw) {
  if (!isObject(raw)) return null;
  const value = /** @type {Record<string, any>} */ (raw);
  const orderNid = text(value.order_nid, 64);
  if (!ORDER_NID.test(orderNid)) return null;
  const status = whole(value.status);
  return {
    orderNid,
    resourceId: text(value.resource_id, 64) || null,
    status,
    priceCny: amount(value.price),
    isRefund: whole(value.is_refund) === 1,
    title: text(value.title, 300),
    remark: text(value.remark, 500),
    rejectionInfo: text(value.rejection_info, 500),
    refundInfo: text(value.refund_info, 500),
    rewriteInfo: text(value.rewrite_info, 500),
    orderUrl: httpUrl(value.order_url),
  };
}

/** @param {Response} response @param {number} limit */
async function boundedBody(response, limit) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw marketError(502, "media_market_response_too_large", "The media marketplace answer exceeded its limit.");
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
      throw marketError(502, "media_market_response_too_large", "The media marketplace answer exceeded its limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Whether a fetch failure provably happened before any connection existed. @param {unknown} error */
function failedBeforeConnecting(error) {
  const cause = /** @type {any} */ (error)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  return NOT_SENT_CAUSES.has(code);
}

/** @param {unknown} error */
function isTimeout(error) {
  const name = /** @type {any} */ (error)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * @typedef {object} MediaMarketStatus
 * @property {boolean} configured
 * @property {string | null} lastError the code of the last failed call, cleared by the next success
 * @property {Record<string, number>} counters
 */

export class MediaMarketClient {
  /**
   * @param {{ baseUrl?: string, apiKey?: string, apiKeyFile?: string, timeoutMs?: number, sendTimeoutMs?: number,
   *   fetchImpl?: typeof fetch, maxResponseBytes?: number, sleep?: (ms: number) => Promise<unknown>,
   *   allowPlaintext?: boolean, minIntervalMs?: number }} [options]
   */
  constructor({ baseUrl = "", apiKey = "", apiKeyFile = "", timeoutMs = 15_000, sendTimeoutMs, fetchImpl = globalThis.fetch,
    maxResponseBytes = MAX_RESPONSE_BYTES, sleep = (ms) => delay(ms), allowPlaintext = false, minIntervalMs = 600 } = {}) {
    this.baseUrl = String(baseUrl ?? "").trim().replace(/\/+$/, "");
    if (this.baseUrl) {
      let parsed;
      try { parsed = new URL(this.baseUrl); } catch { throw new TypeError("The media marketplace URL is invalid."); }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new TypeError("The media marketplace URL is invalid.");
      }
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
      if (parsed.protocol === "http:" && !allowPlaintext && !loopback) {
        throw new TypeError("The media marketplace URL must be https: the key travels in every request.");
      }
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new TypeError("The media marketplace timeout is invalid.");
    const sendTimeout = sendTimeoutMs ?? Math.max(timeoutMs, 30_000);
    if (!Number.isSafeInteger(sendTimeout) || sendTimeout < 100 || sendTimeout > 300_000) throw new TypeError("The media marketplace send timeout is invalid.");
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024) throw new TypeError("The media marketplace response limit is invalid.");
    if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60_000) throw new TypeError("The media marketplace pacing is invalid.");
    this.apiKey = String(apiKey ?? "");
    this.apiKeyFile = String(apiKeyFile ?? "");
    this.timeoutMs = timeoutMs;
    this.sendTimeoutMs = sendTimeout;
    this.fetch = fetchImpl;
    this.maxResponseBytes = maxResponseBytes;
    this.sleep = sleep;
    this.minIntervalMs = minIntervalMs;
    this.nextSlotAt = 0;
    /** @type {string | null} */
    this.lastError = null;
    /** Observable counters (principle 15). */
    this.counters = { requests: 0, failures: 0, retries: 0, refusals: 0, sendUnknown: 0, invalidRows: 0 };
  }

  /**
   * Whether a base URL and a key are both there. A key file that exists but is
   * unusable still reads as configured, and every call then names the defect.
   */
  get configured() {
    if (!this.baseUrl) return false;
    if (this.apiKey) return true;
    if (!this.apiKeyFile) return false;
    try { return fs.lstatSync(this.apiKeyFile).isFile(); } catch { return false; }
  }

  /** @returns {MediaMarketStatus} */
  status() {
    return { configured: this.configured, lastError: this.lastError, counters: { ...this.counters } };
  }

  /** @param {unknown} mediaType */
  #prefix(mediaType) {
    const prefix = PREFIX[/** @type {"website" | "wemedia"} */ (String(mediaType))];
    if (!prefix) throw marketError(400, "media_market_request_invalid", "The media type is not one the marketplace offers.");
    return prefix;
  }

  /** @returns {Promise<string>} */
  async #key() {
    if (this.apiKey) return this.apiKey;
    const loaded = await readMediaMarketKey(this.apiKeyFile);
    if (loaded.error) throw marketError(503, "media_market_unconfigured", `The media marketplace key file is unusable (${loaded.error}).`);
    return loaded.value;
  }

  /** The vendor's own sentence, bounded and scrubbed of the key. @param {unknown} msg @param {string} key */
  #vendorMessage(msg, key) {
    let value = text(msg, 4 * MAX_MSG_CHARS);
    if (key && key.length >= 4) value = value.split(key).join("[redacted]");
    return value.slice(0, MAX_MSG_CHARS);
  }

  /** Wait for this call's slot: one call every `minIntervalMs`. */
  async #pace() {
    if (!this.minIntervalMs) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  /**
   * One vendor call.
   * @param {string} pathname
   * @param {Array<[string, string]>} fields the form, `api_key` excluded
   * @param {{ mutation: boolean, send?: boolean, timeoutMs?: number }} options
   * @returns {Promise<{ data: any, msg: string }>}
   */
  async #call(pathname, fields, { mutation, send = false, timeoutMs = this.timeoutMs }) {
    try {
      const result = await this.#attempt(pathname, fields, { mutation, send, timeoutMs });
      this.lastError = null;
      return result;
    } catch (error) {
      this.counters.failures += 1;
      const code = /** @type {any} */ (error)?.code;
      this.lastError = typeof code === "string" ? code : "media_market_http_error";
      if (code === "media_market_refused") this.counters.refusals += 1;
      if (code === "media_market_send_unknown") this.counters.sendUnknown += 1;
      throw error;
    }
  }

  /**
   * @param {string} pathname @param {Array<[string, string]>} fields
   * @param {{ mutation: boolean, send: boolean, timeoutMs: number }} options
   */
  async #attempt(pathname, fields, { mutation, send, timeoutMs }) {
    if (!this.baseUrl) throw marketError(503, "media_market_unconfigured", "The media marketplace is not configured for this deployment.");
    const key = await this.#key();
    const url = `${this.baseUrl}${pathname}`;
    /** The failure of a mutation whose outcome cannot be known. @param {string} why */
    const unknown = (why) => send
      ? marketError(502, "media_market_send_unknown", `The marketplace may or may not have created the order (${why}); it must not be sent again.`)
      : marketError(502, why === "timeout" ? "media_market_timeout" : "media_market_unreachable", `The marketplace call's outcome is unknown (${why}).`);
    for (let attempt = 1; ; attempt += 1) {
      await this.#pace();
      const form = new FormData();
      form.append("api_key", key);
      for (const [name, value] of fields) form.append(name, value);
      this.counters.requests += 1;
      let response;
      try {
        response = await this.fetch(url, {
          method: "POST",
          headers: { accept: "application/json" },
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (!mutation && attempt < 2) { this.counters.retries += 1; await this.sleep(RETRY_DELAY_MS); continue; }
        if (failedBeforeConnecting(error)) throw marketError(503, "media_market_unreachable", "The media marketplace is unreachable.");
        if (!mutation) {
          throw isTimeout(error)
            ? marketError(504, "media_market_timeout", "The media marketplace did not answer in time.")
            : marketError(503, "media_market_unreachable", "The media marketplace is unreachable.");
        }
        throw unknown(isTimeout(error) ? "timeout" : "connection lost");
      }
      let raw;
      try {
        raw = await boundedBody(response, this.maxResponseBytes);
      } catch (error) {
        if (mutation && /** @type {any} */ (error)?.code !== "media_market_response_too_large") throw unknown("answer cut off");
        throw error;
      }
      if (response.status === 401 || response.status === 403) {
        throw marketError(502, "media_market_unauthorized", "The media marketplace refused this deployment's key.");
      }
      if (response.status === 429) throw marketError(503, "media_market_rate_limited", "The media marketplace is rate limiting this deployment.");
      if (response.status >= 500) {
        if (!mutation && [502, 503, 504].includes(response.status) && attempt < 2) {
          this.counters.retries += 1;
          await this.sleep(RETRY_DELAY_MS);
          continue;
        }
        if (mutation) throw unknown(`HTTP ${response.status}`);
        throw marketError(503, "media_market_unreachable", `The media marketplace answered HTTP ${response.status}.`);
      }
      if (!response.ok) throw marketError(502, "media_market_http_error", `The media marketplace answered HTTP ${response.status}.`);
      let parsed = null;
      try { parsed = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch { parsed = null; }
      const code = isObject(parsed) ? Number(/** @type {any} */ (parsed).code) : NaN;
      if (code !== 0 && code !== 1) {
        if (mutation) throw unknown("unreadable answer");
        throw marketError(502, "media_market_response_invalid", "The media marketplace answered without its envelope.");
      }
      const msg = this.#vendorMessage(/** @type {any} */ (parsed).msg, key);
      if (code === 0) {
        const error = /** @type {HttpError & { vendorMessage?: string }} */ (marketError(409, "media_market_refused", "The media marketplace refused the request."));
        error.vendorMessage = msg;
        throw error;
      }
      return { data: /** @type {any} */ (parsed).data, msg };
    }
  }

  /**
   * One catalogue page.
   * @param {"website" | "wemedia"} mediaType
   * @param {{ page: number, pageSize: number }} options
   */
  async mediaList(mediaType, { page, pageSize }) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw marketError(400, "media_market_request_invalid", "The catalogue page is out of range.");
    }
    const { data } = await this.#call(`${this.#prefix(mediaType)}/media_list`, [["page", String(page)], ["page_size", String(pageSize)]], { mutation: false });
    if (data == null) return { rows: [], received: 0 };
    if (!Array.isArray(data)) throw marketError(502, "media_market_response_invalid", "The catalogue page is not a list.");
    const rows = [];
    for (const item of data.slice(0, MAX_PAGE_SIZE * 2)) {
      const row = normalizeMediaRow(item);
      if (row) rows.push(row);
      else this.counters.invalidRows += 1;
    }
    return { rows, received: data.length };
  }

  /**
   * A category field's names.
   * @param {"website" | "wemedia"} mediaType @param {string} fieldType
   * @returns {Promise<Array<{ id: string, type: string, title: string, sort: number }>>}
   */
  async fields(mediaType, fieldType) {
    if (!MEDIA_FIELD_TYPES.includes(fieldType)) throw marketError(400, "media_market_request_invalid", "The category field is not one the marketplace names.");
    const { data } = await this.#call(`${this.#prefix(mediaType)}/get_field`, [["media_type", mediaType], ["field_type", fieldType]], { mutation: false });
    if (data == null) return [];
    if (!Array.isArray(data)) throw marketError(502, "media_market_response_invalid", "The category list is not a list.");
    return data.slice(0, 2_000).flatMap((item) => {
      if (!isObject(item)) return [];
      const id = text(item.field_id, 32);
      const title = text(item.field_title, 100);
      if (!/^[0-9A-Za-z_-]{1,32}$/.test(id) || !title) return [];
      return [{ id, type: text(item.field_type, 16) || fieldType, title, sort: whole(item.rsort) ?? 0 }];
    });
  }

  /**
   * Place one article with one outlet. Exactly one attempt: see the module note.
   * @param {"website" | "wemedia"} mediaType
   * @param {{ resourceId: string, title: string, contentHtml: string, remark?: string, thirdId: string }} order
   * @returns {Promise<{ orderNid: string }>}
   */
  async send(mediaType, { resourceId, title, contentHtml, remark = "", thirdId }) {
    const prefix = this.#prefix(mediaType);
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(String(resourceId ?? ""))) throw marketError(400, "media_market_request_invalid", "The resource id is invalid.");
    if (!THIRD_ID.test(String(thirdId ?? ""))) throw marketError(400, "media_market_request_invalid", "The order reference is invalid.");
    const cleanTitle = text(title, MAX_TITLE_CHARS + 1);
    if (!cleanTitle || cleanTitle.length > MAX_TITLE_CHARS) throw marketError(400, "media_market_request_invalid", "The title is empty or too long.");
    if (typeof contentHtml !== "string" || !contentHtml.trim() || Buffer.byteLength(contentHtml) > MAX_CONTENT_BYTES) {
      throw marketError(400, "media_market_request_invalid", "The article body is empty or too large.");
    }
    const { data } = await this.#call(`${prefix}/send`, [
      ["resource_id", String(resourceId)],
      ["title", cleanTitle],
      ["content", contentHtml],
      ["remark", text(remark, MAX_REMARK_CHARS)],
      ["third_id", String(thirdId)],
    ], { mutation: true, send: true, timeoutMs: this.sendTimeoutMs });
    const orderNid = isObject(data) ? text(data.order_nid, 64) : "";
    if (!ORDER_NID.test(orderNid)) {
      this.counters.sendUnknown += 1;
      throw marketError(502, "media_market_send_unknown", "The marketplace accepted the article without naming its order; it must not be sent again.");
    }
    return { orderNid };
  }

  /**
   * The vendor's view of up to 50 orders. An order it does not return is simply
   * absent from the list.
   * @param {"website" | "wemedia"} mediaType @param {string[]} orderNids
   */
  async orderInfo(mediaType, orderNids) {
    const prefix = this.#prefix(mediaType);
    const nids = [...new Set(orderNids.map(String))];
    if (!nids.length) return [];
    if (nids.length > MAX_ORDER_NIDS || nids.some((nid) => !ORDER_NID.test(nid))) {
      throw marketError(400, "media_market_request_invalid", "The order numbers are invalid or too many.");
    }
    const form = /** @type {Array<[string, string]>} */ (nids.length === 1 ? [["order_nids", nids[0]]] : nids.map((nid) => ["order_nids[]", nid]));
    const { data } = await this.#call(`${prefix}/order_info`, form, { mutation: false });
    if (data == null) return [];
    const items = Array.isArray(data) ? data : isObject(data) ? [data] : null;
    if (!items) throw marketError(502, "media_market_response_invalid", "The order information is neither a list nor an order.");
    const rows = [];
    for (const item of items.slice(0, MAX_ORDER_NIDS * 2)) {
      const row = normalizeOrderRow(item);
      if (row) rows.push(row);
      else this.counters.invalidRows += 1;
    }
    return rows;
  }

  /**
   * Withdraw an order the outlet has not arranged yet. A refusal names why.
   * @param {"website" | "wemedia"} mediaType @param {string} orderNid
   */
  async cancelOrder(mediaType, orderNid) {
    const prefix = this.#prefix(mediaType);
    if (!ORDER_NID.test(String(orderNid ?? ""))) throw marketError(400, "media_market_request_invalid", "The order number is invalid.");
    const { msg } = await this.#call(`${prefix}/cancel_order`, [["order_nid", String(orderNid)]], { mutation: true });
    return { ok: true, msg };
  }

  /**
   * An after-sale appeal on a published order.
   * @param {"website" | "wemedia"} mediaType @param {string} orderNid
   * @param {{ titleId: 1 | 2 | 3 | 4, info: string }} appeal
   */
  async appeal(mediaType, orderNid, { titleId, info }) {
    const prefix = this.#prefix(mediaType);
    if (!ORDER_NID.test(String(orderNid ?? ""))) throw marketError(400, "media_market_request_invalid", "The order number is invalid.");
    if (![1, 2, 3, 4].includes(titleId)) throw marketError(400, "media_market_request_invalid", "The appeal reason is invalid.");
    const { msg } = await this.#call(`${prefix}/rejection`, [
      ["order_nid", String(orderNid)],
      ["title_id", String(titleId)],
      ["info", text(info, 1_000)],
    ], { mutation: true });
    return { ok: true, msg };
  }

  /** The platform account's balance: money for placements, 算力 for 查收录. */
  async balance() {
    const { data } = await this.#call("/api/geo/get_balance", [], { mutation: false });
    const money = isObject(data) ? amount(data.money) : null;
    const powerCount = isObject(data) ? whole(data.power_count) : null;
    if (money == null) throw marketError(502, "media_market_response_invalid", "The balance answer carries no money figure.");
    return { money, powerCount };
  }

  /**
   * Submit one 「查收录」 task (1 算力).
   * @param {{ platform: number, keywords: string[], question: string, thirdId: string }} task
   */
  async addInclusionTask({ platform, keywords, question, thirdId }) {
    if (!Number.isSafeInteger(platform) || platform < 1 || platform > 8) throw marketError(400, "media_market_request_invalid", "The platform is not one the vendor checks.");
    const words = [...new Set((Array.isArray(keywords) ? keywords : []).map((word) => text(word, 50).replace(/[,，]/g, " ").trim()).filter(Boolean))].slice(0, 10);
    const cleanQuestion = text(question, 500);
    if (!words.length || !cleanQuestion || !THIRD_ID.test(String(thirdId ?? ""))) {
      throw marketError(400, "media_market_request_invalid", "The inclusion task needs brand words, a question and a reference.");
    }
    const { data } = await this.#call("/api/geo/add_shoulu", [
      ["platform", String(platform)],
      ["keywords", words.join(",")],
      ["question", cleanQuestion],
      ["third_id", String(thirdId)],
    ], { mutation: true });
    const requestId = isObject(data) ? text(data.request_id, 64) : "";
    if (!REQUEST_ID.test(requestId)) throw marketError(502, "media_market_response_invalid", "The inclusion task was accepted without an id.");
    return { requestId };
  }

  /** @param {string} requestId */
  async checkInclusionTask(requestId) {
    if (!REQUEST_ID.test(String(requestId ?? ""))) throw marketError(400, "media_market_request_invalid", "The task id is invalid.");
    const { data } = await this.#call("/api/geo/check_task", [["request_id", String(requestId)]], { mutation: false });
    if (!isObject(data)) throw marketError(502, "media_market_response_invalid", "The task answer is not an object.");
    const status = whole(data.status);
    if (status == null || status > 3) throw marketError(502, "media_market_response_invalid", "The task status is not one the vendor documents.");
    const checkedAt = whole(data.script_time);
    return {
      requestId: text(data.request_id, 64) || String(requestId),
      platform: whole(data.platform),
      status,
      inclusionDate: /^\d{4}-\d{2}-\d{2}$/.test(text(data.shoulu_date, 10)) ? text(data.shoulu_date, 10) : null,
      question: text(data.question, 500),
      hitWord: text(data.hit_word, 200),
      keywordRes: text(data.keyword_res, 500),
      shareUrl: httpUrl(data.share_url),
      imgUrl: httpUrl(data.img_url),
      checkedAt: checkedAt ? new Date(checkedAt * 1000).toISOString() : null,
    };
  }

  /** @param {string[]} requestIds */
  async cancelInclusionTasks(requestIds) {
    const ids = [...new Set(requestIds.map(String))];
    if (!ids.length || ids.length > MAX_ORDER_NIDS || ids.some((id) => !REQUEST_ID.test(id))) {
      throw marketError(400, "media_market_request_invalid", "The task ids are invalid or too many.");
    }
    const { data } = await this.#call("/api/geo/cancel_task", ids.map((id) => ["request_ids[]", id]), { mutation: true });
    return { cancelled: Array.isArray(data) ? data.map((id) => text(id, 64)).filter((id) => REQUEST_ID.test(id)) : [] };
  }
}

/**
 * The client a deployment's configuration describes. Missing URL or key file
 * gives a client whose `configured` is false and whose every call refuses with
 * `media_market_unconfigured` — nothing is sent anywhere.
 * @param {Record<string, any>} config
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<unknown>, minIntervalMs?: number }} [options]
 */
export function createMediaMarketClient(config, { fetchImpl, sleep, minIntervalMs } = {}) {
  return new MediaMarketClient({
    baseUrl: config.mediaMarketUrl ?? "",
    apiKey: config.mediaMarketApiKey ?? "",
    apiKeyFile: config.mediaMarketApiKeyFile ?? "",
    timeoutMs: Number(config.mediaMarketTimeoutMs ?? 15_000),
    allowPlaintext: Boolean(config.mediaMarketAllowPlaintext),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(sleep ? { sleep } : {}),
    ...(minIntervalMs != null ? { minIntervalMs } : {}),
  });
}

/**
 * The client's counters as metric families for the operator endpoint.
 * @param {MediaMarketStatus | null | undefined} status
 */
export function mediaMarketMetricFamilies(status) {
  if (!status) return [];
  return [
    { name: "open_science_media_market_configured", help: "Whether the media marketplace has a URL and a key.", type: /** @type {const} */ ("gauge"),
      series: [{ value: status.configured ? 1 : 0 }] },
    { name: "open_science_media_market_calls_total", help: "Media marketplace calls by outcome.", type: /** @type {const} */ ("counter"),
      series: Object.entries(status.counters).map(([outcome, value]) => ({ value, labels: { outcome } })) },
  ];
}
