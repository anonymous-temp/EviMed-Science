/**
 * Six-platform social collection, against the service's 0.5.0 OpenAPI (2026-10-27).
 * POST /api/jobs accepts one bounded multi-platform request and an Idempotency-Key;
 * GET /api/jobs/{32-hex-id} returns waiting/queued/running/done/partial/failed.
 * A search submits once, retries an uncertain submit with the same key, and polls
 * that id inside one deadline. It never follows a supplied poll URL or redirect.
 * GET /health/ready is an explicit operator probe, not an extra job submission.
 *
 * The control plane alone reads the owner-only key file, anew on each request.
 * No upstream error text, raw_response, author, location or provider metadata
 * leaves this module. UGC is whitelisted to a source address, id, <=200-character
 * excerpt, stated engagement and <=10 comment excerpts. A comment sample is not
 * a comment count. Unknown engagement is omitted, never turned into zero.
 *
 * Internal statuses remain collected/partial_collected/no_results/request_failed.
 * Only an explicit successful empty collection establishes no_results. Usable
 * partial posts survive a failed platform or a deadline; unfinished coverage is
 * request_failed with reason pending, which does not claim an upstream failure.
 * @module socialCrawlClient
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { GEO_SOCIAL_EXCERPT_MAX_CHARS, GEO_SOCIAL_PLATFORMS, GEO_SOCIAL_SORTS } from "@evimed/domain";
import { privateHostname } from "./webReadNetwork.mjs";

export const SOCIAL_CRAWL_PATH = "/api/jobs";
export const SOCIAL_MAX_LIMIT = 50;
export const SOCIAL_DEFAULT_LIMIT = 20;
export const SOCIAL_MAX_QUERY_LENGTH = 256;
const MAX_DETAIL_POSTS = 10;
const COMMENTS_PER_POST = 5;
const MAX_COMMENTS_KEPT = 10;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_KEY_BYTES = 8 * 1024;
const JOB_ID = /^[a-fA-F0-9]{32}$/;
const JOB_STATUSES = new Set(["waiting", "queued", "running", "done", "partial", "failed"]);
const TERMINAL_STATUSES = new Set(["done", "partial", "failed"]);
const COLLECTION_STATUSES = new Set(["collected", "partial_collected", "no_results", "failed"]);
const RETRY_DELAYS_MS = [500, 2_000];
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_POLLS = 180;

/** @param {string} code */
const failure = code => Object.assign(new Error("The social collection request could not be completed."), { code });
/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value */
const excerpt = value => typeof value === "string" ? [...value.replace(/\s+/g, " ").trim()].slice(0, GEO_SOCIAL_EXCERPT_MAX_CHARS).join("") : "";
/** @param {unknown} value */
function statedCount(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** Abort headers, body reads and injected waits, including transports ignoring signals.
 * @template T @param {() => Promise<T>} operation @param {AbortSignal | undefined} signal @returns {Promise<T>} */
async function abortable(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let listener;
  const canceled = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([operation(), canceled]); }
  finally { signal.removeEventListener("abort", listener); }
}

/** Stream-bounded, also when Content-Length is absent or false.
 * @param {Response} response @param {number} limit @param {AbortSignal} [signal] */
export async function readBoundedText(response, limit, signal) {
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => {});
    throw failure("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw failure("response_too_large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { void reader.cancel().catch(() => {}); }
}

/** A link is displayed, never fetched here. Refuse credentials and local/secret-bearing addresses.
 * @param {unknown} value */
