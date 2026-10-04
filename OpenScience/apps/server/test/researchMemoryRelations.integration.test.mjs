import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";

/**
 * Validity, replacement, conflict and source links in the PostgreSQL authority
 * (N13), against a real database: the migration on a database that already
 * holds rows, and what the term-matching arm of recall answers for each of the
 * cases the owner's plan names. The index arm is held to the same decision in
 * `memoryScopeTimeConflicts.test.mjs`.
 */
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const alpha = `memrel_alpha_${randomUUID()}`;
const beta = `memrel_beta_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let store;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
  await database.query(
    "INSERT INTO evimed_control.users(id,name,auth_type) SELECT id,'Memory owner','development' FROM unnest($1::text[]) AS id",
    [[alpha, beta]]);
  await migrateProductStore(database);
  store = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
});

// A test that fails halfway must not leave its rows for the next one to trip on.
beforeEach(async () => {
  if (!store) return;
  await store.purgeRecords(alpha);
  await store.purgeRecords(beta);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[alpha, beta]]);
  await database.close();
});

const day = (text) => Date.parse(`${text}T00:00:00Z`);
const SOURCE_A = `src_${"a".repeat(32)}`;
const SOURCE_B = `src_${"b".repeat(32)}`;

/** @param {Record<string, any>} overrides */
function fact(overrides = {}) {
  return {
    scope: "project", scopeId: "prj_a", kind: "project_fact", key: "project.dose.rivaroxaban",
    value: "rivaroxaban dose is 20 mg once daily", summary: "rivaroxaban dose", origin: "explicit", status: "active",
    confidence: 1, importance: 0.7, sensitive: false, ...overrides,
  };
}

/** One piece of conversation evidence, so a record is not "an inference with nothing behind it". */
const proof = (quote = "stated in the conversation") => ({ sourceType: "conversation_message", sourceRef: "sessions/ses_1/messages/1", quote });

/** What a recall in one project hands the model, by memory id. */
async function recalled(userId, query, scope = {}) {
  return store.relevant(userId, query, { projectId: "prj_a", ...scope });
}
const idsOf = (memos) => memos.map((memo) => memo.id.replace(/^record:/, ""));

test("the migration adds the interval and the relations in place and leaves every existing row valid", options, async () => {
  // A deployment that already holds memory has the table without the new
  // column and relations. Put this one back in that shape with a row in it,
  // then let a fresh process migrate it.
  const kept = await store.upsertRecord(alpha, fact({ key: "project.before.migration", value: "an old row", scope: "user", scopeId: "", kind: "profile" }));
  await database.query("DROP TABLE evimed_memory.record_conflicts");
  await database.query("DROP TABLE evimed_memory.record_sources");
  await database.query("DROP INDEX evimed_memory.memory_records_successor_idx");
  await database.query("ALTER TABLE evimed_memory.records DROP COLUMN valid_from");

  const restarted = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    const next = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database: restarted });
    const read = await next.getRecord(alpha, kept.id);
    assert.equal(read.value, "an old row");
    assert.equal(read.validFrom, null, "an existing row reads as valid with its start unknown");
    assert.equal(read.invalidSince, null);
    assert.equal(read.version, kept.version, "the migration rewrites no row");
    assert.deepEqual(await next.sourceLinks(alpha, kept.id), []);
    const tables = await restarted.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='evimed_memory' AND table_name IN ('record_conflicts','record_sources') ORDER BY 1`);
    assert.deepEqual(tables.rows.map((row) => row.table_name), ["record_conflicts", "record_sources"]);
  } finally {
    await restarted.close();
  }
  await store.deleteRecord(alpha, kept.id);
});

