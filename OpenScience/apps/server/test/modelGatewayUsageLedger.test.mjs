import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createModelGatewayHandler } from "../src/modelGateway.mjs";

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

async function call(t, upstreamHandler, usageLedger, requestBody) {
  const upstream = createServer(upstreamHandler);
  const upstreamBase = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const gateway = createServer(createModelGatewayHandler(config(upstreamBase), manager(), { usageLedger }));
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
  assert.equal(events[0].input.priceVersion, "evimed-reference-2026-09-05");
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
