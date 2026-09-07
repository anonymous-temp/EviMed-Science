import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = `usage_${randomUUID()}`;
const other = `usage_${randomUUID()}`;
// A third account kept out of the shared fixtures above: the windowing and
// reconciliation tests assert exact open-cost totals, which the accumulated
// reservations of the other tests would make unreadable.
const stale = `usage_${randomUUID()}`;
let database;
let ledger;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 8, databaseConnectionTimeoutMs: 2_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Usage owner','development'),($2,'Other owner','development'),($3,'Stale owner','development')", [owner, other, stale]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Usage',1048576),($2,'default','Other',1048576),($3,'default','Stale',1048576)", [owner, other, stale]);
  ledger = new UsageLedger(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other, stale]]);
  await database.close();
});

function reservation(userId = owner, values = {}) {
  const id = values.id ?? randomUUID();
  return {
    id, userId, projectId: "default", model: "deepseek-v4-flash",
    priceVersion: "evimed-reference-2026-09-05", currency: "CNY",
    requestFingerprint: createHash("sha256").update(id).digest("hex"),
    estimatedCost: 0.75, dailyLimit: 0, weeklyLimit: 0,
    ...values,
  };
}

test("concurrent reservations cannot oversubscribe one account budget", options, async () => {
  const now = new Date("2026-09-06T00:00:00.000Z");
  const results = await Promise.allSettled([
    ledger.reserveModel(reservation(owner, { dailyLimit: 1, now })),
    ledger.reserveModel(reservation(owner, { dailyLimit: 1, now })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.equal(rejection.reason.code, "usage_budget_exceeded");
  assert.equal(rejection.reason.status, 402);
});

test("settlement is idempotent and retains exact provider counts and price version", options, async () => {
  const reserved = await ledger.reserveModel(reservation());
  const usage = { cacheHitTokens: 11, cacheMissTokens: 23, completionTokens: 37 };
  const settled = await ledger.settleModel(owner, reserved.id, {
    usage, actualCost: 0.0004, priced: true, providerRequestId: "provider-fixture-one",
  });
  assert.equal(settled.status, "settled");
  assert.equal(settled.priceVersion, "evimed-reference-2026-09-05");
  assert.deepEqual(settled.usage, usage);
  assert.equal((await ledger.settleModel(owner, reserved.id, {
    usage, actualCost: 0.0004, priced: true, providerRequestId: "provider-fixture-one",
  })).revision, settled.revision);
  await assert.rejects(ledger.settleModel(owner, reserved.id, {
    usage: { ...usage, completionTokens: 38 }, actualCost: 0.0004, priced: true,
    providerRequestId: "provider-fixture-one",
  }), { code: "usage_settlement_conflict" });
});

test("released, uncertain and settled calls are distinguished in durable summaries", options, async () => {
  const released = await ledger.reserveModel(reservation());
  await ledger.release(owner, released.id, "provider_refused");
  const uncertain = await ledger.reserveModel(reservation());
  await ledger.markUncertain(owner, uncertain.id, "response_usage_missing", { providerRequestId: "provider-unknown" });
  const summary = await ledger.summary(owner, { since: new Date("2020-01-01T00:00:00Z") });
  assert.ok(summary.settledCalls >= 1);
  assert.ok(summary.releasedCalls >= 1);
  assert.ok(summary.uncertainCalls >= 1);
  assert.ok(summary.reservedCost >= 0.75);
  assert.equal(summary.currency, "CNY");
  assert.ok(summary.byModel.some((item) => item.model === "deepseek-v4-flash"));
  assert.deepEqual(summary.priceVersions, ["evimed-reference-2026-09-05"]);
  assert.equal((await ledger.summary(other, { since: new Date("2020-01-01T00:00:00Z") })).totalCalls, 0);
});

test("a project foreign to the account cannot receive a reservation", options, async () => {
  const before = await ledger.summary(owner, { since: new Date("2020-01-01T00:00:00Z") });
  await assert.rejects(ledger.reserveModel(reservation(owner, { projectId: "missing" })), { code: "23503" });
  assert.equal((await ledger.summary(owner, { since: new Date("2020-01-01T00:00:00Z") })).reservedCalls, before.reservedCalls);
});

test("settlement authority remains account scoped even when a request id is known", options, async () => {
  const reserved = await ledger.reserveModel(reservation());
  const usage = { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 };
  await assert.rejects(ledger.settleModel(other, reserved.id, { usage, actualCost: 0.1, priced: true }), { code: "usage_request_not_found" });
  await assert.rejects(ledger.release(other, reserved.id, "foreign_release"), { code: "usage_request_not_found" });
  await assert.rejects(ledger.markUncertain(other, reserved.id, "foreign_uncertain"), { code: "usage_request_not_found" });
  assert.equal((await ledger.summary(owner, { since: new Date("2020-01-01T00:00:00Z") })).reservedCalls >= 1, true);
});

test("monetary fields require finite numeric values and one currency", options, async () => {
  for (const value of [null, false, "", [], "0.5"]) {
    await assert.rejects(ledger.reserveModel(reservation(owner, { estimatedCost: value })), { code: "usage_payload_invalid" });
  }
  await assert.rejects(ledger.reserveModel(reservation(owner, { currency: "USD" })), { code: "usage_payload_invalid" });
  const reserved = await ledger.reserveModel(reservation());
  await assert.rejects(ledger.settleModel(owner, reserved.id, {
    usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 }, actualCost: null, priced: true,
  }), { code: "usage_payload_invalid" });
});

test("reservation retries cannot silently reuse another price or an expired request", options, async () => {
  const now = new Date();
  const input = reservation(owner, { now, ttlMs: 60_000 });
  const first = await ledger.reserveModel(input);
  assert.equal((await ledger.reserveModel({ ...input })).id, first.id);
  await assert.rejects(ledger.reserveModel({ ...input, priceVersion: "another-price" }), { code: "usage_reservation_conflict" });
  await assert.rejects(ledger.reserveModel({ ...input, estimatedCost: input.estimatedCost + 0.01 }), { code: "usage_reservation_conflict" });
  await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=now()-interval '1 second' WHERE id=$1", [first.id]);
  await assert.rejects(ledger.reserveModel({ ...input }), { code: "usage_reservation_conflict" });
  const past = reservation(owner, { now: new Date(Date.now() - 120_000), ttlMs: 60_000 });
  await ledger.reserveModel(past);
  await assert.rejects(ledger.reserveModel({ ...past }), { code: "usage_reservation_conflict" });
});

test("settlement and the next reservation serialize on the same account budget", options, async () => {
  const first = await ledger.reserveModel(reservation(other, { estimatedCost: 0.4, dailyLimit: 1 }));
  const blocker = await database.pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM evimed_usage.model_requests WHERE id=$1 FOR UPDATE", [first.id]);
  const settlement = ledger.settleModel(other, first.id, {
    usage: { cacheHitTokens: 0, cacheMissTokens: 10, completionTokens: 10 },
    actualCost: 0.9, priced: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const next = ledger.reserveModel(reservation(other, { estimatedCost: 0.2, dailyLimit: 1 }));
  try {
    const early = await Promise.race([next.then(() => "reserved", () => "rejected"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 100))]);
    assert.equal(early, "waiting", "a new reservation must wait for the in-flight settlement");
  } finally {
    await blocker.query("COMMIT");
    blocker.release();
  }
  assert.equal((await settlement).status, "settled");
  await assert.rejects(next, { code: "usage_budget_exceeded" });
});

test("one proactive run has an independent hard ceiling and exact summary", options, async () => {
  const runId = `run-${randomUUID()}`;
  const first = await ledger.reserveModel(reservation(owner, {
    runId, estimatedCost: 0.4, runLimit: 0.7, dailyLimit: 0, weeklyLimit: 0,
  }));
  await ledger.settleModel(owner, first.id, {
    usage: { cacheHitTokens: 2, cacheMissTokens: 3, completionTokens: 5 },
    actualCost: 0.5, priced: true,
  });
  await assert.rejects(ledger.reserveModel(reservation(owner, {
    runId, estimatedCost: 0.3, runLimit: 0.7, dailyLimit: 0, weeklyLimit: 0,
  })), { code: "usage_budget_exceeded" });
  const summary = await ledger.summaryRun(owner, runId);
  assert.equal(summary.calls, 1);
  assert.equal(summary.actualCost, 0.5);
  assert.equal(summary.openCost, 0);
  assert.equal(summary.modelId, "deepseek-v4-flash");
  assert.equal(summary.providerId, "deepseek");
  assert.equal(summary.inputTokens, 5);
  assert.equal(summary.outputTokens, 5);
  assert.equal(summary.settledCalls, 1);
  assert.equal(summary.reservedCalls, 0);
});

test("run receipts aggregate actual token counts and never invent a single model for mixed-model work", options, async () => {
  const runId = `run-${randomUUID()}`;
  for (const [model, hit, miss, output] of [["deepseek-v4-pro", 7, 11, 13], ["deepseek-v4-flash", 17, 19, 23]]) {
    const request = await ledger.reserveModel(reservation(owner, { runId, model }));
    await ledger.settleModel(owner, request.id, { usage: { cacheHitTokens: hit, cacheMissTokens: miss, completionTokens: output }, actualCost: 0.01, priced: true });
  }
  const result = await ledger.summaryRun(owner, runId);
  assert.equal(result.modelId, null);
  assert.equal(result.inputTokens, 54);
  assert.equal(result.outputTokens, 36);
  assert.equal(result.actualCost, 0.02);
  assert.equal((await ledger.summaryRun(other, runId)).settledCalls, 0);
});

test("run receipts flag incomplete historical settled token accounting", options, async () => {
  const runId = `run-${randomUUID()}`;
  const request = await ledger.reserveModel(reservation(owner, { runId }));
  await ledger.settleModel(owner, request.id, { actualCost: 0.01, priced: true,
    usage: { cacheHitTokens: 1, cacheMissTokens: 2, completionTokens: 3 } });
  await database.query("UPDATE evimed_usage.model_requests SET cache_miss_tokens=NULL WHERE id=$1", [request.id]);
  const result = await ledger.summaryRun(owner, runId);
  assert.equal(result.settledCalls, 1);
  assert.equal(result.incompleteUsageCalls, 1);
});

test("an uncertain reservation leaves the rolling budget window instead of holding it forever", options, async () => {
  const request = await ledger.reserveModel(reservation(stale, { estimatedCost: 0.6 }));
  await ledger.markUncertain(stale, request.id, "response_usage_missing", { providerRequestId: "provider-truncated" });
  // Fresh: the account is still paying for a call that may have been charged.
  await assert.rejects(ledger.assertWithinLimits(stale, { dailyLimit: 0.5 }), { code: "usage_budget_exceeded" });
  await assert.rejects(ledger.assertWithinLimits(stale, { weeklyLimit: 0.5 }), { code: "usage_budget_exceeded" });
  // Two days old: outside the 24h window, still inside the 7d one.
  await database.query("UPDATE evimed_usage.model_requests SET created_at=now()-interval '2 days' WHERE id=$1", [request.id]);
  assert.deepEqual(await ledger.assertWithinLimits(stale, { dailyLimit: 0.5 }), { allowed: true });
  await assert.rejects(ledger.assertWithinLimits(stale, { weeklyLimit: 0.5 }), { code: "usage_budget_exceeded" });
  // Eight days old: outside both, so the budget it held comes back.
  await database.query("UPDATE evimed_usage.model_requests SET created_at=now()-interval '8 days' WHERE id=$1", [request.id]);
  assert.deepEqual(await ledger.assertWithinLimits(stale, { dailyLimit: 0.5, weeklyLimit: 0.5 }), { allowed: true });
  const reserved = await ledger.reserveModel(reservation(stale, { estimatedCost: 0.4, dailyLimit: 0.5, weeklyLimit: 0.5 }));
  assert.equal(reserved.status, "reserved");
  await ledger.release(stale, reserved.id, "test_cleanup");
});

test("an expired reservation is reconciled to uncertain rather than left stranded", options, async () => {
  const request = await ledger.reserveModel(reservation(stale, { estimatedCost: 0.2 }));
  await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [request.id]);
  assert.ok((await ledger.health()).expiredReservations >= 1, "health must see the stuck reservation");
  const first = await ledger.reconcileExpiredReservations({ limit: 100 });
  assert.ok(first.reconciled >= 1);
  assert.equal(first.failedAccounts, 0, "a healthy sweep skips no account");
  const row = (await database.query("SELECT status,error_code,revision,settled_at,actual_cost FROM evimed_usage.model_requests WHERE id=$1", [request.id])).rows[0];
  assert.equal(row.status, "uncertain", "the provider may already have charged, so it is uncertain and never released");
  assert.equal(row.error_code, "reservation_expired");
  assert.equal(Number(row.revision), request.revision + 1);
  assert.ok(row.settled_at);
  assert.equal(row.actual_cost, null);
  const stuck = await database.query(`SELECT count(*)::integer AS n FROM evimed_usage.model_requests
    WHERE id=$1 AND status='reserved' AND reservation_expires_at<=now()`, [request.id]);
  assert.equal(stuck.rows[0].n, 0);
  assert.equal((await ledger.reconcileExpiredReservations({ limit: 100 })).reconciled, 0, "the sweep is idempotent");
});

test("a reconciled reservation is charged only while it is inside the window", options, async () => {
  const request = await ledger.reserveModel(reservation(stale, { estimatedCost: 0.9 }));
  await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [request.id]);
  await ledger.reconcileExpiredReservations({ limit: 100 });
  await assert.rejects(ledger.assertWithinLimits(stale, { dailyLimit: 0.8 }), { code: "usage_budget_exceeded" });
  await database.query("UPDATE evimed_usage.model_requests SET created_at=now()-interval '8 days' WHERE id=$1", [request.id]);
  assert.deepEqual(await ledger.assertWithinLimits(stale, { dailyLimit: 0.8, weeklyLimit: 0.8 }), { allowed: true });
});

test("the sweep waits behind an in-flight settlement on the same account", options, async () => {
  const request = await ledger.reserveModel(reservation(stale, { estimatedCost: 0.3 }));
  await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [request.id]);
  const blocker = await database.pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM evimed_usage.model_requests WHERE id=$1 FOR UPDATE", [request.id]);
  const settlement = ledger.settleModel(stale, request.id, {
    usage: { cacheHitTokens: 1, cacheMissTokens: 2, completionTokens: 3 }, actualCost: 0.25, priced: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const sweep = ledger.reconcileExpiredReservations({ limit: 100 });
  try {
    const early = await Promise.race([
      sweep.then(() => "swept", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    assert.equal(early, "waiting", "the sweep must take the same account lock the settlement holds");
  } finally {
    await blocker.query("COMMIT");
    blocker.release();
  }
  assert.equal((await settlement).status, "settled");
  await sweep;
  const row = (await database.query("SELECT status,error_code FROM evimed_usage.model_requests WHERE id=$1", [request.id])).rows[0];
  assert.equal(row.status, "settled", "a settlement that won the race is never overwritten by the sweep");
  assert.equal(row.error_code, null);
});

test("the sweep batch is bounded and reports what it left behind", options, async () => {
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const request = await ledger.reserveModel(reservation(stale, { estimatedCost: 0.01 }));
    ids.push(request.id);
  }
  await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=now()-interval '1 minute' WHERE id=ANY($1::text[])", [ids]);
  const partial = await ledger.reconcileExpiredReservations({ limit: 1 });
  assert.equal(partial.reconciled, 1);
  assert.ok(partial.remaining >= 2, "a bounded sweep reports the rows still waiting");
  const rest = await ledger.reconcileExpiredReservations({ limit: 100 });
  assert.ok(rest.reconciled >= 2);
  const remainingOwn = await database.query(`SELECT count(*)::integer AS n FROM evimed_usage.model_requests
    WHERE id=ANY($1::text[]) AND status<>'uncertain'`, [ids]);
  assert.equal(remainingOwn.rows[0].n, 0);
  await assert.rejects(ledger.reconcileExpiredReservations({ limit: 0 }), { code: "product_parameter_invalid" });
});

test("a late genuine cause replaces the sweep's placeholder without moving the money", options, async () => {
  const request = await ledger.reserveModel(reservation(stale, { estimatedCost: 0.05 }));
  await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [request.id]);
  assert.ok((await ledger.reconcileExpiredReservations({ limit: 100 })).reconciled >= 1);
  const late = await ledger.markUncertain(stale, request.id, "response_usage_missing", { providerRequestId: "provider-late" });
  assert.equal(late.status, "uncertain");
  assert.equal(late.errorCode, "response_usage_missing", "the real cause must survive the sweep's placeholder");
  assert.equal(late.revision, request.revision + 2, "the sweep wrote once and the late call once");
  // No longer a placeholder: the row has a concrete cause, so it is terminal again.
  await assert.rejects(ledger.release(stale, request.id, "provider_refused"), { code: "usage_settlement_conflict" });
  const settled = await ledger.settleModel(stale, request.id, {
    usage: { cacheHitTokens: 1, cacheMissTokens: 1, completionTokens: 1 }, actualCost: 0.05, priced: true,
  });
  assert.equal(settled.status, "settled", "a settlement that finally arrives is still accepted");
  assert.equal(settled.errorCode, null);
});

test("a late release of a swept reservation keeps the state the sweep reported", options, async () => {
  const request = await ledger.reserveModel(reservation(stale, { estimatedCost: 0.05 }));
  await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [request.id]);
  await ledger.reconcileExpiredReservations({ limit: 100 });
  const released = await ledger.release(stale, request.id, "provider_refused");
  assert.equal(released.status, "uncertain",
    "the provider may already have charged, and a late report does not undo that — only the cause is written");
  assert.equal(released.errorCode, "provider_refused");
  const row = (await database.query("SELECT status,error_code FROM evimed_usage.model_requests WHERE id=$1", [request.id])).rows[0];
  assert.equal(row.status, "uncertain");
  assert.equal(row.error_code, "provider_refused");
});

test("the sweep decides expiry on the database clock, not the process instant", options, async () => {
  const request = await ledger.reserveModel(reservation(stale, { estimatedCost: 0.05, ttlMs: 60_000 }));
  // Expires in the database's own future-by-a-hair: a sweep that bound a Node
  // instant taken before this statement would still be eligible to take it.
  await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1", [request.id]);
  assert.equal((await ledger.reconcileExpiredReservations({ limit: 100 })).reconciled, 0,
    "a reservation the database still considers live is never swept");
  await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [request.id]);
  assert.ok((await ledger.reconcileExpiredReservations({ limit: 100 })).reconciled >= 1);
  const row = (await database.query("SELECT status,error_code FROM evimed_usage.model_requests WHERE id=$1", [request.id])).rows[0];
  assert.equal(row.status, "uncertain");
  assert.equal(row.error_code, "reservation_expired");
});