test("a fact's interval is stored, refused when empty, carried through an edit and put back by an undo", options, async () => {
  const created = await store.upsertRecord(alpha, fact({ key: "project.interval", validFrom: "2025-01-01T00:00:00Z", invalidSince: "2027-01-01T00:00:00Z" }));
  assert.equal(created.validFrom, "2025-01-01T00:00:00Z");
  assert.equal(created.invalidSince, "2027-01-01T00:00:00Z");
  await assert.rejects(() => store.upsertRecord(alpha, fact({ key: "project.empty", validFrom: "2027-01-01T00:00:00Z", invalidSince: "2025-01-01T00:00:00Z" })),
    { status: 400, code: "memory_payload_invalid" });

  // An edit that goes through the page carries the record back, interval included.
  const edited = await store.upsertRecord(alpha, { ...created, value: "a corrected value" }, null, { expectedVersion: created.version, by: "user", reason: "user updated" });
  assert.equal(edited.validFrom, created.validFrom);
  assert.equal(edited.version, created.version + 1);
  // The same interval is not a change: no version moves.
  const same = await store.upsertRecord(alpha, { ...edited }, null, { expectedVersion: edited.version });
  assert.equal(same.version, edited.version);

  // A change that moves the start, then an undo of the value change: the start the
  // revision recorded comes back with the text it belonged to.
  const moved = await store.upsertRecord(alpha, { ...edited, value: "another value", validFrom: "2025-06-01T00:00:00Z" }, null, { expectedVersion: edited.version, by: "user" });
  assert.equal(moved.validFrom, "2025-06-01T00:00:00Z");
  const undone = await store.undo(alpha, moved.id);
  assert.equal(undone.record.value, "a corrected value");
  assert.equal(undone.record.validFrom, "2025-01-01T00:00:00Z");
  assert.equal(undone.record.invalidSince, "2027-01-01T00:00:00Z", "an explicit end is not wiped by an undo");
  await store.deleteRecord(alpha, created.id);
});

// ----------------------------------------------------------------- changed fact

test("a changed fact answers for now with the new version and for the earlier time with the old one", options, async () => {
  const old = await store.upsertRecord(alpha, fact({ key: "project.dose.20", value: "rivaroxaban dose is 20 mg once daily", validFrom: "2025-01-01T00:00:00Z" }));
  const { record: replacement, superseded } = await store.supersede(alpha, old.id,
    fact({ key: "project.dose.15", value: "rivaroxaban dose is 15 mg once daily after the renal decline" }), null, { reason: "renal function declined", by: "user" });
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededBy, replacement.id);
  assert.ok(superseded.invalidSince, "the old fact says when it stopped holding");

  assert.deepEqual(idsOf(await recalled(alpha, "rivaroxaban dose")), [replacement.id], "now: only the replacement");
  const back = await recalled(alpha, "rivaroxaban dose", { asOf: day("2025-06-15") });
  assert.deepEqual(idsOf(back), [old.id], "an earlier time: the version that held then");
  assert.deepEqual(back[0].validity, { from: "2025-01-01T00:00:00Z", until: superseded.invalidSince });
  assert.equal(back[0].caveats, undefined);

  const before = await recalled(alpha, "rivaroxaban dose", { asOf: day("2024-06-15") });
  assert.deepEqual(before.map((memo) => [idsOf([memo])[0], memo.caveats]), [[old.id, ["not_yet_valid"]]],
    "before anything was stated: the earliest version, labelled, never the latest as if it had held then");
  await store.purgeRecords(alpha);
});

test("history never brings back what the researcher removed", options, async () => {
  const old = await store.upsertRecord(alpha, fact({ key: "project.dose.20", validFrom: "2025-01-01T00:00:00Z" }));
  const { record: replacement } = await store.supersede(alpha, old.id, fact({ key: "project.dose.15", value: "rivaroxaban dose is 15 mg once daily" }));
  assert.deepEqual(idsOf(await recalled(alpha, "rivaroxaban dose", { asOf: day("2025-06-15") })), [old.id]);
  // The researcher forgets the old version: it is archived, and history does not offer it again.
  const current = await store.getRecord(alpha, old.id);
  await store.upsertRecord(alpha, { ...current, status: "archived" }, null, { expectedVersion: current.version, by: "user", reason: "forgotten" });
  const asked = await recalled(alpha, "rivaroxaban dose", { asOf: day("2025-06-15") });
  assert.equal(idsOf(asked).includes(old.id), false, "the removed version is not offered for the time it held");
  assert.deepEqual(asked.map((memo) => [idsOf([memo])[0], memo.caveats]), [[replacement.id, ["not_yet_valid"]]],
    "all that is left is the replacement, which begins after the time asked, and says so");
  assert.deepEqual(idsOf(await recalled(alpha, "rivaroxaban dose")), [replacement.id]);
  // And what is marked sensitive after the fact is not offered either.
  const live = await store.getRecord(alpha, replacement.id);
  await store.upsertRecord(alpha, { ...live, sensitive: true }, null, { expectedVersion: live.version });
  assert.deepEqual(idsOf(await recalled(alpha, "rivaroxaban dose")), []);
  await store.purgeRecords(alpha);
});

