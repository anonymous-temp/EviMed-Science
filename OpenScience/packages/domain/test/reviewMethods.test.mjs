import assert from "node:assert/strict";
import test from "node:test";
import { reviewMethodsFindings } from "../src/reviewMethods.mjs";

function ledger() {
  return {
    queries: [{ database: "PubMed", query: "prespecified review query", resultsRetrieved: 0 }],
    sourceRecords: [
      { referenceNumber: 1, identifier: "PMID 100001", included: true, accessLevel: "full_text" },
      { referenceNumber: 2, identifier: "DOI:10.1234/followup", included: true, accessLevel: "full_text" },
    ],
    reviewMethods: {
      schemaVersion: 1, reviewType: "narrative",
      eligibility: { inclusionCriteria: ["Relevant completed studies"], exclusionCriteria: ["Protocols without outcomes"] },
      protocol: { status: "unregistered", deviations: [] },
      searchCoverage: [{ domain: "intervention", status: "searched", queryIndexes: [0] }],
      studyGroups: [{ studyId: "NCT00000001", evidenceType: "primary", referenceNumbers: [1, 2] }],
    },
  };
}

test("a successful zero-hit search is a completed search, without arbitrary literature floors", () => {
  const result = reviewMethodsFindings(ledger());
  assert.deepEqual(result.issues, []);
  assert.equal(result.metrics.searchCoverageComplete, true);
  assert.equal(result.metrics.includedReports, 2);
  assert.equal(result.metrics.independentPrimaryStudies, 1);
});

test("duplicate document identifiers cannot inflate independent-study counts", () => {
  const value = ledger();
  value.sourceRecords[0].identifier = "https://doi.org/10.1234/FOLLOWUP";
  value.reviewMethods.studyGroups = [
    { studyId: "one", evidenceType: "primary", referenceNumbers: [1] },
    { studyId: "two", evidenceType: "primary", referenceNumbers: [2] },
  ];
  const result = reviewMethodsFindings(value);
  assert.equal(result.metrics.independentPrimaryStudies, null);
  assert.ok(result.issues.some((item) => item.text.includes("same document")));
});

test("primary reports with unknown identity do not become independent by default", () => {
  const value = ledger();
  value.reviewMethods.studyGroups[0].studyId = /** @type {any} */ (null);
  const result = reviewMethodsFindings(value);
  assert.equal(result.metrics.unassignedPrimaryReports, 2);
  assert.equal(result.metrics.independentPrimaryStudies, null);
});

test("a review and protocol are separate sources, not additional primary studies", () => {
  const value = ledger();
  value.reviewMethods.studyGroups = [
    { studyId: "review", evidenceType: "review", referenceNumbers: [1] },
    { studyId: "registration", evidenceType: "registry", referenceNumbers: [2] },
  ];
  const result = reviewMethodsFindings(value);
  assert.equal(result.metrics.independentPrimaryStudies, 0);
  assert.equal(result.metrics.primaryReports, 0);
  assert.equal(result.metrics.includedReports, 2);
});

test("excluded sources and repeated assignments are never counted as usable study members", () => {
  const value = ledger();
  value.sourceRecords[1].included = false;
  value.reviewMethods.studyGroups[0].referenceNumbers = [1, 1, 2];
  const result = reviewMethodsFindings(value);
  assert.equal(result.metrics.includedReports, 1);
  assert.equal(result.metrics.primaryReports, 1);
  assert.equal(result.metrics.independentPrimaryStudies, null);
});

test("missing and incompatible group assignments make the study total unknown", () => {
  for (const groups of [
    [],
    [{ studyId: "one", evidenceType: "invalid", referenceNumbers: [1, 2] }],
    [{ studyId: "one", evidenceType: "primary", referenceNumbers: [1] },
      { studyId: "one", evidenceType: "guideline", referenceNumbers: [2] }],
    [{ studyId: "one", evidenceType: "primary", referenceNumbers: [] }],
  ]) {
    const value = ledger();
    value.reviewMethods.studyGroups = groups;
    assert.equal(reviewMethodsFindings(value).metrics.independentPrimaryStudies, null);
  }
});

