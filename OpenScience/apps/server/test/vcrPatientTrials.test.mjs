// 「给患者找试验」 (the patient → trials direction of matching): the parts that are exact operations and
// need no database. What identifies a candidate trial is read from the registry's record in code, never
// typed by the run; the run's structuring of the eligibility text keeps its original wording, and the
// platform finds where in the record that wording stands.
import assert from "node:assert/strict";
import test from "node:test";

import { ctgovPrecedent } from "../src/trialRegistryClient.mjs";
import {
  CANDIDATE_TRIAL_LOCATIONS_MAX, candidateTrialFromRecord, candidateTrialUrl, locateSourceText, phaseLabel, rankPatientTrials,
  registryStatusLabel, registryStatusRank,
} from "../src/vcrPatientTrials.mjs";
import { FLAURA } from "./vcrEvidenceFixtures.mjs";

const RETRIEVED = "2026-10-10T08:00:00.000Z";

test("a registry record gives a candidate trial its identity: registry, id, title, phase, status, conditions, sites, link and hash", () => {
  const trial = candidateTrialFromRecord(ctgovPrecedent(FLAURA, { retrievedAt: RETRIEVED }));
  assert.equal(trial.registry, "clinicaltrials.gov");
  assert.equal(trial.registryId, "NCT02296125");
  assert.match(trial.title, /^AZD9291 Versus Gefitinib or Erlotinib/);
  assert.equal(trial.phase, "PHASE3");
  assert.equal(trial.status, "COMPLETED");
  assert.deepEqual(trial.conditions, ["Locally Advanced or Metastatic EGFR Sensitising Mutation Positive Non Small Cell Lung Cancer"]);
  assert.equal(trial.url, "https://clinicaltrials.gov/study/NCT02296125");
  assert.match(trial.recordHash, /^[a-f0-9]{64}$/);
  assert.equal(trial.retrievedAt, RETRIEVED);
  assert.match(trial.eligibilityText, /^Inclusion Criteria:/);
  // The sites a record lists: where they are and how they stand, never the people who answer the phone there.
  assert.equal(trial.locations.total, 4);
  assert.deepEqual(trial.locations.countries, ["United States"]);
  assert.deepEqual(trial.locations.sites[0], { facility: "Research Site", city: "Anaheim", state: "", country: "United States", status: "" });
  assert.ok(!JSON.stringify(trial.locations).includes("contact"), "no contact of a site is kept");
});

test("a record that lists many sites keeps a bounded list and the record's own total", () => {
  const locations = Array.from({ length: CANDIDATE_TRIAL_LOCATIONS_MAX + 30 }, (_, index) => ({
    facility: `Site ${index}`, city: "Beijing", country: "China", status: "RECRUITING",
    contacts: [{ name: "A. Coordinator", phone: "000", email: "someone@example.org" }],
  }));
  const built = ctgovPrecedent({
    ...FLAURA, protocolSection: { ...FLAURA.protocolSection, contactsLocationsModule: { locations } },
  }, { retrievedAt: RETRIEVED });
  const trial = candidateTrialFromRecord(built);
  assert.equal(trial.locations.sites.length, CANDIDATE_TRIAL_LOCATIONS_MAX);
  assert.ok(trial.locations.total >= CANDIDATE_TRIAL_LOCATIONS_MAX, "the total is the record's, not the length of the kept list");
  assert.ok(!JSON.stringify(trial).includes("someone@example.org") && !JSON.stringify(trial).includes("A. Coordinator"), "a site's contacts are never read into the trial");
  assert.equal(trial.locations.sites[0].status, "RECRUITING");
});

test("a record without sites, phase or eligibility text is a candidate with those fields empty, not an error", () => {
  const trial = candidateTrialFromRecord({
    precedent: { registry: "chictr", registryId: "ChiCTR2400000001", title: "某研究", pico: { conditions: ["肺癌"] }, design: { phases: [], overallStatus: "Recruiting" },
      sites: { count: null, countries: [] }, eligibilityText: "", sources: [{ url: "https://www.chictr.org.cn/showproj.html?proj=1", recordHash: "a".repeat(64) }], fetchedAt: RETRIEVED },
    record: { url: "https://www.chictr.org.cn/showproj.html?proj=1", hash: "a".repeat(64), reduced: {} },
  });
  assert.equal(trial.phase, "");
  assert.equal(trial.status, "Recruiting");
  assert.deepEqual(trial.locations, { total: null, countries: [], sites: [] });
  assert.equal(trial.eligibilityText, "");
  assert.equal(trial.url, "https://www.chictr.org.cn/showproj.html?proj=1");
});

test("the link out is the registry's own page for the id, and a link that is not https is not a link", () => {
  assert.equal(candidateTrialUrl("clinicaltrials.gov", "NCT02296125", ""), "https://clinicaltrials.gov/study/NCT02296125");
  assert.equal(candidateTrialUrl("ctis", "2024-513060-26-00", ""), "https://euclinicaltrials.eu/ctis-public/view/2024-513060-26-00");
  assert.equal(candidateTrialUrl("chictr", "ChiCTR2400000001", "https://www.chictr.org.cn/showproj.html?proj=1"), "https://www.chictr.org.cn/showproj.html?proj=1");
  assert.equal(candidateTrialUrl("chictr", "ChiCTR2400000001", "javascript:alert(1)"), "");
  assert.equal(candidateTrialUrl("chictr", "ChiCTR2400000001", "http://insecure.example/x"), "");
  assert.equal(candidateTrialUrl("chictr", "ChiCTR2400000001", ""), "");
});

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
