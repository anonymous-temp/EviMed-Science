// 灵豆 settlement against a real PostgreSQL: the properties that are the
// storage's, not the code's — one charge per run however many times it is
// settled, a pending row that exists before the deduction leaves, a bounded
// retry, a refusal that is never retried, and a charge that outlives its
// project; and the person charged is the EviMed user the account row names,
// never our own hashed account id.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { PostgresStore } from "../src/store.mjs";
import { EVIMED_CREDITS_BACKOFF_MS, EVIMED_CREDITS_MAX_ATTEMPTS, EvimedCreditsService } from "../src/evimedCreditsService.mjs";
import { migrateEvimedCredits, prepareResearchBillingAccountDeletion } from "../src/evimedCreditsPersistence.mjs";
import { EvimedCreditsError } from "../src/evimedCreditsClient.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const userId = `evimed_credits_${randomUUID().replaceAll("-", "")}`;
/** EviMed's own id for that account, as introspection reported it. */
const evimedUserId = "4711";
/** A password account in the same deployment: nobody at EviMed. */
const localUserId = `credits_local_${randomUUID()}`;
const projectId = "credits-project";
/** @type {any} */
let database;

const config = { evimedCreditsEnabled: true, evimedCreditsPerCny: 100 };

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 3_000 });
  await database.migrate();
  await migrateEvimedCredits(database);
  await database.query('DELETE FROM evimed_credits.research_policy');
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type,evimed_user_id) VALUES($1,'Credits test','evimed',$2)",
    [userId, evimedUserId]);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Local test','development')", [localUserId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Credits',1048576)", [userId, projectId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Local',1048576)", [localUserId, projectId]);
});

after(async () => {
  if (!databaseUrl) return;
  await database.query('DELETE FROM evimed_credits.settlements WHERE user_id=ANY($1::text[])', [[userId,localUserId]]).catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[userId, localUserId]]).catch(() => {});
  await database.close?.();
});

/** A usage ledger that reports one fixed cost per run id. @param {Record<string, number>} costs */
const ledger = (costs) => ({
  async summaryRuns(/** @type {string} */ _userId, /** @type {string[]} */ ids) {
    return new Map(ids.filter((id) => costs[id] != null).map((id) => [id, { costCny: costs[id] }]));
  },
});

/**
 * A credits upstream whose answers the test drives, recording every request.
 * @param {{ answer?: (request: any, calls: any[]) => any, balance?: number }} [behaviour]
 */
function upstream({ answer = () => ({ receiptId: "rcpt", balance: 500 }), balance = 500 } = {}) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    configured: true,
    status: () => ({ configured: true }),
    async deduct(/** @type {any} */ request) {
      calls.push(request);
      return answer(request, calls);
    },
    async balance(/** @type {string} */ account) {
      calls.push({ balanceOf: account });
      return { balance, frozen: 0 };
    },
  };
}

/** The store's own reader of the column, run against this test's database. */
const evimedUserIdOf = (/** @type {string} */ id) => PostgresStore.prototype.evimedUserIdOf.call({ database }, id);

/**
 * The sweep is deliberately global — it settles every account's due rows — so a
 * test that exercises it starts from a table holding only its own.
 * @param {any} service
 */
async function clearPending(service) {
  await service.ready();
  await database.query("DELETE FROM evimed_credits.settlements WHERE status='pending'");
}

/** @param {{ client: any, costs: Record<string, number>, now?: () => Date }} parts */
const credits = ({ client, costs, now = () => new Date() }) => new EvimedCreditsService({
  config, database, client, usageLedger: ledger(costs), evimedUserIdOf, now,
});

