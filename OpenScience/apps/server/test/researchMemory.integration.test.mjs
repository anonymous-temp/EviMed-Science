import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateNotifications } from "../src/notificationPersistence.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { relationalIntegrity } from "../src/relationalIntegrity.mjs";

/**
 * The research-memory store against a real PostgreSQL.
 *
 * These are the behavioural assertions the retired REST adapter's test held —
 * isolation, compare-and-swap, evidence bounds, export, purge, project deletion
 * and recall — carried over to the store that replaced it, plus the two things
 * only a database can settle: that two writers racing on one canonical key
 * still leave one row, and that deleting an account deletes its memory.
 */
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const alpha = `memory_alpha_${randomUUID()}`;
const beta = `memory_beta_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let store;

/** @param {string[]} ids */
async function createUsers(ids) {
  await database.query(
    "INSERT INTO evimed_control.users(id,name,auth_type) SELECT id,'Memory owner','development' FROM unnest($1::text[]) AS id",
    [ids]);
}

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
  await createUsers([alpha, beta]);
  store = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[alpha, beta]]);
  await database.close();
});

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** @param {Record<string, any>} overrides */
function record(overrides = {}) {
  return {
    scope: "user",
    kind: "preference",
    key: "response.evidence_depth",
    value: "Prefer primary evidence and explicit uncertainty.",
    summary: "Primary evidence first.",
    origin: "inferred",
    status: "pending",
    confidence: 0.7,
    importance: 0.9,
    sensitive: false,
    ...overrides,
  };
}

test("the store answers for a configured database and reports second-precision timestamps", options, async () => {
  assert.equal(store.configured, true);
  assert.deepEqual(await store.status(), { configured: true, connected: true, code: null, structured: true });
  const stored = await store.upsertRecord(alpha, record({ key: "profile.role", value: "Clinical pharmacist" }));
  assert.match(stored.createdAt, instant);
  assert.match(stored.updatedAt, instant);
  assert.equal(stored.version, 1);
  assert.equal(stored.scopeId, "");
  assert.equal(stored.evidenceCount, 0);
  assert.deepEqual(stored.revisions, []);
  assert.deepEqual(await store.getRecord(alpha, stored.id), stored);
  await store.deleteRecord(alpha, stored.id);
});

// Ownership used to be a hidden tag inside the note text, and a tag is data:
// anyone could compute another account's digest and paste it into their own
// note, which then appeared in the victim's list, export and recall. It is a
// column now, so the attack is not mitigated, it is unrepresentable.
test("one account's memory is invisible to another, whatever its text claims", options, async () => {
  const victimDigest = "a".repeat(24);
  const injected = await store.create(alpha, `harmless looking note #evimed-user-${victimDigest} #药物安全`);
  assert.doesNotMatch(injected.content, /^#evimed-user-/m);
  assert.deepEqual(injected.tags, ["药物安全"], "the internal tag is never returned");
  const mine = await store.create(beta, "beta's own note");

  assert.deepEqual((await store.list(beta)).map((note) => note.id), [mine.id]);
  assert.equal((await store.exportUserMemory(beta)).manualMemos.length, 1);
  assert.deepEqual((await store.relevant(beta, "harmless looking note")).map((memo) => memo.id), [mine.id],
    "a note naming another account's digest never reaches that account's prompt");

  await assert.rejects(() => store.update(beta, injected.id, { pinned: true }),
    (error) => error?.status === 404 && error?.code === "memory_not_found");
  await assert.rejects(() => store.delete(beta, injected.id), { code: "memory_not_found" });

  const record1 = await store.upsertRecord(alpha, record({ key: "profile.role", value: "Alpha's role" }));
  await assert.rejects(() => store.getRecord(beta, record1.id), { status: 404, code: "memory_not_found" });
  await assert.rejects(() => store.deleteRecord(beta, record1.id), { status: 404, code: "memory_not_found" });
  await assert.rejects(() => store.getRecord(alpha, "not a valid id"), { status: 400, code: "memory_id_invalid" });

  await store.purgeUserMemory(alpha);
  await store.purgeUserMemory(beta);
});

