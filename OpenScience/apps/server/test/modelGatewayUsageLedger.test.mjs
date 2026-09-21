import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { callModelForControlPlane, createModelGatewayHandler, issueModelGatewayBudgetMarker } from "../src/modelGateway.mjs";

const signingSecret = "test-only-model-gateway-signing-secret-32-bytes";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

function manager() {
  return { assertActiveModelGatewayToken: () => ({ userId: "usage-owner", projectId: "default" }) };
}

function config(baseUrl) {
  return {
    deepseekApiKey: "test-provider-key",
    deepseekBaseUrl: baseUrl,
    deepseekModel: "deepseek-v4-flash",
    modelGatewayMaxBodyBytes: 64 * 1024,
    modelGatewayMaxResponseBytes: 1024 * 1024,
    modelGatewayTimeoutMs: 2_000,
    modelGatewayReservationMaxOutputTokens: 4096,
    userDailySpendLimit: 2,
    userWeeklySpendLimit: 5,
    modelGatewaySigningSecret: signingSecret,
  };
}

function ledger(events, { reject = false } = {}) {
  return {
    async reserveModel(input) {
      events.push({ type: "reserve", input });
      if (reject) throw Object.assign(new Error("budget"), { status: 402, code: "usage_budget_exceeded" });
      return { id: input.id };
    },
    async settleModel(userId, id, input) { events.push({ type: "settle", userId, id, input }); },
    async markUncertain(userId, id, code, input) { events.push({ type: "uncertain", userId, id, code, input }); },
    async release(userId, id, code) { events.push({ type: "release", userId, id, code }); },
  };
}

async function call(t, upstreamHandler, usageLedger, requestBody, runtimeManager = manager(), signal = undefined) {
  const upstream = createServer(upstreamHandler);
  const upstreamBase = await listen(upstream);
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const gateway = createServer(createModelGatewayHandler(config(upstreamBase), runtimeManager, { usageLedger }));
  const gatewayBase = await listen(gateway);
  t.after(() => new Promise((resolve) => { gateway.closeAllConnections(); gateway.close(resolve); }));
  return fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime", "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    signal,
  });
}

test("the gateway reserves before dispatch, requests provider usage and settles exact counts", async (t) => {
  const events = [];
  let upstreamBody;
  const response = await call(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    events.push({ type: "upstream" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"id":"provider-one","choices":[],"usage":{"prompt_tokens":34,"completion_tokens":21,"prompt_cache_hit_tokens":11,"prompt_cache_miss_tokens":23}}\n\ndata: [DONE]\n\n');
  }, ledger(events), { messages: [{ role: "user", content: "Count this." }], stream: true });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(events.map((event) => event.type), ["reserve", "upstream", "settle"]);
  assert.equal(upstreamBody.stream_options.include_usage, true);
  assert.equal(upstreamBody.max_completion_tokens, 4096);
  assert.equal(events[0].input.priceVersion, "evimed-reference-2026-09-10");
  assert.equal(events[0].input.dailyLimit, 2);
  assert.ok(events[0].input.estimatedCost > 0);
  assert.deepEqual(events[2].input.usage, { cacheHitTokens: 11, cacheMissTokens: 23, completionTokens: 21 });
  assert.equal(events[2].input.providerRequestId, "provider-one");
  assert.ok(events[2].input.actualCost > 0);
});

test("successful provider responses without usage remain reserved for reconciliation", async (t) => {
  const events = [];
  const response = await call(t, async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"provider-missing","choices":[]}');
  }, ledger(events), { messages: [{ role: "user", content: "Missing usage." }] });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(events.map((event) => event.type), ["reserve", "uncertain"]);
  assert.equal(events[1].code, "response_usage_missing");
  assert.equal(events[1].input.providerRequestId, "provider-missing");
});

test("provider refusal releases the reservation and budget refusal never calls upstream", async (t) => {
  const events = [];
  const refused = await call(t, async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(429, { "content-type": "application/json" });
    res.end('{"error":"rate limited"}');
  }, ledger(events), { messages: [{ role: "user", content: "Provider refuses." }] });
  assert.equal(refused.status, 429);
  assert.deepEqual(events.map((event) => event.type), ["reserve", "release"]);

  let upstreamCalls = 0;
  const deniedEvents = [];
  const denied = await call(t, async (_req, res) => { upstreamCalls++; res.end(); }, ledger(deniedEvents, { reject: true }), {
    messages: [{ role: "user", content: "Over budget." }],
  });
  assert.equal(denied.status, 402);
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(deniedEvents.map((event) => event.type), ["reserve"]);
});

