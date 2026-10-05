import assert from "node:assert/strict";
import test from "node:test";

import { quoteIsPresent } from "../src/clinicalEvidence.mjs";

/** A document long enough to be kept between checks, with one sentence that is only in it. @param {string} marker */
const document = (marker) => `${"The trial enrolled adults and measured stroke outcomes over two years. 12 of 100 had an event.\n".repeat(900)}${marker} was the only sentence about it.`;

test("a large document keeps nothing between checks that could change an answer", () => {
  const documents = ["alpha", "bravo", "charlie", "delta", "echo"].map((marker) => ({ marker, text: document(marker) }));
  assert.ok(documents[0].text.length > 50_000, "the document is large enough to be kept");
  // Five documents through a memo that keeps three: every answer is the document's own, in any order and on a revisit.
  for (const order of [[0, 1, 2, 3, 4], [4, 0, 3, 1, 2], [0, 0, 1, 1, 0]]) {
    for (const index of order) {
      for (const [other, { marker }] of documents.entries()) {
        assert.equal(quoteIsPresent(documents[index].text, `${marker} was the only sentence about it`), index === other, `${index} against ${marker}`);
      }
    }
  }
  // The same text read by the two ways of normalising it, and with an inline citation marker taken out, still answers as before.
  const marked = `${"x ".repeat(30_000)}Among patients with disease.23 The drug helped. 7 had a stroke`;
  assert.equal(quoteIsPresent(marked, "Among patients with disease. The drug helped"), true);
  assert.equal(quoteIsPresent(marked, "Among patients with disease. The drug helped"), true);
  assert.equal(quoteIsPresent(marked, "7 had a stroke in the other arm"), false);
  // A number is complete or it is not, however many quotes have asked before.
  const numbers = `${"filler words ".repeat(5000)} the rate was 12.5% overall`;
  assert.equal(quoteIsPresent(numbers, "the rate was 12.5% overall"), true);
  assert.equal(quoteIsPresent(numbers, "the rate was 2.5% overall"), false);
  assert.equal(quoteIsPresent(numbers, "the rate was 12.5% overall"), true);
});
