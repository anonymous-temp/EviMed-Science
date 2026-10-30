import assert from "node:assert/strict";
import test from "node:test";
import { NativeMemoryStore } from "../src/nativeMemoryStore.mjs";

// OpenViking's user deletion waits for the user's tasks and fails when one outlives the wait; an extraction that met the
// deletion's fence never finished (v0.5.1.1), so every retry failed too (2026-10-27). An account's erase therefore asks the engine
// to delete only once the extractions its ledger names have ended, and is refused as still in progress past its wait.
function store({ statuses, settleExtractionsMs = 2_000 }) {
  const calls = { erase: 0, task: 0, purged: 0 };
  const sessions = {
    configured: true,
    engineUser: (userId) => `u-${userId}`,
    userRoot: (userId) => `viking://user/u-${userId}`,
    task: async () => { calls.task += 1; return { status: statuses[Math.min(calls.task - 1, statuses.length - 1)] }; },
    eraseUser: async () => { calls.erase += 1; return { deleted: true, pending: false }; },
  };
  const overlay = {
    configured: true,
    openCommits: async ({ userId }) => [{ state: "pending", taskId: "task-1234-5678", userId }, { state: "failed", taskId: "task-old-0000" }],
    purgeUser: async () => { calls.purged += 1; },
    forgetAccount: async () => {},
  };
  return { calls, native: new NativeMemoryStore({ sessions, overlay, settleExtractionsMs }) };
}

test("an account's engine deletion is asked only after its running extraction has ended", async () => {
  const { calls, native } = store({ statuses: ["running", "running", "completed"] });
  assert.deepEqual(await native.eraseAccount("someone"), { deleted: true, pending: false });
  assert.equal(calls.task, 3, "the pending commit's task is read until it ends; a failed commit's is not waited for");
  assert.equal(calls.erase, 1);
  assert.equal(calls.purged, 1);
});

test("an extraction that outlives the wait refuses the deletion as in progress and asks the engine nothing", async () => {
  const { calls, native } = store({ statuses: ["running"], settleExtractionsMs: 0 });
  await assert.rejects(native.eraseAccount("someone"), { status: 503, code: "memory_engine_unavailable" });
  assert.equal(calls.erase, 0, "no engine deletion is started against a running extraction");
  assert.equal(calls.purged, 0);
});

test("a task the engine no longer knows is no reason to wait", async () => {
  const { calls, native } = store({ statuses: [undefined] });
  await native.eraseAccount("someone");
  assert.equal(calls.erase, 1);
});