test("run summaries belong to the timeline and are never recalled; the project's facts are, when they match", options, async () => {
  // A run summary held the platform's own earlier answer and was recalled as
  // if it were memory about the researcher (2026-09-19 proposal §4.1). The
  // project dossier — facts, analyses, decisions — is what a later question in
  // the same project draws on, and only when it matches.
  const projectId = "project-recall";
  const summary = (key, question) => store.upsertRecord(alpha, {
    scope: "project", scopeId: projectId, kind: "run_summary", key,
    value: JSON.stringify({ runId: key, question, answer: `关于${question}的长篇回答` }),
    summary: question, origin: "system", status: "active", confidence: 1, importance: 0.7, sensitive: false,
  });
  await summary("run.metformin", "二甲双胍的作用机制是什么");
  await summary("run.rituximab", "利妥昔单抗的感染风险");
  await store.upsertRecord(alpha, {
    scope: "project", scopeId: projectId, kind: "project_fact", key: "project.metformin.cohort",
    value: "二甲双胍队列纳入 500 人", summary: "二甲双胍队列规模", origin: "explicit", status: "active",
    confidence: 1, importance: 0.6, sensitive: false,
  });
  await store.upsertRecord(alpha, record({
    kind: "preference", key: "pref.language", value: "回答请用中文", summary: "回答请用中文",
    origin: "explicit", status: "active", confidence: 1, importance: 0.6,
  }));

  const greeting = await store.relevant(alpha, "hello", { projectId });
  assert.deepEqual(greeting.map((memo) => memo.kind), ["preference"]);
  const onTopic = await store.relevant(alpha, "二甲双胍还有哪些副作用", { projectId });
  assert.deepEqual(onTopic.map((memo) => memo.kind).sort(), ["preference", "project_fact"],
    "a question that names the drug reaches the project's fact about it, and never an earlier answer");
  // Scope is a permission: another project never sees these.
  assert.deepEqual((await store.relevant(alpha, "二甲双胍还有哪些副作用", { projectId: "other-project" }))
    .map((memo) => memo.kind), ["preference"]);
  // And a run summary is not counted as memory in force.
  const profile = await store.profile(alpha, { projectId });
  assert.equal(profile.activeCount, 2);
  assert.equal(profile.episodeCount, 2);
  await store.purgeUserMemory(alpha);
});

test("the long-term profile survives a store full of run summaries", options, async () => {
  const projectId = "project-crowding";
  // One record per run, and a failed run outranks a preference on importance,
  // so a single ordered page eventually contains nothing but episodes.
  for (let index = 0; index < 120; index += 1) {
    await store.upsertRecord(alpha, {
      scope: "project", scopeId: projectId, kind: "run_summary", key: `run.${index}`,
      value: JSON.stringify({ runId: `run-${index}`, question: `问题 ${index}`, answer: `回答 ${index}` }),
      summary: `Conversation about: 问题 ${index}`, origin: "system", status: "active",
      confidence: 1, importance: 0.7, sensitive: false,
    });
  }
  await store.upsertRecord(alpha, record({
    kind: "profile", key: "profile.role", value: "临床药师，主要做药物评价", summary: "临床药师，主要做药物评价",
    origin: "explicit", status: "active", confidence: 1, importance: 0.6,
  }));
  const recalled = await store.relevant(alpha, "hello", { projectId });
  assert.ok(recalled.some((memo) => memo.kind === "profile"),
    "the profile must stay reachable however many runs have accumulated");
  assert.equal((await store.listRecords(alpha, { pageSize: 500 })).length, 100, "a page is capped at 100");
  assert.equal((await store.listAllRecords(alpha)).length, 121, "and an export is not a page");
  await store.purgeUserMemory(alpha);
});

test("a stale version is a conflict, and a real change writes a revision", options, async () => {
  const first = await store.upsertRecord(alpha, record(), {
    sourceType: "conversation_message", sourceRef: "sessions/s1/messages/m1",
    quote: "优先给原始证据，并明确保留不确定性。", observedAt: "2026-09-11T06:51:44.900Z", weight: 1,
  });
  assert.equal(first.version, 1);
  assert.equal(first.evidenceCount, 1);
  assert.equal(first.evidence[0].observedAt, "2026-09-11T06:51:44Z", "evidence time round-trips at second precision");
  assert.equal(first.evidence[0].fingerprint.length, 32);

  const confirmed = await store.upsertRecord(alpha, record({ id: first.id, status: "active", origin: "explicit", confidence: 1 }),
    null, { expectedVersion: first.version, reason: "the researcher confirmed this memory" });
  assert.equal(confirmed.id, first.id, "the canonical key owns the identity, so the id never changes");
  assert.equal(confirmed.version, 2);
  assert.deepEqual(confirmed.revisions.map((revision) => [revision.version, revision.status]), [[1, "pending"]]);
  assert.equal(confirmed.revisions[0].reason, "the researcher confirmed this memory");
  assert.match(confirmed.revisions[0].changedAt, instant);

  await assert.rejects(() => store.upsertRecord(alpha, record({ value: "something else" }), null,
    { expectedVersion: first.version }),
  (error) => error?.status === 409 && error?.code === "memory_conflict");
  // A new canonical key carrying an id that already names another of this
  // user's memories is refused, never resurrected into the other row: the id is
  // in a feedback ledger and in a recall index, so handing it to a second
  // memory would silently rewrite the first one's provenance.
  await assert.rejects(() => store.upsertRecord(alpha, record({ key: "response.other_depth", id: first.id })),
    (error) => error?.status === 409 && error?.code === "memory_conflict");
  assert.equal((await store.getRecord(alpha, first.id)).key, record().key, "and the memory that owns the id is untouched");
  // Version zero means an unconditional write, which is what the extractor
  // sends when it has never seen the record before.
  const unconditional = await store.upsertRecord(alpha, record({ value: "rewritten without a version" }));
  assert.equal(unconditional.version, 3);
  assert.equal(unconditional.evidenceCount, 1, "evidence survives a write that does not carry any");
  await store.purgeUserMemory(alpha);
});

