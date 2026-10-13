// The native memory path end to end on a real PostgreSQL and a stub engine: the page's store (list, edit under compare-and-swap,
// delete and the rejection list, remember, undo, reset, project and account deletion) and the overlay's worker (the archive scan,
// the diff into revisions, the checks after the fact, the replay of a failed commit, the source labels). The stub records what
// reached the engine, so "the engine was not asked" is asserted on its side.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { NativeMemoryOverlay, contentHash, lineFingerprint } from "../src/nativeMemoryOverlay.mjs";
import { NativeMemoryStore, nativeFileId, versionOfHash } from "../src/nativeMemoryStore.mjs";
import { NativeMemoryWorker, cleanBody, lineRefusal } from "../src/nativeMemoryWorker.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";
import { resetNativeMemoryMetrics, nativeMemoryCounters } from "../src/nativeMemoryMetrics.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const config = { ovNativeMemoryEnabled: true, memoryContextLimit: 8, memoryContextMaxChars: 20_000, nativeMemoryReplayAttempts: 3 };

/** @type {ControlPlaneDatabase} */
let database;
const users = [];

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await migrateResearchMemory(database);
});
after(async () => {
  if (!url) return;
  for (const id of users) await database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]);
  await database.close();
});

/** A user, an engine stub, and the native pieces over them. */
async function fixture(t, { extract = () => ({}) } = {}) {
  resetNativeMemoryMetrics();
  const userId = `nm_${randomUUID().slice(0, 8)}`;
  users.push(userId);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Native memory test','development')", [userId]);
  const stub = await startOpenVikingStub(t, { extract });
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const overlay = new NativeMemoryOverlay({ database });
  const researchMemory = new ResearchMemoryStore(config, { database });
  let clock = new Date("2026-10-13T08:00:00.000Z");
  const store = new NativeMemoryStore({ sessions, overlay, now: () => clock });
  const worker = new NativeMemoryWorker({ config: { ...config, ovNativeMemoryEnabled: true }, researchMemory, sessions, overlay, now: () => clock });
  const root = sessions.memoryRoot(userId);
  const engineUser = sessions.engineUser(userId);
  const seed = (relPath, text, { type, tags = [] } = {}) => stub.seedMemory(engineUser, relPath, text, { type, tags });
  await sessions.register(userId);
  await overlay.noteRegistered(userId);
  return { userId, stub, sessions, overlay, researchMemory, store, worker, root, engineUser, seed, advance: (ms) => { clock = new Date(clock.getTime() + ms); }, now: () => clock };
}

test("the engine of an account is native by default where the deployment has it, and one account is never on both", options, async (t) => {
  const { userId, researchMemory, overlay } = await fixture(t);
  assert.equal(await researchMemory.memoryEngine(userId), "native");
  assert.ok((await researchMemory.accountsOnEngine("native")).some((entry) => entry.userId === userId));
  assert.ok(!(await researchMemory.accountsOnEngine("legacy")).some((entry) => entry.userId === userId));
  const walk = await researchMemory.engineWalk();
  assert.ok(walk.examined.native >= 1, "the walk looked at accounts");
  assert.equal(walk.both.filter((entry) => entry.userId === userId).length, 0);
  // A legacy record written after the move is what the walk is there to find (the move is dated a minute back: a write in the
  // very second of the switch counts as before it).
  await database.query("UPDATE evimed_memory.settings SET engine_changed_at = engine_changed_at - interval '1 minute' WHERE user_id=$1", [userId]);
  await researchMemory.upsertRecord(userId, { scope: "user", scopeId: null, kind: "preference", key: "preference.x", value: "x", summary: "x", origin: "inferred", status: "active", confidence: 0.7, importance: 0.5, sensitive: false }, null);
  const after = await researchMemory.engineWalk();
  assert.ok(after.both.some((entry) => entry.userId === userId && entry.engine === "native" && entry.writes >= 1), "a legacy write on a native account is reported");
  assert.equal((await overlay.account(userId)).registeredAt !== null, true);
});

