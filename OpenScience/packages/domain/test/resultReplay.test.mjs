import test from "node:test";
import assert from "node:assert/strict";
import { compareResultNumbers } from "../src/resultReplay.mjs";

test("scientific comparison uses frozen tolerances and identifies missing values and units", () => {
  const baseline = [{ key: "effect", value: 1.25, relativeTolerance: 1e-6, unit: "RR" }, { key: "count", value: 3 }];
  assert.equal(compareResultNumbers(baseline, baseline).status, "identical");
  assert.equal(compareResultNumbers(baseline, [{ key: "effect", value: 1.2500001, unit: "RR" }, { key: "count", value: 3 }]).status, "within-tolerance");
  assert.equal(compareResultNumbers(baseline, [{ key: "effect", value: 4, unit: "RR", absoluteTolerance: 1000 }]).status, "changed");
  assert.equal(compareResultNumbers(baseline, [{ key: "effect", value: 1.25, unit: "OR" }]).values[0].status, "incompatible-unit");
  assert.equal(compareResultNumbers([], []).status, "not-assessed");
  assert.equal(compareResultNumbers(baseline, baseline).scientificApplicability, "not_assessed");
  assert.throws(() => compareResultNumbers([{ key: "bad", value: NaN }], []));
  assert.throws(() => compareResultNumbers([{ key: "duplicate", value: 1 }, { key: "duplicate", value: 2 }], []));
});