test("a write that changes nothing moves neither the version nor the timestamp", options, async () => {
  const first = await store.upsertRecord(alpha, record({ lastConfirmedAt: "2026-09-11T06:51:44.900Z" }));
  // Pin the row into the past so a no-op is distinguishable from a rewrite that
  // happens to land in the same second.
  await database.query("UPDATE evimed_memory.records SET updated_at='2026-01-01T00:00:00Z' WHERE user_id=$1 AND id=$2",
    [alpha, first.id]);
  const again = await store.upsertRecord(alpha, record({ lastConfirmedAt: "2026-09-11T06:51:44.000Z" }));
  assert.equal(again.version, 1);
  assert.equal(again.updatedAt, "2026-01-01T00:00:00Z");
  assert.equal(again.lastConfirmedAt, "2026-09-11T06:51:44Z");

  // The same write with one field moved is not a no-op.
  const moved = await store.upsertRecord(alpha, record({ importance: 0.5 }));
  assert.equal(moved.version, 2);
  assert.notEqual(moved.updatedAt, "2026-01-01T00:00:00Z");
  await store.purgeUserMemory(alpha);
});

// `now()` is the transaction's start time, and this transaction starts before
// it queues for the row it is about to write. A write that waited would then
// stamp itself with the moment it began waiting, and `updated_at` — which
// orders the list and, through it, recall — could move backwards against a
// write that started later and got the lock first.
test("a write that waited for a lock is stamped when it happened, not when it queued", options, async () => {
  const first = await store.upsertRecord(alpha, record({ key: "clock.stamp" }));
  /** @type {() => void} */ let held = () => {};
  const locked = new Promise((resolve) => { held = () => resolve(null); });
  const holder = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT * FROM evimed_memory.records WHERE user_id=$1 AND id=$2 FOR UPDATE", [alpha, first.id]);
    held();
    await client.query("SELECT pg_sleep(2)");
  });
  await locked;
  const queuedAt = Date.now();
  const updated = await store.upsertRecord(alpha, record({ key: "clock.stamp", value: "written after the wait" }));
  await holder;

  assert.ok(Date.now() - queuedAt >= 1_000, "the write really did queue behind the row lock");
  assert.ok(Date.parse(updated.updatedAt) >= queuedAt + 1_000,
    `the stamp ${updated.updatedAt} must be the moment of the write, not of its transaction's start`);
  assert.equal(updated.revisions.at(-1).changedAt, updated.updatedAt,
    "and the clock is read once, so the revision and the row cannot disagree");
  await store.purgeUserMemory(alpha);
});

// The retired service serialised writes with a process-wide mutex, which is
// exactly as much as a single process can promise. A web tier runs several, so
// the guarantee has to come from the database.
test("concurrent upserts of one canonical key leave one row", options, async () => {
  const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => store.upsertRecord(alpha, record({
    value: `concurrent value ${index}`,
  }), {
    sourceType: "conversation_message", sourceRef: `sessions/s/messages/${index}`, quote: `quote ${index}`,
    observedAt: "2026-09-11T06:51:44Z",
  })));
  const ids = new Set(writes.map((row) => row.id));
  assert.equal(ids.size, 1, "every writer converged on one record");
  const all = await store.listAllRecords(alpha, { kinds: ["preference"] });
  assert.equal(all.length, 1);
  assert.equal(all[0].version, 8, "and every write is accounted for, none lost");
  assert.equal(all[0].evidenceCount, 8);
  assert.equal(all[0].revisions.length, 7, "each value change left its predecessor in the history");
  await store.purgeUserMemory(alpha);
});

