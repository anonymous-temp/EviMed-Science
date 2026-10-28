// Collector 0.5.0: asynchronous jobs, bounded transport and minimised UGC.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GEO_SOCIAL_PLATFORMS } from "@evimed/domain";
import { isPrivateHost } from "../src/geoProbeGateway.mjs";
import { createSocialCrawlClient, minimizedSocialPost, plaintextAllowedHost, readBoundedText, socialCollectionStatus, socialIdempotencyKey, SOCIAL_IDEMPOTENCY_BUCKET_MS, SOCIAL_MAX_QUERY_LENGTH } from "../src/socialCrawlClient.mjs";

const JOB_ID = "a".repeat(32), KEY = "mock-social-key", QUERY = "二甲双胍";
const post = (id = "p1", fields = {}) => ({ post_id: id, title: "饭前还是饭后吃？", content: "饭中可以吗？", url: `https://example.org/posts/${id}`, ...fields });
const platformResult = (platform = "xhs", posts = [post()], status = "collected", fields = {}) => ({ question: QUERY, platform, posts, meta: { collection_status: status }, ...fields });
const job = (fields = {}) => ({ job_id: JOB_ID, job_status: "queued", query: QUERY, platforms: ["xhs"], result: null, ...fields });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const SCOPE = { userId: "user-1", projectId: "project-1" };
/** The asking person's and project's calls, as the gateway makes them: the token, never the request, names the scope. */
function scoped(client, scope = SCOPE) {
  return { get configured() { return client.configured; }, status: () => client.status(), readiness: () => client.readiness(),
    search: request => client.search({ scope, ...request }), job: request => client.job({ scope, ...request }) };
}
/** A job ledger in memory, with the same keys as the table: (user, project, job id). */
function memoryJobs({ failRecord = false, failFind = false } = {}) {
  const rows = new Map();
  const keyOf = (scope, jobId) => [scope.userId, scope.projectId, jobId].join("\u0000");
  return { rows,
    async record(entry) { if (failRecord) throw new Error("ledger down"); rows.set(keyOf(entry.scope, entry.jobId), { jobId: entry.jobId, query: entry.query, platforms: [...entry.platforms], sort: entry.sort, limit: entry.limit }); },
    async find(scope, jobId) { if (failFind) throw new Error("ledger down"); return rows.get(keyOf(scope, jobId)) ?? null; } };
}
function scripted(script, options = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), ...init, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null };
    seen.push(call);
    return script(call, seen.length);
  };
  const jobs = options.jobs === undefined ? memoryJobs() : options.jobs;
  const raw = createSocialCrawlClient({ baseUrl: "https://social.example", apiKey: KEY, fetchImpl,
    pollIntervalMs: 1, sleep: async () => {}, now: () => new Date("2026-10-27T02:00:00Z"), ...options, jobs });
  return { client: scoped(raw), raw, seen, fetchImpl, jobs };
}
const terminal = (result = platformResult(), fields = {}) => job({ job_status: "done", result, ...fields });
const multi = (platforms, results) => ({ job_id: JOB_ID, query: QUERY, platforms, results, progress: {}, errors: {} });

