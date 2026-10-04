// Which version of a fact answers a question, and what the reader is told.
//
// The decision is made once, from the authoritative record, and both recall
// arms end in it (`memoryValidity.mjs`). These cases are the five the owner's
// plan names — cross-project, changed fact, expired or retracted source, two
// conflicting statements, insufficient evidence — plus the property that makes
// a history safe to offer: retrieval never restores what the researcher
// removed.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_CAVEATS, annotateVersions, heldAt, parseAsOf, validityOf, versionFields, versionsInForce,
} from "../src/memoryValidity.mjs";

const NOW = Date.parse("2026-10-04T00:00:00Z");
const day = (text) => Date.parse(`${text}T00:00:00Z`);

function record(overrides = {}) {
  return {
    id: "r1", scope: "project", scopeId: "prj_a", kind: "project_fact", key: "project.dose", value: "20 mg qd",
    summary: "20 mg qd", origin: "explicit", status: "active", sensitive: false, confidence: 1, importance: 0.7,
    evidenceCount: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    expiresAt: null, validFrom: null, invalidSince: null, supersededBy: null, ...overrides,
  };
}

const context = (over = {}) => ({ now: NOW, projectId: "prj_a", sessionId: "ses_1", ...over });
const ids = (entries) => entries.map((entry) => entry.record.id);

test("the vocabulary of caveats is closed and ordered most serious first", () => {
  assert.deepEqual([...MEMORY_CAVEATS], ["conflict", "source_retracted", "source_expired", "source_changed", "not_yet_valid", "insufficient_evidence"]);
});

// --------------------------------------------------------------- cross-project

test("another project's memory is never the answer, and neither is another conversation's", () => {
  const records = [
    record({ id: "mine" }),
    record({ id: "other_project", scopeId: "prj_b" }),
    record({ id: "other_session", scope: "session", scopeId: "ses_2", key: "project.note" }),
    record({ id: "this_session", scope: "session", scopeId: "ses_1", key: "project.note2" }),
    record({ id: "account", scope: "user", scopeId: "", kind: "profile", key: "profile.role" }),
  ];
  assert.deepEqual(ids(versionsInForce(records, context())), ["mine", "this_session", "account"]);
  assert.deepEqual(ids(versionsInForce(records, context({ projectId: "prj_b", sessionId: null }))), ["other_project", "account"]);
  assert.deepEqual(ids(versionsInForce(records, context({ projectId: null, sessionId: null }))), ["account"],
    "a question asked outside any project sees the researcher's own memory and nothing of any project");
});

test("where one fact is held at two scopes the narrower one applies, whatever it says", () => {
  const records = [
    record({ id: "account_default", scope: "user", scopeId: "", kind: "decision", key: "decision.comparator", value: "placebo" }),
    record({ id: "this_project", kind: "decision", key: "decision.comparator", value: "active control" }),
    record({ id: "unrelated", kind: "decision", key: "decision.endpoint", value: "OS" }),
  ];
  assert.deepEqual(ids(versionsInForce(records, context())), ["this_project", "unrelated"]);
  assert.deepEqual(ids(versionsInForce(records, context({ projectId: "prj_z" }))), ["account_default"],
    "in a project with no override the account-level value is the answer, and the other project's value is not");
});

// -------------------------------------------------------------- changed fact

test("a replaced fact answers for the time before it was replaced, and never for now", () => {
  const replacedOn = "2026-06-01T00:00:00Z";
  const old = record({ id: "old", key: "project.dose_20", value: "20 mg qd", status: "superseded", supersededBy: "new",
    createdAt: "2026-01-01T00:00:00Z", invalidSince: replacedOn });
  const current = record({ id: "new", key: "project.dose_15", value: "15 mg qd", createdAt: replacedOn });
  assert.deepEqual(ids(versionsInForce([old, current], context())), ["new"], "now: the replacement");
  assert.deepEqual(ids(versionsInForce([old, current], context({ asOf: day("2026-03-15") }))), ["old"], "March: the dose then");
  assert.deepEqual(ids(versionsInForce([old, current], context({ asOf: day("2026-07-01") }))), ["new"], "July: the dose now");
  assert.deepEqual(ids(versionsInForce([old, current], context({ asOf: Date.parse(replacedOn) }))), ["new"],
    "the instant of replacement belongs to the replacement, not to both");
});

