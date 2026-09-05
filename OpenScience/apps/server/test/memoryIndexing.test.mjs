import assert from "node:assert/strict";
import test from "node:test";
import { MemoryIndexing } from "../src/memoryIndexing.mjs";
import { MemoryIndexWorker } from "../src/memoryIndexWorker.mjs";

const generation = "2026-09-05 00:00:00+00";

test("semantic recall preserves engine rank but reloads approved current facts from PostgreSQL", async () => {
  const engine = {
    async search(_userId, _query, options) {
      return options.capsuleId === "capsule-a"
        ? [
            { entryId: "stale", revision: 1, rank: 0, content: "invented engine prose" },
            { entryId: "current", revision: 3, rank: 1, content: "invented engine prose" },
          ]
        : [{ entryId: "wrong-capsule", revision: 2, rank: 0, content: "invented engine prose" }];
    },
  };
  const database = {
    async query(sql) {
      if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
      if (sql.includes("kind='preferences'")) return { rows: [{ id: "active-capsules:account", payload: { items: [{ capsuleId: "capsule-a", mode: "own" }] } }] };
      return { rows: [
        { id: "stale", revision: 2, payload: { capsuleId: "capsule-a", status: "approved", content: "new revision" } },
        { id: "current", revision: 3, payload: { capsuleId: "capsule-a", status: "approved", content: "canonical fact" } },
        { id: "wrong-capsule", revision: 2, payload: { capsuleId: "capsule-b", status: "approved", content: "deactivated fact" } },
      ] };
    },
  };
  const indexing = new MemoryIndexing({ database, engine, jobs: {} });
  const results = await indexing.recall("owner", generation,
    [{ capsuleId: "capsule-a", mode: "own" }, { capsuleId: "capsule-b", mode: "read" }], "query", 10);
  assert.deepEqual(results.map((item) => item.row.payload.content), ["canonical fact"]);
  assert.equal(results[0].selection.capsuleId, "capsule-a");
  assert.ok(results.every((item) => item.row.id !== "wrong-capsule"));
});

test("published readback requires every current revision and rejects opaque engine additions", async () => {
  const snapshot = { userId: "owner", generation, capsuleId: "capsule-a", entries: [{ id: "fact", revision: 4 }] };
  const engine = { async export() { return { records: [{ id: "m1", entryId: "fact", revision: 3 }], nextPage: null }; } };
  const indexing = new MemoryIndexing({ database: {}, engine, jobs: {} });
  await assert.rejects(indexing.readback(snapshot), { code: "memory_index_readback_mismatch" });
  engine.export = async () => ({ records: [], nextPage: null });
  await assert.rejects(indexing.readback(snapshot), { code: "memory_index_readback_incomplete" });
  engine.export = async () => ({ records: [{ id: "m1", entryId: "fact", revision: 4 }], nextPage: null });
  assert.equal((await indexing.readback(snapshot)).length, 1);
});

test("final snapshots lock mutable capsule rows without reversing the account deletion lock order", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
      if (sql.includes("kind='capsule'")) {
        return { rows: [{ id: "capsule-a", revision: 2, payload: {}, deleted_at: null }] };
      }
      return { rows: [] };
    },
  };
  const indexing = new MemoryIndexing({ database: {}, engine: {}, jobs: {} });
  await indexing.snapshot("owner", "capsule-a", { client, lock: true });
  assert.doesNotMatch(queries[0], /FOR SHARE/);
  assert.match(queries[1], /FOR SHARE/);
  assert.match(queries[2], /FOR SHARE/);
});

test("account deletion locks and purges every canonical or published capsule namespace", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push([sql, values]);
      if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
      if (sql.includes("UNION SELECT")) return { rows: [{ capsule_id: "capsule-a" }, { capsule_id: "capsule-b" }] };
      return { rows: [] };
    },
  };
  const deleted = [];
  const indexing = new MemoryIndexing({
    database: {},
    engine: { async deleteScope(userId, options) { deleted.push([userId, options]); } },
    jobs: {},
  });
  assert.deepEqual(await indexing.prepareAccountDeletion("owner", generation, client), { scopes: 2, verified: true });
  assert.deepEqual(deleted, [
    ["owner", { accountCreatedAt: generation, capsuleId: "capsule-a" }],
    ["owner", { accountCreatedAt: generation, capsuleId: "capsule-b" }],
  ]);
  const locks = calls.filter(([sql]) => sql.includes("pg_advisory_xact_lock"));
  assert.deepEqual(locks.map(([, values]) => values[0]), ["memory-index:owner:capsule-a", "memory-index:owner:capsule-b"]);
});

