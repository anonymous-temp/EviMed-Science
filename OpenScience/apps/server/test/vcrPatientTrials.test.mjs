// 「给患者找试验」 (the patient → trials direction of matching): the parts that are exact operations and
// need no database: where a criterion's wording stands in a record, how the registry's words are ranked and labelled, and how a
// patient's trials are ordered.
import assert from "node:assert/strict";
import test from "node:test";

import { decidedShare } from "../src/vcrMatching.mjs";
import {
  criterionRanking, createPatientTrials, locateSourceText, phaseLabel, rankPatientTrials,
  registryStatusLabel, registryStatusRank,
} from "../src/vcrPatientTrials.mjs";

const ELIGIBILITY = "Inclusion Criteria:\n\n1. Male or female, aged at least 18 years.\n2. Pathologically confirmed adenocarcinoma of the lung.\n\nExclusion Criteria:\n* Prior   treatment\n  with docetaxel.";

test("the platform finds where a criterion's original wording stands in the record's eligibility text", () => {
  const first = locateSourceText("Male or female, aged at least 18 years.", ELIGIBILITY);
  assert.deepEqual(first, { start: ELIGIBILITY.indexOf("Male or female"), end: ELIGIBILITY.indexOf("Male or female") + "Male or female, aged at least 18 years.".length });
  // A list marker in front is the list's, not the wording's; whitespace is folded the way the record folds it.
  assert.ok(locateSourceText("1. Pathologically confirmed adenocarcinoma of the lung.", ELIGIBILITY));
  const folded = locateSourceText("Prior treatment with docetaxel.", ELIGIBILITY);
  assert.equal(ELIGIBILITY.slice(folded.start, folded.end), "Prior   treatment\n  with docetaxel.");
  // Words the record does not contain are not located; nothing is guessed from a near match.
  assert.equal(locateSourceText("Prior treatment with paclitaxel.", ELIGIBILITY), null);
  assert.equal(locateSourceText("", ELIGIBILITY), null);
  assert.equal(locateSourceText("anything", ""), null);
});

test("the wording is compared as the record spells it: case, spacing, >= against ≥, dashes and quotation marks are the same, a near match is not", () => {
  const record = "Inclusion Criteria:\n* Patients must provide Written Informed Consent\n* Age >= 18 years\n* ECOG 0\u20131 (\"fit\")\n* Hb <= 9 g/dL";
  const at = (/** @type {string} */ wording) => locateSourceText(wording, record);
  const spanOf = (/** @type {string} */ wording) => { const found = at(wording); return found && record.slice(found.start, found.end); };
  assert.equal(spanOf("written informed consent"), "Written Informed Consent", "the span is the record's own characters");
  assert.equal(spanOf("Age ≥ 18 years"), "Age >= 18 years", "the span of a two-character >= is two characters");
  assert.equal(spanOf("hb ≤ 9 g/dl"), "Hb <= 9 g/dL");
  assert.equal(spanOf("ECOG 0-1 (\u201Cfit\u201D)"), "ECOG 0\u20131 (\"fit\")", "a hyphen is an en dash, curly quotes are straight ones");
  assert.equal(spanOf("Age\u00A0 \u2265\n18 years"), "Age >= 18 years", "a no-break space is whitespace");
  assert.equal(spanOf("1. Age ≥ 18 years"), "Age >= 18 years", "a list marker in front is the list's");
  assert.equal(at("Age > 18 years"), null);
  assert.equal(at("Adults aged 18 years or more"), null);
  assert.equal(at("Age 18 years"), null);
});

// ---------------------------------------------------------------------------
// The ranking: arithmetic over the evaluator's counts, and nothing a model said
// ---------------------------------------------------------------------------

/** One trial of a patient's list, as the evaluator's verdict makes it. */
const entry = (id, summary, counts = {}, extra = {}) => ({
  id, title: extra.title ?? id, status: extra.status ?? "RECRUITING",
  summary, counts: summary === null ? null : { satisfied: 0, not_satisfied: 0, unknown: 0, pending_recheck: 0, ...counts }, ...extra,
});

