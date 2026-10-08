import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { REFERENCE_PRICE_LIST } from "@evimed/domain";
import { callModelForControlPlane, createModelGatewayHandler, estimateModelReservation, issueModelGatewayBudgetMarker, uncertainCallCost } from "../src/modelGateway.mjs";
import { providerRefusalCount } from "../src/providerRefusals.mjs";

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
  assert.equal(events[0].input.priceVersion, REFERENCE_PRICE_LIST.version, "the reservation names the price list in force");
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
  assert.equal(events[1].code, "provider_refused_429", "released under the status the provider refused with");

  let upstreamCalls = 0;
  const deniedEvents = [];
  const denied = await call(t, async (_req, res) => { upstreamCalls++; res.end(); }, ledger(deniedEvents, { reject: true }), {
    messages: [{ role: "user", content: "Over budget." }],
  });
  assert.equal(denied.status, 402);
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(deniedEvents.map((event) => event.type), ["reserve"]);
  // The kernel records this sentence and shows it as it is: it names the limit, not an outage.
  const deniedBody = await denied.json();
  assert.equal(deniedBody.error.code, "usage_budget_exceeded");
  assert.match(deniedBody.error.message, /spending limit of this account refused/);
  assert.doesNotMatch(deniedBody.error.message, /temporarily unavailable/);
  const runDenied = await call(t, async (_req, res) => { res.end(); }, {
    ...ledger([]),
    async reserveModel() { throw Object.assign(new Error("budget"), { status: 402, code: "usage_budget_exceeded", details: { window: "run" } }); },
  }, { messages: [{ role: "user", content: "Over the run's budget." }] });
  assert.equal(runDenied.status, 402);
  assert.match((await runDenied.json()).error.message, /spending limit of this run refused/);
});

test("a refusal before any output is released and a 5xx is uncertain, at the gateway as everywhere", async (t) => {
  // One rule for every metered client (usageLedger.mjs closeUnsettledReservation):
  // a spent balance (402) or a malformed request (400) declined the call in
  // writing; a 5xx may come from an edge while the model kept working.
  for (const [status, expected] of [[402, ["release", "provider_refused_402"]], [400, ["release", "provider_refused_400"]],
    [503, ["uncertain", "provider_response_incomplete"]], [500, ["uncertain", "provider_response_incomplete"]]]) {
    const events = [];
    const response = await call(t, async (req, res) => {
      for await (const _chunk of req) { /* consume */ }
      res.writeHead(status, { "content-type": "application/json" });
      res.end('{"error":{"message":"no"}}');
    }, ledger(events), { messages: [{ role: "user", content: `Provider answers ${status}.` }] });
    await response.text();
    assert.deepEqual(events.map((event) => event.type), ["reserve", expected[0]], String(status));
    assert.equal(events[1].code, expected[1], String(status));
  }
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

test("an uncertain call is bounded by its prompt and the output that streamed past, never held at its whole reservation", async (t) => {
  // The reservation prices every prompt token uncached and the whole output
  // allowance — on production about 70 times what calls settled at. A call
  // lost before its usage frame used to count at all of it in every spend
  // window; it now carries what the gateway saw (usageLedger.mjs OPEN_COST_VALUE).
  const events = [];
  let sent = null;
  const controller = new AbortController();
  const response = await call(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"provider-cut","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n'
      + 'data: {"id":"provider-cut","choices":[{"index":0,"delta":{"content":"part"}}]}\n\n');
    setTimeout(() => { if (!res.destroyed) res.end(`${USAGE_FRAME}data: [DONE]\n\n`); }, 300);
  }, ledger(events), { messages: [{ role: "user", content: "Answer at length." }], stream: true }, manager(), controller.signal);
  await readLikeTheKernel(response, controller, '"content":"part"');
  await waitFor(() => events.some((event) => event.type !== "reserve"));
  assert.deepEqual(events.map((event) => event.type), ["reserve", "uncertain"]);
  const reserve = events[0].input;
  const estimate = estimateModelReservation(sent, config("http://unused"), reserve.now);
  assert.equal(estimate.cost, reserve.estimatedCost, "the estimate below is the reservation's own");
  const bounded = events[1].input.estimatedCost;
  assert.equal(bounded, uncertainCallCost(estimate, reserve.model, reserve.now, 2), "the prompt plus the two events that arrived");
  assert.ok(bounded > 0 && bounded * 100 < reserve.estimatedCost, `${bounded} against a reservation of ${reserve.estimatedCost}`);

  // An error answered before any output produced none: the prompt alone.
  const failed = [];
  let failedBody = null;
  await (await call(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    failedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"error":{"message":"busy"}}');
  }, ledger(failed), { messages: [{ role: "user", content: "Provider is busy." }] })).text();
  assert.deepEqual(failed.map((event) => [event.type, event.code]).slice(1), [["uncertain", "provider_response_incomplete"]]);
  const failedEstimate = estimateModelReservation(failedBody, config("http://unused"), failed[0].input.now);
  assert.equal(failed[1].input.estimatedCost, uncertainCallCost(failedEstimate, failed[0].input.model, failed[0].input.now, 0));

  // Lost before any answer: nothing was seen, so the reservation stands.
  const lost = [];
  await call(t, async (req) => {
    for await (const _chunk of req) { /* consume before losing the connection */ }
    req.socket.destroy();
  }, ledger(lost), { messages: [{ role: "user", content: "Lost." }] });
  assert.deepEqual(lost.map((event) => event.type), ["reserve", "uncertain"]);
  assert.equal(lost[1].input.estimatedCost, null);
});