test("evidence is bounded, deduplicated and capped at sixty-four entries", options, async () => {
  const evidence = (index) => ({
    sourceType: "conversation_message", sourceRef: `sessions/s/messages/${index}`,
    quote: `证据引语 ${index}`, observedAt: "2026-09-11T06:51:44Z", weight: 1,
  });
  let stored = await store.upsertRecord(alpha, record({ status: "active" }), evidence(0));
  assert.equal(stored.evidenceCount, 1);
  stored = await store.upsertRecord(alpha, record({ status: "active" }), evidence(0));
  assert.equal(stored.evidenceCount, 1, "the same quote observed again adds nothing");
  assert.equal(stored.version, 1, "and a repeat observation is a no-op, not a new version");

  for (let index = 1; index < 70; index += 1) {
    stored = await store.upsertRecord(alpha, record({ status: "active" }), evidence(index));
  }
  assert.equal(stored.evidenceCount, 64);
  assert.equal(stored.evidence.at(-1).quote, "证据引语 69", "evidence stays oldest to newest for the UI");
  assert.equal(stored.evidence[0].quote, "证据引语 6");

  // An over-long quote is trimmed rather than refused, and an empty required
  // field drops the evidence while the record itself is still written.
  const trimmed = await store.upsertRecord(alpha, record({ key: "pref.long", status: "active" }), {
    sourceType: "conversation_message", sourceRef: "sessions/s/messages/long", quote: "证据引语。".repeat(2_000),
  });
  assert.equal(trimmed.evidence[0].quote.length, 4_000);
  const unevidenced = await store.upsertRecord(alpha, record({ key: "pref.empty", status: "active" }), {
    sourceType: "conversation_message", sourceRef: "sessions/s/messages/empty", quote: "   ",
  });
  assert.equal(unevidenced.evidenceCount, 0);
  assert.equal(unevidenced.value, record().value, "the record survives evidence that could not be attached");
  await store.purgeUserMemory(alpha);
});

test("listing filters, orders and searches without crossing accounts", options, async () => {
  await store.upsertRecord(alpha, record({ key: "profile.role", kind: "profile", status: "active", importance: 0.9, confidence: 1 }));
  await store.upsertRecord(alpha, record({ key: "pref.language", value: "回答请用中文", status: "active", importance: 0.5, confidence: 0.9 }));
  await store.upsertRecord(alpha, record({
    scope: "project", scopeId: "study-one", kind: "project_fact", key: "fact.cohort",
    value: "The cohort is 240 patients.", status: "archived", importance: 0.5, confidence: 0.4,
  }));
  await store.upsertRecord(beta, record({ key: "profile.role", kind: "profile", status: "active" }));

  const ordered = await store.listRecords(alpha);
  assert.deepEqual(ordered.map((row) => row.key), ["profile.role", "pref.language", "fact.cohort"],
    "importance, then confidence, then recency");
  assert.deepEqual((await store.listRecords(alpha, { statuses: ["active"] })).map((row) => row.key),
    ["profile.role", "pref.language"]);
  assert.deepEqual((await store.listRecords(alpha, { kinds: ["profile", "project_fact"] })).map((row) => row.key),
    ["profile.role", "fact.cohort"]);
  assert.deepEqual((await store.listRecords(alpha, { scopes: ["project"], scopeId: "study-one" })).map((row) => row.key),
    ["fact.cohort"]);
  assert.deepEqual((await store.listRecords(alpha, { scopes: ["project"], scopeId: "study-two" })), []);
  assert.deepEqual((await store.listRecords(alpha, { query: "COHORT" })).map((row) => row.key), ["fact.cohort"],
    "the search is a case-insensitive substring over key, summary and value");
  assert.deepEqual((await store.listRecords(alpha, { query: "回答请用中文" })).map((row) => row.key), ["pref.language"]);
  assert.deepEqual((await store.listRecords(alpha, { query: "%" })), [],
    "a wildcard character is searched for literally, not as a wildcard");
  assert.equal((await store.listRecords(alpha, { pageSize: 1 })).length, 1);
  await assert.rejects(() => store.listRecords(alpha, { kinds: ["not-a-kind"] }),
    (error) => error?.status === 400 && error?.code === "memory_payload_invalid");

  const profile = await store.profile(alpha, { projectId: "study-one" });
  assert.deepEqual(Object.keys(profile.groups).sort(), ["analysis", "behavior", "correction", "decision",
    "follow_up", "preference", "profile", "project_fact", "run_summary"], "every kind is a key, present or empty");
  assert.equal(profile.activeCount, 2);
  assert.equal(profile.pendingCount, 0);
  assert.deepEqual((await store.profile(alpha, { projectId: null })).records.map((row) => row.key),
    ["profile.role", "pref.language"], "another project's facts are not this project's profile");
  await store.purgeUserMemory(alpha);
  await store.purgeUserMemory(beta);
});