// ---------------------------------------------------------------- cross-project

test("another project's facts are not the answer, and the account-level default yields to the project's own", options, async () => {
  const a = await store.upsertRecord(alpha, fact({ key: "decision.comparator", kind: "decision", value: "comparator is placebo in this trial", scopeId: "prj_a" }));
  const b = await store.upsertRecord(alpha, fact({ key: "decision.comparator", kind: "decision", value: "comparator is active control in this trial", scopeId: "prj_b" }));
  const account = await store.upsertRecord(alpha, fact({ key: "decision.comparator", kind: "decision", scope: "user", scopeId: "", value: "comparator default is placebo in a trial" }));
  assert.deepEqual(idsOf(await recalled(alpha, "comparator trial")), [a.id], "project A: its own value, not B's and not the default");
  assert.deepEqual(idsOf(await recalled(alpha, "comparator trial", { projectId: "prj_b" })), [b.id]);
  assert.deepEqual(idsOf(await recalled(alpha, "comparator trial", { projectId: "prj_c" })), [account.id],
    "a project with no value of its own gets the account's, and nothing of A or B");
  assert.deepEqual(idsOf(await recalled(alpha, "comparator trial", { projectId: null })), [account.id]);
  await store.purgeRecords(alpha);
});

// ------------------------------------------------------------ conflicting statements

test("two statements that disagree stay in force, each labelled with the other, until one replaces it", options, async () => {
  const said = await store.upsertRecord(alpha, fact({ key: "project.dose.said", value: "the researcher states the rivaroxaban dose is 10 mg", summary: "10 mg" }), proof());
  const label = await store.upsertRecord(alpha, fact({ key: "project.dose.label", value: "the label states the rivaroxaban dose is 20 mg", origin: "system", summary: "20 mg" }), proof("label text"));
  const marked = await store.markConflict(alpha, label.id, said.id, { reason: "label and researcher differ" });
  assert.deepEqual([marked.created, marked.state], [true, "open"]);
  assert.deepEqual((await store.markConflict(alpha, said.id, label.id)).created, false, "the same pair in either order is one conflict");

  const both = await recalled(alpha, "rivaroxaban dose");
  assert.deepEqual(new Set(idsOf(both)), new Set([said.id, label.id]), "both are served");
  for (const memo of both) {
    assert.deepEqual(memo.caveats, ["conflict"]);
    assert.equal(memo.conflictsWith.length, 1);
  }
  assert.equal(both.find((memo) => memo.id === `record:${said.id}`).conflictsWith[0].id, label.id);

  const settled = await store.resolveConflict(alpha, said.id, label.id, { reason: "the researcher's dose is the one in use" });
  assert.equal(settled.superseded.status, "superseded");
  assert.equal(settled.superseded.supersededBy, said.id);
  const after = await recalled(alpha, "rivaroxaban dose");
  assert.deepEqual(idsOf(after), [said.id]);
  assert.equal(after[0].caveats, undefined, "a settled disagreement leaves no label");
  assert.equal(after[0].conflictsWith, undefined);
  await assert.rejects(() => store.resolveConflict(alpha, said.id, label.id), { status: 404, code: "memory_conflict_not_found" });
  await store.purgeRecords(alpha);
});

