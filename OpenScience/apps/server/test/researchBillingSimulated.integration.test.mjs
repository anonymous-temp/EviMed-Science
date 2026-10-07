// Research-allowance billing on the platform's own wallet, over a real PostgreSQL
// and the real application: a balance from the first read, an estimate, an exact
// charge for a finished task from what it really cost, statements that carry the
// gifts, the top-ups and the charges, the refusal at the start, the two wallets'
// rows kept apart (and the pending row the one-number wallet could leave), and a
// wallet that goes with its account. The wallet's own properties — lots, holds,
// races — are `evimedCreditsWallet.integration.test.mjs`; the billing service's are
// `evimedCreditsPlatform.integration.test.mjs`.
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
import { EvimedCreditsError } from "../src/evimedCreditsClient.mjs";
import { SIMULATED_INCARNATION_SQL, SimulatedWallet, simulatedPayerId } from "../src/evimedCreditsSimulator.mjs";
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

test("a balance from the first read, an estimate, an exact charge from what a task really cost, and statements that carry the gift and the charge", options, async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const first = (await f.get("/api/account/allowance", owner)).body.data;
  assert.deepEqual([first.enabled, first.simulated, first.status, first.available, first.lowThreshold, first.low], [true, true, "ready", "60.00000000", SIMULATED_LOW_CREDITS, false]);
  // 可用 = 充值 + 赠送 − 冻结, each given beside it, and the next gift to end.
  assert.deepEqual([first.balances, first.held], [{ purchased: "0.00000000", gifted: "60.00000000" }, "0.00000000"]);
  assert.deepEqual([first.nextExpiry.amount, Number.isFinite(Date.parse(first.nextExpiry.at))], ["60.00000000", true]);
  assert.deepEqual(first.month, { since: first.month.since, paid: 0, pending: 0 });
  assert.deepEqual(first.commerce, { rechargeUrl: SIMULATED_WALLET_PAGES.recharge, membershipUrl: SIMULATED_WALLET_PAGES.membership,
    ordersUrl: SIMULATED_WALLET_PAGES.orders, refundsUrl: SIMULATED_WALLET_PAGES.refunds });
  // The first read granted the sign-up gift, once: reading again changes nothing.
  assert.equal((await f.get("/api/account/allowance", owner)).body.data.available, "60.00000000");
  const opening = (await f.get("/api/account/allowance/statements", owner)).body.data;
  assert.equal(opening.simulated, true);
  assert.deepEqual(opening.items.map((item) => [item.kind, item.title, item.amount, item.runId, item.simulated, item.sourceLabel]), [["grant", "模拟赠送 · 注册赠送", "60.00000000", null, true, "注册赠送"]]);
  assert.equal(opening.items[0].expiresAt, first.nextExpiry.at, "the line says when the gift ends");

  const estimate = (await f.get("/api/account/allowance/estimate?capability=adr-analysis", owner)).body.data;
  assert.equal(estimate.simulated, true);
  assert.equal(estimate.basis, "manifest");
  assert.ok(estimate.low > 0 && estimate.high >= estimate.low && estimate.binding === false);
  const bulk = (await f.get("/api/account/allowance/estimates?capabilities=adr-analysis,meta-analysis", owner)).body.data;
  assert.deepEqual(bulk.items.map((item) => item.capabilityId), ["adr-analysis", "meta-analysis"]);
  assert.equal(bulk.simulated, true);

  // A finished task is charged exactly what it really cost: 2.75 of research, and 3 of the platform's own overhead that is not the researcher's.
  const run = await f.finishedRun(owner, [["kernel", 2.75], ["title", 3]]);
  await run.finish();
  await run.finish();
  const after = (await f.get("/api/account/allowance", owner)).body.data;
  assert.equal(after.available, "57.25000000", "charged once, however many times the completion is delivered, and not rounded");
  assert.deepEqual([after.month.paid, after.month.pending], [2.75, 0]);
  const statements = (await f.get("/api/account/allowance/statements", owner)).body.data;
  const charge = statements.items.find((item) => item.runId === run.runId);
  assert.deepEqual([charge.kind, charge.simulated, charge.status, charge.amount, charge.actualCny, charge.platformCostCny, charge.balanceAfter],
    ["charge", true, "settled", "2.75000000", "5.75000000", "3.00000000", "57.25000000"]);
  assert.deepEqual(charge.paidBy, { gifted: "2.75000000", purchased: "0.00000000" });
  assert.deepEqual(statements.items.map((item) => item.kind).sort(), ["charge", "grant"]);
  // On request: what the charge is made of.
  const detail = (await f.get(`/api/account/allowance/statements/${run.runId}`, owner)).body.data;
  assert.deepEqual([detail.detail.calls, detail.detail.cacheHitTokens, detail.detail.cacheMissTokens, detail.detail.outputTokens, detail.detail.amount, detail.detail.priceVersions],
    [1, "0", "1", "1", "2.75000000", ["fixture-price"]]);
  assert.equal((await f.get(`/api/account/allowance/statements/run_${randomUUID()}`, owner)).status, 404);

  // The platform's own rows say which wallet they were charged to, and under which rule, for ever.
  const settlement = (await f.database.query("SELECT * FROM evimed_credits.settlements WHERE run_id=$1", [run.runId])).rows[0];
  assert.deepEqual([settlement.wallet, settlement.status, settlement.credits, settlement.requested, settlement.absorbed, settlement.wallet_contract, settlement.charge_basis],
    ["simulated", "settled", "2.75000000", "2.75000000", "0.00000000", "precision-v1", "completed"]);
  assert.match(settlement.receipt_id, /^sim_rcpt_/);
  assert.equal(settlement.upstream_user_id, await f.payerOf(owner.user.id));
  assert.equal((await f.database.query("SELECT wallet FROM evimed_credits.research_tasks WHERE run_id=$1", [run.runId])).rows[0].wallet, "simulated");
  // One debit in the wallet's own ledger, for that run id.
  const entries = (await f.database.query("SELECT kind,credits::text AS credits FROM evimed_credits.simulated_entries e JOIN evimed_credits.simulated_wallets w ON w.payer=e.payer WHERE w.user_id=$1 ORDER BY entry_id", [owner.user.id])).rows;
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.credits]), [["grant", "60.00000000"], ["deduct", "2.75000000"]]);
  // Another account's allowance is its own.
  const other = await f.signIn();
  assert.equal((await f.get("/api/account/allowance", other)).body.data.available, "60.00000000");
  assert.equal((await f.get("/api/account/allowance/statements", other)).body.data.items.length, 1);
  assert.equal((await f.get(`/api/account/allowance/statements/${run.runId}`, other)).status, 404, "a line is its account's own");
});

