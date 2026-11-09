// The comparison page's card of a target-trial emulation (algorithm round C3, C4): the engine's real results (tests/numeric N79 and N80 hold their numbers to
// TrialEmulation and to a known truth) read into the payload the comparator tab shows, the premises they rest on and the sentences they are read with care by.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_METHODS, VCR_NOT_ESTIMABLE_RULES, vcrResultLimits } from "@evimed/domain";
import { presentTargetTrial, targetTrialPremises } from "../src/vcrTargetTrialView.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";
import { JOB_KIND_LABELS } from "../src/vcrViews.mjs";
import { METHOD_LABELS, measureLabel, measureValue } from "../src/vcrViewsKit.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-target-trial/${name}.json`, import.meta.url), "utf8"));
const value = (result) => (measure) => measureValue(measure, { kind: "comparator", result, tab: "comparator", staleMark: null });
const card = (name) => { const result = fixture(name); return presentTargetTrial(result, value(result)); };
const WORD_KEYS = new Set(["question", "sentence", "meaning", "answers", "label", "weights", "bootstrap", "naiveSentence"]);
const sayings = (node, key = "", out = []) => {
  if (typeof node === "string") { if (WORD_KEYS.has(key)) out.push(node); }
  else if (Array.isArray(node)) node.forEach((each) => sayings(each, key === "checks" ? "sentence" : key, out));
  else if (node && typeof node === "object") Object.entries(node).forEach(([k, each]) => sayings(each, k === "checks" ? "sentence" : k, out));
  return out;
};

test("a target-trial emulation is a comparator job: filed under the comparator kind, with its labels and the rules it can end in", () => {
  assert.equal(VCR_JOB_METHODS.target_trial_emulation, "comparator.target_trial");
  assert.equal(vcrResultKindFor("target_trial_emulation"), "comparator");
  assert.equal(JOB_KIND_LABELS.target_trial_emulation, "目标试验模拟");
  assert.equal(METHOD_LABELS["comparator.target_trial"], "目标试验模拟");
  for (const rule of ["no_eligible_person_trials", "arm_without_person_trials", "horizon_beyond_followup", "outcome_model_not_estimable"]) assert.ok(VCR_NOT_ESTIMABLE_RULES.includes(rule), rule);
  for (const name of ["risk_difference_itt", "risk_difference_pp", "risk_treated_pp", "risk_control_itt", "risk_ratio_pp", "risk_difference_start", "risk_treated_start", "risk_control_start", "risk_ratio_start"]) assert.notEqual(measureLabel(name), name, `${name} has a label`);
});

test("the sequence of trials opens with the person's question, says which estimand each block is and shows both arms beside the difference", () => {
  const result = fixture("sequential");
  const shown = card("sequential");
  assert.match(shown.question, /治疗起始时间各不相同的队列，开始治疗和不开始治疗的效应是多少，而且没有永恒时间偏倚/);
  assert.deepEqual(shown.estimands.map((entry) => entry.kind), ["itt", "pp"]);
  assert.match(shown.estimands[0].meaning, /开始之后治疗有没有变都不管/);
  assert.match(shown.estimands[1].meaning, /偏离了所在组，就在那一期删失/);
  for (const entry of shown.estimands) {
    assert.match(entry.answers, /第 6 个月末的累积风险差 = 试验组风险 − 对照组风险（(意向治疗|按方案)）/, "the horizon and the contrast are said");
    assert.equal(entry.riskDifference.unit, "%");
    assert.ok(entry.riskDifference.interval && entry.riskTreated.interval && entry.riskControl.interval, "an interval on each number");
    assert.equal(entry.riskDifference.source, "calculated");
  }
  const pp = shown.estimands.find((entry) => entry.kind === "pp");
  const measure = result.measures.find((entry) => entry.name === "risk_difference_pp");
  assert.ok(Math.abs(pp.riskDifference.value - measure.value * 100) < 1e-6, "the card's number is the result's own measure, in percent");
  assert.match(shown.weights, /权重（稳定化）平均/);
  assert.match(shown.bootstrap, /重抽样 2000 次/);
  assert.ok(shown.checks.some((text) => /个模拟试验/.test(text)));
  assert.equal(shown.naive, null, "a sequence of trials has no naive comparison");
});

test("clone-censor-weight names its grace period, the waiting time and the naive comparison as a warning about the data", () => {
  const shown = card("clone-censor-weight");
  assert.match(shown.question, /3 周内开始治疗，与不开始治疗相比，效应是多少/);
  // the strategy reads the start and nothing after it: it is not a per-protocol estimand and is not called one (review stats2 finding 16)
  assert.deepEqual(shown.estimands.map((entry) => entry.kind), ["start"]);
  assert.equal(shown.estimands[0].label, "宽限期内开始治疗");
  assert.doesNotMatch(JSON.stringify(shown), /按方案/);
  assert.match(shown.estimands[0].answers, /第 12 周末的累积风险差/);
  assert.match(shown.sentence, /宽限期的最后一期开始时还没开始治疗的人，在“开始”组里被删失/);
  assert.match(shown.weights, /始终不开始的一组平均.*宽限期内开始的一组平均/, "both arms' weights are said");
  assert.match(shown.checks.join(""), /中位等待时间是 \d+ 周/);
  assert.match(shown.naiveSentence, /朴素风险差.*不是结果/);
  assert.ok(shown.naive && shown.naive.value < shown.estimands[0].riskDifference.value, "the naive difference is the larger benefit: it credits the treated with the time they waited");
  assert.equal(shown.naive.interval, null, "it carries no interval: it is not a result");
});