test("a statement that is forgotten, replaced or deleted is no longer one side of a conflict", options, async () => {
  const a = await store.upsertRecord(alpha, fact({ key: "project.a", value: "rivaroxaban statement a" }), proof());
  const b = await store.upsertRecord(alpha, fact({ key: "project.b", value: "rivaroxaban statement b" }), proof());
  const c = await store.upsertRecord(alpha, fact({ key: "project.c", value: "rivaroxaban statement c" }), proof());
  await store.markConflict(alpha, a.id, b.id);
  await store.markConflict(alpha, a.id, c.id);
  assert.deepEqual((await recalled(alpha, "rivaroxaban statement")).find((memo) => memo.id === `record:${a.id}`).conflictsWith.map((other) => other.id).sort(), [b.id, c.id].sort());

  // b is forgotten: archived, and out of the conflict without a word from anyone.
  const current = await store.getRecord(alpha, b.id);
  await store.upsertRecord(alpha, { ...current, status: "archived" }, null, { expectedVersion: current.version, by: "user" });
  const afterForget = await recalled(alpha, "rivaroxaban statement");
  assert.deepEqual(afterForget.find((memo) => memo.id === `record:${a.id}`).conflictsWith.map((other) => other.id), [c.id]);
  // c is deleted: its relation goes with it.
  await store.deleteRecord(alpha, c.id);
  const afterDelete = await recalled(alpha, "rivaroxaban statement");
  assert.equal(afterDelete.find((memo) => memo.id === `record:${a.id}`).caveats, undefined);
  const left = await database.query("SELECT count(*)::int AS n FROM evimed_memory.record_conflicts WHERE user_id=$1", [alpha]);
  assert.equal(left.rows[0].n, 1, "only the pair with the archived record remains, as history");
  // A replaced or archived memory cannot be put into a new conflict.
  await assert.rejects(() => store.markConflict(alpha, a.id, b.id), { status: 409, code: "memory_conflict_invalid" });
  await assert.rejects(() => store.markConflict(alpha, a.id, a.id), { status: 400, code: "memory_conflict_invalid" });
  await store.purgeRecords(alpha);
});

test("undoing the replacement that settled a disagreement puts the disagreement back with the fact it had retired", options, async () => {
  const setup = async (suffix) => {
    const a = await store.upsertRecord(alpha, fact({ key: `project.a${suffix}`, value: `rivaroxaban statement a${suffix}` }), proof());
    const b = await store.upsertRecord(alpha, fact({ key: `project.b${suffix}`, value: `rivaroxaban statement b${suffix}` }), proof());
    await store.markConflict(alpha, a.id, b.id);
    const { record: replacement } = await store.supersede(alpha, a.id, fact({ key: `project.n${suffix}`, value: `rivaroxaban newer statement ${suffix}` }), proof("newer"));
    return { a, b, replacement };
  };
  const labelOf = async (id, suffix) => (await recalled(alpha, `rivaroxaban statement ${suffix}`)).find((memo) => memo.id === `record:${id}`)?.caveats;

  // 1. The replacement is undone as a creation: it is removed and the old statement is back.
  const first = await setup("1");
  assert.equal(await labelOf(first.b.id, "b1"), undefined, "while the replacement stands, the old statement is gone and so is its disagreement");
  const removed = await store.undo(alpha, first.replacement.id);
  assert.equal(removed.undone, "removed");
  assert.equal(removed.restored[0].id, first.a.id);
  assert.deepEqual(await labelOf(first.b.id, "b1"), ["conflict"], "the disagreement it had settled is open again");
  assert.deepEqual(await labelOf(first.a.id, "a1"), ["conflict"]);

  // 2. The retired statement itself is undone back into force while its replacement stays.
  const second = await setup("2");
  const retired = await store.getRecord(alpha, second.a.id);
  assert.equal(retired.status, "superseded");
  const restored = await store.undo(alpha, second.a.id);
  assert.equal(restored.record.status, "active");
  assert.deepEqual(await labelOf(second.b.id, "b2"), ["conflict"]);
  // Only what that replacement settled is reopened: a pair settled by the researcher stays settled.
  const third = await setup("3");
  const c = await store.upsertRecord(alpha, fact({ key: "project.c3", value: "rivaroxaban statement c3" }), proof());
  await store.markConflict(alpha, third.b.id, c.id);
  await store.resolveConflict(alpha, c.id, third.b.id, { reason: "the researcher chose c" });
  await store.undo(alpha, third.replacement.id);
  assert.equal(await labelOf(c.id, "c3"), undefined, "a disagreement the researcher settled is not reopened by an unrelated undo");
});