test("one run is charged once, however many times it is settled", options, async () => {
  const runId = `run_${randomUUID()}`;
  const client = upstream();
  const service = credits({ client, costs: { [runId]: 1.2 } });
  const settled = await service.settleRun({
    userId, projectId, runId, capabilityId: "adr-analysis", subject: "奥希替尼心脏安全信号",
  });
  assert.deepEqual(settled, { status: "settled", credits: 120 });
  // The duplicate is the one this whole module is judged by: a second
  // completion callback, a redelivered event, an operator re-running the fold.
  for (let again = 0; again < 3; again += 1) {
    assert.deepEqual(await service.settleRun({ userId, projectId, runId, capabilityId: "adr-analysis", subject: "奥希替尼心脏安全信号" }),
      { status: "settled", duplicate: true, credits: 120 });
  }
  assert.equal(client.calls.length, 1, "EviMed was asked to charge more than once");
  // EviMed is told whom to charge in its own words: its user id, which our
  // hashed account id cannot be turned back into (§14).
  assert.equal(client.calls[0].userId, evimedUserId);
  const rows = await database.query("SELECT * FROM evimed_credits.settlements WHERE run_id=$1", [runId]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].status, "settled");
  assert.equal(Number(rows.rows[0].credits), 120);
  assert.equal(rows.rows[0].receipt_id, "rcpt");
  assert.equal(rows.rows[0].memo, "药品安全性分析 · 奥希替尼心脏安全信号");
  assert.equal(rows.rows[0].next_attempt_at, null);
  assert.ok(rows.rows[0].settled_at);
  assert.equal(service.status().counters.duplicates, 3);
});

test("the row exists before the deduction leaves, so a crash after the charge is recoverable", options, async () => {
  // This is the whole argument for retrying an unknown outcome: the pending row
  // is written first, and the run id it carries is the key EviMed dedupes on.
  const runId = `run_${randomUUID()}`;
  /** @type {any} */
  let seen = null;
  const client = upstream({
    answer: () => { throw new EvimedCreditsError("evimed_credits_timeout", "no answer"); },
  });
  const watching = {
    ...client,
    async deduct(/** @type {any} */ request) {
      const rows = await database.query("SELECT status,attempts FROM evimed_credits.settlements WHERE run_id=$1", [request.requestId]);
      seen = rows.rows[0];
      return client.deduct(request);
    },
  };
  const service = credits({ client: watching, costs: { [runId]: 0.5 } });
  const outcome = await service.settleRun({ userId, projectId, runId, capabilityId: "adr-analysis", subject: "阿哌沙班" });
  assert.deepEqual(outcome, { status: "pending", credits: 50, errorCode: "evimed_credits_timeout" });
  assert.deepEqual({ status: seen.status, attempts: Number(seen.attempts) }, { status: "pending", attempts: 1 },
    "the deduction left before its row existed");
});

test("an upstream outage leaves a pending settlement, not a charge and not a crash", options, async () => {
  const runId = `run_${randomUUID()}`;
  let down = true;
  const at = new Date("2026-09-26T08:00:00.000Z");
  const client = upstream({
    answer: () => {
      if (down) throw new EvimedCreditsError("evimed_credits_unreachable", "down");
      return { receiptId: "rcpt_late", balance: 380 };
    },
  });
  const service = credits({ client, costs: { [runId]: 2 }, now: () => at });
  await clearPending(service);
  assert.deepEqual(await service.settleRun({ userId, projectId, runId, capabilityId: "adr-analysis", subject: "达格列净" }),
    { status: "pending", credits: 200, errorCode: "evimed_credits_unreachable" });
  const pending = await service.settlementOf(userId, runId);
  assert.equal(pending?.status, "pending");
  assert.equal(pending?.attempts, 1);
  assert.equal(pending?.errorCode, "evimed_credits_unreachable");
  assert.equal(pending?.receiptId, null);
  assert.equal(pending?.settledAt, null);
  // The backoff is in the row, so nothing retries it in a tight loop.
  assert.equal(Date.parse(/** @type {string} */ (pending?.nextAttemptAt)), at.getTime() + EVIMED_CREDITS_BACKOFF_MS[0]);
  // Not due yet: the sweep leaves it alone.
  assert.equal(await service.retryDue(), 0);
  assert.equal(client.calls.length, 1);
  // Due, and the upstream is back. The same run id goes out — EviMed's own
  // idempotency is what keeps this one charge.
  down = false;
  const later = credits({ client, costs: { [runId]: 2 }, now: () => new Date(at.getTime() + EVIMED_CREDITS_BACKOFF_MS[0] + 1_000) });
  assert.equal(await later.retryDue(), 1);
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls.map((call) => call.requestId), [runId, runId]);
  const done = await service.settlementOf(userId, runId);
  assert.equal(done?.status, "settled");
  assert.equal(done?.attempts, 2);
  assert.equal(done?.receiptId, "rcpt_late");
  assert.equal(done?.errorCode, null);
  assert.equal(done?.nextAttemptAt, null);
  // And it is not swept again.
  assert.equal(await later.retryDue(), 0);
  assert.equal(client.calls.length, 2);
});

