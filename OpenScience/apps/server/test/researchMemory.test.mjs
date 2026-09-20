import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MEMORY_EVIDENCE_LIMIT,
  MEMORY_REVISION_LIMIT,
  ResearchMemoryStore,
  appendRevision,
  boundedEvidence,
  boundedText,
  currentStateEqual,
  evidenceFingerprint,
  memoryInstant,
  mergeEvidence,
  normalizeMemoryKey,
  validateRecordInput,
} from "../src/researchMemory.mjs";

/** The separator the Go fingerprint joins with, built rather than written, so
 *  this file carries no control byte of its own. */
const NUL = String.fromCharCode(0);

function candidate(overrides = {}) {
  return {
    scope: "user",
    kind: "preference",
    key: "response.evidence_depth",
    value: "Prefer primary evidence.",
    summary: "Primary evidence first.",
    origin: "inferred",
    status: "pending",
    confidence: 0.7,
    importance: 0.9,
    sensitive: false,
    ...overrides,
  };
}

test("a memory key is lower-cased and trimmed, and anything outside the key alphabet is refused", () => {
  assert.equal(normalizeMemoryKey("  Response.Evidence_Depth  "), "response.evidence_depth");
  assert.equal(validateRecordInput(candidate({ key: " PROFILE.Role " })).key, "profile.role");
  assert.equal(validateRecordInput(candidate({ key: "run.2026-09-11/alpha" })).key, "run.2026-09-11/alpha");
  for (const key of ["", " ", "-leading", "has space", "UPPER CASE", "半角以外", `a${"b".repeat(255)}`]) {
    assert.throws(() => validateRecordInput(candidate({ key })),
      (error) => error?.status === 400 && error?.code === "memory_payload_invalid",
      `key ${JSON.stringify(key)} must be refused`);
  }
  // A user-scoped memory has no scope id, and every other scope must carry one.
  assert.equal(validateRecordInput(candidate({ scope: "user", scopeId: "project-1" })).scopeId, "");
  assert.throws(() => validateRecordInput(candidate({ scope: "project", scopeId: "  " })),
    { code: "memory_payload_invalid" });
  assert.equal(validateRecordInput(candidate({ scope: "project", scopeId: " project-1 " })).scopeId, "project-1");
  for (const field of ["scope", "kind", "origin", "status"]) {
    assert.throws(() => validateRecordInput(candidate({ [field]: "not-a-value" })), { code: "memory_payload_invalid" });
  }
  // Scores are clamped rather than refused, as the retired client clamped them
  // before sending: bad arithmetic in a caller must not lose the memory.
  assert.equal(validateRecordInput(candidate({ confidence: 4 })).confidence, 1);
  assert.equal(validateRecordInput(candidate({ importance: Number.NaN })).importance, 0);
});

// Characters, not bytes, and the same unit the routes validate in. Counted in
// Go bytes, a 2000-character Chinese summary every caller had accepted was
// refused at the boundary as 6000 bytes.
test("text limits are counted in characters and cut between code points", () => {
  assert.equal(boundedText("  padded  ", 100), "padded");
  const chinese = "证据引语。".repeat(2_000);
  const quote = boundedText(chinese, 4_000);
  assert.equal(quote.length, 4_000, "a Chinese quote keeps 4000 characters, not 4000 bytes worth of them");
  assert.ok(Buffer.byteLength(quote, "utf8") > 4_000, "and that is deliberately more than 4000 bytes");
  const astral = "\u{1F9EA}".repeat(10);
  const cut = boundedText(astral, 5);
  assert.equal(cut, "\u{1F9EA}\u{1F9EA}", "a surrogate pair is kept whole, so five units carry two characters");
  assert.equal(cut, [...cut].join(""), "the cut lands on a character boundary");
  assert.equal(validateRecordInput(candidate({ summary: "s".repeat(2_000) })).summary.length, 2_000);
  assert.throws(() => validateRecordInput(candidate({ summary: "s".repeat(2_001) })), { code: "memory_payload_invalid" });
  assert.throws(() => validateRecordInput(candidate({ value: "  " })), { code: "memory_payload_invalid" });
  assert.throws(() => validateRecordInput(candidate({ value: "v".repeat(100_001) })), { code: "memory_payload_invalid" });
});

