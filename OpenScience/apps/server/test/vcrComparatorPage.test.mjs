// What a comparator's page says beside its estimate (remediation plan A5-A9, A13 and owner decision 2 of 2026-11-01), read from a bundle
// the way `vcrViews.test.mjs` reads one: no database. The estimate is on the page in every case; these are the sentences and rows that
// stand beside it.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_PREMISES_DECISIVE_MAX, vcrApplicabilityLimits } from "@evimed/domain";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { presentComparatorTab } from "../src/vcrViewsTabs.mjs";
import { comparatorReminders } from "../src/vcrGateway.mjs";
import { comparatorLimitsDetail } from "../src/vcrOrchestrator.mjs";
import { assumptionSummary } from "../src/vcrViews.mjs";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const AT = "2026-11-01T11:00:00.000Z";
const bundleOf = (/** @type {Record<string, any>} */ over = {}) => ({
  now: NOW, study: { id: "std_1", intendedUse: "exploratory", dataTier: "T2", steps: {}, abilities: [] }, definition: null, results: [], allResults: [], stale: [], reviews: [],
  jobs: [], budget: null, assumptions: [], members: [], exports: [], decisions: [], roles: [], scenarios: [], comparators: [], comparator: null, populations: [],
  patientSets: [], grid: null, forecasts: [], models: [], executions: new Map(), protocol: null, criteria: [], jobMarks: [], currentNodes: new Set(), ...over,
});

/** A comparator row and its result, read as one page. */
function page({ route = "external_control", row = /** @type {Record<string, any>} */ ({}), result = /** @type {Record<string, any>} */ ({}), method = "comparator.entropy_balance" } = {}) {
  const comparator = { id: "cmp_1", version: 1, route, estimand: "ATT", resultId: "res_1", conclusion: result.conclusion ?? "estimable", gapList: [], createdAt: AT, targetTrial: {}, configuration: {}, ...row };
  const filed = { id: "res_1", version: 1, kind: "comparator", conclusion: "estimable", counts: {}, measures: [], diagnostics: {}, createdAt: AT, executionId: "ex_1", ...result };
  const executions = new Map([["ex_1", { id: "ex_1", jobId: "job_1", method, methodVersion: "1.2.0" }]]);
  return presentComparatorTab(bundleOf({ comparators: [comparator], comparator, results: [filed], allResults: [filed], executions }));
}

const balance = (/** @type {Array<[string, number, number]>} */ rows) => rows.map(([covariate, smdUnadjusted, smdAdjusted]) => ({ covariate, smdUnadjusted, smdAdjusted }));

test("decision 2: a weighted balance above 0.10 is delivered limited with its value and its worst variable; above 0.25 it is severe", () => {
  const moderate = page({ result: { conclusion: "limited", measures: [{ name: "weighted_difference", value: 3, source: "calculated" }],
    diagnostics: { balance: balance([["age", 0.7, 0.119], ["educ", 0.1, 0.03]]), balanceVerdict: { band: "moderate", worst: 0.119, variable: "age", floor: 0.1, severeFloor: 0.25 } } } });
  assert.deepEqual(moderate.limits.map((entry) => entry.key), ["balance"]);
  assert.equal(moderate.limits[0].text, "加权后“age”的标准化差异仍为 0.12，超过界值 0.1。");
  assert.equal(moderate.verdict.conclusion, "limited", "the estimate stands, limited");
  assert.equal(moderate.gaps, null, "no gap list: it is not a refusal");
  assert.match(moderate.comparabilityNote, /界值 0\.1，超过 0\.25 为严重失衡/);
  assert.deepEqual(moderate.comparability.map((row) => row.flagged), [true, false]);

  const severe = page({ result: { conclusion: "limited", diagnostics: { balance: balance([["re74", 0.5, 0.274]]), balanceVerdict: { band: "severe", worst: 0.274, variable: "re74" } } } });
  assert.equal(severe.limits[0].text, "严重失衡：加权后“re74”的标准化差异为 0.27，超过 0.25。");

  // a balanced comparison says nothing; one written before the engine said its verdict is read from its table
  assert.deepEqual(page({ result: { diagnostics: { balance: balance([["age", 0.7, 0.04]]), balanceVerdict: { band: "balanced", worst: 0.04, variable: "age" } } } }).limits, []);
  assert.equal(page({ result: { conclusion: "limited", diagnostics: { balance: balance([["age", 0.7, 0.31]]) } } }).limits[0].key, "balance");
  // and a result that was refused by the old rule keeps its gap list and says nothing of a balance beside a number it does not have
  const old = page({ result: { conclusion: "not_estimable", notEstimableRule: "standardized_difference_above_floor", diagnostics: { balance: balance([["age", 0.7, 0.31]]) } } });
  assert.deepEqual(old.limits, []);
  assert.equal(old.verdict.conclusion, "not_estimable");
});