test("a memory file is a record, the profile is a document of lines, and counts are counted here", options, async (t) => {
  const { userId, store, seed } = await fixture(t);
  const language = seed("preferences/language.md", "Replies in Simplified Chinese; code and commit messages in English.", { type: "preferences" });
  const profile = seed("profile.md", "# Profile\n- Works as a pharmacist in a hospital (as of 2026-09-01)\n- Based in Chengdu", { type: "profile" });
  seed("projects/oncology-review.md", "# Oncology review\n领域：肿瘤药学\n## 目标\n- 评价某药的疗效\n## 阶段\n- 检索中", { type: "project_context", tags: ["project=p_onc"] });
  seed("evimed/derived.md", "derived index, not a memory");
  const profilePage = await store.profile(userId, { holder: { id: userId, name: "T" } });
  assert.equal(profilePage.engine, "native");
  assert.equal(profilePage.activeCount, 4, "one file, two profile lines, one project card");
  const lines = profilePage.records.filter((record) => record.document);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].document.uri, profile);
  assert.ok(lines.some((record) => record.value === "Works as a pharmacist in a hospital" && record.lastConfirmedAt === "2026-09-01T00:00:00.000Z"), "an as-of date is the line's confirmation, not its text");
  const preference = profilePage.records.find((record) => record.uri === language);
  assert.equal(preference.kind, "preference");
  assert.equal(preference.nativeType, "preferences");
  assert.equal(preference.version, versionOfHash(contentHash(preference.value)));
  assert.ok(Number.isSafeInteger(preference.version) && preference.version > 0);
  const project = profilePage.records.find((record) => record.nativeType === "project_context");
  assert.equal(project.scope, "project");
  assert.equal(project.scopeId, "p_onc", "the project is the tag the engine file carries");
  assert.ok(!profilePage.records.some((record) => record.uri.includes("/evimed/")), "the derived index is not a memory");
  const card = await store.projectCard(userId, "p_onc");
  assert.deepEqual(card.map((entry) => [entry.slot, entry.text]), [["field", "肿瘤药学"], ["goal", "评价某药的疗效"], ["stage", "检索中"]]);
  assert.deepEqual(await store.projectCard(userId, "p_other"), []);
  const filtered = await store.listRecords(userId, { kinds: ["preference"] });
  assert.deepEqual(filtered.map((record) => record.uri), [language]);
});

test("an edit is a compare-and-swap on the text last read, and it is revisioned and undoable", options, async (t) => {
  const { userId, store, seed, sessions, overlay } = await fixture(t);
  const uri = seed("preferences/format.md", "Answers as short paragraphs.", { type: "preferences" });
  const record = (await store.records(userId)).find((entry) => entry.uri === uri);
  const edited = await store.update(userId, record.id, { value: "Answers as short paragraphs; tables for comparisons.", expectedVersion: record.version });
  assert.equal(edited.value, "Answers as short paragraphs; tables for comparisons.");
  assert.equal(await sessions.read(userId, uri), "Answers as short paragraphs; tables for comparisons.");
  assert.notEqual(edited.version, record.version);
  // The stale token is refused and the file is not written.
  await assert.rejects(store.update(userId, record.id, { value: "overwritten", expectedVersion: record.version }), (error) => error.status === 409 && error.code === "memory_conflict");
  assert.equal(await sessions.read(userId, uri), "Answers as short paragraphs; tables for comparisons.");
  const history = await overlay.revisionsOf(userId, uri);
  assert.equal(history[0].actor, "user");
  assert.equal(history[0].before, "Answers as short paragraphs.");
  // A secret-shaped edit is refused at the door.
  await assert.rejects(store.update(userId, record.id, { value: "my phone is 13800138000", expectedVersion: edited.version }), (error) => error.code === "memory_content_refused");
  // Undo goes back to what the file said, and a second undo has nothing of the user's own to restore beyond that.
  const undone = await store.undo(userId, record.id, { expectedVersion: edited.version });
  assert.equal(undone.undone, "restored");
  assert.equal(await sessions.read(userId, uri), "Answers as short paragraphs.");
});