test("notes are ordered pinned first, and an edit that changes nothing writes nothing", options, async () => {
  const first = await store.create(alpha, "第一条笔记 #循证");
  const second = await store.create(alpha, "second note");
  const third = await store.create(alpha, "third note");
  assert.deepEqual(first.tags, ["循证"]);
  assert.match(first.createdAt, instant);
  for (const [id, updatedAt] of [[first.id, "2026-01-01T00:00:01Z"], [second.id, "2026-01-01T00:00:02Z"],
    [third.id, "2026-01-01T00:00:03Z"]]) {
    await database.query("UPDATE evimed_memory.notes SET updated_at=$3 WHERE user_id=$1 AND id=$2", [alpha, id, updatedAt]);
  }
  assert.deepEqual((await store.list(alpha)).map((note) => note.id), [third.id, second.id, first.id]);
  const pinned = await store.update(alpha, first.id, { pinned: true });
  assert.equal(pinned.pinned, true);
  assert.deepEqual((await store.list(alpha)).map((note) => note.id), [first.id, third.id, second.id],
    "a pinned note leads whatever its age");

  await database.query("UPDATE evimed_memory.notes SET updated_at='2026-01-01T00:00:01Z' WHERE user_id=$1 AND id=$2",
    [alpha, second.id]);
  assert.equal((await store.update(alpha, second.id, {})).updatedAt, "2026-01-01T00:00:01Z", "an empty edit writes nothing");
  assert.equal((await store.update(alpha, second.id, { content: "second note" })).updatedAt, "2026-01-01T00:00:01Z",
    "and neither does rewriting the text it already holds");
  const edited = await store.update(alpha, second.id, { content: "second note, revised #新标签" });
  assert.notEqual(edited.updatedAt, "2026-01-01T00:00:01Z");
  assert.deepEqual(edited.tags, ["新标签"], "tags are re-derived from the new text");

  const archived = await store.update(alpha, third.id, { state: "archived" });
  assert.equal(archived.state, "archived");
  assert.deepEqual((await store.list(alpha, { state: "archived" })).map((note) => note.id), [third.id]);
  assert.equal((await store.list(alpha)).length, 2);
  assert.equal(await store.delete(alpha, third.id), true);
  await assert.rejects(() => store.delete(alpha, third.id), { status: 404, code: "memory_not_found" });
  await assert.rejects(() => store.update(alpha, "not a valid id", {}), { status: 400, code: "memory_id_invalid" });
  await assert.rejects(() => store.create(alpha, "   "), { status: 400, code: "memory_payload_invalid" });
  await store.purgeUserMemory(alpha);
});

test("export carries every surface and purge empties exactly one account", options, async () => {
  const note = await store.create(alpha, "alpha manual memory");
  await store.update(alpha, note.id, { state: "archived" });
  await store.create(alpha, "alpha current memory");
  await store.create(beta, "beta manual memory");
  await store.upsertRecord(alpha, record({ key: "profile.role", kind: "profile", value: "Clinical researcher", status: "active" }));
  await store.upsertRecord(beta, record({ key: "profile.role", kind: "profile", value: "Another user", status: "active" }));

  const exported = await store.exportUserMemory(alpha);
  assert.deepEqual(Object.keys(exported).sort(), ["manualMemos", "records", "settings", "version"]);
  assert.equal(exported.version, 1);
  assert.equal(exported.records.length, 1);
  assert.deepEqual(exported.manualMemos.map((memo) => memo.state), ["normal", "archived"],
    "current notes first, then archived ones");

  assert.deepEqual(await store.purgeUserMemory(alpha), { structured: 1, manual: 2 });
  assert.equal((await store.exportUserMemory(alpha)).records.length, 0);
  assert.equal((await store.exportUserMemory(beta)).records.length, 1);
  assert.equal((await store.list(beta)).length, 1);
  assert.deepEqual(await store.purgeUserMemory(beta), { structured: 1, manual: 1 });
});

test("project deletion removes project memory and legacy run notes, and nothing else", options, async () => {
  await store.create(alpha, "personal note with - Project: study-one");
  await store.create(alpha, "# EviMed agent run\n- Project: study-one\n#evimed-agent-run");
  await store.create(alpha, "# EviMed agent run\n- Project: study-two\n#evimed-agent-run");
  for (const [scope, scopeId, key] of [["project", "study-one", "run.one"], ["project", "study-two", "run.two"],
    ["user", "", "profile.role"]]) {
    await store.upsertRecord(alpha, record({
      scope, scopeId, kind: scope === "user" ? "profile" : "run_summary", key, value: key, summary: key,
      origin: "system", status: "active", confidence: 1, importance: 0.5,
    }));
  }
  assert.deepEqual(await store.deleteProjectMemory(alpha, "study-one"), { structured: 1, manual: 1 });
  const exported = await store.exportUserMemory(alpha);
  assert.deepEqual(exported.records.map((row) => row.key).sort(), ["profile.role", "run.two"]);
  assert.equal(exported.manualMemos.length, 2);
  assert.ok(exported.manualMemos.some((memo) => memo.content === "personal note with - Project: study-one"),
    "a personal note that merely mentions the project is not a run note");
  assert.ok(exported.manualMemos.some((memo) => memo.content.includes("- Project: study-two")));
  await assert.rejects(() => store.deleteProjectMemory(alpha, "  "),
    (error) => error?.status === 400 && error?.code === "memory_payload_invalid");
  await store.purgeUserMemory(alpha);
});

