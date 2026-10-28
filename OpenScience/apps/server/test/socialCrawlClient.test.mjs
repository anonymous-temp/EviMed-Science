// Collector 0.5.0: asynchronous jobs, bounded transport and minimised UGC.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GEO_SOCIAL_PLATFORMS } from "@evimed/domain";
import { createSocialCrawlClient, minimizedSocialPost, readBoundedText, socialCollectionStatus, SOCIAL_MAX_QUERY_LENGTH } from "../src/socialCrawlClient.mjs";

const JOB_ID = "a".repeat(32), KEY = "mock-social-key", QUERY = "二甲双胍";
const post = (id = "p1", fields = {}) => ({ post_id: id, title: "饭前还是饭后吃？", content: "饭中可以吗？", url: `https://example.org/posts/${id}`, ...fields });
const platformResult = (platform = "xhs", posts = [post()], status = "collected", fields = {}) => ({ question: QUERY, platform, posts, meta: { collection_status: status }, ...fields });
const job = (fields = {}) => ({ job_id: JOB_ID, job_status: "queued", query: QUERY, platforms: ["xhs"], result: null, ...fields });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function scripted(script, options = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), ...init, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null };
    seen.push(call);
    return script(call, seen.length);
  };
  const client = createSocialCrawlClient({ baseUrl: "https://social.example", apiKey: KEY, fetchImpl,
    pollIntervalMs: 1, sleep: async () => {}, now: () => new Date("2026-10-27T02:00:00Z"), ...options });
  return { client, seen, fetchImpl };
}
const terminal = (result = platformResult(), fields = {}) => job({ job_status: "done", result, ...fields });
const multi = (platforms, results) => ({ job_id: JOB_ID, query: QUERY, platforms, results, progress: {}, errors: {} });

test("one authenticated multi-platform job, fixed poll path and round-robin limit", async () => {
  const platforms = ["xhs", "zhihu", "douyin"];
  const { client, seen } = scripted((_call, n) => json(n === 1 ? job({ platforms }) : terminal(multi(platforms,
    Object.fromEntries(platforms.map(p => [p, platformResult(p, [post(`${p}-1`), post(`${p}-2`)])]))), { platforms }), n === 1 ? 202 : 200));
  const result = await client.search({ query: QUERY, platforms, sort: "latest", limit: 4 });
  assert.deepEqual(seen.map(c => [c.method, c.url]), [["POST", "https://social.example/api/jobs"], ["GET", `https://social.example/api/jobs/${JOB_ID}`]]);
  assert.deepEqual(seen[0].body, { query: QUERY, platforms, sort_type: "latest", page: 1, minimum_detail_posts: 2,
    minimum_comments_per_post: 5, collect_comments: true, refresh: false, include_provider_raw: false });
  assert.ok(seen[0].headers.get("idempotency-key"));
  assert.ok(seen.every(c => c.headers.get("authorization") === `Bearer ${KEY}` && c.redirect === "error"));
  assert.equal(result.status, "collected");
  assert.deepEqual(result.posts.map(p => p.postId), ["xhs-1", "zhihu-1", "douyin-1", "xhs-2"]);
  assert.deepEqual(result.platforms, platforms.map(platform => ({ platform, status: "collected", posts: 2 })));
});

test("terminal POST result needs no extra poll", async () => {
  const { client, seen } = scripted(() => json(terminal(), 202));
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).posts.length, 1);
  assert.equal(seen.length, 1);
});

test("UGC whitelist bounds excerpts/comments, drops personal/raw fields and preserves unknown engagement", () => {
  const kept = minimizedSocialPost(post("p", { title: "a".repeat(300), content: "b".repeat(300), likes: null, favs: "bad", shares: 0,
    author: "private-author", author_id: "private-user", raw_response: { token: KEY }, avatar: "private-avatar",
    comments: Array.from({ length: 12 }, () => ({ content: "c".repeat(300), author: "private-commenter" })) }), "xhs", "t");
  assert.equal(kept.excerpt.length, 200);
  assert.equal(kept.comments.length, 10);
  assert.ok(kept.comments.every(c => c.length === 200));
  assert.deepEqual(kept.engagement, { shares: 0 });
  assert.equal(JSON.stringify(kept).includes("private"), false);
  assert.equal(JSON.stringify(kept).includes(KEY), false);
  assert.deepEqual(minimizedSocialPost(post("p", { comment_count: 318 }), "xhs", "t").engagement, { comments: 318 });
  assert.equal(minimizedSocialPost({ post_id: "bare" }, "xhs", "t"), null);
  for (const url of ["javascript:alert(1)", "http://user:test-only-password@example.org", "https://127.0.0.1/a", "http://169.254.169.254/meta", "https://example.org/?token=test-only-key"]) {
    assert.equal(minimizedSocialPost(post("p", { url }), "xhs", "t").url, null);
  }
});