test("an inference does not settle which of two statements is right", options, async () => {
  const a = await store.upsertRecord(alpha, fact({ key: "project.a", value: "rivaroxaban a" }), proof());
  const b = await store.upsertRecord(alpha, fact({ key: "project.b", value: "rivaroxaban b" }), proof());
  await store.markConflict(alpha, a.id, b.id);
  await assert.rejects(() => store.resolveConflict(alpha, a.id, b.id, { by: "extraction" }), { status: 400, code: "memory_conflict_invalid" });
  assert.equal((await store.getRecord(alpha, b.id)).status, "active", "nothing was retired");
});

test("a pair is ordered the same way whatever the database's locale sorts first", options, async () => {
  // In an en_US database "alpha1" sorts before "Bravo"; by code point it is the other way round.
  const upper = await store.upsertRecord(alpha, fact({ id: "Bravo", key: "project.upper", value: "rivaroxaban upper" }), proof());
  const lower = await store.upsertRecord(alpha, fact({ id: "alpha1", key: "project.lower", value: "rivaroxaban lower" }), proof());
  assert.deepEqual([upper.id, lower.id], ["Bravo", "alpha1"]);
  const marked = await store.markConflict(alpha, "alpha1", "Bravo");
  assert.deepEqual([marked.recordId, marked.otherId], ["Bravo", "alpha1"]);
  assert.equal((await store.markConflict(alpha, "Bravo", "alpha1")).created, false);
  const labelled = await recalled(alpha, "rivaroxaban");
  assert.deepEqual(labelled.map((memo) => memo.caveats), [["conflict"], ["conflict"]]);
});

test("a conflict is one account's: another account's record cannot be named, and nothing crosses", options, async () => {
  const mine = await store.upsertRecord(alpha, fact({ key: "project.mine", value: "rivaroxaban mine" }));
  const theirs = await store.upsertRecord(beta, fact({ key: "project.theirs", value: "rivaroxaban theirs" }));
  await assert.rejects(() => store.markConflict(alpha, mine.id, theirs.id), { status: 404, code: "memory_not_found" });
  await assert.rejects(() => store.resolveConflict(alpha, mine.id, theirs.id), { status: 404 });
  await store.purgeRecords(alpha);
  await store.purgeRecords(beta);
});

// ------------------------------------------------------- sources and their states

