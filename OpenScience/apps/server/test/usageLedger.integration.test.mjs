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
let database;
let ledger;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 8, databaseConnectionTimeoutMs: 2_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Usage owner','development'),($2,'Other owner','development')", [owner, other]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Usage',1048576),($2,'default','Other',1048576)", [owner, other]);
  ledger = new UsageLedger(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other]]);
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
  const settled = await ledger.settleModel(reserved.id, {
    usage, actualCost: 0.0004, priced: true, providerRequestId: "provider-fixture-one",
  });
  assert.equal(settled.status, "settled");
  assert.equal(settled.priceVersion, "evimed-reference-2026-09-05");
  assert.deepEqual(settled.usage, usage);
  assert.equal((await ledger.settleModel(reserved.id, {
    usage, actualCost: 0.0004, priced: true, providerRequestId: "provider-fixture-one",
  })).revision, settled.revision);
  await assert.rejects(ledger.settleModel(reserved.id, {
    usage: { ...usage, completionTokens: 38 }, actualCost: 0.0004, priced: true,
    providerRequestId: "provider-fixture-one",
  }), { code: "usage_settlement_conflict" });
});

test("released, uncertain and settled calls are distinguished in durable summaries", options, async () => {
  const released = await ledger.reserveModel(reservation());
  await ledger.release(released.id, "provider_refused");
  const uncertain = await ledger.reserveModel(reservation());
  await ledger.markUncertain(uncertain.id, "response_usage_missing", { providerRequestId: "provider-unknown" });
  const summary = await ledger.summary(owner, { since: new Date("2020-01-01T00:00:00Z") });
  assert.ok(summary.settledCalls >= 1);
  assert.ok(summary.releasedCalls >= 1);
  assert.ok(summary.uncertainCalls >= 1);
  assert.ok(summary.reservedCost >= 0.75);
  assert.equal(summary.currency, "CNY");
  assert.equal((await ledger.summary(other, { since: new Date("2020-01-01T00:00:00Z") })).totalCalls, 0);
});

test("a project foreign to the account cannot receive a reservation", options, async () => {
  await assert.rejects(ledger.reserveModel(reservation(owner, { projectId: "missing" })), { code: "23503" });
  assert.equal((await ledger.summary(owner, { since: new Date("2020-01-01T00:00:00Z") })).reservedCalls, 0);
});
