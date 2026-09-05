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
