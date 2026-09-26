/**
 * The 灵豆 boundary: the one place this control plane talks to EviMed's credits
 * service, and the only holder of the shared key (fusion plan §9.6).
 *
 * Hidden knowledge:
 *
 * - **The wire is EviMed's house convention** (`接口文档/EviMed医学证据检索.md`,
 *   the same one the evidence gateway already speaks): `POST`,
 *   `application/json`, `Authorization: Bearer <api_key>`, and the envelope
 *   `{code, msg, data}` where `code: 200` is done. 400 / 401 / 403 / 429 / 500
 *   are the documented HTTP failures. So an answer that is not that envelope is
 *   not a refusal — it is an unknown outcome.
 * - **The key is the one EviMed already issued us.** It is read from
 *   `OPEN_SCIENCE_EVIMED_API_KEY_FILE` on every call, so a rotation is a file
 *   write rather than a restart, and a second copy of the same secret is never
 *   introduced. That file is group-readable by design on the production host
 *   (root:10002 0440 — the knowledge plugin reads it through its group), so
 *   group *read* is accepted here while group write and any access by others
 *   are refused, exactly as `config.mjs`'s `readSecretFile` does for it.
 * - **A deduction is idempotent at the upstream on `requestId`, which is the
 *   run id** (plan §9.6: 「以运行编号幂等」). That is the whole reason a
 *   deduction may be retried at all: without it, an unknown outcome would have
 *   to be abandoned rather than retried, because a second charge for one run is
 *   worse than an uncollected one.
 * - Every answer is size-bounded while it streams, and neither the key nor the
 *   upstream's own sentence is ever carried out of this module: a vendor that
 *   echoes what it received would otherwise put the key into an error (it
 *   happened with another vendor's SDK). Only a code leaves.
 *
 * @module evimedCreditsClient
 */

import fs from "node:fs";
import fsp from "node:fs/promises";

/** Every code this module reports. `refused` is final; the rest are retryable. */
export const EVIMED_CREDITS_CLIENT_CODES = Object.freeze([
  "evimed_credits_unconfigured",
  "evimed_credits_unreachable",
  "evimed_credits_timeout",
  "evimed_credits_refused",
  "evimed_credits_unauthorized",
  "evimed_credits_rate_limited",
  "evimed_credits_http_error",
  "evimed_credits_response_invalid",
  "evimed_credits_response_too_large",
  "evimed_credits_request_invalid",
]);

const MAX_KEY_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_MEMO_CHARS = 200;
/** The most credits one settlement may carry. A larger number is a defect upstream of here. */
const MAX_CREDITS = 10_000_000;
/**
 * HTTP statuses that are the request's own fault and will never succeed on a
 * retry. Everything else that answered — 429, any 5xx — and everything that did
 * not answer is an unknown outcome, retried on the run id's idempotency.
 */
const FINAL_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

/** @param {unknown} value */
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * A failure of this boundary. `final` is what the service reads to decide
 * between 「retry later」 and 「stop asking」.
 */
export class EvimedCreditsError extends Error {
  /** @param {string} code @param {string} message @param {{ final?: boolean, status?: number }} [options] */
  constructor(code, message, { final = false, status = 0 } = {}) {
    super(message);
    this.name = "EvimedCreditsError";
    /** @type {string} */
    this.code = code;
    /** @type {boolean} */
    this.final = final;
    /** @type {number} */
    this.status = status;
  }
}

/**
 * The shared key file: a regular file, not a link, bounded, one line of visible
 * ASCII, and readable by nobody outside its group. The error names the defect
 * of the file, never its content.
 * @param {string} file
 * @returns {Promise<{ value: string, error: string | null }>}
 */
