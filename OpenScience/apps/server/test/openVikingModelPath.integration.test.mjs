// The engine's model path in the real application, on a real database.
//
// The unit test holds the gateway's behaviour for the service caller against a ledger double. This holds what a double
// cannot: that the rows land in `evimed_usage.model_requests` under the platform's own account and a project that
// account really has (the ledger's project reference is a foreign key), that the day's budget is read back from those
// rows, and that readiness and the operator metrics say what happened.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { OPENVIKING_PROJECT_ID } from "../src/internalProjects.mjs";
import { openVikingKnowledgeModelKey } from "../src/openVikingLayout.mjs";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const operatorToken = "openviking-model-path-operator-token-0123456789";

/** An engine check that has already read every fact, so readiness has an engine to report beside the model path. */
const engineStub = {
  status: () => ({ checkedAt: "2026-10-13T02:00:00.000Z", ok: true, facts: { version: { ok: true, version: "v0.5.0" } }, degraded: [], counters: {} }),
  ready: () => ({ ok: true, code: null, fact: null }),
  start() {}, close() {},
};

async function application(t, { budget }) {
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "provider-openviking-fixture", model: "deepseek-flash", choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10_800, completion_tokens: 200, prompt_cache_hit_tokens: 6_000, prompt_cache_miss_tokens: 4_800 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => new Promise((resolve) => { provider.closeAllConnections(); provider.close(resolve); }));
  const root = await mkdtemp(path.join("/tmp", "evimed-ov-model-path-"));
  const serviceKey = randomBytes(36).toString("base64url");
  const app = createWebApiApp({
    dataDir: root, databaseUrl, stateStore: "postgres", requireSharedStateStore: true,
    production: false, runtimeMode: "mock", authMode: "local", devAuth: false, bootstrapUser: "", bootstrapPassword: "",
    deepseekProviderEnabled: true, deepseekApiKey: "test-provider-key", deepseekBaseUrl: `http://127.0.0.1:${provider.address().port}`,
    modelGatewaySigningSecret: randomBytes(32).toString("hex"), evimedWorkloadSigningSecret: randomBytes(32).toString("hex"),
    requireDurableUsageLedger: true, operatorMetricsToken: operatorToken,
    openVikingModelKey: serviceKey, openVikingModelDailyBudgetCny: budget, openVikingEngine: engineStub,
    evolutionEnabled: false, learningEnabled: false,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    // Only this test's rows: the platform account is every test's, its engine project is this subject's alone.
    await app.store.database.query("DELETE FROM evimed_usage.model_requests WHERE user_id=$1 AND project_id=$2", [PLATFORM_PUBLISHER_USER_ID, OPENVIKING_PROJECT_ID]).catch(() => {});
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (bearer) => fetch(`${base}/internal/model/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", temperature: 0, max_tokens: 16_384, messages: [{ role: "system", content: "Extract." }, { role: "user", content: "我是做结构设计的工程师。" }] }),
  });
  const rows = async () => (await app.store.database.query(
    "SELECT purpose, module, status, run_id, session_id, cache_hit_tokens, cache_miss_tokens, output_tokens, actual_cost FROM evimed_usage.model_requests WHERE user_id=$1 AND project_id=$2 ORDER BY created_at",
    [PLATFORM_PUBLISHER_USER_ID, OPENVIKING_PROJECT_ID])).rows;
  const settled = async (count) => {
    const deadline = Date.now() + 5_000;
    let current = await rows();
    while ((current.length < count || current.some((row) => row.status === "reserved")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      current = await rows();
    }
    return current;
  };
  return { app, base, serviceKey, call, rows, settled };
}

test("the engine's calls are booked to the platform account's own project, by purpose, and counted against the day", options, async (t) => {
  const { app, base, serviceKey, call, settled } = await application(t, { budget: 50 });
  await app.store.database.query("DELETE FROM evimed_usage.model_requests WHERE user_id=$1 AND project_id=$2", [PLATFORM_PUBLISHER_USER_ID, OPENVIKING_PROJECT_ID]).catch(() => {});

  const extraction = await call(serviceKey);
  assert.equal(extraction.status, 200);
  await extraction.json();
  const compile = await call(openVikingKnowledgeModelKey(serviceKey));
  assert.equal(compile.status, 200);
  await compile.json();

  const booked = await settled(2);
  assert.deepEqual(booked.map((row) => [row.purpose, row.module, row.status, row.run_id, row.session_id]), [
    ["memory-extraction", "openviking", "settled", null, null],
    ["knowledge", "openviking", "settled", null, null],
  ]);
  for (const row of booked) {
    assert.deepEqual([Number(row.cache_hit_tokens), Number(row.cache_miss_tokens), Number(row.output_tokens)], [6_000, 4_800, 200], "the provider's own counts");
    assert.ok(Number(row.actual_cost) > 0);
  }
  // The project is the platform account's, made on first use, and no person can name it.
  const publisher = await app.store.userById(PLATFORM_PUBLISHER_USER_ID);
  assert.ok(publisher, "the platform account is missing from this database");
  assert.equal((await app.store.requireProject(publisher, OPENVIKING_PROJECT_ID)).id, OPENVIKING_PROJECT_ID);

  // Readiness reports the model path beside the engine: the budget, what is committed against it, what was admitted.
  const ready = (await (await fetch(`${base}/api/ready`)).json()).data.checks.memoryIndex;
  assert.equal(ready.engine.ok, true);
  assert.deepEqual(ready.engine.features, { nativeMemory: false, knowledge: false }, "the switches are reported as configured, and no engine URL is configured here");
  assert.equal(ready.modelPath.configured, true);
  assert.equal(ready.modelPath.budgetCny, 50);
  const spent = booked.reduce((sum, row) => sum + Number(row.actual_cost), 0);
  assert.ok(Math.abs(ready.modelPath.spentCny - spent) < 0.0002, `readiness says ${ready.modelPath.spentCny} is committed, the ledger says ${spent}`);
  assert.deepEqual(ready.modelPath.admitted, { "memory-extraction": 1, knowledge: 1 });
  assert.deepEqual(ready.modelPath.refused, { "memory-extraction": 0, knowledge: 0 });
  assert.ok(!JSON.stringify(ready).includes(serviceKey), "readiness printed the service key");

  const metrics = await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: `Bearer ${operatorToken}` } })).text();
  assert.match(metrics, /open_science_openviking_model_requests_total\{purpose="memory-extraction",outcome="admitted"\} 1/);
  assert.match(metrics, /open_science_openviking_model_requests_total\{purpose="knowledge",outcome="admitted"\} 1/);
  assert.match(metrics, /open_science_openviking_model_budget_cny\{kind="budget"\} 50/);
  assert.match(metrics, /open_science_openviking_model_budget_cny\{kind="committed"\} 0\.\d+/);
  assert.match(metrics, /open_science_openviking_engine_fact\{fact="version",code="ok"\} 1/);
});

test("a day whose budget is spent refuses the next call with 402 and books nothing for it", options, async (t) => {
  // The budget is smaller than one reservation, so the first call is the one that does not fit.
  const { app, base, serviceKey, call, rows } = await application(t, { budget: 0.000001 });
  await app.store.database.query("DELETE FROM evimed_usage.model_requests WHERE user_id=$1 AND project_id=$2", [PLATFORM_PUBLISHER_USER_ID, OPENVIKING_PROJECT_ID]).catch(() => {});
  const refused = await call(serviceKey);
  assert.equal(refused.status, 402);
  assert.equal((await refused.json()).error.code, "insufficient_quota");
  assert.deepEqual(await rows(), [], "a refused call left a row behind");
  const ready = (await (await fetch(`${base}/api/ready`)).json()).data.checks.memoryIndex;
  assert.deepEqual(ready.modelPath.refused, { "memory-extraction": 1, knowledge: 0 });
  // Readiness itself is not failed by it: a spent module budget pauses the engine's own work, and no conversation.
  assert.equal(ready.ok, true);
  const metrics = await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: `Bearer ${operatorToken}` } })).text();
  assert.match(metrics, /open_science_openviking_model_requests_total\{purpose="memory-extraction",outcome="budget_refused"\} 1/);
});