test("a control-plane call the provider fails before any output is bounded by its prompt; one lost on the way in keeps its reservation", async () => {
  const body = { model: "deepseek-v4-flash", max_tokens: 3_000, messages: [{ role: "user", content: "Screen these twenty entries." }] };
  const at = new Date("2026-09-23T08:00:00.000Z");
  const events = [];
  await assert.rejects(callModelForControlPlane({
    config: config("https://api.deepseek.com"), usageLedger: ledger(events),
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  }, { userId: "usage-owner", projectId: "evimed-frontier", purpose: "frontier", at, body }));
  assert.deepEqual(events.map((event) => [event.type, event.code]).slice(1), [["uncertain", "provider_response_incomplete"]]);
  const estimate = estimateModelReservation({ ...body, stream: false }, config("https://api.deepseek.com"), at);
  assert.equal(events[1].input.estimatedCost, uncertainCallCost(estimate, body.model, at, 0));
  assert.ok(events[1].input.estimatedCost < events[0].input.estimatedCost, "the output allowance it never used is not held");

  // A JSON answer arrives only whole; one cut on the way in may have been
  // generated in full, so nothing below the reservation can be claimed.
  const cut = [];
  await assert.rejects(callModelForControlPlane({
    config: config("https://api.deepseek.com"), usageLedger: ledger(cut),
    fetchImpl: async () => new Response(new ReadableStream({ start(stream) { stream.error(new Error("socket hang up")); } }), { status: 200 }),
  }, { userId: "usage-owner", projectId: "evimed-frontier", purpose: "frontier", at, body }));
  assert.deepEqual(cut.map((event) => [event.type, event.code]).slice(1), [["uncertain", "provider_response_incomplete"]]);
  assert.equal(cut[1].input.estimatedCost, null);
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

test("a user continuing in the chat a conversation a bounded run started is served under the user's own caps", async (t) => {
  // Production, 2026-09-25: a follow-up typed into a GEO step's conversation
  // failed every model call with budget_scope_invalid — the step's marker was
  // still in the history the kernel sends.
  const events = [];
  let upstreamBody;
  const marker = issueModelGatewayBudgetMarker({ secret: signingSecret, userId: "usage-owner", projectId: "default",
    runId: "geo-step", dailyLimit: 1000, weeklyLimit: 1000, runLimit: 1000 });
  const response = await call(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"provider-follow-up","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
  }, ledger(events), { messages: [
    { role: "user", content: `Write this week's batch.\n\n<evimed-autopilot-episode>episode-one</evimed-autopilot-episode>\n${marker}` },
    { role: "assistant", content: "Done: five articles." },
    { role: "user", content: "Now raise the accuracy targets." }] });
  assert.equal(response.status, 200);
  await response.text();
  const reservation = events.find((event) => event.type === "reserve").input;
  assert.equal(reservation.runId, null, "the old run is not charged");
  assert.notEqual(reservation.runLimit, 1000, "and its limits are not taken");
  assert.doesNotMatch(JSON.stringify(upstreamBody), /evimed-budget-scope|evimed-autopilot-episode/);
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

async function callWith(t, { attributeRun = null, runPurpose = null, runScope = null, caller = { userId: "usage-owner", projectId: "default" }, extraConfig = {} } = {}, requestBody) {
  const events = [];
  let upstreamCalls = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"provider-x","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":10}}');
  });
  const upstreamBase = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const gateway = createServer(createModelGatewayHandler({ ...config(upstreamBase), ...extraConfig },
    { assertActiveModelGatewayToken: () => caller }, {
      usageLedger: ledger(events), ...(attributeRun ? { attributeRun } : {}), ...(runPurpose ? { runPurpose } : {}), ...(runScope ? { runScope } : {}),
    }));
  const gatewayBase = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const post = (/** @type {Record<string, string>} */ headers = {}) => fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer runtime", "content-type": "application/json", ...headers }, body: JSON.stringify(requestBody),
  }).then((response) => response.text());
  return { events, post, base: gatewayBase, upstreamCalls: () => upstreamCalls };
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

