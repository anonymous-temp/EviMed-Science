// 「重置记忆」 holds against an extraction the engine had already accepted (2026-10-25, hardening of rectification T1.8).
//
// The reset deletes the account's files and sessions and the overlay's ledger, and the extraction goes on: it can finish after the reset and
// write files the person asked to have gone, into an archive whose session has been deleted (the messages with it, so the time-point guard
// that reads them has nothing to read). What a reset found running is written down first (`native_reset_tombstones`), and each pass of the
// worker asks the engine about it: whenever it finishes, however late, the files it wrote that still hold what its diff says are taken out.
import assert from "node:assert/strict";
import { test } from "node:test";

import { nativeMemoryCounters } from "../src/nativeMemoryMetrics.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();

const LINE = "- Meta 分析一律用随机效应模型。";

/** An engine that writes one preference for every conversation. */
const writes = (later) => ({ session }) => {
  const f = later();
  return session.startsWith("dsh-") ? { adds: [{ uri: `${f.root}/preferences/self/meta.md`, memory_type: "preferences", after: LINE }] } : {};
};

async function scene(t) {
  const held = { f: /** @type {any} */ (null) };
  const f = await fixture(t, { extract: writes(() => held.f) });
  held.f = f;
  return f;
}

/** The engine finishing late: it writes its files again after the reset, into an archive whose messages went with the session. */
function landsLate(f, committed) {
  const uri = `${f.root}/preferences/self/meta.md`;
  f.stub.files.set(uri, LINE);
  f.stub.files.delete(`${committed.archive_uri}/messages.jsonl`);
  return uri;
}

test("an extraction that finishes after the reset is taken out, though the archive's messages went with the session", options, async (t) => {
  const f = await scene(t);
  const committed = await f.commitConversation("a", [{ role: "user", text: "Meta 分析一律用随机效应模型。" }]);
  // The reset finds that commit running: its row is pending, and no worker has read its diff.
  await f.memorySettings.noteReset(f.userId);
  const reset = await f.store.reset(f.userId);
  assert.ok(reset.files >= 0);
  assert.equal(f.stub.files.has(`${f.root}/preferences/self/meta.md`), false, "the reset took the files that were there");
  const tombstones = await f.overlay.openTombstones(f.userId);
  assert.equal(tombstones.length, 1, "what was running is written down");
  assert.equal(tombstones[0].taskId, committed.task_id);
  assert.equal((await f.overlay.commitsOf(f.userId)).length, 0, "and the ledger is gone, as a reset leaves it");

  const uri = landsLate(f, committed);
  assert.equal(f.stub.files.has(uri), true, "the late extraction wrote its file");
  await f.worker.pass();
  assert.equal(f.stub.files.has(uri), false, "taken out again, however late");
  assert.deepEqual((await f.overlay.openTombstones(f.userId)).length, 0);
  assert.equal(nativeMemoryCounters().resetSweeps.swept >= 1, true);
  assert.equal(nativeMemoryCounters().resetSweptFiles.files, 1);
  assert.equal((await f.store.records(f.userId)).length, 0, "and it never became a memory of the account");
  // The orphan archive the scan finds afterwards is settled as the reset's, not ingested as a new memory.
  await f.worker.pass();
  assert.equal((await f.overlay.files(f.userId)).size, 0);
  assert.equal((await f.store.records(f.userId)).length, 0);
});

test("a file the person or a later conversation has written since is theirs: only what still holds the diff's text is taken out", options, async (t) => {
  const f = await scene(t);
  const committed = await f.commitConversation("a", [{ role: "user", text: "Meta 分析一律用随机效应模型。" }]);
  await f.store.reset(f.userId);
  const uri = landsLate(f, committed);
  f.stub.files.set(uri, "- 以后改用固定效应模型。");
  await f.worker.pass();
  assert.equal(f.stub.files.get(uri), "- 以后改用固定效应模型。", "a different text is not the reset's to take");
  assert.equal((await f.overlay.openTombstones(f.userId)).length, 0, "and the tombstone is closed");
});

