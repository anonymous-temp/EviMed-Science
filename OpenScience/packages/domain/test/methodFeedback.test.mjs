// The scientific axis of a learned method's record (plan 2026-10-02 §11.3 N14).
//
// What these cases are for: the delivery axis already says whether a run that used a method was accepted. This one says
// what later became of the results that run produced, and the properties that make it worth keeping are the ones a
// careless version would lose: an entry stays under the revision it was made under (so a regression is pinned to one
// body and a rollback goes to the exact one before it), a result that nobody recalculated or corrected is not a trial,
// a replay on a changed engine is not evidence, applicability is unknown until the engine's own diagnostics say
// otherwise, and no summary ever claims the method caused anything.
import assert from "node:assert/strict";
import test from "node:test";

import {
  METHOD_FEEDBACK_LIMIT,
  METHOD_FEEDBACK_POLARITY,
  METHOD_FEEDBACK_SIGNALS,
  METHOD_LINK_LIMIT,
  appendMethodLink,
  cleanMethodScope,
  diagnosticApplicability,
  emptyLearning,
  emptyScientific,
  feedbackSignalFromCorrection,
  feedbackSignalFromReplay,
  foldMethodFeedback,
  methodHarmTest,
  mergeMethodResultLinks,
  methodScientific,
  projectMethodFeedback,
  projectMethodLink,
  projectMethodResultLinks,
  retirementProposal,
  scientificOutcomes,
  scientificRegression,
} from "@evimed/domain";

/** @param {string} character @param {number} [length] */
const hex = (character, length = 64) => character.repeat(length);
const A = `sha256:${hex("a")}`;
const B = `sha256:${hex("b")}`;
const C = `sha256:${hex("c")}`;
/** @param {number} n */
const version = (n) => `rv_${String(n).padStart(64, "0")}`;
/** @param {number} n */
const entryId = (n) => `sf_${String(n).padStart(32, "0")}`;
let counter = 0;

/**
 * One entry, as the join writes it.
 * @param {{ signal?: string, digest?: string, result?: number, at?: string | null, applicability?: any, kind?: string | null }} [options]
 */
function entry({ signal = "replay_differed", digest = A, result = counter + 1, at = null, applicability = null, kind = null } = {}) {
  counter += 1;
  return { id: entryId(counter), signal, at: at ?? new Date(Date.UTC(2026, 9, 4, 0, counter)).toISOString(), digest, used: "invoked", runId: "run-1",
    result: { versionId: version(result), digest: hex("d") }, successor: null, replay: null, event: null, kind, applicability: applicability ?? { state: "unknown", basis: "none", codes: [] } };
}

/** @param {...any} entries */
const record = (...entries) => entries.reduce((scientific, item) => foldMethodFeedback(scientific, item), emptyScientific());

test("a correction is the signal its kind says, and a kind nobody knows is unreadable, not a finding", () => {
  assert.equal(feedbackSignalFromCorrection({ kind: "analytic" }), "analytic_corrected");
  assert.equal(feedbackSignalFromCorrection({ kind: "evidence" }), "evidence_corrected");
  assert.equal(feedbackSignalFromCorrection({ kind: "presentation" }), "presentation_corrected");
  assert.equal(feedbackSignalFromCorrection({ kind: "unknown" }), "correction_unreadable");
  assert.equal(feedbackSignalFromCorrection({ kind: "toString" }), "correction_unreadable");
  assert.equal(feedbackSignalFromCorrection(null), "correction_unreadable");
  // A restyled figure and a comparison nobody could make point nowhere.
  assert.equal(METHOD_FEEDBACK_POLARITY.presentation_corrected, "neutral");
  assert.equal(METHOD_FEEDBACK_POLARITY.correction_unreadable, "neutral");
  assert.deepEqual(Object.keys(METHOD_FEEDBACK_POLARITY).sort(), [...METHOD_FEEDBACK_SIGNALS].sort());
});