test("a top-up adds simulated credits once per request, shows in statements and orders, and releases a start the allowance had refused", options, async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const wallet = new SimulatedWallet({ database: f.database, startCredits: START });
  await f.get("/api/account/allowance", owner);
  const payer = await f.payerOf(owner.user.id);
  // Spend the allowance to nothing: a start is then refused before any run exists, with the code that says 模拟.
  await wallet.settle({ payer, requestId: `run_${randomUUID()}`, amount: START });
  assert.equal((await f.get("/api/account/allowance", owner)).body.data.available, "0.00000000");
  assert.equal((await f.send("PUT", `/api/research-sessions/${encodeURIComponent("ses_gate")}`, owner, { mode: "open-domain" })).status, 200);
  const refused = await f.send("POST", "/api/agent-runs/dispatch", owner, { sessionId: "ses_gate", dispatchId: `turn_${randomUUID().slice(0, 8)}`, text: "你好" });
  assert.deepEqual([refused.status, refused.body.code], [402, "simulated_credits_exhausted"]);
  assert.equal((await f.get("/api/agent-runs", owner)).body.data.length, 0, "no run exists after a refused start");

  const requestId = `page-${randomUUID().slice(0, 12)}`;
  const topup = await f.send("POST", "/api/simulated-wallet/topups", owner, { packageId: "topup-100", requestId });
  assert.equal(topup.status, 201);
  assert.deepEqual([topup.body.data.simulated, topup.body.data.available, topup.body.data.duplicate, topup.body.data.order.amount], [true, "100.00000000", false, 100]);
  const again = await f.send("POST", "/api/simulated-wallet/topups", owner, { packageId: "topup-100", requestId });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.data.duplicate, again.body.data.available, again.body.data.order.id], [true, "100.00000000", topup.body.data.order.id]);
  const read = (await f.get("/api/account/allowance", owner)).body.data;
  assert.deepEqual([read.available, read.balances], ["100.00000000", { purchased: "100.00000000", gifted: "0.00000000" }], "a retried top-up added nothing, and what was bought is told from what was given");
  const items = (await f.get("/api/account/allowance/statements", owner)).body.data.items;
  const credit = items.find((item) => item.kind === "topup");
  assert.deepEqual([credit.title, credit.amount, credit.status, credit.runId, credit.simulated], ["模拟充值", "100.00000000", "settled", null, true]);
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