/* ------------------------------- a scheduled execution in the researcher's runtime (R13, E-20) */

test("a call attributed to a scheduled execution is booked under its episode and held to the episode's limit; any other run is left alone", async (t) => {
  const asked = [];
  const { events, post } = await callWith(t, {
    attributeRun: async ({ sessionId }) => (sessionId === "ses_episode" ? "run_episode" : "run_chat"),
    runScope: async (request) => { asked.push(request); return request.runId === "run_episode" ? { usageRunId: "episode-one", runLimit: 2.5 } : null; },
    extraConfig: { userRunSpendLimit: 3 },
  }, { messages: [{ role: "user", content: "Next step." }] });
  await post({ "x-deepseek-harness-session-id": "ses_episode" });
  assert.deepEqual(asked, [{ userId: "usage-owner", projectId: "default", runId: "run_episode" }], "asked by the run the kernel's session belongs to");
  assert.equal(events[0].input.runId, "episode-one", "booked under the episode, where the task's caps and the episode's cost read it");
  assert.equal(events[0].input.runLimit, 2.5, "against the episode's own limit, not the account's per-run default");

  // The researcher's turn in the same conversation, once the execution is over, is another run with the account's own rule.
  await post({ "x-deepseek-harness-session-id": "ses_chat" });
  assert.equal(events[2].input.runId, "run_chat");
  assert.equal(events[2].input.runLimit, 3);
});