test("metadata-only inclusion is visible even if the report supplied a study identity", () => {
  const value = ledger();
  value.sourceRecords[0].accessLevel = "bibliographic";
  const result = reviewMethodsFindings(value);
  assert.equal(result.metrics.metadataOnlyIncluded, 1);
  assert.ok(result.issues.some((item) => item.text.includes("beyond-metadata")));
});

test("every declared search domain needs an actual query or an explicit limitation", () => {
  for (const change of [
    { domain: "", status: "searched", queryIndexes: [0] },
    { domain: "registry", status: "searched", queryIndexes: [] },
    { domain: "registry", status: "searched", queryIndexes: [-1] },
    { domain: "registry", status: "searched", queryIndexes: [1] },
    { domain: "registry", status: "unavailable", queryIndexes: [] },
    { domain: "registry", status: "not_applicable", queryIndexes: [] },
    { domain: "registry", status: "unknown", queryIndexes: [] },
    { domain: "registry", status: "searched", queryIndexes: null },
  ]) {
    const value = ledger();
    value.reviewMethods.searchCoverage = /** @type {any} */ ([change]);
    const result = reviewMethodsFindings(value);
    assert.equal(result.metrics.searchCoverageComplete, false);
    assert.ok(result.issues.some((item) => item.check === "review-search-coverage"));
  }
});

test("not-applicable domains need a reason and duplicate domain rows do not inflate coverage", () => {
  const value = ledger();
  value.reviewMethods.searchCoverage.push(/** @type {any} */ ({
    domain: "economic evaluation", status: "not_applicable", queryIndexes: [], reason: "Outside this review's defined question.",
  }));
  assert.equal(reviewMethodsFindings(value).metrics.searchCoverageComplete, true);
  value.reviewMethods.searchCoverage.push({ domain: "intervention", status: "searched", queryIndexes: [0] });
  const result = reviewMethodsFindings(value);
  assert.equal(result.metrics.searchDomains, 2);
  assert.equal(result.metrics.searchCoverageComplete, false);
});

test("registration, eligibility and review type are explicit rather than inferred from prose", () => {
  for (const change of [
    { reviewType: "meta" },
    { eligibility: {} },
    { protocol: null },
    { protocol: { status: "registered", deviations: [] } },
    { protocol: { status: "not_applicable", deviations: [] } },
    { protocol: { status: "unknown", deviations: [] } },
    { protocol: { status: "unregistered", deviations: [""] } },
  ]) {
    const value = ledger();
    Object.assign(value.reviewMethods, change);
    assert.equal(reviewMethodsFindings(value).metrics.schemaValid, false);
  }
  const registered = ledger();
  Object.assign(registered.reviewMethods.protocol, { status: "registered", identifier: "actual-protocol-reference" });
  assert.equal(reviewMethodsFindings(registered).metrics.schemaValid, true);
});

test("malformed optional ledgers are contained and old ledgers remain compatible", () => {
  for (const value of [null, [], {}, { queries: [] }]) assert.deepEqual(reviewMethodsFindings(value).issues, []);
  for (const reviewMethods of [null, [], { schemaVersion: 2 }]) {
    assert.equal(reviewMethodsFindings({ reviewMethods }).metrics.schemaValid, false);
  }
  for (const change of [{ sourceRecords: null }, { sourceRecords: [] }]) {
    const value = { ...ledger(), ...change };
    assert.equal(reviewMethodsFindings(value).metrics.independentPrimaryStudies, null);
  }
  const value = ledger();
  value.reviewMethods.studyGroups = /** @type {any} */ (null);
  assert.equal(reviewMethodsFindings(value).metrics.independentPrimaryStudies, null);
});