test("a replay of a dispatch that already started is answered, not refused by the allowance its own start used up (review F8)", options, async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const wallet = new SimulatedWallet({ database: f.database, startCredits: START });
  const payer = await f.payerOf(owner.user.id);
  assert.equal((await f.send("PUT", `/api/research-sessions/ses_replay`, owner, { mode: "open-domain" })).status, 200);
  const dispatchId = `turn_${randomUUID().slice(0, 8)}`;
  const first = await f.send("POST", "/api/agent-runs/dispatch", owner, { sessionId: "ses_replay", dispatchId, text: "你好" });
  assert.ok([200, 202].includes(first.status), JSON.stringify(first.body));
  // The first answer was lost, and by now the account has nothing available — as when the run's own hold froze what was left.
  const left = (await wallet.snapshot(payer)).balance;
  await wallet.settle({ payer, requestId: `run_${randomUUID()}`, amount: left });
  assert.equal((await wallet.snapshot(payer)).available, "0.00000000");
  const again = await f.send("POST", "/api/agent-runs/dispatch", owner, { sessionId: "ses_replay", dispatchId, text: "你好" });
  assert.ok([200, 202].includes(again.status), `the same dispatch, asked again: ${again.status} ${again.body?.code}`);
  assert.equal(again.body.data.id, first.body.data.id, "it is the run that exists");
  // A new dispatch is still asked, and still refused for an empty allowance.
  const fresh = await f.send("POST", "/api/agent-runs/dispatch", owner, { sessionId: "ses_replay", dispatchId: `turn_${randomUUID().slice(0, 8)}`, text: "再问一个" });
  assert.deepEqual([fresh.status, fresh.body.code], [402, "simulated_credits_exhausted"]);
});