test("one authenticated multi-platform job, fixed poll path and round-robin limit", async () => {
  // Named in any order, asked in the vocabulary's: one set is one request, and so one Idempotency-Key.
  const named = ["xhs", "zhihu", "douyin"], platforms = ["xhs", "douyin", "zhihu"];
  const { client, seen } = scripted((_call, n) => json(n === 1 ? job({ platforms }) : terminal(multi(platforms,
    Object.fromEntries(platforms.map(p => [p, platformResult(p, [post(`${p}-1`), post(`${p}-2`)])]))), { platforms }), n === 1 ? 202 : 200));
  const result = await client.search({ query: QUERY, platforms: named, sort: "latest", limit: 4 });
  assert.deepEqual(seen.map(c => [c.method, c.url]), [["POST", "https://social.example/api/jobs"], ["GET", `https://social.example/api/jobs/${JOB_ID}`]]);
  assert.deepEqual(seen[0].body, { query: QUERY, platforms, sort_type: "latest", page: 1, minimum_detail_posts: 2,
    minimum_comments_per_post: 5, collect_comments: true, refresh: false, include_provider_raw: false });
  assert.ok(seen[0].headers.get("idempotency-key"));
  assert.ok(seen.every(c => c.headers.get("authorization") === `Bearer ${KEY}` && c.redirect === "error"));
  assert.equal(result.status, "collected");
  assert.deepEqual(result.posts.map(p => p.postId), ["xhs-1", "douyin-1", "zhihu-1", "xhs-2"]);
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
  const platforms = ["xhs", "douyin", "zhihu"];
  const value = multi(platforms, { xhs: platformResult(), zhihu: platformResult("zhihu", [], "no_results") });
  value.errors.douyin = KEY;
  const { client } = scripted(() => json(terminal(value, { job_status: "partial", platforms, error: KEY }), 202));
  const result = await client.search({ query: QUERY, platforms });
  assert.equal(result.status, "partial_collected");
  assert.equal(result.posts.length, 1);
  assert.equal(result.platforms[1].status, "request_failed");
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

test("pending deadline retains completed platforms, names pending rather than upstream failure and carries the job id", async () => {
  const platforms = ["xhs", "zhihu"];
  const { client, jobs } = scripted((_call, n) => json(job({ job_status: "running", platforms, result: multi(platforms, { xhs: platformResult() }) }), n === 1 ? 202 : 200),
    { timeoutMs: 25, pollIntervalMs: 20, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
  const result = await client.search({ query: QUERY, platforms, sort: "latest", limit: 7 });
  assert.equal(result.status, "pending");
  assert.equal(result.jobId, JOB_ID);
  assert.equal(result.reason, "pending");
  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.platforms.map(entry => [entry.platform, entry.status, entry.reason]), [["xhs", "collected", undefined], ["zhihu", "request_failed", "pending"]]);
  assert.equal(client.status().lastError, "pending");
  assert.deepEqual(client.status().counters, { ...client.status().counters, collected: 1, pending: 1, failed: 0 });
  // The id is recorded against the asking user and project, with the request the collector will echo.
  assert.deepEqual(jobs.rows.get([SCOPE.userId, SCOPE.projectId, JOB_ID].join("\u0000")), { jobId: JOB_ID, query: QUERY, platforms, sort: "latest", limit: 7 });
});

test("headers and slow streamed bodies share the deadline even if transport ignores abort", async () => {
  for (const stage of ["headers", "body"]) {
    let canceled = false;
    const fetchImpl = stage === "headers" ? async () => new Promise(() => {}) : async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"job_id":')); }, cancel() { canceled = true; },
    }), { status: 202 });
    const client = scoped(createSocialCrawlClient({ baseUrl: "https://social.example", apiKey: KEY, fetchImpl, timeoutMs: 20 }));
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
  const client = scoped(createSocialCrawlClient({ baseUrl: "https://social.example", apiKeyFile: file, sleep: async () => {}, fetchImpl: async (_url, init) => {
    seen.push(new Headers(init.headers).get("authorization"));
    await writeFile(file, "mock-rotated-key\n", { mode: 0o600 });
    return json(seen.length === 1 ? job() : terminal(), seen.length === 1 ? 202 : 200);
  } }));
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
    const client = scoped(createSocialCrawlClient({ ...options, fetchImpl: async () => { called = true; return json({}); } }));
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
  assert.equal(answer.status, "pending");
  assert.equal(answer.posts.length, 1);
  assert.equal(answer.reason, "pending");
  assert.equal(answer.jobId, JOB_ID);
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

// --- finding 4: a pending job is readable, and a repeat joins it ---------------------------------------------------------------------

test("the Idempotency-Key is the same search in the same ten minutes and a different one for anything else", () => {
  const at = Date.parse("2026-10-27T02:00:00Z");
  const base = { scope: SCOPE, query: QUERY, platforms: ["xhs", "zhihu"], sort: "hot", limit: 20, at, bucketMs: SOCIAL_IDEMPOTENCY_BUCKET_MS };
  const key = socialIdempotencyKey(base);
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(socialIdempotencyKey({ ...base, platforms: ["zhihu", "xhs"] }), key, "the set, not the order");
  assert.equal(socialIdempotencyKey({ ...base, at: at + SOCIAL_IDEMPOTENCY_BUCKET_MS - 1 - (at % SOCIAL_IDEMPOTENCY_BUCKET_MS) }), key, "inside the bucket");
  for (const changed of [{ scope: { ...SCOPE, userId: "user-2" } }, { scope: { ...SCOPE, projectId: "project-2" } }, { query: "other" }, { platforms: ["xhs"] },
    { sort: "latest" }, { limit: 21 }, { at: at + SOCIAL_IDEMPOTENCY_BUCKET_MS }]) {
    assert.notEqual(socialIdempotencyKey({ ...base, ...changed }), key, JSON.stringify(changed));
  }
  assert.equal(SOCIAL_IDEMPOTENCY_BUCKET_MS, 600_000);
});

test("a repeat of the same search sends the same key (and a 200 answer is the collector's replay, counted as a join); another search does not", async () => {
  const { client, seen } = scripted((call) => call.method === "POST" ? json(terminal(), seen.filter(c => c.method === "POST").length === 1 ? 202 : 200) : json({}, 500));
  await client.search({ query: QUERY, platforms: ["xhs"] });
  await client.search({ query: `  ${QUERY} `, platforms: ["xhs"] });
  assert.equal(seen[0].headers.get("idempotency-key"), seen[1].headers.get("idempotency-key"));
  assert.deepEqual(seen[0].body, seen[1].body, "the same key never carries two requests");
  assert.equal(client.status().counters.idempotent_join, 1, "only the second was handed an existing job");
  await client.search({ query: QUERY, platforms: ["xhs"], sort: "latest" });
  assert.notEqual(seen[2].headers.get("idempotency-key"), seen[0].headers.get("idempotency-key"));
  // Another person's identical search is not this one's job.
  const other = scoped(createSocialCrawlClient({ baseUrl: "https://social.example", apiKey: KEY, now: () => new Date("2026-10-27T02:00:00Z"),
    fetchImpl: async (_url, init) => { seen.push({ headers: new Headers(init.headers) }); return json(terminal(), 202); } }), { userId: "user-2", projectId: "project-1" });
  await other.search({ query: QUERY, platforms: ["xhs"] });
  assert.notEqual(seen.at(-1).headers.get("idempotency-key"), seen[0].headers.get("idempotency-key"));
});

test("a pending job is read on by the user and project that started it, and by no one else", async () => {
  let reads = 0;
  const { client, raw, jobs, seen } = scripted((call) => {
    if (call.method === "POST") return json(job({ job_status: "running" }), 202);
    reads += 1;
    return json(reads < 3 ? job({ job_status: "running" }) : terminal(platformResult("xhs", [post("late")])), 200);
  }, { timeoutMs: 15, pollIntervalMs: 30, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
  const pending = await client.search({ query: QUERY, platforms: ["xhs"], sort: "latest", limit: 5 });
  assert.equal(pending.status, "pending");
  assert.equal(pending.jobId, JOB_ID);
  assert.equal(seen.filter(c => c.method === "POST").length, 1);
  // Read on: one GET to the validated path, still running...
  const still = await client.job({ jobId: JOB_ID });
  assert.deepEqual([still.status, still.jobId, still.query, still.sort], ["pending", JOB_ID, QUERY, "latest"]);
  assert.equal(seen.filter(c => c.method === "POST").length, 1, "a read never submits");
  assert.equal(seen.at(-1).url, `https://social.example/api/jobs/${JOB_ID}`);
  // ...and then done, with the request the job was started with.
  const done = await scripted(() => json(terminal(platformResult("xhs", [post("late")])), 200), { jobs }).client.job({ jobId: JOB_ID });
  assert.deepEqual([done.status, done.posts.map(p => p.postId), done.query, done.sort], ["collected", ["late"], QUERY, "latest"]);
  // Another project of the same person, another person, a malformed id and an unrecorded one never reach the collector.
  const before = seen.length;
  for (const [who, jobId, code] of [[{ userId: SCOPE.userId, projectId: "project-2" }, JOB_ID, "social_posts_job_unknown"], [{ userId: "user-2", projectId: SCOPE.projectId }, JOB_ID, "social_posts_job_unknown"],
    [SCOPE, "b".repeat(32), "social_posts_job_unknown"], [SCOPE, "../x", "social_posts_job_invalid"], [SCOPE, 7, "social_posts_job_invalid"]]) {
    await assert.rejects(raw.job({ jobId, scope: who }), { code }, `${who.userId}/${who.projectId} ${jobId}`);
  }
  await assert.rejects(raw.job({ jobId: JOB_ID }), { code: "social_posts_job_invalid" }, "no scope, no read");
  assert.equal(seen.length, before);
  assert.equal(client.status().counters.job_reads, 1);
  assert.equal(client.status().counters.searches, 1, "a read is not a search");
});

test("an accepted job whose id cannot be stored is pending without an id, and a ledger that cannot be read is named", async () => {
  const { client } = scripted((_call, n) => json(job({ job_status: "running" }), n === 1 ? 202 : 200),
    { timeoutMs: 15, pollIntervalMs: 30, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), jobs: memoryJobs({ failRecord: true }) });
  const pending = await client.search({ query: QUERY, platforms: ["xhs"] });
  assert.equal(pending.status, "pending");
  assert.equal("jobId" in pending, false, "an id that cannot be read back is not offered");
  assert.equal(client.status().counters.job_unrecorded, 1);
  const none = scripted(() => json(terminal(), 202), { jobs: null });
  assert.equal((await none.client.search({ query: QUERY, platforms: ["xhs"] })).status, "collected", "no ledger: the search itself goes on");
  const broken = scripted(() => json({}), { jobs: memoryJobs({ failFind: true }) });
  await assert.rejects(broken.client.job({ jobId: JOB_ID }), { code: "social_posts_job_unavailable" });
});

test("an outage between two polls leaves an accepted job pending, not failed", async () => {
  const { client } = scripted((_call, n) => n === 1 ? json(job({ job_status: "running" }), 202) : json({}, 503), { sleep: async () => {} });
  const answer = await client.search({ query: QUERY, platforms: ["xhs"] });
  assert.equal(answer.status, "pending");
  assert.equal(answer.jobId, JOB_ID);
  assert.equal(client.status().lastError, "unavailable", "the operator still sees what happened");
  assert.equal(client.status().counters.failed, 0);
  // An answer that is a refusal stays one.
  const refused = scripted((_call, n) => n === 1 ? json(job({ job_status: "running" }), 202) : json({}, 404), { sleep: async () => {} });
  assert.equal((await refused.client.search({ query: QUERY, platforms: ["xhs"] })).status, "request_failed");
});

// --- finding 10: a 200 job envelope is acceptance --------------------------------------------------------------------------------------

test("the collector's 200 replay of a submit is an accepted job, not an invalid answer", async () => {
  const { client, seen } = scripted((_call, n) => {
    if (n === 1) throw new Error("connection lost");
    return json(n === 2 ? job({ job_status: "running" }) : terminal(), 200);
  });
  assert.equal((await client.search({ query: QUERY, platforms: ["xhs"] })).status, "collected");
  assert.deepEqual(seen.map(c => c.method), ["POST", "POST", "GET"]);
  assert.equal(seen[0].headers.get("idempotency-key"), seen[1].headers.get("idempotency-key"));
  assert.equal(client.status().counters.idempotent_join, 0, "the replay of this call's own submit is not a join");
  // A 200 that is not a job envelope is still invalid.
  const odd = scripted(() => json({ ok: true }, 200));
  assert.equal((await odd.client.search({ query: QUERY, platforms: ["xhs"] })).status, "request_failed");
  assert.equal(odd.client.status().lastError, "response_invalid");
});

// --- finding 9: counters ---------------------------------------------------------------------------------------------------------------

test("counters keep collected, partial, empty, failed and pending apart", async () => {
  const platforms = ["xhs", "douyin", "zhihu", "weibo"];
  const value = multi(platforms, { xhs: platformResult("xhs"), douyin: platformResult("douyin", [post("d")], "partial_collected"),
    zhihu: platformResult("zhihu", [], "no_results") });
  value.errors.weibo = "boom";
  const { client } = scripted(() => json(terminal(value, { platforms, job_status: "partial" }), 202));
  await client.search({ query: QUERY, platforms });
  const { collected, partial, noResults, failed, pending, searches } = client.status().counters;
  assert.deepEqual({ collected, partial, noResults, failed, pending, searches }, { collected: 1, partial: 1, noResults: 1, failed: 1, pending: 0, searches: 1 });
});

// --- finding 6: a named reason, a real readability check, one plaintext rule -------------------------------------------------------------

test("a key file the web user cannot read is not configured, and each reason is named", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "social-reason-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const make = (options) => createSocialCrawlClient({ baseUrl: "https://social.example", ...options });
  const key = path.join(dir, "key");
  await writeFile(key, `${KEY}\n`, { mode: 0o600 });
  assert.equal(make({ apiKeyFile: key }).status().configured, true);
  assert.equal("reason" in make({ apiKeyFile: key }).status(), false);
  const reasonOf = (options) => make(options).status().reason;
  assert.equal(reasonOf({ apiKeyFile: path.join(dir, "absent") }), "key_missing");
  assert.equal(reasonOf({ apiKeyFile: "/dev/null" }), "key_missing", "compose binds /dev/null where no host file was named");
  assert.equal(reasonOf({}), "key_missing");
  assert.equal(reasonOf({ apiKey: "has a space" }), "key_missing");
  const wide = path.join(dir, "wide");
  await writeFile(wide, `${KEY}\n`, { mode: 0o644 });
  await chmod(wide, 0o644);
  assert.equal(reasonOf({ apiKeyFile: wide }), "key_mode");
  const empty = path.join(dir, "empty");
  await writeFile(empty, "", { mode: 0o600 });
  assert.equal(reasonOf({ apiKeyFile: empty }), "key_invalid");
  assert.equal(reasonOf({ apiKeyFile: dir }), "key_invalid", "a directory is not a key");
  // The lstat checks pass for a file owned by someone else with mode 0600; only asking the file for read access tells. As root it is always readable.
  if (process.getuid?.() !== 0) {
    const sealed = path.join(dir, "sealed");
    await writeFile(sealed, `${KEY}\n`, { mode: 0o600 });
    await chmod(sealed, 0o000);
    const client = make({ apiKeyFile: sealed });
    assert.equal(client.configured, false);
    assert.equal(client.status().reason, "key_unreadable");
    await assert.rejects(client.search({ query: QUERY, scope: SCOPE }), { code: "social_posts_unconfigured" });
    assert.deepEqual(await client.readiness(), { configured: false, ready: false, reason: "key_unreadable" });
    await chmod(sealed, 0o600);
    assert.equal(client.configured, true, "re-read on every call: a mount fixed under a running process is noticed");
  }
});

test("the URL has its own reasons, and plaintext follows the probe's rule: refused to a public address unless allowed, fine to a private one", () => {
  const status = (options) => createSocialCrawlClient({ apiKey: KEY, ...options }).status();
  assert.equal(status({}).reason, "url_missing");
  for (const baseUrl of ["social.example", "ftp://social.example", "https://u:p@social.example", "https://social.example/?q=1", "https://social.example/#x"]) {
    assert.equal(status({ baseUrl }).reason, "url_invalid", baseUrl);
  }
  assert.equal(status({ baseUrl: "https://social.example" }).configured, true);
  assert.equal(status({ baseUrl: "http://social.example" }).reason, "plaintext_not_allowed");
  assert.equal(status({ baseUrl: "http://203.0.113.9:9966" }).reason, "plaintext_not_allowed");
  assert.equal(status({ baseUrl: "http://social.example", allowPlaintext: true }).configured, true);
  for (const baseUrl of ["http://127.0.0.1:9966", "http://10.0.0.5:9966", "http://192.168.1.4", "http://172.16.0.9", "http://100.64.0.2", "http://[::1]:9966", "http://localhost:9966", "http://social.internal:9966", "http://social:9966"]) {
    assert.equal(status({ baseUrl }).configured, true, `${baseUrl} is a private address`);
  }
});

test("the social channel and the probe host agree on which hosts may be reached in plaintext", () => {
  for (const host of ["localhost", "a.localhost", "social.local", "social.internal", "127.0.0.1", "127.9.9.9", "10.0.0.5", "172.16.0.1", "172.31.255.255", "172.15.0.1", "172.32.0.1",
    "192.168.1.1", "192.169.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "100.128.0.1", "8.8.8.8", "203.0.113.9", "999.1.1.1", "[::1]", "::1", "[fd12::1]", "fdnet",
    "fda.gov", "[fe80::1]", "[2001:db8::1]", "social", "social.example", "www.example.org", "", "SOCIAL.INTERNAL"]) {
    assert.equal(plaintextAllowedHost(host), isPrivateHost(host), JSON.stringify(host));
  }
});

test("a deadline that passes while the job id is being stored still leaves the id to read on", async () => {
  const slow = memoryJobs();
  const store = slow.record;
  slow.record = async entry => { await new Promise(resolve => setTimeout(resolve, 40)); return store(entry); };
  const { client } = scripted((_call, n) => json(job({ job_status: "running" }), n === 1 ? 202 : 200),
    { timeoutMs: 10, pollIntervalMs: 5, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), jobs: slow });
  const pending = await client.search({ query: QUERY, platforms: ["xhs"] });
  assert.deepEqual([pending.status, pending.jobId], ["pending", JOB_ID]);
  assert.equal(client.status().counters.job_unrecorded, 0);
});
