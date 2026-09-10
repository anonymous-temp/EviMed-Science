import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createModelGatewayHandler, issueModelGatewayBudgetMarker } from "../src/modelGateway.mjs";

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

async function call(t, upstreamHandler, usageLedger, requestBody, runtimeManager = manager()) {
  const upstream = createServer(upstreamHandler);
  const upstreamBase = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const gateway = createServer(createModelGatewayHandler(config(upstreamBase), runtimeManager, { usageLedger }));
  const gatewayBase = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  return fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime", "content-type": "application/json" },
    body: JSON.stringify(requestBody),
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
