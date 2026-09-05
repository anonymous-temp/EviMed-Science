import assert from "node:assert/strict";
import test from "node:test";
import { runGate } from "@evimed/domain";
import { validateClinicalEvidencePackage } from "../src/clinicalEvidenceQuality.mjs";
import { deepResearchPackage } from "./fixtures/clinicalEvidencePackage.mjs";

function reviewPackage() {
  const input = deepResearchPackage();
  const log = JSON.parse(input.searchLogText);
  log.reviewMethods = {
    schemaVersion: 1,
    reviewType: "systematic",
    eligibility: { inclusionCriteria: ["Trials in the question's population"], exclusionCriteria: ["Protocols without results"] },
    protocol: { status: "unregistered", deviations: [] },
    searchCoverage: [{ domain: "intervention effects", status: "searched", queryIndexes: [0] }],
    studyGroups: [
      { studyId: "NCT00000001", evidenceType: "primary", referenceNumbers: [1, 2] },
      ...log.sourceRecords.slice(2).map((row) => ({
        studyId: null, evidenceType: "guideline", referenceNumbers: [row.referenceNumber],
      })),
    ],
  };
  return { input, log };
}

function verdictFor(input, log) {
  const current = { ...input, searchLogText: JSON.stringify(log) };
  const direct = validateClinicalEvidencePackage(current);
  const files = new Map(Object.entries({
    "clinical-evidence-report.md": current.reportText,
    "clinical-evidence-matrix.json": JSON.stringify(current.matrix),
    "clinical-evidence-run.json": JSON.stringify(current.runReceipt),
    "clinical-evidence-search.json": current.searchLogText,
    "references.bib": current.referencesText,
    "citation-ledger.csv": current.citationLedgerText,
    "citation-audit.md": current.citationAuditText,
    "question-coverage.json": current.questionCoverageText,
  }));
  const runtime = runGate({
    contractKind: "clinical-evidence-report", files,
    expectedOutputs: [...files.keys()].map((path) => ({ path, required: true })),
    matrix: current.matrix, runReceipt: current.runReceipt,
    sourceArtifacts: current.sourceArtifacts,
    executedSearchQueries: current.executedSearchQueries,
    briefText: current.briefText,
  });
  return { direct, runtime };
}

test("two publications of one trial are counted as one primary study on both entrypoints", () => {
  const { input, log } = reviewPackage();
  const { direct, runtime } = verdictFor(input, log);
  assert.equal(direct.reviewCoverage?.includedReports, 12);
  assert.equal(direct.reviewCoverage?.primaryReports, 2);
  assert.equal(direct.reviewCoverage?.independentPrimaryStudies, 1);
  assert.deepEqual(runtime.metrics.reviewCoverage, direct.reviewCoverage);
});

test("unknown study identity is not counted as a new independent study", () => {
  const { input, log } = reviewPackage();
  log.reviewMethods.studyGroups[1] = { studyId: null, evidenceType: "primary", referenceNumbers: [3] };
  const { direct } = verdictFor(input, log);
  assert.equal(direct.reviewCoverage?.knownPrimaryStudies, 1);
  assert.equal(direct.reviewCoverage?.unassignedPrimaryReports, 1);
  assert.equal(direct.reviewCoverage?.independentPrimaryStudies, null);
});

test("invalid group references and double assignment are advisory and cannot add a blocker", () => {
  const { input, log } = reviewPackage();
  const baseline = verdictFor(input, log);
  log.reviewMethods.studyGroups.push({ studyId: "NCT00000002", evidenceType: "primary", referenceNumbers: [1, 99] });
  const { direct, runtime } = verdictFor(input, log);
  assert.ok(direct.issueChecks.some((item) => item.check === "review-study-accounting"));
  assert.deepEqual(direct.blockingIssues, baseline.direct.blockingIssues);
  assert.equal(runtime.ok, baseline.runtime.ok);
  assert.ok(runtime.issues.filter((item) => item.check === "review-study-accounting").every((item) => item.severity === "advisory"));
  assert.equal(direct.reviewCoverage?.independentPrimaryStudies, null);
});

test("a source outage stays an unavailable domain rather than a negative evidence search", () => {
  const { input, log } = reviewPackage();
  log.reviewMethods.searchCoverage.push({ domain: "ongoing trials", status: "unavailable", queryIndexes: [], reason: "Registry gateway timed out." });
  const { direct, runtime } = verdictFor(input, log);
  assert.equal(direct.reviewCoverage?.unavailableDomains, 1);
  assert.equal(direct.reviewCoverage?.searchCoverageComplete, false);
  assert.ok(runtime.issues.some((item) => item.check === "review-search-coverage" && item.severity === "advisory"));
});

test("coverage can only reference a search query that was actually recorded", () => {
  const { input, log } = reviewPackage();
  log.reviewMethods.searchCoverage[0].queryIndexes = [log.queries.length];
  const { direct } = verdictFor(input, log);
  assert.equal(direct.reviewCoverage?.searchCoverageComplete, false);
  assert.ok(direct.issueChecks.some((item) => item.check === "review-search-coverage"));
});

test("a malformed methods extension produces a named advisory and preserves old blockers", () => {
  const { input, log } = reviewPackage();
  const baseline = validateClinicalEvidencePackage(input);
  log.reviewMethods = [];
  const { direct } = verdictFor(input, log);
  assert.ok(direct.issueChecks.some((item) => item.check === "review-methods-schema"));
  assert.deepEqual(direct.blockingIssues, baseline.blockingIssues);
});

test("legacy search logs retain their existing verdict without a mandatory methods artifact", () => {
  const input = deepResearchPackage();
  const baseline = validateClinicalEvidencePackage(input);
  const { direct, runtime } = verdictFor(input, JSON.parse(input.searchLogText));
  assert.deepEqual(direct.blockingIssues, baseline.blockingIssues);
  assert.ok(!direct.issueChecks.some((item) => item.check?.startsWith("review-")));
  assert.equal(runtime.ok, baseline.blockingIssues.length === 0);
});