test("A8: a result that is a benchmark is read as 仅基准; the conclusion the engine stored is not changed", () => {
  const maic = page({ route: "literature_control", method: "comparator.maic", row: { configuration: { method: "maic" } },
    result: { conclusion: "limited", measures: [{ name: "indirect_estimate", value: 0.8, source: "calculated" }], diagnostics: { anchored: false, targetPopulation: "aggregate_data_trial", unadjustedEffectModifiers: ["ECOG"] } } });
  assert.equal(maic.verdict.conclusion, "benchmark_only");
  assert.match(maic.headline, /^文献对照：仅基准/);
  assert.equal(maic.routes.find((route) => route.route === "literature_control").state, "benchmark_only");

  const anchored = page({ route: "literature_control", method: "comparator.maic", result: { conclusion: "limited", diagnostics: { anchored: true } } });
  assert.equal(anchored.verdict.conclusion, "limited", "an anchored comparison is an estimate");

  const curve = page({ route: "literature_control", method: "evidence.reconstruct_km", result: { conclusion: "estimable", measures: [{ name: "median_survival", value: 9, source: "reconstructed" }] } });
  assert.equal(curve.verdict.conclusion, "benchmark_only");
  assert.deepEqual(curve.limits.map((entry) => entry.key), ["benchmark"]);
  assert.match(curve.limits[0].text, /没有和另一组比较/);

  const prediction = page({ route: "model_comparator", method: "model.prognostic_apply", result: { conclusion: "limited", diagnostics: { sourceCondition: "control", absoluteRiskAvailable: false } } });
  assert.equal(prediction.verdict.conclusion, "benchmark_only");
  assert.match(prediction.limits.find((entry) => entry.key === "benchmark").text, /不识别治疗效应/);

  const weighted = page({ method: "comparator.weighted_cox", result: { conclusion: "estimable" } });
  assert.equal(weighted.verdict.conclusion, "estimable");
  assert.equal(page({ route: "literature_control", method: "comparator.maic", result: { conclusion: "not_estimable", diagnostics: { anchored: false } } }).verdict.conclusion, "not_estimable");
});

test("A9: an indirect comparison shows its target population and the effect modifiers it did not adjust; unanchored adds its premise", () => {
  const diagnostics = { anchored: false, targetPopulation: "aggregate_data_trial", unadjustedEffectModifiers: ["ECOG", "LDH"] };
  const tab = page({ route: "literature_control", method: "comparator.maic", result: { conclusion: "limited", diagnostics } });
  const rows = Object.fromEntries(tab.premises.map((row) => [row.key, row]));
  assert.equal(rows.maicTarget.value, "对方试验已发表的人群（只有汇总数）");
  assert.equal(rows.maicTarget.source, "literature");
  assert.equal(rows.maicModifiers.value, "ECOG、LDH");
  assert.equal(rows.residual.label, "无锚定");
  assert.equal(rows.residual.value, "假定所有预后因子和效应修饰因子都已调整", "the premise itself, with its value");
  assert.equal(rows.residual.decisive, true);
  assert.ok(tab.premises.filter((row) => row.decisive).length <= VCR_PREMISES_DECISIVE_MAX);

  const anchored = page({ route: "literature_control", method: "comparator.maic", result: { conclusion: "limited", diagnostics: { ...diagnostics, anchored: true, unadjustedEffectModifiers: [] } } });
  const kept = Object.fromEntries(anchored.premises.map((row) => [row.key, row]));
  assert.equal(kept.residual, undefined, "an anchored comparison has a common comparator and says nothing of residual error");
  assert.equal(kept.maicModifiers.value, "没有列出", "none listed is said, not left out");
});