test("the premises, the limits of a run that was stopped, no back-office word, nothing for another method", () => {
  const stopped = fixture("sequential-stopped");
  const rows = targetTrialPremises(stopped.diagnostics);
  assert.deepEqual(rows.map((row) => row.key), ["trialStrategy", "trialWeights", "trialFollowUp"]);
  assert.equal(rows[0].decisive, true);
  const premises = vcrPremises("comparator", { route: "external_control", estimand: "ATT", estimandStated: false, diagnostics: stopped.diagnostics, measures: {}, applicability: null, targetTrial: null, covariates: [], anchored: null });
  assert.ok(premises.some((row) => row.key === "trialStrategy"), "the premise reaches the block");
  const limits = vcrResultLimits({ conclusion: stopped.conclusion, method: "comparator.target_trial", diagnostics: stopped.diagnostics, measures: stopped.measures });
  assert.ok(limits.some((entry) => entry.key === "bootstrap_stopped_early" && /1000 次/.test(entry.text)), JSON.stringify(limits));
  assert.equal(stopped.conclusion, "limited");
  assert.match(presentTargetTrial(stopped, value(stopped)).bootstrap, /重抽样 1000 次（计划 2000 次，计算时间用完了）/);
  assert.equal(presentTargetTrial({ diagnostics: {}, measures: [] }, () => null), null);
  assert.equal(presentTargetTrial(null, () => null), null);
  assert.deepEqual(targetTrialPremises({}), []);
  for (const name of ["sequential", "clone-censor-weight", "sequential-stopped"]) {
    for (const sentence of sayings(card(name))) assert.doesNotMatch(sentence, /bootstrap|nnet|TrialEmulation|handler|diagnostics|_|\bITT\b|\bPP\b/i, sentence);
  }
});

test("the limits of the new cases are said: an arm with no event, a per-protocol estimand the follow-up cannot carry, a horizon inside the grace period, people treated before time zero, a median past the data", () => {
  const sequential = fixture("sequential");
  const diagnostics = {
    ...sequential.diagnostics,
    limitedBy: ["arm_without_events", "per_protocol_beyond_protocol_follow_up"],
    targetTrial: { ...sequential.diagnostics.targetTrial, armsWithoutEvents: [{ estimand: "itt", arms: ["treated"], upperLimits: { treated: { n: 200, risk: 0.01828, level: 0.95 } } }],
      droppedEstimands: [{ estimand: "pp", rule: "horizon_beyond_followup", arm: "treated", longestOnProtocol: 3, horizon: 10 }] },
  };
  const limits = vcrResultLimits({ conclusion: "limited", method: "comparator.target_trial", diagnostics, measures: sequential.measures });
  const keys = limits.map((entry) => entry.key);
  assert.ok(keys.includes("arm_without_events") && keys.includes("per_protocol_beyond_protocol_follow_up"), JSON.stringify(keys));
  assert.match(limits.find((entry) => entry.key === "arm_without_events").text, /试验组一例事件也没有.*没有区间/);
  const shown = presentTargetTrial({ ...sequential, diagnostics }, value(sequential));
  assert.ok(shown.checks.some((text) => /试验组一例事件也没有.*不高于大约 1\.83%.*200 人里 0 例/.test(text)), shown.checks.join("|"));
  assert.ok(shown.checks.some((text) => /按方案的结果没有给出：试验组里没有人在方案上待满.*最长 3 期/.test(text)), shown.checks.join("|"));
  const ccw = fixture("clone-censor-weight");
  const inside = { ...ccw, diagnostics: { ...ccw.diagnostics, limitedBy: ["horizon_inside_grace_period", "treated_before_time_zero"],
    targetTrial: { ...ccw.diagnostics.targetTrial, design: { ...ccw.diagnostics.targetTrial.design, gracePeriod: 15, horizonInsideGracePeriod: true, treatedBeforeTimeZero: 31 } } } };
  const ccwLimits = vcrResultLimits({ conclusion: "limited", method: "comparator.target_trial", diagnostics: inside.diagnostics, measures: ccw.measures }).map((entry) => entry.key);
  assert.ok(ccwLimits.includes("horizon_inside_grace_period") && ccwLimits.includes("treated_before_time_zero"), JSON.stringify(ccwLimits));
  const ccwCard = presentTargetTrial(inside, value(ccw));
  assert.ok(ccwCard.checks.some((text) => /还在宽限期（15 周）之内.*不是“宽限期内开始治疗”的风险/.test(text)), ccwCard.checks.join("|"));
  assert.ok(ccwCard.checks.some((text) => /时间零点之前用过药、之后没再用 31 人/.test(text)));
  const fit = vcrResultLimits({ conclusion: "limited", method: "model.survival_fit", diagnostics: { limitedBy: ["median_beyond_follow_up"], model: { medianTimesLongestFollowUp: 4.2 } }, measures: [] });
  assert.ok(fit.some((entry) => entry.key === "median_beyond_follow_up" && /最长随访的 4\.2 倍/.test(entry.text)), JSON.stringify(fit));
});