test("all criteria met comes first, then the fewest unknown or pending, then the excluded; a trial not yet evaluated is last", () => {
  const ranked = rankPatientTrials([
    entry("excluded", "ineligible", { not_satisfied: 1, satisfied: 6 }),
    entry("two-open", "insufficient_evidence", { unknown: 2 }),
    entry("none", null),
    entry("met", "eligible", { satisfied: 8 }),
    entry("one-open", "insufficient_evidence", { unknown: 1 }),
    entry("waiting", "pending", { pending_recheck: 1 }),
  ]);
  assert.deepEqual(ranked.map((row) => row.id), ["met", "one-open", "waiting", "two-open", "excluded", "none"]);
  assert.deepEqual(ranked.map((row) => row.rank), [1, 2, 3, 4, 5, 6]);
});

test("an unknown and a date to wait for are both a criterion still to settle: they are counted together", () => {
  const ranked = rankPatientTrials([
    entry("one-unknown-one-pending", "insufficient_evidence", { unknown: 1, pending_recheck: 1 }),
    entry("two-pending", "pending", { pending_recheck: 2 }),
    entry("one-unknown", "insufficient_evidence", { unknown: 1 }),
  ]);
  assert.deepEqual(ranked.map((row) => row.id), ["one-unknown", "one-unknown-one-pending", "two-pending"]);
});

test("within the trials the patient is not excluded from, the share of criteria decided comes first: few parsed criteria do not rise above a well-decided trial (M5)", () => {
  const ranked = rankPatientTrials([
    // Two parsed criteria and neither answered: only two open, which used to put it above a trial with seven of ten answered.
    entry("thin", "insufficient_evidence", { unknown: 2 }),
    entry("well-decided", "insufficient_evidence", { satisfied: 7, unknown: 3 }),
    entry("half", "insufficient_evidence", { satisfied: 1, unknown: 1 }),
    entry("half-more", "insufficient_evidence", { satisfied: 5, unknown: 5 }),
    entry("waiting", "pending", { satisfied: 4, pending_recheck: 1 }),
    entry("met-few", "eligible", { satisfied: 1 }),
    entry("met-many", "eligible", { satisfied: 9 }),
    entry("excluded-sure", "ineligible", { not_satisfied: 2, satisfied: 8 }),
    entry("excluded-thin", "ineligible", { not_satisfied: 1, unknown: 4 }),
    entry("none", null),
  ]);
  assert.deepEqual(ranked.map((row) => row.id), ["met-many", "met-few", "waiting", "well-decided", "half-more", "half", "thin", "excluded-sure", "excluded-thin", "none"]);
});

test("the decided share counts unknown and waiting criteria in its denominator and a criterion that does not apply in neither part", () => {
  assert.deepEqual(decidedShare({ satisfied: 7, not_satisfied: 1, unknown: 1, pending_recheck: 1, notApplicable: 4, total: 14 }), { decided: 8, applicable: 10, percent: 80 });
  assert.deepEqual(decidedShare({ unknown: 2 }), { decided: 0, applicable: 2, percent: 0 });
  assert.deepEqual(decidedShare({ satisfied: 1 }), { decided: 1, applicable: 1, percent: 100 });
  assert.deepEqual(decidedShare(null), { decided: 0, applicable: 0, percent: 0 });
  assert.deepEqual(decidedShare({ satisfied: "x", unknown: -3 }), { decided: 0, applicable: 0, percent: 0 }, "what is not a count is not counted");
});

test("ties go to the registry's status (recruiting first), then the title, then the id", () => {
  const ranked = rankPatientTrials([
    entry("c", "eligible", {}, { status: "COMPLETED", title: "Alpha" }),
    entry("d", "eligible", {}, { status: "NOT_YET_RECRUITING", title: "Zeta" }),
    entry("b", "eligible", {}, { status: "RECRUITING", title: "beta" }),
    entry("a", "eligible", {}, { status: "RECRUITING", title: "Alpha" }),
    entry("e", "eligible", {}, { status: "RECRUITING", title: "Alpha" }),
    entry("own", "eligible", {}, { status: "", title: "本研究方案" }),
  ]);
  assert.deepEqual(ranked.map((row) => row.id), ["a", "e", "b", "d", "own", "c"],
    "a trial with no registry status is the study's own, ranked after what is open and before what is closed");
});

