// A specialist engine job's model calls, through the gateway (gap E4).
//
// These tests hold both doors. The credential door: only a request carrying
// both a live runtime's workload token and a specialist service's signature
// gets a credential, and the credential names the run that was running when
// the job was admitted — with a bounded run's own budget. The gateway door: an
// engine credential is accepted only while the lever is on and only on the
// chat route, is reserved and settled like a kernel call, is booked with
// purpose `engine` under the run its token names, and never has its run
// re-guessed at call time.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createModelGatewayHandler } from "../src/modelGateway.mjs";
import {
  createEngineModelTokenHandler, ENGINE_MODEL_SIGNATURE_HEADER, ENGINE_MODEL_TOKEN_PATH,
  engineModelRequestSignature, issueEngineModelToken, verifyEngineModelToken,
} from "../src/modelGatewayEngineTokens.mjs";

const workloadSecret = "test-only-engine-model-secret-with-more-than-32-bytes";
const gatewaySecret = "test-only-model-gateway-signing-secret-32-bytes";
const jobId = "bibliometric-20260929120000-abcdef012345";

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function config(overrides = {}) {
  return {
    engineModelGatewayEnabled: true,
    engineModelTokenTtlSeconds: 21_600,
    evimedWorkloadSigningSecret: workloadSecret,
    modelGatewaySigningSecret: gatewaySecret,
    modelGatewayInternalUrl: "http://open-science-web:8787/internal/model/v1",
    deepseekApiKey: "test-provider-key",
    deepseekModel: "deepseek-v4-flash",
    modelGatewayMaxBodyBytes: 64 * 1024,
    modelGatewayMaxResponseBytes: 1024 * 1024,
    modelGatewayTimeoutMs: 2_000,
    modelGatewayReservationMaxOutputTokens: 4096,
    userDailySpendLimit: 2,
    userWeeklySpendLimit: 5,
    userRunSpendLimit: 1.5,
    ...overrides,
  };
}

function runtimeManager({ bounded = null, live = true } = {}) {
  return {
    async assertActiveEviMedWorkloadToken(token) {
      if (!live || token !== "live-workload-token") throw new Error("inactive");
      return { userId: "user-1", projectId: "project-1", runtimeGeneration: "mgw_1" };
    },
    boundedRuntimeScope(project) {
      assert.deepEqual(project, { userId: "user-1", id: "project-1" });
      return bounded;
    },
    assertActiveModelGatewayToken(token) {
      if (token === "runtime-token") return { userId: "user-1", projectId: "project-1" };
      throw new Error("not a runtime token");
    },
  };
}