test("a line of the profile is edited and removed as a line of its document; a delete scrubs the history, a forget keeps it for the undo", options, async (t) => {
  const { userId, store, seed, sessions, overlay } = await fixture(t);
  const uri = seed("profile.md", "# Profile\n- Works in a hospital pharmacy (as of 2026-09-01)\n- Allergic to penicillin", { type: "profile" });
  const [first, second] = (await store.records(userId)).filter((entry) => entry.document).sort((a, b) => a.value.localeCompare(b.value));
  assert.match(first.id, /^nm_[a-f0-9]{24}_[a-f0-9]{12}$/);
  const dated = await store.update(userId, first.id, { value: "Allergic to penicillin and sulfonamides", expectedVersion: first.version });
  assert.equal(dated.value, "Allergic to penicillin and sulfonamides");
  assert.match(await sessions.read(userId, uri), /- Allergic to penicillin and sulfonamides \(as of 2026-10-13\)/);
  assert.match(await sessions.read(userId, uri), /Works in a hospital pharmacy/, "the other line stays");
  // Forget the other line with an undo: the text stays in the history, the line leaves the file.
  const current = (await store.records(userId)).find((entry) => entry.value.startsWith("Works in"));
  const forgotten = await store.update(userId, current.id, { status: "archived", expectedVersion: current.version });
  assert.equal(forgotten.status, "archived");
  assert.doesNotMatch(await sessions.read(userId, uri), /Works in a hospital/);
  assert.ok((await overlay.revisionsOf(userId, uri)).some((revision) => /Works in a hospital/.test(revision.before ?? "")), "a forget keeps the text for its undo");
  // A delete removes the line from the history too, and puts it on the rejection list.
  const sulfa = (await store.records(userId)).find((entry) => entry.value.startsWith("Allergic"));
  await store.remove(userId, sulfa.id, { keepText: false });
  assert.doesNotMatch(await sessions.read(userId, uri), /Allergic/);
  const revisions = await overlay.revisionsOf(userId, uri);
  assert.ok(!revisions.some((revision) => /Allergic/.test(`${revision.before ?? ""}${revision.after ?? ""}`)), "no revision keeps what the person deleted");
  assert.ok((await overlay.rejectedFingerprints(userId, "profile")).has(lineFingerprint("Allergic to penicillin and sulfonamides")));
  assert.ok(second, "two lines were listed");
});

test("deleting a file removes it, rejects its lines and keeps no text; a forget of a file can be undone as text", options, async (t) => {
  const { userId, store, seed, sessions, overlay, stub } = await fixture(t);
  const uri = seed("preferences/units.md", "Doses in mg/kg.", { type: "preferences" });
  const other = seed("preferences/tone.md", "Plain, no flattery.", { type: "preferences" });
  const [units, tone] = ["units", "tone"].map((name) => nativeFileId(`${sessions.memoryRoot(userId)}/preferences/${name}.md`));
  await store.remove(userId, units, { keepText: false });
  assert.equal(await sessions.read(userId, uri), null);
  assert.ok((await overlay.rejectedFingerprints(userId, "preferences")).has(lineFingerprint("Doses in mg/kg.")));
  assert.ok((await overlay.revisionsOf(userId, uri)).every((revision) => revision.before === null && revision.after === null), "a delete keeps no text");
  await assert.rejects(store.undo(userId, units, {}), (error) => error.status === 409);
  const record = (await store.records(userId)).find((entry) => entry.uri === other);
  const result = await store.update(userId, record.id, { status: "archived", expectedVersion: record.version });
  assert.equal(result.status, "archived");
  assert.equal(await sessions.read(userId, other), null);
  const undone = await store.undo(userId, tone, {});
  assert.equal(undone.undone, "restored");
  assert.equal(await sessions.read(userId, other), "Plain, no flattery.", "the text is back");
  assert.ok(stub.sent("DELETE", "/api/v1/fs").length >= 2);
});