test("a scheduled execution whose limit cannot be read is refused before anything is reserved or sent", async (t) => {
  const refused = await callWith(t, {
    attributeRun: async () => "run_episode",
    runScope: async () => { throw Object.assign(new Error("episode unreadable"), { code: "autopilot_episode_not_found" }); },
  }, { messages: [{ role: "user", content: "Next step." }] });
  const response = await fetch(`${refused.base}/internal/model/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer runtime", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Next step." }] }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "model_gateway_run_scope_unavailable");
  assert.match(body.error.message, /nothing was sent to the provider/);
  assert.equal(refused.events.length, 0, "no reservation");
  assert.equal(refused.upstreamCalls(), 0);
});

test("the scope hook is for an interactive runtime's attributed calls only: a bounded token and an unattributed call never reach it", async (t) => {
  const never = async () => assert.fail("not asked");
  const bounded = await callWith(t, {
    caller: { userId: "usage-owner", projectId: "default", runId: "episode-1", runLimit: 1.5, dailyLimit: 2, weeklyLimit: 5 },
    runScope: never,
  }, { messages: [{ role: "user", content: "Bounded." }] });
  await bounded.post();
  assert.equal(bounded.events[0].input.runLimit, 1.5, "a bounded runtime is capped by its token");
  const unattributed = await callWith(t, { attributeRun: async () => null, runScope: never }, { messages: [{ role: "user", content: "Two runs." }] });
  await unattributed.post();
  assert.equal(unattributed.events[0].input.runId, null);
});

test("the episode tag and signed scope may ride in injected context for a bounded runtime, and an interactive runtime refuses both", async (t) => {
  // A scheduled execution's first message is the researcher's instruction (2026-10-08); the tag and the signed scope are in the run
  // context the socket injects, a user-role message of its own. The gateway finds markers wherever they are for a runtime whose
  // token names the run.
  const marker = issueModelGatewayBudgetMarker({ secret: signingSecret, userId: "usage-owner", projectId: "default",
    runId: "episode-ctx", dailyLimit: 11, weeklyLimit: 33, runLimit: 4 });
  const messages = [
    { role: "user", content: "每周检索 SGLT2 抑制剂的新证据。" },
    { role: "user", content: `<evimed-agenda>…</evimed-agenda>\n\n<evimed-autopilot-episode>episode-ctx</evimed-autopilot-episode>\n${marker}` },
  ];
  let seen = "";
  const upstreamSeen = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"p","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
  };
  const boundedEvents = [];
  const bounded = await call(t, upstreamSeen, ledger(boundedEvents), { messages }, { assertActiveModelGatewayToken: () => ({ userId: "usage-owner", projectId: "default",
    runId: "episode-ctx", dailyLimit: 11, weeklyLimit: 33, runLimit: 4 }) });
  assert.equal(bounded.status, 200);
  await bounded.text();
  assert.equal(boundedEvents.find((event) => event.type === "reserve").input.runLimit, 4);
  assert.doesNotMatch(seen, /evimed-budget-scope|evimed-autopilot-episode/, "stripped before the provider");
  assert.match(seen, /每周检索/, "and the researcher's words are untouched");

  const interactiveEvents = [];
  const interactive = await call(t, upstreamSeen, ledger(interactiveEvents), { messages });
  assert.equal(interactive.status, 401, "an interactive runtime's newest context carrying the tag and a marker is refused: this is why an interactive execution carries neither");
  assert.equal(interactiveEvents.length, 0);
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

test("a control-plane call with its own budget replaces the account caps for that call only", async () => {
  // The frontier feed is charged to an operator's internal project and
  // governed by its own daily budget: the operator's personal caps must not
  // refuse it. Without `limits` the deployment's caps apply as before.
  const usage = { prompt_tokens: 20, completion_tokens: 4, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 };
  const fetchImpl = async () => Response.json({ id: "provider-limits", choices: [{ message: { content: "{}" } }], usage });
  const call = async (extra) => {
    const events = [];
    await callModelForControlPlane({ config: config("https://api.deepseek.com"), usageLedger: ledger(events), fetchImpl }, {
      userId: "usage-owner", projectId: "evimed-frontier", purpose: "frontier", ...extra,
      body: { model: "deepseek-v4-flash", max_tokens: 100, messages: [{ role: "user", content: "Screen." }] },
    });
    return events[0].input;
  };
  const own = await call({ limits: { daily: 0, weekly: 0 } });
  assert.equal(own.dailyLimit, 0);
  assert.equal(own.weeklyLimit, 0);
  assert.equal(own.purpose, "frontier");
  const partial = await call({ limits: { daily: 7 } });
  assert.equal(partial.dailyLimit, 7);
  assert.equal(partial.weeklyLimit, 5, "a limit the call does not name stays the deployment's");
  const unchanged = await call({});
  assert.equal(unchanged.dailyLimit, 2);
  assert.equal(unchanged.weeklyLimit, 5);
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
  // A 5xx reached the provider and may have been worked on: uncertain.
  assert.deepEqual(events.map((event) => event.type), ["reserve", "uncertain"]);
  assert.equal(events[1].code, "provider_response_incomplete");
});

test("a control-plane call the provider refuses outright is released, not held as possibly spent", async () => {
  // Production 2026-09-23: the DeepSeek balance ran out for two hours and every
  // frontier call was answered 402. They were booked uncertain — 569 rows
  // held at their reserved ceilings against the feed's daily budget — for calls
  // the provider had declined before producing a token.
  for (const status of [402, 401, 400, 404, 413, 422, 429]) {
    const events = [];
    await assert.rejects(
      callModelForControlPlane({
        config: config("https://api.deepseek.com"), usageLedger: ledger(events),
        fetchImpl: async () => Response.json({ error: { message: "Insufficient Balance" } }, { status }),
      }, { userId: "usage-owner", projectId: "evimed-frontier", purpose: "frontier", limits: { daily: 0, weekly: 0 },
        body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "Screen." }] } }),
      (error) => error.upstreamStatus === status,
    );
    assert.deepEqual(events.map((event) => event.type), ["reserve", "release"], String(status));
    assert.equal(events[1].code, `provider_refused_${status}`);
  }
  // Never sent at all is released as before.
  const lost = [];
  await assert.rejects(callModelForControlPlane({
    config: config("https://api.deepseek.com"), usageLedger: ledger(lost),
    fetchImpl: async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("Connect refused"), { code: "ECONNREFUSED" }) }); },
  }, { userId: "usage-owner", projectId: "default", body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "x" }] } }));
  assert.deepEqual(lost.map((event) => [event.type, event.code]).slice(1), [["release", "provider_not_accepted"]]);
});

test("an attached image is reserved by its pixels, not by the length of its base64", async (t) => {
  // A composer attachment reaches the provider inline. Read as text, one
  // normalized image was hundreds of thousands of "tokens" and reserved a
  // conversation's worth of spend for a picture.
  const answer = async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"provider-image","choices":[],"usage":{"prompt_tokens":400,"completion_tokens":1}}');
  };
  const pixels = Buffer.alloc(36 * 1024, 7).toString("base64");
  const image = [];
  await (await call(t, answer, ledger(image), { messages: [{ role: "user", content: [
    { type: "text", text: "What does this table say?" },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${pixels}` } },
  ] }] })).text();
  const asText = [];
  await (await call(t, answer, ledger(asText), { messages: [{ role: "user", content: [
    { type: "text", text: "What does this table say?" },
    { type: "text", text: pixels },
  ] }] })).text();
  const alone = [];
  await (await call(t, answer, ledger(alone), { messages: [{ role: "user", content: [
    { type: "text", text: "What does this table say?" },
  ] }] })).text();
  // The output ceiling is reserved alike for all three; what differs is the prompt.
  const cost = (events) => events.find((event) => event.type === "reserve").input.estimatedCost;
  const forImage = cost(image) - cost(alone);
  const forText = cost(asText) - cost(alone);
  assert.ok(forImage > 0, "an image still costs something");
  assert.ok(forImage * 5 < forText, `an image added ${forImage}, the same bytes as text ${forText}`);
});