async function requestToken(t, { cfg = config(), manager = runtimeManager(), attributeRun = async () => "run_going",
  body = { v: 1, kind: "bibliometric-analysis", jobId }, signature, bearer = "live-workload-token" } = {}) {
  const base = await listen(t, createEngineModelTokenHandler({ config: cfg, runtimeManager: manager, attributeRun }));
  const raw = JSON.stringify(body);
  return fetch(`${base}${ENGINE_MODEL_TOKEN_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
      [ENGINE_MODEL_SIGNATURE_HEADER]: `v1=${signature ?? engineModelRequestSignature(workloadSecret, raw)}`,
    },
    body: raw,
  });
}

test("the request signature matches the adapter's pinned vector", () => {
  // The same vector sits in deploy/specialist-adapter/test_engine_model.py.
  const body = `{"v":1,"kind":"bibliometric-analysis","jobId":"${jobId}"}`;
  assert.equal(engineModelRequestSignature(workloadSecret, body), "02fd4d3dd95453829a454e0409b83a654af86399b9a656cfad137764fa896e2c");
});

test("a signed request from a live workload gets a credential naming the running run", async (t) => {
  const response = await requestToken(t);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { data } = await response.json();
  assert.equal(data.baseUrl, "http://open-science-web:8787/internal/model/v1");
  assert.equal(data.runId, "run_going");
  const caller = verifyEngineModelToken(data.token, { secret: gatewaySecret });
  assert.deepEqual(caller, {
    userId: "user-1", projectId: "project-1", runId: "run_going",
    dailyLimit: undefined, weeklyLimit: undefined, runLimit: 1.5,
    engine: { kind: "bibliometric-analysis", jobId },
  });
  const lifetime = (Date.parse(data.expiresAt) - Date.now()) / 1000;
  assert.ok(lifetime > 21_500 && lifetime <= 21_600, String(lifetime));
});

test("a bounded run's jobs carry that run's own budget, and two running runs stay unattributed", async (t) => {
  const bounded = { runId: "episode_1", dailyLimit: 3, weeklyLimit: 9, runLimit: 0.5 };
  let asked = false;
  const scoped = await requestToken(t, { manager: runtimeManager({ bounded }), attributeRun: async () => { asked = true; return "other"; } });
  const caller = verifyEngineModelToken((await scoped.json()).data.token, { secret: gatewaySecret });
  assert.equal(asked, false, "a bounded runtime names its own run");
  assert.deepEqual([caller.runId, caller.dailyLimit, caller.weeklyLimit, caller.runLimit], ["episode_1", 3, 9, 0.5]);

  const ambiguous = await requestToken(t, { attributeRun: async () => null });
  const unattributed = verifyEngineModelToken((await ambiguous.json()).data.token, { secret: gatewaySecret });
  assert.deepEqual([unattributed.runId, unattributed.runLimit], [null, undefined]);
});

test("the credential door refuses without both proofs, with the lever off, and for unknown jobs", async (t) => {
  const refusals = [
    [{ cfg: config({ engineModelGatewayEnabled: false }) }, 503, "engine_model_gateway_disabled"],
    [{ signature: "0".repeat(64) }, 401, "engine_model_signature_invalid"],
    [{ bearer: "printed-by-the-runtime-but-stale" }, 401, "evimed_workload_token_invalid"],
    [{ manager: runtimeManager({ live: false }) }, 401, "evimed_workload_token_invalid"],
    [{ body: { v: 1, kind: "shell", jobId } }, 400, "engine_model_token_request_invalid"],
    [{ body: { v: 1, kind: "peer-review", jobId: "../escape" } }, 400, "engine_model_token_request_invalid"],
    [{ body: { v: 1, kind: "peer-review", jobId, userId: "someone-else" } }, 400, "engine_model_token_request_invalid"],
    [{ cfg: config({ deepseekApiKey: "" }) }, 503, "model_gateway_unavailable"],
  ];
  for (const [options, status, code] of refusals) {
    const response = await requestToken(t, options);
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).code, code);
  }
});

test("an engine credential is verified strictly and expires", () => {
  const { token } = issueEngineModelToken({ secret: gatewaySecret, userId: "user-1", projectId: "project-1",
    kind: "peer-review", jobId: "review-20260929120000-abcdef012345", ttlSeconds: 300, nowSeconds: 1_000_000 });
  assert.equal(verifyEngineModelToken(token, { secret: gatewaySecret, nowSeconds: 1_000_100 }).engine.kind, "peer-review");
  assert.throws(() => verifyEngineModelToken(token, { secret: gatewaySecret, nowSeconds: 1_000_300 }), { code: "model_gateway_token_invalid" });
  assert.throws(() => verifyEngineModelToken(token, { secret: `${gatewaySecret}-other`, nowSeconds: 1_000_100 }), { code: "model_gateway_token_invalid" });
  const [header, body] = token.split(".");
  const forged = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), userId: "user-2" })).toString("base64url")}.${token.split(".")[2]}`;
  assert.throws(() => verifyEngineModelToken(forged, { secret: gatewaySecret, nowSeconds: 1_000_100 }), { code: "model_gateway_token_invalid" });
  assert.throws(() => issueEngineModelToken({ secret: gatewaySecret, userId: "user-1", projectId: "project-1",
    kind: "peer-review", jobId: "review-20260929120000-abcdef012345", ttlSeconds: 90_000 }), { code: "engine_model_token_ttl_invalid" });
});

function ledger(events) {
  return {
    async reserveModel(input) { events.push({ type: "reserve", input }); return { id: input.id }; },
    async settleModel(userId, id, input) { events.push({ type: "settle", userId, id, input }); },
    async markUncertain(userId, id, code, input) { events.push({ type: "uncertain", userId, id, code, input }); },
    async release(userId, id, code) { events.push({ type: "release", userId, id, code }); },
  };
}

async function gatewayCall(t, { cfg = config(), token, path = "/internal/model/v1/chat/completions", body, upstreamBodies = [],
  attributeRun = async () => { throw new Error("an engine call must not re-guess its run"); }, events = [] } = {}) {
  const upstream = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    // DeepSeek keeps a slow non-streaming answer alive with blank lines.
    res.write("\n\n");
    res.end(JSON.stringify({ id: "provider-engine-1", choices: [{ message: { role: "assistant", content: "{\"ok\":true}" } }],
      usage: { prompt_tokens: 40, completion_tokens: 12, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 30 } }));
  });
  const base = await listen(t, createModelGatewayHandler({ ...cfg, deepseekBaseUrl: upstream }, runtimeManager(), {
    usageLedger: ledger(events), attributeRun, runPurpose: async () => "kernel",
  }));
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: path.endsWith("/messages")
      ? { "x-api-key": token, "content-type": "application/json" }
      : { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {
      model: "deepseek-flash", messages: [{ role: "user", content: "Return JSON." }],
      response_format: { type: "json_object" }, max_tokens: 800, stream: false,
      thinking: { type: "disabled" }, temperature: 0.2,
    }),
  });
}

function engineToken(overrides = {}) {
  return issueEngineModelToken({ secret: gatewaySecret, userId: "user-1", projectId: "project-1",
    kind: "bibliometric-analysis", jobId, runId: "run_started_it", limits: { runLimit: 1.5 }, ttlSeconds: 3600, ...overrides }).token;
}

