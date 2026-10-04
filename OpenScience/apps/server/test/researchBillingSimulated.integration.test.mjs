// Research-allowance billing on a simulated wallet, over a real PostgreSQL and the
// real application: a balance from the first read, an estimate, a charge for a
// finished task from what it really cost, statements that carry the allowance and
// the top-ups, the refusal at the start, an unknown result retried on the run id,
// the two wallets' rows kept apart, and a wallet that goes with its account.
//
// Like every integration file it runs in a database of its own
// (`scripts/ops/test-product-state.mjs`): activating the research-allowance
// policy is a once-only fact of a whole ledger, and nothing here assumes a
// policy that is not its own.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SIMULATED_LOW_CREDITS, SIMULATED_WALLET_PAGES } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EVIMED_CREDITS_BACKOFF_MS, EvimedCreditsService } from "../src/evimedCreditsService.mjs";
import { createEvimedCreditsClient, EvimedCreditsError } from "../src/evimedCreditsClient.mjs";
import {
  SIMULATED_INCARNATION_SQL, SIMULATED_WALLET_BALANCE_URL, SIMULATED_WALLET_DEDUCT_URL, SIMULATED_WALLET_KEY,
  SimulatedWallet, createSimulatedWalletFetch, simulatedPayerId,
} from "../src/evimedCreditsSimulator.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const START = 60;
const PASSWORD = "test-only-simulated-billing-password";

