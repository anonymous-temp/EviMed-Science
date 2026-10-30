import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { quarantineRetiredEvolutionJobs } from "../src/evolutionRetiredJobs.mjs";

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

test('paused evolution SQL eligibility skips experimental queue heads without consuming attempts', { skip: !url && 'A disposable localhost test database is required' }, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  const owner = `pause_${randomUUID()}`;
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Pause admission','development')", [owner]);
    const jobs = new ProductJobs(database);
    const blocked = await jobs.enqueue(owner, 'evolution-evaluate', { action: 'scorer-audit' }, { idempotencyKey: `${owner}:audit`, runAfter: new Date(Date.now() - 60000) });
    const allowed = await jobs.enqueue(owner, 'evolution-evaluate', { action: 'release-replay' }, { idempotencyKey: `${owner}:release` });
    const claimed = await jobs.claim(['evolution-evaluate'], owner, { eligibility: 'evolution-serving', candidateAdmission: async (_client, job) => job.id === allowed.id });
    assert.equal(claimed.id, allowed.id);
    assert.equal((await jobs.get(owner, blocked.id)).attempts, 0);
    assert.equal((await jobs.get(owner, blocked.id)).status, 'queued');
    await database.query("UPDATE evimed_product.jobs SET status='running',attempts=1,lease_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [blocked.id]);
    const next = await jobs.enqueue(owner, 'evolution-evaluate', { action: 'release-replay', releaseId: 'next' }, { idempotencyKey: `${owner}:next` });
    const resumed = await jobs.claim(['evolution-evaluate'], owner, { eligibility: 'evolution-serving', candidateAdmission: async (_client, job) => job.id === next.id });
    assert.equal(resumed.id, next.id);
    assert.equal((await jobs.get(owner, blocked.id)).attempts, 1, 'an expired experimental row is filtered before lease allocation too');
    await assert.rejects(jobs.claim(['evolution-build'], owner, { eligibility: 'anything' }), { code: 'product_job_eligibility_invalid' });
  } finally { await database.query('DELETE FROM evimed_control.users WHERE id=$1', [owner]); await database.close(); }
});

test('the serving cutover cancels only experiments, admitted as a claim is, and never a key serving enqueues again', { skip: !url && 'A disposable localhost test database is required' }, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  const owner = `quarantine_${randomUUID()}`, hold = `quarantine-hold-${randomUUID()}`;
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Quarantine admission','development')", [owner]);
    const jobs = new ProductJobs(database);
    const scout = await jobs.enqueue(owner, 'evolution-scout', { action: 'daily-scan', day: '2026-10-26' }, { idempotencyKey: 'evolution:daily-scout:2026-10-26' });
    const serving = await Promise.all([
      jobs.enqueue(owner, 'evolution-self-check', { waiterId: 'waiter', toolId: 'tool' }, { idempotencyKey: 'evolution:check:waiter:event:tool' }),
      jobs.enqueue(owner, 'evolution-maintain', { month: '2026-10', metricsMonth: '2026-09' }, { idempotencyKey: 'evolution:monthly-v2:2026-10' }),
      jobs.enqueue(owner, 'evolution-maintain', { action: 'retirement-reconcile', toolId: 'tool' }, { idempotencyKey: 'evolution:retirement:tool:2026-10-26' }),
      jobs.enqueue(owner, 'evolution-digest', { day: '2026-10-26' }, { idempotencyKey: 'evolution:daily-digest:2026-10-26' })]);
    assert.equal(await quarantineRetiredEvolutionJobs(database, owner, { admission: async () => false }), 0, 'the worker\'s own admission refuses');
    await database.query("INSERT INTO evimed_product.maintenance_lease(singleton,request_id,requested_at,expires_at) VALUES (true,$1,clock_timestamp(),clock_timestamp()+interval '1 hour')", [hold]);
    try { assert.equal(await quarantineRetiredEvolutionJobs(database, owner, { admission: async () => true }), 0, 'maintenance refuses it as it refuses a claim'); }
    finally { await database.query('DELETE FROM evimed_product.maintenance_lease WHERE request_id=$1', [hold]); }
    assert.equal((await jobs.get(owner, scout.id)).status, 'queued');
    assert.equal(await quarantineRetiredEvolutionJobs(database, owner, { admission: async () => true }), 1);
    assert.equal((await jobs.get(owner, scout.id)).status, 'canceled');
    for (const row of serving) assert.equal((await jobs.get(owner, row.id)).status, 'queued', row.kind);
    // A monthly pass cancelled by an earlier cutover does not hold the metrics-only month: serving queues it under a key of its own.
    await jobs.cancel(owner, serving[1].id);
    assert.equal((await jobs.enqueue(owner, 'evolution-maintain', { month: '2026-10', metricsMonth: '2026-09' }, { idempotencyKey: 'evolution:monthly-v2:2026-10' })).status, 'canceled');
    assert.equal((await jobs.enqueue(owner, 'evolution-maintain', { metricsMonth: '2026-09', metricsOnly: true }, { idempotencyKey: 'evolution:serving-metrics:2026-09' })).status, 'queued');
  } finally {
    await database.query('DELETE FROM evimed_product.maintenance_lease WHERE request_id=$1', [hold]).catch(() => {});
    await database.query('DELETE FROM evimed_control.users WHERE id=$1', [owner]); await database.close();
  }
});
