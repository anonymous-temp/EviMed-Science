// 重读旧记忆 on the native engine (2026-10-23, rectification T1.10 / I6): the engine's own memory consolidation, asked for once an interval and
// only after the account's files changed, read back as revisions the page can undo, and held to the checks every write of the engine is.
import assert from "node:assert/strict";
import test from "node:test";

import { MIN_FILES, TASK_TIMEOUT_MS, filesFingerprint } from "../src/nativeMemoryConsolidation.mjs";
import { nativeMemoryCounters } from "../src/nativeMemoryMetrics.mjs";
import { lineFingerprint } from "../src/nativeMemoryOverlay.mjs";
import { nativeFileId } from "../src/nativeMemoryStore.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration({ config: { nativeMemoryConsolidationEnabled: true, nativeMemoryConsolidationIntervalDays: 7 } });
const DAY = 24 * 3_600_000;

/** Several memory files, in the engine and as the overlay's last reading of them (what ingestion leaves). */
async function account(t, { consolidate = () => ({}), files = 5, config = {} } = {}) {
  const f = await fixture(t, { consolidate, config });
  /** @type {string[]} */ const uris = [];
  for (let index = 0; index < files; index += 1) {
    const text = `Fact number ${index} about the person's work.`;
    const uri = f.seed(`entities/person/p${index}.md`, text, { type: "entities" });
    await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: "entities", body: text });
    uris.push(uri);
  }
  return { ...f, uris, tick: () => f.consolidation.tick(f.userId) };
}
const compile = (stub) => stub.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/compile");

test("it is off until switched on, and asks the engine nothing then", options, async (t) => {
  const f = await account(t, { config: { nativeMemoryConsolidationEnabled: false } });
  assert.equal(f.consolidation.applicable, false);
  assert.equal(await f.tick(), "off");
  assert.equal(compile(f.stub).length, 0);
  assert.equal(f.stub.requests.filter((request) => request.path === "/api/v1/fs/tree").length, 0, "not even the files are listed");
});

test("a due consolidation of changed files is submitted as the engine documents it, polled without blocking, and read back as revisions", options, async (t) => {
  const f = await account(t, {
    consolidate: ({ user }) => ({
      updates: [{ uri: `viking://user/${user}/memories/entities/person/p0.md`, text: "Fact number 0 about the person's work. Fact number 1 about the person's work." }],
      deletes: [`viking://user/${user}/memories/entities/person/p1.md`],
      adds: [{ uri: `viking://user/${user}/memories/entities/person/split.md`, text: "A split-off fact." }],
    }),
  });
  assert.equal(await f.tick(), "submitted");
  const [asked] = compile(f.stub);
  assert.deepEqual(Object.keys(asked.body).sort(), ["instruction", "skill", "to"], "memory mode takes no --from");
  assert.equal(asked.body.skill, "memory");
  assert.equal(asked.body.to, f.root);
  assert.match(asked.body.instruction, /without losing any fact/);
  assert.match(asked.headers["idempotency-key"], /^nm-consolidate-[a-f0-9]{24}-[a-f0-9]{24}-\d{10}$/);
  assert.equal(asked.headers["x-openviking-role"], undefined);
  const state = await f.overlay.consolidationState(f.userId);
  assert.ok(state.task, "the task is on the account's row");
  assert.equal(state.consolidatedAt, null);

  // The pass that submitted it returned; the next ones ask how it is doing and change nothing until it is done.
  assert.equal(await f.tick(), "submitted", "still running");
  assert.equal((await f.overlay.revisionsOf(f.userId, f.uris[0])).length, 0);
  assert.equal(await f.tick(), "completed");
  assert.equal(compile(f.stub).length, 1, "one task");

  const [updated] = await f.overlay.revisionsOf(f.userId, f.uris[0]);
  assert.deepEqual([updated.change, updated.actor, updated.reason], ["updated", "engine", "consolidation"]);
  assert.equal(updated.before, "Fact number 0 about the person's work.");
  assert.match(updated.after, /Fact number 1/);
  const [deleted] = await f.overlay.revisionsOf(f.userId, f.uris[1]);
  assert.deepEqual([deleted.change, deleted.actor, deleted.reason, deleted.before], ["deleted", "engine", "consolidation", "Fact number 1 about the person's work."]);
  const [added] = await f.overlay.revisionsOf(f.userId, `${f.root}/entities/person/split.md`);
  assert.deepEqual([added.change, added.before, added.after], ["added", null, "A split-off fact."]);
  assert.equal((await f.overlay.file(f.userId, f.uris[0])).body, updated.after, "the overlay holds what the file says now");
  assert.equal(await f.overlay.file(f.userId, f.uris[1]), null);
  assert.deepEqual(nativeMemoryCounters().consolidatedFiles, { added: 1, updated: 1, deleted: 1 });
  assert.equal(nativeMemoryCounters().consolidations.submitted, 1);
  assert.equal(nativeMemoryCounters().consolidations.completed, 1);
  const after = await f.overlay.consolidationState(f.userId);
  assert.equal(after.task, null);
  assert.ok(after.consolidatedAt && after.fingerprint);
  // The tidying is not something the engine just learned.
  assert.deepEqual(await f.store.changes(f.userId, { since: "2026-01-01T00:00:00.000Z" }), []);

  // Every change is the page's to undo, in one step.
  const restored = await f.store.undo(f.userId, nativeFileId(f.uris[0]), {});
  assert.equal(restored.undone, "restored");
  assert.equal(await f.sessions.read(f.userId, f.uris[0]), "Fact number 0 about the person's work.");
  const back = await f.store.undo(f.userId, nativeFileId(f.uris[1]), {});
  assert.equal(back.undone, "restored");
  assert.equal(await f.sessions.read(f.userId, f.uris[1]), "Fact number 1 about the person's work.");
});

