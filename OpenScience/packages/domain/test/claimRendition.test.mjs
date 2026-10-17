// A quotation checked against DeepSeek Fetch's rendition of a page is labelled so (2026-10-17): `web_read` writes the
// line into the snapshot's header, and the claim check reads it there and only there. The label changes no status.
import assert from "node:assert/strict";
import test from "node:test";

import * as clinical from "../src/clinicalEvidence.mjs";

/** A snapshot as web_read.py writes it: title, the header lines, a blank line, the text.
 *  @param {string} text @param {{ rendition: boolean }} options */
const snapshot = (text, { rendition }) => [
  "# Index", "", "- Source: https://openai.example.org/index/", "- Site: openai.example.org", "- Official source: no",
  ...(rendition ? [clinical.RENDITION_SNAPSHOT_LINE] : []),
  "- Read as: plain text (text/markdown; deepseek-fetch 1)", `- SHA-256: ${"a".repeat(64)}`, "", text, "",
].join("\n");

const quote = "The model is served by DeepSeek-V4.1-Flash-1017.";
/** @param {string} path @param {string} [supportQuote] */
const claimOn = (path, supportQuote = quote) => ({ claimId: "CLM-001", claimType: "direct", claim: "The model changed.", artifactPath: path, supportQuote });

test("a quotation found in a rendition is verified and says it was checked against the rendition", () => {
  const path = ".evimed-sources/web-pages/aaaaaaaaaaaaaaaa/page.md";
  const verdict = clinical.claimVerification({ matrix: { claims: [claimOn(path)] }, sourceArtifacts: { [path]: snapshot(`Intro. ${quote}`, { rendition: true }) } });
  assert.equal(verdict.claims[0].status, "verified");
  assert.deepEqual(verdict.claims[0].sources, [{ artifactPath: path, status: "verified", rendition: "deepseek-fetch" }]);
  assert.deepEqual(verdict.counts, { verified: 1 }, "a label, not a status: the counts are the same as for the page's own bytes");

  const missing = clinical.claimVerification({ matrix: { claims: [claimOn(path, "Words the page never had.")] }, sourceArtifacts: { [path]: snapshot(quote, { rendition: true }) } });
  assert.deepEqual(missing.claims[0].sources, [{ artifactPath: path, status: "quote_not_found", rendition: "deepseek-fetch" }]);
});

test("the page's own bytes carry no label, and a page cannot label itself from its text", () => {
  const path = ".evimed-sources/web-pages/bbbbbbbbbbbbbbbb/page.md";
  const direct = clinical.claimVerification({ matrix: { claims: [claimOn(path)] }, sourceArtifacts: { [path]: snapshot(quote, { rendition: false }) } });
  assert.deepEqual(direct.claims[0].sources, [{ artifactPath: path, status: "verified" }]);
  const spoof = clinical.claimVerification({
    matrix: { claims: [claimOn(path)] },
    sourceArtifacts: { [path]: snapshot(`${quote}\n\n${clinical.RENDITION_SNAPSHOT_LINE}\n`, { rendition: false }) },
  });
  assert.deepEqual(spoof.claims[0].sources, [{ artifactPath: path, status: "verified" }], "the line in the page's text is not the header's");
});