// The purge above runs first so the deletion audit can report what there was.
// Completeness is the foreign key's job, and this is the assertion that it is
// doing it: an account deleted without a purge still leaves nothing behind.
test("deleting an account deletes its memory, and the integrity audit knows the tables", options, async () => {
  const doomed = `memory_doomed_${randomUUID()}`;
  await createUsers([doomed]);
  await store.create(doomed, "a note that must not outlive its account");
  await store.upsertRecord(doomed, record({ key: "profile.role", kind: "profile", status: "active" }));
  await store.updateSessionState(doomed, "study-one", "ses_doomed", { incognito: true });
  assert.equal((await store.listAllRecords(doomed)).length, 1);

  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [doomed]);
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM evimed_memory.records WHERE user_id=$1",
    [doomed])).rows[0].count, 0);
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM evimed_memory.notes WHERE user_id=$1",
    [doomed])).rows[0].count, 0);
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM evimed_memory.sessions WHERE user_id=$1",
    [doomed])).rows[0].count, 0);

  const audit = await relationalIntegrity(database);
  for (const name of ["memory_records_user", "memory_notes_user", "memory_settings_user", "memory_sessions_user"]) {
    assert.ok(!audit.missing.includes(name), `${name} must be a declared foreign key`);
    assert.equal(audit.counts[name], 0, `${name} must hold no orphans`);
  }
});

/** Run an audit against a database with one table dropped, and put the table
 *  back: the drop lives and dies inside one rolled-back transaction, which the
 *  audit sees because it is handed that transaction's own client.
 *  @param {string} table */
async function auditWithout(table) {
  /** @type {any} */ let result = null;
  await database.transaction(async (/** @type {any} */ client) => {
    const inside = {
      query: (/** @type {string} */ text, /** @type {any[]} */ values) => client.query(text, values),
      transaction: (/** @type {(client: any) => Promise<any>} */ run) => run(client),
    };
    await client.query(`DROP TABLE ${table} CASCADE`);
    result = await relationalIntegrity(inside).catch((error) => ({ failedWith: String(error?.code ?? error?.message) }));
    throw new Error("rollback");
  }).catch((/** @type {any} */ error) => {
    if (error?.message !== "rollback") throw error;
  });
  return result;
}

// The audit tolerates no missing table, and that has to stay true for the two
// newest ones. While `evimed_memory` had no migration caller among the tools
// that audit, a tolerated-absent list kept them from failing; every such caller
// migrates it now, so the list is gone and a dropped memory table fails exactly
// the way a dropped inbox table always has. A registry that cannot fail on a
// dropped table is not a registry.
test("a dropped memory table fails the ownership audit, like every other registered table", options, async () => {
  await migrateNotifications(database);
  assert.deepEqual(await auditWithout("evimed_memory.records"), { failedWith: "42P01" },
    "a dropped memory table must fail the audit, not be reported as tolerable");
  assert.deepEqual(await auditWithout("evimed_inbox.notifications"), { failedWith: "42P01" },
    "and so must a dropped table outside that schema");
  assert.equal((await relationalIntegrity(database)).ok, true, "and both probes left the schema as they found it");
});

/**
 * The outbox: every memory write tells the derived index, in its own transaction.
 *
 * This is the half the index had no writer for. A deployment that selects the
 * OpenViking provider used to publish a record only when an operator ran the
 * rebuild command, so everything extracted between two runs of that command was
 * absent from recall — silently, because an empty index answers like a
 * relevance judgement rather than like a failure.
 */
/** @param {string} owner @returns {Promise<any[]>} */
async function indexJobs(owner) {
  // A queue that was never migrated holds no jobs, which is the answer the
  // `builtin` case wants and the only way to read it without a store that
  // migrates on the way past.
  const result = await database.query(`SELECT payload,status FROM evimed_product.jobs
    WHERE user_id=$1 AND kind='memory-record-index' ORDER BY created_at,id`, [owner])
    .catch((/** @type {any} */ error) => {
      if (error?.code === "42P01") return { rows: [] };
      throw error;
    });
  return result.rows;
}

