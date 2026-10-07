// The platform wallet's billing, end to end through the service, over a real
// PostgreSQL: the exact charge, the stop rule, the shortfall the platform
// carries, the hold a commissioned run freezes, the start check in exact units,
// the gifts and their reminders, and a statement that adds up.
//
// Like every integration file it runs in a database of its own
// (`scripts/ops/test-product-state.mjs`): activating a billing policy is a
// once-only fact of a whole ledger. This file sets the two activations it needs
// itself, and nothing here assumes a policy that is not its own.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { RESEARCH_BILLING_VERSION, researchMoneyDecimal, researchMoneyUnits } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvimedCreditsService, chargeDecision } from "../src/evimedCreditsService.mjs";
import { SIMULATED_INCARNATION_SQL, SimulatedWallet, simulatedPayerId } from "../src/evimedCreditsSimulator.mjs";
import { createEvimedCreditsRoutes } from "../src/evimedCreditsRoutes.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { auditWallet, clock, databaseOptions as options, databaseUrl } from "./helpers/creditWalletFixture.mjs";
import { SimulatedWallet as LegacyWallet } from "./helpers/legacyOneNumberWallet.mjs";

const DAY = 86_400_000;
/** @type {any} */
let database;
/** @type {UsageLedger} */
let usage;
/** @type {NotificationService} */
let inbox;
/** @type {string[]} */
const accounts = [];
const config = { evimedCreditsEnabled: true, evimedCreditsSimulated: true, evimedCreditsPerCny: 1, researchBillingEnabled: true };

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 8, databaseConnectionTimeoutMs: 3_000 });
  await database.migrate();
  usage = new UsageLedger(database);
  inbox = new NotificationService(database);
  // This file's own policies: both rules activated now, so a run that starts from now on is under the exact rule.
  const seed = new EvimedCreditsService({ config, database, client: null, simulator: new SimulatedWallet({ database }), now: () => new Date() });
  await seed.ready();
  await database.query("DELETE FROM evimed_credits.research_policy");
  await database.query("DELETE FROM evimed_credits.billing_policies");
  await seed.ready();
});

after(async () => {
  if (!databaseUrl) return;
  for (const id of accounts) {
    await database.query("DELETE FROM evimed_credits.research_task_requests WHERE run_id IN (SELECT run_id FROM evimed_credits.research_tasks WHERE user_id=$1)", [id]).catch(() => {});
    await database.query("DELETE FROM evimed_credits.research_tasks WHERE user_id=$1", [id]).catch(() => {});
    await database.query("DELETE FROM evimed_credits.settlements WHERE user_id=$1", [id]).catch(() => {});
    await database.query("DELETE FROM evimed_credits.simulated_wallets WHERE user_id=$1", [id]).catch(() => {});
    await database.query("DELETE FROM evimed_inbox.notifications WHERE user_id=$1", [id]).catch(() => {});
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]).catch(() => {});
  }
  await database.close?.();
});

/**
 * One account with a wallet and a billing service on a clock of its own.
 * @param {{ startCredits?: number, signupGiftDays?: number, monthlyGift?: string | number, serviceConfig?: Record<string, any>, tick?: number }} [settings]
 */