test("once an interval, and only after the files changed since the last one left them", options, async (t) => {
  const f = await account(t, { consolidate: ({ user }) => ({ updates: [{ uri: `viking://user/${user}/memories/entities/person/p0.md`, text: "Fact number 0, tightened." }] }) });
  await f.tick(); await f.tick(); assert.equal(await f.tick(), "completed");
  assert.equal(await f.tick(), "not_due", "inside the interval");
  f.advanceConsolidation(8 * DAY);
  assert.equal(await f.tick(), "unchanged", "due, but the files are what the last consolidation left");
  assert.equal(compile(f.stub).length, 1);
  assert.equal(await f.tick(), "not_due", "and not looked at again within the hour");
  // A file changes: the next due look submits again.
  f.advanceConsolidation(8 * DAY);
  f.seed("entities/person/new.md", "A new fact.", { type: "entities" });
  assert.equal(await f.tick(), "submitted");
  assert.equal(compile(f.stub).length, 2);
  assert.equal(filesFingerprint([{ uri: "a", modTime: "t", size: 1 }]), filesFingerprint([{ uri: "a", modTime: "t", size: 1 }]));
  assert.notEqual(filesFingerprint([{ uri: "a", modTime: "t", size: 1 }]), filesFingerprint([{ uri: "a", modTime: "t", size: 2 }]));
});

