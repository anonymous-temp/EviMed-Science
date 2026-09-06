import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { MemoryIndexing } from "../src/memoryIndexing.mjs";
import { MemoryIndexWorker } from "../src/memoryIndexWorker.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 15000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

async function fixture(t) {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  const users = [0, 1].map(() => `memory_recovery_${randomUUID()}`);
  const documents = new ProductDocuments(database);
  const jobs = new ProductJobs(database);
  const records = new Map();
  const mutations = [];
  let unavailable = false;
  // This controllable engine models scoped record loss. It does not certify
  // physical MemOS/Qdrant restoration or semantic ranking.
  const key = (userId, scope) => JSON.stringify([userId, scope.accountCreatedAt, scope.capsuleId]);
  const engine = {
    async export(userId, scope) {
      if (unavailable) throw Object.assign(new Error("Engine unavailable"), { code: "mem_os_unavailable" });
      return { records: structuredClone(records.get(key(userId, scope)) ?? []), nextPage: null };
    },
    async deleteScope(userId, scope) { mutations.push(["delete", userId]); records.set(key(userId, scope), []); },
    async add(userId, entries, scope) {
      mutations.push(["add", userId]);
      const added = entries.map(entry => ({ id: randomUUID(), entryId: entry.entryId, revision: entry.revision }));
      records.set(key(userId, scope), [...(records.get(key(userId, scope)) ?? []), ...added]);
      return { records: added.map(entry => ({ ...entry, memoryIds: [entry.id] })) };
    },
  };
  const indexing = new MemoryIndexing({ database, jobs, engine });
  const worker = new MemoryIndexWorker({ jobs, indexing });
  t.after(async () => {
    await worker.close();
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [users]);
    await database.close();
  });
  const scopes = [];
  for (const userId of users) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Recovery fixture','development')", [userId]);
    await documents.put(userId, "capsule", "capsule", { title: "Recovery fixture" }, { expectedRevision: 0 });
    await documents.put(userId, "fact", "fact", {
      capsuleId: "capsule", content: `Canonical ${userId}`, status: "approved", provenance: [{ type: "source", id: "source" }],
    }, { expectedRevision: 0 });
    const snapshot = await indexing.snapshot(userId, "capsule");
    const scope = { accountCreatedAt: snapshot.generation, capsuleId: "capsule" };
    scopes.push(scope);
  }
  // Drain the real document outbox before introducing engine failure.
  for (let remaining = 20; remaining > 0; remaining--) {
    const result = await worker.tick();
    if (!result) break;
    assert.equal(result.status, "succeeded");
  }
  for (const [index, userId] of users.entries()) {
    assert.deepEqual(records.get(key(userId, scopes[index])).map(row => [row.entryId, row.revision]), [["fact", 1]]);
  }
  assert.equal((await indexing.reconcile()).enqueued, 0);
  return { database, users, jobs, indexing, worker, records, scopes, key, mutations,
    setUnavailable(value) { unavailable = value; } };
}

test("reconciliation repairs missing and stale engine records despite an unchanged PostgreSQL fingerprint", options, async t => {
  const f = await fixture(t);
  const [owner, other] = f.users;
  const ownerKey = f.key(owner, f.scopes[0]);
  const otherKey = f.key(other, f.scopes[1]);
  const untouched = structuredClone(f.records.get(otherKey));
  const fingerprint = (await f.indexing.snapshot(owner, "capsule")).fingerprint;
  for (const damaged of [[], [{ id: "stale", entryId: "fact", revision: 0 }], [{ id: "foreign", entryId: "unknown", revision: 1 }]]) {
    f.records.set(ownerKey, damaged);
    assert.equal((await f.indexing.reconcile()).enqueued, 1);
    const result = await f.worker.tick();
    assert.equal(result?.status, "succeeded");
    assert.equal(result.result.status, "published", "a matching old SQL fingerprint cannot suppress engine recovery");
    const restored = await f.indexing.readback(await f.indexing.snapshot(owner, "capsule"));
    assert.deepEqual(restored.map(row => [row.entryId, row.revision]), [["fact", 1]]);
    assert.equal((await f.indexing.snapshot(owner, "capsule")).fingerprint, fingerprint);
    assert.deepEqual(f.records.get(otherKey), untouched);
    assert.equal((await f.indexing.reconcile()).enqueued, 0, "successful repair must stop recurring reconciliation");
  }
});

test("an unavailable engine retries without deleting its records or reporting already current", options, async t => {
  const f = await fixture(t);
  const owner = f.users[0];
  const job = await f.jobs.enqueue(owner, "memory-index", f.scopes[0], { idempotencyKey: "verify-existing", maxAttempts: 3 });
  const previous = structuredClone([...f.records]);
  const mutations = f.mutations.length;
  f.setUnavailable(true);
  assert.equal(await f.worker.tick(), null);
  const queued = await f.jobs.get(owner, job.id);
  assert.equal(queued.status, "queued");
  assert.equal(queued.error.code, "mem_os_unavailable");
  assert.equal(f.mutations.length, mutations);
  assert.deepEqual([...f.records], previous);
  f.setUnavailable(false);
  await f.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND id=$2", [owner, job.id]);
  assert.equal((await f.worker.tick()).result.status, "already_current");
  assert.equal(f.mutations.length, mutations, "verified current records must not be rewritten");
});

test("lease expiry during final row locking rolls back index publication before a new worker recovers", options, async t => {
  const f = await fixture(t);
  const owner = f.users[0];
  const previous = (await f.database.query("SELECT * FROM evimed_product.memory_index_state WHERE user_id=$1", [owner])).rows;
  f.records.set(f.key(owner, f.scopes[0]), []);
  const queued = await f.jobs.enqueue(owner, "memory-index", f.scopes[0], { idempotencyKey: "expired-publication" });
  const claimed = await f.jobs.claim(["memory-index"], "short-lease-recovery", { leaseMs: 1000 });
  assert.equal(claimed.id, queued.id);
  const blocker = await f.database.pool.connect();
  let rebuilding;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='capsule' FOR UPDATE", [owner]);
    rebuilding = f.indexing.rebuild(claimed).then(value => ({ value }), error => ({ error }));
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline) {
      const blocked = await f.database.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE 'SELECT id,revision,payload,deleted_at%FOR SHARE'`);
      if (blocked.rowCount > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "the real final canonical row lock must be reached before expiring the lease");
    await blocker.query("SELECT pg_sleep(1.1)");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const result = await rebuilding;
  assert.equal(result.error?.code, "product_job_lease_lost");
  assert.deepEqual((await f.database.query("SELECT * FROM evimed_product.memory_index_state WHERE user_id=$1", [owner])).rows,
    previous, "a rejected completion must roll back its index-state side effect");
  assert.equal((await f.jobs.get(owner, queued.id)).status, "running");
  assert.equal((await f.worker.tick()).status, "succeeded");
  assert.equal((await f.indexing.readback(await f.indexing.snapshot(owner, "capsule"))).length, 1);
});