test("remember from the page goes through the engine as a conversation, shows as pending, and is settled by the worker", options, async (t) => {
  let seen = null;
  const { userId, store, worker, overlay, sessions, root } = await fixture(t, {
    extract: ({ messages }) => { seen = messages; return { adds: [{ uri: `${`viking://user/${"__USER__"}`}`, memory_type: "preferences", after: "x" }].slice(0, 0) }; },
  });
  const pending = await store.remember(userId, { text: "我习惯用中文写综述的摘要", projectId: null });
  assert.equal(pending.pending.state, "pending");
  assert.match(JSON.stringify(seen), /请记住：我习惯用中文写综述的摘要/);
  const page = await store.profile(userId);
  assert.equal(page.pending.length, 1, "until the engine has written it the page says it is pending");
  assert.equal(page.pending[0].text, "我习惯用中文写综述的摘要");
  await assert.rejects(store.remember(userId, { text: "   " }), (error) => error.code === "memory_payload_invalid");
  await assert.rejects(store.remember(userId, { text: "my phone is 13800138000 please keep it" }), (error) => error.code === "memory_content_refused");
  assert.ok(root.startsWith("viking://user/"));
  await worker.processCommits({ userId });
  assert.equal((await store.profile(userId)).pending.length, 0, "settled: the ledger row is complete and the text cleared");
  assert.equal((await overlay.pendingCommits(userId, { origins: ["page"] })).length, 0);
  assert.equal((await overlay.commit(userId, pending.pending.id)).pendingText, null);
  assert.ok(await sessions.read(userId, `${pending.pending.id}/messages.jsonl`) !== null);
});

test("the worker enters an idle commit it never saw, ingests the diff into revisions once, and 刚记住了 reads them", options, async (t) => {
  const state = { engineUser: null };
  const { userId, store, worker, overlay, stub, engineUser, sessions, root } = await fixture(t, {
    extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/citation.md`, memory_type: "preferences", after: "Cites with numbered references." }] }),
  });
  state.engineUser = engineUser;
  // A conversation the engine committed by itself (idle timeout): the control plane never saw the commit.
  const session = "dsh-session_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, messages: [{ role: "user", parts: [{ type: "text", text: "Please cite with numbered references." }] }], archives: 0, commitCount: 0 });
  stub.commitSession(engineUser, session);
  const entered = await worker.scanArchives(userId);
  assert.equal(entered, 1);
  assert.equal(await worker.scanArchives(userId), 0, "an archive is entered once");
  assert.equal(nativeMemoryCounters().workerCommits.found_by_scan, 1);
  assert.equal(await worker.processCommits({ userId }), 1);
  assert.equal(await worker.processCommits({ userId }), 0, "a diff is read once");
  const uri = `${root}/preferences/citation.md`;
  const revisions = await overlay.revisionsOf(userId, uri);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].actor, "engine");
  assert.equal(revisions[0].change, "added");
  const changes = await store.changes(userId, { since: "2026-01-01T00:00:00.000Z", sessionId: session.slice(4) });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].change, "created");
  assert.equal(changes[0].id, nativeFileId(uri));
  // 「刚记住了」's one-click undo removes an engine addition and keeps the line from coming back.
  const undone = await store.undo(userId, changes[0].id, { expectedVersion: changes[0].version });
  assert.equal(undone.undone, "removed");
  assert.equal(await sessions.read(userId, uri), null);
  assert.ok((await overlay.rejectedFingerprints(userId, "preferences")).has(lineFingerprint("Cites with numbered references.")));
});

test("the checks after the fact: an identifier, platform text and a line the person removed are taken out of what the engine wrote, with the reason", options, async (t) => {
  const { userId, store, worker, overlay, stub, engineUser, sessions, root, seed } = await fixture(t);
  assert.equal(lineRefusal("- My e-mail is someone@example.org", new Set()), "identifier_shape");
  assert.equal(lineRefusal("- Likes tea", new Set()), null);
  assert.equal(lineRefusal("- Likes tea", new Set([lineFingerprint("Likes tea")])), "rejected_line");
  assert.deepEqual(cleanBody("# T\n- keep\n- 13800138000 is the phone", new Set()).hasStatements, true);
  // The person deleted a line; the engine writes it back verbatim in a later commit.
  seed("preferences/old.md", "Likes tea.", { type: "preferences" });
  await store.remove(userId, nativeFileId(`${root}/preferences/old.md`), { keepText: false });
  stub.extract = ({ user }) => ({
    adds: [
      { uri: `viking://user/${user}/memories/preferences/old.md`, memory_type: "preferences", after: "Likes tea." },
      { uri: `viking://user/${user}/memories/preferences/contact.md`, memory_type: "preferences", after: "- Reach me at someone@example.org\n- Prefers morning meetings" },
      { uri: `viking://user/${user}/memories/preferences/phone.md`, memory_type: "preferences", after: "Phone 13800138000" },
    ],
  });
  const session = "dsh-session_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }], archives: 0, commitCount: 0 });
  stub.commitSession(engineUser, session);
  await worker.scanArchives(userId);
  await worker.processCommits({ userId });
  assert.equal(await sessions.read(userId, `${root}/preferences/old.md`), null, "the line the person deleted is deleted again");
  assert.equal(await sessions.read(userId, `${root}/preferences/contact.md`), "- Prefers morning meetings", "the line with an address leaves, the other stays");
  assert.equal(await sessions.read(userId, `${root}/preferences/phone.md`), null, "a file left with no statement is removed");
  const why = (await overlay.revisionsOf(userId, `${root}/preferences/contact.md`)).find((revision) => revision.actor === "platform");
  assert.match(why.reason, /identifier_shape/);
  assert.equal(nativeMemoryCounters().checkActions.identifier_shape, 2, "the e-mail line and the phone line");
  assert.equal(nativeMemoryCounters().checkActions.rejected_line, 1);
});

test("a failed extraction is replayed from its archive as a new session, with a cap and a back-off, and is abandoned when it cannot succeed", options, async (t) => {
  let fail = true;
  const { userId, worker, overlay, stub, engineUser, sessions, root, advance } = await fixture(t, {
    extract: ({ user }) => (fail ? "fail" : { adds: [{ uri: `viking://user/${user}/memories/preferences/replayed.md`, memory_type: "preferences", after: "Prefers metric units." }] }),
  });
  const session = "dsh-session_cccccccccccccccccccccccccccccccc";
  stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, messages: [
    { role: "user", parts: [{ type: "text", text: "I prefer metric units." }] },
    { role: "assistant", parts: [{ type: "text", text: "Noted, metric units." }] },
  ], archives: 0, commitCount: 0 });
  const committed = stub.commitSession(engineUser, session);
  await overlay.recordCommit({ userId, archiveUri: committed.archive_uri, engineSession: session, origin: "gateway", taskId: committed.task_id });
  await worker.processCommits({ userId });
  assert.equal((await overlay.commit(userId, committed.archive_uri)).state, "failed", "the engine's failure marker is read");
  // The first replay fails again: attempts counted, the next try is later.
  advance(1);
  await worker.processCommits({ userId });
  const afterFirst = await overlay.commit(userId, committed.archive_uri);
  assert.equal(afterFirst.state, "replayed");
  const replays = [...stub.sessions.keys()].filter((key) => key.includes("evimed-replay-"));
  assert.equal(replays.length, 1);
  fail = false;
  // The replayed commit failed in turn (the engine was still rate-limited): its own row is failed, replayed again with the back-off.
  const replayRow = (await overlay.openCommits({ userId, limit: 10 })).find((row) => row.origin === "replay");
  assert.ok(replayRow, "the replay is a commit of its own in the ledger");
  await worker.processCommits({ userId });
  const next = await overlay.commit(userId, replayRow.archiveUri);
  assert.ok(["failed", "replayed"].includes(next.state));
  assert.ok(next.nextAttemptAt === null || Date.parse(next.nextAttemptAt) >= worker.now().getTime(), "a replay is not retried before its back-off");
  // Past the back-off the next replay succeeds and the memory is written.
  advance(3 * 3_600_000);
  for (let round = 0; round < 4; round += 1) { await worker.processCommits({ userId }); advance(3_600_000); }
  assert.equal(await sessions.read(userId, `${root}/preferences/replayed.md`), "Prefers metric units.");
});

test("a replay is capped: after the attempts it is abandoned and the reason is on the row", options, async (t) => {
  const { userId, worker, overlay, stub, engineUser, advance } = await fixture(t, { extract: () => "fail" });
  const session = "dsh-session_dddddddddddddddddddddddddddddddd";
  stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, messages: [{ role: "user", parts: [{ type: "text", text: "A real statement worth keeping." }] }], archives: 0, commitCount: 0 });
  const committed = stub.commitSession(engineUser, session);
  await overlay.recordCommit({ userId, archiveUri: committed.archive_uri, engineSession: session, origin: "gateway", taskId: committed.task_id });
  for (let round = 0; round < 12; round += 1) { await worker.processCommits({ userId }); advance(2 * 3_600_000); }
  const open = (await overlay.openCommits({ userId, limit: 50 })).length;
  assert.equal(open, 0, "nothing is retried without bound");
  assert.equal(nativeMemoryCounters().workerCommits.abandoned >= 1, true);
  const replays = stub.sent("POST", "/api/v1/sessions").filter((request) => String(request.body?.session_id).startsWith("evimed-replay-"));
  assert.ok(replays.length <= 3, "the cap bounds what one conversation costs");
});

