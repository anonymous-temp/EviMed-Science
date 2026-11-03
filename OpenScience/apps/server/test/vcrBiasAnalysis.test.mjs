// The comparison page's cards of the algorithm round's comparator patches (C1, C2 bias analysis; C14 trimming; C8, C9 beside them): the engine's
// real results (tests/numeric N70-N73 hold their numbers to references) read into the payloads the comparator tab shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_METHODS, VCR_ROBUSTNESS_STAGES, vcrResultLimits } from "@evimed/domain";
import { biasEstimatePhrase, biasStatedWords, presentBiasAnalysis, vcrBiasEstimateOf, vcrBiasScenarioFromComparison } from "../src/vcrBiasAnalysis.mjs";
import { presentTrim } from "../src/vcrTrimView.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { vcrMergeStageResult, vcrResultKindFor } from "../src/vcrJobs.mjs";
import { vcrJobObjectKind } from "../src/vcrJobs.mjs";
import { vcrJobStage } from "../src/vcrSubjects.mjs";
import { measureLabel, measureValue } from "../src/vcrViewsKit.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-bias-analysis/${name}.json`, import.meta.url), "utf8"));
const value = (result) => (measure) => measureValue(measure, { kind: "comparator", result, tab: "comparator", staleMark: null });
const card = (name) => { const result = fixture(name); return presentBiasAnalysis(result, value(result)); };
/** The sentences and labels of a card, flattened: the string leaves under the keys that carry words (a back-office key would show as ascii with underscores). */
const WORD_KEYS = new Set(["question", "sentence", "note", "direction", "estimate", "stated", "bias", "what", "carrier", "interrupted", "title", "label"]);
const sayings = (node, key = "") => {
  if (typeof node === "string") return WORD_KEYS.has(key) ? [node] : [];
  if (Array.isArray(node)) return node.flatMap((each) => sayings(each, key));
  return node && typeof node === "object" ? Object.entries(node).flatMap(([k, each]) => sayings(each, k)) : [];
};

test("a bias analysis is a comparator job: filed under the comparator kind, a stage like the tipping point, an object of its own when it states its estimate", () => {
  assert.equal(VCR_JOB_METHODS.bias_analysis, "comparator.bias_analysis");
  assert.equal(VCR_JOB_METHODS.stc_comparator, "comparator.stc");
  for (const kind of ["bias_analysis", "stc_comparator"]) {
    assert.equal(vcrResultKindFor(kind), "comparator", kind);
    assert.equal(vcrJobObjectKind(kind), "comparator", kind);
  }
  assert.equal(vcrJobStage("bias_analysis", "comparator"), "bias_analysis");
  assert.equal(vcrJobStage("stc_comparator", "comparator"), "primary", "a simulated treatment comparison is a comparison, not a stress test of one");
  assert.ok(VCR_ROBUSTNESS_STAGES.includes("bias_analysis"));
});

test("a bias analysis filed as a stage of a comparison adds to it and weakens nothing; filed alone it reads limited, as an E-value does", () => {
  const stage = fixture("bias-ratio");
  const prior = { conclusion: "estimable", notEstimableRule: null, counts: { realPatients: 100 }, measures: [{ name: "weighted_difference", value: 0.4, simulated: false, source: "calculated" }],
    diagnostics: { balance: [{ covariate: "age", smdAdjusted: 0.02 }], stages: [{ stage: "primary", jobId: "j0", conclusion: "estimable", measures: ["weighted_difference"] }] }, tables: [] };
  const merged = vcrMergeStageResult(prior, { conclusion: stage.conclusion, notEstimableRule: null, counts: stage.counts, measures: stage.measures, diagnostics: stage.diagnostics, tables: [] },
    { stage: "bias_analysis", jobId: "j1", method: "comparator.bias_analysis", methodVersion: "1.0.0" });
  assert.equal(merged.conclusion, "estimable");
  assert.ok(merged.measures.some((measure) => measure.name === "weighted_difference") && merged.measures.some((measure) => measure.name === "bias_tipping_limit"));
  assert.ok(merged.diagnostics.biasAnalysis && merged.diagnostics.balance, "the comparison's own diagnostics stay beside the bias analysis");
  assert.deepEqual(merged.diagnostics.stages.map((entry) => entry.stage).sort(), ["bias_analysis", "primary"]);
  const alone = vcrMergeStageResult(null, { conclusion: stage.conclusion ?? "estimable", notEstimableRule: null, counts: stage.counts, measures: stage.measures, diagnostics: stage.diagnostics, tables: [] },
    { stage: "bias_analysis", jobId: "j1", method: "comparator.bias_analysis", methodVersion: "1.0.0" });
  assert.equal(alone.conclusion, "limited");
});