test("only explicit successful empty results establish no_results", async () => {
  for (const [upstream, posts, expected] of [["no_results", [], "no_results"], ["collected", [], "request_failed"], ["partial_collected", [], "request_failed"], ["failed", [], "request_failed"], ["unknown", [], "request_failed"], ["no_results", [post()], "partial_collected"]]) {
    const { client } = scripted(() => json(terminal(platformResult("xhs", posts, upstream)), 202));
    assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, expected, upstream);
  }
  assert.equal(socialCollectionStatus([]), "request_failed");
  assert.equal(socialCollectionStatus([{ status: "partial_collected", posts: 0 }]), "request_failed");
});

test("partial and failed jobs retain usable posts; missing platforms remain unknown", async () => {
  const platforms = ["xhs", "zhihu", "douyin"];
  const value = multi(platforms, { xhs: platformResult(), zhihu: platformResult("zhihu", [], "no_results") });
  value.errors.douyin = KEY;
  const { client } = scripted(() => json(terminal(value, { job_status: "partial", platforms, error: KEY }), 202));
  const result = await client.search({ query: QUERY, platforms });
  assert.equal(result.status, "partial_collected");
  assert.equal(result.posts.length, 1);
  assert.equal(result.platforms[2].status, "request_failed");
  assert.equal(JSON.stringify(result).includes(KEY), false);
  const failed = scripted(() => json(terminal(platformResult(), { job_status: "failed" }), 202));
  assert.equal((await failed.client.search({ query: QUERY, platforms: ["xhs"] })).status, "partial_collected");
});

test("invalid query/platform/job identities never admit UGC or choose a poll URL", async () => {
  for (const fields of [{ job_id: "../secrets" }, { job_id: "https://elsewhere.example/job" }, { job_status: "mystery" }, { query: "other" },
    { platforms: ["zhihu"] }, { platforms: ["xhs", "xhs"] }, { job_status: "done", result: platformResult("zhihu") },
    { job_status: "done", result: platformResult("xhs", [post()], "collected", { question: "other" }) },
    { job_status: "done", result: { ...multi(["xhs"], { xhs: platformResult() }), query: "other" } },
    { job_status: "done", result: multi(["xhs"], { alien: platformResult() }) }, { job_status: "done", result: null }]) {
    const { client, seen } = scripted(() => json(job(fields), 202));
    const result = await client.search({ query: QUERY, platforms: ["xhs"] });
    assert.equal(result.status, "request_failed", JSON.stringify(fields));
    assert.equal(result.posts.length, 0);
    assert.equal(seen.length, 1);
  }
  const { client, seen } = scripted((_call, n) => json(n === 1 ? job() : terminal(platformResult(), { job_id: "b".repeat(32) }), n === 1 ? 202 : 200));
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "request_failed");
  assert.equal(seen.length, 2);
});

test("POST uncertainty uses stable idempotency; poll retries never submit another job", async () => {
  const { client, seen } = scripted((_call, n) => {
    if (n === 1) throw new Error(`connection lost ${KEY}`);
    if (n === 3) return json({ error: KEY }, 503, { "retry-after": "0" });
    return json(n >= 4 ? terminal() : job(), n === 2 ? 202 : 200);
  });
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "collected");
  assert.equal(seen.filter(c => c.method === "POST").length, 2);
  assert.equal(seen[0].headers.get("idempotency-key"), seen[1].headers.get("idempotency-key"));
  assert.deepEqual(seen[0].body, seen[1].body);
  assert.equal(client.status().counters.retried, 2);
  assert.equal(JSON.stringify(client.status()).includes(KEY), false);
});

test("auth and non-retryable HTTP failures are final; busy Retry-After is bounded", async () => {
  for (const status of [401, 403, 400, 404, 409, 422, 500]) {
    const { client, seen } = scripted(() => json({ message: KEY }, status));
    assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "request_failed");
    assert.equal(seen.length, 1, String(status));
    assert.equal(JSON.stringify(client.status()).includes(KEY), false);
  }
  const waits = [];
  const { client, seen } = scripted((_call, n) => n < 3 ? json({}, n === 1 ? 429 : 503, { "retry-after": n === 1 ? "999999" : "invalid" }) : json(terminal(), 202),
    { timeoutMs: 120_000, sleep: async ms => { waits.push(ms); } });
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "collected");
  assert.equal(seen.length, 3);
  assert.ok(waits[0] <= 30_000 && waits[1] > 0);
});

