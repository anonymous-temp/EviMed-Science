/**
 * The six-platform social channel (「真人怎么问」, build spec 2026-09-25 §4):
 * `POST {OPEN_SCIENCE_GEO_SOCIAL_URL}/api/crawl`, one request per platform.
 *
 * Hidden knowledge:
 *
 * - **UGC is minimised before anything else sees it.** A post leaves this
 *   module as its platform, its address, its post id, one excerpt of at most
 *   200 characters (title and body together), its engagement counts, the
 *   time it was collected and at most ten comment excerpts of the same
 *   length. Author names and ids, avatars, locations, IP regions and full
 *   texts are never read out of the upstream answer — the minimisation is a
 *   whitelist, so a field the upstream adds tomorrow is dropped too. Nothing
 *   is stored: the answer goes to the run and nowhere else.
 * - **The wire, as the live host answered it on 2026-09-25**: the request is
 *   `{query, platform, sort_type, page, minimum_detail_posts,
 *   minimum_comments_per_post, include_provider_raw: false}` (an empty body is
 *   a 422); the answer is `{question, platform, search_id, posts: [{post_id,
 *   title, url, content, likes, favs, shares, comments: [{content, author,
 *   author_id, …}]}], meta: {collection_status, post_count, sort_type, page}}`.
 *   Only the first `minimum_detail_posts` posts carry a body, an address and
 *   comments; the rest are bare ids, which carry nothing a run can use and are
 *   left out.
 * - **「没采到」 is not 「没人这么问」.** Each platform reports
 *   `collected | partial_collected | no_results | request_failed`; the
 *   answer's status is `collected` only when every platform answered and some
 *   posts came back, `partial_collected` when some came back and some platform
 *   failed or said partial, `no_results` only when every platform answered
 *   and none had a post, and `request_failed` when nothing came back and a
 *   platform failed. A run reads the last as 「无信号」, never as zero.
 * - **Engagement is what the platform counted, or nothing.** The comments a
 *   detail crawl returns are at most `minimum_comments_per_post` of them, so
 *   their number is not the post's comment count; `engagement.comments` is set
 *   only from a count the upstream states (`comment_count`), and is absent
 *   otherwise — never the length of a sample dressed as a total.
 * - An answer is read at most 8 MB, counted while it streams in: an upstream
 *   that sends more is cut off there, not buffered whole and then refused.
 * - Platforms are asked three at a time, all within one deadline — the
 *   configured timeout (a detail crawl took 14 s for one post on the live
 *   host; five posts with five comments each take longer). A platform the
 *   deadline did not reach is `request_failed`, never `no_results`.
 *
 * @module socialCrawlClient
 */

import { GEO_SOCIAL_EXCERPT_MAX_CHARS, GEO_SOCIAL_PLATFORMS, GEO_SOCIAL_SORTS } from "@evimed/domain";

export const SOCIAL_CRAWL_PATH = "/api/crawl";
export const SOCIAL_MAX_LIMIT = 50;
export const SOCIAL_DEFAULT_LIMIT = 20;
export const SOCIAL_MAX_QUERY_LENGTH = 100;
/** Detailed posts asked of each platform at most, and the comments asked of each. */
const MAX_DETAIL_POSTS = 10;
const COMMENTS_PER_POST = 5;
const MAX_COMMENTS_KEPT = 10;
/**
 * One platform at a time: the crawler serves one request at a time and answers
 * 429 to the rest. Measured on production 2026-09-25 with three at once: 14 of
 * 16 platform requests came back 429 and a question map was built from two.
 */
const CONCURRENCY = 1;
/** Waits before asking again after a busy answer (429/503), inside the search's one deadline. */
const BUSY_BACKOFF_MS = Object.freeze([2_000, 5_000, 10_000]);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const UPSTREAM_STATUSES = new Set(["collected", "partial_collected", "no_results", "request_failed"]);

/** @param {unknown} value */
const excerpt = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, GEO_SOCIAL_EXCERPT_MAX_CHARS);
/** @param {unknown} value */
const count = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
};

/** A count the upstream states, or null when it states none. @param {unknown} value */
function statedCount(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

/**
 * A response body as text, read chunk by chunk and abandoned the moment it
 * passes `limit` bytes.
 * @param {Response} response @param {number} limit
 */
export async function readBoundedText(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("The social channel's answer is too large."), { code: "response_too_large" });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))).toString("utf8");
}

/**
 * One upstream post, reduced to what may be kept.
 * @param {any} post @param {string} platform @param {string} collectedAt
 */