async function world({ startCredits = 200, signupGiftDays = 30, monthlyGift = 0, serviceConfig = {}, tick = 0 } = {}) {
  const userId = `platform_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const projectId = "platform-project";
  accounts.push(userId);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Platform test','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Platform',1048576)", [userId, projectId]);
  const time = clock(new Date().toISOString(), tick);
  const wallet = new SimulatedWallet({ database, startCredits, signupGiftDays, monthlyGift, now: time.now });
  const reported = /** @type {string[]} */ ([]);
  const service = new EvimedCreditsService({
    config: { ...config, ...serviceConfig }, database, client: null, usageLedger: usage, simulator: wallet, now: time.now,
    notify: (/** @type {string} */ id, /** @type {any} */ input) => inbox.create(id, input, { now: time.now() }), report: (code) => reported.push(code),
  });
  await service.ready();
  const epoch = (await database.query("SELECT created_at::text AS epoch, " + SIMULATED_INCARNATION_SQL + " AS incarnation FROM evimed_control.users u WHERE u.id=$1", [userId])).rows[0];
  const payer = simulatedPayerId(userId, epoch.incarnation);

  /** Record a finished run's model calls in the usage ledger and settle it. @param {Record<string, any>} [run] @param {{ costs?: number[], purpose?: string }} [spend] */
  async function finish(run = {}, { costs = [], purpose = "kernel" } = {}) {
    const runId = run.runId ?? `run_${randomUUID()}`;
    for (const actualCost of costs) {
      await usage.recordSettled({ id: `usage_${randomUUID()}`, userId, projectId, runId, purpose, model: "test-model", priceVersion: "test-price-v1", currency: "CNY",
        requestFingerprint: "a".repeat(64), usage: { cacheHitTokens: 1000, cacheMissTokens: 200, completionTokens: 50 }, actualCost, priced: true });
    }
    const result = await service.settleRun({ userId, projectId, runId, dispatchId: null, status: "succeeded", subject: "司美格鲁肽减重 Meta 分析",
      startedAt: time.now().toISOString(), finishedAt: time.now().toISOString(), accountCreatedAt: epoch.epoch, capabilityId: "adr-analysis", ...run });
    return { result, runId };
  }
  const balance = () => wallet.snapshot(payer);
  return { userId, projectId, time, wallet, service, payer, finish, balance, reported };
}

const units = (/** @type {string} */ value) => researchMoneyUnits(value);

test("a run costing ¥0.0431 moves the balance by exactly 0.0431, and the statement says what it is made of", options, async () => {
  const w = await world();
  const { result, runId } = await w.finish({}, { costs: [0.01230000, 0.03080000] });
  assert.deepEqual([result.status, result.credits, result.absorbed], ["settled", "0.04310000", "0.00000000"]);
  const read = await w.balance();
  assert.deepEqual([read.balance, read.gifted, read.purchased], ["199.95690000", "199.95690000", "0.00000000"]);
  const line = (await w.service.statements(w.userId)).items.find((item) => item.runId === runId);
  assert.deepEqual([line?.status, line?.amount, line?.requestedAmount, line?.absorbed, line?.balanceAfter, line?.pricingVersion, line?.settlementPrecision],
    ["settled", "0.04310000", "0.04310000", null, "199.95690000", RESEARCH_BILLING_VERSION, "precision-v1"]);
  assert.deepEqual(line?.paidBy, { gifted: "0.04310000", purchased: "0.00000000" });
  assert.match(String(line?.title), /^.+ · 司美格鲁肽减重 Meta 分析$/, "the title the code already writes: the line and the subject");
  // On request: the number of model calls, the tokens by kind, the price list and the amount to 8 decimals.
  const detail = await w.service.statementDetail(w.userId, runId);
  assert.deepEqual(detail.detail, {
    calls: 2, cacheHitTokens: "2000", cacheMissTokens: "400", outputTokens: "100", priceVersions: ["test-price-v1"], pricingVersion: RESEARCH_BILLING_VERSION,
    walletContract: "precision-v1", amount: "0.04310000", requestedAmount: "0.04310000", absorbed: "0.00000000",
    lots: [{ kind: "gifted", source: "signup", expiresAt: detail.detail.lots[0].expiresAt, amount: "0.04310000" }],
  });
  await assert.rejects(w.service.statementDetail(w.userId, `run_${randomUUID()}`), { status: 404, code: "credit_statement_not_found" });
  const other = await world();
  await assert.rejects(other.service.statementDetail(other.userId, runId), { status: 404 }, "a line is the account's own");
  await auditWallet(database, w.payer);
});

test("a ¥7.30 run on 5 gifted (ending in 2 days) and 1 purchased takes 5 + 1, records 1.30 as absorbed by the platform, leaves 0, and the next start is refused", options, async () => {
  const w = await world({ startCredits: 5, signupGiftDays: 2 });
  await w.wallet.credit({ payer: w.payer, amount: "1", requestId: `request_${randomUUID().slice(0, 12)}`, packageId: null });
  const { result, runId } = await w.finish({}, { costs: [7.3] });
  assert.deepEqual([result.status, result.credits, result.requested, result.absorbed], ["settled", "6.00000000", "7.30000000", "1.30000000"]);
  const read = await w.balance();
  assert.deepEqual([read.balance, read.available], ["0.00000000", "0.00000000"]);
  const line = (await w.service.statements(w.userId)).items.find((item) => item.runId === runId);
  assert.deepEqual([line?.status, line?.amount, line?.requestedAmount, line?.absorbed, line?.balanceAfter], ["absorbed", "6.00000000", "7.30000000", "1.30000000", "0.00000000"]);
  assert.deepEqual(line?.paidBy, { gifted: "5.00000000", purchased: "1.00000000" });
  // The platform's own counter, and the figure an operator reads.
  assert.equal(w.service.status().counters.absorbed, 1);
  const figure = await w.service.absorbedSummary({ since: new Date(Date.now() - DAY) });
  assert.ok(figure.count >= 1 && units(figure.absorbed) >= units("1.30000000"), `${figure.count} absorbed, ${figure.absorbed}`);
  // With nothing available, new work waits exactly as before: refused with the amount it needs.
  await assert.rejects(w.service.assertBalanceForStart(w.userId, "adr-analysis"), (/** @type {any} */ error) => {
    assert.deepEqual([error.status, error.code], [402, "simulated_credits_exhausted"]);
    assert.match(error.readerMessage, /^模拟额度不足，这次没有开始：可用模拟额度 ¥0\.00，这件事预计至少需要 ¥\d+\.\d{2}。/);
    return true;
  });
  await assert.rejects(w.service.assertBalanceForStart(w.userId, "open-domain-answer"), { status: 402 }, "a plain question needs something to spend");
  assert.equal(w.service.status().counters.refusedStarts, 2);
  await auditWallet(database, w.payer);
});

test("a stopped run is charged what had run when the stop arrived; a failed run, a platform stop and a stop nobody can attribute are not", options, async () => {
  const w = await world();
  const stopped = await w.finish({ status: "canceled", canceledBy: "user" }, { costs: [0.5, 0.25] });
  assert.deepEqual([stopped.result.status, stopped.result.credits], ["settled", "0.75000000"]);
  assert.equal((await w.balance()).balance, "199.25000000");
  const cases = /** @type {Array<[string, Record<string, any>, string]>} */ ([
    ["a failure", { status: "failed", errorCode: "runtime_session_error" }, "not_delivered"],
    ["a timeout", { status: "failed", errorCode: "run_timeout" }, "not_delivered"],
    ["a platform stop", { status: "canceled", canceledBy: "platform" }, "platform_stop"],
    ["a stop nobody can attribute", { status: "canceled" }, "stop_unattributed"],
    ["a cancel by something else", { status: "canceled", canceledBy: "someone" }, "stop_unattributed"],
  ]);
  for (const [name, run, reason] of cases) {
    const { result, runId } = await w.finish(run, { costs: [3] });
    assert.equal(result.credits, "0.00000000", name);
    assert.equal(result.reason, reason, name);
    const line = (await w.service.statements(w.userId)).items.find((item) => item.runId === runId);
    assert.deepEqual([line?.status, line?.amount, line?.notChargedCode], ["waived", "0.00000000", reason], name);
    assert.match(String(line?.notChargedReason), /不收费/, `${name}: the reason is in words`);
  }
  assert.equal((await w.balance()).balance, "199.25000000", "none of those cost the account anything");
  assert.equal(w.service.status().counters.userStops, 1);
  // Only the researcher's own work is ever charged: the platform's own, however it ends, is not.
  const platform = await w.finish({ effectiveAgentId: "method-distillation", capabilityId: "method-distillation" }, { costs: [9] });
  assert.equal(platform.result.reason, "platform_work");
  // It is nothing the researcher asked for, and a statement names a run by its subject: the platform's own work, and a run that
  // produced nothing to bill, are not on it (an operator's English smoke-test prompt used to read as the researcher's own research).
  // The reasons that answer 「为什么这次没收费」 for a run they did start stay.
  const nothing = await w.finish({}, { costs: [] });
  assert.equal(nothing.result.reason, "no_usage");
  const statement = (await w.service.statements(w.userId, { limit: 100 })).items;
  assert.equal(statement.some((item) => item.runId === platform.runId), false, "platform work is not a line");
  assert.equal(statement.some((item) => item.runId === nothing.runId), false, "a run with no usage is not a line");
  assert.ok(statement.some((item) => item.runId === stopped.runId), "a charged stop is");
  assert.equal(statement.filter((item) => item.notChargedCode === "not_delivered").length, 2, "a failure and a timeout still say why they cost nothing");
  // A stop is charged for the run's own calls only: another run's are never its.
  const sibling = `run_${randomUUID()}`;
  await usage.recordSettled({ id: `usage_${randomUUID()}`, userId: w.userId, projectId: w.projectId, runId: sibling, purpose: "kernel", model: "m", priceVersion: "p", currency: "CNY",
    requestFingerprint: "b".repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 }, actualCost: 5, priced: true });
  const own = await w.finish({ status: "canceled", canceledBy: "user" }, { costs: [0.1] });
  assert.equal(own.result.credits, "0.10000000");
  await auditWallet(database, w.payer);
});

test("the stop rule is a pure function of how the run ended", () => {
  const owned = { automated: false, effectiveAgentId: "adr-analysis" };
  assert.deepEqual(chargeDecision({ ...owned, status: "succeeded" }), { charges: true, basis: "completed", reason: null });
  assert.deepEqual(chargeDecision({ ...owned, status: "completed" }), { charges: true, basis: "completed", reason: null });
  assert.deepEqual(chargeDecision({ ...owned, status: "canceled", canceledBy: "user" }), { charges: true, basis: "user_stop", reason: null });
  assert.equal(chargeDecision({ ...owned, status: "canceled", canceledBy: "platform" }).reason, "platform_stop");
  assert.equal(chargeDecision({ ...owned, status: "canceled" }).reason, "stop_unattributed");
  assert.equal(chargeDecision({ ...owned, status: "failed", canceledBy: "user" }).reason, "not_delivered", "a user flag on a run that failed is not a stop");
  assert.equal(chargeDecision({ ...owned, status: "running" }).reason, "not_delivered");
  assert.equal(chargeDecision({ effectiveAgentId: "method-relations", status: "succeeded" }).reason, "platform_work");
  assert.equal(chargeDecision(/** @type {any} */ (null)).reason, "platform_work");
});

test("the same run settled five times at once is one charge", options, async () => {
  const w = await world();
  const runId = `run_${randomUUID()}`;
  await usage.recordSettled({ id: `usage_${randomUUID()}`, userId: w.userId, projectId: w.projectId, runId, purpose: "kernel", model: "m", priceVersion: "p", currency: "CNY",
    requestFingerprint: "c".repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 }, actualCost: 12.3456, priced: true });
  const results = await Promise.all(Array.from({ length: 5 }, () => w.finish({ runId }, {})));
  assert.equal(results.filter(({ result }) => result.duplicate).length, 4);
  assert.equal((await w.balance()).balance, "187.65440000");
  const lines = (await w.service.statements(w.userId)).items.filter((item) => item.runId === runId);
  assert.equal(lines.length, 1);
  await auditWallet(database, w.payer);
});

test("two runs finishing at once on a balance that covers one of them: what the wallet held is taken, the rest is absorbed, and nothing goes below zero", options, async () => {
  for (let round = 0; round < 5; round += 1) {
    const w = await world({ startCredits: 10 });
    const [a, b] = await Promise.all([w.finish({}, { costs: [8] }), w.finish({}, { costs: [8] })]);
    const taken = [a.result.credits, b.result.credits].sort();
    assert.deepEqual(taken, ["2.00000000", "8.00000000"], `round ${round}: one is covered and the other takes what is left`);
    assert.deepEqual([a.result.absorbed, b.result.absorbed].sort(), ["0.00000000", "6.00000000"]);
    assert.equal((await w.balance()).balance, "0.00000000");
    const lines = (await w.service.statements(w.userId)).items.filter((line) => line.kind === "charge");
    assert.deepEqual(lines.map((line) => line.status).sort(), ["absorbed", "settled"]);
    await auditWallet(database, w.payer);
  }
});

test("a settlement racing the expiry sweep through the service: the lapsed gift is its own line, and the charge is taken from what is still valid", options, async () => {
  for (let round = 0; round < 5; round += 1) {
    const w = await world({ startCredits: 4, signupGiftDays: 1 });
    await w.service.simulatedTopUp(w.userId, { packageId: "topup-50", requestId: `request_${randomUUID().slice(0, 12)}` });
    // The gift's date passes; a run that began long after it finishes while the sweep is running.
    w.time.advance(3 * DAY);
    const [done] = await Promise.all([w.finish({}, { costs: [1.5] }), w.service.sweepWallet(), w.service.sweepWallet()]);
    assert.equal(done.result.credits, "1.50000000");
    const { entries, balance } = await auditWallet(database, w.payer);
    assert.equal(balance, units("48.5"), `round ${round}`);
    assert.deepEqual(entries.filter((entry) => entry.kind === "expire").map((entry) => entry.credits), ["4.00000000"], "once");
    const line = (await w.service.statements(w.userId)).items.find((item) => item.runId === done.runId);
    assert.deepEqual(line?.paidBy, { gifted: "0.00000000", purchased: "1.50000000" }, "a gift past its date pays for nothing");
  }
});

test("the start check compares in exact units: an estimate of ¥0.40 is 0.40 and not 0, a run a person starts needs the P50 and one nobody watches needs the P90", options, async () => {
  const w = await world({ startCredits: 1 });
  // A capability with a history whose P50 is 0.40 and P90 is 0.80.
  const capability = `test-cap-${randomUUID().slice(0, 8)}`;
  for (const requested of ["0.30", "0.40", "0.40", "0.50", "1.00"]) {
    await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,capability_id,memo,cost_cny,credits,credits_per_cny,status,wallet,requested,wallet_contract,charge_basis,settled_at)
      VALUES($1,$2,$3,'history',$4,$4,1,'settled','simulated',$4,'precision-v1','completed',now())`, [`run_${randomUUID()}`, w.userId, capability, requested]);
  }
  const estimate = await w.service.estimate(capability);
  assert.deepEqual([estimate.lowDecimal, estimate.highDecimal, estimate.basis, estimate.samples], ["0.40000000", "0.80000000", "history", 5]);
  assert.equal(estimate.low, 0.4, "the figure a page draws is not rounded to nothing");
  // Spend the account down to 0.39 available.
  await w.wallet.settle({ payer: w.payer, requestId: `run_${randomUUID()}`, amount: "0.61" });
  await assert.rejects(w.service.assertBalanceForStart(w.userId, capability), { code: "simulated_credits_exhausted" }, "0.39 does not cover a P50 of 0.40");
  await w.wallet.credit({ payer: w.payer, amount: "0.01", requestId: `request_${randomUUID().slice(0, 12)}`, packageId: null });
  const admitted = await w.service.assertBalanceForStart(w.userId, capability);
  assert.deepEqual([admitted.allowed, admitted.balanceDecimal], [true, "0.40000000"]);
  // 0.40 covers the P50 for a person at the keyboard and not the P90 for a run nobody is watching.
  await assert.rejects(w.service.assertBalanceForStart(w.userId, capability, { unattended: true }), { code: "simulated_credits_exhausted" });
  await w.wallet.credit({ payer: w.payer, amount: "0.40", requestId: `request_${randomUUID().slice(0, 12)}`, packageId: null });
  assert.equal((await w.service.assertBalanceForStart(w.userId, capability, { unattended: true })).allowed, true);
  // A plain question needs only something to spend, whatever its history says.
  assert.equal((await w.service.assertBalanceForStart(w.userId, "open-domain-answer")).allowed, true);
  assert.equal((await w.service.assertBalanceForStart(w.userId, null)).allowed, true);
});

