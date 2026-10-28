import assert from "node:assert/strict";
import test from "node:test";
import { probeUpstream, GEO_UNDELIVERED_FAILURE_CODES } from "../src/geoProbeGateway.mjs";

const id = "4606654b1e144e1d81d9de6c91e5099a";
const config = { geoProbeUrl: "http://probe.internal:9999", geoProbeTimeoutMs: 1000 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = { provider: "deepseek", status: "ok", answer: "A real consumer answer", source: "browser", search_results: [] };
const completed = (rows = [row]) => ({ request_id: id, job_status: "done", question: "test", providers: ["deepseek"], result: { request_id: id, question: "test", results: rows } });

test("pool readiness distinguishes busy capacity from quarantine and omits slots", async () => {
  const client = probeUpstream(config, { fetchImpl: async () => json({ providers: {
    deepseek: { total: 5, idle: 0, busy: 5, quarantined: 0 },
    kimi: { total: 2, idle: 0, busy: 0, quarantined: 2 },
  }, slots: [{ cdp_url: "secret-internal" }] }) });
  const result = await client.providers();
  assert.deepEqual(result.ready, ["deepseek"]);
  assert.equal(result.providers.find((p) => p.provider === "deepseek").state, "busy");
  assert.equal(JSON.stringify(result).includes("secret-internal"), false);
});

test("one asynchronous ask polls only its fixed run and returns final answers", async () => {
  const calls = [];
  const replies = [json({ request_id: id, job_status: "queued", poll_url: "http://evil.internal/" }, 202), json({ request_id: id, job_status: "running" }), json(completed())];
  const client = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async (url, init) => { calls.push([url.pathname, init.method]); return replies.shift(); } });
  const result = await client.ask({ question: "test", provider: "deepseek" });
  assert.deepEqual(calls, [["/ask", "POST"], [`/runs/${id}`, "GET"], [`/runs/${id}`, "GET"]]);
  assert.equal(result.results[0].answer, row.answer);
  assert.equal(result.integrity.upstreamRequestId, id);
});

test("accepted jobs whose poll fails are never classified as free to resubmit", async () => {
  let posts = 0;
  const client = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async (_url, init) => {
    if (init.method === "POST") { posts++; return json({ request_id: id }, 202); }
    return json({}, 404);
  } });
  await assert.rejects(client.ask({ question: "test" }), (error) => {
    assert.equal(error.code, "geo_probe_result_unavailable");
    assert.equal(GEO_UNDELIVERED_FAILURE_CODES.includes(error.code), false);
    return true;
  });
  assert.equal(posts, 1);
});

test("a mismatched completed job and a continued-chat ask are rejected", async () => {
  let calls = 0;
  const client = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async () => ++calls === 1 ? json({ request_id: id }, 202) : json({ ...completed(), request_id: "a".repeat(32) }) });
  await assert.rejects(client.ask({ question: "test", newChat: 0 }), { code: "geo_probe_flag_invalid" });
  assert.equal(calls, 0);
  await assert.rejects(client.ask({ question: "test" }), { code: "geo_probe_result_unavailable" });
});

test("inclusion fallbacks cannot enter consumer-answer denominators", async () => {
  let calls = 0;
  const client = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async () => ++calls === 1 ? json({ request_id: id }, 202) : json(completed([{ ...row, source: "geo_fallback" }])) });
  const result = await client.ask({ question: "test" });
  assert.equal(result.results[0].inDenominator, false);
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].answer, "");
});