test("an ambiguous connection loss after dispatch stays uncertain for reconciliation", async (t) => {
  const events = [];
  const response = await call(t, async (req) => {
    for await (const _chunk of req) { /* consume before losing the connection */ }
    req.socket.destroy();
  }, ledger(events), { messages: [{ role: "user", content: "Connection outcome is unknown." }] });
  assert.equal(response.status, 502);
  assert.deepEqual(events.map((event) => event.type), ["reserve", "uncertain"]);
  assert.equal(events[1].code, "provider_response_incomplete");
});

const USAGE_FRAME = 'data: {"id":"provider-late","choices":[],"usage":{"prompt_tokens":40,"completion_tokens":5,"prompt_cache_hit_tokens":32,"prompt_cache_miss_tokens":8}}\n\n';

/**
 * Read a gateway stream the way the kernel does (`parseSse` in
 * dsh-llm-deepseek): up to `stopAt`, then drop the connection at once.
 * @param {Response} response @param {AbortController} controller @param {string} stopAt
 */
async function readLikeTheKernel(response, controller, stopAt) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text, ended: true };
    text += decoder.decode(value, { stream: true });
    if (text.includes(stopAt)) {
      controller.abort();
      await reader.cancel().catch(() => {});
      return { text, ended: false };
    }
  }
}

test("an answer the kernel read to [DONE] is settled however late the provider closes its body", async (t) => {
  // 2026-09-21: about 3% of calls — more at peak hours — were booked
  // `uncertain` at their reserved cost although the whole answer and its usage
  // frame had reached the kernel. The kernel stops at `[DONE]` and drops the
  // connection; the gateway was still waiting for the provider to close.
  const events = [];
  let providerClosed = null;
  const controller = new AbortController();
  const response = await call(t, async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"provider-late","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n');
    res.write(`${USAGE_FRAME}data: [DONE]\n\n`);
    // The body's end arrives in a later packet, after the kernel has gone.
    setTimeout(() => { providerClosed = Date.now(); res.end(); }, 400);
  }, ledger(events), { messages: [{ role: "user", content: "Answer briefly." }], stream: true }, manager(), controller.signal);
  assert.equal(response.status, 200);
  const read = await readLikeTheKernel(response, controller, "data: [DONE]\n\n");
  assert.ok(read.text.includes('"usage"'));
  await waitFor(() => events.some((event) => event.type !== "reserve"));
  assert.deepEqual(events.map((event) => event.type), ["reserve", "settle"]);
  assert.deepEqual(events[1].input.usage, { cacheHitTokens: 32, cacheMissTokens: 8, completionTokens: 5 });
  assert.equal(events[1].input.providerRequestId, "provider-late");
  assert.ok(providerClosed !== null, "the rest of the provider's body was read, so its connection can be reused");
});

test("a reader that waits for the end of the stream gets it at [DONE], not at the provider's close", async (t) => {
  const events = [];
  let providerClosedAt = null;
  const response = await call(t, async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`${USAGE_FRAME}data: [DONE]\n\n`);
    setTimeout(() => { providerClosedAt = Date.now(); res.end(); }, 600);
  }, ledger(events), { messages: [{ role: "user", content: "Answer briefly." }], stream: true });
  const text = await response.text();
  const endedAt = Date.now();
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  assert.equal(providerClosedAt, null, "the answer ended before the provider closed its body");
  await waitFor(() => events.some((event) => event.type === "settle"));
  assert.ok(Date.now() >= endedAt);
});

