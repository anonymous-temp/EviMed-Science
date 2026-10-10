// 「给患者找试验」 (the patient → trials direction of matching): the parts that are exact operations and
// need no database. What identifies a candidate trial is read from the registry's record in code, never
// typed by the run; the run's structuring of the eligibility text keeps its original wording, and the
// platform finds where in the record that wording stands.
import assert from "node:assert/strict";
import test from "node:test";

import { ctgovPrecedent } from "../src/trialRegistryClient.mjs";
import {
  CANDIDATE_TRIAL_LOCATIONS_MAX, candidateTrialFromRecord, candidateTrialUrl, locateSourceText,
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
