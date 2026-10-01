import assert from "node:assert/strict";
import test from "node:test";

import * as clinical from "../src/clinicalEvidence.mjs";

const sources = [
  { sourceUrl: "https://example.org/a", sourceTitle: "Earlier review", artifactPath: ".evimed-sources/a/fulltext.md", accessLevel: "full_text", supportQuote: "The review searched studies published through December 2014." },
  { sourceUrl: "https://example.org/b", sourceTitle: "Later review", artifactPath: ".evimed-sources/b/fulltext.md", accessLevel: "full_text", supportQuote: "The later review included randomized controlled studies." },
];
const sourceArtifacts = Object.fromEntries(sources.map((source) => [source.artifactPath, source.supportQuote]));
const claim = {
  claimId: "CLM-053", claimType: "synthesized", claim: "Two reviews describe the evidence.",
  confidence: "moderate", applicability: "The reviews address the research question.", uncertainty: "Review eligibility differed.",
  referenceNumber: 1, referenceNumbers: [1, 2], supportingSources: sources,
  ...sources[0], supportQuote: "The review searched studies published through June 2019.",
};

/** @param {any} value */
const verify = (value) => clinical.claimVerification({ matrix: { claims: [value] }, sourceArtifacts }).claims[0];

test("verified supporting quotes cannot hide a false explicit top-level bond", () => {
  const verdict = verify(claim);
  assert.equal(verdict.status, "quote_not_found");
  assert.deepEqual(verdict.sources.map((source) => source.status), ["verified", "verified", "quote_not_found"]);
  assert.deepEqual(verdict.sources.map((source) => source.artifactPath), [sources[0].artifactPath, sources[1].artifactPath, sources[0].artifactPath]);

  const audit = clinical.validateEvidenceClaim({ claim, sourceArtifacts });
  assert.equal(audit.status, "unverified");
  assert.equal(audit.verification, "quote_not_found");
  assert.deepEqual(audit.issues.map((issue) => [issue.code, issue.tier]), [["claim-explicit-quote-verbatim", "advisory"]]);
  assert.match(audit.issues[0].message, /^MUST FIX — CLM-053\.supportQuote was not found/);
  assert.equal(Object.hasOwn(clinical.CLINICAL_CHECK_TIERS, "claim-explicit-quote-verbatim"), false);
});

test("correcting or removing the optional explicit bond clears the finding", () => {
  const corrected = { ...claim, supportQuote: sources[0].supportQuote };
  const { artifactPath: _path, supportQuote: _quote, ...removed } = claim;
  for (const value of [corrected, removed]) {
    assert.equal(verify(value).status, "verified");
    assert.equal(verify(value).sources.length, 2);
    assert.deepEqual(clinical.validateEvidenceClaim({ claim: value, sourceArtifacts }).issues, []);
  }
});

test("source enumeration keeps nested indexes and dedupes only an identical explicit bond", () => {
  assert.deepEqual(clinical.claimEvidenceSources(claim), [...sources, claim]);
  assert.deepEqual(clinical.claimEvidenceSources({ ...claim, supportQuote: sources[0].supportQuote }), sources);
  // Path aliases compare canonically for deduplication; this does not make
  // an invalid path eligible for quotation verification.
  assert.deepEqual(clinical.claimEvidenceSources({ ...claim, artifactPath: `./${sources[0].artifactPath}`, supportQuote: sources[0].supportQuote }), sources);
  const repeated = { ...claim, supportingSources: [sources[0], sources[0], sources[1]] };
  assert.deepEqual(clinical.claimEvidenceSources(repeated), [sources[0], sources[0], sources[1], repeated]);
  assert.deepEqual(clinical.claimEvidenceSources({ ...claim, supportQuote: undefined }), sources);
  assert.deepEqual(clinical.claimEvidenceSources({ ...claim, artifactPath: undefined }), sources);
  assert.deepEqual(clinical.claimEvidenceSources({ ...claim, claimType: "direct" }), [{ ...claim, claimType: "direct" }]);
  assert.deepEqual(clinical.claimEvidenceSources({ ...claim, claimType: "derived" }), []);
});

test("an explicit bond never substitutes for independent supporting sources, confidence or numeric anchors", () => {
  const oneNested = { ...claim, ...sources[1], supportingSources: [sources[0]] };
  assert.ok(clinical.validateEvidenceClaim({ claim: oneNested, sourceArtifacts }).issues.some((issue) => /at least two distinct sources/.test(issue.message)));
  assert.ok(clinical.validateEvidenceClaim({ claim: { ...claim, confidence: undefined }, sourceArtifacts }).issues.some((issue) => /confidence must be/.test(issue.message)));
  const numeric = { ...claim, claim: "The response was 25%.", supportQuote: "The response was 25%." };
  const artifacts = { ...sourceArtifacts, [numeric.artifactPath]: `${sourceArtifacts[numeric.artifactPath]}\n${numeric.supportQuote}` };
  assert.ok(clinical.validateEvidenceClaim({ claim: numeric, sourceArtifacts: artifacts }).issues.some((issue) => /numeric fact 25 is not present in any supporting source/.test(issue.message)));
});

test("a reader's retained declared path keeps a bond visible without authorizing its source", () => {
  const reader = { ...claim, artifactPath: undefined, declaredArtifactPath: `./${sources[0].artifactPath}` };
  assert.deepEqual(clinical.claimEvidenceSources(reader), [...sources, reader]);
  assert.deepEqual(verify(reader).sources.map((source) => source.status), ["verified", "verified", "no_quote"]);
  assert.deepEqual(clinical.claimEvidenceSources({ ...reader, supportQuote: sources[0].supportQuote }), sources);
  // A declared display path cannot replace an actual source's identity.
  const actual = { ...claim, supportQuote: sources[1].supportQuote, declaredArtifactPath: sources[1].artifactPath };
  assert.deepEqual(clinical.claimEvidenceSources(actual), [...sources, actual]);
});