test("a refusal EviMed wrote down is recorded and never asked again", options, async () => {
  const runId = `run_${randomUUID()}`;
  const client = upstream({
    answer: () => { throw new EvimedCreditsError("evimed_credits_refused", "declined", { final: true }); },
  });
  const service = credits({ client, costs: { [runId]: 3 } });
  await clearPending(service);
  assert.deepEqual(await service.settleRun({ userId, projectId, runId, capabilityId: "adr-analysis", subject: "利伐沙班" }),
    { status: "refused", credits: 300, errorCode: "evimed_credits_refused" });
  const row = await service.settlementOf(userId, runId);
  assert.equal(row?.status, "refused");
  assert.equal(row?.errorCode, "evimed_credits_refused");
  assert.equal(row?.nextAttemptAt, null, "a refused settlement must fall out of the sweep");
  assert.equal(await service.retryDue(), 0);
  assert.equal(client.calls.length, 1);
});

test("the retry is bounded: after the last wait the settlement is abandoned, not looped", options, async () => {
  const runId = `run_${randomUUID()}`;
  const client = upstream({ answer: () => { throw new EvimedCreditsError("evimed_credits_unreachable", "down"); } });
  let at = new Date("2026-09-26T00:00:00.000Z");
  const service = credits({ client, costs: { [runId]: 1 }, now: () => at });
  await clearPending(service);
  await service.settleRun({ userId, projectId, runId, capabilityId: "adr-analysis", subject: "华法林" });
  for (let attempt = 2; attempt <= EVIMED_CREDITS_MAX_ATTEMPTS; attempt += 1) {
    const row = await service.settlementOf(userId, runId);
    assert.equal(row?.status, "pending", `attempt ${attempt} should still have a pending row`);
    at = new Date(Date.parse(/** @type {string} */ (row?.nextAttemptAt)) + 1_000);
    assert.equal(await service.retryDue(), 1, `attempt ${attempt} was not swept`);
  }
  const abandoned = await service.settlementOf(userId, runId);
  assert.equal(abandoned?.status, "abandoned");
  assert.equal(abandoned?.attempts, EVIMED_CREDITS_MAX_ATTEMPTS);
  assert.equal(abandoned?.nextAttemptAt, null);
  assert.equal(client.calls.length, EVIMED_CREDITS_MAX_ATTEMPTS);
  at = new Date(Date.parse("2026-12-31T00:00:00.000Z"));
  assert.equal(await service.retryDue(), 0, "an abandoned settlement is never asked again");
  assert.equal(client.calls.length, EVIMED_CREDITS_MAX_ATTEMPTS);
});

test("an account EviMed does not know is never charged under our own id", options, async () => {
  const runId = `run_${randomUUID()}`;
  const client = upstream({ answer: () => { throw new Error("must not be called"); } });
  const service = credits({ client, costs: { [runId]: 2 } });
  await clearPending(service);
  assert.deepEqual(await service.settleRun({ userId: localUserId, projectId, runId, capabilityId: "adr-analysis", subject: "本地账号" }),
    { status: "refused", credits: 200, errorCode: "evimed_credits_account_unlinked" });
  assert.equal(client.calls.length, 0, "a deduction left naming an account EviMed cannot resolve");
  const row = await service.settlementOf(localUserId, runId);
  assert.equal(row?.status, "refused");
  assert.equal(row?.nextAttemptAt, null, "no retry gives an account an EviMed id");
  assert.equal(await service.retryDue(), 0);
  assert.equal(service.status().counters.unlinked, 1);
  // Its balance is unknown rather than an error, so its start is admitted.
  assert.deepEqual(await service.balanceFor(localUserId),
    { balance: null, frozen: null, unit: "灵豆", status: "evimed_credits_account_unlinked" });
  assert.equal((await service.assertBalanceForStart(localUserId, "adr-analysis")).allowed, true);
  assert.equal(client.calls.length, 0);
  // And the linked account's balance read names EviMed's id, not ours.
  assert.equal((await service.balanceFor(userId)).status, "ok");
  assert.deepEqual(client.calls, [{ balanceOf: evimedUserId }]);
  // Financial evidence pins its upstream payer for retries after account erasure.
  const stored = await database.query("SELECT * FROM evimed_credits.settlements WHERE user_id=$1", [userId]);
  assert.ok(stored.rowCount > 0);
  assert.ok(stored.rows.some(row => row.upstream_user_id === evimedUserId));
});

