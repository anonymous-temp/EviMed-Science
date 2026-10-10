// A share of runs chosen by a hash of the run id: stable for a run, close to the share over many, and independent between purposes.
import assert from "node:assert/strict";
import test from "node:test";

import { sampledByHash } from "../src/runSampling.mjs";

const ids = Array.from({ length: 4000 }, (_, index) => `run_${index.toString(16).padStart(6, "0")}`);
const taken = (share, purpose = "test-purpose") => ids.filter((id) => sampledByHash(id, share, purpose));

test("a run is in or out of a sample for good: the same id, share and purpose give the same answer however often it is asked", () => {
  for (const id of ids.slice(0, 200)) {
    const first = sampledByHash(id, 0.33, "test-purpose");
    for (let again = 0; again < 3; again += 1) assert.equal(sampledByHash(id, 0.33, "test-purpose"), first, id);
  }
});

test("zero selects nothing, one selects everything, and a value that is not a share is nothing rather than everything", () => {
  assert.equal(taken(0).length, 0);
  assert.equal(taken(1).length, ids.length);
  assert.equal(taken(1.5).length, ids.length, "more than all is all");
  for (const share of [-0.2, Number.NaN, undefined, null, "", "x"]) assert.equal(taken(/** @type {any} */ (share)).length, 0, String(share));
  assert.equal(sampledByHash("run_1", "1", "test-purpose"), true, "a share read from the environment as text still counts");
});

test("over many runs the sample is close to its share, and a larger share only adds runs", () => {
  for (const share of [0.1, 0.33, 0.5]) {
    const fraction = taken(share).length / ids.length;
    assert.ok(Math.abs(fraction - share) < 0.03, `${share} selected ${fraction}`);
  }
  const small = new Set(taken(0.1));
  assert.ok(taken(0.33).length > small.size);
  assert.ok([...small].every((id) => sampledByHash(id, 0.33, "test-purpose")), "every run in the smaller sample is in the larger one");
});

test("two purposes sample the same runs independently, so one run does not carry both costs", () => {
  const first = new Set(taken(0.33, "learning-distill-delivery"));
  const second = new Set(taken(0.33, "platform-handbook-probation"));
  const both = [...first].filter((id) => second.has(id)).length;
  // Independent draws of a third each overlap in about a ninth of the runs; identical draws would overlap in a third.
  assert.ok(Math.abs(both / ids.length - 0.33 * 0.33) < 0.03, `${both} runs are in both`);
});