test("external screenshots are observed opaque references, use a public pinned transport and no signing key", async () => {
  const imageUrl = "https://bucket.oss-cn-shanghai.aliyuncs.com/monitor-screenshots/test.png";
  let calls = 0;
  const downloads = [];
  const client = probeUpstream({ ...config, geoProbeSigningSecret: "test-secret" }, { pollIntervalMs: 1,
    fetchImpl: async () => ++calls === 1 ? json({ request_id: id }, 202) : json(completed([{ ...row, screenshot_url: imageUrl }])),
    screenshotTransport: async (request) => { downloads.push(request); return { status: 200, headers: { "content-type": "image/png" }, body: Buffer.from("image") }; },
  });
  const result = await client.ask({ question: "test" });
  const name = result.results[0].screenshotName;
  assert.match(name, /^remote-[a-f0-9]+\.png$/);
  const image = await client.screenshot({ name });
  assert.equal(image.bytes.toString(), "image");
  assert.equal(downloads[0].url.href, imageUrl);
  assert.deepEqual(Object.keys(downloads[0].headers), ["accept"]);
  await assert.rejects(client.screenshot({ name: "remote-unknown.png" }), { code: "geo_probe_screenshot_expired" });
});

for (const mismatch of [{ request_id: "a".repeat(32) }, { deep: 1 }, { new_chat: 0 }, { question: "foreign" }, { provider: "kimi" }]) {
  test(`accepted results reject row contamination without allowing resubmission: ${JSON.stringify(mismatch)}`, async () => {
    let posts = 0;
    const client = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async (_url, init) => {
      if (init.method === "POST") { posts++; return json({ request_id: id }, 202); }
      return json(completed([{ ...row, ...mismatch }]));
    } });
    await assert.rejects(client.ask({ question: "test" }), { code: "geo_probe_result_unavailable" });
    assert.equal(posts, 1);
  });
}

test("an accepted task obeys cancellation and never re-posts", async () => {
  const controller = new AbortController();
  let posts = 0;
  const client = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async (_url, init) => {
    if (init.method === "POST") { posts++; return json({ request_id: id }, 202); }
    controller.abort();
    return json({ request_id: id, job_status: "running" });
  } });
  await assert.rejects(client.ask({ question: "test", signal: controller.signal }), { code: "geo_probe_result_unavailable" });
  assert.equal(posts, 1);
});

for (const response of [new Response("invalid", { status: 202 }), new Response("{}", { status: 202, headers: { "content-length": String(9 * 1024 * 1024) } })]) {
  test("an unreadable acceptance cannot be retried as a new ask", async () => {
    let posts = 0;
    const client = probeUpstream(config, { fetchImpl: async () => { posts++; return response; } });
    await assert.rejects(client.ask({ question: "test" }), { code: "geo_probe_result_unavailable" });
    assert.equal(posts, 1);
  });
}

for (const malformed of [null, 3, "answer", []]) {
  test(`an accepted malformed result row cannot trigger automatic resubmission: ${JSON.stringify(malformed)}`, async () => {
    let posts = 0;
    const client = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async (_url, init) => {
      if (init.method === "POST") { posts++; return json({ request_id: id }, 202); }
      return json(completed([malformed]));
    } });
    await assert.rejects(client.ask({ question: "test" }), { code: "geo_probe_result_unavailable" });
    assert.equal(posts, 1);
  });
}

test("a queue-owned deadline is preserved across submission and polling", async () => {
  const signal = AbortSignal.timeout(360_000);
  let calls = 0;
  const client = probeUpstream({ ...config, geoProbeTimeoutMs: 150_000 }, { pollIntervalMs: 1, fetchImpl: async (_url, init) => {
    assert.equal(init.signal, signal);
    return ++calls === 1 ? json({ request_id: id }, 202) : json(completed());
  } });
  assert.equal((await client.ask({ question: "test", signal })).results[0].inDenominator, true);
});

for (const malformed of [{ answer: { toString: null } }, { status: { toString: null } }, { latency_ms: { toString: null } }, { search_results: [{ title: { toString: null } }] }]) {
  test(`accepted field normalization failures never permit automatic resubmission: ${JSON.stringify(malformed)}`, async () => {
    let posts = 0;
    const client = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async (_url, init) => {
      if (init.method === "POST") { posts++; return json({ request_id: id }, 202); }
      return json(completed([{ ...row, ...malformed }]));
    } });
    await assert.rejects(client.ask({ question: "test" }), { code: "geo_probe_result_unavailable" });
    assert.equal(posts, 1);
  });
}
