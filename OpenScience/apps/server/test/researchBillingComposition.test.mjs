import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { EvimedCreditsService } from "../src/evimedCreditsService.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

test("real app completion preserves account generation and charges the external wallet once with confirmed HTTP spend", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-billing-composition-"));
  const deductions = [];
  const settlementInputs = [];
  let walletBalance = 100;
  const settle = EvimedCreditsService.prototype.settleRun;
  EvimedCreditsService.prototype.settleRun = async function (run) {
    settlementInputs.push(run);
    return settle.call(this, run);
  };
  t.after(() => { EvimedCreditsService.prototype.settleRun = settle; });
  const app = createWebApiApp({ dataDir, databaseUrl, stateStore: "postgres", requireSharedStateStore: true,
    runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    deepseekProviderEnabled: false, researchMemoryEnabled: false,
    evimedCreditsEnabled: true, researchBillingEnabled: true, evimedCreditsPerCny: 1,
    evimedCreditsUrl: "https://wallet.evimed.com/deduct", evimedCreditsBalanceUrl: "https://wallet.evimed.com/balance",
    evimedApiKey: "composition-test-only-key",
    evimedCreditsFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.userId, "composition-upstream-user");
      if (String(url) === "https://wallet.evimed.com/balance") {
        return Response.json({ code: 200, data: { balance: walletBalance, frozen: 0 } });
      }
      assert.equal(String(url), "https://wallet.evimed.com/deduct");
      deductions.push(body);
      walletBalance -= body.credits;
      return Response.json({ code: 200, data: { receiptId: "composition-receipt", balance: walletBalance } });
    },
  });
  const userId = `composition_${randomUUID()}`;
  t.after(async () => {
    await app.store.database.query("DELETE FROM evimed_credits.research_task_requests WHERE run_id IN (SELECT run_id FROM evimed_credits.research_tasks WHERE user_id=$1)", [userId]);
    await app.store.database.query("DELETE FROM evimed_credits.research_tasks WHERE user_id=$1", [userId]);
    await app.store.database.query("DELETE FROM evimed_credits.settlements WHERE user_id=$1", [userId]);
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const user = await app.store.upsertExternalUser(userId, "Composition fixture", "evimed", { evimedUserId: "composition-upstream-user" });
  const epoch = "2026-10-03T00:00:00.123456Z";
  const generation = await app.store.database.query("UPDATE evimed_control.users SET created_at=$2::timestamptz WHERE id=$1 RETURNING created_at::text AS epoch", [userId, epoch]);
  const project = await app.store.projectFor(user, "default");
  assert.equal(project.accountCreatedAt, generation.rows[0].epoch);
  assert.match(project.accountCreatedAt, /123456/);
  const sessionId = `session_${randomUUID()}`;
  const binding = await app.researchSessions.put(project, sessionId, { mode: "open-domain" });
  const created = await app.agentRuns.createRun(project, binding, { baselineCursor: null });
  const persisted = (await app.agentRuns.list(project)).find(run => run.id === created.id);
  assert.equal(persisted.accountCreatedAt, project.accountCreatedAt);
  for (const [purpose, actualCost] of [["kernel", 2.75], ["title", 3]]) {
    await app.usageLedger.recordSettled({ id: `usage_${randomUUID()}`, userId, projectId: project.id, runId: created.id,
      purpose, actualCost, model: "fixture-model", priceVersion: "fixture-price", currency: "CNY", priced: true,
      requestFingerprint: "f".repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 } });
  }
  const completed = { ...persisted, status: "completed", finishedAt: new Date().toISOString() };
  await app.agentRuns.onRunFinished(project, completed);
  await app.agentRuns.onRunFinished(project, completed);
  assert.equal(settlementInputs.length, 2);
  assert.ok(settlementInputs.every(run => run.accountCreatedAt === project.accountCreatedAt), "composition must forward the persisted exact generation");
  assert.equal(deductions.length, 1);
  assert.equal(deductions[0].requestId, created.id);
  assert.equal(deductions[0].credits, 2);
  const receipt = await app.store.database.query("SELECT status,owner_created_at::text AS epoch,receipt_id FROM evimed_credits.settlements WHERE run_id=$1", [created.id]);
  assert.equal(receipt.rows[0].epoch, project.accountCreatedAt);
  assert.equal(receipt.rows[0].status, "settled");
  assert.equal(receipt.rows[0].receipt_id, "composition-receipt");

  let cookie = "";
  await app.store.createSession(user, { headers: {}, socket: {} }, { getHeader() { return undefined; }, setHeader(name, value) {
    if (name.toLowerCase() === "set-cookie") cookie = String(value).split(";")[0];
  } });
  const allowanceResponse = await fetch(`${base}/api/account/allowance`, { headers: { Cookie: cookie } });
  assert.equal(allowanceResponse.status, 200);
  const allowance = (await allowanceResponse.json()).data;
  assert.equal(allowance.available, 98);
  assert.equal(allowance.month.paid, 2);
  assert.equal(allowance.month.pending, 0);
  const statementResponse = await fetch(`${base}/api/account/allowance/statements`, { headers: { Cookie: cookie } });
  assert.equal(statementResponse.status, 200);
  const statement = (await statementResponse.json()).data.items.find(item => item.runId === created.id);
  assert.equal(statement.status, "settled");
  assert.equal(statement.amount, '2.00000000');
  assert.equal(statement.actualCny, "5.75000000");
  assert.equal(statement.platformCostCny, "3.00000000");
});