test("the account row holds EviMed's id for an EviMed account only", options, async () => {
  await assert.rejects(
    database.query("UPDATE evimed_control.users SET evimed_user_id='1' WHERE id=$1", [localUserId]),
    (/** @type {any} */ error) => error?.code === "23514",
  );
  await assert.rejects(
    database.query("UPDATE evimed_control.users SET evimed_user_id='' WHERE id=$1", [userId]),
    (/** @type {any} */ error) => error?.code === "23514",
  );
  assert.equal(await evimedUserIdOf(userId), evimedUserId);
  assert.equal(await evimedUserIdOf(localUserId), null);
});

test("a run that cost nothing is recorded as free, with no call at all", options, async () => {
  const runId = `run_${randomUUID()}`;
  const client = upstream({ answer: () => { throw new Error("must not be called"); } });
  const service = credits({ client, costs: { [runId]: 0 } });
  assert.deepEqual(await service.settleRun({ userId, projectId, runId, capabilityId: "adr-analysis", subject: "一次免费的提问" }),
    { status: "settled", credits: 0, reason: "no_charge" });
  const row = await service.settlementOf(userId, runId);
  assert.equal(row?.status, "settled");
  assert.equal(row?.credits, 0);
  assert.equal(row?.receiptId, null);
  assert.equal(client.calls.length, 0);
  // A run the ledger knows nothing about is the same case, not an error.
  const unknown = `run_${randomUUID()}`;
  assert.deepEqual(await service.settleRun({ userId, projectId, runId: unknown }), { status: "settled", credits: 0, reason: "no_charge" });
});

test("a run's dispatch id is settled with it, once", options, async () => {
  // A bounded workflow's model rows are attributed to its dispatch id, so a
  // settlement that read only the run id would charge nothing for it.
  const runId = `run_${randomUUID()}`;
  const dispatchId = `episode-${randomUUID().replaceAll("-", "")}-v1`;
  const client = upstream();
  const service = credits({ client, costs: { [runId]: 0.4, [dispatchId]: 1.6 } });
  assert.deepEqual(await service.settleRun({ userId, projectId, runId, dispatchId, capabilityId: "adr-analysis", subject: "主动研究一轮" }),
    { status: "settled", credits: 200 });
  assert.equal(client.calls[0].requestId, runId, "the run id is the idempotency key, not the dispatch id");
});

test("the estimate reads the capability's own settled history once it has one", options, async () => {
  const capability = `history-${randomUUID().slice(0, 8)}`;
  const client = upstream();
  const service = credits({ client, costs: {} });
  const before = await service.estimate(capability);
  assert.deepEqual([before.basis, before.samples], ["none", 0], "an unknown capability has neither history nor a manifest");
  for (const [index, cost] of [0.8, 1.0, 1.2, 1.4, 3.0, 4.0].entries()) {
    const runId = `run_${randomUUID()}`;
    const withCost = credits({ client, costs: { [runId]: cost } });
    await withCost.settleRun({ userId, projectId, runId, capabilityId: capability, subject: `第 ${index + 1} 次` });
  }
  const after = await service.estimate(capability);
  assert.equal(after.basis, "history");
  assert.equal(after.samples, 6);
  assert.equal(after.unit, "灵豆");
  // P50 and P90 of the six costs, in 灵豆 at this deployment's rate.
  assert.equal(after.low, 130);
  assert.ok(after.high >= 340 && after.high <= 400, String(after.high));
  // And a balance below the typical cost refuses a start, while one above it
  // does not. This is the 「余额不足在开始前拦住」 of §9.6.
  const poor = credits({ client: { ...upstream({ balance: 20 }), configured: true, status: () => ({ configured: true }) }, costs: {} });
  await assert.rejects(poor.assertBalanceForStart(userId, capability),
    (/** @type {any} */ error) => error.status === 402 && error.code === "credits_exhausted");
  const rich = credits({ client: { ...upstream({ balance: 900 }), configured: true, status: () => ({ configured: true }) }, costs: {} });
  const allowed = await rich.assertBalanceForStart(userId, capability);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.balance, 900);
  assert.equal(allowed.estimate.low, 130);
});