test("the ranking is a function of the verdicts alone: the same list in any order is the same list", () => {
  const rows = [
    entry("1", "eligible", {}, { title: "B" }), entry("2", "insufficient_evidence", { unknown: 3 }, { title: "A" }),
    entry("3", "ineligible", { not_satisfied: 2 }, { title: "C" }), entry("4", "eligible", {}, { title: "A", status: "COMPLETED" }),
  ];
  const expected = rankPatientTrials(rows).map((row) => row.id);
  for (const shuffled of [[...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]], [rows[1], rows[3], rows[0], rows[2]]]) {
    assert.deepEqual(rankPatientTrials(shuffled).map((row) => row.id), expected);
  }
  assert.deepEqual(rankPatientTrials([]), []);
});

test("a registry's words for where a trial stands are read through a closed table: recruiting first, closed last, anything else after the open ones", () => {
  const order = ["RECRUITING", "Recruiting", "recruiting", "NOT_YET_RECRUITING", "Not yet recruiting", "ENROLLING_BY_INVITATION", "ACTIVE_NOT_RECRUITING", "Ongoing, recruiting",
    "COMPLETED", "TERMINATED", "WITHDRAWN"].map(registryStatusRank);
  assert.equal(order[0], order[1]);
  assert.equal(order[1], order[2]);
  assert.ok(registryStatusRank("RECRUITING") < registryStatusRank("NOT_YET_RECRUITING"));
  assert.ok(registryStatusRank("NOT_YET_RECRUITING") < registryStatusRank("ENROLLING_BY_INVITATION"));
  assert.ok(registryStatusRank("ENROLLING_BY_INVITATION") < registryStatusRank("ACTIVE_NOT_RECRUITING"));
  assert.ok(registryStatusRank("ACTIVE_NOT_RECRUITING") < registryStatusRank("") && registryStatusRank("") < registryStatusRank("COMPLETED"));
  assert.ok(registryStatusRank("some word the registry made up") < registryStatusRank("COMPLETED"), "a status this table does not know is not read as closed");
  assert.ok(registryStatusRank("COMPLETED") <= registryStatusRank("TERMINATED"));
  assert.equal(registryStatusRank("Authorised, recruiting"), registryStatusRank("RECRUITING"));
  assert.equal(registryStatusLabel("RECRUITING"), "招募中");
  assert.equal(registryStatusLabel("NOT_YET_RECRUITING"), "尚未开始招募");
  assert.equal(registryStatusLabel("COMPLETED"), "已完成");
  assert.equal(registryStatusLabel("some word the registry made up"), "some word the registry made up", "an unknown word is shown as the registry wrote it");
  assert.equal(registryStatusLabel(""), "");
  assert.equal(phaseLabel("PHASE2"), "II 期");
  assert.equal(phaseLabel("PHASE1/PHASE2"), "I/II 期");
  assert.equal(phaseLabel("EARLY_PHASE1"), "早期 I 期");
  assert.equal(phaseLabel("NA"), "不适用");
  assert.equal(phaseLabel("Ⅲ期"), "Ⅲ期", "a ChiCTR phase is shown as it was registered");
  assert.equal(phaseLabel(""), "");
});

test("criterion ranking uses normalized exclusion judgments and retains unknowns", () => {
  const criteria = [{ id: "i", kind: "inclusion" }, { id: "e", kind: "exclusion" }, { id: "u", kind: "inclusion" }, { id: "n", kind: "exclusion" }];
  const result = criterionRanking(criteria, [{ criterionId: "i", applicable: true, state: "satisfied" }, { criterionId: "e", applicable: true, state: "not_satisfied" }, { criterionId: "n", applicable: false, state: "not_satisfied" }]);
  assert.equal(result.inclusionSatisfied, 1);
  assert.equal(result.decisiveFailures, 1);
  assert.equal(result.unknown, 1);
  assert.equal(result.notApplicable, 1);
  assert.equal(result.score, 0);
});

