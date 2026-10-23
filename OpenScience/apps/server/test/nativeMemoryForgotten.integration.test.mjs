// What a person forgot on the native engine can be listed and brought back (2026-10-23, rectification T1.7). The engine no longer holds a
// forgotten file; the overlay's revisions kept its text for the undo, and the page's 「已忘记的内容」 lists them as `status: "archived"`
// records exactly as it does for the other engine — with 恢复 writing the text back through the engine.
import assert from "node:assert/strict";
import test from "node:test";

import { lineFingerprint } from "../src/nativeMemoryOverlay.mjs";
import { nativeFileId } from "../src/nativeMemoryStore.mjs";
import { nativeAppIntegration } from "./helpers/nativeAppFixture.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();
const app = nativeAppIntegration();

const archivedOf = async (store, userId) => (await store.profile(userId)).records.filter((record) => record.status === "archived");

test("a forgotten file is listed with its text and comes back through the engine, and the forget leaves the list", options, async (t) => {
  const { userId, store, seed, sessions, overlay, root } = await fixture(t);
  const uri = seed("preferences/format.md", "Answers as short paragraphs.\nTables for comparisons.", { type: "preferences" });
  const live = (await store.records(userId)).find((record) => record.uri === uri);
  await store.update(userId, live.id, { status: "archived", expectedVersion: live.version });
  assert.equal(await sessions.read(userId, uri), null, "the file left the engine");

  const page = await store.profile(userId);
  assert.equal(page.activeCount, 0, "a forgotten memory is not counted as one in force");
  const [entry] = page.records.filter((record) => record.status === "archived");
  assert.ok(entry, "the forgotten file is on the list");
  assert.equal(entry.id, live.id, "its id is the one it had");
  assert.equal(entry.value, "Answers as short paragraphs.\nTables for comparisons.");
  assert.equal(entry.kind, "preference");
  assert.equal(entry.nativeType, "preferences");
  assert.ok(page.groups.preference.includes(entry), "and in its group, as on the other engine");
  assert.deepEqual((await store.records(userId)), [], "every other reader leaves it out");
  assert.deepEqual(await store.mapMemories(userId).then((map) => map.records), []);
  assert.equal((await store.search(userId, "paragraphs")).items.length, 0);
  assert.ok((await overlay.rejectedFingerprints(userId, "preferences")).has(lineFingerprint("Tables for comparisons.")), "its lines stay on the rejection list while it is forgotten");

  // A stale version is refused and nothing is written.
  await assert.rejects(store.update(userId, entry.id, { status: "active", expectedVersion: entry.version + 1 }), (error) => error.status === 409 && error.code === "memory_conflict");
  assert.equal(await sessions.read(userId, uri), null);

  const restored = await store.update(userId, entry.id, { status: "active", expectedVersion: entry.version });
  assert.equal(restored.status, "active");
  assert.equal(await sessions.read(userId, uri), "Answers as short paragraphs.\nTables for comparisons.");
  assert.equal((await archivedOf(store, userId)).length, 0, "restored, it is not forgotten any more");
  assert.equal((await overlay.rejectedFingerprints(userId, "preferences")).has(lineFingerprint("Tables for comparisons.")), false, "and its lines are the person's again");
  assert.equal((await overlay.revisionsOf(userId, uri))[0].change, "restored");
  assert.equal(`${root}/preferences/format.md`, uri);
  // Asked again, the memory is in force already: the answer is the live record and nothing is written.
  const revisionsBefore = (await overlay.revisionsOf(userId, uri)).length;
  const again = await store.update(userId, entry.id, { status: "active", expectedVersion: restored.version });
  assert.equal(again.status, "active");
  assert.equal((await overlay.revisionsOf(userId, uri)).length, revisionsBefore);
});

test("a forgotten line of the profile is listed as a line and goes back into the document", options, async (t) => {
  const { userId, store, seed, sessions } = await fixture(t);
  const uri = seed("profile.md", "# Profile\n- Works in a hospital pharmacy (as of 2026-09-01)\n- Allergic to penicillin", { type: "profile" });
  const lines = (await store.records(userId)).filter((record) => record.document);
  const allergy = lines.find((line) => /penicillin/.test(line.value));
  const gone = await store.update(userId, allergy.id, { status: "archived", expectedVersion: allergy.version });
  assert.equal(gone.status, "archived");
  assert.doesNotMatch(await sessions.read(userId, uri), /penicillin/);

  const [entry, ...others] = await archivedOf(store, userId);
  assert.equal(others.length, 0);
  assert.equal(entry.id, allergy.id, "the line has the id it had while it lived");
  assert.equal(entry.value, "Allergic to penicillin");
  assert.deepEqual(entry.document, { id: nativeFileId(uri), uri });
  assert.equal((await store.profile(userId)).activeCount, 1, "the other line is still in force");

  const restored = await store.update(userId, entry.id, { status: "active", expectedVersion: entry.version });
  assert.equal(restored.value, "Allergic to penicillin");
  const text = await sessions.read(userId, uri);
  assert.match(text, /- Works in a hospital pharmacy/, "the other line is untouched");
  assert.match(text, /- Allergic to penicillin/);
  assert.equal((await archivedOf(store, userId)).length, 0);
  assert.equal((await store.profile(userId)).activeCount, 2);
});

