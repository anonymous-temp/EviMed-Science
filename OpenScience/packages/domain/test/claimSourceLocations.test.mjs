import assert from "node:assert/strict";
import test from "node:test";

import { attachClaimSourceLocations, claimVerification } from "../src/clinicalEvidence.mjs";

const PATH = ".evimed-sources/aaaa/fulltext.md";
const OTHER = ".evimed-sources/bbbb/fulltext.md";
const TEXT = [
  "<!-- page 1 -->",
  "Methods. Participants were randomised 1:1 to the study drug or placebo for twenty-four weeks of treatment.",
  "<!-- page 2 -->",
  "Table 3. Primary and secondary outcomes at week 24",
  "",
  "| Outcome | Study drug | Placebo | Hazard ratio (95% CI) |",
  "| --- | --- | --- | --- |",
  "| Primary composite, n/N (%) | 22/118 (18.6) | 38/120 (31.7) | 0.52 (0.31–0.88) |",
  "| Death from any cause, n/N (%) | 6/118 (5.1) | 9/120 (7.5) | 0.66 (0.23–1.86) |",
  "<!-- page 3 -->",
  "Closing discussion of the adverse events observed in both treatment groups over the whole study.",
].join("\n");

const claim = (/** @type {Record<string, any>} */ overrides) => ({ claimId: "CLM-001", claim: "A claim.", claimType: "direct", artifactPath: PATH, accessLevel: "full_text", ...overrides });

/** @param {any[]} claims @param {Record<string, string>} [artifacts] */
function verify(claims, artifacts = { [PATH]: TEXT }) {
  const matrix = { claims };
  const verdict = claimVerification({ matrix, sourceArtifacts: artifacts });
  return /** @type {any} */ (attachClaimSourceLocations(verdict, { matrix, sourceArtifacts: artifacts }));
}

test("a verified quotation inside a table cell resolves to its table, row, cell and the page its text carries", () => {
  const verdict = verify([claim({ supportQuote: "22/118 (18.6)" })]);
  const [source] = verdict.claims[0].sources;
  assert.equal(source.status, "verified");
  assert.equal(source.location.status, "located");
  assert.deepEqual(source.location.table, { id: "tbl-1", index: 1, kind: "table", label: "Table 3" });
  assert.equal(source.location.row, 2);
  assert.deepEqual(source.location.cell, { row: 2, column: 2, header: "Study drug" });
  assert.deepEqual(source.location.page, { status: "located", pages: [2], basis: "page_marker" });
});

test("a quotation in prose has a page where the text has markers and no table; the reason is said", () => {
  const verdict = verify([claim({ supportQuote: "Closing discussion of the adverse events observed in both treatment groups" })]);
  const { location } = verdict.claims[0].sources[0];
  assert.equal(location.status, "located");
  assert.equal(location.table, undefined);
  assert.deepEqual(location.page, { status: "located", pages: [3], basis: "page_marker" });
  assert.equal(location.reason, "not_in_a_table");
});

test("a text with no page markers gives a table and cell and an unknown page, with the reason", () => {
  const plain = TEXT.split("\n").filter((line) => !line.startsWith("<!--")).join("\n");
  const verdict = verify([claim({ supportQuote: "9/120 (7.5)" })], { [PATH]: plain });
  const { location } = verdict.claims[0].sources[0];
  assert.equal(location.cell.column, 3);
  assert.equal(location.row, 3);
  assert.deepEqual(location.page, { status: "unknown", reason: "no_page_markers" });
});

test("a quotation that was not found, a source not preserved and a claim with no quotation are unknown, never located", () => {
  const verdict = verify([
    claim({ claimId: "CLM-001", supportQuote: "A sentence the source does not contain at all anywhere." }),
    claim({ claimId: "CLM-002", artifactPath: OTHER, supportQuote: "Anything." }),
    claim({ claimId: "CLM-003", supportQuote: "" }),
  ]);
  const locations = verdict.claims.map((/** @type {any} */ entry) => [entry.sources[0].status, entry.sources[0].location.status, entry.sources[0].location.reason]);
  assert.deepEqual(locations, [["quote_not_found", "unknown", "quote_not_found"], ["source_unavailable", "unknown", "source_unavailable"], ["no_quote", "unknown", "no_quote"]]);
  for (const entry of verdict.claims) assert.deepEqual(entry.sources[0].location.page, { status: "unknown", reason: "quote_not_verified" });
});

test("a synthesized claim's sources are located one by one, in the order the verification lists them", () => {
  const verdict = verify([{
    claimId: "CLM-010", claim: "Across sources.", claimType: "synthesized", confidence: "moderate",
    supportingSources: [
      { artifactPath: PATH, supportQuote: "6/118 (5.1)" },
      { artifactPath: PATH, supportQuote: "Participants were randomised 1:1 to the study drug or placebo for twenty-four weeks" },
    ],
  }]);
  const [one, two] = verdict.claims[0].sources;
  assert.equal(one.location.cell.column, 2);
  assert.equal(one.location.row, 3);
  assert.equal(two.location.table, undefined);
  assert.deepEqual(two.location.page.pages, [1]);
});

test("a derived claim has no sources to locate, and the verdict's statuses are exactly what they were", () => {
  const claims = [claim({ supportQuote: "22/118 (18.6)" }), { claimId: "CLM-020", claim: "An estimate.", claimType: "derived" }];
  const before = claimVerification({ matrix: { claims }, sourceArtifacts: { [PATH]: TEXT } });
  const after = verify(claims);
  assert.deepEqual(after.claims.map((/** @type {any} */ entry) => [entry.claimId, entry.status]), before.claims.map((/** @type {any} */ entry) => [entry.claimId, entry.status]));
  assert.deepEqual(after.counts, before.counts);
  assert.deepEqual(after.claims[1].sources, []);
});

test("a source too large to derive from is unknown for that reason, and nothing it does can throw", () => {
  const huge = `${TEXT}\n${"x".repeat(4 * 1024 * 1024 + 1)}`;
  const verdict = verify([claim({ supportQuote: "22/118 (18.6)" })], { [PATH]: huge });
  assert.equal(verdict.claims[0].sources[0].status, "verified");
  assert.equal(verdict.claims[0].sources[0].location.reason, "source_too_large");
  assert.doesNotThrow(() => attachClaimSourceLocations({ claims: [{ claimId: "x", sources: [{ status: "verified", artifactPath: PATH }] }] }, /** @type {any} */ ({ matrix: null, sourceArtifacts: null })));
  assert.doesNotThrow(() => attachClaimSourceLocations({}, {}));
  assert.doesNotThrow(() => attachClaimSourceLocations(/** @type {any} */ (null), {}));
});