function sourceUrl(value) {
  if (typeof value !== "string" || value.length > 2_048 || [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || privateHostname(url.hostname)) return null;
    if ([...url.searchParams.keys()].some(key => /(?:token|password|secret|api[_-]?key|auth)/i.test(key))) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

/** One post reduced to the permitted fields; redact known deployment credentials before truncation.
 * @param {any} post @param {string} platform @param {string} collectedAt @param {(value: unknown) => unknown} [redact] */
export function minimizedSocialPost(post, platform, collectedAt, redact = value => value) {
  if (!isObject(post)) return null;
  const joined = excerpt([excerpt(redact(post.title)), excerpt(redact(post.content))].filter(Boolean).join(" "));
  const comments = (Array.isArray(post.comments) ? post.comments : []).slice(0, 200)
    .map(comment => excerpt(redact(isObject(comment) ? comment.content ?? comment.text : comment))).filter(Boolean).slice(0, MAX_COMMENTS_KEPT);
  const url = sourceUrl(redact(post.url));
  if (!url && !joined && !comments.length) return null;
  const rawId = post.post_id ?? post.id;
  const postId = typeof rawId === "string" || typeof rawId === "number" ? String(redact(String(rawId))).split("").filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join("").slice(0, 120) : null;
  const engagement = {};
  for (const [name, raw] of Object.entries({ likes: post.likes, favs: post.favs, shares: post.shares, comments: post.comment_count ?? post.comments_count })) {
    const value = statedCount(raw);
    if (value != null) engagement[name] = value;
  }
  return { platform, url, postId, excerpt: joined, engagement, collectedAt, comments };
}

/** @param {Array<{ status: string, posts: number }>} platforms */
export function socialCollectionStatus(platforms) {
  if (platforms.some(entry => entry.posts > 0)) return platforms.every(entry => ["collected", "no_results"].includes(entry.status)) ? "collected" : "partial_collected";
  return platforms.length && platforms.every(entry => entry.status === "no_results") ? "no_results" : "request_failed";
}

/** File metadata only, never contents. @param {string} file */
function keyFileUsable(file) {
  if (!file) return false;
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_KEY_BYTES + 2 && (process.platform === "win32" || (stat.mode & 0o077) === 0);
  } catch { return false; }
}
/** @param {unknown} key @returns {key is string} */
const validKey = key => typeof key === "string" && key.length > 0 && Buffer.byteLength(key) <= MAX_KEY_BYTES && /^[\x21-\x7e]+$/.test(key);
/** Read a bounded, owner-only regular file without following symlinks. @param {string} file */
async function readKey(file) {
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_KEY_BYTES + 2 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw failure("credential_invalid");
    const bytes = Buffer.alloc(MAX_KEY_BYTES + 3);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const value = bytes.subarray(0, bytesRead).toString("utf8").replace(/\r?\n$/, "");
    if (!validKey(value)) throw failure("credential_invalid");
    return value;
  } catch { throw failure("credential_unavailable"); }
  finally { await handle?.close(); }
}

/** Same exact requested set, never an upstream-selected platform.
 * @param {unknown} value @param {string[]} platforms */
function matchingPlatforms(value, platforms) {
  return Array.isArray(value) && value.length === platforms.length && new Set(value).size === value.length && value.every(platform => platforms.includes(platform));
}
/** @param {any} value @param {string} query @param {string[]} platforms @param {string | null} id */
function validateJob(value, query, platforms, id) {
  if (!isObject(value) || typeof value.job_id !== "string" || !JOB_ID.test(value.job_id) || (id && value.job_id !== id)
    || !JOB_STATUSES.has(value.job_status) || value.query !== query || !matchingPlatforms(value.platforms, platforms)) throw failure("response_invalid");
  return value;
}

/** Internal result rows stay within the existing search contract.
 * @typedef {{ platform: string, status: string, posts: any[], reason?: string }} PlatformCollection
 */
/** @param {any} value @param {string} platform @param {string} query @param {string} collectedAt
 * @param {(value: unknown) => unknown} redact @returns {PlatformCollection} */