test("a memory written is a memory the index is told about, in the same transaction", options, async () => {
  const owner = `memory_outbox_${randomUUID()}`;
  await createUsers([owner]);
  const queued = new ResearchMemoryStore({}, { database, jobs: new ProductJobs(database) });

  const created = await queued.upsertRecord(owner, {
    scope: "project", scopeId: "prj_outbox", kind: "analysis", key: "dose/response",
    value: "The 40 mg arm carried the effect.", origin: "inferred", status: "active",
  });
  const afterCreate = await indexJobs(owner);
  assert.equal(afterCreate.length, 1);
  assert.equal(afterCreate[0].status, "queued");
  assert.deepEqual(afterCreate[0].payload, {
    recordId: created.id, scope: "project", scopeId: "prj_outbox", memoryKind: "analysis",
  });

  // A write that changes nothing is not an event. Re-enqueueing on it would
  // turn one extraction repeated across a run into one index write per repeat.
  await queued.upsertRecord(owner, {
    scope: "project", scopeId: "prj_outbox", kind: "analysis", key: "dose/response",
    value: "The 40 mg arm carried the effect.", origin: "inferred", status: "active",
  });
  assert.equal((await indexJobs(owner)).length, 1, "a no-op write must not enqueue an index job");

  await queued.upsertRecord(owner, {
    scope: "project", scopeId: "prj_outbox", kind: "analysis", key: "dose/response",
    value: "The 40 mg arm carried the effect in the per-protocol set.", origin: "inferred", status: "active",
  });
  assert.equal((await indexJobs(owner)).length, 2, "a real edit must enqueue one");

  await queued.deleteRecord(owner, created.id);
  const afterDelete = await indexJobs(owner);
  assert.equal(afterDelete.length, 3, "forgetting a memory must reach the copy of it");
  assert.deepEqual(afterDelete[2].payload, {
    recordId: created.id, scope: "project", scopeId: "prj_outbox", memoryKind: "analysis",
  });

  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
});

test("a write that does not commit does not tell the index it did", options, async () => {
  const owner = `memory_rollback_${randomUUID()}`;
  await createUsers([owner]);
  const queued = new ResearchMemoryStore({}, { database, jobs: new ProductJobs(database) });
  const first = await queued.upsertRecord(owner, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "Tables, not prose.", origin: "inferred", status: "active",
  });
  assert.equal((await indexJobs(owner)).length, 1);

  // A provided id that already names another memory is refused after the row
  // would have been inserted. The outbox row has to go back with it, or the
  // index would be told to publish a version that never existed.
  await assert.rejects(() => queued.upsertRecord(owner, {
    id: first.id, scope: "user", scopeId: "", kind: "preference", key: "format",
    value: "Another memory entirely.", origin: "inferred", status: "active",
  }), { code: "memory_conflict" });
  assert.equal((await indexJobs(owner)).length, 1, "a refused write must leave no index job behind");

  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
});

test("a deployment on the term matcher queues nothing for a worker it never composes", options, async () => {
  const owner = `memory_builtin_${randomUUID()}`;
  await createUsers([owner]);
  // The store built without the queue is what `builtin` composes.
  await store.upsertRecord(owner, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "Tables, not prose.", origin: "inferred", status: "active",
  });
  assert.deepEqual(await indexJobs(owner), []);
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
});

test("a superseded fact leaves recall in the same commit that writes its replacement, and keeps its history", options, async () => {
  const projectId = "project-supersede";
  const fact = (key, value) => ({
    scope: "project", scopeId: projectId, kind: "project_fact", key, value, summary: value,
    origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false,
  });
  const old = await store.upsertRecord(alpha, fact("project.regimen.rivaroxaban_20mg", "利伐沙班 20 mg qd"));
  assert.equal(old.supersededBy, null);
  assert.equal(old.invalidSince, null);

  const { record, superseded } = await store.supersede(alpha, old.id, fact("project.regimen.rivaroxaban_15mg", "利伐沙班 15 mg qd"),
    { sourceType: "conversation_message", sourceRef: "sessions/s1/messages/m9", quote: "改为 15 mg", observedAt: "2026-09-20T01:00:00Z", weight: 1 },
    { reason: "conversation evidence replaced an earlier fact" });
  assert.equal(record.status, "active");
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededBy, record.id);
  assert.match(superseded.invalidSince, instant);
  assert.equal(superseded.value, "利伐沙班 20 mg qd", "the old fact is kept as it was, not edited");
  assert.match(superseded.revisions.at(-1).reason, /^superseded by project\.regimen\.rivaroxaban_15mg: conversation evidence replaced/);

  const recalled = await store.relevant(alpha, "利伐沙班的剂量", { projectId });
  assert.deepEqual(recalled.map((memo) => memo.id), [`record:${record.id}`], "only the fact in force is recalled");

  // An edit of the replaced fact's wording does not put it back in force.
  const edited = await store.upsertRecord(alpha, { ...superseded, summary: "（旧方案）利伐沙班 20 mg qd" }, null,
    { expectedVersion: superseded.version, reason: "user updated structured memory" });
  assert.equal(edited.status, "superseded");
  assert.equal(edited.supersededBy, record.id);

  await assert.rejects(store.supersede(alpha, record.id, fact("project.regimen.rivaroxaban_15mg", "利伐沙班 15 mg bid")),
    (error) => error?.status === 400 && error?.code === "memory_supersede_invalid");
  await assert.rejects(store.supersede(beta, record.id, fact("project.regimen.other", "x")),
    (error) => error?.status === 404, "another account's record cannot be superseded");
  await store.purgeUserMemory(alpha);
});