test("a run's charge is taken and its hold released even when a step of its completion throws before the settlement (review F7)", options, async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const wallet = new SimulatedWallet({ database: f.database, startCredits: START });
  const payer = await f.payerOf(owner.user.id);
  await wallet.snapshot(payer);
  const run = await f.finishedRun(owner, [["kernel", 2.75]]);
  assert.equal((await wallet.hold({ payer, runId: run.runId, amount: "5", ttlMs: 86_400_000 })).held, "5.00000000");
  // The first thing the completion asks the runtime manager about, ahead of the settlement, fails — once.
  const snapshots = f.app.runtimeManager.evaluationMethodSnapshots;
  const has = snapshots.has.bind(snapshots);
  let asked = 0;
  snapshots.has = (/** @type {any} */ key) => { if (asked++ === 0) throw new Error("a step before the settlement failed"); return has(key); };
  await assert.rejects(run.finish(), /a step before the settlement failed/);
  const hold = (await f.database.query("SELECT status,release_reason FROM evimed_credits.simulated_holds WHERE run_id=$1", [run.runId])).rows[0];
  assert.deepEqual([hold.status, hold.release_reason], ["released", "settled"], "the hold does not wait out its 24 hours");
  const settlement = (await f.database.query("SELECT status,credits::text AS credits FROM evimed_credits.settlements WHERE run_id=$1", [run.runId])).rows[0];
  assert.deepEqual([settlement.status, settlement.credits], ["settled", "2.75000000"], "and the run is charged for what it used");
  assert.deepEqual([(await wallet.snapshot(payer)).balance, (await wallet.snapshot(payer)).frozen], ["57.25000000", "0.00000000"]);
  // Delivered again, as a retry is: nothing more.
  await run.finish();
  assert.equal((await wallet.snapshot(payer)).balance, "57.25000000");
});

test("the two wallets' rows are kept apart: a pending row the one-number wallet left is settled from the platform wallet once, and a real wallet's sweep never touches either", options, async (t) => {
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
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Simulated pending row','development')", [id]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [id]);
  }
  const wallet = new SimulatedWallet({ database, startCredits: 100 });
  let clock = new Date();
  const simulatedConfig = { evimedCreditsEnabled: true, evimedCreditsSimulated: true, evimedCreditsPerCny: 1, researchBillingEnabled: true };
  const service = new EvimedCreditsService({ config: simulatedConfig, database, client: null, simulator: wallet, now: () => clock });
  assert.equal(await service.ensureReady(), null);
  const payer = await simulatedPayerOf(database, userId);
  await service.balanceFor(userId);
  // The one-number wallet's outbox: a charge of 2 credits it asked for and never got an answer to.
  const runId = `run_${randomUUID()}`;
  await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,memo,cost_cny,credits,credits_per_cny,status,attempts,next_attempt_at,owner_created_at,upstream_user_id,wallet)
    SELECT $1,id,'Pending from before',2.75,2,1,'pending',1,$3::timestamptz,created_at,$4,'simulated' FROM evimed_control.users WHERE id=$2`,
  [runId, userId, new Date(clock.getTime() - 1_000).toISOString(), payer]);
  const pending = (await service.statements(userId)).items.find((item) => item.runId === runId);
  assert.deepEqual([pending.status, pending.amount, pending.requestedAmount, pending.simulated], ["pending", null, "2.00000000", true]);

  // A real wallet's sweep, due now, never touches that row — and is never handed it.
  clock = new Date(clock.getTime() + EVIMED_CREDITS_BACKOFF_MS[0] + 1_000);
  /** @type {any[]} */
  const realCalls = [];
  const real = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 1, researchBillingEnabled: true }, database,
    evimedUserIdOf: async () => null, now: () => clock,
    client: { configured: true, status: () => ({ configured: true }), async deduct(/** @type {any} */ request) { realCalls.push(request); throw new EvimedCreditsError("evimed_credits_unreachable", "must not be called"); } } });
  assert.equal(await real.retryDue(), 0);
  assert.deepEqual(realCalls, []);
  assert.equal((await real.statements(userId)).items.length, 0, "a real wallet's statement holds no simulated charge");
  // A real pending row is not the platform wallet's sweep either.
  const livePending = `run_${randomUUID()}`;
  await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,memo,cost_cny,credits,credits_per_cny,status,attempts,next_attempt_at,owner_created_at,upstream_user_id)
    SELECT $1,id,'Real pending',1,1,1,'pending',1,$3::timestamptz,created_at,'98211' FROM evimed_control.users WHERE id=$2`,
  [livePending, liveUserId, new Date(clock.getTime() - 1_000).toISOString()]);

  // The platform wallet's own sweep settles its row from the wallet: once, whole credits as asked.
  assert.equal(await service.retryDue(), 1, "only its own pending row is swept");
  const settled = (await service.statements(userId)).items.find((item) => item.runId === runId);
  assert.deepEqual([settled.status, settled.amount], ["settled", "2.00000000"]);
  assert.equal((await wallet.snapshot(payer)).balance, "98.00000000", "one run, one charge");
  const row = (await database.query("SELECT status,receipt_id,wallet FROM evimed_credits.settlements WHERE run_id=$1", [runId])).rows[0];
  assert.deepEqual([row.status, row.wallet], ["settled", "simulated"]);
  assert.match(row.receipt_id, /^sim_rcpt_/);
  assert.equal((await database.query("SELECT status FROM evimed_credits.settlements WHERE run_id=$1", [livePending])).rows[0].status, "pending", "a real row is left exactly as it was");
  assert.equal(await service.retryDue(), 0);
  assert.equal((await wallet.snapshot(payer)).balance, "98.00000000");
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
  assert.equal((await f.get("/api/account/allowance", owner)).body.data.available, "56.80000000", "60 less exactly 3.20");
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
  assert.equal(fresh.available, "60.00000000", "a new incarnation starts from the sign-up gift, not the old wallet");
  assert.deepEqual([fresh.month.paid, fresh.month.pending], [0, 0]);
  assert.deepEqual((await f.get("/api/account/allowance/statements", again)).body.data.items.map((item) => item.kind), ["grant"]);
  assert.notEqual(await f.payerOf(owner.user.id), payer, "the same name is a different payer");
});

