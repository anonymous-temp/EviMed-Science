import assert from "node:assert/strict";
import test from "node:test";
import { createGeoProbeGatewayHandler, probeUpstream, GEO_PROBE_POLL_TRANSIENT_CODES, GEO_PROBE_TASK_OUTCOMES, GEO_UNDELIVERED_FAILURE_CODES } from "../src/geoProbeGateway.mjs";
import { countProbeTask } from "../src/geoProbeQueue.mjs";
import { geoMetricFamilies } from "../src/geoService.mjs";

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

// ──────────────────────────── a task that outlives the deadline is pending, not lost ────────────────────────────
//
// A five-engine task measured 487 s against the runtime tool's 150 s. The host had taken the task and the ask was paid for; the old
// answer was an error with no id, so the run got nothing and the question was asked again. Acceptance is now a fact of its own.

test("a task still running at the deadline is pending with its id, recorded first, and never posted twice", async () => {
  const accepted = [];
  let posts = 0;
  let reads = 0;
  const client = probeUpstream({ ...config }, { pollIntervalMs: 5, fetchImpl: async (_url, init) => {
    if (init.method === "POST") { posts++; return json({ request_id: id, job_status: "queued" }, 202); }
    reads++;
    return json({ request_id: id, job_status: "running" });
  } });
  await assert.rejects(client.ask({ question: "test", provider: "deepseek", signal: AbortSignal.timeout(120), onAccepted: (task) => { accepted.push(task.requestId); assert.equal(reads, 0, "recorded before anything is read"); } }), (error) => {
    assert.equal(error.code, "geo_probe_result_pending");
    assert.equal(error.status, 202);
    assert.equal(error.requestId, id);
    assert.equal(GEO_UNDELIVERED_FAILURE_CODES.includes(error.code), false);
    return true;
  });
  assert.deepEqual(accepted, [id]);
  assert.equal(posts, 1);
  assert.ok(reads >= 1);
});

test("three unreachable reads of an accepted task leave it pending, because the host did not lose it", async () => {
  let posts = 0;
  const client = probeUpstream({ ...config }, { pollIntervalMs: 1, fetchImpl: async (_url, init) => {
    if (init.method === "POST") { posts++; return json({ request_id: id }, 202); }
    return json({}, 503);
  } });
  await assert.rejects(client.ask({ question: "test" }), { code: "geo_probe_result_pending", requestId: id });
  assert.equal(posts, 1);
});

test("read() reads an accepted task once without waiting: pending while it runs, the answers when it is done", async () => {
  const states = [json({ request_id: id, job_status: "running" }), json(completed())];
  const calls = [];
  const client = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async (url, init) => { calls.push([url.pathname, init.method]); return states.shift(); } });
  const ask = { requestId: id, question: "test", providers: ["deepseek"], deep: 0, newChat: 1 };
  assert.deepEqual(await client.read(ask), { pending: true, requestId: id, jobStatus: "running" });
  const finished = await client.read(ask);
  assert.equal(finished.results[0].answer, row.answer);
  assert.equal(finished.integrity.upstreamRequestId, id);
  assert.deepEqual(calls, [[`/runs/${id}`, "GET"], [`/runs/${id}`, "GET"]], "reads only: nothing is posted");
});

test("read() holds a reply to the ask it checks: another ask's answer is an unreadable task, never an answer", async () => {
  const client = probeUpstream(config, { fetchImpl: async () => json(completed([{ ...row, question: "foreign" }])) });
  await assert.rejects(client.read({ requestId: id, question: "test", providers: ["deepseek"] }), { code: "geo_probe_result_unavailable", requestId: id });
  await assert.rejects(client.read({ requestId: "not-an-id", question: "test" }), { code: "geo_probe_request_id_invalid" });
});