test("a caller that leaves after the usage frame leaves a settled call; one that leaves before it, an uncertain one", async (t) => {
  for (const [label, stopAt, expected] of [
    ["after usage, before [DONE]", '"usage"', "settle"],
    ["mid-answer, before usage", '"content":"part"', "uncertain"],
  ]) {
    const events = [];
    const controller = new AbortController();
    const response = await call(t, async (req, res) => {
      for await (const _chunk of req) { /* consume */ }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"provider-late","choices":[{"index":0,"delta":{"content":"part"}}]}\n\n');
      setTimeout(() => {
        if (res.destroyed) return;
        res.write(USAGE_FRAME);
        setTimeout(() => { if (!res.destroyed) res.end("data: [DONE]\n\n"); }, 300);
      }, 150);
    }, ledger(events), { messages: [{ role: "user", content: "Answer." }], stream: true }, manager(), controller.signal);
    await readLikeTheKernel(response, controller, stopAt);
    await waitFor(() => events.some((event) => event.type !== "reserve"));
    assert.deepEqual(events.map((event) => event.type), ["reserve", expected], label);
    if (expected === "uncertain") assert.equal(events[1].code, "provider_response_incomplete", label);
    else assert.deepEqual(events[1].input.usage, { cacheHitTokens: 32, cacheMissTokens: 8, completionTokens: 5 }, label);
  }
});

/** @param {() => boolean} predicate */
async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the ledger");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a signed session marker attributes only that request and is removed before the provider", async (t) => {
  const events = [];
  let upstreamBody;
  const scopedManager = { assertActiveModelGatewayToken: () => ({ userId: "usage-owner", projectId: "default",
    runId: "run-autopilot", dailyLimit: 11, weeklyLimit: 33, runLimit: 4 }) };
  const marker = issueModelGatewayBudgetMarker({ secret: signingSecret, userId: "usage-owner", projectId: "default",
    runId: "run-autopilot", dailyLimit: 11, weeklyLimit: 33, runLimit: 4 });
  const response = await call(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"provider-scoped","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
  }, ledger(events), { messages: [{ role: "system", content: `Research context\n${marker}` },
    { role: "user", content: "<evimed-autopilot-episode>episode-one</evimed-autopilot-episode>\nRun it." }] }, scopedManager);
  assert.equal(response.status, 200);
  await response.text();
  const reservation = events.find((event) => event.type === "reserve").input;
  assert.equal(reservation.runId, "run-autopilot");
  assert.equal(reservation.runLimit, 4);
  assert.equal(reservation.dailyLimit, 2);
  assert.equal(reservation.weeklyLimit, 5);
  assert.doesNotMatch(JSON.stringify(upstreamBody), /evimed-budget-scope/);
  assert.doesNotMatch(JSON.stringify(upstreamBody), /evimed-autopilot-episode/);

  const ordinary = [];
  const ordinaryResponse = await call(t, async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"provider-ordinary","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
  }, ledger(ordinary), { messages: [{ role: "user", content: "Interactive work." }] });
  assert.equal(ordinaryResponse.status, 200);
  await ordinaryResponse.text();
  assert.equal(ordinary.find((event) => event.type === "reserve").input.runId, null);
});

test("an autopilot intent without its signed budget scope is rejected before reservation", async (t) => {
  const events = [];
  let upstreamCalls = 0;
  const response = await call(t, async (_req, res) => { upstreamCalls += 1; res.end(); }, ledger(events), {
    messages: [{ role: "user", content: "<evimed-autopilot-episode>episode-one</evimed-autopilot-episode>\nRun it." }],
  });
  assert.equal(response.status, 401);
  assert.equal(upstreamCalls, 0);
  assert.equal(events.length, 0);
});

test("an unbounded runtime cannot use an old signed marker to grant itself episode limits", async (t) => {
  const events = [];
  const marker = issueModelGatewayBudgetMarker({ secret: signingSecret, userId: "usage-owner", projectId: "default",
    runId: "old-episode", dailyLimit: 1000, weeklyLimit: 1000, runLimit: 1000 });
  const response = await call(t, async (_req, res) => res.end(), ledger(events), {
    messages: [{ role: "user", content: marker }],
  });
  assert.equal(response.status, 401);
  assert.equal(events.length, 0);
});