test("an extraction still running is waited for, and swept when it ends", options, async (t) => {
  const f = await scene(t);
  const committed = await f.commitConversation("a", [{ role: "user", text: "Meta 分析一律用随机效应模型。" }]);
  await f.store.reset(f.userId);
  const task = f.stub.tasks.get(committed.task_id);
  task.public.status = "running";
  const uri = landsLate(f, committed);
  f.stub.files.delete(`${committed.archive_uri}/memory_diff.json`);
  await f.worker.pass();
  assert.equal((await f.overlay.openTombstones(f.userId)).length, 1, "still open: the engine says it is running");
  assert.equal(nativeMemoryCounters().resetSweeps.waiting >= 1, true);
  assert.equal(f.stub.files.has(uri), true, "nothing is touched before it has ended");
  // It ends, and its diff lands where its archive was.
  task.public.status = "completed";
  f.stub.files.set(`${committed.archive_uri}/memory_diff.json`, JSON.stringify({ operations: { adds: [{ uri, memory_type: "preferences", after: LINE }], updates: [], deletes: [] } }));
  task.public.result = { ...task.public.result, memory_diff_uri: `${committed.archive_uri}/memory_diff.json` };
  await f.worker.pass();
  assert.equal(f.stub.files.has(uri), false);
  assert.equal((await f.overlay.openTombstones(f.userId)).length, 0);
});

test("an archive no ledger row named, still unfinished at the reset, is written down by its place in the engine's tree", options, async (t) => {
  const f = await scene(t);
  // An idle commit the scan had not entered: an archive with no diff and no failure marker, and a task nobody here knows.
  const archive = `viking://user/${f.engineUser}/sessions/dsh-session_idle/history/archive_001`;
  f.stub.files.set(`${archive}/messages.jsonl`, JSON.stringify({ role: "user", parts: [{ type: "text", text: "x" }] }));
  f.stub.sessions.set(`${f.engineUser}/dsh-session_idle`, { id: "dsh-session_idle", user: f.engineUser, archives: 1, commitCount: 1, messages: [] });
  await f.store.reset(f.userId);
  const [tombstone] = await f.overlay.openTombstones(f.userId);
  assert.equal(tombstone.archiveUri, archive);
  assert.equal(tombstone.taskId, null);
  const uri = `${f.root}/preferences/self/meta.md`;
  f.stub.files.set(uri, LINE);
  f.stub.files.set(`${archive}/memory_diff.json`, JSON.stringify({ operations: { adds: [{ uri, memory_type: "preferences", after: LINE }] } }));
  await f.worker.pass();
  assert.equal(f.stub.files.has(uri), false);
  assert.equal((await f.overlay.openTombstones(f.userId)).length, 0);
});

test("a task the engine no longer holds is closed as unknown after a day, and never before", options, async (t) => {
  const f = await scene(t);
  const committed = await f.commitConversation("a", [{ role: "user", text: "Meta 分析一律用随机效应模型。" }]);
  await f.store.reset(f.userId);
  f.stub.tasks.delete(committed.task_id);
  f.stub.files.delete(`${committed.archive_uri}/memory_diff.json`);
  await f.worker.pass();
  assert.equal((await f.overlay.openTombstones(f.userId)).length, 1, "within the day it is looked for again");
  // The clock is the store's and the worker's: a day after the reset.
  f.advance(25 * 3_600_000);
  await f.worker.pass();
  assert.equal((await f.overlay.openTombstones(f.userId)).length, 0);
  assert.equal(nativeMemoryCounters().resetSweeps.unknown, 1);
  assert.equal((await f.overlay.tombstone(f.userId, committed.archive_uri)).state, "unknown");
});

test("a reset with nothing running writes nothing down, and a settled commit is not a tombstone", options, async (t) => {
  const f = await scene(t);
  await f.commitConversation("a", [{ role: "user", text: "Meta 分析一律用随机效应模型。" }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.commitsOf(f.userId))[0].state, "completed");
  await f.store.reset(f.userId);
  assert.equal((await f.overlay.openTombstones(f.userId)).length, 0);
});