test("learning paused: a failed commit is abandoned and not replayed into a paused account", options, async (t) => {
  const { userId, worker, overlay, stub, engineUser, researchMemory } = await fixture(t, { extract: () => "fail" });
  const session = "dsh-session_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, messages: [{ role: "user", parts: [{ type: "text", text: "something" }] }], archives: 0, commitCount: 0 });
  const committed = stub.commitSession(engineUser, session);
  await overlay.recordCommit({ userId, archiveUri: committed.archive_uri, engineSession: session, origin: "gateway", taskId: committed.task_id });
  await researchMemory.updateSettings(userId, { learningPaused: true });
  await worker.processCommits({ userId });
  await worker.processCommits({ userId });
  assert.equal((await overlay.commit(userId, committed.archive_uri)).state, "abandoned");
  assert.equal(stub.sent("POST", "/api/v1/sessions").filter((request) => String(request.body?.session_id).startsWith("evimed-replay-")).length, 0);
});

test("a source that changed is a label line on the memory that names it, removed when the state clears, and never a hidden memory", options, async (t) => {
  const { userId, worker, store, sessions, root, seed, overlay } = await fixture(t, {});
  const doi = "10.1056/nejmoa0000001";
  const uri = seed("project_facts/trial.md", `The trial reported a benefit (doi ${doi}).`, { type: "project_facts" });
  await overlay.upsertFile({ userId, uri, memoryType: "project_facts", body: `The trial reported a benefit (doi ${doi}).` });
  await overlay.setSources(userId, uri, [{ type: "doi", id: doi }]);
  assert.equal(await worker.labelSource(userId, { type: "doi", id: doi }, "retracted"), 1);
  const labelled = await sessions.read(userId, uri);
  assert.match(labelled, /> 来源变更：10\.1056\/nejmoa0000001 已撤稿/);
  assert.match(labelled, /The trial reported a benefit/, "the statement is still there");
  const records = await store.records(userId);
  const record = records.find((entry) => entry.uri === uri);
  assert.equal(record.relations.sources[0].state, "retracted");
  assert.match(record.value, /已撤稿/, "the label travels with the text; the record's relations carry the state");
  assert.equal(await worker.labelSource(userId, { type: "doi", id: doi }, "retracted"), 0, "the same state twice writes nothing");
  assert.equal(await worker.labelSource(userId, { type: "doi", id: doi }, "current"), 1);
  assert.equal(await sessions.read(userId, uri), `The trial reported a benefit (doi ${doi}).`);
  assert.ok(root.length > 0);
});