test("the estimate a bias analysis takes from a saved comparison is read by code, in a fixed order, and a comparison without one is refused by name", async () => {
  const hazard = { measures: [{ name: "hazard_ratio", value: 0.7, interval: { kind: "confidence", low: 0.5, high: 0.98, level: 0.95 } }, { name: "rmst_difference", value: 1.2, interval: { low: 0.1, high: 2.3 } }], diagnostics: {} };
  assert.deepEqual(vcrBiasEstimateOf(hazard), { scale: "hazard_ratio", estimate: 0.7, lower: 0.5, upper: 0.98, measure: "hazard_ratio", level: 0.95 }, "a ratio is preferred to a difference");
  const weighted = fixture("trim-weighting");
  const taken = vcrBiasEstimateOf(weighted);
  assert.equal(taken.scale, "difference");
  assert.equal(taken.measure, "weighted_difference");
  const stc = vcrBiasEstimateOf(fixture("stc-anchored"));
  assert.equal(stc.scale, "odds_ratio", "a logit-link contrast is a log odds ratio, read as the ratio");
  assert.ok(Math.abs(Math.log(stc.estimate) - fixture("stc-anchored").measures.find((m) => m.name === "indirect_estimate").value) < 1e-12);
  assert.equal(vcrBiasEstimateOf({ measures: [{ name: "effective_sample_size", value: 90 }], diagnostics: {} }), null);

  const store = (result) => ({
    comparatorDesigns: async () => [{ id: "cmp_1", resultId: result ? "res_1" : null }],
    result: async () => (result ? { id: "res_1", ...result } : null),
  });
  const filled = await vcrBiasScenarioFromComparison({ store: store(hazard), study: { id: "std_1" }, subjectId: "cmp_1", scenario: { probabilistic: { bias: { family: "constant", value: 1.2 } } } });
  assert.deepEqual(filled.scenario, { probabilistic: { bias: { family: "constant", value: 1.2 } }, scale: "hazard_ratio", estimate: 0.7, lower: 0.5, upper: 0.98 });
  assert.deepEqual(filled.from, { resultId: "res_1", measure: "hazard_ratio" });
  // a call that states its estimate keeps it; a call that names no comparison is left to the validator
  const stated = await vcrBiasScenarioFromComparison({ store: store(hazard), study: { id: "std_1" }, subjectId: "cmp_1", scenario: { scale: "hazard_ratio", estimate: 0.6, se: 0.2 } });
  assert.equal(stated.from, null);
  assert.equal(stated.scenario.estimate, 0.6);
  assert.equal((await vcrBiasScenarioFromComparison({ store: store(hazard), study: { id: "std_1" }, subjectId: null, scenario: {} })).from, null);
  const refused = await vcrBiasScenarioFromComparison({ store: store(null), study: { id: "std_1" }, subjectId: "cmp_1", scenario: {} });
  assert.ok("refused" in refused && /先算出对照的结果/.test(refused.refused.message));
  // a 90% interval is carried with its level so the engine backs the standard error out with the right quantile
  const ninety = await vcrBiasScenarioFromComparison({ store: store({ measures: [{ name: "hazard_ratio", value: 0.7, interval: { low: 0.5, high: 0.98, level: 0.9 } }], diagnostics: {} }), study: { id: "std_1" }, subjectId: "cmp_1", scenario: {} });
  assert.equal(ninety.scenario.confidenceLevel, 0.9);
});