/** The application, a signed-in account factory, and everything it created, cleaned up. */
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-simulated-billing-"));
  const app = createWebApiApp({
    dataDir, databaseUrl, stateStore: "postgres", requireSharedStateStore: true, runtimeMode: "mock", production: false,
    authMode: "local", devAuth: false, bootstrapUser: "", bootstrapPassword: "", deepseekProviderEnabled: false, researchMemoryEnabled: false,
    llmRoutingEnabled: false,
    evimedCreditsEnabled: true, evimedCreditsSimulated: true, evimedCreditsSimulatedStartCredits: START, researchBillingEnabled: true,
    evimedCreditsPerCny: 1, evimedCreditsUrl: "", evimedCreditsBalanceUrl: "", ...overrides,
  });
  const database = app.store.database;
  const users = [];
  t.after(async () => {
    for (const id of users) {
      await database.query("DELETE FROM evimed_credits.research_task_requests WHERE run_id IN (SELECT run_id FROM evimed_credits.research_tasks WHERE user_id=$1)", [id]);
      await database.query("DELETE FROM evimed_credits.research_tasks WHERE user_id=$1", [id]);
      await database.query("DELETE FROM evimed_credits.settlements WHERE user_id=$1", [id]);
      await database.query("DELETE FROM evimed_credits.simulated_wallets WHERE user_id=$1", [id]);
      await database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]);
    }
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  async function signIn(name = `sim${randomUUID().replaceAll("-", "").slice(0, 12)}`) {
    const user = await app.store.createUser(name, PASSWORD, "Simulated billing fixture");
    users.push(user.id);
    const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, password: PASSWORD }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    return { user, headers: { cookie: response.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": body.data.csrfToken, "x-open-science-project": "default" } };
  }
  const get = async (route, session) => {
    const response = await fetch(`${base}${route}`, { headers: session.headers });
    return { status: response.status, body: await response.json() };
  };
  const send = async (method, route, session, body) => {
    const response = await fetch(`${base}${route}`, { method, headers: { ...session.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  /** A research run for the account, with what its model calls really cost, finished the way the ledger finishes one. */
  async function finishedRun(session, costs) {
    // The full account record (the sign-in's `createUser` answers the public one).
    const project = await app.store.projectFor(await app.store.userById(session.user.id), "default");
    const sessionId = `session_${randomUUID()}`;
    const binding = await app.researchSessions.put(project, sessionId, { mode: "open-domain" });
    const created = await app.agentRuns.createRun(project, binding, { baselineCursor: null });
    const persisted = (await app.agentRuns.list(project)).find((run) => run.id === created.id);
    for (const [purpose, actualCost] of costs) {
      await app.usageLedger.recordSettled({ id: `usage_${randomUUID()}`, userId: session.user.id, projectId: project.id, runId: created.id,
        purpose, actualCost, model: "fixture-model", priceVersion: "fixture-price", currency: "CNY", priced: true,
        requestFingerprint: "f".repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 } });
    }
    const finish = async () => app.agentRuns.onRunFinished(project, { ...persisted, status: "completed", finishedAt: new Date().toISOString() });
    return { runId: created.id, project, finish };
  }
  const payerOf = async (userId) => simulatedPayerId(userId, (await database.query(
    `SELECT ${SIMULATED_INCARNATION_SQL} AS incarnation FROM evimed_control.users u WHERE u.id=$1`, [userId])).rows[0].incarnation);
  return { app, database, base, signIn, get, send, finishedRun, payerOf, users };
}

test("a balance from the first read, an estimate, a charge from what a task really cost, and statements that carry the allowance and the charge", options, async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const first = (await f.get("/api/account/allowance", owner)).body.data;
  assert.deepEqual([first.enabled, first.simulated, first.status, first.available, first.lowThreshold], [true, true, "ready", START, SIMULATED_LOW_CREDITS]);
  assert.deepEqual(first.month, { since: first.month.since, paid: 0, pending: 0 });
  assert.deepEqual(first.commerce, { rechargeUrl: SIMULATED_WALLET_PAGES.recharge, membershipUrl: SIMULATED_WALLET_PAGES.membership,
    ordersUrl: SIMULATED_WALLET_PAGES.orders, refundsUrl: SIMULATED_WALLET_PAGES.refunds });
  // The first read granted the starting allowance, once: reading again changes nothing.
  assert.equal((await f.get("/api/account/allowance", owner)).body.data.available, START);
  const opening = (await f.get("/api/account/allowance/statements", owner)).body.data;
  assert.equal(opening.simulated, true);
  assert.deepEqual(opening.items.map((item) => [item.kind, item.title, item.amount, item.runId, item.simulated]), [["grant", "模拟初始额度", START, null, true]]);

  const estimate = (await f.get("/api/account/allowance/estimate?capability=adr-analysis", owner)).body.data;
  assert.equal(estimate.simulated, true);
  assert.equal(estimate.basis, "manifest");
  assert.ok(estimate.low > 0 && estimate.high >= estimate.low && estimate.binding === false);
  const bulk = (await f.get("/api/account/allowance/estimates?capabilities=adr-analysis,meta-analysis", owner)).body.data;
  assert.deepEqual(bulk.items.map((item) => item.capabilityId), ["adr-analysis", "meta-analysis"]);
  assert.equal(bulk.simulated, true);

  // A finished task is charged what it really cost, in whole credits: 2.75 of research and 3 of the platform's own overhead.
  const run = await f.finishedRun(owner, [["kernel", 2.75], ["title", 3]]);
  await run.finish();
  await run.finish();
  const after = (await f.get("/api/account/allowance", owner)).body.data;
  assert.equal(after.available, START - 2, "charged once, however many times the completion is delivered");
  assert.deepEqual([after.month.paid, after.month.pending], [2, 0]);
  const statements = (await f.get("/api/account/allowance/statements", owner)).body.data;
  const charge = statements.items.find((item) => item.runId === run.runId);
  assert.deepEqual([charge.kind, charge.simulated, charge.status, charge.amount, charge.actualCny, charge.platformCostCny],
    ["charge", true, "settled", 2, "5.75000000", "3.00000000"]);
  assert.deepEqual(statements.items.map((item) => item.kind).sort(), ["charge", "grant"]);

  // The platform's own rows say which wallet they were charged to, for ever.
  const settlement = (await f.database.query("SELECT * FROM evimed_credits.settlements WHERE run_id=$1", [run.runId])).rows[0];
  assert.deepEqual([settlement.wallet, settlement.status, Number(settlement.credits)], ["simulated", "settled", 2]);
  assert.match(settlement.receipt_id, /^sim_rcpt_/);
  assert.equal(settlement.upstream_user_id, await f.payerOf(owner.user.id));
  assert.equal((await f.database.query("SELECT wallet FROM evimed_credits.research_tasks WHERE run_id=$1", [run.runId])).rows[0].wallet, "simulated");
  // One debit in the wallet's own ledger, for that run id.
  const entries = (await f.database.query("SELECT kind,credits FROM evimed_credits.simulated_entries e JOIN evimed_credits.simulated_wallets w ON w.payer=e.payer WHERE w.user_id=$1 ORDER BY entry_id", [owner.user.id])).rows;
  assert.deepEqual(entries.map((entry) => [entry.kind, Number(entry.credits)]), [["grant", START], ["deduct", 2]]);
  // Another account's allowance is its own.
  const other = await f.signIn();
  assert.equal((await f.get("/api/account/allowance", other)).body.data.available, START);
  assert.equal((await f.get("/api/account/allowance/statements", other)).body.data.items.length, 1);
});

test("a top-up adds simulated credits once per request, shows in statements and orders, and releases a start the allowance had refused", options, async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const wallet = new SimulatedWallet({ database: f.database, startCredits: START });
  await f.get("/api/account/allowance", owner);
  const payer = await f.payerOf(owner.user.id);
  // Spend the allowance to nothing: a start is then refused before any run exists, with the code that says 模拟.
  await wallet.deduct({ payer, requestId: `run_${randomUUID()}`, credits: START });
  assert.equal((await f.get("/api/account/allowance", owner)).body.data.available, 0);
  assert.equal((await f.send("PUT", `/api/research-sessions/${encodeURIComponent("ses_gate")}`, owner, { mode: "open-domain" })).status, 200);
  const refused = await f.send("POST", "/api/agent-runs/dispatch", owner, { sessionId: "ses_gate", dispatchId: `turn_${randomUUID().slice(0, 8)}`, text: "你好" });
  assert.deepEqual([refused.status, refused.body.code], [402, "simulated_credits_exhausted"]);
  assert.equal((await f.get("/api/agent-runs", owner)).body.data.length, 0, "no run exists after a refused start");

  const requestId = `page-${randomUUID().slice(0, 12)}`;
  const topup = await f.send("POST", "/api/simulated-wallet/topups", owner, { packageId: "topup-100", requestId });
  assert.equal(topup.status, 201);
  assert.deepEqual([topup.body.data.simulated, topup.body.data.available, topup.body.data.duplicate, topup.body.data.order.amount], [true, 100, false, 100]);
  const again = await f.send("POST", "/api/simulated-wallet/topups", owner, { packageId: "topup-100", requestId });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.data.duplicate, again.body.data.available, again.body.data.order.id], [true, 100, topup.body.data.order.id]);
  assert.equal((await f.get("/api/account/allowance", owner)).body.data.available, 100, "a retried top-up added nothing");
  const items = (await f.get("/api/account/allowance/statements", owner)).body.data.items;
  const credit = items.find((item) => item.kind === "topup");
  assert.deepEqual([credit.title, credit.amount, credit.status, credit.runId, credit.simulated], ["模拟充值", 100, "settled", null, true]);
  const orders = (await f.get("/api/simulated-wallet/orders", owner)).body.data;
  assert.deepEqual([orders.simulated, orders.items.length, orders.items[0].amount, orders.items[0].packageId], [true, 1, 100, "topup-100"]);
  // A top-up for a package that is not on the list adds nothing.
  assert.equal((await f.send("POST", "/api/simulated-wallet/topups", owner, { packageId: "topup-7", requestId: `page-${randomUUID().slice(0, 12)}` })).body.code, "simulated_wallet_request_invalid");
  // The refused start now goes ahead: whatever it does next, it is not refused for the allowance.
  const released = await f.send("POST", "/api/agent-runs/dispatch", owner, { sessionId: "ses_gate", dispatchId: `turn_${randomUUID().slice(0, 8)}`, text: "你好" });
  assert.notEqual(released.body.code, "simulated_credits_exhausted");
  assert.notEqual(released.status, 402);
  // One account's orders are not another's.
  const stranger = await f.signIn();
  assert.deepEqual((await f.get("/api/simulated-wallet/orders", stranger)).body.data.items, []);
});