test("reset, a deleted project and an erased account take what the engine holds with them", options, async (t) => {
  const { userId, store, seed, sessions, overlay, stub, worker, engineUser } = await fixture(t);
  const keep = seed("preferences/keep.md", "Keeps.", { type: "preferences" });
  const projectFile = seed("projects/alpha.md", "# Alpha\n## 目标\n- one", { type: "project_context", tags: ["project=p_alpha"] });
  const otherProject = seed("project_facts/beta.md", "Beta fact.", { type: "project_facts", tags: ["project=p_beta"] });
  await overlay.recordCommit({ userId, archiveUri: `viking://user/${engineUser}/sessions/dsh-s1/history/archive_001`, engineSession: "dsh-s1", projectId: "p_alpha", origin: "gateway", state: "completed" });
  stub.files.set(`viking://user/${engineUser}/sessions/dsh-s1/history/archive_001/messages.jsonl`, "{}");
  stub.sessions.set(`${engineUser}/dsh-s1`, { id: "dsh-s1", user: engineUser, messages: [], archives: 1, commitCount: 1 });
  const deleted = await store.deleteProject(userId, "p_alpha");
  assert.equal(deleted.files, 1);
  assert.equal(await sessions.read(userId, projectFile), null);
  assert.ok(await sessions.read(userId, keep), "what is not the project's stays");
  assert.ok(await sessions.read(userId, otherProject), "another project's stays");
  assert.equal(stub.sessions.has(`${engineUser}/dsh-s1`), false, "the project's conversation is deleted in the engine");
  const reset = await store.reset(userId);
  assert.ok(reset.files >= 1);
  assert.equal(await sessions.read(userId, keep), null);
  assert.equal((await store.records(userId)).length, 0);
  await store.eraseAccount(userId);
  assert.equal(stub.users.has(engineUser), false);
  assert.equal((await overlay.account(userId)).registeredAt, null, "the registration is forgotten");
  assert.ok(worker);
});