test("a charge outlives the project it was made in", options, async () => {
  // Deleting a project used to delete every model request charged under it
  // (usagePersistence.mjs, 2026-09-20). A settlement is the record of money
  // leaving, so it keeps only the account.
  const otherProject = `credits-doomed-${randomUUID().slice(0, 8)}`;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Doomed',1048576)", [userId, otherProject]);
  const runId = `run_${randomUUID()}`;
  const service = credits({ client: upstream(), costs: { [runId]: 1 } });
  await service.settleRun({ userId, projectId: otherProject, runId, capabilityId: "adr-analysis", subject: "会被删掉的项目" });
  await database.query("DELETE FROM evimed_control.projects WHERE user_id=$1 AND id=$2", [userId, otherProject]);
  const row = await service.settlementOf(userId, runId);
  assert.equal(row?.status, "settled");
  assert.equal(row?.credits, 100);
  assert.equal(row?.projectId, otherProject, "what it cost is a fact, and so is which project asked");
});

test("autopilot retry settlement charges the real owner once and never charges its unsent predecessor", options, async () => {
  for (const suffix of ["", "-v1"]) for (const reversed of [false, true]) {
    const logical = `episode-${randomUUID().replaceAll("-", "")}${suffix}`;
    const runId = `run_${randomUUID()}`;
    const oldId = `run_${randomUUID()}`;
    const client = upstream();
    const service = credits({ client, costs: { [logical]: 1.6, [runId]: 0.4 } });
    const sent = { userId, projectId, runId, dispatchId: `${logical}-a2`, status: "succeeded", effectiveRouteReason: "autopilot:research" };
    const old = { ...sent, runId: oldId, dispatchId: logical, status: "failed", dispatchStatus: "rejected", errorCode: "product_job_lease_lost" };
    if (reversed) assert.equal((await service.settleRun(old)).credits, 0);
    assert.deepEqual(await service.settleRun(sent), { status: "settled", credits: 200 });
    assert.deepEqual(await service.settleRun(sent), { status: "settled", credits: 200, duplicate: true });
    assert.equal((await service.settleRun(old)).credits, 0);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].requestId, runId);
    const saved = await service.settlementOf(userId, runId);
    assert.equal(saved.credits, 200);
  }
});

