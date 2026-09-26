// 灵豆 settlement against a real PostgreSQL: the properties that are the
// storage's, not the code's — one charge per run however many times it is
// settled, a pending row that exists before the deduction leaves, a bounded
// retry, a refusal that is never retried, and a charge that outlives its
// project.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EVIMED_CREDITS_BACKOFF_MS, EVIMED_CREDITS_MAX_ATTEMPTS, EvimedCreditsService } from "../src/evimedCreditsService.mjs";
import { EvimedCreditsError } from "../src/evimedCreditsClient.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const userId = `credits_user_${randomUUID()}`;
const projectId = "credits-project";
/** @type {any} */
let database;

const config = { evimedCreditsEnabled: true, evimedCreditsPerCny: 100 };

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 3_000 });
  await database.migrate();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Credits test','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Credits',1048576)", [userId, projectId]);
});

after(async () => {
  if (!databaseUrl) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]).catch(() => {});
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
    async balance() { return { balance, frozen: 0 }; },
  };
}

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
  config, database, client, usageLedger: ledger(costs), now,
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