test("an exhausted DeepSeek balance is named, counted by provider, and released, on both gateway paths", async (t) => {
  // 2026-09-23: DeepSeek answered every call 402 for two hours and nothing
  // alerted. The alert reads open_science_model_provider_refusals_total.
  const before = providerRefusalCount("deepseek", 402);
  const events = [];
  const response = await call(t, async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(402, { "content-type": "application/json" });
    res.end('{"error":{"message":"Insufficient Balance","type":"unknown_error"}}');
  }, ledger(events), { messages: [{ role: "user", content: "Spent." }] });
  const body = await response.json();
  assert.equal(body.error.code, "model_gateway_payment_required", "the runtime is told the balance is exhausted, not a generic refusal");
  assert.deepEqual(events.map((event) => [event.type, event.code]).slice(1), [["release", "provider_refused_402"]]);
  assert.equal(providerRefusalCount("deepseek", 402), before + 1);

  // The control plane's own calls (the frontier feed's path) the same way.
  const frontier = [];
  await assert.rejects(callModelForControlPlane({
    config: config("https://api.deepseek.com"), usageLedger: ledger(frontier),
    fetchImpl: async () => Response.json({ error: { message: "Insufficient Balance" } }, { status: 402 }),
  }, { userId: "usage-owner", projectId: "evimed-frontier", purpose: "frontier", limits: { daily: 0, weekly: 0 },
    body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "Screen." }] } }),
  (error) => error.code === "model_gateway_payment_required" && error.upstreamStatus === 402);
  assert.deepEqual(frontier.map((event) => [event.type, event.code]).slice(1), [["release", "provider_refused_402"]]);
  assert.equal(providerRefusalCount("deepseek", 402), before + 2);
  // A 5xx is not a refusal and is not counted as one.
  await assert.rejects(callModelForControlPlane({
    config: config("https://api.deepseek.com"), usageLedger: ledger([]),
    fetchImpl: async () => new Response("down", { status: 503 }),
  }, { userId: "usage-owner", projectId: "default", body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "x" }] } }),
  (error) => error.code === "model_gateway_upstream_error");
  assert.equal(providerRefusalCount("deepseek", 503), 0);
});