test("A5: the E-value stands in the premises, worded as a strength and never as the absence of bias", () => {
  const tab = page({ method: "comparator.weighted_cox", result: { conclusion: "estimable", measures: [
    { name: "hazard_ratio", value: 0.62, source: "calculated" }, { name: "e_value", value: 2.12, source: "calculated" }, { name: "e_value_confidence_limit", value: 1.63, source: "calculated" }] } });
  const row = tab.premises.find((entry) => entry.key === "unmeasured");
  assert.equal(row.label, "未测量的混杂");
  assert.match(row.value, /^E 值 2\.12（置信限 1\.63）：未测量的混杂要和处理、结局各有这么强的关联，才能解释掉这个结果；它只回答“要多强”，是偏倚分析里最简单的一层，不估计偏倚本身$/);
  assert.doesNotMatch(row.value, /没有偏倚|无偏倚/);
  assert.equal(row.decisive, true);
  assert.equal(row.source, "assumed");
  assert.deepEqual(tab.robustness.rows.map((entry) => entry.key), ["e_value", "e_value_confidence_limit"], "and the two numbers are in the robustness section, as they are for an E-value that lands beside an estimate");
  assert.equal(tab.verdict.conclusion, "estimable", "an E-value beside an estimate does not relabel the comparison as a sensitivity run");
  assert.match(tab.headline, /^真实外部对照：可估计/);
  // no E-value, no row
  assert.equal(page({ result: { measures: [{ name: "weighted_difference", value: 1 }] } }).premises.find((entry) => entry.key === "unmeasured"), undefined);
});

test("A6: the skill's own example reaches the page, in every shape it was written in", () => {
  // what the skill taught: the engine's list in the configuration
  const taught = page({ row: { targetTrial: {}, configuration: { targetTrial: [
    { item: "入选标准", emulation: "approximate" }, { item: "处理策略", emulation: "exact" }, { item: "同期治疗", emulation: "cannot" }] } } });
  const labels = Object.fromEntries(taught.estimand.rows.map((row) => [row.label, row.value]));
  assert.equal(labels["入选标准"], "只能近似");
  assert.equal(labels["处理策略"], "可精确复现");
  assert.equal(labels["同期治疗"], "无法复现", "an item that is no component is listed as it was written");
  assert.equal(taught.premises.find((row) => row.key === "targetTrial").value, "入选标准：只能近似", "what cannot be exact is a premise");

  // the closed record, on the row
  const closed = page({ row: { targetTrial: {
    eligibility: { status: "approximate", text: "外部对照的入排条件更宽" }, strategies: { status: "exact", text: "试验药物对标准治疗" },
    timeZero: { status: "not_possible", text: "外部对照没有随机日期" }, outcome: { status: "exact", text: "总生存期" } } } });
  const closedRows = Object.fromEntries(closed.estimand.rows.map((row) => [row.label, row.value]));
  assert.equal(closedRows["随访起点（时间零点）"], "无法复现：外部对照没有随机日期");
  assert.equal(closedRows["入选标准"], "只能近似：外部对照的入排条件更宽");
  const premise = closed.premises.find((row) => row.key === "targetTrial");
  assert.equal(premise.value, "入选标准：只能近似；随访起点（时间零点）：无法复现");
  assert.equal(premise.decisive, true, "the components that cannot be reproduced exactly are decisive");

  // the page's old two sentences and a note
  const legacy = page({ row: { targetTrial: { population: "二线 NSCLC", treatment: "多西他赛单药", note: "按公开方案" } } });
  assert.deepEqual(legacy.estimand.rows.slice(1), [{ label: "入选标准", value: "二线 NSCLC" }, { label: "处理策略", value: "多西他赛单药" }]);
  assert.equal(legacy.estimand.note, "按公开方案");
  assert.equal(legacy.premises.find((row) => row.key === "targetTrial"), undefined, "no status stated, no premise to show");

  // no record at all: the page shows the estimate and the estimand, and no row for what was not written
  const none = page({});
  assert.deepEqual(none.estimand.rows.map((row) => row.label), ["估计目标"]);
});