test("only a recalculation on what the original ran on is evidence; a changed engine and unassessed numbers are neither agreement nor error", () => {
  const same = { environment: { status: "same" } };
  assert.deepEqual(feedbackSignalFromReplay({ ...same, numbers: { status: "identical" } }), { signal: "replay_agreed", numbers: "identical", reason: null });
  assert.equal(feedbackSignalFromReplay({ ...same, numbers: { status: "within-tolerance" } }).signal, "replay_agreed");
  assert.deepEqual(feedbackSignalFromReplay({ ...same, numbers: { status: "changed" } }), { signal: "replay_differed", numbers: "changed", reason: null });
  // The original's numbers and the replay's differ, but the replay ran on another engine: the difference may be the engine's.
  assert.deepEqual(feedbackSignalFromReplay({ environment: { status: "differs", changed: ["code"] }, numbers: { status: "changed" } }),
    { signal: null, numbers: null, reason: "environment_differs" });
  assert.equal(feedbackSignalFromReplay({ numbers: { status: "identical" } }).reason, "environment_unknown");
  assert.equal(feedbackSignalFromReplay({ ...same, numbers: { status: "not-assessed" } }).reason, "not_assessed");
  assert.equal(feedbackSignalFromReplay({ ...same }).reason, "not_assessed");
  assert.equal(feedbackSignalFromReplay(null).reason, "no_comparison");
});

test("applicability is unknown until the engine's own diagnostics say otherwise, and unflagged is not applicable", () => {
  const known = ["few_studies", "tau_squared_at_boundary"];
  assert.deepEqual(diagnosticApplicability({ raised: undefined, known }), { state: "unknown", basis: "none", codes: [] });
  assert.deepEqual(diagnosticApplicability({ raised: { few_studies: true }, known }), { state: "unknown", basis: "none", codes: [] });
  assert.deepEqual(diagnosticApplicability({ raised: [], known }), { state: "unflagged", basis: "engine_diagnostics", codes: [] });
  assert.deepEqual(diagnosticApplicability({ raised: [{ code: "few_studies", detail: "n=2" }, "few_studies", { code: "tau_squared_at_boundary" }], known }),
    { state: "flagged", basis: "engine_diagnostics", codes: ["few_studies", "tau_squared_at_boundary"] });
  // The vocabulary is the method record's: a code it does not list is not read.
  assert.deepEqual(diagnosticApplicability({ raised: [{ code: "made_up_by_the_engine" }], known }), { state: "unflagged", basis: "engine_diagnostics", codes: [] });
  assert.deepEqual(diagnosticApplicability({ raised: [{ code: "few_studies" }], known: null }), { state: "unflagged", basis: "engine_diagnostics", codes: [] });
});

test("an entry names what it is about, or it is not an entry", () => {
  const good = entry();
  assert.equal(projectMethodFeedback(good).signal, "replay_differed");
  assert.equal(projectMethodFeedback(good).used, "invoked");
  for (const broken of [{ ...good, id: "x" }, { ...good, signal: "approved" }, { ...good, digest: "abc" }, { ...good, at: "yesterday" },
    { ...good, result: { versionId: "rv_1", digest: hex("d") } }, { ...good, result: { versionId: version(1), digest: "no" } }, null]) {
    assert.throws(() => projectMethodFeedback(broken));
  }
  // What it does not know stays what it does not know.
  const cut = projectMethodFeedback({ ...good, kind: "something else", applicability: { state: "applicable", codes: ["x"] }, successor: { versionId: "nope" } });
  assert.equal(cut.kind, null);
  assert.deepEqual(cut.applicability, { state: "unknown", basis: "none", codes: [] });
  assert.equal(cut.successor, null);
  // Codes of a flagged entry are kept in their closed shape only.
  const flagged = projectMethodFeedback({ ...good, applicability: { state: "flagged", codes: ["few_studies", "Not A Code", 7] } });
  assert.deepEqual(flagged.applicability, { state: "flagged", basis: "engine_diagnostics", codes: ["few_studies"] });
});

test("an entry of an identity the record holds is added once, and the oldest go when it is full", () => {
  const first = entry();
  const once = foldMethodFeedback(emptyScientific(), first);
  assert.equal(foldMethodFeedback(once, first), once);
  assert.equal(once.entries.length, 1);
  let full = emptyScientific();
  for (let index = 0; index < METHOD_FEEDBACK_LIMIT + 5; index += 1) full = foldMethodFeedback(full, entry({ result: 1000 + index }));
  assert.equal(full.entries.length, METHOD_FEEDBACK_LIMIT);
  assert.equal(full.entries.at(-1).result.versionId, version(1000 + METHOD_FEEDBACK_LIMIT + 4));
  assert.equal(foldMethodFeedback(null, first).entries.length, 1);
});

