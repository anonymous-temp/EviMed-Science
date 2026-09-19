import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { issueModelGatewayRuntimeToken } from "../src/runtimeManager.mjs";
import { ENGINE_USAGE_PATH, ENGINE_USAGE_SIGNATURE_HEADER, engineUsageSignature } from "../src/engineUsage.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const operatorToken = "usage-report-operator-token-0123456789abcdef";
const workloadSecret = "usage-app-workload-signing-secret-0123456789abcdef";

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
    operatorMetricsToken: operatorToken,
    evimedWorkloadSigningSecret: workloadSecret,
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
    // Settlement is written after the last byte by design (modelGateway.mjs:
    // "After the body, never before"), so the client can finish reading while
    // the row is still `reserved` and `summary()` counts only settled ones.
    // Wait for the terminal transition, bounded, and prove the wait ended on it.
    const since = new Date("2020-01-01T00:00:00Z");
    const deadline = Date.now() + 5_000;
    let summary = await app.usageLedger.summary(user.id, { since });
    while (summary.reservedCalls > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      summary = await app.usageLedger.summary(user.id, { since });
    }
    assert.equal(summary.totalCalls, 1);
    assert.equal(summary.reservedCalls, 0, "the gateway never settled the call");
    assert.equal(summary.settledCalls, 1);
    assert.equal(summary.uncertainCalls, 0);
    assert.equal(summary.cacheHitTokens, 4);
    assert.equal(summary.cacheMissTokens, 5);
    assert.equal(summary.completionTokens, 3);
    // A runtime's request is the kernel's: no run is going in the project.
    const purposes = await app.store.database.query("SELECT purpose FROM evimed_usage.model_requests WHERE user_id=$1", [user.id]);
    assert.deepEqual(purposes.rows.map((row) => row.purpose), ["kernel"]);

    // The operator's cost report, behind the scrape token and nothing else.
    const report = (query, headers = {}) => fetch(`http://127.0.0.1:${address.port}/api/ops/usage/by-purpose${query}`, { headers });
    assert.equal((await report("")).status, 401, "no token, no report");
    assert.equal((await report("", { authorization: "Bearer wrong-token-of-a-plausible-length-000000" })).status, 401);
    const bearer = { authorization: `Bearer ${operatorToken}` };
    for (const days of ["0", "367", "1.5", "week"]) {
      const refused = await report(`?days=${days}`, bearer);
      assert.equal(refused.status, 400, `days=${days}`);
      assert.equal((await refused.json()).code, "usage_report_days_invalid");
    }
    const answered = await report("?days=7", bearer);
    assert.equal(answered.status, 200);
    const body = (await answered.json()).data;
    assert.equal(body.days, 7);
    assert.equal(body.currency, "CNY");
    assert.ok(Date.parse(body.since) < Date.now());
    assert.ok(body.rows.length >= 9, "every purpose has a row");
    const kernel = body.rows.find((row) => row.purpose === "kernel");
    assert.ok(kernel.requests >= 1 && kernel.cacheHitTokens >= 4 && kernel.outputTokens >= 3, "the call above is in the report");
    assert.deepEqual(Object.keys(kernel).sort(), ["cacheHitTokens", "cacheMissTokens", "costCny", "outputTokens", "purpose", "requests"]);

    // A specialist engine's job, reported by its adapter: signed with the
    // workload secret, recorded once as an engine row on this account.
    const engineReport = JSON.stringify({
      v: 1, kind: "peer-review", jobId: `review-${randomUUID().slice(0, 8)}-abcdef`, attempt: 1,
      userId: user.id, projectId: project.id, status: "succeeded", finishedAt: new Date().toISOString(),
      usage: { requests: 6, cacheHitTokens: 40_000, cacheMissTokens: 8_000, outputTokens: 2_500, model: "deepseek-flash" },
    });
    const reportEngine = (signature) => fetch(`http://127.0.0.1:${address.port}${ENGINE_USAGE_PATH}`, {
      method: "POST", body: engineReport,
      headers: { "content-type": "application/json", [ENGINE_USAGE_SIGNATURE_HEADER]: signature },
    });
    assert.equal((await reportEngine(`v1=${engineUsageSignature("not-the-deployment-secret-0123456789abcdef", engineReport)}`)).status, 401);
    const recorded = await reportEngine(`v1=${engineUsageSignature(workloadSecret, engineReport)}`);
    assert.equal(recorded.status, 200);
    assert.equal((await recorded.json()).data.recorded, true);
    assert.equal((await reportEngine(`v1=${engineUsageSignature(workloadSecret, engineReport)}`)).status, 200, "a retry lands on the same row");
    const engineRows = await app.store.database.query(
      "SELECT purpose, status, output_tokens, priced FROM evimed_usage.model_requests WHERE user_id=$1 AND purpose='engine'", [user.id]);
    assert.deepEqual(engineRows.rows.map((row) => [row.purpose, row.status, Number(row.output_tokens), row.priced]),
      [["engine", "settled", 2_500, true]]);
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