test("a conversation's memory state: incognito, set aside and brought back, in one statement each", options, async () => {
  const owner = `memory_session_${randomUUID()}`;
  await createUsers([owner]);
  /** @param {any} state */
  const plain = (state) => ({ incognito: state.incognito, excluded: state.excluded });
  try {
    // Every switch off for a conversation that never touched one.
    assert.deepEqual(plain(await store.sessionState(owner, "study-one", "ses_a")), { incognito: false, excluded: [] });

    const on = await store.updateSessionState(owner, "study-one", "ses_a", { incognito: true });
    assert.equal(on.incognito, true);
    const aside = await store.updateSessionState(owner, "study-one", "ses_a", {
      exclude: { type: "memory", id: "rec_1", label: "偏好表格" },
    });
    assert.equal(aside.incognito, true, "setting an item aside leaves the switch where it was");
    await store.updateSessionState(owner, "study-one", "ses_a", { exclude: { type: "method", id: "method-abc", label: "剂量核对" } });
    // The same item twice is one item, moved to the end with its newest label.
    const again = await store.updateSessionState(owner, "study-one", "ses_a", { exclude: { type: "memory", id: "rec_1", label: "表格" } });
    assert.deepEqual(again.excluded.map((item) => [item.type, item.id, item.label]),
      [["method", "method-abc", "剂量核对"], ["memory", "rec_1", "表格"]]);
    const back = await store.updateSessionState(owner, "study-one", "ses_a", { include: { type: "memory", id: "rec_1" } });
    assert.deepEqual(back.excluded.map((item) => item.id), ["method-abc"]);

    // Another conversation, and the same conversation id in another project, are their own.
    assert.deepEqual(plain(await store.sessionState(owner, "study-one", "ses_b")), { incognito: false, excluded: [] });
    assert.deepEqual(plain(await store.sessionState(owner, "study-two", "ses_a")), { incognito: false, excluded: [] });

    // Two tabs at once both win: one sets an item aside while the other turns incognito off.
    await Promise.all([
      store.updateSessionState(owner, "study-one", "ses_a", { exclude: { type: "note", id: "note_1", label: "" } }),
      store.updateSessionState(owner, "study-one", "ses_a", { incognito: false }),
    ]);
    const both = await store.sessionState(owner, "study-one", "ses_a");
    assert.equal(both.incognito, false);
    assert.deepEqual(both.excluded.map((item) => item.id).sort(), ["method-abc", "note_1"]);

    // Refused as payload errors, by name.
    for (const patch of [{ incognito: "yes" }, { exclude: { type: "tool", id: "x" } }, { exclude: { type: "memory", id: "../x" } }]) {
      await assert.rejects(() => store.updateSessionState(owner, "study-one", "ses_a", patch),
        (error) => error?.status === 400, JSON.stringify(patch));
    }
    await assert.rejects(() => store.sessionState(owner, "study-one", "ses a"), (error) => error?.code === "memory_session_invalid");

    // Recall leaves out what the conversation set aside, and frees the slot.
    await store.upsertRecord(owner, record({ key: "response.format", kind: "preference", value: "Tables for kidney outcomes.",
      summary: "Tables", origin: "explicit", status: "active", confidence: 1 }));
    const kept = await store.upsertRecord(owner, record({ key: "response.language", kind: "preference",
      value: "Answer kidney questions in Chinese.", summary: "Chinese", origin: "explicit", status: "active", confidence: 1 }));
    const all = await store.relevant(owner, "kidney", { projectId: "study-one" });
    assert.equal(all.length, 2);
    const [first] = all;
    const filtered = await store.relevant(owner, "kidney", { projectId: "study-one",
      excluded: [{ type: "memory", id: first.id.slice("record:".length) }] });
    assert.deepEqual(filtered.map((memo) => memo.id), all.slice(1).map((memo) => memo.id));
    assert.ok(all.some((memo) => memo.id === `record:${kept.id}`));

    // Forgetting the project forgets its conversations' state, and only its.
    await store.updateSessionState(owner, "study-two", "ses_c", { incognito: true });
    await store.deleteProjectMemory(owner, "study-one");
    assert.deepEqual(plain(await store.sessionState(owner, "study-one", "ses_a")), { incognito: false, excluded: [] });
    assert.equal((await store.sessionState(owner, "study-two", "ses_c")).incognito, true);
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  }
});