test("persisted criterion scores order equal eligibility tiers without changing the verdict", () => {
  const mk = (id, summary, judgments) => ({ ...entry(id, summary, {}), ranking: criterionRanking(
    [{ id: "i", kind: "inclusion" }, { id: "e", kind: "exclusion" }], judgments) });
  const yes = (criterionId) => ({ criterionId, applicable: true, state: "satisfied" });
  const no = (criterionId) => ({ criterionId, applicable: true, state: "not_satisfied" });
  const rows = rankPatientTrials([
    mk("failure", "ineligible", [yes("i"), no("e")]),
    mk("partial", "eligible", [yes("i")]),
    mk("complete", "eligible", [yes("i"), yes("e")]),
  ]);
  assert.deepEqual(rows.map(row => row.id), ["complete", "partial", "failure"]);
  assert.equal(rows[1].summary, "eligible");
  assert.equal(rows[1].ranking.unknown, 1);
});

test("patient runtime ranking pages retain global rank on later pages", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, kind: "registry", rank: i + 1, registryId: `NCT${i}`, summary: "insufficient_evidence", counts: { unknown: 1 }, evidenceGaps: [] }));
  const { matchingInputDigest } = await import("../src/vcrMatching.mjs");
  const criteria = rows.map(row => ({ candidateTrialId: row.id, id: `c${row.id}`, ordinal: 1, kind: "inclusion", sourceText: "consent", requirement: { op: "language", key: `key-${row.id}` },
    ...(row.id === "t50" ? { applicability: { op: "language", key: "applicable-t50", text: "Does this condition apply?" } } : {}) }));
  for (const row of rows) row.snapshotHash = matchingInputDigest({ criteria: criteria.filter(c => c.candidateTrialId === row.id), judgments: [] });
  const store = {
    async rankingSnapshot() { return { assessments: rows.map(row => ({ candidateTrialId: row.id, id: row.assessmentId })), criteria, judgments: [] }; },
    async languageAnswersForTrials(_study, _subject, ids) { return new Map(ids.map(id => [id, new Set()])); },
  };
  const service = createPatientTrials({ candidateStore: store });
  service.ranked = async () => rows;
  service.unjudged = async () => [];
  const first = await service.runtimeRead({ id: "study" }, { subjectKey: "P" });
  const last = await service.runtimeRead({ id: "study" }, { subjectKey: "P", offset: 50 });
  assert.equal(first.ranking.length, 50); assert.equal(first.more, true); assert.equal(first.total, 51);
  assert.equal(last.ranking[0].rank, 51); assert.equal(last.more, false);
  assert.equal("requests" in last, false, "no write can answer a language request any more, so none is offered");
});

