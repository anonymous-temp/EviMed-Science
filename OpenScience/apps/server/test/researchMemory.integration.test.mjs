import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";

/**
 * The research-memory store against a real PostgreSQL.
 *
 * These are the behavioural assertions the retired REST adapter's test held —
 * isolation, compare-and-swap, evidence bounds, export, purge, project deletion
 * and recall — carried over to the store that replaced it, plus the thing only
 * a database can settle: that two writers racing on one canonical key still
 * leave one row.
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

test("run summaries are recalled only when they match the question", options, async () => {
  const projectId = "project-recall";
  const summary = (key, question) => store.upsertRecord(alpha, {
    scope: "project", scopeId: projectId, kind: "run_summary", key,
    value: JSON.stringify({ runId: key, question, answer: `关于${question}的长篇回答` }),
    summary: `Conversation about: ${question}`, origin: "system", status: "active",
    // A finished run is stored with full confidence and a failed one as more
    // important than a successful one. Those two numbers alone put the
    // relevance score above zero, which is what used to make every summary
    // unconditionally recallable.
    confidence: 1, importance: 0.7, sensitive: false,
  });
  await summary("run.metformin", "二甲双胍的作用机制是什么");
  await summary("run.rituximab", "利妥昔单抗的感染风险");
  await store.upsertRecord(alpha, record({
    kind: "preference", key: "pref.language", value: "回答请用中文", summary: "回答请用中文",
    origin: "explicit", status: "active", confidence: 1, importance: 0.6,
  }));

  const greeting = await store.relevant(alpha, "hello", { projectId });
  assert.deepEqual(greeting.map((memo) => memo.kind), ["preference"]);
  const onTopic = await store.relevant(alpha, "二甲双胍还有哪些副作用", { projectId });
  assert.deepEqual(onTopic.map((memo) => memo.kind).sort(), ["preference", "run_summary"],
    "a question that names the drug should still reach the earlier run");

  // The projection, not the record: a run summary stores run ids, the model and
  // timings, and none of those belong in a prompt.
  const [recalled] = onTopic.filter((memo) => memo.kind === "run_summary");
  assert.match(recalled.content, /二甲双胍的作用机制是什么/);
  for (const internal of ["run.metformin", "runId"]) {
    assert.ok(!recalled.content.includes(internal), `${internal} must not reach the prompt`);
  }
  // Scope is a permission: another project never sees these.
  assert.deepEqual((await store.relevant(alpha, "二甲双胍还有哪些副作用", { projectId: "other-project" }))
    .map((memo) => memo.kind), ["preference"]);
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
  assert.deepEqual(Object.keys(exported).sort(), ["manualMemos", "records", "version"]);
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