test("account deletion acquires the shared memory-index lock before any user-row work", async () => {
  const calls = [];
  const indexing = new MemoryIndexing({ database: {}, engine: {}, jobs: {} });
  await indexing.lockAccountDeletion("owner", { async query(sql, values) { calls.push([sql, values]); } });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0][1], ["memory-index-account:owner"]);
});

test("rebuild acquires account before capsule and releases both on an early superseded job", async () => {
  const queries = [];
  let released = 0;
  const connection = {
    async query(sql, values) { queries.push([sql, values]); },
    release() { released++; },
  };
  const indexing = new MemoryIndexing({
    database: { pool: { async connect() { return connection; } } },
    engine: {},
    jobs: { async finish() { return { status: "superseded_account_generation" }; } },
  });
  indexing.snapshot = async () => null;
  await indexing.rebuild({ userId: "owner", id: "job", leaseToken: "lease", payload: { capsuleId: "capsule-a", accountCreatedAt: generation } });
  assert.deepEqual(queries.map(([, values]) => values[0]), [
    "memory-index-account:owner",
    "memory-index:owner:capsule-a",
    "memory-index:owner:capsule-a",
    "memory-index-account:owner",
  ]);
  assert.match(queries[0][0], /pg_advisory_lock/);
  assert.match(queries[1][0], /pg_advisory_lock/);
  assert.match(queries[2][0], /pg_advisory_unlock/);
  assert.match(queries[3][0], /pg_advisory_unlock/);
  assert.equal(released, 1);
});

test("account deletion refuses a stale generation before taking capsule locks or mutating the engine", async () => {
  let deleted = false;
  const indexing = new MemoryIndexing({ database: {}, engine: { async deleteScope() { deleted = true; } }, jobs: {} });
  const client = { async query() { return { rows: [{ generation: "another-generation" }] }; } };
  await assert.rejects(indexing.prepareAccountDeletion("owner", generation, client), { code: "memory_account_changed" });
  assert.equal(deleted, false);
});

test("worker uses ProductJobs leases and retries a bounded failed index job", async () => {
  const calls = [];
  const job = { id: "job", userId: "owner", leaseToken: "lease", attempts: 1, payload: {} };
  const jobs = {
    async claim() { calls.push("claim"); return job; },
    async renew() { return true; },
    async fail(...args) { calls.push(["fail", ...args]); },
  };
  const indexing = { async rebuild() { const error = new Error("private detail"); error.code = "mem_os_unavailable"; throw error; }, async reconcile() {} };
  const worker = new MemoryIndexWorker({ jobs, indexing, pollMs: 60_000, leaseMs: 3_000, reconcileMs: 60_000 });
  await worker.tick();
  assert.equal(calls[0], "claim");
  assert.equal(calls[1][0], "fail");
  assert.deepEqual(calls[1][5], { retry: true, delayMs: 2000 });
  assert.equal(calls[1][4].message, "Memory indexing failed.");
});

test("worker refuses invalid timer configuration before it can create a busy loop", () => {
  assert.throws(() => new MemoryIndexWorker({ jobs: {}, indexing: {}, pollMs: 0 }), /Invalid memory index poll interval/);
  assert.throws(() => new MemoryIndexWorker({ jobs: {}, indexing: {}, leaseMs: 500 }), /Invalid memory index lease interval/);
});

test("a claim failure is contained and recorded instead of becoming an unhandled rejection", async () => {
  const jobs = { async claim() { const error = new Error("database unavailable"); error.code = "database_unavailable"; throw error; } };
  const worker = new MemoryIndexWorker({ jobs, indexing: {}, pollMs: 60_000, reconcileMs: 60_000 });
  assert.equal(await worker.tick(), null);
  assert.equal(worker.status().lastError, "database_unavailable");
});