// hex(sha256(sourceType || NUL || sourceRef || NUL || quote))[0:32], the formula
// of 记忆模块/store/memory_record.go:memoryEvidenceFingerprint. Evidence written
// before the move and evidence written after it must dedupe against each other,
// so this is asserted against the formula rather than against itself.
test("the evidence fingerprint is the Go formula, and time is not part of it", () => {
  const fields = ["conversation_message", "sessions/s1/messages/m1", "优先给原始证据。"];
  const expected = createHash("sha256").update(fields.join(NUL)).digest("hex").slice(0, 32);
  assert.equal(expected.length, 32);
  const [sourceType, sourceRef, quote] = fields;
  assert.equal(evidenceFingerprint({ sourceType, sourceRef, quote }), expected);
  // A fixed vector, so a later refactor of the helper cannot quietly change the
  // digest while still agreeing with a freshly computed one.
  assert.equal(
    evidenceFingerprint({ sourceType: "conversation_message", sourceRef: "sessions/s1/messages/m1", quote: "hello" }),
    "388ed587ad4b87eb920c961d471d0f0d",
  );
  assert.equal(evidenceFingerprint({ sourceType: ` ${sourceType} `, sourceRef, quote: `${quote}\n` }), expected,
    "the fields are trimmed before hashing");
  const first = boundedEvidence({ sourceType, sourceRef, quote, observedAt: "2026-09-11T06:51:44Z" });
  const later = boundedEvidence({ sourceType, sourceRef, quote, observedAt: "2026-09-12T09:00:00Z" });
  assert.equal(first.fingerprint, later.fingerprint, "re-quoting the same message in a later run adds nothing");
  // Two fields swapped must not collide, which is the whole point of a
  // separator that cannot appear inside a field.
  assert.notEqual(evidenceFingerprint({ sourceType: "a", sourceRef: "bc", quote: "d" }),
    evidenceFingerprint({ sourceType: "ab", sourceRef: "c", quote: "d" }));
});

test("evidence is trimmed to what a record accepts, and an empty required field drops the evidence, not the record", () => {
  const long = boundedEvidence({ sourceType: "conversation_message", sourceRef: "sessions/s/messages/1",
    quote: "q".repeat(5_000), observedAt: "2026-09-11T06:51:44Z" });
  assert.equal(long.quote.length, 4_000);
  const wide = boundedEvidence({ sourceType: "t".repeat(200), sourceRef: "r".repeat(900), quote: "q" });
  assert.equal(wide.sourceType.length, 64);
  assert.equal(wide.sourceRef.length, 500);
  assert.equal(boundedEvidence({ sourceType: "conversation_message", sourceRef: "sessions/s/messages/2", quote: "   " }), null);
  assert.equal(boundedEvidence(null), null);
  assert.equal(boundedEvidence({ sourceType: "t", sourceRef: "r", quote: "q" }).weight, 1, "weight defaults to one");
  assert.equal(boundedEvidence({ sourceType: "t", sourceRef: "r", quote: "q", weight: 0 }).weight, 0);
  assert.equal(boundedEvidence({ sourceType: "t", sourceRef: "r", quote: "q", weight: 9 }).weight, 1);
});

test("evidence dedupes by fingerprint and keeps the newest 64", () => {
  const item = (index) => boundedEvidence({ sourceType: "conversation_message",
    sourceRef: `sessions/s/messages/${index}`, quote: `quote ${index}`, observedAt: "2026-09-11T06:51:44Z" });
  let evidence = [];
  for (let index = 0; index < 70; index += 1) {
    const merged = mergeEvidence(evidence, item(index));
    assert.equal(merged.added, true);
    evidence = merged.evidence;
  }
  assert.equal(evidence.length, MEMORY_EVIDENCE_LIMIT);
  assert.equal(evidence[0].quote, "quote 6", "the oldest entries age out, newest last");
  assert.equal(evidence.at(-1).quote, "quote 69");
  const again = mergeEvidence(evidence, item(69));
  assert.equal(again.added, false, "a quote already retained is not appended twice");
  assert.equal(again.evidence.length, MEMORY_EVIDENCE_LIMIT);
  assert.equal(mergeEvidence(evidence, null).added, false);
});

test("revisions keep the newest 32", () => {
  let revisions = [];
  for (let version = 1; version <= 40; version += 1) {
    revisions = appendRevision(revisions, { version, value: `v${version}`, summary: "", status: "active",
      changedAt: "2026-09-11T06:51:44Z", reason: "" });
  }
  assert.equal(revisions.length, MEMORY_REVISION_LIMIT);
  assert.equal(revisions[0].version, 9);
  assert.equal(revisions.at(-1).version, 40);
});

// The extractor re-observes the same preference in every run. If each of those
// writes bumped the version, every later compare-and-swap would fail against a
// record nobody edited.
test("a write that changes nothing is detected as a no-op, field by field", () => {
  const stored = {
    value: "Prefer primary evidence.", summary: "Primary evidence first.", origin: "inferred", status: "pending",
    confidence: 0.7, importance: 0.9, sensitive: false,
    lastConfirmedAt: "2026-09-11T06:51:44Z", expiresAt: null,
  };
  assert.equal(currentStateEqual(stored, { ...stored }), true);
  assert.equal(currentStateEqual(stored, { ...stored, lastConfirmedAt: undefined }), false);
  assert.equal(currentStateEqual({ ...stored, lastConfirmedAt: null }, { ...stored, lastConfirmedAt: undefined }), true,
    "an absent timestamp and a null one are the same absence");
  for (const [field, value] of [["value", "other"], ["summary", "other"], ["origin", "explicit"],
    ["status", "active"], ["confidence", 0.8], ["importance", 0.1], ["sensitive", true],
    ["lastConfirmedAt", "2026-09-11T06:51:45Z"], ["expiresAt", "2026-10-11T06:51:44Z"]]) {
    assert.equal(currentStateEqual(stored, { ...stored, [field]: value }), false, `${field} must be part of the check`);
  }
});