test("a read that cannot reach the host throws the transient code the caller holds the task on; a host with no such task is final", async () => {
  const ask = { requestId: id, question: "test", providers: ["deepseek"] };
  const down = probeUpstream(config, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(down.read(ask), (error) => GEO_PROBE_POLL_TRANSIENT_CODES.includes(error.code));
  const lost = probeUpstream(config, { fetchImpl: async () => json({}, 404) });
  await assert.rejects(lost.read(ask), { code: "geo_probe_result_unavailable" });
});

test("a 200 that carries a job is an acceptance, not a synchronous answer (and a finished one inside it needs no poll)", async () => {
  const calls = [];
  const queued = probeUpstream(config, { pollIntervalMs: 1, fetchImpl: async (url, init) => {
    calls.push(init.method);
    return init.method === "POST" ? json({ request_id: id, job_status: "queued" }) : json(completed());
  } });
  const result = await queued.ask({ question: "test" });
  assert.equal(result.integrity.upstreamRequestId, id);
  assert.deepEqual(calls, ["POST", "GET"]);
  const finished = probeUpstream(config, { fetchImpl: async (_url, init) => {
    assert.equal(init.method, "POST", "the job is already finished: nothing is read");
    return json(completed());
  } });
  assert.equal((await finished.ask({ question: "test" })).results[0].answer, row.answer);
  // A legacy synchronous answer carries no job and is still read as one.
  const legacy = probeUpstream(config, { fetchImpl: async () => json({ results: [{ provider: "deepseek", status: "ok", answer: "sync" }] }) });
  assert.equal((await legacy.ask({ question: "test" })).results[0].answer, "sync");
});

test("submit() returns the accepted task for the caller to hold instead of waiting for it", async () => {
  const seen = [];
  let reads = 0;
  const client = probeUpstream(config, { fetchImpl: async (_url, init) => {
    if (init.method === "GET") reads++;
    return json({ request_id: id, job_status: "queued" }, 202);
  } });
  assert.deepEqual(await client.submit({ question: "test", provider: "kimi", onAccepted: (task) => seen.push(task) }), { pending: true, requestId: id, jobStatus: "queued" });
  assert.equal(reads, 0);
  assert.deepEqual(seen, [{ requestId: id, question: "test", providers: ["kimi"], deep: 0, newChat: 1 }]);
  // If recording the task fails, the ask ends there, and as an accepted task whose result cannot be established.
  await assert.rejects(client.submit({ question: "test", onAccepted: () => { throw Object.assign(new Error("not recorded"), { code: "geo_probe_result_unavailable" }); } }), { code: "geo_probe_result_unavailable" });
});

test("task outcomes are counted once each: accepted, then how the task ended", async () => {
  const outcomes = [];
  const run = async (reply) => {
    outcomes.length = 0;
    const client = probeUpstream(config, { pollIntervalMs: 1, onTask: (outcome) => outcomes.push(outcome), fetchImpl: async (_url, init) => (init.method === "POST" ? json({ request_id: id }, 202) : reply()) });
    await client.ask({ question: "test" }).catch(() => {});
    return [...outcomes];
  };
  assert.deepEqual(await run(() => json(completed())), ["accepted", "completed"]);
  assert.deepEqual(await run(() => json({ ...completed(), job_status: "partial" })), ["accepted", "partial"]);
  assert.deepEqual(await run(() => json({ ...completed([{ ...row, status: "failed", error: "no tab" }]), job_status: "failed" })), ["accepted", "failed"]);
  assert.deepEqual(await run(() => json({}, 404)), ["accepted", "accepted_result_unavailable"]);
  assert.deepEqual(await run(() => json(completed([{ ...row, question: "foreign" }]))), ["accepted", "accepted_result_unavailable"]);
  // A counter that throws never fails a probe.
  const client = probeUpstream(config, { pollIntervalMs: 1, onTask: () => { throw new Error("counter broke"); }, fetchImpl: async (_url, init) => (init.method === "POST" ? json({ request_id: id }, 202) : json(completed())) });
  assert.equal((await client.ask({ question: "test" })).results[0].answer, row.answer);
});

// ──────────────────────────── the gateway: pending, and reading by id ────────────────────────────

const TOKENS = { "token-alice": { userId: "alice", projectId: "p-1" }, "token-alice-2": { userId: "alice", projectId: "p-2" }, "token-bob": { userId: "bob", projectId: "p-1" } };
const runtimeManager = { assertActiveModelGatewayToken(token) { if (!TOKENS[token]) throw new Error("no such token"); return TOKENS[token]; } };
const moduleOn = { geoEnabled: true, geoProbeUrl: "http://probe.internal:9999", geoProbeTimeoutMs: 1_000, geoProbeCallsPerMinute: 100 };
const geo = { service: { allows: () => true } };

/** A request ledger in memory with the contract of `GeoProbeRequests`. */
function memoryLedger() {
  /** @type {Map<string, any>} */
  const saved = new Map();
  return {
    saved,
    failWith: /** @type {Error | null} */ (null),
    async record(task) { if (this.failWith) throw this.failWith; saved.set(task.requestId, { ...task, acceptedAt: "2026-10-28T01:00:00.000Z" }); },
    async lookup({ requestId, userId, projectId }) {
      const task = saved.get(requestId);
      return task && task.userId === userId && task.projectId === projectId ? task : null;
    },
  };
}

async function call(handler, body, token = "token-alice") {
  const payload = JSON.stringify(body);
  const stream = (async function* () { yield Buffer.from(payload); })();
  const req = { method: "POST", url: "/internal/geo-probe/v1", headers: { authorization: `Bearer ${token}` }, [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator]() };
  const chunks = [];
  const res = { statusCode: 0, writableEnded: false, writeHead(status) { this.statusCode = status; }, end(chunk) { if (chunk) chunks.push(chunk); this.writableEnded = true; } };
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}

test("an ask that outlives the gateway deadline is 202 pending with the task's id, recorded for this project, and not an error", async () => {
  const ledger = memoryLedger();
  const outcomes = [];
  const posts = [];
  const handler = createGeoProbeGatewayHandler(moduleOn, runtimeManager, { pollIntervalMs: 20, geo, requests: ledger, onProbeTask: (outcome) => outcomes.push(outcome), fetchImpl: async (url, init) => {
    if (init.method === "POST") { posts.push(url.pathname); return json({ request_id: id, job_status: "queued" }, 202); }
    return json({ request_id: id, job_status: "running" });
  } });
  const asked = await call(handler, { op: "ask", question: "test", providers: ["deepseek", "kimi"] });
  assert.equal(asked.status, 202);
  assert.equal(asked.body.measurement, "pending");
  assert.deepEqual({ ...asked.body.data, acceptedAt: undefined }, { status: "pending", requestId: id, question: "test", providers: ["deepseek", "kimi"], acceptedAt: undefined });
  assert.match(asked.body.warnings.join(" "), /second charge/);
  assert.equal(asked.body.error, undefined);
  assert.deepEqual(posts, ["/ask"]);
  assert.deepEqual([...ledger.saved.values()].map((task) => [task.requestId, task.userId, task.projectId, task.question, task.providers, task.deep, task.newChat]),
    [[id, "alice", "p-1", "test", ["deepseek", "kimi"], 0, 1]]);
  assert.deepEqual(outcomes, ["accepted", "pending"]);
});

test("op=result reads the recorded task: still pending, then the answers, with no second post; another project or account finds nothing", async () => {
  const ledger = memoryLedger();
  let finished = false;
  const seen = [];
  const handler = createGeoProbeGatewayHandler(moduleOn, runtimeManager, { pollIntervalMs: 20, geo, requests: ledger, fetchImpl: async (url, init) => {
    seen.push(`${init.method} ${url.pathname}`);
    if (init.method === "POST") return json({ request_id: id, job_status: "queued" }, 202);
    return json(finished ? completed() : { request_id: id, job_status: "running" });
  } });
  await call(handler, { op: "ask", question: "test", providers: ["deepseek"] });
  seen.length = 0;

  const waiting = await call(handler, { op: "result", requestId: id });
  assert.equal(waiting.status, 202);
  assert.equal(waiting.body.data.status, "pending");
  finished = true;
  const done = await call(handler, { op: "result", requestId: id.toUpperCase() });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.results[0].answer, row.answer);
  assert.equal(done.body.measurement, "ok");
  assert.equal(done.body.integrity.upstreamRequestId, id);
  assert.ok(seen.every((entry) => entry === `GET /runs/${id}`), `only the task is read: ${seen.join(", ")}`);

  for (const token of ["token-alice-2", "token-bob"]) {
    seen.length = 0;
    const refused = await call(handler, { op: "result", requestId: id }, token);
    assert.equal(refused.status, 404, token);
    assert.equal(refused.body.code, "geo_probe_request_unknown");
    assert.equal(refused.body.measurement, "failed");
    assert.deepEqual(seen, [], "the host is not asked about a task this project never had accepted");
  }
  assert.equal((await call(handler, { op: "result", requestId: "f".repeat(32) })).body.code, "geo_probe_request_unknown");
  assert.equal((await call(handler, { op: "result", requestId: "nope" })).body.code, "geo_probe_request_id_invalid");
});