export async function readEvimedApiKey(file) {
  if (!file) return { value: "", error: "key_file_unconfigured" };
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return { value: "", error: "key_file_not_regular" };
    if (stat.size > MAX_KEY_BYTES + 2) return { value: "", error: "key_file_too_large" };
    // 0o037: group read is allowed (the host shares this key with the knowledge
    // plugin through a group); group write and anything for others are not.
    if (process.platform !== "win32" && (stat.mode & 0o037) !== 0) return { value: "", error: "key_file_permissions" };
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (!value) return { value: "", error: "key_file_empty" };
    if (!/^[\x21-\x7e]+$/.test(value)) return { value: "", error: "key_file_invalid" };
    return { value, error: null };
  } catch (error) {
    return { value: "", error: /** @type {any} */ (error)?.code === "ELOOP" ? "key_file_symlink" : "key_file_unavailable" };
  } finally {
    await handle?.close();
  }
}

/**
 * Whether a key file could be read as a key — the same tests as above, short of
 * reading the content, so a readiness line and a `configured` getter can ask
 * without opening a secret. `/dev/null`, which compose binds where a deployment
 * has no key, is not a regular non-empty file and so reads as no key.
 * @param {string | null | undefined} file
 */
export function evimedKeyFileUsable(file) {
  if (!file) return false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_KEY_BYTES + 2) return false;
    return process.platform === "win32" || (stat.mode & 0o037) === 0;
  } catch { return false; }
}

/**
 * A response body as text, abandoned the moment it passes `limit` bytes.
 * @param {Response} response @param {number} limit
 */
async function boundedText(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new EvimedCreditsError("evimed_credits_response_too_large", "The credits service's answer is too large.");
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A finite, non-negative number from the upstream's number or digit string, or null. @param {unknown} value */
export function upstreamAmount(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\s*-?\d{1,15}(?:\.\d{1,6})?\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 100) / 100;
}

/**
 * @param {{ deductUrl?: string, balanceUrl?: string, apiKey?: string, apiKeyFile?: string,
 *   timeoutMs?: number, fetchImpl?: typeof fetch, maxResponseBytes?: number }} [options]
 */