test("an outcome is one per result version, in the order it was learned, under the revision it was made under", () => {
  const record1 = record(
    entry({ signal: "replay_agreed", result: 1, at: "2026-10-01T00:00:00.000Z" }),
    // The same version, corrected later: against outranks the recalculation that agreed.
    entry({ signal: "analytic_corrected", result: 1, at: "2026-10-02T00:00:00.000Z" }),
    entry({ signal: "replay_agreed", result: 2, at: "2026-10-01T12:00:00.000Z" }),
    // Not read: a restyle, and another revision's.
    entry({ signal: "presentation_corrected", result: 3 }),
    entry({ signal: "replay_differed", result: 4, digest: B }),
  );
  assert.deepEqual(scientificOutcomes(record1, A).map((item) => [item.versionId, item.polarity]),
    [[version(2), "supports"], [version(1), "against"]]);
  assert.deepEqual(scientificOutcomes(record1, B).map((item) => item.polarity), ["against"]);
  assert.deepEqual(scientificOutcomes(record1, C), []);
  assert.deepEqual(scientificOutcomes(null, A), []);
});

test("a summary says what happened and never what caused it", () => {
  const scientific = record(
    entry({ signal: "replay_agreed", result: 1, applicability: { state: "unflagged", basis: "engine_diagnostics", codes: [] } }),
    entry({ signal: "evidence_corrected", result: 2, kind: "evidence" }),
    entry({ signal: "replay_agreed", result: 3, applicability: { state: "flagged", basis: "engine_diagnostics", codes: ["few_studies"] } }),
    entry({ signal: "presentation_corrected", result: 4 }),
  );
  const summary = methodScientific(scientific, A);
  assert.equal(summary.results, 4);
  assert.equal(summary.supports, 2);
  assert.equal(summary.against, 1);
  assert.equal(summary.assessed, 3);
  assert.equal(summary.neutral, 1);
  assert.equal(summary.causalBenefit, "unproven");
  assert.equal(summary.applicability, "flagged");
  assert.deepEqual(summary.limits.map((item) => item.codes), [["few_studies"]]);
  assert.deepEqual(summary.counterexamples.map((item) => [item.versionId, item.signal, item.kind]), [[version(2), "evidence_corrected", "evidence"]]);
  // Nothing recorded is not "applicable" and not "benefit shown".
  const none = methodScientific(emptyScientific(), A);
  assert.deepEqual([none.results, none.assessed, none.applicability, none.causalBenefit], [0, 0, "unknown", "unproven"]);
  assert.equal(methodScientific(scientific, B).applicability, "unknown");
});

test("results nobody recalculated or corrected are not trials, and agreement alone never reads as a regression", () => {
  assert.equal(scientificRegression({ digest: A, scientific: emptyScientific() }).state, "watching");
  // One correction is something to watch, not a regression: the test needs its minimum number of results, and three corrections in a row are not enough.
  assert.equal(scientificRegression({ digest: A, scientific: record(entry({ signal: "analytic_corrected", result: 1 })) }).state, "watching");
  assert.equal(scientificRegression({ digest: A, scientific: record(...[1, 2, 3].map((n) => entry({ signal: "analytic_corrected", result: n }))) }).state, "watching");
  // A trusted agreement between the corrections takes weight back: three of the first five is not four of four.
  assert.equal(scientificRegression({ digest: A, scientific: record(...["analytic_corrected", "replay_agreed", "analytic_corrected", "analytic_corrected", "replay_agreed", "analytic_corrected"]
    .map((signal, n) => entry({ signal, result: n + 1 }))) }).state, "watching");
  const agreed = record(...[1, 2, 3, 4, 5].map((n) => entry({ signal: "replay_agreed", result: n })));
  assert.notEqual(scientificRegression({ digest: A, scientific: agreed }).state, "regression");
  // A method nobody corrected or recalculated has no regression, whatever its delivery record says.
  assert.equal(scientificRegression({ digest: A, scientific: record(entry({ signal: "presentation_corrected", result: 1 })) }).action, null);
});