test("A7: the applicability record is a premise; the two triggers limit a result with their reason and never refuse it", () => {
  const record = { state: "partly_suitable", claim: "superiority", note: "对照来自另一年代的登记库，时期不同" };
  const tab = page({ row: { configuration: { applicability: record } } });
  const premise = tab.premises.find((row) => row.key === "applicability");
  assert.equal(premise.value, "部分适用，要支持优效结论：对照来自另一年代的登记库，时期不同");
  assert.equal(premise.decisive, true);
  assert.equal(tab.premises[0].key, "applicability", "it comes first");

  // what the job froze at its start is what the result says: limited, with the reasons beside the estimate
  const limited = page({ result: { conclusion: "limited", measures: [{ name: "weighted_difference", value: 2 }],
    diagnostics: { applicabilityLimits: [{ code: "non_inferiority_purpose", reason: "x" }, { code: "no_time_zero_rule", reason: "y" }] } } });
  assert.deepEqual(limited.limits.map((entry) => entry.key), ["non_inferiority_purpose", "no_time_zero_rule"]);
  assert.match(limited.limits[0].text, /非劣效/);
  assert.match(limited.limits[1].text, /时间零点/);
  assert.equal(limited.verdict.conclusion, "limited");

  // the job detail: an external control with a non-inferiority claim and no time-zero rule carries both; a complete record carries none
  const detail = comparatorLimitsDetail({ route: "external_control", configuration: { applicability: { state: "doubtful", claim: "non_inferiority" } }, targetTrial: {} });
  assert.deepEqual(detail.applicabilityLimits.map((entry) => entry.code), ["non_inferiority_purpose", "no_time_zero_rule"]);
  assert.deepEqual(comparatorLimitsDetail({ route: "external_control", configuration: { applicability: { state: "suitable", claim: "superiority" } }, targetTrial: { timeZero: { status: "approximate", text: "入组日" } } }), {});
  assert.deepEqual(vcrApplicabilityLimits({ route: "prognostic_adjustment", configuration: {} }), []);
});

test("A6, A7: a comparator that has not written its records is reminded in the answer of the write, and the reminder names what is missing", () => {
  const external = comparatorReminders({ route: "external_control", targetTrial: { eligibility: { status: "approximate" }, strategies: { status: "exact" } }, configuration: {} });
  assert.deepEqual(external.map((entry) => [entry.field, entry.code]), [["targetTrial", "vcr_comparator_record_incomplete"], ["configuration.applicability", "vcr_comparator_record_incomplete"]]);
  assert.match(external[0].message, /还缺：分配方式、随访起点（时间零点）、结局、对比、分析方法/);
  assert.match(external[0].message, /已保存、照常计算/);
  // a complete record is not reminded
  const full = Object.fromEntries(["eligibility", "strategies", "assignment", "timeZero", "outcome", "contrast", "analysis"].map((key) => [key, { status: "approximate", text: "x" }]));
  assert.deepEqual(comparatorReminders({ route: "external_control", targetTrial: full, configuration: { applicability: { state: "suitable" } } }), []);
  // a single published curve is a benchmark with no comparison to be suitable for; a MAIC is a comparison
  assert.deepEqual(comparatorReminders({ route: "literature_control", targetTrial: {}, configuration: { tau: 24 } }), []);
  assert.deepEqual(comparatorReminders({ route: "literature_control", targetTrial: {}, configuration: { method: "maic" } }).map((entry) => entry.field), ["configuration.applicability"]);
  assert.deepEqual(comparatorReminders({ route: "hybrid_control", targetTrial: {}, configuration: {} }).map((entry) => entry.field), ["configuration.applicability"]);
  assert.deepEqual(comparatorReminders({ route: "prognostic_adjustment", targetTrial: {}, configuration: {} }), []);
});