test("an ask that outlives the deadline without a record to read it by is an unreadable task, never a silent pending", async () => {
  const ledger = memoryLedger();
  ledger.failWith = new Error("database down");
  const fetchImpl = async (/** @type {URL} */ _url, /** @type {RequestInit} */ init) => (init.method === "POST" ? json({ request_id: id }, 202) : json({ request_id: id, job_status: "running" }));
  const failed = await call(createGeoProbeGatewayHandler(moduleOn, runtimeManager, { pollIntervalMs: 20, geo, requests: ledger, fetchImpl }), { op: "ask", question: "test" });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, "geo_probe_result_unavailable");
  assert.equal(failed.body.measurement, "failed");
  const without = await call(createGeoProbeGatewayHandler(moduleOn, runtimeManager, { pollIntervalMs: 20, geo, fetchImpl }), { op: "ask", question: "test" });
  assert.equal(without.body.code, "geo_probe_result_unavailable");
});

test("an ask that finishes inside the deadline answers 200 as before, and its task is on record anyway", async () => {
  const ledger = memoryLedger();
  const handler = createGeoProbeGatewayHandler(moduleOn, runtimeManager, { pollIntervalMs: 20, geo, requests: ledger, fetchImpl: async (_url, init) => (init.method === "POST" ? json({ request_id: id }, 202) : json(completed())) });
  const answered = await call(handler, { op: "ask", question: "test", providers: ["deepseek"] });
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body.data.inDenominator, ["deepseek"]);
  assert.equal(ledger.saved.size, 1, "a reply lost on the way back can still be read by its id");
});