test("four results found wrong under one body are a regression of that body, answered with the exact earlier body that is not itself harmful", () => {
  const scientific = record(
    // The earlier body A: results that held.
    entry({ signal: "replay_agreed", result: 1, digest: A }), entry({ signal: "replay_agreed", result: 2, digest: A }),
    // The current body B.
    entry({ signal: "replay_differed", result: 3, digest: B }), entry({ signal: "analytic_corrected", result: 4, digest: B }), entry({ signal: "evidence_corrected", result: 5, digest: B }),
    entry({ signal: "analytic_corrected", result: 6, digest: B }));
  // Three are not enough: a correction is ordinary work, and the background rate this axis is tested against says so.
  const three = record(...scientific.entries.slice(0, 5));
  assert.equal(scientificRegression({ digest: B, revisions: [B, A], scientific: three }).state, "watching");
  const decided = scientificRegression({ digest: B, revisions: [B, A], scientific });
  assert.equal(decided.state, "regression");
  assert.equal(decided.action, "rollback");
  assert.equal(decided.rollbackToDigest, A);
  assert.equal(decided.harm.bad, 4);
  assert.equal(decided.evidence.length, 4);
  // The earlier body's own record is what is read, never the current body's: A is not itself harmful.
  assert.notEqual(scientificRegression({ digest: A, revisions: [B, A], scientific }).state, "regression");
});

test("a body its first trusted recalculations cleared still regresses on the corrections that follow", () => {
  // Until 2026-11-03 three agreements first read clear and nothing after them was read (audit D3).
  const agreed = [1, 2, 3].map((n) => entry({ signal: "replay_agreed", result: n }));
  assert.equal(scientificRegression({ digest: A, scientific: record(...agreed) }).state, "clear");
  const corrected = (/** @type {number} */ count) => record(...agreed, ...Array.from({ length: count }, (_, n) => entry({ signal: "analytic_corrected", result: 10 + n })));
  assert.equal(scientificRegression({ digest: A, scientific: corrected(5) }).state, "watching");
  const decided = scientificRegression({ digest: A, scientific: corrected(6) });
  assert.deepEqual([decided.state, decided.action, decided.harm.runs, decided.harm.bad], ["regression", "retire", 9, 6]);
});

/** Seeded generator: every rate below is reproducible. @param {number} seed */
const mulberry32 = (seed) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
/** One result's trial as the whole record reads it, in order: the delivery axis's test over every version. @param {readonly boolean[]} against */
const wholeRecord = (against) => methodHarmTest({ ...emptyLearning(A), observations: against.map((bad, index) => ({
  runId: `v${index}`, family: `v${index}`, outcome: bad ? "rejected" : "accepted", invoked: true, at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() })) });

test("a record longer than it keeps is read whole: what it let go of is carried and read first, and a replay of it changes nothing", () => {
  // Review of 2026-11-03: the record kept its last sixty entries and nothing of the rest, so the test read a window that slid.
  const random = mulberry32(31);
  const against = Array.from({ length: 300 }, () => random() < 0.25);
  /** @type {any[]} */
  const entries = [];
  let scientific = emptyScientific();
  against.forEach((bad, index) => {
    const made = entry({ signal: bad ? "analytic_corrected" : "replay_agreed", result: 5000 + index });
    entries.push(made);
    scientific = foldMethodFeedback(scientific, made);
    // An earlier body's results, interleaved: kept under their own digest.
    if (index % 10 === 0) scientific = foldMethodFeedback(scientific, entry({ signal: "replay_differed", digest: B, result: 9000 + index }));
  });
  assert.ok(scientific.entries.length <= METHOD_FEEDBACK_LIMIT);
  const read = scientificRegression({ digest: A, scientific });
  const whole = wholeRecord(against);
  assert.deepEqual([read.harm.state, read.harm.runs, read.harm.bad], [whole.state, whole.runs, whole.bad]);
  assert.deepEqual([methodScientific(scientific, A).results, methodScientific(scientific, A).assessed, methodScientific(scientific, A).against],
    [300, 300, against.filter(Boolean).length], "the counts are the whole record's");
  assert.equal(methodScientific(scientific, B).against, 30);
  assert.equal(scientificRegression({ digest: B, scientific }).state, "regression", "an earlier body's results are read whole too");
  // A join that replays an entry the record let go of, and a later signal on a result it let go of, change nothing.
  assert.equal(foldMethodFeedback(scientific, entries[0]), scientific);
  assert.equal(foldMethodFeedback(scientific, entry({ signal: "evidence_corrected", result: 5000 })), scientific);
  // A result with two signals goes whole and is read as one trial, against.
  let pair = emptyScientific();
  pair = foldMethodFeedback(pair, entry({ signal: "replay_agreed", result: 1 }));
  pair = foldMethodFeedback(pair, entry({ signal: "analytic_corrected", result: 1 }));
  for (let index = 0; index < METHOD_FEEDBACK_LIMIT; index += 1) pair = foldMethodFeedback(pair, entry({ signal: "replay_agreed", result: 100 + index }));
  assert.equal(pair.entries.some((/** @type {any} */ item) => item.result.versionId === version(1)), false);
  assert.deepEqual([methodScientific(pair, A).results, methodScientific(pair, A).against, methodScientific(pair, A).supports], [61, 1, 60]);
});