test("only what can be taken back is listed: not a hard delete, not what the platform removed, not what is live again", options, async (t) => {
  const { userId, store, seed, overlay, sessions, root } = await fixture(t);
  const hard = seed("preferences/hard.md", "Deleted for good.", { type: "preferences" });
  const soft = seed("preferences/soft.md", "Forgotten with an undo.", { type: "preferences" });
  const again = seed("preferences/again.md", "Forgotten, then written by the engine again.", { type: "preferences" });
  const byUri = async () => new Map((await store.records(userId)).map((record) => [record.uri, record]));
  await store.remove(userId, (await byUri()).get(hard).id, { keepText: false, actor: "user" });
  await store.remove(userId, (await byUri()).get(soft).id, { keepText: true, actor: "user" });
  await store.remove(userId, (await byUri()).get(again).id, { keepText: true, actor: "user" });
  // The platform's own check took a file out (an identifier shape): that is not the person's forget.
  await overlay.addRevision({ userId, uri: `${root}/preferences/platform.md`, memoryType: "preferences", change: "deleted", actor: "platform", reason: "identifier_shape", before: "text", after: null });
  assert.deepEqual((await archivedOf(store, userId)).map((record) => record.uri).sort(), [again, soft].sort());
  // The engine writes the same address again: the person's forget no longer describes anything.
  seed("preferences/again.md", "Written again.", { type: "preferences" });
  assert.deepEqual((await archivedOf(store, userId)).map((record) => record.uri), [soft]);
  // The page's own 8-second undo takes the forget off the list as well.
  const [only] = await archivedOf(store, userId);
  await store.undo(userId, only.id, {});
  assert.equal((await archivedOf(store, userId)).length, 0);
  assert.equal(await sessions.read(userId, soft), "Forgotten with an undo.");
});

test("what a conversation forgot at the person's word is listed too, and the restore keeps the project it belonged to", options, async (t) => {
  const { userId, store, seed, sessions, overlay } = await fixture(t);
  const uri = seed("projects/trial.md", "# Trial\n## 目标\n- Compare two schedules.", { type: "project_context", tags: ["project=p_trial"] });
  await overlay.upsertFile({ userId, uri, memoryType: "project_context", body: "# Trial\n## 目标\n- Compare two schedules.", projectId: "p_trial" });
  assert.deepEqual(await store.forget({ id: userId }, { id: "p_trial" }, uri), { removed: true });
  const [entry] = await archivedOf(store, userId);
  assert.equal(entry.scope, "project");
  assert.equal(entry.scopeId, "p_trial");
  await store.update(userId, entry.id, { status: "active", expectedVersion: entry.version });
  assert.match(await sessions.read(userId, uri), /Compare two schedules/);
  const [back] = (await store.records(userId)).filter((record) => record.uri === uri);
  assert.equal(back.scopeId, "p_trial", "the project tag was written back with the file");
});

test("the page restores a forgotten memory with the same PATCH it uses for any status", app.options, async (t) => {
  const { base, headers, seed, sessions, user } = await app.fixture(t);
  const uri = seed("preferences/format.md", "Answers as short paragraphs.", { type: "preferences" });
  const list = async () => (await (await fetch(`${base}/api/memory/profile`, { headers })).json()).data;
  const record = (await list()).records.find((item) => item.uri === uri);
  const forget = await fetch(`${base}/api/memory/records/${encodeURIComponent(record.id)}`, { method: "PATCH", headers, body: JSON.stringify({ status: "archived", expectedVersion: record.version }) });
  assert.equal(forget.status, 200);
  const profile = await list();
  const archived = profile.records.filter((item) => item.status === "archived");
  assert.equal(archived.length, 1);
  assert.equal(profile.activeCount, 0);
  const restored = await fetch(`${base}/api/memory/records/${encodeURIComponent(archived[0].id)}`, { method: "PATCH", headers, body: JSON.stringify({ status: "active", expectedVersion: archived[0].version }) });
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal(await sessions.read(user.id, uri), "Answers as short paragraphs.");
  assert.equal((await list()).records.filter((item) => item.status === "archived").length, 0);
  // A memory that never existed is a 404, not a quiet success.
  const unknown = await fetch(`${base}/api/memory/records/nm_${"0".repeat(24)}`, { method: "PATCH", headers, body: JSON.stringify({ status: "active", expectedVersion: 1 }) });
  assert.equal(unknown.status, 404);
});
