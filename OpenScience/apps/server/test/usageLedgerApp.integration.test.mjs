import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { issueModelGatewayRuntimeToken } from "../src/runtimeManager.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("the real application wires every provider call into the durable usage ledger", options, async (t) => {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "provider-app-fixture", choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 9, completion_tokens: 3, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 5 } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const root = await mkdtemp(path.join("/tmp", "evimed-usage-app-"));
  const secret = randomBytes(32).toString("hex");
  const app = createWebApiApp({
    dataDir: root, databaseUrl, stateStore: "postgres", requireSharedStateStore: true,
    production: false, runtimeMode: "mock", authMode: "local", devAuth: false,
    bootstrapUser: "", bootstrapPassword: "", deepseekProviderEnabled: true,
    deepseekApiKey: "test-provider-key", deepseekBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    modelGatewaySigningSecret: secret,
    requireDurableUsageLedger: true, modelGatewayReservationMaxOutputTokens: 4096,
    memOsEngineUrl: "", requireMemoryIndex: false,
  });
  const username = `usage${randomUUID().slice(0, 8)}`;
  let user;
  try {
    user = await app.store.createUser(username, "test-only-usage-password", "Usage fixture");
    const scopedUser = await app.store.userById(user.id);
    const project = await app.store.defaultProject(scopedUser);
    const jti = `fixture_${randomUUID()}`;
    const token = issueModelGatewayRuntimeToken({ secret, userId: user.id, projectId: project.id, jti });
    app.runtimeManager.activateModelGatewayRuntime(project, { modelGatewayToken: token, modelGatewayTokenJti: jti });
    const address = await app.listen(0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/model/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Count the real app call." }] }),
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.ok(app.usageLedger);
    // The response stream completes before its durable terminal transition.
    // Observe that transition instead of racing it with an immediate SELECT.
    let summary;
    const settlementDeadline = Date.now() + 5000;
    do {
      summary = await app.usageLedger.summary(user.id, { since: new Date("2020-01-01T00:00:00Z") });
      if (summary.settledCalls || summary.uncertainCalls) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < settlementDeadline);
    assert.equal(summary.settledCalls, 1);
    assert.equal(summary.uncertainCalls, 0);
    assert.equal(summary.cacheHitTokens, 4);
    assert.equal(summary.cacheMissTokens, 5);
    assert.equal(summary.completionTokens, 3);
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the running application sweeps reservations whose settlement never arrived", options, async (t) => {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const root = await mkdtemp(path.join("/tmp", "evimed-usage-sweep-"));
  const secret = randomBytes(32).toString("hex");
  const app = createWebApiApp({
    dataDir: root, databaseUrl, stateStore: "postgres", requireSharedStateStore: true,
    production: false, runtimeMode: "mock", authMode: "local", devAuth: false,
    bootstrapUser: "", bootstrapPassword: "", deepseekProviderEnabled: true,
    deepseekApiKey: "test-provider-key", deepseekBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    deepseekModel: "deepseek-v4-flash", modelGatewaySigningSecret: secret,
    requireDurableUsageLedger: true, modelGatewayReservationMaxOutputTokens: 4096,
    memOsEngineUrl: "", requireMemoryIndex: false,
  });
  const username = `sweep${randomUUID().slice(0, 8)}`;
  let user;
  try {
    user = await app.store.createUser(username, "test-only-usage-password", "Sweep fixture");
    const scopedUser = await app.store.userById(user.id);
    const project = await app.store.defaultProject(scopedUser);
    const id = randomUUID();
    await app.usageLedger.reserveModel({
      id, userId: user.id, projectId: project.id, model: "deepseek-v4-flash",
      priceVersion: "evimed-reference-2026-09-05", currency: "CNY",
      requestFingerprint: createHash("sha256").update(id).digest("hex"),
      estimatedCost: 0.25, ttlMs: 60_000,
    });
    // The settle call never comes back: without a sweeper this row stays
    // 'reserved' for good and quietly falls out of every budget window.
    await app.store.database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [id]);
    assert.ok((await app.usageLedger.health()).expiredReservations >= 1);
    await app.listen(0, "127.0.0.1");
    const row = (await app.store.database.query("SELECT status,error_code FROM evimed_usage.model_requests WHERE id=$1", [id])).rows[0];
    assert.equal(row.status, "uncertain", "startRecurringWork must drive the ledger reconciliation");
    assert.equal(row.error_code, "reservation_expired");
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