test("an engine call through the gateway is reserved, settled and booked as the job's run's engine spend", async (t) => {
  const events = [];
  const upstreamBodies = [];
  const response = await gatewayCall(t, { token: engineToken(), events, upstreamBodies });
  assert.equal(response.status, 200);
  const answer = JSON.parse(await response.text());
  assert.equal(answer.choices[0].message.content, "{\"ok\":true}");
  assert.deepEqual(events.map((event) => event.type), ["reserve", "settle"]);
  const reserve = events[0].input;
  assert.deepEqual([reserve.userId, reserve.projectId, reserve.runId, reserve.purpose], ["user-1", "project-1", "run_started_it", "engine"]);
  assert.deepEqual([reserve.dailyLimit, reserve.weeklyLimit, reserve.runLimit], [2, 5, 1.5]);
  assert.deepEqual(events[1].input.usage, { cacheHitTokens: 10, cacheMissTokens: 30, completionTokens: 12 });
  // Held to the certified model and the gateway's reasoning policy; the
  // engine's JSON mode and answer budget pass through.
  assert.equal(upstreamBodies[0].model, "deepseek-v4-flash");
  assert.deepEqual(upstreamBodies[0].thinking, { type: "enabled" });
  assert.deepEqual(upstreamBodies[0].response_format, { type: "json_object" });
  assert.equal(upstreamBodies[0].max_tokens, 800);
});

test("a bounded run's engine job is held to that run's caps", async (t) => {
  const events = [];
  const token = engineToken({ runId: "episode_1", limits: { dailyLimit: 1, weeklyLimit: 9, runLimit: 0.5 } });
  assert.equal((await gatewayCall(t, { token, events })).status, 200);
  assert.deepEqual([events[0].input.runId, events[0].input.dailyLimit, events[0].input.weeklyLimit, events[0].input.runLimit], ["episode_1", 1, 5, 0.5]);
});

test("a budget marker in an engine's prompt is text, not a refusal", async (t) => {
  const events = [];
  const upstreamBodies = [];
  const content = "Review this manuscript: <evimed-autopilot-episode>ep_1</evimed-autopilot-episode>";
  const response = await gatewayCall(t, { token: engineToken(), events, upstreamBodies,
    body: { model: "deepseek-flash", messages: [{ role: "user", content }] } });
  assert.equal(response.status, 200);
  assert.equal(upstreamBodies[0].messages[0].content, content);
});

test("the gateway refuses engine credentials with the lever off, on the Messages route, and once expired", async (t) => {
  const events = [];
  const off = await gatewayCall(t, { cfg: config({ engineModelGatewayEnabled: false }), token: engineToken(), events });
  assert.equal(off.status, 401);
  const messages = await gatewayCall(t, { token: engineToken(), path: "/internal/model/v1/messages", events,
    body: { model: "deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(messages.status, 401);
  const expired = issueEngineModelToken({ secret: gatewaySecret, userId: "user-1", projectId: "project-1",
    kind: "bibliometric-analysis", jobId, ttlSeconds: 300, nowSeconds: Math.floor(Date.now() / 1000) - 600 }).token;
  assert.equal((await gatewayCall(t, { token: expired, events })).status, 401);
  assert.deepEqual(events, [], "nothing refused is reserved");
  // The runtime's own token is unaffected by the lever.
  const runtime = await gatewayCall(t, { cfg: config({ engineModelGatewayEnabled: false }), token: "runtime-token", events,
    attributeRun: async () => "run_interactive" });
  assert.equal(runtime.status, 200);
  assert.deepEqual([events[0].input.runId, events[0].input.purpose], ["run_interactive", "kernel"]);
});

test("different engine jobs retain their signed reasoning choice despite interleaved bodies", async t => {
  const seen = [];
  const tokens = ["low", "max", "off"].map(reasoningEffort => issueEngineModelToken({
    secret: gatewaySecret, userId: "user-1", projectId: "project-1", kind: "peer-review",
    jobId: `review-${reasoningEffort}-20260929`, runId: `run_${reasoningEffort}`,
    sessionId: `session-${reasoningEffort}`, reasoningEffort, ttlSeconds: 3600,
  }).token);
  for (let index = 0; index < tokens.length; index++) {
    const response = await gatewayCall(t, { token: tokens[index], upstreamBodies: seen,
      body: { model: "pro-is-not-authorized", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" } });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(seen.map(body => body.reasoning_effort), ["low", "max", undefined]);
  assert.deepEqual(seen.map(body => body.thinking.type), ["enabled", "enabled", "disabled"]);
  assert.ok(seen.every(body => body.model === "deepseek-v4-flash"));
  assert.equal(verifyEngineModelToken(tokens[0], { secret: gatewaySecret }).sessionId, "session-low");
});