function platformCollection(value, platform, query, collectedAt, redact) {
  if (!isObject(value) || (value.platform != null && value.platform !== platform) || (value.question != null && value.question !== query)
    || !Array.isArray(value.posts) || !COLLECTION_STATUSES.has(value.meta?.collection_status)) return { platform, status: "request_failed", posts: [], reason: "response_invalid" };
  const posts = value.posts.slice(0, SOCIAL_MAX_LIMIT).map(post => minimizedSocialPost(post, platform, collectedAt, redact)).filter(Boolean);
  const upstream = value.meta.collection_status;
  // 0.5.0 may say collected while a requested comments stage failed. Sampling
  // complete_history=false alone is not a failure: these are declared samples.
  const meta = value.meta;
  const stageIssue = meta.has_errors === true || meta.requirements_met === false || Number(meta.error_details_total) > 0
    || [meta.detail, meta.comments].some(stage => isObject(stage) && (Number(stage.failed) > 0 || stage.complete === false))
    || (isObject(meta.stage_completeness) && Object.values(meta.stage_completeness).some(stage => isObject(stage)
      && stage.enabled === true && ["partial", "failed"].includes(stage.status)));
  if (posts.length) return { platform, status: upstream === "collected" && !stageIssue ? "collected" : "partial_collected", posts,
    ...(upstream === "failed" ? { reason: "upstream_failed" } : stageIssue ? { reason: "incomplete_collection" } : {}) };
  if (upstream === "no_results" && value.posts.length === 0 && !stageIssue) return { platform, status: "no_results", posts: [] };
  return { platform, status: "request_failed", posts: [], reason: upstream === "failed" ? "upstream_failed" : "incomplete_collection" };
}

/** @param {Record<string, any>} job @param {string} query @param {string[]} platforms @param {string} collectedAt
 * @param {(value: unknown) => unknown} redact @param {string | null} fallbackReason @returns {PlatformCollection[]} */
function jobCollections(job, query, platforms, collectedAt, redact, fallbackReason) {
  const result = job?.result;
  if (!isObject(result)) {
    return platforms.map(platform => ({ platform, status: "request_failed", posts: [], reason: fallbackReason ?? (job?.job_status === "failed" ? "upstream_failed" : "response_invalid") }));
  }
  const multiple = isObject(result.results);
  if (multiple && (result.job_id !== job.job_id || result.query !== query || !matchingPlatforms(result.platforms, platforms)
    || Object.keys(result.results).some(platform => !platforms.includes(platform)))) throw failure("response_invalid");
  if (!multiple && platforms.length !== 1) throw failure("response_invalid");
  return platforms.map(platform => {
    const value = multiple ? result.results[platform] : result;
    if (!value) return { platform, status: "request_failed", posts: [], reason: fallbackReason ?? "missing_platform" };
    const row = platformCollection(value, platform, query, collectedAt, redact);
    const progress = result.progress?.[platform] ?? job.progress?.[platform];
    const platformError = (isObject(result.errors) && Object.hasOwn(result.errors, platform))
      || (isObject(progress) && (progress.has_errors === true || progress.requirements_met === false || ["error", "partial"].includes(progress.status)));
    if (job.job_status === "failed" || platformError) {
      row.status = row.posts.length ? "partial_collected" : "request_failed";
      row.reason = "upstream_failed";
    }
    if (platforms.length === 1 && job.job_status === "partial" && row.status === "collected") {
      row.status = "partial_collected";
      row.reason = "incomplete_collection";
    }
    return row;
  });
}

/** @param {Headers} headers @param {number} fallback */
function retryAfterMs(headers, fallback) {
  const value = headers.get("retry-after");
  if (!value || value.length > 128) return fallback;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)) : fallback;
}

/**
 * @param {{ baseUrl?: string, apiKey?: string, apiKeyFile?: string, allowPlaintext?: boolean, timeoutMs?: number,
 * fetchImpl?: typeof fetch, now?: () => Date, sleep?: (ms: number) => Promise<unknown>, pollIntervalMs?: number, maxResponseBytes?: number }} options
 */
