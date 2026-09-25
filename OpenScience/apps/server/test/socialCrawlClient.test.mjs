// The six-platform social channel against a scripted upstream shaped like the
// live host's answer (2026-09-25): what is sent, what is kept (never an
// author), and how 「没采到」 stays apart from 「没人这么问」.
import assert from "node:assert/strict";
import test from "node:test";
import { GEO_SOCIAL_PLATFORMS } from "@evimed/domain";
import { createSocialCrawlClient, minimizedSocialPost, readBoundedText, socialCollectionStatus } from "../src/socialCrawlClient.mjs";

/** One post as the live host answers it: detailed, with comments that name their authors. */
function livePost(id, overrides = {}) {
  return {
    post_id: id, title: "二甲双胍  饭前还是饭后吃？", url: `https://www.xiaohongshu.com/discovery/item/${id}`,
    content: `${"我妈一直饭前吃，".repeat(40)}到底对不对`, likes: 2930, favs: 2807, shares: 447,
    comments: Array.from({ length: 12 }, (_unused, index) => ({
      comment_id: `c${index}`, source_ref: `comment:xiaohongshu:${id}:c${index}`, author: `真实用户${index}`, author_id: `u${index}`,
      content: `评论 ${index}：医生说饭中吃`, likes: 3, replies: 1, time: "2026-09-20T10:00:00",
    })),
    // Fields the upstream may add tomorrow: a whitelist drops them too.
    avatar: "https://cdn.example/avatar.png", location: "上海", ip_region: "上海", author: "楼主",
    ...overrides,
  };
}

/** A bare search hit: an id and nothing a run can use. @param {string} id */
const barePost = (id) => ({ post_id: id, title: "", url: "", content: "", likes: 0, favs: 0, shares: 0, comments: [] });

/** @param {(platform: string, body: any) => { status?: number, body?: any, raw?: string, delayMs?: number }} script */
function upstream(script) {
  const seen = /** @type {any[]} */ ([]);
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ url: String(url), method: init?.method, headers: init?.headers, body });
    const answer = script(body.platform, body);
    if (answer.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, answer.delayMs);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      });
    }
    const text = answer.raw ?? JSON.stringify(answer.body ?? {});
    return new Response(text, { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, seen };
}

/** @param {string} platform @param {any[]} posts @param {string} status */
const liveAnswer = (platform, posts, status = "collected") => ({
  body: { question: "二甲双胍", platform, search_id: "abc123", posts, meta: { collection_status: status, post_count: posts.length, sort_type: "hot", page: 1, run_id: "r" } },
});