test("the card opens with the question a person asked, then the tipping bias in plain words, and every part it was asked for", () => {
  const each = card("bias-ratio");
  assert.equal(each.question, "未测混杂要造成多大的偏移，结论才翻？");
  assert.equal(each.estimate, "风险比（HR） 0.7（95% 区间 0.5–0.98）");
  assert.match(each.tipping.sentence, /偏倚要把效应夸大 1\.02 倍.*无效线（1）.*需要夸大 1\.43 倍/);
  assert.equal(each.tipping.alreadyIncludesNull, false);
  assert.ok(Math.abs(each.tipping.limit.value - 1.0204) < 1e-3 && each.tipping.limit.source === "calculated");
  // the shifted null: one row per stated bias, the interval after removing it, the one-sided P, whether the null is still outside
  assert.equal(each.shiftedNull.question, "如果偏倚真有这么大，效应还站得住吗？");
  assert.deepEqual(each.shiftedNull.rows.map((row) => row.bias), ["1.1 倍", "1.25 倍", "1.5 倍"]);
  assert.deepEqual(each.shiftedNull.rows.map((row) => row.holds), [false, false, false], "with an interval whose limit is 0.98, no stated bias leaves the effect standing");
  assert.match(each.shiftedNull.rows[0].sentence, /区间已含无效线/);
  assert.ok(each.shiftedNull.rows[1].p.value > 0 && each.shiftedNull.rows[1].p.value < 1);
  // the tipping confounder: which arm carries more of it, how much, and when no such confounder exists
  assert.equal(each.confounder.rows.length, 3);
  const first = each.confounder.rows[0];
  assert.equal(first.estimate.carrier, "对照组", "a protective estimate is exaggerated by a confounder that is more common among the controls");
  assert.ok(first.estimate.sentence.includes("个百分点") || first.estimate.sentence.includes("不存在"));
  assert.equal(each.confounder.rows.some((row) => row.estimate.feasible), true);
  // the probabilistic analysis: simulated, with its error, and what was stated
  assert.equal(each.probabilistic.question, "按你设定的偏倚范围，校正后的效应和区间是多少？");
  assert.equal(each.probabilistic.adjusted.source, "calculated");
  assert.ok(each.probabilistic.adjusted.mcse > 0 && each.probabilistic.adjusted.interval.low < each.probabilistic.adjusted.value);
  assert.equal(each.probabilistic.persists.unit, "%");
  assert.match(each.probabilistic.stated, /混杂因素在试验组的比例三角分布.*对数正态/);
  assert.equal(each.probabilistic.draws, 100000);
});

test("no back-office word reaches the card: every label and sentence is Chinese", () => {
  for (const name of ["bias-ratio", "bias-null", "bias-difference"]) {
    const words = sayings(card(name));
    assert.ok(words.length >= 4, name);
    for (const word of words) assert.doesNotMatch(word, /[a-z]+_[a-z_]+/, `${name}: ${word}`);
  }
  for (const measure of ["bias_tipping_limit", "bias_tipping_estimate", "bias_adjusted_estimate", "bias_adjusted_effect_persists", "trimmed_treated", "trimmed_control", "marginal_contrast_ipd", "marginal_level_ipd", "conditional_contrast_ipd"]) {
    assert.match(measureLabel(measure), /[一-龥]/, measure);
  }
});

test("an interval that already holds the null says so, and a difference is worded as an amount", () => {
  const holds = card("bias-null");
  assert.equal(holds.tipping.alreadyIncludesNull, true);
  assert.match(holds.tipping.sentence, /本来就包含无效线（1），不需要任何偏倚结论就站不住/);
  assert.equal(holds.shiftedNull, null, "a part the call did not ask for is not on the card");
  assert.equal(holds.probabilistic, null);
  const amount = card("bias-difference");
  assert.match(amount.estimate, /差值 -2\.4/);
  assert.match(amount.direction, /差值向 0 靠近/);
  assert.match(amount.tipping.sentence, /无效线（0）/);
  assert.equal(amount.shiftedNull.rows[0].bias, "0.5", "an amount, not a multiple");
  assert.equal(amount.confounder.rows.length, 2);
  assert.match(amount.probabilistic.stated, /偏倚量在 0 到 1 之间均匀分布/);
});