test("pending deadline retains completed platforms and names pending rather than upstream failure", async () => {
  const platforms = ["xhs", "zhihu"];
  const { client } = scripted((_call, n) => json(job({ job_status: "running", platforms, result: multi(platforms, { xhs: platformResult() }) }), n === 1 ? 202 : 200),
    { timeoutMs: 25, pollIntervalMs: 20, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
  const result = await client.search({ query: QUERY, platforms });
  assert.equal(result.status, "partial_collected");
  assert.equal(result.posts.length, 1);
  assert.equal(result.platforms[1].reason, "pending");
  assert.equal(client.status().lastError, "pending");
});

test("headers and slow streamed bodies share the deadline even if transport ignores abort", async () => {
  for (const stage of ["headers", "body"]) {
    let canceled = false;
    const fetchImpl = stage === "headers" ? async () => new Promise(() => {}) : async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"job_id":')); }, cancel() { canceled = true; },
    }), { status: 202 });
    const client = createSocialCrawlClient({ baseUrl: "https://social.example", apiKey: KEY, fetchImpl, timeoutMs: 20 });
    const began = Date.now();
    assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "request_failed");
    assert.ok(Date.now() - began < 1_000);
    if (stage === "body") assert.equal(canceled, true);
  }
});

test("abort ends pending search; declared and streamed body sizes are bounded", async () => {
  const controller = new AbortController();
  const { client } = scripted(() => json(job(), 202), { pollIntervalMs: 100, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
  const pending = client.search({ query: QUERY, platforms: ["xhs"], signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await pending).platforms[0].reason, "canceled");
  for (const response of [new Response("a".repeat(20)), new Response("tiny", { headers: { "content-length": "100" } })]) {
    await assert.rejects(readBoundedText(response, 10), { code: "response_too_large" });
  }
  const large = scripted(() => new Response("a".repeat(20), { status: 202 }), { maxResponseBytes: 10 });
  assert.equal((await large.client.search({ query: QUERY, platforms: ["xhs"] })).status, "request_failed");
  assert.equal(large.client.status().lastError, "response_too_large");
});

test("redirects are refused without forwarding credentials", async () => {
  const { client, seen } = scripted(() => new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }));
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "request_failed");
  assert.equal(seen.length, 1);
  assert.equal(client.status().lastError, "redirect_refused");
});

test("key files rotate between requests and unsafe files are not configured", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "social-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "key");
  await writeFile(file, KEY + "\n", { mode: 0o600 });
  const seen = [];
  const client = createSocialCrawlClient({ baseUrl: "https://social.example", apiKeyFile: file, sleep: async () => {}, fetchImpl: async (_url, init) => {
    seen.push(new Headers(init.headers).get("authorization"));
    await writeFile(file, "mock-rotated-key\n", { mode: 0o600 });
    return json(seen.length === 1 ? job() : terminal(), seen.length === 1 ? 202 : 200);
  } });
  assert.equal(client.configured, true);
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "collected");
  assert.deepEqual(seen, [`Bearer ${KEY}`, "Bearer mock-rotated-key"]);
  assert.equal(JSON.stringify(client.status()).includes("mock-"), false);
  await chmod(file, 0o644);
  assert.equal(client.configured, false);
  const linked = path.join(dir, "linked");
  await symlink(file, linked);
  assert.equal(createSocialCrawlClient({ baseUrl: "https://social.example", apiKeyFile: linked }).configured, false);
});

test("URL, credentials and input arguments are refused before transport", async () => {
  for (const options of [{}, { baseUrl: "https://social.example" }, { baseUrl: "http://social.example", apiKey: KEY }, { baseUrl: "https://user:test-only-password@social.example", apiKey: KEY }]) {
    let called = false;
    const client = createSocialCrawlClient({ ...options, fetchImpl: async () => { called = true; return json({}); } });
    assert.equal(client.configured, false);
    await assert.rejects(client.search({ query: QUERY }), { code: "social_posts_unconfigured" });
    assert.equal(called, false);
  }
  assert.equal(SOCIAL_MAX_QUERY_LENGTH, 256);
  const { client, seen } = scripted(() => json(terminal(), 202));
  for (const request of [{ query: "" }, { query: "x".repeat(257) }, { query: QUERY, platforms: [] }, { query: QUERY, platforms: ["bad"] }, { query: QUERY, limit: NaN }, { query: QUERY, sort: "bad" }]) {
    await assert.rejects(client.search(request), { code: "social_posts_request_invalid" });
  }
  assert.equal(seen.length, 0);
  const platforms = [...GEO_SOCIAL_PLATFORMS];
  const all = scripted(() => json(terminal(multi(platforms, Object.fromEntries(platforms.map(p => [p, platformResult(p, [], "no_results")]))), { platforms }), 202));
  assert.equal((await all.client.search({ query: QUERY })).status, "no_results");
});