export function createSocialCrawlClient({ baseUrl = "", apiKey = "", apiKeyFile = "", allowPlaintext = false, timeoutMs = 120_000,
  fetchImpl = globalThis.fetch, now = () => new Date(), sleep = ms => delay(ms), pollIntervalMs = 1_000, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  let origin = String(baseUrl).trim().replace(/\/+$/, "");
  try {
    const url = new URL(origin);
    if (!["https:", ...(allowPlaintext ? ["http:"] : [])].includes(url.protocol) || url.username || url.password || url.search || url.hash) origin = "";
  } catch { origin = ""; }
  const configured = () => Boolean(origin) && (apiKeyFile ? keyFileUsable(apiKeyFile) : validKey(apiKey));
  const counters = { searches: 0, requests: 0, collected: 0, noResults: 0, failed: 0, retried: 0 };
  let lastError = /** @type {string | null} */ (null);
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;
  const responseLimit = Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 ? Math.min(MAX_RESPONSE_BYTES, maxResponseBytes) : MAX_RESPONSE_BYTES;
  const interval = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 1_000;

  /** @param {string} route @param {string} method @param {string | undefined} body @param {string | null} idempotencyKey
   * @param {AbortSignal} signal @param {Set<string>} keys */
  async function request(route, method, body, idempotencyKey, signal, keys) {
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      const key = apiKeyFile ? await abortable(() => readKey(apiKeyFile), signal) : apiKey;
      if (!validKey(key)) throw failure("credential_unavailable");
      keys.add(key);
      counters.requests += 1;
      let response;
      try {
        response = await abortable(() => fetchImpl(`${origin}${route}`, { method, body, redirect: "error", signal,
          headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}),
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) } }), signal);
      } catch {
        signal.throwIfAborted();
        if (attempt >= RETRY_DELAYS_MS.length) throw failure("request_failed");
        counters.retried += 1;
        await abortable(() => sleep(RETRY_DELAYS_MS[attempt]), signal);
        continue;
      }
      if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw failure("redirect_refused"); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) throw failure("auth_failed");
        if ([429, 503].includes(response.status) && attempt < RETRY_DELAYS_MS.length) {
          counters.retried += 1;
          await abortable(() => sleep(retryAfterMs(response.headers, RETRY_DELAYS_MS[attempt])), signal);
          continue;
        }
        throw failure(response.status === 429 ? "rate_limited" : response.status === 503 ? "unavailable" : "http_error");
      }
      if (method === "POST" ? response.status !== 202 : response.status !== 200) { void response.body?.cancel().catch(() => {}); throw failure("response_invalid"); }
      let raw;
      try { raw = await readBoundedText(response, responseLimit, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (/** @type {any} */ (error)?.code === "response_too_large") throw error;
        if (attempt >= RETRY_DELAYS_MS.length) throw failure("request_failed");
        counters.retried += 1;
        await abortable(() => sleep(RETRY_DELAYS_MS[attempt]), signal);
        continue;
      }
      try { return JSON.parse(raw); } catch { throw failure("response_invalid"); }
    }
  }

  return {
    get configured() { return configured(); },
    status() { return { configured: configured(), counters: { ...counters }, lastError }; },
    async readiness() {
      if (!configured()) return { configured: false, ready: false };
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(budget, 5_000));
      try { await request("/health/ready", "GET", undefined, null, controller.signal, new Set()); return { configured: true, ready: true }; }
      catch { return { configured: true, ready: false }; }
      finally { clearTimeout(timer); }
    },
    /** @param {{ query: string, platforms?: string[], sort?: string, limit?: number, signal?: AbortSignal }} input */
    async search({ query, platforms = [...GEO_SOCIAL_PLATFORMS], sort = "hot", limit = SOCIAL_DEFAULT_LIMIT, signal: callerSignal }) {
      if (!configured()) throw Object.assign(new Error("The social channel is not configured."), { code: "social_posts_unconfigured" });
      if (typeof query !== "string" || !query.trim() || [...query].length > SOCIAL_MAX_QUERY_LENGTH || [...query].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        || !Array.isArray(platforms) || !platforms.length || platforms.length > GEO_SOCIAL_PLATFORMS.length || platforms.some(p => !GEO_SOCIAL_PLATFORMS.includes(p))
        || new Set(platforms).size !== platforms.length || !GEO_SOCIAL_SORTS.includes(sort) || !Number.isSafeInteger(limit) || limit < 1 || limit > SOCIAL_MAX_LIMIT) throw failure("social_posts_request_invalid");
      counters.searches += 1;
      lastError = null;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), budget);
      const deadline = Date.now() + budget;
      const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
      const keys = new Set();
      const redact = value => {
        if (typeof value !== "string") return value;
        for (const key of keys) value = value.split(key).join("[redacted]");
        return value;
      };
      let accepted = false, snapshot = null, reason = /** @type {string | null} */ (null);
      /** @type {PlatformCollection[]} */ let rows = [];
      try {
        const body = JSON.stringify({ query, platforms, sort_type: sort, page: 1,
          minimum_detail_posts: Math.max(1, Math.min(MAX_DETAIL_POSTS, Math.ceil(limit / platforms.length))),
          minimum_comments_per_post: COMMENTS_PER_POST, collect_comments: true, refresh: false, include_provider_raw: false });
        const idempotencyKey = randomUUID();
        snapshot = validateJob(await request(SOCIAL_CRAWL_PATH, "POST", body, idempotencyKey, signal, keys), query, platforms, null);
        accepted = true;
        let polls = 0;
        while (!TERMINAL_STATUSES.has(snapshot.job_status)) {
          if (Date.now() >= deadline || polls >= MAX_POLLS) throw failure("pending");
          // Validate an intermediate result before preserving it across an outage.
          if (snapshot.result != null) rows = jobCollections(snapshot, query, platforms, now().toISOString(), redact, "pending");
          await abortable(() => sleep(interval), signal);
          polls += 1;
          snapshot = validateJob(await request(`${SOCIAL_CRAWL_PATH}/${snapshot.job_id}`, "GET", undefined, null, signal, keys), query, platforms, snapshot.job_id);
        }
        rows = jobCollections(snapshot, query, platforms, now().toISOString(), redact, null);
      } catch (error) {
        const knownCodes = new Set(["pending", "response_too_large", "response_invalid", "redirect_refused", "auth_failed", "request_failed", "credential_unavailable", "rate_limited", "unavailable", "http_error"]);
        const code = /** @type {any} */ (error)?.code;
        reason = callerSignal?.aborted ? "canceled" : controller.signal.aborted ? accepted ? "pending" : "timeout" : knownCodes.has(code) ? code : "request_failed";
        rows = platforms.map(platform => {
          const previous = rows.find(row => row.platform === platform);
          return previous?.posts.length || previous?.status === "no_results" ? previous : { platform, status: "request_failed", posts: [], reason };
        });
      } finally { clearTimeout(timer); }
      const posts = [];
      for (let index = 0; posts.length < limit && rows.some(row => index < row.posts.length); index += 1) {
        for (const row of rows) { if (posts.length < limit && index < row.posts.length) posts.push(row.posts[index]); }
      }
      const coverage = rows.map(row => {
        if (row.status === "request_failed") counters.failed += 1;
        else if (row.posts.length) counters.collected += 1;
        else counters.noResults += 1;
        return { platform: row.platform, status: row.status, posts: row.posts.length, ...(row.reason ? { reason: row.reason } : {}) };
      });
      lastError = reason ?? rows.find(row => row.reason)?.reason ?? null;
      const status = socialCollectionStatus(coverage);
      const incomplete = reason || ["partial", "failed"].includes(snapshot?.job_status) || snapshot?.has_errors === true || snapshot?.result?.has_errors === true
        || snapshot?.requirements_met === false || snapshot?.result?.requirements_met === false;
      const finalStatus = incomplete && posts.length ? "partial_collected" : incomplete && status === "no_results" ? "request_failed" : status;
      const finalReason = reason ?? (finalStatus !== status ? "incomplete_collection" : null);
      return { status: finalStatus, platforms: coverage, posts, ...(finalReason ? { reason: finalReason } : {}) };
    },
  };
}
