import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The gate's own entry: `claimVerification` reaches `quoteIsPresent`, the
// comparison the delivery gate makes, without this test needing the private
// normaliser exported. The research MCP's `locate_quote` ports that
// comparison to Python and reads this same fixture in
// `runtime/mcp/evimed-research/test/test_quote_locator.py`; a change to the
// normalisation that is not made on both sides turns one of the two red.
import { claimVerification } from "../src/clinicalEvidence.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/quote-normalization.json", import.meta.url), "utf8"));
const ARTIFACT = ".evimed-sources/fixture/0000/fulltext.md";

/** The gate's verdict on one quotation against one preserved text.
 *  @param {string} source @param {string} quote */
function verdict(source, quote) {
  const { claims } = claimVerification({
    matrix: { claims: [{ claimId: "CLM-001", claimType: "direct", artifactPath: ARTIFACT, supportQuote: quote }] },
    sourceArtifacts: { [ARTIFACT]: source },
  });
  return claims[0].status;
}

test("the fixture is the evimed-quote-v1 agreement and is not empty", () => {
  assert.equal(fixture.version, "evimed-quote-v1");
  assert.ok(fixture.normalization.length >= 20);
  assert.ok(fixture.presence.length >= 20);
});

test("each normalisation pair is exactly what the gate normalises the input to", () => {
  // Containment both ways between two normalised whole strings is equality:
  // a match that spans a whole string has no neighbour to violate a word or
  // number boundary, and the normalisation is idempotent, so `expected`
  // normalises to itself.
  for (const { input, expected, note } of fixture.normalization) {
    assert.equal(verdict(input, expected), "verified", `${note}: the expected form is not in the input`);
    assert.equal(verdict(expected, input), "verified", `${note}: the input is not in the expected form`);
  }
});

test("each presence case is the gate's verdict", () => {
  for (const { source, quote, present, note } of fixture.presence) {
    assert.equal(verdict(source, quote) === "verified", present, note);
  }
});
