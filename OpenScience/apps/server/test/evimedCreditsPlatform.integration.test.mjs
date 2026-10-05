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
 * @param {{ startCredits?: number, signupGiftDays?: number, monthlyGift?: string | number, serviceConfig?: Record<string, any> }} [settings]
 */
async function world({ startCredits = 200, signupGiftDays = 30, monthlyGift = 0, serviceConfig = {} } = {}) {
  const userId = `platform_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const projectId = "platform-project";
  accounts.push(userId);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Platform test','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Platform',1048576)", [userId, projectId]);
  const time = clock(new Date().toISOString());
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
  assert.equal(lines[1].note, "launch week");
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
