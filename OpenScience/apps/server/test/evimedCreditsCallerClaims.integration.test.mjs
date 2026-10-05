// What research billing charges is decided by what the run is — its purpose —
// and not by anything its caller said about it (review of 「循证进化」,
// 2026-10-05, B1/F2). `POST /api/agent-runs/dispatch` takes `automated` from
// the body or a header, and `dispatchId` from the body; both used to make a
// run "not the researcher's" and so settle at zero.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { PostgresStore } from "../src/store.mjs";
import { EvimedCreditsService } from "../src/evimedCreditsService.mjs";
import { migrateEvimedCredits } from "../src/evimedCreditsPersistence.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const userId = `credits_claims_${randomUUID().replaceAll("-", "")}`;
const projectId = "credits-claims";
/** @type {any} */
let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 3_000 });
  await database.migrate();
  await migrateEvimedCredits(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type,evimed_user_id) VALUES($1,'Claims test','evimed','4712')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Claims',1048576)", [userId, projectId]);
});

after(async () => {
  if (!databaseUrl) return;
  await database.query("DELETE FROM evimed_credits.settlements WHERE user_id=$1", [userId]).catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]).catch(() => {});
  await database.close?.();
});

test("a caller's own flags never waive the charge; the platform's own dispatchers still do", options, async () => {
  const usage = new UsageLedger(database);
  const client = { calls: /** @type {any[]} */ ([]), configured: true, status: () => ({ configured: true }),
    async deduct(/** @type {any} */ request) { this.calls.push(request); return { receiptId: "rcpt", balance: 500 }; },
    async balance() { return { balance: 500, frozen: 0 }; } };
  const evimedUserIdOf = (/** @type {string} */ id) => PostgresStore.prototype.evimedUserIdOf.call({ database }, id);
  const service = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 1, researchBillingEnabled: true },
    database, client, usageLedger: usage, evimedUserIdOf });
  await service.ready();
  await database.query("UPDATE evimed_credits.research_policy SET activated_at=activated_at - interval '1 day'");
  const accountCreatedAt = (await database.query("SELECT created_at::text AS epoch FROM evimed_control.users WHERE id=$1", [userId])).rows[0].epoch;

  /** @param {Record<string, any>} claims */
  async function settle(claims) {
    const runId = `run_${randomUUID()}`;
    await usage.recordSettled({ id: `usage_${randomUUID()}`, userId, projectId, runId, purpose: "kernel", model: "test-model",
      priceVersion: "test-price-v1", currency: "CNY", requestFingerprint: "a".repeat(64),
      usage: { cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 }, actualCost: 4, priced: true });
    return service.settleRun({ userId, projectId, runId, status: "succeeded", subject: "Claims", startedAt: new Date().toISOString(),
      accountCreatedAt, effectiveAgentId: "open-domain-answer", effectiveRouteReason: "unrouted:open-domain", ...claims });
  }

  assert.equal((await settle({})).credits, 4, "an ordinary run is charged");
  assert.equal((await settle({ automated: true })).credits, 4, "`automated` is the caller's word, not a waiver");
  for (const dispatchId of ["evolution_free_1", "methodeval_0a1b2c3d4e5f"]) {
    assert.equal((await settle({ dispatchId, automated: true })).credits, 4, `${dispatchId} is only an identity`);
  }
  // What the platform dispatches on its own account is still waived.
  assert.equal((await settle({ effectiveRouteReason: "platform-evolution", automated: true })).credits, 0);
  assert.equal((await settle({ effectiveRouteReason: "platform-learning" })).credits, 0);
  assert.equal((await settle({ effectiveAgentId: "method-distillation", effectiveRouteReason: "method-distillation" })).credits, 0);
});