export function minimizedSocialPost(post, platform, collectedAt) {
  if (!post || typeof post !== "object") return null;
  const title = excerpt(post.title);
  const body = excerpt(post.content);
  const joined = excerpt([title, body].filter(Boolean).join(" "));
  let url = null;
  if (typeof post.url === "string" && post.url) {
    try {
      const parsed = new URL(post.url);
      if (["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href;
    } catch { url = null; }
  }
  const comments = (Array.isArray(post.comments) ? post.comments : [])
    .map((/** @type {any} */ comment) => excerpt(comment && typeof comment === "object" ? comment.content ?? comment.text : comment))
    .filter(Boolean)
    .slice(0, MAX_COMMENTS_KEPT);
  if (!url && !joined && !comments.length) return null;
  const postId = typeof post.post_id === "string" || typeof post.post_id === "number" ? String(post.post_id).slice(0, 120)
    : typeof post.id === "string" || typeof post.id === "number" ? String(post.id).slice(0, 120) : null;
  return {
    platform,
    url,
    postId,
    excerpt: joined,
    engagement: {
      likes: count(post.likes), favs: count(post.favs), shares: count(post.shares),
      ...(statedCount(post.comment_count ?? post.comments_count) != null ? { comments: statedCount(post.comment_count ?? post.comments_count) } : {}),
    },
    collectedAt,
    comments,
  };
}

/**
 * The one status an answer carries, from each platform's (see the module note).
 * @param {Array<{ status: string, posts: number }>} platforms
 */
export function socialCollectionStatus(platforms) {
  const posts = platforms.reduce((sum, entry) => sum + entry.posts, 0);
  const failed = platforms.some((entry) => entry.status === "request_failed");
  const partial = platforms.some((entry) => entry.status === "partial_collected");
  if (posts > 0) return failed || partial ? "partial_collected" : "collected";
  return failed ? "request_failed" : "no_results";
}

/**
 * @param {{ baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch, now?: () => Date, sleep?: (ms: number) => Promise<unknown> }} options
 */
export function createSocialCrawlClient({ baseUrl = "", timeoutMs = 120_000, fetchImpl = globalThis.fetch, now = () => new Date(),
  sleep = (/** @type {number} */ ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }) } = {}) {
  const origin = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const counters = { searches: 0, requests: 0, collected: 0, noResults: 0, failed: 0, retried: 0 };
  let lastError = /** @type {string | null} */ (null);

  /**
   * One platform's crawl, never throwing: a failure is the platform's status.
   * Every platform of one search shares one deadline, so a slow first batch
   * leaves the rest less time rather than the whole search more.
   * @param {string} query @param {string} platform @param {string} sort @param {number} detailPosts @param {number} deadline epoch ms
   */
  async function crawl(query, platform, sort, detailPosts, deadline) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await crawlOnce(query, platform, sort, detailPosts, deadline);
      const wait = BUSY_BACKOFF_MS[attempt];
      if (!result.busy || wait == null || deadline - Date.now() < wait + 5_000) return { platform: result.platform, status: result.status, posts: result.posts };
      counters.retried += 1;
      await sleep(wait);
    }
  }

  /** @param {string} query @param {string} platform @param {string} sort @param {number} detailPosts @param {number} deadline */
  async function crawlOnce(query, platform, sort, detailPosts, deadline) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) {
      lastError = "timeout";
      counters.failed += 1;
      return { platform, status: "request_failed", posts: [] };
    }
    counters.requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${origin}${SOCIAL_CRAWL_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, platform, sort_type: sort, page: 1, minimum_detail_posts: detailPosts,
          minimum_comments_per_post: COMMENTS_PER_POST, include_provider_raw: false }),
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = `http_${response.status}`;
        counters.failed += 1;
        return { platform, status: "request_failed", posts: [], busy: response.status === 429 || response.status === 503 };
      }
      const body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
      const collectedAt = now().toISOString();
      const upstream = String(body?.meta?.collection_status ?? "");
      const posts = (Array.isArray(body?.posts) ? body.posts : [])
        .map((/** @type {any} */ post) => minimizedSocialPost(post, platform, collectedAt))
        .filter(Boolean);
      const status = UPSTREAM_STATUSES.has(upstream) ? upstream : posts.length ? "collected" : "no_results";
      if (status === "request_failed") counters.failed += 1;
      else if (posts.length) counters.collected += 1;
      else counters.noResults += 1;
      return { platform, status, posts };
    } catch (error) {
      lastError = /** @type {any} */ (error)?.name === "AbortError" ? "timeout" : /** @type {any} */ (error)?.code ?? "request_failed";
      counters.failed += 1;
      return { platform, status: "request_failed", posts: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get configured() { return Boolean(origin); },
    status() { return { configured: Boolean(origin), counters: { ...counters }, lastError }; },
    /**
     * Search the platforms for how real people phrase a question. Arguments
     * are validated by the gateway; this bounds them again.
     * @param {{ query: string, platforms?: string[], sort?: string, limit?: number }} request
     */
    async search({ query, platforms = [...GEO_SOCIAL_PLATFORMS], sort = "hot", limit = SOCIAL_DEFAULT_LIMIT }) {
      if (!origin) throw Object.assign(new Error("The social channel is not configured."), { code: "social_posts_unconfigured" });
      counters.searches += 1;
      const chosen = [...new Set(platforms)].filter((platform) => GEO_SOCIAL_PLATFORMS.includes(platform));
      const order = GEO_SOCIAL_SORTS.includes(sort) ? sort : "hot";
      const cap = Math.max(1, Math.min(SOCIAL_MAX_LIMIT, Math.floor(limit)));
      const detailPosts = Math.max(1, Math.min(MAX_DETAIL_POSTS, Math.ceil(cap / Math.max(1, chosen.length))));
      const deadline = Date.now() + timeoutMs;
      /** @type {Array<{ platform: string, status: string, posts: any[] }>} */
      const results = [];
      for (let start = 0; start < chosen.length; start += CONCURRENCY) {
        results.push(...await Promise.all(chosen.slice(start, start + CONCURRENCY)
          .map((platform) => crawl(query, platform, order, detailPosts, deadline))));
      }
      /** @type {any[]} */
      const posts = [];
      // Round-robin across platforms so a limit keeps every platform's voice.
      for (let index = 0; posts.length < cap && results.some((result) => index < result.posts.length); index += 1) {
        for (const result of results) {
          if (posts.length >= cap) break;
          if (index < result.posts.length) posts.push(result.posts[index]);
        }
      }
      const platformStatuses = results.map((result) => ({ platform: result.platform, status: result.status, posts: result.posts.length }));
      return { status: socialCollectionStatus(platformStatuses), platforms: platformStatuses, posts };
    },
  };
}