// Second precision is load-bearing twice over: distinct runs are counted by
// distinct observedAt strings, and the no-op check above compares two
// timestamps. A millisecond that survives a write breaks both.
test("timestamps are whole seconds, formatted the way the retired service formatted them", () => {
  assert.equal(memoryInstant("2026-09-11T06:51:44.789Z"), "2026-09-11T06:51:44Z");
  assert.equal(memoryInstant(new Date("2026-09-11T06:51:44.001Z")), "2026-09-11T06:51:44Z");
  assert.equal(memoryInstant("2026-09-11T14:51:44.500+08:00"), "2026-09-11T06:51:44Z");
  assert.equal(memoryInstant(null), null);
  assert.equal(memoryInstant(""), null);
  assert.equal(memoryInstant("not a time"), null);
  assert.equal(validateRecordInput(candidate({ expiresAt: "2026-10-11T06:51:44.999Z" })).expiresAt, "2026-10-11T06:51:44Z");
  assert.equal(validateRecordInput(candidate({ lastConfirmedAt: null })).lastConfirmedAt, null);
  assert.throws(() => validateRecordInput(candidate({ expiresAt: "soon" })), { code: "memory_payload_invalid" });
  assert.equal(boundedEvidence({ sourceType: "t", sourceRef: "r", quote: "q", observedAt: "2026-09-11T06:51:44.900Z" }).observedAt,
    "2026-09-11T06:51:44Z");
});

// 「你写下的笔记」 is gone, and with it the usememos tag rule this file used to
// hold three suites for (`extractTags`, the URL-fragment case, the retired
// per-user tenancy tag). The composer was a hand-written duplicate of what the
// extractor already writes; production held zero rows, so the table is dropped
// rather than migrated. A memory now has a canonical key and its evidence, and
// nothing about it is parsed out of free text.
test("the note store and everything that parsed a note's text are gone", async () => {
  const module = await import("../src/researchMemory.mjs");
  for (const name of ["extractTags", "normalizeNoteContent", "sessionExclusion", "MEMORY_NOTE_CONTENT_LIMIT"]) {
    assert.equal(module[name], undefined, `${name} is deleted, not kept for a caller that no longer exists`);
  }
  const store = new ResearchMemoryStore({});
  for (const name of ["create", "update", "delete", "list", "listAllMemos", "searchNotes"]) {
    assert.equal(typeof (/** @type {any} */ (store))[name], "undefined", `the store no longer offers ${name}`);
  }
  const persistence = await import("../src/researchMemoryPersistence.mjs");
  assert.equal(persistence.MEMORY_NOTE_STATES, undefined, "the note state vocabulary went with the table");
});

// A deployment without a control-plane database has no research memory, which
// is what a deployment without the retired service had. The status says so by
// name instead of pretending to be connected, and every method refuses with the
// same 503 the routes already translate.
test("without a database the store is unconfigured, and says so rather than failing at the first query", async () => {
  const store = new ResearchMemoryStore({});
  assert.equal(store.configured, false);
  assert.deepEqual(await store.status(), {
    configured: false,
    connected: false,
    code: "memory_unconfigured",
    structured: false,
  });
  for (const call of [
    () => store.listRecords("alpha"),
    () => store.getRecord("alpha", "record_1"),
    () => store.upsertRecord("alpha", candidate()),
    () => store.exportUserMemory("alpha"),
    () => store.purgeUserMemory("alpha"),
  ]) {
    await assert.rejects(call, (error) => error?.status === 503 && error?.code === "memory_unconfigured");
  }
  // Recall is the one exception, and deliberately so: a question must still be
  // answered when there is no memory to answer it with.
  assert.deepEqual(await store.relevant("alpha", "anything"), []);
});

// A database that is merely unreachable must never look like a rejected
// payload: chat and autopilot read this code to decide between degrading and
// refusing, and a run that is told its memory was invalid stops asking.
test("a database that cannot be reached is 503 memory_unavailable, not a rejected payload", async () => {
  const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  const unreachable = { query: async () => { throw refused(); }, transaction: async () => { throw refused(); } };
  const store = new ResearchMemoryStore({}, { database: unreachable });
  assert.equal(store.configured, true, "a configured store whose database is down is still configured");
  assert.deepEqual(await store.status(), {
    configured: true,
    connected: false,
    code: "memory_unavailable",
    structured: false,
  });
  for (const call of [
    () => store.listRecords("alpha"),
    () => store.upsertRecord("alpha", candidate()),
    () => store.searchRecords("alpha", { query: "肾功能" }),
    () => store.recordUsage("alpha", ["rec_1"]),
    () => store.deleteProjectMemory("alpha", "project-1"),
  ]) {
    await assert.rejects(call, (error) => error?.status === 503 && error?.code === "memory_unavailable");
  }
  await assert.rejects(() => store.relevant("alpha", "anything"), { status: 503, code: "memory_unavailable" },
    "recall reports the outage rather than pretending the account has no memory");
});