test("a borrowed prior's premises: what the history rests on and what the prior is worth", () => {
  const verified = vcrPremises("comparator", { route: "hybrid_control", diagnostics: {}, measures: { prior_effective_sample_size_elir: 14.3 } });
  assert.deepEqual(verified.map((row) => [row.key, row.value, row.source]), [["borrowedHistory", "来自核对过的证据", "literature"], ["priorWorth", "14.3 例", "literature"]]);
  const assumed = vcrPremises("comparator", { route: "hybrid_control", diagnostics: { inputsAssumed: true }, measures: {} });
  assert.deepEqual(assumed.map((row) => [row.key, row.value, row.source]), [["borrowedHistory", "没有经过核对的来源（输入为假设）", "assumed"]]);
});

test("an external control's premises: five open at most, the estimand and the covariates folded", () => {
  const rows = vcrPremises("comparator", {
    route: "external_control", estimand: "ATE", estimandStated: true, covariates: ["age", "ecog", "ldh", "sex", "smoking", "stage", "prior_lines"],
    applicability: { present: true, stateLabel: "适用", claimLabel: null, note: null },
    targetTrial: { components: [{ key: "timeZero", label: "随访起点（时间零点）", status: "approximate", statusLabel: "只能近似", text: null }] },
    measures: { e_value: 2.4, e_value_confidence_limit: 1.5 }, diagnostics: {},
  });
  assert.deepEqual(rows.filter((row) => row.decisive).map((row) => row.key), ["applicability", "targetTrial", "unmeasured"]);
  assert.deepEqual(rows.filter((row) => !row.decisive).map((row) => [row.key, row.value]), [["estimand", "对合并人群（ATE）"], ["covariates", "age、ecog、ldh、sex、smoking、stage 等 7 个"]]);
  assert.equal(rows.find((row) => row.key === "estimand").source, "assumed", "a changed estimand was somebody's choice");
  assert.equal(vcrPremises("comparator", { route: "external_control", estimand: "ATT", estimandStated: false }).find((row) => row.key === "estimand").source, "default");
  assert.deepEqual(vcrPremises("comparator", { route: "external_control" }), [], "a comparison with no record and no estimand has nothing to list");
});

test("A13: an effect card says its role in its summary, first; a card of no effect says nothing of one", () => {
  assert.equal(assumptionSummary({ effectRole: "important_difference", pooling: { k: 3 } }), "重要差异 · 3 项");
  assert.equal(assumptionSummary({ effectRole: "realistic_expectation", sourceKind: "scenario" }), "现实预期 · 情景假设");
  assert.equal(assumptionSummary({ effectRole: null, pooling: { k: 3 } }), "3 项");
  assert.equal(assumptionSummary({ effectRole: "bogus", pooling: { k: 3 } }), "3 项", "a word outside the closed ones is not drawn");
});

