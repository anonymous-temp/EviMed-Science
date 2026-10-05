import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductJobs } from "../src/productJobs.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
test("candidate admission refuses a new runtime without spending a lease attempt, then permits the exact resumed job", { skip: !url && "A disposable localhost test database is required" }, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  const owner = `admission_${randomUUID()}`;
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Job admission','development')", [owner]);
    const jobs = new ProductJobs(database);
    const queued = await jobs.enqueue(owner, "evolution-build", { dossierId: "one" }, { idempotencyKey: owner });
    const filter = async client => (await client.query("SELECT count(*) AS n FROM evimed_product.jobs WHERE id=$1", [queued.id])).rows[0].n > 0;
    let observed;
    const blocked = await jobs.claim(["evolution-build"], owner, { admission: filter, candidateAdmission: async (_client, candidate) => { observed = candidate; return false; } });
    assert.equal(blocked, null);
    assert.equal(observed.id, queued.id);
    const unchanged = await jobs.get(owner, queued.id);
    assert.equal(unchanged.status, "queued"); assert.equal(unchanged.attempts, 0); assert.equal(unchanged.leaseToken, null);
    const accepted = await jobs.claim(["evolution-build"], owner, { admission: filter, candidateAdmission: async (_client, candidate) => candidate.id === queued.id });
    assert.equal(accepted.id, queued.id); assert.equal(accepted.attempts, 1); assert.equal(accepted.status, "running");
  } finally { await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]); await database.close(); }
});