test("a real control-plane request received before headers is uncertain after abort, while a written refusal is released", async (t) => {
  for (const status of [null, 402]) {
    const events = []; const controller = new AbortController();
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume the complete real POST */ }
      events.push({ type: "provider-received" });
      if (status === null) controller.abort(new DOMException("Fixture abort after provider accepted POST", "AbortError"));
      else { res.writeHead(status, { "content-type": "application/json" }); res.end('{"error":{"message":"Refused"}}'); }
    });
    const base = await listen(upstream);
    t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
    await assert.rejects(callModelForControlPlane({ config: config(base), usageLedger: ledger(events) }, {
      userId: "usage-owner", projectId: "evimed-frontier", purpose: "frontier", signal: controller.signal,
      body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "A real local transport request." }] },
    }), error => status === null ? error.name === "AbortError" : error.upstreamStatus === status);
    assert.deepEqual(events.map(event => event.type), ["reserve", "provider-received", status === null ? "uncertain" : "release"]);
    assert.equal(events[2].code, status === null ? "provider_response_incomplete" : "provider_refused_402");
  }
});

test("control-plane pre-abort and validation never dispatch, including abort during the reservation", async () => {
  const body = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "Do not send." }] };
  const controller = new AbortController(); controller.abort();
  const events = []; let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; throw new Error("Must not reach fetch"); };
  await assert.rejects(callModelForControlPlane({ config: config("https://api.deepseek.com"), usageLedger: ledger(events), fetchImpl }, { userId: "usage-owner", projectId: "default", body, signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(callModelForControlPlane({ config: config("not a URL"), usageLedger: ledger(events), fetchImpl }, { userId: "usage-owner", projectId: "default", body }));
  const circular = {}; circular.self = circular;
  await assert.rejects(callModelForControlPlane({ config: config("https://api.deepseek.com"), usageLedger: ledger(events), fetchImpl }, { userId: "usage-owner", projectId: "default", body: { ...body, extra: circular } }));
  assert.equal(fetchCalls, 0); assert.equal(events.length, 0);
  const during = new AbortController(), held = ledger(events), reserve = held.reserveModel;
  held.reserveModel = async input => { const reservation = await reserve(input); during.abort(); return reservation; };
  await assert.rejects(callModelForControlPlane({ config: config("https://api.deepseek.com"), usageLedger: held, fetchImpl }, { userId: "usage-owner", projectId: "default", body, signal: during.signal }), { name: "AbortError" });
  assert.equal(fetchCalls, 0); assert.deepEqual(events.map(event => event.type), ["reserve", "release"]); assert.equal(events[1].code, "provider_not_accepted");
});

test("only definite non-aborted DNS or connect failures release control-plane reservations", async () => {
  for (const [code, abort, expected] of [["ENOTFOUND", false, "release"], ["ECONNREFUSED", false, "release"], ["ECONNRESET", false, "uncertain"], [null, false, "uncertain"], ["ECONNREFUSED", true, "uncertain"]]) {
    const events = []; const controller = new AbortController();
    await assert.rejects(callModelForControlPlane({ config: config("https://api.deepseek.com"), usageLedger: ledger(events), fetchImpl: async () => {
      if (abort) controller.abort();
      throw new TypeError("Synthetic transport failure", { cause: Object.assign(new Error("Synthetic cause"), code ? { code } : {}) });
    } }, { userId: "usage-owner", projectId: "default", body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "A controlled failure." }] }, signal: controller.signal }));
    assert.deepEqual(events.map(event => event.type), ["reserve", expected]);
    assert.equal(events[1].code, expected === "release" ? "provider_not_accepted" : "provider_response_incomplete");
  }
});
test('learning drift calls carry their module budget and registered attribution',async()=>{const events=[];await callModelForControlPlane({config:config('https://api.deepseek.com'),usageLedger:ledger(events),fetchImpl:async()=>Response.json({choices:[{message:{content:'{}'}}],usage:{prompt_tokens:20,completion_tokens:0,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:20}})},{userId:'usage-owner',projectId:'default',purpose:'learning',operation:'J1-baseline',taskId:'learning-task',module:'learning',limits:{moduleDaily:10,run:1},body:{model:'deepseek-v4-flash',max_tokens:100,messages:[{role:'user',content:'Screen.'}]}});assert.equal(events[0].input.moduleLimit,10);assert.equal(events[0].input.budgetPurpose,'learning');assert.equal(events[0].input.operation,'J1-baseline');assert.equal(events[0].input.taskId,'learning-task');assert.equal(events[0].input.module,'learning');assert.equal(events[0].input.runLimit,1);});