test("D6: the enrolment year is a row beside the balance when the engine computed it, and nothing when there is no date column", () => {
  const entry = {
    status: "computed", column: "STARTDT", unit: "calendar year", readable: { treated: 120, control: 300 },
    treated: { min: 2019, median: 2020, max: 2021, mean: 2020.054, weightedMean: 2020.054 }, control: { min: 2010, median: 2015, max: 2021, mean: 2015.56, weightedMean: 2019.9 },
    smdUnadjusted: 5.4427, smdAdjusted: 0.31, controlOutsideTrialYears: { share: 0.726, weightedShare: 0.2 }, byYear: [],
  };
  const dated = page({ result: { diagnostics: { balance: balance([["age", 0.7, 0.04]]), balanceVerdict: { band: "balanced", worst: 0.04, variable: "age" }, enrolmentYear: entry } } });
  assert.deepEqual(dated.comparability.map((row) => row.key), ["age", "enrolment_year"], "the year follows the covariates");
  const row = dated.comparability[1];
  assert.equal(row.label, "入组年份");
  assert.equal(row.smd, 0.31);
  assert.equal(row.smdBefore, 5.4427);
  assert.equal(row.flagged, true);
  assert.equal(row.note, "平均入组年份：本研究 2020.1，外部对照 2015.6。没有按它加权；外部对照有 73% 的人入组年份不在本研究的 2019–2021 年之内。");
  assert.deepEqual(dated.limits, [], "the year is beside the balance and not in its verdict: the estimate is not limited by it");

  // a trial that enrolled in one year says that year once
  const oneYear = page({ result: { diagnostics: { balance: balance([["age", 0.7, 0.04]]), enrolmentYear: { ...entry, treated: { ...entry.treated, min: 2020, max: 2020 } } } } });
  assert.match(oneYear.comparability[1].note, /没有按它加权；外部对照有 73% 的人入组年份不在本研究的 2020 年之内。$/);

  // no date column: no row, no sentence, and the covariates are as they were
  const none = page({ result: { diagnostics: { balance: balance([["age", 0.7, 0.04]]) } } });
  assert.deepEqual(none.comparability.map((item) => item.key), ["age"]);
  assert.doesNotMatch(none.comparabilityNote ?? "", /入组年份/);
  // a date column nobody could read: one sentence and no row
  const unreadable = page({ result: { diagnostics: { balance: balance([["age", 0.7, 0.04]]), enrolmentYear: { status: "unreadable", column: "STARTDT", readable: { treated: 0, control: 0 } } } } });
  assert.deepEqual(unreadable.comparability.map((item) => item.key), ["age"]);
  assert.match(unreadable.comparabilityNote, /入组年份没有算：日期列里读不出年份。/);
});

test("the headline is the saved comparison the link named when it is one of the study's, and the newest otherwise (2026-11-02: the reply said 3.0 and the page 2.22)", () => {
  const row = (/** @type {string} */ id, /** @type {number} */ version, /** @type {number} */ value) => {
    const comparator = { id, version, route: "external_control", estimand: "ATT", resultId: `res_${id}`, conclusion: "estimable", gapList: [], createdAt: AT, targetTrial: {}, configuration: {} };
    const result = { id: `res_${id}`, version: 1, kind: "comparator", conclusion: "estimable", counts: {}, createdAt: AT, executionId: `ex_${id}`, diagnostics: {},
      measures: [{ name: "e_value", value, source: "calculated" }] };
    return { comparator, result };
  };
  const first = row("cmp_old", 1, 3.0);
  const second = row("cmp_new", 2, 2.22);
  const bundle = (/** @type {Record<string, any>} */ more = {}) => bundleOf({ comparators: [second.comparator, first.comparator], comparator: second.comparator,
    results: [second.result, first.result], allResults: [second.result, first.result], executions: new Map([["ex_cmp_old", { id: "ex_cmp_old", jobId: "job_1", method: "comparator.evalue", methodVersion: "1.0.0" }],
      ["ex_cmp_new", { id: "ex_cmp_new", jobId: "job_2", method: "comparator.evalue", methodVersion: "1.0.0" }]]), ...more });
  assert.equal(presentComparatorTab(bundle()).selection.id, "cmp_new", "without a name the newest stays");
  const named = presentComparatorTab(bundle({ askedComparator: "cmp_old" }));
  assert.equal(named.selection.id, "cmp_old");
  assert.equal(named.selection.resultId, "res_cmp_old", "and its result is what the headline is made of");
  assert.deepEqual(named.versions.map((version) => version.objectId), ["cmp_new", "cmp_old"], "the list of versions is the study's, in the same order");
  assert.equal(presentComparatorTab(bundle({ askedComparator: "cmp_not_here" })).selection.id, "cmp_new", "a name the study does not hold is the newest");
});