test("the map's reader: the same records, sources and no sensitive file", options, async (t) => {
  const { userId, store, seed, overlay } = await fixture(t);
  const open = seed("preferences/a.md", "Open preference.", { type: "preferences" });
  const secret = seed("preferences/b.md", "Sensitive preference.", { type: "preferences" });
  await overlay.upsertFile({ userId, uri: secret, memoryType: "preferences", sensitive: true });
  await overlay.setSources(userId, open, [{ type: "doi", id: "10.1000/xyz123" }]);
  const map = await store.mapMemories(userId);
  assert.deepEqual(map.records.map((record) => record.uri), [open]);
  assert.equal(map.sources.length, 1);
  assert.equal(map.sources[0].recordId, map.records[0].id);
  assert.deepEqual(map.conflicts, []);
});

test("the person's own words win over their deletion: a line they say again, word for word, stays and leaves the rejection list", options, async (t) => {
  const { userId, store, worker, overlay, stub, engineUser, sessions, root, seed } = await fixture(t);
  seed("preferences/window.md", "Release window is Wednesday night.", { type: "preferences" });
  await store.remove(userId, nativeFileId(`${root}/preferences/window.md`), { keepText: false });
  assert.ok((await overlay.rejectedFingerprints(userId, "preferences")).has(lineFingerprint("Release window is Wednesday night.")));
  stub.extract = ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/window.md`, memory_type: "preferences", after: "Release window is Wednesday night." }] });
  const session = "dsh-session_9999999999999999999999999999999a";
  stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, archives: 0, commitCount: 0,
    messages: [{ role: "user", parts: [{ type: "text", text: "To be clear: Release window is Wednesday night. Please keep that." }] }] });
  stub.commitSession(engineUser, session);
  await worker.scanArchives(userId);
  await worker.processCommits({ userId });
  assert.equal(await sessions.read(userId, `${root}/preferences/window.md`), "Release window is Wednesday night.", "said again by the person: it stays");
  assert.ok(!(await overlay.rejectedFingerprints(userId, "preferences")).has(lineFingerprint("Release window is Wednesday night.")), "and is theirs again");
});

test("the project tab's card reads the labels of an English conversation as well as a Chinese one", options, async (t) => {
  const { userId, store, seed } = await fixture(t);
  seed("projects/billing.md", "# Billing pipeline\nField: data engineering\n\n## Goal\n- Zero missed runs\n## Scope\n- The nightly billing jobs\n## Materials and data\n- Cron jobs, Airflow\n## Decisions\n- Invoice export first\n## Stage\n- Waiting for the retry proposal\n## Constraints\n- End of the quarter\n## Study elements\n- Design: not a study", { type: "project_context", tags: ["project=p_bill"] });
  const card = await store.projectCard(userId, "p_bill");
  assert.deepEqual(card.map((entry) => entry.slot), ["field", "goal", "subject", "data_source", "stage", "constraints", "design"]);
  assert.equal(card.find((entry) => entry.slot === "field").text, "data engineering");
  assert.equal(card.find((entry) => entry.slot === "stage").text, "Waiting for the retry proposal");
});
