import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
    deepseekModel: "deepseek-v4-flash", modelGatewaySigningSecret: secret,
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
    const summary = await app.usageLedger.summary(user.id, { since: new Date("2020-01-01T00:00:00Z") });
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