test("a post keeps its address, id, one excerpt, engagement, collection time and comment excerpts — never an author", () => {
  const post = /** @type {any} */ (minimizedSocialPost(livePost("p1"), "xhs", "2026-09-25T02:00:00.000Z"));
  assert.deepEqual(Object.keys(post).sort(), ["collectedAt", "comments", "engagement", "excerpt", "platform", "postId", "url"]);
  assert.equal(post.url, "https://www.xiaohongshu.com/discovery/item/p1");
  assert.equal(post.postId, "p1");
  assert.equal(post.excerpt.length, 200, "at most 200 characters of title and body together");
  assert.ok(post.excerpt.startsWith("二甲双胍 饭前还是饭后吃？ 我妈"), "whitespace folded, title first");
  assert.deepEqual(post.engagement, { likes: 2930, favs: 2807, shares: 447 },
    "the comments a detail crawl returns are a sample, not the post's comment count");
  assert.equal(/** @type {any} */ (minimizedSocialPost(livePost("p4", { comment_count: 318 }), "xhs", "t")).engagement.comments, 318,
    "a count the upstream states is kept");
  assert.equal(post.comments.length, 10, "at most ten comment excerpts");
  assert.equal(post.comments[0], "评论 0：医生说饭中吃");
  const serialized = JSON.stringify(post);
  for (const forbidden of ["真实用户", "u0", "avatar", "上海", "楼主", "author", "source_ref"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} survived the minimisation`);
  }
  assert.equal(minimizedSocialPost(barePost("p2"), "xhs", "t"), null, "a bare hit carries nothing a run can use");
  assert.equal(minimizedSocialPost(livePost("p3", { url: "javascript:alert(1)" }), "xhs", "t")?.url, null, "only a web address is an address");
});

test("the request is the live host's shape, one per platform, and a limit keeps every platform's voice", async () => {
  const { fetchImpl, seen } = upstream((platform) => liveAnswer(platform, [livePost(`${platform}-1`), livePost(`${platform}-2`), barePost("x")]));
  const client = createSocialCrawlClient({ baseUrl: "http://social.internal:9966/", fetchImpl, now: () => new Date("2026-09-25T02:00:00Z") });
  const result = await client.search({ query: "二甲双胍", platforms: ["xhs", "zhihu", "douyin"], sort: "latest", limit: 4 });
  assert.deepEqual(seen.map((call) => call.url), Array(3).fill("http://social.internal:9966/api/crawl"));
  assert.deepEqual(seen.map((call) => call.body.platform), ["xhs", "zhihu", "douyin"]);
  assert.deepEqual(seen[0].body, { query: "二甲双胍", platform: "xhs", sort_type: "latest", page: 1, minimum_detail_posts: 2,
    minimum_comments_per_post: 5, include_provider_raw: false });
  assert.equal(result.status, "collected");
  assert.deepEqual(result.posts.map((/** @type {any} */ post) => post.postId), ["xhs-1", "zhihu-1", "douyin-1", "xhs-2"], "round-robin across platforms");
  assert.deepEqual(result.platforms, [
    { platform: "xhs", status: "collected", posts: 2 }, { platform: "zhihu", status: "collected", posts: 2 }, { platform: "douyin", status: "collected", posts: 2 },
  ]);
  assert.equal(result.posts[0].collectedAt, "2026-09-25T02:00:00.000Z");
  // Without platforms, all six are asked.
  seen.length = 0;
  await client.search({ query: "降糖药" });
  assert.deepEqual(seen.map((call) => call.body.platform).sort(), [...GEO_SOCIAL_PLATFORMS].sort());
});

test("没采到 is not 没人这么问: a failed platform is request_failed, and the answer says partial or failed accordingly", async () => {
  const scripts = {
    xhs: () => liveAnswer("xhs", [livePost("a")]),
    zhihu: () => ({ status: 502, body: { detail: "upstream" } }),
    weibo: () => liveAnswer("weibo", [], "no_results"),
    douyin: () => ({ raw: "<html>not json</html>" }),
  };
  const { fetchImpl } = upstream((platform) => /** @type {any} */ (scripts)[platform]());
  const client = createSocialCrawlClient({ baseUrl: "http://social.internal:9966", fetchImpl });
  const partial = await client.search({ query: "q", platforms: ["xhs", "zhihu", "weibo", "douyin"] });
  assert.equal(partial.status, "partial_collected");
  assert.deepEqual(partial.platforms.map((/** @type {any} */ entry) => [entry.platform, entry.status]),
    [["xhs", "collected"], ["zhihu", "request_failed"], ["weibo", "no_results"], ["douyin", "request_failed"]]);
  assert.equal((await client.search({ query: "q", platforms: ["weibo"] })).status, "no_results", "asked, answered, nobody");
  assert.equal((await client.search({ query: "q", platforms: ["zhihu", "weibo"] })).status, "request_failed", "nothing came back and a platform failed");
  const counters = client.status().counters;
  assert.ok(counters.failed >= 3 && counters.collected >= 1 && counters.noResults >= 2, JSON.stringify(counters));
  assert.equal(socialCollectionStatus([{ status: "partial_collected", posts: 3 }]), "partial_collected");
  assert.equal(socialCollectionStatus([]), "no_results");
});

test("every platform of a search shares one deadline; what it did not reach is request_failed", async () => {
  const { fetchImpl, seen } = upstream((platform) => (platform === "xhs" ? { ...liveAnswer("xhs", [livePost("a")]), delayMs: 5_000 } : liveAnswer(platform, [livePost("b")])));
  const client = createSocialCrawlClient({ baseUrl: "http://social.internal:9966", timeoutMs: 1_200, fetchImpl });
  const started = Date.now();
  const result = await client.search({ query: "q", platforms: ["xhs", "zhihu", "douyin", "weibo"] });
  assert.ok(Date.now() - started < 2_500, "the search ends near its deadline, not after every platform's own");
  assert.equal(result.platforms.find((/** @type {any} */ entry) => entry.platform === "xhs").status, "request_failed");
  assert.equal(result.platforms.find((/** @type {any} */ entry) => entry.platform === "weibo").status, "request_failed", "the second batch had no time left");
  assert.equal(seen.some((call) => call.body.platform === "weibo"), false, "a platform past the deadline is not asked at all");
  assert.equal(result.status, "partial_collected");
  assert.equal(client.status().lastError, "timeout");
});

test("an unconfigured channel refuses by name and is never asked", async () => {
  let asked = 0;
  const client = createSocialCrawlClient({ baseUrl: "", fetchImpl: async () => { asked += 1; return new Response("{}"); } });
  assert.equal(client.configured, false);
  await assert.rejects(client.search({ query: "q" }), { code: "social_posts_unconfigured" });
  assert.equal(asked, 0);
});

test("an answer is bounded while it streams in, not buffered whole and then refused", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  // An upstream that never stops sending (stopped by the test at 64 MB if the client does not).
  const endless = () => new Response(new ReadableStream({
    pull(controller) {
      if (pulled >= 64 * 1024 * 1024) { controller.close(); return; }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(readBoundedText(endless(), 8 * 1024 * 1024), { code: "response_too_large" });
  assert.ok(pulled <= 10 * 1024 * 1024, `read ${pulled} bytes past an 8 MB bound`);
  pulled = 0;
  const client = createSocialCrawlClient({ baseUrl: "http://social.internal:9966", fetchImpl: async () => endless() });
  const result = await client.search({ query: "q", platforms: ["xhs"] });
  assert.equal(result.status, "request_failed");
  assert.ok(pulled <= 10 * 1024 * 1024, `the client read ${pulled} bytes`);
  assert.equal(client.status().lastError, "response_too_large");
  assert.equal(await readBoundedText(new Response('{"ok":true}'), 1024), '{"ok":true}');
});