test("a charge the one-number wallet took before the lots says the balance it left, read from its deduct entry", options, async (t) => {
  // Live check of 2026-10-05: an account's 28 charges from before the lots read 「余额 —」, because the old
  // wallet wrote the balance on its deduct entry and never in the charge's evidence.
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 3_000 });
  const userId = `sim_legacy_${randomUUID().replaceAll("-", "")}`;
  t.after(async () => {
    await database.query("DELETE FROM evimed_credits.research_tasks WHERE user_id=$1", [userId]).catch(() => {});
    await database.query("DELETE FROM evimed_credits.simulated_wallets WHERE user_id=$1", [userId]).catch(() => {});
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]).catch(() => {});
    await database.close();
  });
  await database.migrate();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Legacy statement','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [userId]);
  const wallet = new SimulatedWallet({ database, startCredits: 100 });
  const service = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsSimulated: true, evimedCreditsPerCny: 1, researchBillingEnabled: true },
    database, client: null, simulator: wallet });
  assert.equal(await service.ensureReady(), null);
  await service.balanceFor(userId);
  const payer = await simulatedPayerOf(database, userId);
  const runId = `run_${randomUUID()}`;
  await database.query(`INSERT INTO evimed_credits.research_tasks(run_id,user_id,title,evidence,created_at,status,settled_at,owner_created_at,wallet)
    SELECT $1,id,'深度研究 · before the lots',$3::jsonb,clock_timestamp(),'settled',clock_timestamp(),created_at,'simulated' FROM evimed_control.users WHERE id=$2`,
  [runId, userId, JSON.stringify({ pricingVersion: "research-allowance-v1-20261003", walletContract: "legacy-integer-floor", actualCny: "3.41000000",
    billableCny: "3.41000000", eligibleCny: "3.41000000", chargedCny: "3.00000000", creditsAmount: "3.00000000", waivedCny: "0.41000000", platformCostCny: "0.00000000", evidence: [] })]);
  await database.query("INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id) VALUES($1,'deduct',$2,3,97,'sim_rcpt_fixture')", [payer, runId]);
  const line = (await service.statements(userId)).items.find((item) => item.runId === runId);
  assert.ok(line, "the old charge is on the statement");
  assert.equal(line.balanceAfter, "97.00000000");
});