test("it holds back while learning is paused, an extraction is working or just finished, another worker has the account, or there is little to tidy", options, async (t) => {
  const f = await account(t, { files: MIN_FILES });
  // Few files: counted, and the files are not looked at again within the hour.
  const few = await account(t, { files: MIN_FILES - 1 });
  assert.equal(await few.tick(), "too_few");
  assert.equal(compile(few.stub).length, 0);
  // Learning paused.
  await f.researchMemory.setSettings?.(f.userId, { learningPaused: true });
  if (typeof f.researchMemory.setSettings !== "function") await f.database.query("INSERT INTO evimed_memory.settings (user_id, learning_paused) VALUES ($1, true) ON CONFLICT (user_id) DO UPDATE SET learning_paused=true", [f.userId]);
  assert.equal(await f.tick(), "held_back");
  await f.database.query("UPDATE evimed_memory.settings SET learning_paused=false WHERE user_id=$1", [f.userId]);
  // An extraction still owed.
  await f.overlay.recordCommit({ userId: f.userId, archiveUri: `viking://user/${f.engineUser}/sessions/s/history/archive_001`, engineSession: "dsh-session_x", origin: "gateway" });
  assert.equal(await f.tick(), "held_back");
  await f.overlay.completeCommit(f.userId, `viking://user/${f.engineUser}/sessions/s/history/archive_001`, { operations: 0 });
  // A commit that finished a minute ago.
  assert.equal(await f.tick(), "held_back", "the last commit is under ten minutes old (its row is as old as the database's clock)");
  await f.database.query("UPDATE evimed_memory.native_commits SET created_at = created_at - interval '1 hour' WHERE user_id=$1", [f.userId]);
  // Another worker holds the account.
  assert.equal(await f.overlay.claimConsolidation(f.userId, 60_000), true);
  assert.equal(await f.tick(), "held_back");
  assert.equal(compile(f.stub).length, 0);
  await f.database.query("UPDATE evimed_memory.native_accounts SET consolidation_lease_until = NULL WHERE user_id=$1", [f.userId]);
  assert.equal(await f.tick(), "submitted");
  assert.equal(nativeMemoryCounters().consolidations.held_back, 4);
});

test("a failed task is counted and asked again at the next due time; one the engine lost, or that outlives its time, is let go", options, async (t) => {
  let fail = "the model budget is spent";
  const f = await account(t, { consolidate: ({ user }) => (fail ? { fail } : { updates: [{ uri: `viking://user/${user}/memories/entities/person/p0.md`, text: "Fact number 0, tightened." }] }) });
  await f.tick(); await f.tick();
  assert.equal(await f.tick(), "failed");
  const failed = await f.overlay.consolidationState(f.userId);
  assert.deepEqual([failed.task, failed.consolidatedAt, failed.fingerprint], [null, null, null], "a failure records nothing as done");
  fail = "";
  f.advanceConsolidation(2 * 3_600_000);
  assert.equal(await f.tick(), "submitted", "the same files, asked again: a failure is not an answer");
  // A task the engine no longer holds.
  f.stub.tasks.clear();
  assert.equal(await f.tick(), "lost");
  // One that runs for too long is cancelled and counted as failed.
  f.advanceConsolidation(2 * 3_600_000);
  f.stub.consolidationPolls = 1_000;
  assert.equal(await f.tick(), "submitted");
  assert.equal(await f.tick(), "submitted");
  f.advanceConsolidation(TASK_TIMEOUT_MS + 1_000);
  assert.equal(await f.tick(), "failed");
  assert.equal((await f.overlay.consolidationState(f.userId)).task, null);
  assert.ok(f.stub.requests.some((request) => request.method === "POST" && /\/api\/v1\/tasks\/[^/]+\/cancel$/.test(request.path)), "the engine was told to stop");
});

test("errors with no change are a failure, errors with some change keep the change; a task that changed nothing is a completed no-op", options, async (t) => {
  let outcome = { errors: ["rename conflict"] };
  const f = await account(t, { consolidate: () => outcome });
  await f.tick(); await f.tick();
  assert.equal(await f.tick(), "failed");
  f.advanceConsolidation(2 * 3_600_000);
  outcome = { errors: ["one merge conflicted"], updates: [{ uri: `viking://user/${f.engineUser}/memories/entities/person/p0.md`, text: "Fact number 0, tightened." }] };
  await f.tick(); await f.tick();
  assert.equal(await f.tick(), "completed");
  assert.equal((await f.overlay.revisionsOf(f.userId, f.uris[0])).length, 1);
  f.advanceConsolidation(8 * DAY);
  f.seed("entities/person/another.md", "Another fact.", { type: "entities" });
  outcome = {};
  await f.tick(); await f.tick();
  assert.equal(await f.tick(), "completed", "nothing to merge is not a failure");
  assert.deepEqual(nativeMemoryCounters().consolidatedFiles, { added: 0, updated: 1, deleted: 0 });
});