export function createEvimedCreditsClient({ deductUrl = "", balanceUrl = "", apiKey = "", apiKeyFile = "",
  timeoutMs = 10_000, fetchImpl = globalThis.fetch, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  const deduct = String(deductUrl ?? "").trim();
  const balance = String(balanceUrl ?? "").trim();
  const key = String(apiKey ?? "");
  const keyFile = String(apiKeyFile ?? "");
  const counters = { deductions: 0, balanceReads: 0, refusals: 0, failures: 0 };
  let lastError = /** @type {string | null} */ (null);

  /** The key, file first so a rotation is a file write. @returns {Promise<string>} */
  async function readKey() {
    if (keyFile) {
      const loaded = await readEvimedApiKey(keyFile);
      if (!loaded.error) return loaded.value;
      if (!key) {
        throw new EvimedCreditsError("evimed_credits_unconfigured", `The EviMed key file is unusable (${loaded.error}).`);
      }
    }
    if (key) return key;
    throw new EvimedCreditsError("evimed_credits_unconfigured", "This deployment holds no EviMed key.");
  }

  /**
   * One call to EviMed, reduced to `data` or an `EvimedCreditsError`.
   * @param {string} url @param {Record<string, unknown>} body
   * @returns {Promise<any>}
   */
  async function call(url, body) {
    if (!url) throw new EvimedCreditsError("evimed_credits_unconfigured", "The credits service is not configured for this deployment.");
    const bearer = await readKey();
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = /** @type {any} */ (error)?.name;
      throw name === "TimeoutError" || name === "AbortError"
        ? new EvimedCreditsError("evimed_credits_timeout", "The credits service did not answer in time.")
        : new EvimedCreditsError("evimed_credits_unreachable", "The credits service is unreachable.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new EvimedCreditsError("evimed_credits_unauthorized", "EviMed refused this deployment's key.", { final: true, status: response.status });
    }
    if (response.status === 429) {
      throw new EvimedCreditsError("evimed_credits_rate_limited", "EviMed is rate limiting this deployment.", { status: 429 });
    }
    if (!response.ok) {
      throw new EvimedCreditsError("evimed_credits_http_error", `EviMed answered HTTP ${response.status}.`,
        { final: FINAL_STATUSES.has(response.status), status: response.status });
    }
    const raw = await boundedText(response, maxResponseBytes);
    let parsed = null;
    try { parsed = raw.length ? JSON.parse(raw) : null; } catch { parsed = null; }
    if (!isObject(parsed) || !Number.isFinite(Number(/** @type {any} */ (parsed).code))) {
      throw new EvimedCreditsError("evimed_credits_response_invalid", "EviMed answered without its envelope.", { status: response.status });
    }
    const code = Number(/** @type {any} */ (parsed).code);
    if (code !== 200) {
      // The envelope's own refusal: EviMed read the request and declined it.
      // Final by construction — the same request will be declined again — and
      // its `msg` stays here, because it is upstream text.
      throw new EvimedCreditsError("evimed_credits_refused", `EviMed declined the request (code ${code}).`, { final: true, status: code });
    }
    return /** @type {any} */ (parsed).data ?? null;
  }

  /** @param {string} code */
  function note(code) { lastError = code; }

  return {
    get configured() { return Boolean(deduct) && Boolean(balance) && (Boolean(key) || evimedKeyFileUsable(keyFile)); },
    status() {
      return {
        configured: Boolean(deduct) && Boolean(balance) && (Boolean(key) || evimedKeyFileUsable(keyFile)),
        deductConfigured: Boolean(deduct),
        balanceConfigured: Boolean(balance),
        keyPresent: Boolean(key) || evimedKeyFileUsable(keyFile),
        lastError,
        counters: { ...counters },
      };
    },

    /**
     * Charge one finished run's credits. `requestId` is the run id and the
     * upstream's idempotency key: calling this twice with the same one must
     * charge once.
     * @param {{ requestId: string, userId: string, credits: number, memo: string, occurredAt?: string }} request
     * @returns {Promise<{ receiptId: string | null, balance: number | null }>}
     */
    async deduct({ requestId, userId, credits, memo, occurredAt }) {
      if (!requestId || !userId || !Number.isSafeInteger(credits) || credits <= 0 || credits > MAX_CREDITS) {
        throw new EvimedCreditsError("evimed_credits_request_invalid", "This deduction's own fields are invalid.", { final: true });
      }
      counters.deductions += 1;
      try {
        const data = await call(deduct, {
          requestId,
          userId,
          credits,
          memo: String(memo ?? "").slice(0, MAX_MEMO_CHARS),
          occurredAt: occurredAt ?? new Date().toISOString(),
        });
        lastError = null;
        const receipt = isObject(data) && typeof /** @type {any} */ (data).receiptId === "string"
          ? /** @type {any} */ (data).receiptId.slice(0, 120) : null;
        return { receiptId: receipt, balance: isObject(data) ? upstreamAmount(/** @type {any} */ (data).balance) : null };
      } catch (error) {
        counters.failures += 1;
        if (/** @type {any} */ (error)?.code === "evimed_credits_refused") counters.refusals += 1;
        note(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_http_error");
        throw error;
      }
    },

    /**
     * One account's 灵豆 balance.
     * @param {string} userId
     * @returns {Promise<{ balance: number, frozen: number }>}
     */
    async balance(userId) {
      if (!userId) throw new EvimedCreditsError("evimed_credits_request_invalid", "A balance read needs an account.", { final: true });
      counters.balanceReads += 1;
      try {
        const data = await call(balance, { userId });
        lastError = null;
        const available = isObject(data) ? upstreamAmount(/** @type {any} */ (data).balance) : null;
        if (available == null) {
          throw new EvimedCreditsError("evimed_credits_response_invalid", "EviMed's balance answer carries no balance.");
        }
        return { balance: available, frozen: (isObject(data) ? upstreamAmount(/** @type {any} */ (data).frozen) : null) ?? 0 };
      } catch (error) {
        counters.failures += 1;
        note(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_http_error");
        throw error;
      }
    },
  };
}