test("a bounded runtime token retains episode attribution after markers compact out of history", async (t) => {
  const events = [];
  const scopedManager = { assertActiveModelGatewayToken: () => ({ userId: "usage-owner", projectId: "default",
    runId: "episode-compacted", dailyLimit: 12, weeklyLimit: 40, runLimit: 5 }) };
  const response = await call(t, async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"provider-compacted","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
  }, ledger(events), { messages: [{ role: "user", content: "Summary of an older compacted conversation." }] }, scopedManager);
  assert.equal(response.status, 200);
  await response.text();
  const reservation = events.find((event) => event.type === "reserve").input;
  assert.equal(reservation.runId, "episode-compacted");
  assert.equal(reservation.runLimit, 5);
});

/* --------------------------------------------- run attribution (E §9.4, C3) */

async function callWith(t, { attributeRun = null, runPurpose = null, caller = { userId: "usage-owner", projectId: "default" }, extraConfig = {} } = {}, requestBody) {
  const events = [];
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"provider-x","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":10}}');
  });
  const upstreamBase = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const gateway = createServer(createModelGatewayHandler({ ...config(upstreamBase), ...extraConfig },
    { assertActiveModelGatewayToken: () => caller }, {
      usageLedger: ledger(events), ...(attributeRun ? { attributeRun } : {}), ...(runPurpose ? { runPurpose } : {}),
    }));
  const gatewayBase = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const post = (/** @type {Record<string, string>} */ headers = {}) => fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer runtime", "content-type": "application/json", ...headers }, body: JSON.stringify(requestBody),
  }).then((response) => response.text());
  return { events, post };
}

test("an interactive runtime's call is charged to the one run going in its project, and capped by the per-run limit", async (t) => {
  const asked = [];
  const { events, post } = await callWith(t, {
    attributeRun: async (caller) => { asked.push(caller); return "run_interactive"; },
    extraConfig: { userRunSpendLimit: 3 },
  }, { messages: [{ role: "user", content: "Attribute me." }] });
  await post();
  assert.deepEqual(asked, [{ userId: "usage-owner", projectId: "default", sessionId: null }]);
  assert.equal(events[0].input.runId, "run_interactive");
  assert.equal(events[0].input.runLimit, 3, "the interactive per-run cap applies once the call has a run");
});

test("the conversation the kernel names is what the request is attributed by", async (t) => {
  // The kernel's provider stamps `x-deepseek-harness-session-id` on every model
  // call. Without it the control plane could only ask 「is exactly one run going
  // in this project」, and two conversations in the catch-all default project
  // both read 「约 ¥0.00」 (2026-09-20). It is a hint, not authority: the
  // resolver only ever matches it against the runs of the token's own project.
  const asked = [];
  const { events, post } = await callWith(t, {
    attributeRun: async (caller) => { asked.push(caller); return caller.sessionId === "ses_geo" ? "run_geo" : "run_other"; },
    extraConfig: { userRunSpendLimit: 3 },
  }, { messages: [{ role: "user", content: "Attribute me." }] });
  await post({ "x-deepseek-harness-session-id": "ses_geo" });
  assert.deepEqual(asked, [{ userId: "usage-owner", projectId: "default", sessionId: "ses_geo" }]);
  assert.equal(events[0].input.runId, "run_geo");

  // Nothing usable is nothing: a blank or oversized header is not a session id,
  // and the request falls back to the project rule. (A control character
  // cannot reach here at all — an HTTP client refuses to send one — and the
  // reader rejects it anyway rather than trusting that.)
  for (const value of ["   ", "x".repeat(201)]) {
    asked.length = 0;
    await post({ "x-deepseek-harness-session-id": value });
    assert.deepEqual(asked.at(-1), { userId: "usage-owner", projectId: "default", sessionId: null }, JSON.stringify(value));
  }
});

test("a bounded runtime keeps the run its token names, and an unattributable call carries none", async (t) => {
  const bounded = await callWith(t, {
    caller: { userId: "usage-owner", projectId: "default", runId: "episode-1", runLimit: 1.5, dailyLimit: 2, weeklyLimit: 5 },
    attributeRun: async () => assert.fail("a bounded runtime's run is its own"),
    extraConfig: { userRunSpendLimit: 3 },
  }, { messages: [{ role: "user", content: "Bounded." }] });
  await bounded.post();
  assert.equal(bounded.events[0].input.runId, "episode-1");
  assert.equal(bounded.events[0].input.runLimit, 1.5);
  const ambiguous = await callWith(t, { attributeRun: async () => null, extraConfig: { userRunSpendLimit: 3 } }, { messages: [{ role: "user", content: "Two runs." }] });
  await ambiguous.post();
  assert.equal(ambiguous.events[0].input.runId, null, "two runs at once are not guessed between");
  assert.equal(ambiguous.events[0].input.runLimit, 0);
  const broken = await callWith(t, { attributeRun: async () => { throw new Error("ledger unreadable"); } }, { messages: [{ role: "user", content: "x" }] });
  assert.equal((await broken.post()).length > 0, true, "an attribution failure never costs the call");
  assert.equal(broken.events[0].input.runId, null);
});