test("a run's own hold is not counted against its own follow-up: the start check can leave one run's hold out (review F8)", options, async () => {
  const w = await world({ startCredits: 10 });
  const capability = `test-cap-${randomUUID().slice(0, 8)}`;
  for (const requested of ["4", "4", "4", "4", "9"]) {
    await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,capability_id,memo,cost_cny,credits,credits_per_cny,status,wallet,requested,wallet_contract,charge_basis,settled_at)
      VALUES($1,$2,$3,'history',$4,$4,1,'settled','simulated',$4,'precision-v1','completed',now())`, [`run_${randomUUID()}`, w.userId, capability, requested]);
  }
  const running = `run_${randomUUID()}`;
  // P50 is 4 and P90 is 7: the run's hold takes 7 of 10, leaving 3.
  assert.deepEqual(await w.service.holdForRun({ userId: w.userId, runId: running, capabilityId: capability, startedAt: w.time.now().toISOString() }), { held: "7.00000000" });
  await assert.rejects(w.service.assertBalanceForStart(w.userId, capability), { code: "simulated_credits_exhausted" }, "another start is asked against what is left");
  const admitted = await w.service.assertBalanceForStart(w.userId, capability, { ignoreHoldOf: running });
  assert.deepEqual([admitted.allowed, admitted.balanceDecimal], [true, "10.00000000"], "the run's own follow-up is asked against what the run does not itself hold");
  await assert.rejects(w.service.assertBalanceForStart(w.userId, capability, { ignoreHoldOf: "run_somebody_else" }), { code: "simulated_credits_exhausted" });
});

test("a commissioned run freezes its P90 (or what is available), shows it as frozen, and lets it go at every end; a plain question takes none", options, async () => {
  const w = await world({ startCredits: 10 });
  const capability = `test-cap-${randomUUID().slice(0, 8)}`;
  for (const requested of ["2", "3", "3", "4", "6"]) {
    await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,capability_id,memo,cost_cny,credits,credits_per_cny,status,wallet,requested,wallet_contract,charge_basis,settled_at)
      VALUES($1,$2,$3,'history',$4,$4,1,'settled','simulated',$4,'precision-v1','completed',now())`, [`run_${randomUUID()}`, w.userId, capability, requested]);
  }
  const start = (/** @type {string} */ runId, /** @type {string | null} */ capabilityId) => w.service.holdForRun({ userId: w.userId, runId, capabilityId, startedAt: w.time.now().toISOString() });
  // P90 of 2,3,3,4,6 is 5.2: frozen, part of the balance, not available.
  assert.deepEqual(await start("run_one", capability), { held: "5.20000000" });
  let read = await w.balance();
  assert.deepEqual([read.balance, read.frozen, read.available], ["10.00000000", "5.20000000", "4.80000000"]);
  assert.deepEqual(await start("run_one", capability), { held: "5.20000000" }, "once per run");
  // The smaller of the P90 and what is available.
  assert.deepEqual(await start("run_two", capability), { held: "4.80000000" });
  assert.equal((await w.balance()).available, "0.00000000");
  assert.deepEqual(await start("run_three", capability), { held: "0.00000000" }, "nothing is available, so nothing is frozen");
  // A plain question, the open-domain line and a run with no capability take no hold.
  assert.equal(await start("run_plain", "open-domain-answer"), null);
  assert.equal(await start("run_none", null), null);
  assert.equal(w.service.status().counters.holds, 2);
  // The first run ends delivering: its exact charge is taken from the balance and the rest of its hold is released.
  await w.finish({ runId: "run_one" }, { costs: [4] });
  read = await w.balance();
  assert.deepEqual([read.balance, read.frozen, read.available], ["6.00000000", "4.80000000", "1.20000000"]);
  // The second run fails: nothing is charged, and its hold goes with it.
  await w.finish({ runId: "run_two", status: "failed" }, { costs: [2] });
  read = await w.balance();
  assert.deepEqual([read.balance, read.frozen, read.available], ["6.00000000", "0.00000000", "6.00000000"]);
  await auditWallet(database, w.payer);
});