test("a question about a time before anything was recorded is answered with the earliest version, labelled, and not with the latest", () => {
  const old = record({ id: "old", key: "project.dose_20", status: "superseded", supersededBy: "new",
    createdAt: "2026-01-01T00:00:00Z", invalidSince: "2026-06-01T00:00:00Z" });
  const current = record({ id: "new", key: "project.dose_15", createdAt: "2026-06-01T00:00:00Z" });
  const found = versionsInForce([old, current], context({ asOf: day("2025-05-01") }));
  assert.deepEqual(found.map((entry) => [entry.record.id, entry.caveats]), [["old", ["not_yet_valid"]]]);
});

test("a stated start is the start; an unknown one is when the platform recorded it, never always", () => {
  const stated = record({ validFrom: "2024-03-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z" });
  assert.equal(validityOf(stated).start, Date.parse("2024-03-01T00:00:00Z"));
  assert.equal(heldAt(stated, context({ asOf: day("2025-01-01") })), true, "the source said it held from 2024");
  const unknown = record({ createdAt: "2026-09-01T00:00:00Z" });
  assert.equal(validityOf(unknown).start, Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(heldAt(unknown, context({ asOf: day("2025-01-01") })), false, "the platform knows nothing of 2025");
  assert.equal(validityOf(record({ createdAt: undefined })).start, -Infinity, "a record that carries no times is not refused");
});

test("a question about now never reads a clock the caller does not share: a record in force is in force", () => {
  // The database stamped it a minute ahead of this process's clock.
  const justWritten = record({ createdAt: new Date(NOW + 60_000).toISOString() });
  assert.deepEqual(ids(versionsInForce([justWritten], context())), ["r1"]);
  assert.deepEqual(versionsInForce([justWritten], context({ asOf: NOW - 1_000 })).map((entry) => entry.caveats), [["not_yet_valid"]],
    "for an earlier time the recorded moment is the evidence, and it says nothing was known yet");
  const stated = record({ validFrom: new Date(NOW + 60_000).toISOString() });
  assert.deepEqual(versionsInForce([stated], context()).map((entry) => entry.caveats), [["not_yet_valid"]], "a stated future start is a stated start");
});

test("a fact with a stated end stops being the answer at that end, and an inverted interval is never held", () => {
  const ended = record({ invalidSince: "2026-08-01T00:00:00Z" });
  assert.deepEqual(ids(versionsInForce([ended], context())), []);
  assert.deepEqual(ids(versionsInForce([ended], context({ asOf: day("2026-07-01") }))), ["r1"]);
  const upcoming = record({ id: "later", validFrom: "2027-01-01T00:00:00Z" });
  assert.deepEqual(versionsInForce([upcoming], context()).map((entry) => entry.caveats), [["not_yet_valid"]],
    "a version that begins after the time asked is offered, labelled");
  const inverted = record({ id: "empty", validFrom: "2026-09-01T00:00:00Z", invalidSince: "2026-08-01T00:00:00Z" });
  assert.deepEqual(versionsInForce([inverted], context()), []);
});

test("a replacement waiting to begin does not stand beside the fact it will replace", () => {
  const current = record({ id: "current", supersededBy: "next" });
  const next = record({ id: "next", key: "project.dose_next", validFrom: "2027-01-01T00:00:00Z" });
  assert.deepEqual(ids(versionsInForce([current, next], context())), ["current"]);
});

test("a replacement and the record it replaces, both in hand and both held, give the replacement", () => {
  const old = record({ id: "old", key: "project.a", supersededBy: "new", status: "superseded", invalidSince: "2026-10-05T00:00:00Z" });
  const next = record({ id: "new", key: "project.b", createdAt: "2026-02-01T00:00:00Z" });
  assert.deepEqual(ids(versionsInForce([old, next], context({ asOf: day("2026-09-01") }))), ["new"]);
});

test("an inference's retention expiry applies to now and not to a question about the past", () => {
  const inferred = record({ origin: "inferred", expiresAt: "2026-09-01T00:00:00Z" });
  assert.deepEqual(ids(versionsInForce([inferred], context())), [], "the platform no longer relies on it");
  assert.deepEqual(ids(versionsInForce([inferred], context({ asOf: day("2026-05-01") }))), ["r1"]);
});

// ------------------------------------------------------- retrieval and revocation

test("retrieval never restores what the researcher removed or was never allowed to see", () => {
  const history = [
    record({ id: "forgotten_then_replaced", status: "archived", invalidSince: "2026-06-01T00:00:00Z" }),
    record({ id: "proposal", status: "pending" }),
    record({ id: "secret", sensitive: true }),
    record({ id: "summary", kind: "run_summary", key: "run.x" }),
    record({ id: "other_projects_history", scopeId: "prj_b", status: "superseded", invalidSince: "2026-06-01T00:00:00Z" }),
  ];
  for (const asOf of [null, day("2026-03-01")]) {
    assert.deepEqual(versionsInForce(history, context({ asOf })), [], `nothing comes back for ${asOf ?? "now"}`);
  }
});

// ------------------------------------------------------------------- labels

function links({ conflicts = {}, sources = {} } = {}) {
  return { conflicts: new Map(Object.entries(conflicts)), sources: new Map(Object.entries(sources)) };
}
const conflictWith = (other, over = {}) => ({ otherId: other.id, state: "open", createdAt: "2026-05-01T00:00:00Z", other, ...over });

test("two statements that disagree are both served, each marked with the other", () => {
  const stated = record({ id: "said", key: "project.dose_user", value: "10 mg", summary: "你说 10 mg" });
  const label = record({ id: "label", key: "project.dose_label", value: "20 mg", summary: "说明书 20 mg", origin: "system" });
  const entries = versionsInForce([stated, label], context());
  const labelled = annotateVersions(entries, links({
    conflicts: { said: [conflictWith(label)], label: [conflictWith(stated)] },
  }), context());
  assert.deepEqual(labelled.map((item) => [item.record.id, item.caveats]), [["said", ["conflict"]], ["label", ["conflict"]]]);
  assert.deepEqual(labelled[0].conflictsWith, [{ id: "label", key: "project.dose_label", kind: "project_fact", scope: "project", summary: "说明书 20 mg" }]);
  assert.equal(versionFields(labelled[0]).caveats[0], "conflict");
});

test("a conflict is only a conflict while both sides hold and it has been recorded", () => {
  const a = record({ id: "a", key: "project.a" });
  const entries = versionsInForce([a], context());
  const label = (other, over) => annotateVersions(entries, links({ conflicts: { a: [conflictWith(other, over)] } }), context({ asOf: over?.asOf }))[0].caveats;
  assert.deepEqual(label(record({ id: "b", key: "project.b" })), ["conflict"]);
  assert.deepEqual(label(record({ id: "b", key: "project.b", status: "archived" })), [], "a forgotten statement is no longer a side");
  assert.deepEqual(label(record({ id: "b", key: "project.b", status: "superseded", invalidSince: "2026-06-01T00:00:00Z" })), [], "neither is a replaced one");
  assert.deepEqual(label(record({ id: "b", key: "project.b", sensitive: true })), [], "nor one that must never be shown");
  assert.deepEqual(label(record({ id: "b", key: "project.b", scopeId: "prj_b" })), [], "nor another project's");
  assert.deepEqual(label(record({ id: "b", key: "project.b" }), { state: "resolved" }), [], "a settled disagreement is not shown");
  const later = annotateVersions(versionsInForce([a], context({ asOf: day("2026-04-01") })),
    links({ conflicts: { a: [conflictWith(record({ id: "b", key: "project.b", createdAt: "2026-01-01T00:00:00Z" }))] } }),
    context({ asOf: day("2026-04-01") }));
  assert.deepEqual(later[0].caveats, [], "a question about a time before the pair was recorded is not answered with a disagreement that did not exist");
});

test("a retracted, corrected or lapsed source labels the memory and does not withhold it", () => {
  const entries = versionsInForce([record({ id: "a" }), record({ id: "b", key: "project.b" }), record({ id: "c", key: "project.c" }),
    record({ id: "d", key: "project.d" })], context());
  const labelled = annotateVersions(entries, links({ sources: {
    a: [{ type: "doi", id: "10.1000/x", state: "retracted" }],
    b: [{ type: "knowledge_source", id: `src_${"a".repeat(32)}`, state: "changed" }],
    c: [{ type: "knowledge_source", id: `src_${"b".repeat(32)}`, state: "expired" }, { type: "doi", id: "10.1000/y", state: "retracted" }],
    d: [{ type: "doi", id: "10.1000/z", state: "unknown" }, { type: "doi", id: "10.1000/w", state: "current" }],
  } }), context());
  assert.deepEqual(labelled.map((item) => item.caveats), [["source_retracted"], ["source_changed"], ["source_retracted", "source_expired"], []],
    "a source whose check could not answer is not a finding, and not a clean bill: it raises nothing");
  assert.deepEqual(labelled[2].staleSources.map((source) => source.state), ["expired", "retracted"]);
  assert.equal(labelled.length, 4, "every memory is still served");
});

test("an inference or platform note with nothing behind it says so; the researcher's own word needs no citation", () => {
  const entries = versionsInForce([
    record({ id: "bare_inference", origin: "inferred", evidenceCount: 0, key: "project.a" }),
    record({ id: "bare_note", origin: "system", evidenceCount: 0, key: "project.b" }),
    record({ id: "bare_user", origin: "manual", evidenceCount: 0, key: "project.c" }),
    record({ id: "cited", origin: "inferred", evidenceCount: 2, key: "project.d" }),
    record({ id: "no_count", origin: "inferred", key: "project.e", evidenceCount: undefined }),
  ], context());
  assert.deepEqual(annotateVersions(entries, {}, context()).map((item) => item.caveats),
    [["insufficient_evidence"], ["insufficient_evidence"], [], [], []]);
});

test("a memory with no history of any kind is the memo it always was", () => {
  const [plain] = annotateVersions(versionsInForce([record()], context()), {}, context());
  assert.deepEqual(versionFields(plain), {});
  const [dated] = annotateVersions(versionsInForce([record({ validFrom: "2026-02-01T00:00:00Z" })], context()), {}, context());
  assert.deepEqual(versionFields(dated), { validity: { from: "2026-02-01T00:00:00Z", until: null } });
});

// -------------------------------------------------------------------- asOf

test("a question's time is an ISO date or instant, read at the end of a bare date, or it is not one", () => {
  assert.equal(parseAsOf(null), null);
  assert.equal(parseAsOf(""), null);
  assert.equal(parseAsOf("2025-06-30"), Date.parse("2025-06-30T23:59:59.999Z"));
  assert.equal(parseAsOf("2025-06-30T08:00:00Z"), Date.parse("2025-06-30T08:00:00Z"));
  for (const bad of ["last year", "2025", "2025-13-45", "yesterday", "2025-06-30; drop", 20250630]) {
    assert.equal(parseAsOf(bad), undefined, String(bad));
  }
});