/* ------------------------------------------------------- purpose (X1) */

test("a runtime's request is the kernel's unless its run says otherwise, and asking never costs the call", async (t) => {
  // Nothing wired: every runtime request is the kernel working.
  const plain = await callWith(t, {}, { messages: [{ role: "user", content: "Plain." }] });
  await plain.post();
  assert.equal(plain.events[0].input.purpose, "kernel");

  // A bounded runtime is asked about by the run its token names — the dispatch
  // id a source understanding run is launched under.
  const asked = [];
  const bounded = await callWith(t, {
    caller: { userId: "usage-owner", projectId: "default", runId: "dispatch-source-1", runLimit: 3, dailyLimit: 10, weeklyLimit: 50 },
    runPurpose: async (request) => { asked.push(request); return "source-understanding"; },
  }, { messages: [{ role: "user", content: "Understand this source." }] });
  await bounded.post();
  assert.deepEqual(asked, [{ userId: "usage-owner", projectId: "default", runId: "dispatch-source-1" }]);
  assert.equal(bounded.events[0].input.purpose, "source-understanding");

  // An interactive runtime is asked about by the run it was attributed to.
  const interactiveAsked = [];
  const interactive = await callWith(t, {
    attributeRun: async () => "run_interactive",
    runPurpose: async (request) => { interactiveAsked.push(request.runId); return "kernel"; },
  }, { messages: [{ role: "user", content: "Interactive." }] });
  await interactive.post();
  assert.deepEqual(interactiveAsked, ["run_interactive"]);
  assert.equal(interactive.events[0].input.purpose, "kernel");

  const broken = await callWith(t, { runPurpose: async () => { throw new Error("run ledger unreadable"); } },
    { messages: [{ role: "user", content: "x" }] });
  assert.ok((await broken.post()).length > 0, "a purpose lookup failure never costs the call");
  assert.equal(broken.events[0].input.purpose, "kernel");
});

test("a control-plane call reserves under the purpose its caller names, and an unnamed one is left to the ledger", async () => {
  const usage = { prompt_tokens: 20, completion_tokens: 4, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 };
  const fetchImpl = async () => Response.json({ id: "provider-cp", choices: [{ message: { content: "{}" } }], usage });
  for (const [purpose, expected] of [["routing", "routing"], ["memory-extraction", "memory-extraction"], [undefined, undefined]]) {
    const events = [];
    await callModelForControlPlane({ config: config("https://api.deepseek.com"), usageLedger: ledger(events), fetchImpl }, {
      userId: "usage-owner", projectId: "default", ...(purpose ? { purpose } : {}),
      body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "Classify." }] },
    });
    // The ledger turns a missing purpose into `other` (usagePurpose); the
    // gateway passes through what it was given rather than inventing one.
    assert.equal(events[0].input.purpose, expected);
    assert.deepEqual(events.map((event) => event.type), ["reserve", "settle"]);
  }
});

test("a refused control-plane call carries the provider's own status, not only the mapped one", async () => {
  const events = [];
  await assert.rejects(
    callModelForControlPlane({
      config: config("https://api.deepseek.com"), usageLedger: ledger(events),
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    }, { userId: "usage-owner", projectId: "default", purpose: "routing",
      body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "x" }] } }),
    (error) => error.code === "model_gateway_upstream_error" && error.status === 502 && error.upstreamStatus === 503,
  );
  // Reached the provider, so uncertain rather than released (the extraction
  // test "a provider that refuses ..." holds the reason).
  assert.deepEqual(events.map((event) => event.type), ["reserve", "uncertain"]);
});