test("a row from the paid third-party fallback is told not to be retried, and is not an ordinary failed probe", async () => {
  const handler = createGeoProbeGatewayHandler(moduleOn, runtimeManager, { pollIntervalMs: 20, geo, requests: memoryLedger(),
    fetchImpl: async (_url, init) => (init.method === "POST" ? json({ request_id: id }, 202) : json(completed([{ ...row, source: "geo_fallback" }]))) });
  const answered = await call(handler, { op: "ask", question: "test", providers: ["deepseek"] });
  assert.equal(answered.body.measurement, "failed");
  assert.equal(answered.body.data.results[0].error, "consumer_answer_unavailable");
  const text = answered.body.warnings.join(" ");
  assert.match(text, /do not ask that engine again/);
  assert.doesNotMatch(text, /must be retried/);
});

// ──────────────────────────── screenshots named by an address other than the one the host is reached at ────────────────────────────

/** Ask once against a host that answers with this screenshot reference; returns the answer, the names served and the downloads. */
async function askWithScreenshot(reference, hostConfig = config) {
  const downloaded = [];
  const fetched = [];
  const client = probeUpstream(hostConfig, { pollIntervalMs: 1,
    fetchImpl: async (url, init) => {
      if (init.method === "POST") return json({ request_id: id }, 202);
      if (url.pathname.startsWith("/screenshots/")) { fetched.push(url.href); return new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/png" } }); }
      return json(completed([{ ...row, screenshot_url: reference }]));
    },
    screenshotTransport: async (request) => { downloaded.push(request.url.href); return { status: 200, headers: { "content-type": "image/png" }, body: Buffer.from("image") }; } });
  const result = await client.ask({ question: "test" });
  const answer = result.results[0];
  const image = answer.screenshotName ? await client.screenshot({ name: answer.screenshotName }) : null;
  return { answer, image, downloaded, fetched };
}

test("a pre-signed screenshot URL is named by its path, not by its query string", async () => {
  const href = "https://bucket.oss-cn-shanghai.aliyuncs.com/monitor-screenshots/test.png?Expires=1790000000&OSSAccessKeyId=public&Signature=abc%2Fdef";
  const { answer, image, downloaded } = await askWithScreenshot(href);
  assert.match(answer.screenshotName, /^remote-[a-f0-9]{64}\.png$/);
  assert.equal(answer.warnings, undefined);
  assert.equal(image.bytes.toString(), "image");
  assert.deepEqual(downloaded, [href], "the whole signed address is what is fetched, over the pinned public transport");
});

test("a host that names its own screenshot by another address (no port, bind address, loopback) is read by name on the configured origin", async () => {
  for (const reference of ["http://probe.internal/screenshots/x.png", "http://0.0.0.0:9999/screenshots/x.png", "http://127.0.0.1:8000/screenshots/x.png?v=2",
    "http://10.1.2.3:9999/screenshots/x.png", "/screenshots/x.png", "screenshots/x.png"]) {
    const { answer, image, downloaded, fetched } = await askWithScreenshot(reference);
    assert.equal(answer.screenshotName, "x.png", reference);
    assert.equal(answer.warnings, undefined, reference);
    assert.equal(image.bytes.toString(), "image");
    assert.deepEqual(fetched, ["http://probe.internal:9999/screenshots/x.png"], `${reference}: only the configured origin is asked`);
    assert.deepEqual(downloaded, []);
  }
});

test("a screenshot reference that cannot be served is said, not dropped in silence", async () => {
  const cases = [
    ["http://evil.example.com/screenshots/x.png", "screenshot_unavailable:foreign_origin"],
    ["https://bucket.example.com/dir/", "screenshot_unavailable:name_invalid"],
    ["https://bucket.example.com/%2e%2e/a%20b.png", "screenshot_unavailable:name_invalid"],
  ];
  for (const [reference, warning] of cases) {
    const { answer, downloaded, fetched } = await askWithScreenshot(reference);
    assert.equal(answer.screenshotName, null, reference);
    assert.deepEqual(answer.warnings, [warning], reference);
    assert.deepEqual([downloaded, fetched], [[], []], `${reference}: nothing is requested`);
  }
  // An answer with no screenshot at all carries no warning.
  const none = await askWithScreenshot("");
  assert.equal(none.answer.screenshotName, null);
  assert.equal(none.answer.warnings, undefined);
});

// ──────────────────────────── the metrics ────────────────────────────

test("open_science_geo_probe_tasks_total lists every outcome, zero where nothing happened", () => {
  const state = { probeTotals: {} };
  countProbeTask(state, "accepted");
  countProbeTask(state, "accepted");
  countProbeTask(state, "pending");
  countProbeTask(undefined, "accepted");
  countProbeTask({}, "accepted");
  const family = geoMetricFamilies(true, { tables: null, service: {}, social: null, worker: null, probeTasks: state.probeTotals })
    .find((entry) => entry.name === "open_science_geo_probe_tasks_total");
  assert.equal(family?.type, "counter");
  assert.deepEqual(family?.series.map((series) => series.labels?.outcome), [...GEO_PROBE_TASK_OUTCOMES]);
  assert.deepEqual(Object.fromEntries((family?.series ?? []).map((series) => [series.labels?.outcome, series.value])),
    { accepted: 2, completed: 0, partial: 0, failed: 0, pending: 1, accepted_result_unavailable: 0, resubmit_prevented: 0, capacity_wait: 0 });
  assert.equal(geoMetricFamilies(true, { tables: null, service: {}, social: null, worker: null, probeTasks: null }).some((entry) => entry.name === "open_science_geo_probe_tasks_total"), false);
  assert.deepEqual([...GEO_PROBE_TASK_OUTCOMES], ["accepted", "completed", "partial", "failed", "pending", "accepted_result_unavailable", "resubmit_prevented", "capacity_wait"]);
});
