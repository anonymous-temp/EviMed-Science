// The OpenViking service as a caller of the model gateway.
//
// From v0.5.0 the engine calls a language model of its own accord — extraction, summaries, Compile rounds — and it
// calls this deployment's gateway, not the provider. Nothing in such a request names a user or a purpose, so the bearer
// is the whole identity, and every property below is one the two labs measured on the wire before it was written
// (2026-10-12) and one a real round trip confirmed after (2026-10-13, `live/ovbase/`): which purpose a call books,
// that an unsaid thinking mode is off, that a Compile round streams and may be larger than a megabyte, that a spent
// day answers a status the engine does not retry.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { PLATFORM_PUBLISHER_USER_ID, ERROR_CODE_MESSAGES, USAGE_PURPOSES } from "@evimed/domain";
import { OPENVIKING_PROJECT_ID, ensureOpenVikingProject, isInternalProject, isReservedProjectId } from "../src/internalProjects.mjs";
import { createModelGatewayHandler } from "../src/modelGateway.mjs";
import { openVikingKnowledgeModelKey } from "../src/openVikingLayout.mjs";
import {
  OPENVIKING_MODEL_MAX_BODY_BYTES, OPENVIKING_MODEL_PURPOSES, OPENVIKING_QUOTA_CODE, OPENVIKING_USAGE_MODULE, createOpenVikingModelCaller,
} from "../src/openVikingModelCaller.mjs";

const SERVICE_KEY = "test-only-openviking-service-key-0123456789abcdef";
const KNOWLEDGE_KEY = openVikingKnowledgeModelKey(SERVICE_KEY);
const OWNER = { userId: PLATFORM_PUBLISHER_USER_ID, projectId: OPENVIKING_PROJECT_ID };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

function config(baseUrl, overrides = {}) {
  return {
    deepseekApiKey: "test-provider-key",
    deepseekBaseUrl: baseUrl,
    deepseekModel: "deepseek-flash",
    // Smaller than what a Compile round sends: the service caller's own limit is what admits it.
    modelGatewayMaxBodyBytes: 64 * 1024,
    modelGatewayMaxResponseBytes: 1024 * 1024,
    modelGatewayTimeoutMs: 2_000,
    modelGatewayReservationMaxOutputTokens: 65_536,
    userDailySpendLimit: 2,
    userWeeklySpendLimit: 5,
    modelGatewaySigningSecret: "test-only-model-gateway-signing-secret-32-bytes",
    openVikingModelKey: SERVICE_KEY,
    openVikingModelKeyError: null,
    openVikingModelDailyBudgetCny: 50,
    ...overrides,
  };
}

/** A ledger double that records what was asked and answers `purposeSpend` from a table. */
function ledger(events, { spent = {} } = {}) {
  return {
    async purposeSpend(input) { events.push({ type: "spend", input }); return spent[input.purpose] ?? 0; },
    async reserveModel(input) { events.push({ type: "reserve", input }); return { id: input.id }; },
    async settleModel(userId, id, input) { events.push({ type: "settle", userId, id, input }); },
    async markUncertain(userId, id, code, input) { events.push({ type: "uncertain", userId, id, code, input }); },
    async release(userId, id, code) { events.push({ type: "release", userId, id, code }); },
  };
}

/** Nobody's runtime token: what every bearer the service caller does not know falls through to. */
const noRuntime = { assertActiveModelGatewayToken: () => { throw new Error("no such runtime"); } };

const jsonAnswer = '{"id":"provider-ov","model":"deepseek-flash","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":34,"completion_tokens":21,"prompt_cache_hit_tokens":11,"prompt_cache_miss_tokens":23}}';