test("the premises name the estimate analysed and the bias that was stated, and a default grid is a default", () => {
  const result = fixture("bias-ratio");
  const rows = vcrPremises("comparator", { route: "literature_control", diagnostics: result.diagnostics, measures: {} });
  const by = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(by.biasEstimate.value, "风险比（HR） 0.7（95% 区间 0.5–0.98）");
  assert.equal(by.biasEstimate.source, "given");
  assert.equal(by.biasEstimate.decisive, true);
  assert.match(by.biasStated.value, /混杂因素在试验组的比例/);
  assert.equal(by.biasStated.source, "assumed");
  assert.equal(by.biasDirection.decisive, false);
  assert.ok(!by.biasGrid, "the associations were stated, so there is no default grid to name");
  const defaulted = vcrPremises("comparator", { route: "literature_control", diagnostics: fixture("bias-null").diagnostics, measures: {} });
  assert.match(defaulted.find((row) => row.key === "biasGrid").value, /1\.5、2、3、5（没有设定，按参考网格算）/);
  assert.equal(defaulted.find((row) => row.key === "biasGrid").source, "default");
  assert.ok(rows.filter((row) => row.decisive).length <= 5);
  assert.equal(biasEstimatePhrase({}), null);
  assert.equal(biasStatedWords({}), null);
});

test("a propensity trimming restates the population: who was removed in each arm, what they were like, and a limit on the conclusion", () => {
  const result = fixture("trim-weighting");
  const trim = presentTrim(result.diagnostics.trim);
  assert.equal(trim.rule, "fixed");
  assert.deepEqual(trim.arms.map((arm) => arm.arm), ["试验组", "对照组"]);
  assert.equal(trim.removed, trim.arms[0].removed + trim.arms[1].removed);
  assert.match(trim.sentence, /你设定的界值.*倾向评分低于 0\.1 或高于 0\.9.*试验组 \d+ 例、对照组 \d+ 例。结论只适用于留下的人/);
  const age = trim.covariates.find((row) => row.covariate === "x1");
  assert.ok(age && age.treated.removed !== "—" && age.treated.kept !== "—", "the removed trial people are compared with the kept ones");
  assert.match(trim.covariates.find((row) => row.covariate === "x2").control.removed, /%$/, "a 0/1 covariate is a proportion");
  const limits = vcrResultLimits({ conclusion: "limited", method: "comparator.propensity_weight", diagnostics: result.diagnostics, measures: result.measures });
  assert.ok(limits.some((entry) => entry.key === "trim" && /只适用于修剪后留下的人/.test(entry.text)));
  const premises = vcrPremises("comparator", { route: "external_control", diagnostics: result.diagnostics, measures: {} });
  const row = premises.find((entry) => entry.key === "trimmedPopulation");
  assert.match(row.value, /去掉试验组 \d+ 例、对照组 \d+ 例.*结论只适用于留下的人/);
  assert.equal(row.source, "assumed", "a fixed bound is the person's own");
  assert.equal(presentTrim(null), null);
  const none = presentTrim({ rule: "crump", lower: 0, upper: 1, arms: [{ arm: "treated", n: 5, kept: 5, removed: 0, removedShare: 0 }, { arm: "control", n: 5, kept: 5, removed: 0, removedShare: 0 }], baseline: [], removedTotal: 0, keptTotal: 10 });
  assert.match(none.sentence, /没有去掉任何人/);
});

test("the time-to-event doubly robust estimate and an unanchored G-computation comparison carry their premises", () => {
  const aipw = fixture("aipw-tte");
  assert.equal(aipw.diagnostics.endpoint, "time_to_event");
  const premises = vcrPremises("comparator", { route: "external_control", diagnostics: aipw.diagnostics, measures: {} });
  assert.match(premises.find((row) => row.key === "censoringIndependent").value, /删失与协变量无关/);
  const stc = fixture("stc-unanchored");
  const rows = vcrPremises("comparator", { route: "literature_control", diagnostics: stc.diagnostics, measures: {}, anchored: stc.diagnostics.anchored });
  assert.equal(rows.find((row) => row.key === "residual").value, "假定所有预后因子和效应修饰因子都已调整", "the same premise row as the unanchored MAIC");
  assert.equal(rows.find((row) => row.key === "maicTarget").value, "对方试验已发表的人群（只有汇总数）");
  assert.equal(vcrPremises("comparator", { route: "literature_control", diagnostics: fixture("stc-anchored").diagnostics, measures: {}, anchored: true }).find((row) => row.key === "residual"), undefined);
  const limits = vcrResultLimits({ conclusion: "limited", method: "comparator.stc", diagnostics: stc.diagnostics, measures: stc.measures });
  assert.deepEqual(limits, [], "an unanchored comparison says its premise in the premises, and is read as a benchmark");
});
