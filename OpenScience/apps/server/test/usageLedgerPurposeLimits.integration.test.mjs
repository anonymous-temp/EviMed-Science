// A cap that belongs to one kind of work counts exactly that work, uncapped or not
// (review of 「循证进化」, 2026-10-05, S7/F9). `assertWithinLimits` excluded the account's
// uncapped purposes first and then filtered to the named ones, so for `evolution` — itself
// uncapped — the set was empty, the sum was 0 and the pre-dispatch check could never refuse.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const userId = `usage_purpose_limits_${randomUUID().replaceAll("-", "")}`;
const projectId = "usage-purpose-limits";
/** @type {any} */
let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 3_000 });
  await database.migrate();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Limits test','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Limits',1048576)", [userId, projectId]);
});

after(async () => {
  if (!databaseUrl) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]).catch(() => {});
  await database.close?.();
});

test("a named purpose is counted even when the account's caps leave it out, so its own daily budget can refuse", options, async () => {
  const ledger = new UsageLedger(database);
  const spend = (/** @type {string} */ purpose, /** @type {number} */ actualCost) => ledger.recordSettled({
    id: `usage_${randomUUID()}`, userId, projectId, runId: `run_${randomUUID()}`, purpose, model: "test-model",
    priceVersion: "test-price-v1", currency: "CNY", requestFingerprint: "a".repeat(64),
    usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 }, actualCost, priced: true });
  await spend("evolution", 60);
  await spend("kernel", 1);

  // Evolution's own allowance is 50 a day and 60 are spent: the dispatch is refused, by the window.
  await assert.rejects(ledger.assertWithinLimits(userId, { dailyLimit: 50, weeklyLimit: 0, purposes: ["evolution"] }),
    (error) => error.status === 402 && error.code === "usage_budget_exceeded" && error.details?.window === "day");
  // A purpose with room is still allowed, and the same spend does not count against another purpose's allowance.
  assert.deepEqual(await ledger.assertWithinLimits(userId, { dailyLimit: 100, weeklyLimit: 0, purposes: ["evolution"] }), { allowed: true });
  assert.deepEqual(await ledger.assertWithinLimits(userId, { dailyLimit: 50, weeklyLimit: 0, purposes: ["learning"] }), { allowed: true });
  // The account's own cap (no purposes named) never counted the platform's uncapped work and still does not.
  assert.deepEqual(await ledger.assertWithinLimits(userId, { dailyLimit: 50, weeklyLimit: 0 }), { allowed: true });
  await assert.rejects(ledger.assertWithinLimits(userId, { dailyLimit: 0.5, weeklyLimit: 0 }), { code: "usage_budget_exceeded" });
});