test("a hold cannot outlive its run: a run whose process died is swept after its own timeout", options, async () => {
  const w = await world({ startCredits: 10, serviceConfig: { agentRunMonitorTimeoutMs: 3_600_000 } });
  const capability = `test-cap-${randomUUID().slice(0, 8)}`;
  for (const requested of ["1", "1", "1", "1", "1"]) {
    await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,capability_id,memo,cost_cny,credits,credits_per_cny,status,wallet,requested,wallet_contract,charge_basis,settled_at)
      VALUES($1,$2,$3,'history',$4,$4,1,'settled','simulated',$4,'precision-v1','completed',now())`, [`run_${randomUUID()}`, w.userId, capability, requested]);
  }
  await w.service.holdForRun({ userId: w.userId, runId: "run_dead", capabilityId: capability, startedAt: w.time.now().toISOString() });
  assert.equal((await w.balance()).frozen, "1.00000000");
  // The run's own timeout is an hour, and a margin: before that the hold stays.
  w.time.advance(60 * 60_000);
  await w.service.sweepWallet();
  assert.equal((await w.balance()).frozen, "1.00000000", "still inside its run's timeout");
  w.time.advance(11 * 60_000);
  assert.ok((await w.service.sweepWallet()).holds >= 1);
  assert.deepEqual([(await w.balance()).frozen, (await w.balance()).available], ["0.00000000", "10.00000000"]);
  assert.ok(w.service.status().counters.holdsSwept >= 1);
});

test("a run that started before the exact rule's activation stays under the whole-credit rule, and nothing already settled is recomputed", options, async () => {
  const w = await world();
  // The exact rule begins an hour from now; a run that began now is under the rule before it.
  await database.query("UPDATE evimed_credits.billing_policies SET activated_at=$1 WHERE pricing_version=$2", [new Date(Date.now() + 3_600_000).toISOString(), RESEARCH_BILLING_VERSION]);
  try {
    const before = await w.finish({}, { costs: [7.3] });
    assert.equal(before.result.credits, "7.00000000", "whole credits, rounded down");
    const free = await w.finish({}, { costs: [0.9] });
    assert.equal(free.result.credits, "0.00000000", "under a credit is free under the old rule");
    const line = (await w.service.statements(w.userId)).items.find((item) => item.runId === before.runId);
    assert.deepEqual([line?.settlementPrecision, line?.requestedAmount, line?.amount], ["legacy-integer-floor", "7.00000000", "7.00000000"]);
    // A run that starts after the activation is exact.
    w.time.advance(2 * 3_600_000);
    const after = await w.finish({}, { costs: [7.3] });
    assert.equal(after.result.credits, "7.30000000");
    // Nothing already settled moved.
    assert.equal((await w.service.statementDetail(w.userId, before.runId)).detail.amount, "7.00000000");
    // And a hold is only for a run under the exact rule.
    await database.query("UPDATE evimed_credits.billing_policies SET activated_at=$1 WHERE pricing_version=$2", [new Date(Date.now() + 3_600_000).toISOString(), RESEARCH_BILLING_VERSION]);
    assert.equal(await w.service.holdForRun({ userId: w.userId, runId: `run_${randomUUID()}`, capabilityId: "adr-analysis", startedAt: new Date().toISOString() }), null);
  } finally {
    await database.query("UPDATE evimed_credits.billing_policies SET activated_at=now() - interval '1 minute' WHERE pricing_version=$1", [RESEARCH_BILLING_VERSION]);
  }
});

test("a gifted lot expires with its own statement line, and the inbox reminds the account 7 days and 1 day before, once each", options, async () => {
  const w = await world({ startCredits: 0 });
  const grant = await w.service.operatorGrant(w.userId, { requestId: `request_${randomUUID().slice(0, 12)}`, source: "campaign", amount: "5", days: 10, note: "launch week" });
  const ends = Date.parse(grant.lot.expiresAt);
  const reminders = async () => (await inbox.list(w.userId, { limit: 50 })).items.filter((item) => item.source?.id === `credit_lot_${grant.lot.lotId}`);
  assert.deepEqual(await reminders(), []);
  await w.service.sweepWallet();
  assert.deepEqual(await reminders(), [], "ten days out");
  // Six and a half days before it ends: the 7-day reminder. Another sweep, another process, a restart: the same one, not another.
  w.time.set(new Date(ends - 6.5 * DAY).toISOString());
  assert.ok((await w.service.sweepWallet()).reminded >= 1);
  await w.service.sweepWallet();
  await w.service.sweepWallet();
  assert.deepEqual((await reminders()).map((item) => item.title), ["模拟赠送额度将在 7 天内到期"]);
  assert.match((await reminders())[0].body, /还有 5\.00 灵豆，将于 \d+ 月 \d+ 日到期/);
  // Two days before: nothing new. Half a day before: the 1-day reminder, once.
  w.time.set(new Date(ends - 2 * DAY).toISOString());
  await w.service.sweepWallet();
  assert.equal((await reminders()).length, 1);
  w.time.set(new Date(ends - 0.5 * DAY).toISOString());
  await w.service.sweepWallet();
  await w.service.sweepWallet();
  assert.deepEqual((await reminders()).map((item) => item.title).sort(), ["模拟赠送额度将在 1 天内到期", "模拟赠送额度将在 7 天内到期"]);
  // The date passes: the sweep writes the expiry as its own line, once, and the lot is gone.
  w.time.set(new Date(ends + 1_000).toISOString());
  assert.ok((await w.service.sweepWallet()).expired >= 1);
  assert.equal((await w.balance()).balance, "0.00000000");
  await w.service.sweepWallet();
  assert.equal((await reminders()).length, 2, "an ended lot is not reminded about");
  const read = await w.balance();
  assert.deepEqual([read.balance, read.nextExpiry], ["0.00000000", null]);
  const lines = (await w.service.statements(w.userId)).items;
  assert.deepEqual(lines.map((line) => [line.kind, line.amount]), [["expire", "5.00000000"], ["grant", "5.00000000"]], "the expiry is one line, never silent and never repeated");
  assert.equal(lines[0].title, "模拟赠送到期 · 活动赠送");
  assert.equal(lines[1].title, "模拟赠送 · 活动赠送");
  assert.equal(lines[1].expiresAt, grant.lot.expiresAt, "the grant line says when it ends");
  assert.equal("note" in lines[1], false, "an operator's free-text note, and a migrated lot's bookkeeping, are not the account's to read (review F10)");
  await auditWallet(database, w.payer);
});

test("the statement holds every kind of line, newest first, with a balance that adds up, and pages without losing or repeating one", options, async () => {
  const w = await world({ startCredits: 20, signupGiftDays: 5 });
  await w.balance();
  w.time.advance(1_000);
  await w.service.simulatedTopUp(w.userId, { packageId: "topup-50", requestId: `request_${randomUUID().slice(0, 12)}` });
  w.time.advance(1_000);
  const first = await w.finish({}, { costs: [2.5] });
  w.time.advance(1_000);
  const failed = await w.finish({ status: "failed" }, { costs: [1] });
  w.time.advance(7 * DAY);
  await w.service.sweepWallet();
  const all = (await w.service.statements(w.userId, { limit: 50 })).items;
  assert.deepEqual(all.map((line) => line.kind), ["expire", "charge", "charge", "topup", "grant"]);
  assert.deepEqual(all.map((line) => line.status), ["settled", "waived", "settled", "settled", "settled"]);
  // 20 gifted + 50 bought − 2.5 charged (gifted first) − 17.5 of the gift that ended = 50.
  assert.deepEqual(all.map((line) => line.balanceAfter), ["50.00000000", null, "67.50000000", "70.00000000", "20.00000000"]);
  assert.equal(all[0].amount, "17.50000000", "what was left of the gift when its date passed");
  assert.equal(all.find((line) => line.runId === first.runId)?.balanceAfter, "67.50000000");
  assert.equal(all.find((line) => line.runId === failed.runId)?.notChargedCode, "not_delivered");
  assert.equal(all.at(-1)?.sourceLabel, "注册赠送");
  assert.ok(all.at(-1)?.expiresAt, "a gift line says when it ends");
  // Paging by keyset: every line exactly once.
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const read = await w.service.statements(w.userId, { limit: 2, cursor });
    seen.push(...read.items.map((line) => line.id));
    cursor = read.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, all.map((line) => line.id));
  assert.equal(new Set(seen).size, 5);
  // Another account sees none of it.
  const other = await world();
  assert.equal((await other.service.statements(other.userId)).items.some((line) => seen.includes(line.id)), false);
  await auditWallet(database, w.payer);
});

test("when a charge triggers an expiry and a monthly gift, the lines read in the order they happened and the newest line's balance is the wallet's (review F9)", options, async () => {
  // A clock that ticks, as a real one does between two statements: the stamp the service takes before it asks
  // the wallet is earlier than the one the wallet takes under its lock.
  const w = await world({ startCredits: 0, monthlyGift: 5, tick: 5 });
  await w.service.operatorGrant(w.userId, { requestId: `request_${randomUUID().slice(0, 12)}`, source: "campaign", amount: "3", days: 10 });
  // 35 days on: the 3 has lapsed and this month's 5 is due — both are written by the charge's own preparation of the wallet.
  w.time.advance(35 * DAY);
  const charged = await w.finish({}, { costs: [2] });
  assert.equal(charged.result.credits, "2.00000000");
  const lines = (await w.service.statements(w.userId)).items;
  assert.deepEqual(lines.map((line) => [line.kind, line.amount, line.balanceAfter]), [
    ["charge", "2.00000000", "3.00000000"],
    ["grant", "5.00000000", "5.00000000"],
    ["expire", "3.00000000", "0.00000000"],
    ["grant", "3.00000000", "3.00000000"],
  ], "newest first: the charge, then the gift and the expiry that came before it");
  assert.equal(lines[0].balanceAfter, (await w.balance()).balance, "the newest line's balance is what the wallet holds");
  // The same under paging: every line once, in the same order, one per page.
  const paged = [];
  let cursor = null;
  for (let page = 0; page < 6; page += 1) {
    const read = await w.service.statements(w.userId, { limit: 1, cursor });
    paged.push(...read.items.map((line) => line.kind));
    cursor = read.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(paged, ["charge", "grant", "expire", "grant"]);
  await auditWallet(database, w.payer);
});

test("a legacy line that exists only in the settlement ledger opens its detail instead of answering 404 (review F10)", options, async () => {
  const w = await world({ startCredits: 20 });
  const runId = `run_${randomUUID()}`;
  await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,memo,cost_cny,credits,credits_per_cny,status,settled_at,owner_created_at,wallet)
    SELECT $1,id,'Old paid line',3.4,3,1,'settled',now(),created_at,'simulated' FROM evimed_control.users WHERE id=$2`, [runId, w.userId]);
  const line = (await w.service.statements(w.userId)).items.find((item) => item.id === runId);
  assert.deepEqual([line?.status, line?.amount], ["settled", "3.00000000"]);
  const detail = await w.service.statementDetail(w.userId, runId);
  assert.deepEqual([detail.detail.calls, detail.detail.amount, detail.detail.absorbed, detail.detail.lots, detail.detail.pricingVersion], [null, "3.00000000", "0.00000000", [], "legacy"],
    "what is known about it, and nothing invented: no calls, no tokens");
  const stranger = await world();
  await assert.rejects(stranger.service.statementDetail(stranger.userId, runId), { status: 404 });
});

