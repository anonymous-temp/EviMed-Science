import test from "node:test";
import assert from "node:assert/strict";
import { numericScore } from "./evaluator.mjs";
test("numeric tolerances and defensible intervals", () => {
  assert.equal(numericScore(1.02, { value: 1, absoluteTolerance: .03 }).valid, true);
  assert.equal(numericScore(3, { interval: [1, 2] }).valid, false);
  assert.equal(numericScore(NaN, { value: 1 }).valid, false);
});