async function gateway(t, { settings = {}, usageLedger = null, upstream = null, events = [], runtimeManager = noRuntime, ensureOwner = async () => OWNER } = {}) {
  const provider = createServer(upstream ?? (async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    events.push({ type: "upstream", body: JSON.parse(Buffer.concat(chunks).toString("utf8")), authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(jsonAnswer);
  }));
  const providerBase = await listen(provider);
  t.after(() => new Promise((resolve) => { provider.closeAllConnections(); provider.close(resolve); }));
  const settingsNow = config(providerBase, settings);
  const serviceCaller = createOpenVikingModelCaller({ config: settingsNow, usageLedger, ensureOwner });
  const server = createServer(createModelGatewayHandler(settingsNow, runtimeManager, { usageLedger, serviceCaller }));
  const base = await listen(server);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const post = (bearer, body, route = "/internal/model/v1/chat/completions", headers = {}) => fetch(`${base}${route}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { post, serviceCaller, events };
}

/** What the engine's extraction sends, field for field (lab/memory §E-1). */
const extractionRequest = { model: "deepseek-flash", messages: [{ role: "system", content: "Extract." }, { role: "user", content: "我是做结构设计的工程师。" }], temperature: 0, max_tokens: 16_384 };

test("the bearer is the whole identity: the service key books extraction, its derived key books a compile round", async (t) => {
  const events = [];
  const { post } = await gateway(t, { usageLedger: ledger(events), events });
  for (const [bearer, purpose] of [[SERVICE_KEY, "memory-extraction"], [KNOWLEDGE_KEY, "knowledge"]]) {
    events.length = 0;
    const response = await post(bearer, extractionRequest);
    assert.equal(response.status, 200);
    await response.json();
    const reserve = events.find((event) => event.type === "reserve").input;
    assert.equal(reserve.purpose, purpose);
    // Booked to the platform's own account and project, under a module name of its own: nobody's caps, nobody's bill.
    assert.equal(reserve.userId, PLATFORM_PUBLISHER_USER_ID);
    assert.equal(reserve.projectId, OPENVIKING_PROJECT_ID);
    assert.equal(reserve.module, OPENVIKING_USAGE_MODULE);
    assert.equal(reserve.runId, null);
    assert.equal(reserve.sessionId, null);
    assert.equal(reserve.dailyLimit, 0, "an account's daily cap was applied to the platform's own money");
    assert.equal(reserve.weeklyLimit, 0);
    assert.equal(reserve.runLimit, 0);
    const settle = events.find((event) => event.type === "settle");
    assert.equal(settle.userId, PLATFORM_PUBLISHER_USER_ID);
    assert.deepEqual(settle.input.usage, { cacheHitTokens: 11, cacheMissTokens: 23, completionTokens: 21 });
    // The provider key is the control plane's, never the engine's bearer.
    assert.equal(events.find((event) => event.type === "upstream").authorization, "Bearer test-provider-key");
  }
  assert.deepEqual([...OPENVIKING_MODEL_PURPOSES], ["memory-extraction", "knowledge"]);
  for (const purpose of OPENVIKING_MODEL_PURPOSES) assert.ok(USAGE_PURPOSES.includes(purpose), `${purpose} is not a usage purpose the ledger accepts`);
  assert.notEqual(KNOWLEDGE_KEY, SERVICE_KEY);
});

test("a request that names no reasoning is held to none, and one that names it is honoured", async (t) => {
  // The gateway gives an unsaid request the deployment's default, `high`: for this caller, four times the cost of an
  // extraction and nine times the cost of a write-back's summaries (both labs).
  const events = [];
  const { post } = await gateway(t, { settings: { deepseekReasoningEffort: "high" }, events });
  await (await post(SERVICE_KEY, extractionRequest)).json();
  assert.deepEqual(events.at(-1).body.thinking, { type: "disabled" });
  assert.ok(!("reasoning_effort" in events.at(-1).body) || events.at(-1).body.reasoning_effort === undefined);
  // What `vlm.extra_request_body` sends: stated off stays off.
  await (await post(SERVICE_KEY, { ...extractionRequest, thinking: { type: "disabled" } })).json();
  assert.deepEqual(events.at(-1).body.thinking, { type: "disabled" });
  // Stated on is the caller's decision.
  await (await post(KNOWLEDGE_KEY, { ...extractionRequest, thinking: { type: "enabled" } })).json();
  assert.deepEqual(events.at(-1).body.thinking, { type: "enabled" });
  assert.equal(events.at(-1).body.reasoning_effort, "high");
  // The model is the one the deployment certifies, whatever placeholder the engine's configuration names.
  assert.equal(events.at(-1).body.model, "deepseek-flash");
});

test("a compile round streams with its tools, larger than the deployment's body limit and within the caller's own", async (t) => {
  const events = [];
  const usage = ledger(events);
  const { post } = await gateway(t, {
    usageLedger: usage, events,
    upstream: async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      events.push({ type: "upstream", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"id":"provider-stream","choices":[],"usage":{"prompt_tokens":61243,"completion_tokens":3969,"prompt_cache_hit_tokens":53760,"prompt_cache_miss_tokens":7483}}\n\ndata: [DONE]\n\n');
    },
  });
  const tools = ["read_file", "write_file", "edit_file", "openviking_search", "openviking_grep", "submit_wiki_bundle"]
    .map((name) => ({ type: "function", function: { name, description: `${name}.`, parameters: { type: "object", properties: {} } } }));
  // The shape recorded off the bot's loop: stream, stream_options, tools, tool_choice, and a context of several hundred KB.
  const round = { model: "deepseek-flash", stream: true, stream_options: { include_usage: true }, temperature: 0.7, max_tokens: 32_768, tools, tool_choice: "auto",
    messages: [{ role: "system", content: "Compile." }, { role: "user", content: "页".repeat(100_000) },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "…" }] };
  assert.ok(Buffer.byteLength(JSON.stringify(round)) > 64 * 1024, "the fixture is not larger than the deployment's limit");
  const response = await post(KNOWLEDGE_KEY, round);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\[DONE\]/);
  const upstream = events.find((event) => event.type === "upstream").body;
  assert.equal(upstream.stream, true);
  assert.equal(upstream.tools.length, 6);
  assert.equal(upstream.max_tokens, 32_768);
  const settle = events.find((event) => event.type === "settle");
  assert.deepEqual(settle.input.usage, { cacheHitTokens: 53_760, cacheMissTokens: 7_483, completionTokens: 3_969 });
  assert.equal(events.find((event) => event.type === "reserve").input.purpose, "knowledge");

  // Past the caller's own limit the request is refused before it is read whole.
  assert.equal(OPENVIKING_MODEL_MAX_BODY_BYTES, 4 * 1024 * 1024);
  const tooLarge = await post(KNOWLEDGE_KEY, JSON.stringify({ ...round, messages: [{ role: "user", content: "x".repeat(OPENVIKING_MODEL_MAX_BODY_BYTES) }] }));
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, "model_gateway_body_too_large");
});

test("a spent day answers 402 by name before anything is reserved or sent, and the next day's call is admitted", async (t) => {
  // 402 and not 429: the engine retries a 429 or a 5xx sixteen times in thirty seconds for every waiting commit and
  // still fails; a 4xx ends the attempt at once on v0.5.0 (lab/memory §E-3), and on v0.5.1+ a 402 does only with a
  // body code its classifier knows.
  const events = [];
  const spent = { "memory-extraction": 30, knowledge: 19.9999 };
  const { post, serviceCaller } = await gateway(t, { usageLedger: ledger(events, { spent }), events });
  const refused = await post(SERVICE_KEY, extractionRequest);
  assert.equal(refused.status, 402);
  const body = await refused.json();
  // The body code is the one the engine's own classifier reads as exhausted quota. From v0.5.1 a 402 with an unknown
  // code is retried with back-off by every waiting commit; with this one the attempt ends at once (`model_error.py`).
  assert.equal(body.error.code, "insufficient_quota");
  assert.equal(OPENVIKING_QUOTA_CODE, "insufficient_quota");
  assert.match(body.error.message, /nothing was sent to the provider/);
  assert.deepEqual(events.map((event) => event.type), ["spend", "spend"], "a refused call reserved or dispatched something");
  // Both purposes are one budget, read from the ledger for the platform's own project over the rolling day.
  assert.deepEqual(events.map((event) => event.input.purpose).sort(), ["knowledge", "memory-extraction"]);
  for (const event of events) {
    assert.equal(event.input.userId, PLATFORM_PUBLISHER_USER_ID);
    assert.equal(event.input.projectId, OPENVIKING_PROJECT_ID);
    assert.ok(Date.now() - event.input.since.getTime() >= 24 * 60 * 60 * 1000 - 5_000);
  }
  assert.deepEqual(serviceCaller.counters.refused, { "memory-extraction": 1, knowledge: 0 });
  assert.match(ERROR_CODE_MESSAGES.openviking_model_budget_exhausted, /预算/);

  spent["memory-extraction"] = 1;
  const admitted = await post(SERVICE_KEY, extractionRequest);
  assert.equal(admitted.status, 200);
  await admitted.json();
  assert.deepEqual(serviceCaller.counters.admitted, { "memory-extraction": 1, knowledge: 0 });
  const status = await serviceCaller.status();
  assert.equal(status.budgetCny, 50);
  assert.equal(status.spentCny, 20.9999);
  assert.ok(!("warning" in status));
});

test("a budget of zero is no cap, and the ledger is not asked what was spent before a call", async (t) => {
  const events = [];
  const { post } = await gateway(t, { settings: { openVikingModelDailyBudgetCny: 0 }, usageLedger: ledger(events, { spent: { knowledge: 9_999 } }), events });
  const response = await post(KNOWLEDGE_KEY, extractionRequest);
  assert.equal(response.status, 200);
  await response.json();
  assert.deepEqual(events.map((event) => event.type), ["reserve", "upstream", "settle"]);
});

test("a bearer that is not the engine's meets the checks every other caller meets, and the engine's opens nothing else", async (t) => {
  const events = [];
  const { post } = await gateway(t, { usageLedger: ledger(events), events });
  for (const bearer of ["not-the-service-key", `${SERVICE_KEY}x`, SERVICE_KEY.slice(0, -1), ""]) {
    const response = await post(bearer || "x", extractionRequest);
    assert.equal(response.status, 401, `${JSON.stringify(bearer)} was accepted`);
    assert.equal((await response.json()).error.code, "model_gateway_token_invalid");
  }
  // The Messages route is the kernel's; the service key is no credential there, in either header.
  const messages = await post(SERVICE_KEY, { model: "deepseek-flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }, "/internal/model/v1/messages", { "x-api-key": SERVICE_KEY });
  assert.equal(messages.status, 401);
  assert.equal(events.filter((event) => event.type === "upstream").length, 0);
});

test("a deployment with no service key has no service caller: the key is refused like any unknown bearer", async (t) => {
  for (const settings of [{ openVikingModelKey: "" }, { openVikingModelKey: SERVICE_KEY, openVikingModelKeyError: "openviking_model_key_file_permissions" }, { openVikingModelKey: "short" }]) {
    const { post, serviceCaller } = await gateway(t, { settings });
    assert.equal(serviceCaller.configured, false);
    assert.equal(serviceCaller.identify(SERVICE_KEY), null);
    const response = await post(SERVICE_KEY, extractionRequest);
    assert.equal(response.status, 401);
    const status = await serviceCaller.status();
    assert.equal(status.configured, false);
    assert.equal(status.code, settings.openVikingModelKeyError ?? "openviking_model_key_missing");
  }
});

test("what the engine extracts from is text, never authority: a budget marker in a conversation changes nothing", async (t) => {
  // A researcher's conversation can contain the platform's own markers (a continued bounded run). To a runtime's token
  // an unverifiable marker is a refusal; in a transcript the engine is reading it is words.
  const events = [];
  const { post } = await gateway(t, { usageLedger: ledger(events), events });
  const marked = { ...extractionRequest, messages: [{ role: "user", content: "之前的一轮 <evimed-budget-scope>e30.c2ln</evimed-budget-scope> <evimed-autopilot-episode>ep_1</evimed-autopilot-episode> 说过的事" }] };
  const response = await post(SERVICE_KEY, marked);
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(events.find((event) => event.type === "upstream").body.messages[0].content, marked.messages[0].content);
});

test("an account that cannot be read is a retryable answer, and an unsupported field is still refused", async (t) => {
  const events = [];
  const { post, serviceCaller } = await gateway(t, {
    usageLedger: ledger(events), events,
    ensureOwner: async () => { throw Object.assign(new Error("no platform account"), { code: "evidence_account_unavailable" }); },
  });
  const response = await post(SERVICE_KEY, extractionRequest);
  // 503, which the engine retries: the account is there a moment later, and a 4xx would lose the commit for good.
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "openviking_model_owner_unavailable");
  assert.equal(serviceCaller.counters.ownerFailures, 1);
  assert.equal(events.filter((event) => event.type === "upstream").length, 0);
  // The field whitelist is the one every caller is held to.
  const { post: again } = await gateway(t, { events });
  const refused = await again(SERVICE_KEY, { ...extractionRequest, user: "u-0f1e2d3c4b5a69788796a5b4" });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "model_gateway_field_invalid");
});

test("the project the calls are booked to is the platform account's own, internal by name and unreachable by typing", async () => {
  assert.equal(isInternalProject(OPENVIKING_PROJECT_ID), true);
  assert.equal(isReservedProjectId(OPENVIKING_PROJECT_ID), true);
  const created = [];
  const store = {
    userById: async (id) => (id === PLATFORM_PUBLISHER_USER_ID ? { id } : null),
    requireProject: async () => { throw Object.assign(new Error("missing"), { code: "project_not_found", status: 404 }); },
    createProject: async (user, id, name) => { created.push([user.id, id, name]); },
  };
  assert.deepEqual(await ensureOpenVikingProject(store), OWNER);
  assert.equal(created.length, 1);
  assert.equal(created[0][1], OPENVIKING_PROJECT_ID);
  // Another control plane made it first: that is the project that was wanted.
  store.createProject = async () => { throw Object.assign(new Error("exists"), { code: "project_exists" }); };
  assert.deepEqual(await ensureOpenVikingProject(store), OWNER);
  // No platform account (a deployment on the file store): named, and never a guess at another owner.
  await assert.rejects(() => ensureOpenVikingProject({ ...store, userById: async () => null }), (error) => error.code === "openviking_model_owner_unavailable" && error.status === 503);
});