test("a run that began under the whole-credit rule and is stopped by its user after the exact rule begins keeps that rule's stop: a cancellation is free (review F10)", options, async () => {
  const w = await world();
  await database.query("UPDATE evimed_credits.billing_policies SET activated_at=$1 WHERE pricing_version=$2", [new Date(Date.now() + 3_600_000).toISOString(), RESEARCH_BILLING_VERSION]);
  try {
    const stopped = await w.finish({ status: "canceled", canceledBy: "user" }, { costs: [7.3] });
    assert.equal(stopped.result.credits, "0.00000000");
    assert.equal(stopped.result.reason, "earlier_rule_stop");
    const line = (await w.service.statements(w.userId)).items.find((item) => item.runId === stopped.runId);
    assert.deepEqual([line?.status, line?.notChargedCode], ["waived", "earlier_rule_stop"]);
    assert.match(String(line?.notChargedReason), /不收费/);
    // A run that finished under the same old rule is charged whole credits, as before.
    const done = await w.finish({}, { costs: [7.3] });
    assert.equal(done.result.credits, "7.00000000");
  } finally {
    await database.query("UPDATE evimed_credits.billing_policies SET activated_at=now() - interval '1 minute' WHERE pricing_version=$1", [RESEARCH_BILLING_VERSION]);
  }
});

