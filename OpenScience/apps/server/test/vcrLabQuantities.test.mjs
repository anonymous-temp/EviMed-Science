// The lab's comparison of progression arms names the chance each arm states (round-2 review P1-9, S9): a mode-averaged number is never called 功效, a run on
// a record of virtual people names its fixed study, and the people of a comparison are the engine's draw from the model, never 你给的数据 (P1-1).
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_RESULT_QUANTITY_LABELS_ZH } from "@evimed/domain";
import { VcrExperiments } from "../src/vcrExperiments.mjs";

const study = { id: "study_1" };
const curves = [{ visit: 0, timeUnit: "weeks", control: { mean: { value: 20 } }, treated: { mean: { value: 20 } } }, { visit: 78, timeUnit: "weeks", control: { mean: { value: 26 } }, treated: { mean: { value: 24 } } }];
const result = (uncertainty, extra = {}) => ({ id: `res_${uncertainty}`, executionId: null, measures: [{ name: "power", value: 0.7, mcse: 0.005, simulated: true }],
  diagnostics: { progression: { family: "beta_logit", isNull: false, uncertainty, curves, ...extra } } });
const experiment = (arms, people = null) => new VcrExperiments({ store: {
  one: async () => ({ id: "exp_1", kind: "experiment", manifest: { kind: "disease", question: "q", purpose: "p", arms: arms.map((arm) => ({ name: arm.name, scenario: {} })),
    comparison: { measures: ["power"], reference: arms[0].name }, ...(people ? { people } : {}) }, state: { arms: Object.fromEntries(arms.map((arm) => [arm.name, { resultId: arm.result.id }])) } }),
  result: async (_study, id) => arms.map((arm) => arm.result).find((entry) => entry.id === id) ?? null,
  resultOfJob: async () => null,
}, jobs: null });

test("a comparison of arms run with study-to-study variation names that chance, never 功效", async () => {
  const view = await experiment([{ name: "无药", result: result("new_study") }, { name: "有药", result: { ...result("new_study"), id: "res_2" } }]).view(study, "exp_1");
  assert.equal(view.comparison[0].label, VCR_RESULT_QUANTITY_LABELS_ZH.expected_power_over_studies);
  assert.doesNotMatch(JSON.stringify(view.comparison[0].label), /功效/);
});

test("arms run on a record of virtual people name the fixed study's chance, and the people row is the engine's draw", async () => {
  const onRecord = (id) => ({ ...result("new_study"), id, diagnostics: { progression: { ...result("new_study").diagnostics.progression, people: { mode: "resampled_trials", people: 300 } } } });
  const view = await experiment([{ name: "无药", result: onRecord("res_a") }, { name: "有药", result: onRecord("res_b") }], { recordId: "res_people", mode: "resampled_trials" }).view(study, "exp_1");
  assert.equal(view.comparison[0].label, VCR_RESULT_QUANTITY_LABELS_ZH.conditional_power_fixed_study);
  const people = view.premises.find((premise) => premise.key === "lab:people");
  assert.equal(people.source, "default", "the engine drew these people from the model");
  assert.match(people.value, /同一份虚拟患者记录/);
  assert.equal(view.people.recordId, "res_people");
});

test("the typical study's power keeps a plain name and an arm in the null keeps the error it measures", async () => {
  const view = await experiment([{ name: "无药", result: result("typical_study") }, { name: "有药", result: { ...result("typical_study"), id: "res_2" } }]).view(study, "exp_1");
  assert.equal(view.comparison[0].label, VCR_RESULT_QUANTITY_LABELS_ZH.conditional_power_typical_study);
});

test("a time table says its unit and arms carry no raw progression block", async () => {
  const view = await experiment([{ name: "无药", result: result("new_study") }]).view(study, "exp_1");
  assert.equal(view.arms[0].trajectoryUnit, "周");
  assert.equal("progression" in view.arms[0], false);
});
