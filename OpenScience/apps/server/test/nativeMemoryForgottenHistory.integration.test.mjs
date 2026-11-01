// A forgotten or deleted line is never shown again (rev-1101). The person edits a line in one file, so its old words stay in that file's history
// and the map may draw them in grey; later they forget (or delete) the same words in another file. The old words in the first file's history are
// the forgotten line now: the map's grey marks and the drawer's earlier versions must not show them. Over a real PostgreSQL and the stub engine.
import assert from "node:assert/strict";
import test from "node:test";

import { lineFingerprint } from "../src/nativeMemoryOverlay.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();

const OLD = "Target journal is Kidney International and nothing else.";
const NEW = "Target journal is JASN and nothing else.";

/** The same words in two files; the person edits one of them, so its history keeps the old words. */
async function seeded(t) {
  const f = await fixture(t);
  const edited = f.seed("preferences/journal-a.md", OLD, { type: "preferences" });
  const other = f.seed("preferences/journal-b.md", OLD, { type: "preferences" });
  const byUri = async () => new Map((await f.store.records(f.userId)).map((record) => [record.uri, record]));
  const record = (await byUri()).get(edited);
  await f.store.update(f.userId, record.id, { value: NEW, expectedVersion: record.version });
  return { ...f, edited, other, byUri };
}

const greyTexts = async (f) => (await f.store.mapMemories(f.userId)).replaced.map((statement) => statement.text);
const versionsOf = async (f, uri) => (await f.byUri()).get(uri).revisions.map((revision) => revision.value);

test("an edit's old words are drawn as what the memory used to say, and listed in its earlier versions", options, async (t) => {
  const f = await seeded(t);
  assert.deepEqual(await greyTexts(f), [OLD]);
  assert.deepEqual(await versionsOf(f, f.edited), [OLD]);
  const [row] = await f.overlay.rejectedLines(f.userId, "preferences");
  assert.equal(row.origin, "edit");
});

test("the same words forgotten in another file are no longer drawn or listed in the edited file's history", options, async (t) => {
  const f = await seeded(t);
  const other = (await f.byUri()).get(f.other);
  await f.store.update(f.userId, other.id, { status: "archived", expectedVersion: other.version });
  assert.deepEqual(await greyTexts(f), [], "not in the map");
  assert.deepEqual(await versionsOf(f, f.edited), [""], "the earlier version is kept, without the forgotten words");
  assert.equal((await f.overlay.rejectedLines(f.userId, "preferences")).find((row) => row.fingerprint === lineFingerprint(OLD))?.origin, "forget");

  // The forget is undone: the words are the person's again, and the history of the edit is whole.
  const archived = (await f.store.profile(f.userId)).records.find((record) => record.status === "archived");
  await f.store.update(f.userId, archived.id, { status: "active", expectedVersion: archived.version });
  assert.deepEqual(await greyTexts(f), [OLD]);
  assert.deepEqual(await versionsOf(f, f.edited), [OLD]);
});

test("the same words deleted in another file are no longer drawn or listed either", options, async (t) => {
  const f = await seeded(t);
  const other = (await f.byUri()).get(f.other);
  await f.store.remove(f.userId, other.id, { keepText: false, actor: "user" });
  assert.deepEqual(await greyTexts(f), []);
  assert.deepEqual(await versionsOf(f, f.edited), [""]);
});

test("a rejection older than the origin column is read as a forget: nothing it names is drawn", options, async (t) => {
  const f = await seeded(t);
  await f.database.query("UPDATE evimed_memory.native_rejections SET origin = NULL WHERE user_id = $1", [f.userId]);
  assert.deepEqual(await greyTexts(f), []);
  assert.deepEqual(await versionsOf(f, f.edited), [""]);
});

test("a line the person forgot from its own file is still on that forget's version, the one its undo goes back to", options, async (t) => {
  const f = await fixture(t);
  const uri = f.seed("preferences/format.md", "Answers as short paragraphs.\nTables for comparisons.", { type: "preferences" });
  const live = (await f.store.records(f.userId)).find((record) => record.uri === uri);
  await f.store.update(f.userId, live.id, { status: "archived", expectedVersion: live.version });
  const [archived] = (await f.store.profile(f.userId)).records.filter((record) => record.status === "archived");
  assert.equal(archived.value, "Answers as short paragraphs.\nTables for comparisons.");
  const restored = await f.store.update(f.userId, archived.id, { status: "active", expectedVersion: archived.version });
  assert.equal(restored.status, "active");
  assert.equal(await f.sessions.read(f.userId, uri), "Answers as short paragraphs.\nTables for comparisons.");
});

test("a read of the old words that does not finish costs the grey marks and nothing else", options, async (t) => {
  const f = await seeded(t);
  const { NativeMemoryStore } = await import("../src/nativeMemoryStore.mjs");
  const { nativeMemoryCounters } = await import("../src/nativeMemoryMetrics.mjs");
  const quick = new NativeMemoryStore({ sessions: f.sessions, overlay: f.overlay, now: f.now, replacedDeadlineMs: 50 });
  assert.equal((await quick.mapMemories(f.userId)).replaced.length, 1, "read in time");
  const before = nativeMemoryCounters().mapReplaced.timeout;
  // The rejection lists never answer: the marks are given up at the deadline, and the memories the map draws from are all there.
  const answered = f.overlay.rejectedLines;
  f.overlay.rejectedLines = () => new Promise(() => {});
  try {
    const started = Date.now();
    const map = await quick.mapMemories(f.userId);
    assert.ok(Date.now() - started < 2_000, "it did not wait for the read");
    assert.deepEqual(map.replaced, []);
    assert.equal(map.records.length, 2, "both memories are drawn");
    assert.equal(nativeMemoryCounters().mapReplaced.timeout, before + 1);
  } finally {
    f.overlay.rejectedLines = answered;
  }
});

test("a rejection is an edit's only while every rejection of the words was one: a forget wins for good, and a row with no origin stays closed", options, async (t) => {
  const f = await fixture(t);
  const line = "Prefers the Vancouver reference style.";
  const originOf = async () => (await f.overlay.rejectedLines(f.userId, "preferences")).find((row) => row.fingerprint === lineFingerprint(line))?.origin;
  await f.overlay.reject(f.userId, "preferences", "uri:a", [line], { origin: "edit" });
  assert.equal(await originOf(), "edit");
  await f.overlay.reject(f.userId, "preferences", "uri:a", [line], { origin: "edit" });
  assert.equal(await originOf(), "edit", "edited away twice is still an edit");
  await f.overlay.reject(f.userId, "preferences", "uri:b", [line]);
  assert.equal(await originOf(), "forget", "forgotten once, anywhere");
  await f.overlay.reject(f.userId, "preferences", "uri:a", [line], { origin: "edit" });
  assert.equal(await originOf(), "forget", "an edit afterwards does not reopen it");
  // A row from before the column, edited away again: unknown stays closed.
  await f.database.query("UPDATE evimed_memory.native_rejections SET origin = NULL WHERE user_id = $1", [f.userId]);
  await f.overlay.reject(f.userId, "preferences", "uri:a", [line], { origin: "edit" });
  assert.equal(await originOf(), "forget");
  // And the person writing the words themselves lifts the rejection altogether.
  await f.overlay.unreject(f.userId, "preferences", [line]);
  assert.equal(await originOf(), undefined);
});