test("a hold that could not be placed in full is counted, so a burst of starts admitted against one balance can be seen (review F10)", options, async () => {
  const w = await world({ startCredits: 10 });
  const capability = `test-cap-${randomUUID().slice(0, 8)}`;
  for (const requested of ["6", "6", "6", "6", "6"]) {
    await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,capability_id,memo,cost_cny,credits,credits_per_cny,status,wallet,requested,wallet_contract,charge_basis,settled_at)
      VALUES($1,$2,$3,'history',$4,$4,1,'settled','simulated',$4,'precision-v1','completed',now())`, [`run_${randomUUID()}`, w.userId, capability, requested]);
  }
  const start = (/** @type {string} */ runId) => w.service.holdForRun({ userId: w.userId, runId, capabilityId: capability, startedAt: w.time.now().toISOString() });
  assert.deepEqual(await start(`run_${randomUUID()}`), { held: "6.00000000" });
  assert.equal(w.service.status().counters.holdsShort, 0, "the first was held in full");
  assert.deepEqual(await start(`run_${randomUUID()}`), { held: "4.00000000" });
  assert.deepEqual(await start(`run_${randomUUID()}`), { held: "0.00000000" });
  assert.equal(w.service.status().counters.holdsShort, 2, "two starts were admitted against a balance that could not freeze them");
});

test("a top-up answers what a start may use after it, not the balance with the frozen part in it (review F10)", options, async () => {
  const w = await world({ startCredits: 10 });
  await w.wallet.hold({ payer: w.payer, runId: `run_${randomUUID()}`, amount: "6", ttlMs: DAY });
  const topUp = await w.service.simulatedTopUp(w.userId, { packageId: "topup-50", requestId: `request_${randomUUID().slice(0, 12)}` });
  assert.deepEqual([topUp.balance, topUp.available], ["60.00000000", "54.00000000"]);
  const again = await w.service.simulatedTopUp(w.userId, { packageId: "topup-50", requestId: `request_${randomUUID().slice(0, 12)}` });
  assert.equal(again.available, "104.00000000");
});

test("one reminder that cannot be written does not stop the ones after it, and only what is actually written is counted (review F10)", options, async () => {
  const w = await world({ startCredits: 0 });
  const other = await world({ startCredits: 0 });
  const bad = await w.service.operatorGrant(w.userId, { requestId: `request_${randomUUID().slice(0, 12)}`, source: "campaign", amount: "2", days: 3 });
  const good = await other.service.operatorGrant(other.userId, { requestId: `request_${randomUUID().slice(0, 12)}`, source: "campaign", amount: "4", days: 3 });
  const reported = /** @type {string[]} */ ([]);
  const failing = new EvimedCreditsService({ config, database, client: null, usageLedger: usage, simulator: w.wallet, now: w.time.now, report: (code) => reported.push(code),
    notify: async (/** @type {string} */ userId, /** @type {any} */ input) => {
      if (userId === w.userId) throw Object.assign(new Error("the inbox write failed"), { code: "inbox_unavailable" });
      return inbox.create(userId, input, { now: w.time.now() });
    } });
  w.time.set(new Date(Date.parse(good.lot.expiresAt) - 12 * 3_600_000).toISOString());
  const sent = await failing.remindExpiries();
  assert.ok(sent >= 1, "the lot after the failing one was reminded");
  assert.equal((await inbox.list(other.userId, { limit: 20 })).items.filter((item) => item.source?.id === `credit_lot_${good.lot.lotId}`).length, 1);
  assert.ok(reported.includes("inbox_unavailable"), "and the failure is said");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_credits.simulated_reminders WHERE lot_id=$1", [bad.lot.lotId])).rows[0].n, 0, "the failed one is not written down as sent, so it is tried again later");
  // The next sweep leaves a lot that failed alone for a while rather than re-trying it on every tick.
  const before = reported.length;
  await failing.remindExpiries();
  assert.equal(reported.length, before, "not retried within the hour");
});

test("the monthly gift is off at 0 and, when set, arrives on the account's own date as one lot that ends at the next", options, async () => {
  const off = await world({ startCredits: 0, monthlyGift: 0 });
  off.time.advance(70 * DAY);
  assert.equal((await off.balance()).gifted, "0.00000000");
  const on = await world({ startCredits: 0, monthlyGift: 12 });
  assert.equal((await on.balance()).gifted, "0.00000000", "not on the day it was made");
  on.time.advance(35 * DAY);
  const month = await on.balance();
  assert.equal(month.gifted, "12.00000000");
  assert.ok(month.nextExpiry, "and it says when it ends");
  const again = await on.balance();
  assert.equal(again.gifted, "12.00000000", "once per cycle");
});

test("the operator's grant over HTTP: operators only, the sources a compensation or a campaign, once per request id, audited, listed in the statement", options, async () => {
  const w = await world({ startCredits: 0 });
  const operatorId = `operator_${randomUUID().slice(0, 8)}`;
  /** @type {any[]} */
  const audited = [];
  const routes = createEvimedCreditsRoutes({
    store: { async ensureSessionUser(/** @type {any} */ req) { return { user: { id: req.headers["x-user"] } }; }, async assertCsrf() {} },
    service: w.service, config: { evimedCreditsEnabled: true, operatorUsers: [operatorId] }, audit: (event, detail) => { audited.push([event, detail]); },
  });
  /** @param {string} user @param {string} method @param {string} path @param {any} [body] */
  async function call(user, method, path, body) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { "x-user": user, "content-type": "application/json" } });
    const res = { status: 0, body: /** @type {any} */ (null), headers: /** @type {any} */ ({}),
      writeHead(/** @type {number} */ status, /** @type {any} */ headers) { this.status = status; this.headers = headers; },
      setHeader() {}, end(/** @type {string} */ text) { this.body = text ? JSON.parse(text) : null; } };
    try { await routes(req, res); } catch (error) { return { status: /** @type {any} */ (error).status, code: /** @type {any} */ (error).code }; }
    return { status: res.status, body: res.body };
  }
  const grant = { accountId: w.userId, requestId: `request_${randomUUID().slice(0, 12)}`, source: "compensation", amount: "12.5", note: "the 4 October outage" };
  assert.deepEqual(await call(w.userId, "POST", "/api/credits/grants", grant), { status: 403, code: "credit_grant_forbidden" }, "a researcher cannot grant");
  assert.deepEqual(await call(w.userId, "GET", "/api/credits/absorbed"), { status: 403, code: "credit_grant_forbidden" });
  const made = await call(operatorId, "POST", "/api/credits/grants", grant);
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.data.balance, made.body.data.duplicate, made.body.data.lot.source, made.body.data.lot.note], ["12.50000000", false, "compensation", "the 4 October outage"]);
  const replay = await call(operatorId, "POST", "/api/credits/grants", grant);
  assert.deepEqual([replay.status, replay.body.data.duplicate, replay.body.data.balance], [200, true, "12.50000000"]);
  assert.deepEqual(await call(operatorId, "POST", "/api/credits/grants", { ...grant, amount: "13" }), { status: 409, code: "credit_grant_conflict" });
  assert.deepEqual(await call(operatorId, "POST", "/api/credits/grants", { ...grant, requestId: `request_${randomUUID().slice(0, 12)}`, source: "signup" }), { status: 400, code: "credit_grant_invalid" });
  assert.deepEqual(await call(operatorId, "POST", "/api/credits/grants", { ...grant, requestId: `request_${randomUUID().slice(0, 12)}`, extra: 1 }), { status: 400, code: "credit_grant_invalid" });
  assert.deepEqual(await call(operatorId, "POST", "/api/credits/grants", { ...grant, accountId: "nobody_at_all", requestId: `request_${randomUUID().slice(0, 12)}` }), { status: 404, code: "credit_grant_account_not_found" });
  assert.deepEqual(await call(operatorId, "PUT", "/api/credits/grants", grant), { status: 405, code: "method_not_allowed" });
  w.time.advance(1_000);
  const dated = await call(operatorId, "POST", "/api/credits/grants", { ...grant, requestId: `request_${randomUUID().slice(0, 12)}`, source: "campaign", amount: 1, expiresOn: "2030-12-31", note: undefined });
  assert.equal(dated.body.data.lot.expiresAt, "2030-12-31T16:00:00.000Z");
  // Audited with who, whom, what and why — never the note's text — and listed in the account's statement.
  assert.equal(audited.length, 3, "the replay is audited too, as a duplicate");
  assert.deepEqual(audited[0], ["credit.grant", { userId: operatorId, account: w.userId, source: "compensation", amount: "12.5", duplicate: false, lot: made.body.data.lot.lotId }]);
  assert.ok(!JSON.stringify(audited).includes("outage"));
  const lines = (await w.service.statements(w.userId)).items;
  assert.deepEqual(lines.map((line) => [line.kind, line.sourceLabel, line.amount]), [["grant", "活动赠送", "1.00000000"], ["grant", "补偿", "12.50000000"]]);
  // The operator reads the figure the platform carried.
  const figure = await call(operatorId, "GET", "/api/credits/absorbed?days=7");
  assert.equal(figure.status, 200);
  assert.deepEqual(Object.keys(figure.body.data).sort(), ["absorbed", "charged", "count", "days", "settlements", "since"]);
  assert.deepEqual(await call(operatorId, "GET", "/api/credits/absorbed?days=0"), { status: 400, code: "evimed_credits_request_invalid" });
  void researchMoneyDecimal;
});

test("a simulated top-up goes through the service once per request, as a closed package, into a purchased lot, for a simulated deployment only", options, async () => {
  const w = await world({ startCredits: 10 });
  const requestId = `request_${randomUUID().slice(0, 12)}`;
  const first = await w.service.simulatedTopUp(w.userId, { packageId: "topup-100", requestId });
  assert.deepEqual([first.duplicate, first.balance, first.order.amount, first.order.title], [false, "110.00000000", 100, "模拟充值"]);
  const again = await w.service.simulatedTopUp(w.userId, { packageId: "topup-100", requestId });
  assert.deepEqual([again.duplicate, again.balance], [true, "110.00000000"]);
  const read = await w.balance();
  assert.deepEqual([read.purchased, read.gifted], ["100.00000000", "10.00000000"], "what was bought is told from what was given");
  assert.deepEqual((await w.service.simulatedOrders(w.userId)).items.map((order) => order.amount), [100]);
  for (const bad of [{ packageId: "topup-7", requestId: `request_${randomUUID().slice(0, 12)}` }, { packageId: "topup-100", requestId: "x" }, { packageId: "topup-50", requestId }, {}]) {
    await assert.rejects(w.service.simulatedTopUp(w.userId, bad), { status: 400, code: "simulated_wallet_request_invalid" });
  }
  await assert.rejects(w.service.simulatedOrders(w.userId, { cursor: "nonsense" }), { status: 400, code: "simulated_wallet_request_invalid" });
  const stranger = await world();
  assert.deepEqual((await stranger.service.simulatedOrders(stranger.userId)).items, [], "another account has no orders of this one's");
  const live = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 1 }, database, client: { configured: true } });
  await assert.rejects(live.simulatedTopUp(w.userId, { packageId: "topup-50", requestId: `request_${randomUUID().slice(0, 12)}` }), { status: 404, code: "simulated_wallet_not_enabled" });
  await assert.rejects(live.simulatedOrders(w.userId), { status: 404, code: "simulated_wallet_not_enabled" });
  await auditWallet(database, w.payer);
});

test("off means off, and a billing module that fails never stops a run: nothing is charged, held or refused", options, async () => {
  const w = await world();
  const off = new EvimedCreditsService({ config: { ...config, evimedCreditsEnabled: false }, database, client: null, simulator: w.wallet, usageLedger: usage });
  assert.deepEqual(await off.settleRun({ userId: w.userId, projectId: w.projectId, runId: `run_${randomUUID()}`, status: "succeeded" }), { status: "skipped", reason: "not_enabled" });
  assert.equal(await off.holdForRun({ userId: w.userId, runId: `run_${randomUUID()}`, capabilityId: "adr-analysis", startedAt: new Date().toISOString() }), null);
  assert.deepEqual(await off.sweepWallet(), { holds: 0, expired: 0, reminded: 0 });
  assert.equal((await off.assertBalanceForStart(w.userId, "adr-analysis")).allowed, true);
  assert.equal((await off.balanceFor(w.userId)).status, "disabled");
  // A database that fails under it: a named status, never a throw out of the run's completion path, and the start is admitted.
  const broken = { query: async () => { throw Object.assign(new Error("down"), { code: "57P01" }); }, transaction: async () => { throw Object.assign(new Error("down"), { code: "57P01" }); } };
  const reported = /** @type {string[]} */ ([]);
  const failing = new EvimedCreditsService({ config, database: broken, client: null, simulator: w.wallet, usageLedger: usage, report: (code) => reported.push(code) });
  const settled = await failing.settleRun({ userId: w.userId, projectId: w.projectId, runId: `run_${randomUUID()}`, status: "succeeded", accountCreatedAt: new Date().toISOString() });
  assert.equal(settled.status, "error");
  assert.equal((await failing.assertBalanceForStart(w.userId, "adr-analysis")).allowed, true);
  assert.equal(await failing.holdForRun({ userId: w.userId, runId: `run_${randomUUID()}`, capabilityId: "adr-analysis", startedAt: new Date().toISOString() }), null);
  assert.ok(reported.length > 0, "and it says why");
});

/** The one-number wallet's outbox row: a charge it asked for and never got an answer to. @param {any} w @param {{ credits: number, withTask?: boolean }} row */
async function pendingRow(w, { credits, withTask = true }) {
  const runId = `run_${randomUUID()}`;
  await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,memo,cost_cny,credits,credits_per_cny,status,attempts,next_attempt_at,owner_created_at,upstream_user_id,wallet)
    SELECT $1,id,'Pending from before',$3,$3,1,'pending',1,$4::timestamptz,created_at,$5,'simulated' FROM evimed_control.users WHERE id=$2`,
  [runId, w.userId, credits, new Date(Date.now() - 1_000).toISOString(), w.payer]);
  if (withTask) {
    const evidence = { actualCny: `${credits}.00000000`, billableCny: `${credits}.00000000`, chargedCny: `${credits}.00000000`, waivedCny: "0.00000000", platformCostCny: "0.00000000",
      pricingVersion: "research-allowance-v1-20261003", walletContract: "legacy-integer-floor", physicalRunId: runId, evidence: [] };
    await database.query(`INSERT INTO evimed_credits.research_tasks(run_id,user_id,title,evidence,status,owner_created_at,wallet)
      SELECT $1,id,'Pending from before',$3::jsonb,'pending',created_at,'simulated' FROM evimed_control.users WHERE id=$2`, [runId, w.userId, JSON.stringify(evidence)]);
  }
  return runId;
}