test("a memory records the sources it rests on by identifier, and a finding about a source labels it", options, async () => {
  const resting = await store.upsertRecord(alpha, fact({ key: "project.cites", value: "rivaroxaban reduces stroke risk in the trial" }), null, {
    sourceLinks: [{ type: "knowledge_source", id: SOURCE_A, version: "sha256:v1" }, { type: "doi", id: "https://doi.org/10.1000/Retracted.1" }],
  });
  const independent = await store.upsertRecord(alpha, fact({ key: "project.independent", value: "rivaroxaban independent statement" }));
  assert.deepEqual((await store.sourceLinks(alpha, resting.id)).map((link) => [link.type, link.id, link.version, link.state]), [
    ["doi", "10.1000/retracted.1", null, "current"],
    ["knowledge_source", SOURCE_A, "sha256:v1", "current"],
  ], "a DOI is recorded in the one form it is compared in, and an unknown version is recorded as unknown");
  assert.equal((await recalled(alpha, "rivaroxaban")).every((memo) => memo.caveats === undefined), true, "nothing is wrong yet");

  // Found by the recorded identifier, never by what a memory says.
  assert.deepEqual((await store.dependentsOfSource(alpha, { type: "knowledge_source", id: SOURCE_A })).map((row) => row.recordId), [resting.id]);
  assert.deepEqual(await store.dependentsOfSource(alpha, { type: "knowledge_source", id: SOURCE_B }), []);
  assert.deepEqual(await store.dependentsOfSource(beta, { type: "knowledge_source", id: SOURCE_A }), [], "one account's links are not another's");

  const marked = await store.markSourceLinks(alpha, { type: "doi", id: "10.1000/retracted.1" }, { state: "retracted", reason: "retraction notice" });
  assert.deepEqual(marked.recordIds, [resting.id]);
  const labelled = await recalled(alpha, "rivaroxaban");
  assert.deepEqual(labelled.find((memo) => memo.id === `record:${resting.id}`).caveats, ["source_retracted"]);
  assert.deepEqual(labelled.find((memo) => memo.id === `record:${resting.id}`).staleSources, [{ type: "doi", id: "10.1000/retracted.1", state: "retracted" }]);
  assert.equal(labelled.find((memo) => memo.id === `record:${independent.id}`).caveats, undefined, "a memory that rests on nothing is not touched");
  assert.equal((await store.getRecord(alpha, resting.id)).version, resting.version, "labelling a link moves no version and withholds nothing");

  // A check that could not answer is recorded as unknown, which is not clean and not a finding.
  await store.markSourceLinks(alpha, { type: "doi", id: "10.1000/retracted.1" }, { state: "unknown", reason: "lookup timed out" });
  assert.equal((await recalled(alpha, "rivaroxaban")).find((memo) => memo.id === `record:${resting.id}`).caveats, undefined);
  assert.equal((await store.sourceLinks(alpha, resting.id)).find((link) => link.type === "doi").state, "unknown");
  await assert.rejects(() => store.markSourceLinks(alpha, { type: "doi", id: "10.1000/x" }, { state: "falsified" }), { status: 400 });
  await assert.rejects(() => store.markSourceLinks(alpha, { type: "knowledge_source", id: "src_not_an_id" }, { state: "changed" }), { status: 400 });
  await store.purgeRecords(alpha);
});

test("a link names a source we can find again or it is refused; a re-read of a changed source starts it over", options, async () => {
  await assert.rejects(() => store.upsertRecord(alpha, fact({ key: "project.bad" }), null, { sourceLinks: [{ type: "knowledge_source", id: "report.pdf" }] }),
    { status: 400, code: "memory_payload_invalid" });
  await assert.rejects(() => store.upsertRecord(alpha, fact({ key: "project.bad2" }), null, { sourceLinks: [{ type: "url", id: "https://example.org" }] }),
    { status: 400, code: "memory_payload_invalid" });
  assert.equal((await store.listRecords(alpha, {})).length, 0, "a refused write leaves no record behind");

  const resting = await store.upsertRecord(alpha, fact({ key: "project.resting", value: "rivaroxaban rests on a document" }), null,
    { sourceLinks: [{ type: "knowledge_source", id: SOURCE_A, version: "v1" }] });
  await store.markSourceLinks(alpha, { type: "knowledge_source", id: SOURCE_A }, { state: "changed", reason: "the file was revised" });
  // Naming the same source at the same version again changes nothing.
  await store.upsertRecord(alpha, { ...resting }, null, { sourceLinks: [{ type: "knowledge_source", id: SOURCE_A, version: "v1" }] });
  assert.equal((await store.sourceLinks(alpha, resting.id))[0].state, "changed");
  // The memory is re-read from the revised file: the link is current again, at the new version.
  await store.upsertRecord(alpha, { ...resting }, null, { sourceLinks: [{ type: "knowledge_source", id: SOURCE_A, version: "v2" }] });
  const [link] = await store.sourceLinks(alpha, resting.id);
  assert.deepEqual([link.state, link.version, link.stateReason], ["current", "v2", ""]);
  await store.purgeRecords(alpha);
});