test("a harmless revision read after every result is not rolled back more often as its record grows", () => {
  // At the 25% background rate the window of sixty rolled back a third of harmless revisions by the hundredth result and 92% by the three
  // hundredth (review of 2026-11-03). Read whole, the chance is the test's own: 4.31% however long (`methodHarmTest`).
  const random = mulberry32(1103);
  const histories = 200;
  let regressed = 0;
  for (let history = 0; history < histories; history += 1) {
    let scientific = emptyScientific();
    for (let index = 0; index < 300; index += 1) {
      scientific = foldMethodFeedback(scientific, entry({ signal: random() < 0.25 ? "analytic_corrected" : "replay_agreed", result: 100_000 + history * 1000 + index }));
      // What production does: the lifecycle reads the record after every entry the join adds (`MethodFeedbackService`).
      if (scientificRegression({ digest: A, scientific }).state === "regression") { regressed += 1; break; }
    }
  }
  assert.ok(regressed <= 20, `${regressed} of ${histories} harmless revisions read as a regression`);
});

test("the newest earlier body that is itself harmful is passed over, and a method with no sound body is stopped, not returned to one", () => {
  /** @param {string} digest @param {number} first */
  const harmful = (digest, first) => [1, 2, 3, 4].map((n) => entry({ signal: "replay_differed", result: first + n, digest }));
  const scientific = record(...harmful(A, 10), ...harmful(B, 20), ...harmful(C, 30));
  assert.equal(scientificRegression({ digest: C, revisions: [C, B, A], scientific }).action, "retire");
  assert.equal(scientificRegression({ digest: C, revisions: [C, B, A], scientific }).rollbackToDigest, null);
  const oneSound = record(...harmful(B, 20), ...harmful(C, 30), entry({ signal: "replay_agreed", result: 40, digest: A }));
  const decided = scientificRegression({ digest: C, revisions: [C, B, A], scientific: oneSound });
  assert.deepEqual([decided.action, decided.rollbackToDigest], ["rollback", A]);
  // With no earlier body at all there is nothing to return to.
  assert.deepEqual([scientificRegression({ digest: C, revisions: [C], scientific: record(...harmful(C, 50)) }).action,
    scientificRegression({ digest: C, scientific: record(...harmful(C, 60)) }).action], ["retire", "retire"]);
});