test("readiness uses documented bounded GET and returns no diagnostics", async () => {
  const { client, seen } = scripted(() => json({ status: "ready", token: KEY, details: "private" }));
  assert.deepEqual(await client.readiness(), { configured: true, ready: true });
  assert.equal(seen[0].url, "https://social.example/health/ready");
  assert.equal(seen[0].method, "GET");
});

test("stage errors override collected while usable posts survive, matching the 0.5.0 live shape", async () => {
  for (const meta of [{ has_errors: true }, { requirements_met: false }, { comments: { failed: 1, complete: false } },
    { stage_completeness: { comments: { enabled: true, complete: false, status: "failed" } } }]) {
    const result = platformResult("xhs", [post()], "collected", { meta: { collection_status: "collected", ...meta } });
    const { client } = scripted(() => json(terminal(result), 202));
    const answer = await client.search({ query: QUERY, platforms: ["xhs"] });
    assert.equal(answer.status, "partial_collected", JSON.stringify(meta));
    assert.equal(answer.platforms[0].status, "partial_collected");
    assert.equal(answer.posts.length, 1);
  }
  const { client } = scripted(() => json(terminal(platformResult(), { job_status: "partial" }), 202));
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "partial_collected");
});

test("known credentials echoed into retained fields are redacted before truncation", async () => {
  const result = platformResult("xhs", [post(KEY, { title: KEY, content: KEY, comments: [{ content: KEY }], url: `https://example.org/${KEY}` })]);
  const { client } = scripted(() => json(terminal(result), 202));
  assert.equal(JSON.stringify(await client.search({ query: QUERY, platforms: ["xhs"] })).includes(KEY), false);
});

test("malformed JSON never becomes an empty collection and retries are bounded", async () => {
  const { client, seen } = scripted(() => new Response("not-json", { status: 202 }));
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "request_failed");
  assert.equal(client.status().lastError, "response_invalid");
  assert.equal(seen.length, 1);
  const busy = scripted(() => json({}, 503), { sleep: async () => {} });
  assert.equal((await busy.client.search({ query: QUERY, platforms: ["xhs"] })).status, "request_failed");
  assert.equal(busy.seen.length, 3);
});

test("a poll body cut off is retried without another POST", async () => {
  const { client, seen } = scripted((_call, n) => {
    if (n === 2) return new Response(new ReadableStream({ start(controller) { controller.error(new Error(`connection lost ${KEY}`)); } }));
    return json(n === 1 ? job() : terminal(), n === 1 ? 202 : 200);
  });
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "collected");
  assert.equal(seen.filter(c => c.method === "POST").length, 1);
  assert.equal(seen.filter(c => c.method === "GET").length, 2);
});

test("platform progress can report a partial failure independently of its collected metadata", async () => {
  const platforms = ["xhs", "zhihu"], value = multi(platforms, { xhs: platformResult(), zhihu: platformResult("zhihu") });
  value.progress.zhihu = { status: "partial", error: KEY };
  const { client } = scripted(() => json(terminal(value, { platforms }), 202));
  const answer = await client.search({ query: QUERY, platforms });
  assert.equal(answer.status, "partial_collected");
  assert.equal(answer.platforms[0].status, "collected");
  assert.equal(answer.platforms[1].status, "partial_collected");
  assert.equal(answer.posts.length, 2);
  assert.equal(JSON.stringify(answer).includes(KEY), false);
});

test("a globally partial job cannot certify an empty observation", async () => {
  const { client } = scripted(() => json(terminal(platformResult("xhs", [], "no_results"), { job_status: "partial" }), 202));
  const answer = await client.search({ query: QUERY, platforms: ["xhs"] });
  assert.equal(answer.status, "request_failed");
  assert.equal(answer.reason, "incomplete_collection");
});

test("pending reason reaches the caller even when every platform already has usable posts", async () => {
  const { client } = scripted((_call, n) => json(job({ job_status: "running", result: platformResult() }), n === 1 ? 202 : 200),
    { timeoutMs: 20, pollIntervalMs: 100, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
  const answer = await client.search({ query: QUERY, platforms: ["xhs"] });
  assert.equal(answer.status, "partial_collected");
  assert.equal(answer.posts.length, 1);
  assert.equal(answer.reason, "pending");
});

test("authoritative job requirements prevent full coverage even when platform rows look collected", async () => {
  for (const atResult of [false, true]) {
    for (const empty of [false, true]) {
      const result = platformResult("xhs", empty ? [] : [post()], empty ? "no_results" : "collected");
      const snapshot = terminal(result);
      (atResult ? snapshot.result : snapshot).requirements_met = false;
      const { client } = scripted(() => json(snapshot, 202));
      assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, empty ? "request_failed" : "partial_collected");
    }
  }
});
