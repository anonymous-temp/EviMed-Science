// The closed set of names of the chances a result states (round 2, R24): different quantities, never a ladder.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_QUANTITY_REQUIRES, VCR_RESULT_QUANTITIES, VCR_RESULT_QUANTITY_LABELS_ZH, VCR_SIMULATION_ERROR_SENTENCE_ZH, VCR_UNCERTAINTY_MODE_QUANTITY, vcrQuantityAvailability } from "../index.mjs";

test("the set is closed and every name is its own words, a label never reused", () => {
  assert.deepEqual([...VCR_RESULT_QUANTITIES].sort(), Object.keys(VCR_RESULT_QUANTITY_LABELS_ZH).sort());
  assert.equal(new Set(Object.values(VCR_RESULT_QUANTITY_LABELS_ZH)).size, VCR_RESULT_QUANTITIES.length);
  assert.equal(VCR_RESULT_QUANTITY_LABELS_ZH.conditional_power_typical_study, "在典型研究条件下的把握度");
  assert.equal(VCR_RESULT_QUANTITY_LABELS_ZH.assurance, "按药效的不确定性平均后，得到显著结果的概率（assurance）");
  assert.equal(VCR_RESULT_QUANTITY_LABELS_ZH.trial_success_probability, "得到显著结果且药效达到最小重要差异的概率");
  // the three the uncertainty modes of a simulation produce are the first three, one each
  assert.deepEqual(Object.values(VCR_UNCERTAINTY_MODE_QUANTITY), ["conditional_power_typical_study", "expected_power_over_studies", "expected_power_over_parameters"]);
  // no label of an averaged quantity is called 功效, and no name of a programme's success exists
  for (const id of VCR_RESULT_QUANTITIES.filter((entry) => entry !== "conditional_power_typical_study")) assert.doesNotMatch(/** @type {Record<string, string>} */ (VCR_RESULT_QUANTITY_LABELS_ZH)[id], /功效/, id);
  for (const label of Object.values(VCR_RESULT_QUANTITY_LABELS_ZH)) assert.doesNotMatch(label, /研发成功率|项目成功/);
  assert.match(VCR_SIMULATION_ERROR_SENTENCE_ZH, /模拟本身的误差.*模型形式.*药效假设/);
});

test("a quantity that needs more than a run is computed only when everything it rests on is stated, and says what is missing", () => {
  assert.deepEqual(VCR_QUANTITY_REQUIRES.trial_success_probability, ["effectPrior", "mid", "betweenStudy", "estimand"]);
  const none = vcrQuantityAvailability("trial_success_probability", {});
  assert.equal(none.computable, false);
  assert.deepEqual(none.missing, ["effectPrior", "mid", "betweenStudy", "estimand"]);
  const partial = vcrQuantityAvailability("trial_success_probability", { effectPrior: true, mid: true, betweenStudy: false, estimand: true });
  assert.deepEqual(partial.missing, ["betweenStudy"], "a fact stated false is missing, like one not stated");
  assert.match(String(partial.sentence), /得到显著结果且药效达到最小重要差异的概率.*没有计算.*研究之间的差异/);
  const all = vcrQuantityAvailability("trial_success_probability", { effectPrior: true, mid: true, betweenStudy: true, estimand: true });
  assert.deepEqual([all.computable, all.missing, all.sentence], [true, [], null]);
  assert.equal(vcrQuantityAvailability("expected_power_given_mid", { effectPrior: true }).missing[0], "mid");
  assert.equal(vcrQuantityAvailability("assurance", { effectPrior: true }).computable, true);
  assert.equal(vcrQuantityAvailability("conditional_power_typical_study", {}).computable, true, "the typical study needs nothing beyond the run");
});