test("a replaced fact keeps its links and its history; the replacement carries its own", options, async () => {
  const old = await store.upsertRecord(alpha, fact({ key: "project.old", value: "rivaroxaban old finding" }), null,
    { sourceLinks: [{ type: "knowledge_source", id: SOURCE_A, version: "v1" }] });
  const { record, superseded } = await store.supersede(alpha, old.id, fact({ key: "project.new", value: "rivaroxaban revised finding" }), null,
    { sourceLinks: [{ type: "knowledge_source", id: SOURCE_A, version: "v2" }] });
  assert.equal(superseded.value, "rivaroxaban old finding", "the old value is kept");
  assert.deepEqual((await store.sourceLinks(alpha, old.id)).map((link) => link.version), ["v1"]);
  assert.deepEqual((await store.sourceLinks(alpha, record.id)).map((link) => link.version), ["v2"]);
  const dependents = await store.dependentsOfSource(alpha, { type: "knowledge_source", id: SOURCE_A });
  assert.deepEqual(dependents.map((row) => [row.recordId, row.status, row.recordVersion, row.sourceVersion]).sort(),
    [[old.id, "superseded", 2, "v1"], [record.id, "active", 1, "v2"]].sort(), "history is returned, tagged, for the caller to weigh");
  await store.purgeRecords(alpha);
});

test("a memory carries at most sixteen links and the memory is unaffected by the rest", options, async () => {
  const many = Array.from({ length: 16 }, (_, index) => ({ type: "doi", id: `10.1000/many.${index}` }));
  const resting = await store.upsertRecord(alpha, fact({ key: "project.many" }), null, { sourceLinks: many });
  assert.equal((await store.sourceLinks(alpha, resting.id)).length, 16);
  await store.upsertRecord(alpha, { ...resting }, null, { sourceLinks: [{ type: "doi", id: "10.1000/seventeenth" }] });
  assert.equal((await store.sourceLinks(alpha, resting.id)).length, 16, "a link past the bound is not recorded");
  await assert.rejects(() => store.upsertRecord(alpha, fact({ key: "project.toomany" }), null,
    { sourceLinks: Array.from({ length: 17 }, (_, index) => ({ type: "doi", id: `10.1000/x.${index}` })) }), { status: 400 });
  await store.purgeRecords(alpha);
});

// -------------------------------------------------------------- lifecycle and export

test("deleting a project, a record or an account takes its relations with it, and the export carries them", options, async () => {
  const a = await store.upsertRecord(alpha, fact({ key: "project.a", value: "rivaroxaban a", scopeId: "prj_gone" }), null, { sourceLinks: [{ type: "doi", id: "10.1000/a" }] });
  const b = await store.upsertRecord(alpha, fact({ key: "project.b", value: "rivaroxaban b", scopeId: "prj_gone" }));
  await store.markConflict(alpha, a.id, b.id);
  const exported = await store.exportUserMemory(alpha);
  assert.equal(exported.links.conflicts.length, 1);
  assert.deepEqual(exported.links.conflicts[0], { ...exported.links.conflicts[0], recordId: [a.id, b.id].sort()[0], otherId: [a.id, b.id].sort()[1], state: "open" });
  assert.deepEqual(exported.links.sources.map((link) => [link.recordId, link.id]), [[a.id, "10.1000/a"]]);

  await store.deleteProjectMemory(alpha, "prj_gone");
  const left = await database.query(`SELECT
    (SELECT count(*)::int FROM evimed_memory.record_conflicts WHERE user_id=$1) AS conflicts,
    (SELECT count(*)::int FROM evimed_memory.record_sources WHERE user_id=$1) AS sources`, [alpha]);
  assert.deepEqual(left.rows[0], { conflicts: 0, sources: 0 });

  const c = await store.upsertRecord(beta, fact({ key: "project.c", value: "rivaroxaban c" }), null, { sourceLinks: [{ type: "doi", id: "10.1000/c" }] });
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [beta]);
  const cascaded = await database.query("SELECT count(*)::int AS n FROM evimed_memory.record_sources WHERE user_id=$1", [beta]);
  assert.equal(cascaded.rows[0].n, 0, `deleting the account deletes what its memory rested on (${c.id})`);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Memory owner','development')", [beta]);
});
