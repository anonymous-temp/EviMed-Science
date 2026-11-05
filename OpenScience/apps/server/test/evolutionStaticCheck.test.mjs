import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { EVOLUTION_STATIC_CHECK } from "../src/evolutionVerification.mjs";

const HONEST = `def net_benefit(specification):
    n = specification["n"]
    odds = specification["threshold"] / (1 - specification["threshold"])
    prevalence = specification["eventCount"] / n
    # "expected value" is ordinary decision-analysis vocabulary; the old name rule refused this line.
    expected_value_treat = prevalence - (1 - prevalence) * odds
    benefit = (specification["truePositive"] - odds * specification["falsePositive"]) / n
    return {"netBenefit": benefit, "treatAll": expected_value_treat, "treatNone": 0, "netReductionPer100": 100 * (benefit - expected_value_treat) / odds}
`;
/** The reviewer's probe: a dict keyed by the input tuple, holding the printed answers. */
const MEMORISING = `_TABLE = {
    (250, 45, 60, 55, 0.15): {"netBenefit": 0.0494, "treatAll": 0.0191, "treatNone": 0, "netReductionPer100": 0.0},
    (1200, 130, 310, 180, 0.2): {"netBenefit": 0.0342, "treatAll": -0.0167, "treatNone": 0, "netReductionPer100": 0.0},
}
def net_benefit(specification):
    s = specification
    return _TABLE[(s["n"], s["truePositive"], s["falsePositive"], s["eventCount"], s["threshold"])]
`;

test("the static scan decides neither way: a lookup table passes and an honest `expected_value_*` variable is not refused", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-name-rule-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "honest.py"), HONEST);
  await writeFile(path.join(root, "memorising.py"), MEMORISING);
  const result = spawnSync("python3", ["-c", EVOLUTION_STATIC_CHECK.replaceAll("'/candidate'", JSON.stringify(root))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  // The static scan no longer pretends to decide this in either direction; a recital is told from a computation by running the code on inputs it never saw, which no evaluator does any more.
  assert.deepEqual(JSON.parse(result.stdout).issues, []);
  assert.doesNotMatch(EVOLUTION_STATIC_CHECK, /expected_value|gold_answer|holdout_answer/);
});