test("a pending settlement the one-number wallet left finishes like any other: what the wallet took, the rest absorbed, the statement and the month agreeing, in one commit (review F5)", options, async () => {
  for (const withTask of [true, false]) {
    const w = await world({ startCredits: 3 });
    const runId = await pendingRow(w, { credits: 12, withTask });
    assert.equal(await w.service.retryDue(), 1);
    // The wallet gave what it had.
    assert.equal((await w.balance()).balance, "0.00000000", `withTask=${withTask}`);
    const row = (await database.query("SELECT status,credits::text AS credits,requested::text AS requested,absorbed::text AS absorbed,receipt_id FROM evimed_credits.settlements WHERE run_id=$1", [runId])).rows[0];
    assert.deepEqual([row.status, row.credits, row.requested, row.absorbed], ["settled", "3.00000000", "12.00000000", "9.00000000"], "the row says what was taken, what was asked and what the platform carried");
    assert.match(row.receipt_id, /^sim_rcpt_/);
    const line = (await w.service.statements(w.userId)).items.find((item) => item.id === runId);
    assert.deepEqual([line?.status, line?.amount, line?.requestedAmount, line?.absorbed], ["absorbed", "3.00000000", "12.00000000", "9.00000000"], "the statement does not say 12 was charged");
    const month = await w.service.allowanceSummary(w.userId, { since: new Date(Date.now() - DAY) });
    assert.deepEqual([month.spentCny, month.pendingCny], [3, 0]);
    // Σ settlements.credits = Σ deduct entries, to the last 1e-8, and the platform's figure counts what it carried.
    const sums = (await database.query(`SELECT (SELECT coalesce(sum(credits),0)::text FROM evimed_credits.settlements WHERE user_id=$1 AND wallet='simulated') AS settled,
      (SELECT coalesce(sum(credits),0)::text FROM evimed_credits.simulated_entries WHERE payer=$2 AND kind='deduct') AS taken`, [w.userId, w.payer])).rows[0];
    assert.equal(sums.settled, sums.taken);
    const figure = await w.service.absorbedSummary({ since: new Date(Date.now() - DAY) });
    assert.ok(units(figure.absorbed) >= units("9"), `the platform's figure counts it: ${figure.absorbed}`);
    assert.equal(w.service.status().counters.absorbed >= 1, true);
    await auditWallet(database, w.payer);
    // Replayed by a second sweep: nothing more.
    assert.equal(await w.service.retryDue(), 0);
    assert.equal((await w.balance()).balance, "0.00000000");
  }
});