test("the lifecycle reads the scientific axis beside the delivery axis, and a researcher's own method is proposed for a stop, never made one", () => {
  const harmful = record(...[1, 2, 3, 4].map((n) => entry({ signal: "replay_differed", result: n, digest: B })));
  const base = { id: "method:learned:m", name: "m", digest: B, status: "approved", dependencies: [], learning: emptyLearning(B),
    provenance: { origin: "inferred" }, scientific: harmful, revisions: [B, A] };
  const proposal = retirementProposal(base, { nowMs: Date.UTC(2026, 9, 5) });
  assert.deepEqual([proposal.propose, proposal.immediate, proposal.code, proposal.action, proposal.rollbackToDigest], [true, true, "scientific_regression", "rollback", A]);
  assert.equal(proposal.rejected, 4);
  assert.match(proposal.reason, /association, not cause/);
  const explicit = retirementProposal({ ...base, provenance: { origin: "explicit" } }, { nowMs: Date.UTC(2026, 9, 5) });
  assert.deepEqual([explicit.propose, explicit.immediate, explicit.code], [true, false, "scientific_regression"]);
  // No scientific record: the lifecycle is what it was.
  assert.notEqual(retirementProposal({ ...base, scientific: undefined }, { nowMs: Date.UTC(2026, 9, 5) }).code, "scientific_regression");
  // A record about another body does not retire this one.
  assert.notEqual(retirementProposal({ ...base, digest: C, revisions: [C, B, A], learning: emptyLearning(C) }, { nowMs: Date.UTC(2026, 9, 5) }).code, "scientific_regression");
  // An incident and a measured `worse` still come first.
  assert.equal(retirementProposal({ ...base, provenance: { origin: "inferred", incident: true } }, { nowMs: 0 }).code, "incident");
});

test("a declared scope is the distillation's own words, bounded, and a sensitive line never reaches the record", () => {
  assert.equal(cleanMethodScope(null), null);
  assert.equal(cleanMethodScope({ applicability: "", counterexamples: [] }), null);
  const scope = cleanMethodScope({ applicability: "  A random-effects pool of\n trials.  ", counterexamples: ["Fewer than three studies.", "", 7, "x".repeat(900)] });
  assert.ok(scope);
  assert.equal(scope.applicability, "A random-effects pool of trials.");
  assert.equal(scope.counterexamples.length, 2);
  assert.equal(scope.counterexamples[1].length, 300);
  assert.equal(cleanMethodScope({ applicability: "Use the password of the registry.", counterexamples: ["Fewer than three studies."] })?.applicability, "");
  assert.equal(cleanMethodScope({ counterexamples: Array.from({ length: 20 }, (_, index) => `case ${index}`) })?.counterexamples.length, 8);
});

test("the results a method was learnt from are immutable identities, once each, and the list is bounded", () => {
  const links = projectMethodResultLinks([
    { role: "original", versionId: version(1), digest: hex("a") }, { role: "original", versionId: version(1), digest: hex("a") },
    { role: "successor", versionId: version(2) }, { role: "adopted", versionId: version(3) }, { role: "original", versionId: "rv_short" }, null]);
  assert.deepEqual(links.map((item) => [item.role, item.versionId]), [["original", version(1)], ["successor", version(2)]]);
  assert.equal(links[1].digest, null);
  const merged = mergeMethodResultLinks(links, [{ role: "original", versionId: version(1) }, { role: "original", versionId: version(9) }]);
  assert.deepEqual(merged.map((item) => item.versionId), [version(1), version(2), version(9)]);
  assert.equal(mergeMethodResultLinks(Array.from({ length: 8 }, (_, n) => ({ role: "original", versionId: version(n + 1) })),
    [{ role: "original", versionId: version(99) }]).at(-1)?.versionId, version(99));
});

test("a revision link names what was left, and the list keeps the newest", () => {
  const link = { type: "rolled_back_for_regression", at: "2026-10-05T00:00:00.000Z", fromDigest: B, toDigest: A, results: 5, against: 3, evidence: [entryId(1), "nope"] };
  assert.deepEqual(projectMethodLink(link), { ...link, evidence: [entryId(1)] });
  assert.throws(() => projectMethodLink({ ...link, type: "deleted" }));
  assert.throws(() => projectMethodLink({ ...link, fromDigest: "x" }));
  /** @type {any[]} */
  let links = [];
  for (let index = 0; index < METHOD_LINK_LIMIT + 3; index += 1) links = appendMethodLink(links, { ...link, results: index });
  assert.equal(links.length, METHOD_LINK_LIMIT);
  assert.equal(links.at(-1).results, METHOD_LINK_LIMIT + 2);
  // A stored link that is no longer readable is dropped, not fatal.
  assert.equal(appendMethodLink([{ type: "nonsense" }], link).length, 1);
});