test("a ranking read whose assessments changed while it was read is refused as changed", async () => {
  const { matchingInputDigest } = await import("../src/vcrMatching.mjs");
  const criteria = [
    { id: "not-applicable", candidateTrialId: "trial", kind: "inclusion",
      applicability: { op: "language", key: "premise-no", text: "For women" },
      requirement: { op: "language", key: "requirement-no", text: "Pregnancy test" } },
    { id: "unresolved", candidateTrialId: "trial", kind: "inclusion",
      applicability: { op: "language", key: "premise-unknown", text: "For adults" },
      requirement: { op: "language", key: "requirement-unknown", text: "Consent" } },
    { id: "stale", candidateTrialId: "trial", kind: "inclusion",
      requirement: { op: "language", key: "old-assessment-only", text: "A different condition" } },
    { id: "shared-no", candidateTrialId: "trial", kind: "inclusion",
      requirement: { op: "language", key: "shared", text: "Same language question" } },
    { id: "shared-yes", candidateTrialId: "trial", kind: "inclusion",
      requirement: { op: "language", key: "shared", text: "Same language question" } },
  ];
  const judgments = [
    { assessmentId: "current", criterionId: "not-applicable", state: "unknown", applicable: false },
    { assessmentId: "current", criterionId: "unresolved", state: "unknown", applicable: true },
    { assessmentId: "old", criterionId: "stale", state: "unknown", applicable: false },
    { assessmentId: "current", criterionId: "shared-no", state: "unknown", applicable: false },
    { assessmentId: "current", criterionId: "shared-yes", state: "unknown", applicable: true },
  ];
  const current = judgments.filter(j => j.assessmentId === "current");
  const row = { id: "trial", assessmentId: "current", kind: "registry", rank: 1,
    registryId: "NCT00000001", summary: "insufficient_evidence", counts: { unknown: 2 }, evidenceGaps: [],
    snapshotHash: matchingInputDigest({ criteria, judgments: current.map(j => [j.criterionId, j.state, j.applicable]).sort() }) };
  const store = {
    async rankingSnapshot() { return { trials: [], assessments: [{ candidateTrialId: "trial", id: "current" }], criteria, judgments }; },
    async languageAnswersForTrials() { return new Map([["trial", new Set()]]); },
  };
  const service = createPatientTrials({ candidateStore: store });
  service.ranked = async () => [row];
  service.unjudged = async () => [];
  const result = await service.runtimeRead({ id: "study" }, { subjectKey: "patient" });
  assert.equal(result.ranking.length, 1);
  // A changed judgment after ranking is not read through a stale snapshot.
  judgments[1].applicable = false;
  await assert.rejects(service.runtimeRead({ id: "study" }, { subjectKey: "patient" }), error => error.code === "vcr_read_changed");
});

test("candidate language bindings come from one coherent record and criterion snapshot", async () => {
  const criteria = [{ id: "c1", candidateTrialId: "trial", ordinal: 1, kind: "inclusion", sourceText: "Consent",
    requirement: { op: "language", key: "consent", text: "Consent" } }];
  const trial = { id: "trial", registry: "clinicaltrials.gov", registryId: "NCT00000001", recordHash: null, eligibilityText: "Consent" };
  const store = { async rankingSnapshot(studyId, subjectKey, filter) {
    assert.equal(studyId, "study");
    assert.equal(subjectKey, "");
    assert.equal(filter.id, "trial");
    return { trials: [trial], criteria, assessments: [], judgments: [] };
  } };
  const service = createPatientTrials({ candidateStore: store });
  const result = await service.runtimeRead({ id: "study" }, { id: "trial" });
  const binding = result.trials[0].criteria[0].languageBindings[0];
  const { languageCriterionHash } = await import("../src/vcrMatchingSnapshot.mjs");
  assert.deepEqual(binding, { criterionKey: "consent", expectedRecordHash: null,
    expectedCriterionHash: languageCriterionHash(criteria, "consent") });
});

test("requested missing trials and trials without criteria are unavailable for each selected patient", async () => {
  const store = {
    async listCandidateTrials() { return [{ id: "empty", registryId: "NCT00000001" }]; },
    async criteriaOfTrials() { return new Map([["empty", []]]); },
  };
  const service = createPatientTrials({ candidateStore: store });
  const result = await service.evaluate({ id: "study" }, { subjectKeys: ["P1", "P2", "P1"], trialIds: ["missing", "empty", "missing"] });
  assert.deepEqual(result.evaluated, []);
  assert.deepEqual(result.unavailable, [
    { trialId: "missing", subjectKey: "P1", code: "vcr_candidate_trial_not_found" },
    { trialId: "empty", registryId: "NCT00000001", subjectKey: "P1", code: "vcr_criteria_missing" },
    { trialId: "missing", subjectKey: "P2", code: "vcr_candidate_trial_not_found" },
    { trialId: "empty", registryId: "NCT00000001", subjectKey: "P2", code: "vcr_criteria_missing" },
  ]);
});
