// A simulated type I error is said from the verdict on its conservative bound (live D8, 2026-11-07): the trial page's rows, the inbox
// title and the answer a conversation reads share one function, and it is the lab's constraint judge.
import test from "node:test";
import assert from "node:assert/strict";
import { vcrJudgeConstraint } from "@evimed/domain";
import { vcrTypeOneLevel, vcrTypeOneVerdict } from "../src/vcrTypeOneVerdict.mjs";

test("a rate at the level cannot be decided, one clear of it passes, one above it fails: the live numbers", () => {
  // The 612-patient null run of the live conversation: 2.53% with MCSE 0.11%, upper bound 2.75%.
  const atLevel = vcrTypeOneVerdict({ value: 0.0253, mcse: 0.0011, bound: 0.025 });
  assert.equal(atLevel.status, "inconclusive");
  assert.equal(atLevel.text, "无法确定是否不超过 2.5%（模拟 2.53% ± 0.11%）");
  assert.ok(atLevel.upper > 0.0274 && atLevel.upper < 0.0276, String(atLevel.upper));
  // The 500-patient null run: 2.275% with MCSE 0.105%, upper bound 2.48%.
  const clear = vcrTypeOneVerdict({ value: 0.02275, mcse: 0.00105, bound: 0.025 });
  assert.equal(clear.status, "pass");
  assert.match(clear.text, /^不超过 2\.5%（模拟 2\.2[78]% ± 0\.1[01]%）$/);
  // A point estimate under the level is not enough on its own: 2.45% ± 0.11% is still undecided.
  assert.equal(vcrTypeOneVerdict({ value: 0.0245, mcse: 0.0011, bound: 0.025 }).status, "inconclusive");
  const above = vcrTypeOneVerdict({ value: 0.031, mcse: 0.0012, bound: 0.025 });
  assert.equal(above.status, "fail");
  assert.equal(above.text, "超过 2.5%（模拟 3.10% ± 0.12%）");
});

test("it is the lab's judge: the same status as vcrJudgeConstraint on the same estimate and error", () => {
  for (const [value, mcse] of [[0.0253, 0.0011], [0.0228, 0.00105], [0.0262, 0.0011], [0.04, 0.002], [0.0201, 0.0005]]) {
    const lab = vcrJudgeConstraint({ space: { method: "design.simulate" } },
      { measure: "type_one_error", op: "<=", bound: 0.025, kind: "error_control", confidence: 0.975 },
      { state: "succeeded", measures: [{ name: "type_one_error", value, mcse, simulated: true }] }, { stage: "final" });
    assert.equal(vcrTypeOneVerdict({ value, mcse, bound: 0.025 }).status, lab.status, `${value} ± ${mcse}`);
  }
});

test("an exact value is compared as it is, and nothing is said without an estimate or a level", () => {
  assert.deepEqual(vcrTypeOneVerdict({ value: 0.025, mcse: null, bound: 0.025 }), { status: "pass", simulated: false, lower: 0.025, upper: 0.025, text: "不超过 2.5%（计算值 2.5%）" });
  assert.equal(vcrTypeOneVerdict({ value: 0.0312, bound: 0.025 }).text, "超过 2.5%（计算值 3.12%）");
  assert.equal(vcrTypeOneVerdict({ value: null, mcse: 0.001, bound: 0.025 }), null);
  assert.equal(vcrTypeOneVerdict({ value: 0.02, mcse: 0.001, bound: null }), null);
  assert.equal(vcrTypeOneVerdict({ value: 0.02, mcse: 0.001, bound: 2.5 }), null, "a level is a proportion, never a percentage");
});

test("the level is the scenario's, else the applied default, else the closed form a type I check was held against", () => {
  assert.equal(vcrTypeOneLevel({ scenario: { analysis: { alpha: 0.05 } }, result: { diagnostics: { analyticCheck: { name: "type_one_error", value: 0.025 } } } }), 0.05);
  assert.equal(vcrTypeOneLevel({ result: { diagnostics: { appliedDefaults: [{ path: "analysis.alpha", value: 0.025 }] } } }), 0.025);
  assert.equal(vcrTypeOneLevel({ result: { diagnostics: { analyticCheck: { name: "type_one_error", value: 0.025, simulated: 0.0253 } } } }), 0.025);
  assert.equal(vcrTypeOneLevel({ result: { diagnostics: { analyticCheck: { name: "power", value: 0.9 } } } }), null, "a power check names no level");
  assert.equal(vcrTypeOneLevel({}), null);
});

test("the inbox title of a finished null run says the verdict, not the estimate rounded onto the level", async () => {
  const { vcrJobNoticeText } = await import("../src/vcrNotify.mjs");
  const title = (/** @type {Record<string, any>} */ measure, /** @type {Record<string, any>} */ diagnostics = {}) =>
    vcrJobNoticeText({ resultKind: "trial_scenario", stage: "simulation", label: "试验方案 4", state: "succeeded", result: { conclusion: "estimable", measures: [measure], diagnostics } })?.title;
  const check = { analyticCheck: { name: "type_one_error", value: 0.025, simulated: 0.0253, difference: 0.0003, withinTolerance: true } };
  assert.equal(title({ name: "type_one_error", value: 0.0253, mcse: 0.0011, simulated: true }, check),
    "方案模拟完成：试验方案 4 I 类错误无法确定是否不超过 2.5%（模拟 2.53% ± 0.11%）");
  assert.match(title({ name: "type_one_error", value: 0.02275, mcse: 0.00105, simulated: true }, { appliedDefaults: [{ path: "analysis.alpha", value: 0.025 }] }),
    /^方案模拟完成：试验方案 4 I 类错误不超过 2\.5%（模拟 2\.2[78]% ± 0\.1[01]%）$/);
  // No level to judge against: the estimate with its error, never 「2.5%」 for 2.53%.
  assert.equal(title({ name: "type_one_error", value: 0.0253, mcse: 0.0011, simulated: true }), "方案模拟完成：试验方案 4 I 类错误 2.53% ± 0.11%");
  assert.equal(title({ name: "type_one_error", value: 0.025 }), "方案模拟完成：试验方案 4 I 类错误 2.5%", "an exact value as it is (live D9's title stays)");
});