test("an unknown result is retried on the run id and charges once, and a simulated row can never be swept by a real wallet or the reverse", options, async (t) => {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 3_000 });
  const userId = `sim_unknown_${randomUUID().replaceAll("-", "")}`;
  const liveUserId = `sim_live_${randomUUID().replaceAll("-", "")}`;
  t.after(async () => {
    await database.query("DELETE FROM evimed_credits.research_task_requests WHERE run_id IN (SELECT run_id FROM evimed_credits.research_tasks WHERE user_id=ANY($1::text[]))", [[userId, liveUserId]]).catch(() => {});
    await database.query("DELETE FROM evimed_credits.research_tasks WHERE user_id=ANY($1::text[])", [[userId, liveUserId]]).catch(() => {});
    await database.query("DELETE FROM evimed_credits.settlements WHERE user_id=ANY($1::text[])", [[userId, liveUserId]]).catch(() => {});
    await database.query("DELETE FROM evimed_credits.simulated_wallets WHERE user_id=ANY($1::text[])", [[userId, liveUserId]]).catch(() => {});
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[userId, liveUserId]]).catch(() => {});
    await database.close();
  });
  await database.migrate();
  for (const id of [userId, liveUserId]) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Simulated unknown result','development')", [id]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [id]);
  }
  const wallet = new SimulatedWallet({ database, startCredits: 100 });
  let lose = true;
  const client = createEvimedCreditsClient({
    deductUrl: SIMULATED_WALLET_DEDUCT_URL, balanceUrl: SIMULATED_WALLET_BALANCE_URL, apiKey: SIMULATED_WALLET_KEY, simulated: true,
    fetchImpl: createSimulatedWalletFetch(wallet, { after: (operation) => {
      if (operation === "deduct" && lose) throw Object.assign(new Error("the answer never arrived"), { name: "TimeoutError" });
    } }),
  });
  const usage = new UsageLedger(database);
  let clock = new Date();
  const simulatedConfig = { evimedCreditsEnabled: true, evimedCreditsSimulated: true, evimedCreditsPerCny: 1, researchBillingEnabled: true };
  const service = new EvimedCreditsService({ config: simulatedConfig, database, client, simulator: wallet, usageLedger: usage, now: () => clock });
  assert.equal(await service.ensureReady(), null);
  const accountCreatedAt = (await database.query("SELECT created_at::text AS epoch FROM evimed_control.users WHERE id=$1", [userId])).rows[0].epoch;
  const runId = `run_${randomUUID()}`;
  await usage.recordSettled({ id: `usage_${randomUUID()}`, userId, projectId: "default", runId, purpose: "kernel", model: "fixture-model", priceVersion: "fixture-price",
    currency: "CNY", requestFingerprint: "a".repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 }, actualCost: 2.75, priced: true });
  const finished = { userId, projectId: "default", runId, status: "completed", subject: "模拟重试", startedAt: new Date(Date.now() - 60_000).toISOString(), accountCreatedAt };
  await service.balanceFor(userId);
  // The wallet took the credits and the answer was lost: the settlement is pending, and so is the money in the statement.
  assert.deepEqual(await service.settleRun(finished), { status: "pending", credits: 2, errorCode: "evimed_credits_timeout" });
  const payer = await simulatedPayerOf(database, userId);
  assert.equal((await wallet.balance(payer)).balance, 98, "the debit stands though the caller could not tell");
  const pending = (await service.statements(userId)).items.find((item) => item.runId === runId);
  assert.deepEqual([pending.status, pending.amount, pending.requestedAmount, pending.simulated], ["pending", null, 2, true]);
  const summary = await service.allowanceSummary(userId, { since: new Date(Date.now() - 3_600_000) });
  assert.deepEqual([summary.pendingCny, summary.spentCny, summary.simulated], [2, 0, true]);

  // A real wallet's sweep, due now, never touches that row — and is never handed it.
  clock = new Date(clock.getTime() + EVIMED_CREDITS_BACKOFF_MS[0] + 1_000);
  /** @type {any[]} */
  const realCalls = [];
  const real = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 1, researchBillingEnabled: true }, database, usageLedger: usage,
    evimedUserIdOf: async () => null, now: () => clock,
    client: { configured: true, status: () => ({ configured: true }), async deduct(/** @type {any} */ request) { realCalls.push(request); throw new EvimedCreditsError("evimed_credits_unreachable", "must not be called"); } } });
  assert.equal(await real.retryDue(), 0);
  assert.deepEqual(realCalls, []);
  assert.equal((await real.statements(userId)).items.length, 0, "a real wallet's statement holds no simulated charge");
  assert.equal((await real.allowanceSummary(userId, { since: new Date(Date.now() - 3_600_000) })).pendingCny, 0);
  // A real pending row is not the simulated sweep's either.
  const livePending = `run_${randomUUID()}`;
  await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,memo,cost_cny,credits,credits_per_cny,status,attempts,next_attempt_at,owner_created_at,upstream_user_id)
    SELECT $1,id,'Real pending',1,1,1,'pending',1,$3::timestamptz,created_at,'98211' FROM evimed_control.users WHERE id=$2`,
  [livePending, liveUserId, new Date(clock.getTime() - 1_000).toISOString()]);

  // The answer comes back this time: the sweep sends the same run id, the wallet answers the original receipt, and the money moves once.
  lose = false;
  assert.equal(await service.retryDue(), 1, "only its own pending row is swept");
  const settled = (await service.statements(userId)).items.find((item) => item.runId === runId);
  assert.deepEqual([settled.status, settled.amount], ["settled", 2]);
  assert.equal((await wallet.balance(payer)).balance, 98, "one run, one charge");
  const row = (await database.query("SELECT status,receipt_id,wallet FROM evimed_credits.settlements WHERE run_id=$1", [runId])).rows[0];
  assert.deepEqual([row.status, row.wallet], ["settled", "simulated"]);
  assert.match(row.receipt_id, /^sim_rcpt_/);
  assert.equal((await database.query("SELECT status FROM evimed_credits.settlements WHERE run_id=$1", [livePending])).rows[0].status, "pending", "a real row is left exactly as it was");
  assert.equal(await service.retryDue(), 0);
});

/** @param {any} database @param {string} userId */
async function simulatedPayerOf(database, userId) {
  const row = (await database.query(`SELECT ${SIMULATED_INCARNATION_SQL} AS incarnation FROM evimed_control.users u WHERE u.id=$1`, [userId])).rows[0];
  return simulatedPayerId(userId, row.incarnation);
}

test("a wallet goes with its account, a financial row stays marked and redacted, and a re-registered name starts a new wallet", options, async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const run = await f.finishedRun(owner, [["kernel", 3.2]]);
  await run.finish();
  assert.equal((await f.get("/api/account/allowance", owner)).body.data.available, START - 3);
  const payer = await f.payerOf(owner.user.id);
  const deletion = await fetch(`${f.base}/api/account`, { method: "DELETE", headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ confirm: owner.user.id, password: PASSWORD }) });
  assert.equal(deletion.status, 200, JSON.stringify(await deletion.json()));
  assert.equal((await f.database.query("SELECT 1 FROM evimed_credits.simulated_wallets WHERE payer=$1", [payer])).rowCount, 0, "the wallet went with the account");
  assert.equal((await f.database.query("SELECT 1 FROM evimed_credits.simulated_entries WHERE payer=$1", [payer])).rowCount, 0);
  // The platform's own record of the charge stays, marked simulated, with the subject gone.
  const kept = (await f.database.query("SELECT wallet,title FROM evimed_credits.research_tasks WHERE run_id=$1", [run.runId])).rows[0];
  assert.deepEqual([kept.wallet, kept.title], ["simulated", "Research task"]);
  const registration = await fetch(`${f.base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: owner.user.id, password: PASSWORD, name: "A new account of the same name" }) });
  const registered = await registration.json();
  assert.equal(registration.status, 201, JSON.stringify(registered));
  const again = { user: owner.user, headers: { cookie: registration.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": registered.data.csrfToken, "x-open-science-project": "default" } };
  const fresh = (await f.get("/api/account/allowance", again)).body.data;
  assert.equal(fresh.available, START, "a new incarnation starts from the allowance, not the old wallet");
  assert.deepEqual([fresh.month.paid, fresh.month.pending], [0, 0]);
  assert.deepEqual((await f.get("/api/account/allowance/statements", again)).body.data.items.map((item) => item.kind), ["grant"]);
  assert.notEqual(await f.payerOf(owner.user.id), payer, "the same name is a different payer");
});