test("a pending settlement covered in full is settled for its full amount, and one the old release already took (the answer was lost) is not taken twice (review F5)", options, async () => {
  const w = await world({ startCredits: 50 });
  const covered = await pendingRow(w, { credits: 12 });
  assert.equal(await w.service.retryDue(), 1);
  assert.equal((await w.balance()).balance, "38.00000000");
  const line = (await w.service.statements(w.userId)).items.find((item) => item.id === covered);
  assert.deepEqual([line?.status, line?.amount, line?.absorbed], ["settled", "12.00000000", null]);
  // The old release took 5 and lost the answer: its deduct entry exists under the run id, the row is still pending.
  const lost = await pendingRow(w, { credits: 5, withTask: false });
  await w.wallet.settle({ payer: w.payer, requestId: lost, amount: "5" });
  assert.equal((await w.balance()).balance, "33.00000000");
  assert.equal(await w.service.retryDue(), 1);
  assert.equal((await w.balance()).balance, "33.00000000", "taken once");
  assert.equal((await database.query("SELECT status FROM evimed_credits.settlements WHERE run_id=$1", [lost])).rows[0].status, "settled");
  await auditWallet(database, w.payer);
});

test("the wallet's take and the row's update are one commit: a failure after the take leaves the wallet untouched and the row pending (review F5)", options, async () => {
  const w = await world({ startCredits: 20 });
  const runId = await pendingRow(w, { credits: 7, withTask: false });
  await database.query(`CREATE OR REPLACE FUNCTION evimed_credits.test_fail_settlement() RETURNS trigger AS $f$
    BEGIN IF NEW.status = 'settled' THEN RAISE EXCEPTION 'test: the row update fails after the take' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $f$ LANGUAGE plpgsql`);
  await database.query(`CREATE TRIGGER test_fail_settlement BEFORE UPDATE ON evimed_credits.settlements FOR EACH ROW WHEN (NEW.run_id = '${runId}') EXECUTE FUNCTION evimed_credits.test_fail_settlement()`);
  try {
    await w.service.retryDue();
    assert.equal((await w.balance()).balance, "20.00000000", "the wallet was not debited for a row that did not land");
    assert.equal((await database.query("SELECT status FROM evimed_credits.settlements WHERE run_id=$1", [runId])).rows[0].status, "pending");
  } finally {
    await database.query("DROP TRIGGER test_fail_settlement ON evimed_credits.settlements");
  }
  // And once the cause is gone it settles, once.
  await database.query("UPDATE evimed_credits.settlements SET next_attempt_at=now() - interval '1 second' WHERE run_id=$1", [runId]);
  assert.equal(await w.service.retryDue(), 1);
  assert.equal((await w.balance()).balance, "13.00000000");
});

test("a pending row of a deleted account never re-creates that account's wallet to take the charge from (review F10)", options, async () => {
  const w = await world({ startCredits: 20 });
  const runId = await pendingRow(w, { credits: 4, withTask: false });
  // The account is erased; the financial row stays (money outlives its account) but the wallet goes with it.
  await database.query("DELETE FROM evimed_credits.simulated_wallets WHERE user_id=$1", [w.userId]);
  await database.query("UPDATE evimed_credits.settlements SET owner_created_at='-infinity' WHERE run_id=$1", [runId]);
  assert.equal(await w.service.retryDue(), 1);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_credits.simulated_wallets WHERE payer=$1", [w.payer])).rows[0].n, 0, "no wallet was made for it");
  const row = (await database.query("SELECT status,error_code FROM evimed_credits.settlements WHERE run_id=$1", [runId])).rows[0];
  assert.deepEqual([row.status, row.error_code], ["refused", "evimed_credits_account_unlinked"]);
});

test("everything at once on one account — settlements, replays, holds, sweeps, top-ups, grants, reads, and the one-number code writing under them — ends conserved to the last 1e-8 (concurrency suite)", options, async () => {
  for (let round = 0; round < 6; round += 1) {
    const w = await world({ startCredits: 100, signupGiftDays: 2 });
    const legacy = new LegacyWallet({ database, startCredits: 100 });
    const runs = Array.from({ length: 4 }, () => `run_${randomUUID()}`);
    for (const runId of runs) await w.wallet.hold({ payer: w.payer, runId, amount: "8", ttlMs: 10 * DAY });
    // The first gift's date passes while the runs are still being settled: expiry joins the race.
    w.time.advance(3 * DAY);
    const results = await Promise.all([
      ...runs.flatMap((runId) => [w.finish({ runId }, { costs: [3] }), w.finish({ runId }, {})]),
      w.service.simulatedTopUp(w.userId, { packageId: "topup-50", requestId: `request_${randomUUID().slice(0, 12)}` }),
      w.service.operatorGrant(w.userId, { requestId: `request_${randomUUID().slice(0, 12)}`, source: "campaign", amount: "7", days: 10 }),
      w.balance(), w.balance(), w.balance(),
      w.service.sweepWallet(), w.service.sweepWallet(),
      legacy.deduct({ payer: w.payer, requestId: `run_${randomUUID()}`, credits: 2 }).catch(() => null),
      legacy.topUp({ payer: w.payer, packageId: "topup-50", requestId: `request_${randomUUID().slice(0, 12)}` }).catch(() => null),
      w.service.assertBalanceForStart(w.userId, null).catch(() => null),
    ]);
    assert.ok(results.length > 0);
    const settled = await database.query("SELECT count(*)::int AS n, coalesce(sum(credits),0)::text AS taken FROM evimed_credits.settlements WHERE user_id=$1", [w.userId]);
    assert.equal(settled.rows[0].n, 4, `round ${round}: one charge per run however many times it was settled`);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_credits.simulated_holds WHERE payer=$1 AND status='open'", [w.payer])).rows[0].n, 0, "no hold outlives its run");
    const { balance } = await auditWallet(database, w.payer);
    assert.ok(balance >= 0n);
    // The wallet's own account of what was taken for the platform's runs is exactly what the settlements say, to the last 1e-8.
    const taken = await database.query(`SELECT coalesce(sum(e.credits),0)::text AS taken FROM evimed_credits.simulated_entries e
      WHERE e.payer=$1 AND e.kind='deduct' AND e.request_id IN (SELECT run_id FROM evimed_credits.settlements WHERE user_id=$2)`, [w.payer, w.userId]);
    assert.equal(units(taken.rows[0].taken), units(settled.rows[0].taken), `round ${round}`);
  }
});
