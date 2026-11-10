import test from "node:test";
import assert from "node:assert/strict";
import { reproductionRateLowerBound, researchPromotion, RESEARCH_PROMOTION_MINIMUM_PAPERS, RESEARCH_PROMOTION_MINIMUM_LOWER_BOUND } from "./promotion.mjs";

const papers = (passed, failed) => [...Array.from({ length: passed }, (_, i) => ({ paper: `pass-${i}`, passed: true })), ...Array.from({ length: failed }, (_, i) => ({ paper: `fail-${i}`, passed: false }))];
const round2 = value => Math.round(value * 100) / 100;

test("the lower bound is the one-sided 95% Clopper-Pearson bound", () => {
  // Five of five: 0.05 ** (1 / 5), in closed form.
  assert.ok(Math.abs(reproductionRateLowerBound(5, 5) - 0.05 ** (1 / 5)) < 1e-9);
  assert.equal(round2(reproductionRateLowerBound(5, 5)), 0.55);
  assert.equal(round2(reproductionRateLowerBound(5, 6)), 0.42);
  assert.equal(round2(reproductionRateLowerBound(7, 8)), 0.53);
  assert.equal(round2(reproductionRateLowerBound(4, 4)), 0.47);
  assert.equal(reproductionRateLowerBound(0, 0), 0);
  assert.equal(reproductionRateLowerBound(0, 7), 0);
  for (const [successes, n] of [[-1, 3], [4, 3], [1.5, 3], [1, 2.5]]) assert.throws(() => reproductionRateLowerBound(successes, n), /promotion_counts_invalid/);
});

test("five of five meets the rule, five of six does not, seven of eight does", () => {
  assert.equal(RESEARCH_PROMOTION_MINIMUM_PAPERS, 5);
  assert.equal(RESEARCH_PROMOTION_MINIMUM_LOWER_BOUND, 0.5);
  const five = researchPromotion(papers(5, 0));
  assert.equal(five.qualifies, true);
  assert.equal(round2(five.lowerBound), 0.55);
  assert.deepEqual([five.reproduced, five.attempted, five.failedPublications], [5, 5, []]);
  const six = researchPromotion(papers(5, 1));
  assert.equal(six.qualifies, false);
  assert.equal(round2(six.lowerBound), 0.42);
  assert.deepEqual([six.reproduced, six.attempted, six.failedPublications], [5, 6, ["fail-0"]]);
  const eight = researchPromotion(papers(7, 1));
  assert.equal(eight.qualifies, true);
  assert.equal(round2(eight.lowerBound), 0.53);
});

test("a failure counts: five reproduced of a hundred attempted is not five of five, and four of four is too few", () => {
  const many = researchPromotion(papers(5, 95));
  assert.equal(many.reproduced, 5);
  assert.equal(many.attempted, 100);
  assert.equal(many.qualifies, false);
  assert.ok(many.lowerBound < 0.05);
  const few = researchPromotion(papers(4, 0));
  assert.equal(few.qualifies, false);
  assert.equal(round2(few.lowerBound), 0.47);
  assert.equal(researchPromotion([]).qualifies, false);
  assert.equal(researchPromotion([]).attempted, 0);
});

test("the first measured outcome of a paper stands, whichever it is", () => {
  const base = papers(5, 0);
  // A failure measured first is not turned into a pass by a later measurement of the same paper.
  const retried = researchPromotion([{ paper: "late", passed: false }, ...base, { paper: "late", passed: true }]);
  assert.deepEqual([retried.reproduced, retried.attempted, retried.failedPublications], [5, 6, ["late"]]);
  assert.equal(retried.qualifies, false);
  // And a pass measured first is not undone by a later failure of the same paper.
  const kept = researchPromotion([...base, { paper: "pass-0", passed: false }]);
  assert.deepEqual([kept.reproduced, kept.attempted], [5, 5]);
  assert.equal(kept.qualifies, true);
});

test("one outcome per publication, and a failure is not hidden by a pass", () => {
  const base = papers(4, 0);
  // Two paper identities of one publication, in either order: one outcome, a failed one.
  for (const pair of [[true, false], [false, true]]) {
    const outcomes = [...base, { paper: "doi:10.1/a", publication: "pub-a", passed: pair[0] }, { paper: "pmid:1", publication: "pub-a", passed: pair[1] }];
    const reading = researchPromotion(outcomes);
    assert.deepEqual([reading.reproduced, reading.attempted, reading.failedPublications], [4, 5, ["pub-a"]], JSON.stringify(pair));
    assert.equal(reading.qualifies, false);
  }
  // Two passing identities of one publication are one reproduced publication, not two.
  const double = researchPromotion([...base, { paper: "doi:10.1/a", publication: "pub-a", passed: true }, { paper: "pmid:1", publication: "pub-a", passed: true }]);
  assert.deepEqual([double.reproduced, double.attempted], [5, 5]);
  assert.equal(double.qualifies, true);
});

test("an outcome that is not one is refused, never counted as a failure or a pass", () => {
  for (const bad of [null, { paper: "a" }, { paper: "", passed: true }, { paper: "a", passed: "true" }, { paper: "a", publication: "", passed: true }, { paper: 1, passed: true }]) {
    assert.throws(() => researchPromotion([bad]), /promotion_outcome_invalid/);
  }
  assert.throws(() => researchPromotion(/** @type {any} */ ({})), /promotion_outcomes_invalid/);
});