test('research task billing preserves fractional evidence and deduplicates child spend', options, async () => {
  const since = new Date();
  const { UsageLedger } = await import('../src/usageLedger.mjs');
  const usage = new UsageLedger(database);
  const runId = `run_${randomUUID()}`;
  const childId = `run_${randomUUID()}`;
  const client = upstream();
  const service = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 1, researchBillingEnabled: true },
    database, client, usageLedger: usage, evimedUserIdOf });
  await service.ready();
  await usage.recordSettled({ id: `usage_${randomUUID()}`, userId, projectId, runId: childId,
    purpose: 'kernel', model: 'test-model', priceVersion: 'test-price-v1', currency: 'CNY',
    requestFingerprint: 'a'.repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 },
    actualCost: 1.90000001, priced: true });
  const accountCreatedAt = (await database.query('SELECT created_at::text AS epoch FROM evimed_control.users WHERE id=$1', [userId])).rows[0].epoch;
  const run = { userId, projectId, runId, dispatchId: childId, status: 'succeeded', subject: 'Research task', startedAt: new Date().toISOString(), accountCreatedAt };
  const missingEpoch = await service.settleRun({ ...run, runId: `run_${randomUUID()}`, accountCreatedAt: null });
  assert.equal(missingEpoch.reason, 'account_generation_missing');
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => service.settleRun(run)));
  assert.equal(concurrent.filter(result => result.duplicate).length, 4);
  assert.equal(concurrent.filter(result => result.credits === 1).length, 5);
  assert.equal((await service.settleRun(run)).duplicate, true);
  assert.equal((await service.settleRun({ ...run, runId: childId, dispatchId: null })).credits, 0);
  assert.equal(client.calls.filter(call => call.requestId).length, 1);
  const history = await service.statements(userId, { limit: 1 });
  assert.equal(history.items.length, 1);
  assert.ok(history.nextCursor);
  const second = await service.statements(userId, { cursor: history.nextCursor });
  assert.equal(second.items.find(item => item.id === runId)?.waivedCny, '0.90000001');
  assert.equal((await service.statements(localUserId, { cursor: history.nextCursor })).items.some(item => item.id === runId || item.id === childId), false);
  const summary = await service.allowanceSummary(userId, { since });
  assert.equal(summary.spentCny, 1);
  const failedRunId = `run_${randomUUID()}`;
  await usage.recordSettled({ id: `usage_${randomUUID()}`, userId, projectId, runId: failedRunId,
    purpose: 'kernel', model: 'test-model', priceVersion: 'test-price-v1', currency: 'CNY',
    requestFingerprint: 'b'.repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 },
    actualCost: 2.75, priced: true });
  assert.equal((await service.settleRun({ ...run, runId: failedRunId, dispatchId: null, status: 'failed' })).credits, 0);
  const failedTask = (await service.statements(userId)).items.find(item => item.id === failedRunId);
  assert.equal(failedTask?.status, 'waived');
  assert.equal(failedTask?.actualCny, '2.75000000');
  assert.equal(failedTask?.waivedCny, '2.75000000');
  assert.equal(client.calls.filter(call => call.requestId).length, 1);
  // A failed physical attempt cannot consume the successful sibling's logical calls.
  const logical = `episode-${randomUUID().replaceAll('-', '')}`;
  const logicalRequestId = `usage_${randomUUID()}`;
  await usage.recordSettled({ id: logicalRequestId, userId, projectId, runId: logical,
    purpose: 'kernel', model: 'test-model', priceVersion: 'test-price-v1', currency: 'CNY',
    requestFingerprint: 'c'.repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 },
    actualCost: 4, priced: true });
  const failedPhysicalId = `run_${randomUUID()}`;
  assert.equal((await service.settleRun({ ...run, runId: failedPhysicalId, dispatchId: logical,
    effectiveRouteReason: 'autopilot:research', status: 'failed' })).credits, 0);
  const successful = { ...run, runId: `run_${randomUUID()}`, dispatchId: `${logical}-a2`, effectiveRouteReason: 'autopilot:research' };
  assert.equal((await service.settleRun(successful)).credits, 4);
  assert.equal((await service.settleRun({ ...successful, runId: `run_${randomUUID()}`, dispatchId: `${logical}-a3` })).duplicate, true);
  const attributed = await database.query('SELECT * FROM evimed_credits.research_task_requests WHERE request_id=$1', [logicalRequestId]);
  assert.notEqual(attributed.rows[0].run_id, failedPhysicalId);

  // Policy activation excludes old legacy aliases, and remains active if its flag rolls back.
  const oldAlias = `alias_${randomUUID()}`;
  const oldRunId = `run_${randomUUID()}`;
  await usage.recordSettled({ id: `usage_${randomUUID()}`, userId, projectId, runId: oldAlias,
    purpose: 'kernel', model: 'test-model', priceVersion: 'test-price-v1', currency: 'CNY',
    requestFingerprint: 'd'.repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 },
    actualCost: 3, priced: true, now: new Date('2000-01-01') });
  await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,memo,cost_cny,credits,credits_per_cny,status,settled_at)
    VALUES($1,$2,'Old paid alias',3,3,1,'settled',clock_timestamp())`, [oldRunId,userId]);
  const callsBeforeAlias = client.calls.filter(call => call.requestId).length;
  const aliasRetry = { ...run, runId: `run_${randomUUID()}`, dispatchId: oldAlias };
  assert.equal((await service.settleRun(aliasRetry)).credits, 0);
  const oldAliasStatement = (await service.statements(userId, { limit: 100 })).items.find(item => item.runId === aliasRetry.runId);
  assert.equal(oldAliasStatement.actualCny, '3.00000000');
  assert.equal(oldAliasStatement.billableCny, '0.00000000');
  assert.equal(client.calls.filter(call => call.requestId).length, callsBeforeAlias);
  const rollback = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 1, researchBillingEnabled: false },
    database, client, usageLedger: usage, evimedUserIdOf });
  const rolledRunId = `run_${randomUUID()}`;
  await usage.recordSettled({ id: `usage_${randomUUID()}`, userId, projectId, runId: rolledRunId,
    purpose: 'kernel', model: 'test-model', priceVersion: 'test-price-v1', currency: 'CNY',
    requestFingerprint: 'e'.repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 },
    actualCost: 1.9, priced: true });
  assert.equal((await rollback.settleRun({ ...run, runId: rolledRunId, dispatchId: null })).credits, 1,
    'sticky policy keeps floor semantics rather than reopening legacy rounding');
  const wrongRateRollback = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 100, researchBillingEnabled: false },
    database, client, usageLedger: usage, evimedUserIdOf });
  assert.equal((await wrongRateRollback.settleRun({ ...run, runId: `run_${randomUUID()}` })).errorCode, 'evimed_credits_request_invalid');
  await assert.rejects(wrongRateRollback.ready(), error => error.code === 'evimed_credits_request_invalid' && error.status === 503);
  assert.equal((await service.settleRun({ ...run, runId: `run_${randomUUID()}`, dispatchId: `${logical}-a4`,
    effectiveRouteReason: 'autopilot:research', status: 'failed' })).credits, 0,
    'a later failed callback still cannot revisit the successful logical charge');

  const disabled = new EvimedCreditsService({ config: { evimedCreditsEnabled: false, evimedCreditsPerCny: 1, researchBillingEnabled: true },
    database, client, usageLedger: usage, evimedUserIdOf });
  assert.equal((await disabled.settleRun({ ...run, runId: `run_${randomUUID()}` })).status, 'skipped');

  // Background overhead stays visible, never described as a customer waiver.
  const overheadFailedId = `run_${randomUUID()}`;
  for (const [purpose, actualCost] of [['kernel',2.75],['title',3]]) await usage.recordSettled({
    id: `usage_${randomUUID()}`, userId, projectId, runId: overheadFailedId, purpose, actualCost,
    model: 'test-model', priceVersion: 'test-price-v1', currency: 'CNY', requestFingerprint: 'f'.repeat(64),
    usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 }, priced: true });
  await service.settleRun({ ...run, runId: overheadFailedId, dispatchId: null, status: 'failed' });
  const overhead = (await service.statements(userId, { limit: 100 })).items.find(item => item.runId === overheadFailedId);
  assert.equal(overhead.actualCny, '5.75000000');
  assert.equal(overhead.platformCostCny, '3.00000000');
  assert.equal(overhead.waivedCny, '2.75000000');

  // A pending outbox retains its upstream payer and can finish after account erasure.
  await database.query("UPDATE evimed_credits.settlements SET next_attempt_at='2100-01-01' WHERE status='pending'");
  let walletOffline = true;
  let settlementNow = new Date();
  const pendingClient = upstream({ answer: () => {
    if (walletOffline) throw new EvimedCreditsError('evimed_credits_unreachable','Test-only outage');
    return { receiptId: 'retained-outbox-receipt' };
  } });
  const pendingService = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 1, researchBillingEnabled: true },
    database, client: pendingClient, usageLedger: usage, evimedUserIdOf, now: () => settlementNow });
  const pendingId = `run_${randomUUID()}`;
  await usage.recordSettled({ id: `usage_${randomUUID()}`, userId, projectId, runId: pendingId,
    purpose: 'kernel', model: 'test-model', priceVersion: 'test-price-v1', currency: 'CNY',
    requestFingerprint: '9'.repeat(64), usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 }, actualCost: 2, priced: true });
  assert.equal((await pendingService.settleRun({ ...run, runId: pendingId, dispatchId: null })).status, 'pending');
  const pendingStatement = (await service.statements(userId, { limit: 100 })).items.find(item => item.runId === pendingId);
  assert.equal(pendingStatement.amount, null);
  assert.equal(pendingStatement.requestedAmount, '2.00000000');
  const missingPayerId = `run_${randomUUID()}`;
  await database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,memo,cost_cny,credits,credits_per_cny,status,attempts,next_attempt_at,owner_created_at)
    SELECT $1,id,'Unresolved old payer',2,2,1,'pending',1,$3::timestamptz,created_at FROM evimed_control.users WHERE id=$2`,
    [missingPayerId,userId,new Date(settlementNow.getTime()+EVIMED_CREDITS_BACKOFF_MS[0]).toISOString()]);
  // Financial evidence survives both workspace and account erasure.
  await database.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-user:${userId}`]);
    await prepareResearchBillingAccountDeletion(client,userId);
    await client.query('DELETE FROM evimed_control.users WHERE id=$1', [userId]);
  });
  assert.deepEqual((await service.statements(userId)).items, []);
  const kept = await database.query('SELECT * FROM evimed_credits.research_tasks WHERE run_id=$1', [runId]);
  assert.equal(kept.rows[0].status, 'settled');
  assert.equal(kept.rows[0].title, 'Research task');
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type,evimed_user_id) VALUES($1,'Reused account','evimed','replacement-wallet')", [userId]);
  const restarted = new ControlPlaneDatabase({ databaseUrl,databasePoolMax:2,databaseConnectionTimeoutMs:3000 });
  try { await migrateEvimedCredits(restarted); } finally { await restarted.close(); }
  assert.deepEqual((await service.statements(userId)).items, []);
  assert.equal((await service.allowanceSummary(userId)).spentCny, 0);
  // Two exact incarnations can share one JavaScript millisecond. The old
  // snapshot must fail even when its startedAt looks equal after truncation.
  await database.query(`UPDATE evimed_control.users SET created_at=date_trunc('milliseconds',$2::timestamptz)+
    CASE WHEN $2::timestamptz=date_trunc('milliseconds',$2::timestamptz)+interval '0.0009 second'
      THEN interval '0.0008 second' ELSE interval '0.0009 second' END WHERE id=$1`, [userId,accountCreatedAt]);
  const replacementEpoch = (await database.query('SELECT created_at::text AS epoch FROM evimed_control.users WHERE id=$1', [userId])).rows[0].epoch;
  assert.equal(new Date(replacementEpoch).getTime(), new Date(accountCreatedAt).getTime());
  const beforeStale = client.calls.filter(call => call.requestId).length;
  const late = await service.settleRun({ ...run, runId: `run_${randomUUID()}` });
  assert.equal(late.reason, 'account_changed');
  assert.equal(client.calls.filter(call => call.requestId).length, beforeStale);
  const current = await service.settleRun({ ...run, runId: `run_${randomUUID()}`, dispatchId: null, accountCreatedAt: replacementEpoch, startedAt: '2000-01-01T00:00:00Z' });
  assert.equal(current.status, 'settled', 'exact same incarnation accepts a harmless start-clock skew');
  walletOffline = false;
  settlementNow = new Date(settlementNow.getTime()+EVIMED_CREDITS_BACKOFF_MS[0]+1);
  assert.equal(await pendingService.retryDue(), 2);
  const retained = (await database.query('SELECT * FROM evimed_credits.settlements WHERE run_id=$1', [pendingId])).rows[0];
  assert.equal(retained.status, 'settled');
  assert.equal(retained.receipt_id, 'retained-outbox-receipt');
  assert.equal(await service.settlementOf(userId,pendingId), null);
  assert.equal(pendingClient.calls.at(-1).userId, evimedUserId);
  const unbound = (await database.query('SELECT status,upstream_user_id FROM evimed_credits.settlements WHERE run_id=$1', [missingPayerId])).rows[0];
  assert.equal(unbound.status, 'refused');
  assert.equal(unbound.upstream_user_id, null, 'restart cannot bind an orphan to a replacement wallet');
  assert.equal(pendingClient.calls.some(call => call.userId === 'replacement-wallet'), false);


  await database.query('DELETE FROM evimed_credits.research_task_requests WHERE run_id IN (SELECT run_id FROM evimed_credits.research_tasks WHERE user_id=$1)', [userId]);
  await database.query('DELETE FROM evimed_credits.research_tasks WHERE user_id=$1', [userId]);
});