test("what a consolidation writes is held to the checks after the fact: an identifier, and a line the person removed that a merge brought back", options, async (t) => {
  const f = await account(t, { consolidate: ({ user }) => ({ updates: [
    { uri: `viking://user/${user}/memories/entities/person/p0.md`, text: "Fact number 0 about the person's work.\nReach them at someone@example.org." },
    { uri: `viking://user/${user}/memories/entities/person/p2.md`, text: "Fact number 2 about the person's work.\nPrefers tables for comparisons of every kind." },
  ] }) });
  // The person removed a line earlier; a merge puts it back.
  const gone = f.seed("entities/person/gone.md", "Prefers tables for comparisons of every kind.", { type: "entities" });
  await f.store.remove(f.userId, nativeFileId(gone), { keepText: false, actor: "user" });
  assert.ok((await f.overlay.rejectedFingerprints(f.userId, "entities")).has(lineFingerprint("Prefers tables for comparisons of every kind.")));
  // The overlay's last reading of the file the merge will rewrite is what it was before.
  await f.tick(); await f.tick();
  assert.equal(await f.tick(), "completed");
  assert.equal(await f.sessions.read(f.userId, f.uris[0]), "Fact number 0 about the person's work.", "the e-mail address is taken out");
  const checked = (await f.overlay.revisionsOf(f.userId, f.uris[0])).find((revision) => revision.actor === "platform");
  assert.match(checked.reason, /identifier_shape/);
  assert.equal(nativeMemoryCounters().checkActions.identifier_shape, 1);
  assert.equal(await f.sessions.read(f.userId, f.uris[2]), "Fact number 2 about the person's work.", "the line the person removed is taken out again");
  const why = (await f.overlay.revisionsOf(f.userId, f.uris[2])).find((revision) => revision.actor === "platform");
  assert.match(why.reason, /rejected_line/);
});

test("the worker's own pass asks it for every native account, and a pass with it off asks nothing", options, async (t) => {
  const f = await account(t, { consolidate: ({ user }) => ({ updates: [{ uri: `viking://user/${user}/memories/entities/person/p0.md`, text: "Fact number 0, tightened." }] }) });
  f.worker.consolidation = f.consolidation;
  assert.equal(await f.researchMemory.memoryEngine(f.userId), "native", "an account's engine is decided the first time anything asks");
  await f.worker.pass();
  assert.equal(compile(f.stub).length, 1, "the pass submitted this account's consolidation");
  await f.worker.pass();
  await f.worker.pass();
  assert.equal(nativeMemoryCounters().consolidations.completed, 1);
  const off = await account(t, { config: { nativeMemoryConsolidationEnabled: false } });
  off.worker.consolidation = off.consolidation;
  await off.researchMemory.memoryEngine(off.userId);
  await off.worker.pass();
  assert.equal(compile(off.stub).length, 0);
});

test("a consolidation can only target the account's own memories, and always carries an idempotency key", options, async (t) => {
  const f = await account(t);
  await assert.rejects(f.resources.submitMemoryConsolidation(f.userId, { to: "viking://user/another-user/memories", idempotencyKey: "nm-consolidate-abcdefgh" }), { code: "knowledge_compile_invalid" });
  await assert.rejects(f.resources.submitMemoryConsolidation(f.userId, { to: `${f.root}-evil`, idempotencyKey: "nm-consolidate-abcdefgh" }), { code: "knowledge_compile_invalid" });
  await assert.rejects(f.resources.submitMemoryConsolidation(f.userId, { to: f.root, idempotencyKey: "" }), { code: "knowledge_compile_invalid" });
  assert.equal(compile(f.stub).length, 0, "nothing reached the engine");
  const task = await f.resources.submitMemoryConsolidation(f.userId, { to: `${f.root}/entities`, idempotencyKey: "nm-consolidate-abcdefgh" });
  assert.equal(task.terminal, false);
  assert.equal(compile(f.stub)[0].body.to, `${f.root}/entities`, "a type's own directory is a target too");
});
