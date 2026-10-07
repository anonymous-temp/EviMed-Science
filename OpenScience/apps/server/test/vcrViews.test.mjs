// The presenter's rules, one at a time, on plain rows: how a stored measure
// becomes a page value, what a count is allowed to be, when a design is
// dominated, when it is chosen, and what a page says when the data is not
// there. The seeded-study contract test (`vcrViews.integration.test.mjs`) is
// the proof that the pages equal the fixtures; this file is why each rule is
// the rule.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { VCR_ENGINE_METHODS, VCR_JOB_KINDS, VCR_PROGNOSTIC_QUALIFICATION_LABEL_ZH, VCR_VALUE_SOURCES } from "@evimed/domain";

import {
  JOB_KIND_LABELS, attentionOf, budgetView, conclusionOf, designsSentence, failedExportsOf, jobView, notEstimableDesign, numberString, presentDesigns, presentModelCard, presentModels,
  presentExport, presentPrecedent, presentStudy, presentSummary, useCeilingOf, valueString, vcrCurrentNodes, vcrDependencies, vcrReviewIsCurrent,
} from "../src/vcrViews.mjs";
import { frozenVersion, modelInputs, reportModelFor, resultRows, study as modelStudy } from "./vcrModelDocumentFixtures.mjs";
import {
  presentComparatorTab, presentDataTab, presentIntake, presentMatchingTab, presentPatientsTab, presentPopulationTab, presentTrialTab, qualityReportView,
  seriesView, criterionCodes, vcrLocatorText,
} from "../src/vcrViewsTabs.mjs";
import {
  METHOD_LABELS, VCR_ROBUSTNESS_MEASURES, countsView, decimalsFor, defaultSourceOf, intervalView, measureLabel, measureValue, rangeString, reviewOfNode, staleNote,
  withReviewState, zhDate, zhTime,
} from "../src/vcrViewsKit.mjs";
import { FIXTURE_DIR } from "./vcrViewsFixtures.mjs";

const NOW = new Date("2026-09-28T09:00:00.000Z"); // 17:00 in China standard time

// --- the names the engine's methods are shown by --------------------------------------

test("every engine method and every job kind the domain declares is shown by a Chinese name, and a new one cannot be missed", () => {
  const cjk = /[\u4e00-\u9fff]/;
  assert.ok(Object.keys(VCR_ENGINE_METHODS).length >= 28 && VCR_JOB_KINDS.length >= 28, "the walk proves it walked");
  for (const method of Object.keys(VCR_ENGINE_METHODS)) assert.ok(cjk.test(METHOD_LABELS[method] ?? ""), `${method} has no Chinese method name`);
  for (const kind of VCR_JOB_KINDS) assert.ok(cjk.test(JOB_KIND_LABELS[kind] ?? ""), `${kind} has no Chinese job name`);
  assert.deepEqual(Object.keys(METHOD_LABELS).filter((method) => !(method in VCR_ENGINE_METHODS)), [], "a label for a method the domain does not declare");
  assert.deepEqual(Object.keys(JOB_KIND_LABELS).filter((kind) => !VCR_JOB_KINDS.includes(kind)), [], "a label for a job kind the domain does not declare");
});

test("the measures the comparator-effect methods write are named in words, the set estimates by their number", () => {
  const cjk = /[\u4e00-\u9fff]/;
  for (const name of ["hazard_ratio", "hazard_ratio_robust", "hazard_ratio_unadjusted", "hazard_ratio_ac_adjusted", "hazard_ratio_ac_unadjusted", "hazard_ratio_bc",
    "log_hazard_ratio_se_robust", "log_hazard_ratio_se_bootstrap", "ph_test_chisq", "ph_test_p", "aipw_difference", "aipw_difference_influence",
    "aipw_difference_se_influence", "aipw_difference_se_bootstrap", "aipw_risk_ratio", "aipw_odds_ratio", "outcome_mean_treated", "outcome_mean_control_adjusted",
    "covariate_set_range_low", "covariate_set_range_high", "covariate_set_range_width", "covariate_sets_total", "covariate_sets_estimable", "covariate_set_estimate_3"]) {
    assert.ok(cjk.test(measureLabel(name)) && measureLabel(name) !== name, `${name} is shown as itself`);
  }
  assert.equal(measureLabel("covariate_set_estimate_3"), "第 3 个协变量集的估计");
});

// --- robustness methods ---

test("every measure the three robustness methods write is named in words, whatever the engine's source says", () => {
  const cjk = /[\u4e00-\u9fff]/;
  const dir = new URL("../../../../项目代码/vcr-engine/R/", import.meta.url);
  /** @type {Set<string>} */
  const emitted = new Set();
  for (const file of ["negative_control.R", "tipping_point.R", "prognostic_adjustment.R"]) {
    const source = readFileSync(new URL(file, dir), "utf8");
    for (const match of source.matchAll(/vcr_measure\("([a-z_0-9]+)"/g)) emitted.add(match[1]);
    // the prognostic job states its measures as (name, value, interval, unit) rows
    if (file === "prognostic_adjustment.R") for (const match of source.matchAll(/^\s*list\("([a-z_0-9]+)",/gm)) emitted.add(match[1]);
  }
  assert.ok(emitted.size >= 30, `the walk proves it walked: ${emitted.size} measure names read from the engine`);
  for (const name of emitted) assert.ok(cjk.test(measureLabel(name)) && measureLabel(name) !== name, `${name} is shown as itself`);
  // the page lists what the table names, and each name is one the engine writes (a label for a measure nobody writes is a stale row)
  for (const name of VCR_ROBUSTNESS_MEASURES) assert.ok(emitted.has(name), `${name} is in the table and no robustness method writes it`);
  // proportions are said as percentages, as every other proportion on the pages is
  for (const name of ["share_changing_conclusion", "tipping_treatment_rate", "tipping_control_rate", "risk_treatment_standardised", "risk_control_standardised"]) {
    assert.equal(measureValue({ name, value: 0.25, source: "calculated" }, { kind: "comparator" }).value, 25, name);
  }
});

test("the comparator page lists the robustness numbers, says what could not be computed, and states beside a prognostic result that no regulator has qualified it", () => {
  const comparator = { id: "cmp_p", version: 1, route: "prognostic_adjustment", estimand: "ATE", conclusion: "estimable", gapList: [], resultId: "res_p",
    targetTrial: {}, configuration: {}, reviewState: "ai_set", createdAt: "2026-09-28T01:00:00.000Z" };
  const prognostic = { id: "res_p", version: 1, kind: "comparator", conclusion: "estimable", reviewState: "ai_set", counts: { realPatients: 240 }, executionId: null,
    measures: [
      { name: "marginal_risk_difference", value: 0.11, source: "calculated", interval: { kind: "confidence", low: 0.02, high: 0.2, level: 0.95 } },
      { name: "marginal_odds_ratio", value: 1.9, source: "calculated" },
      { name: "empirical_variance_ratio", value: 0.82, source: "calculated" },
      { name: "hazard_ratio", value: 0.7, source: "calculated" },
    ],
    diagnostics: { regulatoryStatus: { qualification: "none_beyond_continuous", qualifiedEndpoints: ["continuous"] } } };
  const tab = presentComparatorTab({ ...emptyBundle(), study: { ...study, dataTier: "T3" }, comparators: [comparator], results: [prognostic], allResults: [prognostic] });
  assert.deepEqual(tab.robustness.rows.map((/** @type {any} */ row) => row.key), ["marginal_risk_difference", "marginal_odds_ratio", "empirical_variance_ratio"],
    "only what the robustness methods write; another method's number is not listed here");
  assert.equal(tab.robustness.rows[0].label, "边际风险差");
  assert.equal(tab.robustness.rows[0].value.interval.low, 0.02);
  assert.equal(tab.robustness.qualification, VCR_PROGNOSTIC_QUALIFICATION_LABEL_ZH);
  assert.match(tab.robustness.qualification, /没有监管机构认可/);
  assert.deepEqual(tab.robustness.notes, []);
  // a word of the engine's that the domain does not know says nothing: the page states only what it can vouch for
  const unknown = { ...prognostic, diagnostics: { regulatoryStatus: { qualification: "something_else" } } };
  assert.equal(presentComparatorTab({ ...emptyBundle(), comparators: [comparator], results: [unknown], allResults: [unknown] }).robustness.qualification, null);
  // the statement is read from the stage that carries it when stages were filed as one result
  const staged = { ...prognostic, diagnostics: { stageResults: { primary: { conclusion: "estimable", diagnostics: prognostic.diagnostics } } } };
  assert.equal(presentComparatorTab({ ...emptyBundle(), comparators: [comparator], results: [staged], allResults: [staged] }).robustness.qualification, VCR_PROGNOSTIC_QUALIFICATION_LABEL_ZH);

  // an analysis that could not be computed is said, with the rule's own sentence, and the comparison keeps its numbers
  const external = { ...comparator, id: "cmp_e", route: "external_control", resultId: "res_e" };
  const limited = { id: "res_e", version: 1, kind: "comparator", conclusion: "limited", reviewState: "ai_set", counts: {}, executionId: null,
    measures: [{ name: "weighted_difference", value: 1.2, source: "calculated" }, { name: "worst_case_p_value", value: 0.31, source: "calculated" }],
    diagnostics: { stageResults: { primary: { conclusion: "estimable" },
      negative_control: { conclusion: "not_estimable", notEstimableRule: "negative_controls_not_estimable" }, tipping_point: { conclusion: "estimable" } } } };
  const stressed = presentComparatorTab({ ...emptyBundle(), comparators: [external], results: [limited], allResults: [limited] });
  assert.deepEqual(stressed.robustness.rows.map((/** @type {any} */ row) => row.key), ["worst_case_p_value"]);
  assert.equal(stressed.robustness.notes.length, 1);
  assert.match(stressed.robustness.notes[0], /^阴性对照结局没有算出：没有一个阴性对照结局能得出估计/);
  assert.equal(stressed.robustness.qualification, null);
  assert.match(String(stressed.headline), /有限制地估计/, "the comparison is still read as estimated, with a limit");
  // no robustness analysis, no section
  const plain = { ...limited, measures: [{ name: "weighted_difference", value: 1.2, source: "calculated" }], diagnostics: {} };
  assert.equal(presentComparatorTab({ ...emptyBundle(), comparators: [external], results: [plain], allResults: [plain] }).robustness, null);
  assert.equal(presentComparatorTab(emptyBundle()).robustness, null);
});

// --- end robustness methods ---

// --- how a moment is said ----------------------------------------------------------

test("a moment is said the way a reader says it, in China standard time", () => {
  assert.equal(zhTime("2026-09-28T06:32:00.000Z", NOW), "今天 14:32");
  assert.equal(zhTime("2026-09-27T09:40:00.000Z", NOW), "昨天 17:40");
  assert.equal(zhTime("2026-09-20T01:00:00.000Z", NOW), "9 月 20 日 09:00");
  assert.equal(zhTime("2025-12-03T01:00:00.000Z", NOW), "2025 年 12 月 3 日");
  // 17:00 UTC on the 27th is already the 28th in China.
  assert.equal(zhTime("2026-09-27T17:30:00.000Z", NOW), "今天 01:30");
  assert.equal(zhTime(null, NOW), null);
  assert.equal(zhTime("not a date", NOW), null);
  assert.equal(zhDate("2026-09-27T09:40:00.000Z", NOW), "昨天");
  assert.equal(zhDate("2026-09-20T01:00:00.000Z", NOW), "9 月 20 日");
});

// --- a measure as a page value ---------------------------------------------------------

test("a simulated proportion is shown as a percentage, with its error and interval moving with it", () => {
  const value = measureValue({ name: "power", value: 0.712, simulated: true, mcse: 0.0031, interval: { kind: "monte_carlo", low: 0.706, high: 0.718, level: 0.95 } },
    { kind: "trial_scenario" });
  assert.equal(value.value, 71.2);
  assert.equal(value.unit, "%");
  assert.equal(value.mcse, 0.31);
  assert.deepEqual(value.interval, { kind: "monte_carlo", low: 70.6, high: 71.8, level: 95 });
  assert.equal(value.precision, 1, "the value to the decimal place of its error's first digit");
  assert.equal(value.source, "predicted", "a simulated trial measure is a prediction, never an observation");
});

test("a value the engine names a source for keeps it; one it does not is labelled from the kind of result — never observed by default", () => {
  assert.equal(measureValue({ name: "pooled", value: 1, source: "reconstructed" }, { kind: "evidence_pool" }).source, "reconstructed");
  assert.equal(measureValue({ name: "pooled", value: 1 }, { kind: "evidence_pool" }).source, "aggregate");
  assert.equal(measureValue({ name: "x", value: 1, source: "made_up" }, { kind: "trial_scenario" }).source, "calculated");
  for (const kind of ["trial_scenario", "design_grid", "accrual_forecast", "evidence_pool", "population", "patient_set", "comparator", "matching", "snapshot_profile", "anything"]) {
    const source = defaultSourceOf(kind, { name: "m", simulated: true }, {});
    assert.ok(VCR_VALUE_SOURCES.includes(source), kind);
    assert.notEqual(source, "observed", `${kind}: an unlabelled simulated number is never an observation`);
  }
});

test("a measure with no number is a word and a reason — never a zero, and a failure is not a finding", () => {
  const missing = measureValue({ name: "power", value: null }, { kind: "trial_scenario", result: { conclusion: "estimable" } });
  assert.equal(missing.value, null);
  assert.equal(missing.text, "—");
  assert.ok(missing.reason);
  const notEstimable = measureValue({ name: "weighted_difference", value: null },
    { kind: "comparator", result: { conclusion: "not_estimable", notEstimableRule: "effective_sample_size_below_floor", reviewState: "ai_set" } });
  assert.equal(notEstimable.text, "不可估计");
  assert.match(String(notEstimable.reason), /有效样本量/);
  assert.equal(measureValue({ name: "power", value: 0 }, { kind: "trial_scenario" }).value, 0, "a real zero stays a zero");
});

test("a value carries the run it came from, so a click can open its seed and error", () => {
  const value = measureValue({ name: "power", value: 0.8, simulated: true, mcse: 0.003 }, {
    kind: "trial_scenario", result: { id: "res_1", reviewState: "ai_set" }, tab: "trial",
    execution: { method: "design.simulate", methodVersion: "1.0.0", seed: 5, replicates: 16000, cpuSeconds: 12.4, scenarioHash: "a".repeat(64) },
  });
  assert.equal(value.detail?.kind, "run");
  assert.deepEqual(value.detail?.fields?.map((field) => field.label), ["方法", "种子", "重复次数", "蒙特卡洛标准误", "计算用时"]);
  assert.equal(value.detail?.fields?.[0]?.value, "方案的模拟运行", "the method in words, never its id or version");
  assert.doesNotMatch(JSON.stringify(value.detail?.fields), /design\.simulate|1\.0\.0|aaaaaaaa/, "no method id, version or hash");
  assert.deepEqual(value.detail?.ref, { kind: "result", id: "res_1", tab: "trial" });
  assert.equal(value.review, "ai_set");
});

test("a stale mark travels with the value and the number stays", () => {
  const value = measureValue({ name: "assurance", value: 0.71, simulated: true, mcse: 0.004 }, { kind: "trial_scenario", staleMark: { node: "result:x@1" } });
  assert.equal(value.stale, true);
  assert.equal(value.value, 71);
});

// --- precision ---------------------------------------------------------------------------------

test("a number is printed to the precision it deserves, on the server as in the browser", () => {
  assert.equal(numberString(1.04, null), "1.04");
  assert.equal(numberString(1.96, null), "1.96");
  assert.equal(numberString(0.0031, null), "0.0031");
  assert.equal(numberString(5.9, null), "5.9");
  assert.equal(numberString(72, 1), "72.0");
  assert.equal(numberString(71.2345, null, 0.31), "71.2");
  assert.equal(decimalsFor(0.0031, 2), 4);
  assert.equal(decimalsFor(0.0031, 1), 3);
  assert.equal(rangeString(3, 5.6), "3.0–5.6");
  assert.equal(valueString({ value: 71.2, precision: 1, unit: "%" }), "71.2%");
  assert.equal(valueString({ value: null, text: "不可估计" }), "不可估计");
});

// --- counts ------------------------------------------------------------------------------------------

test("the four counts stay four: missing is null, a real zero is a zero, and a design-stage note is said once", () => {
  const counts = countsView({ realPatients: 0, events: null, generatedRecords: 6_480_000 }, { tier: "T0", scope: "方案 B" });
  assert.equal(counts.realPatients, 0);
  assert.equal(counts.events, null);
  assert.equal(counts.effectiveSampleSize, null);
  assert.equal(counts.note, "设计阶段：尚无真实患者");
  assert.equal(counts.scope, "方案 B");
  assert.equal("reconstructedPseudoPatients" in countsView({}), false, "the optional two appear only when their route was used");
  assert.equal(countsView({ reconstructedPseudoPatients: 801 }).reconstructedPseudoPatients, 801);
  assert.equal(countsView({ realPatients: 3412 }, { tier: "T1" }).notes?.events, "T1 无结局记录");
});

// --- intervals and stale ---------------------------------------------------------------------------------

test("an interval without a name is not an interval", () => {
  assert.equal(intervalView({ low: 1, high: 2 }), null);
  assert.equal(intervalView({ kind: "made_up", low: 1, high: 2 }), null);
  assert.equal(intervalView({ kind: "prediction", low: null, high: null }), null);
  assert.deepEqual(intervalView({ kind: "prediction", low: 3, high: 5.6, level: 0.8 }), { kind: "prediction", low: 3, high: 5.6, level: 80 });
});

test("the stale note says a recomputation is queued only when one is", () => {
  assert.equal(staleNote([]), null);
  assert.equal(staleNote([null]), null);
  assert.equal(staleNote([{ reason: "assumption_changed", queuedJobId: null, markedAt: "x" }])?.queued, false);
  assert.equal(staleNote([{ reason: "assumption_changed", queuedJobId: "job_1", markedAt: "x" }])?.queued, true);
  assert.equal(staleNote([{ reason: "assumption_changed" }])?.reason, "假设卡已变更");
});

// --- designs: dominated is a rule, chosen is a record -----------------------------------------------------------

const scenario = (id, version, label, extra = {}) => ({ id, version, label, design: "two_arm_fixed", endpointType: "time_to_event", configuration: { design: { nTreat: 100, nControl: 100 } }, assumptionIds: [], resultId: `res_${id}`, ...extra });
const result = (id, measures) => ({ id: `res_${id}`, version: 1, kind: "trial_scenario", conclusion: "estimable", reviewState: "ai_set", measures, counts: {}, diagnostics: {}, executionId: null });
const measure = (name, value) => ({ name, value, simulated: true, mcse: 0.004 });

function designsBundle({ decisions = [], grid = { comparisonGoal: { measures: [{ name: "assurance", direction: "higher" }, { name: "expected_sample_size", direction: "lower" }] } } } = {}) {
  return {
    scenarios: [scenario("a", 1, "A"), scenario("b", 2, "B"), scenario("c", 3, "C")],
    results: [
      result("a", [measure("assurance", 0.58), measure("expected_sample_size", 60)]),
      result("b", [measure("assurance", 0.71), measure("expected_sample_size", 180)]),
      result("c", [measure("assurance", 0.70), measure("expected_sample_size", 200)]),
    ],
    stale: [], executions: new Map(), grid, decisions, forecastResults: [],
  };
}

test("a design is dominated only when the team's own goal makes it decidable, and it then carries no numbers", () => {
  const { designs } = presentDesigns(designsBundle());
  const c = designs.find((design) => design.code === "C");
  assert.equal(c.dominated, true, "B beats C on both measures of the goal");
  assert.equal(c.dominatedBy, "B");
  assert.deepEqual(c.measures, {}, "a dominated design's numbers are not shown");
  assert.match(String(c.note), /B/);
  assert.equal(designs.find((design) => design.code === "A").dominated, false, "A is cheaper: not beaten on every measure");
  // No goal, no verdict: nothing is dominated until the team wrote what it wants.
  assert.ok(presentDesigns(designsBundle({ grid: null })).designs.every((design) => design.dominated === false));
});

test("a design keeps its own result even when another design's later run superseded it as the current one of its kind", () => {
  const bundle = designsBundle();
  // The current list holds only the newest; the design rows still point at their own.
  const current = [bundle.results[2]];
  const { designs } = presentDesigns({ ...bundle, results: current, allResults: bundle.results });
  assert.equal(designs.find((design) => design.code === "A").measures.assurance.value, 58, "A's numbers are still A's");
  assert.equal(designs.find((design) => design.code === "B").measures.assurance.value, 71);
  const onlyCurrent = presentDesigns({ ...bundle, results: current, allResults: undefined }).designs;
  assert.equal(onlyCurrent.find((design) => design.code === "A").measures.assurance, undefined, "without the all-results list the earlier design would read as never simulated");
});

test("the brand blue exists only where a decision was recorded: `chosen` comes from a decision row and from nothing else", () => {
  assert.ok(presentDesigns(designsBundle()).designs.every((design) => design.chosen === false), "nothing chosen by default, however good B looks");
  const decided = presentDesigns(designsBundle({ decisions: [{ id: "dec_1", question: "q", chosen: { id: "b", code: "B" }, createdAt: "2026-09-28T00:00:00.000Z" }] }));
  assert.deepEqual(decided.designs.filter((design) => design.chosen).map((design) => design.code), ["B"]);
});

test("a design's measures are percentages, its sample size is a setting, and its label letter follows creation order", () => {
  const { designs } = presentDesigns(designsBundle());
  const b = designs.find((design) => design.code === "B");
  assert.equal(b.measures.assurance.value, 71);
  assert.equal(b.measures.assurance.mcse, 0.4);
  assert.equal(b.measures.sample_size.value, 200);
  assert.equal(b.measures.sample_size.source, "assumed", "a design's size is what somebody set, not something measured");
  assert.deepEqual(designs.map((design) => design.code), ["A", "B", "C"]);
});

/** Three designs of one study as the conversation leaves them, and the results each design's jobs filed under it. */
function conversationTrialBundle({ staged = false } = {}) {
  const at = (/** @type {number} */ minute) => `2026-10-07T11:${String(10 + minute).padStart(2, "0")}:00.000Z`;
  const design = (/** @type {string} */ id, /** @type {number} */ version, /** @type {string} */ label, /** @type {string} */ kind, /** @type {Record<string, any>} */ plan) =>
    ({ id, version, label, design: kind, endpointType: "time_to_event", configuration: { design: plan }, assumptionIds: [], resultId: `res_${id}_sim` });
  const analytic = (/** @type {string} */ id, /** @type {number} */ events, /** @type {number} */ total, /** @type {number} */ minute, /** @type {any[]} */ extra = []) => ({
    id: `res_${id}_ana`, version: 1, kind: "trial_scenario", subjectId: id, conclusion: "estimable", reviewState: "ai_set", counts: {}, diagnostics: {}, executionId: `ex_${id}_ana`,
    measures: [{ name: "required_events", value: events, source: "calculated" }, { name: "required_total", value: total, source: "calculated" }, ...extra], createdAt: at(minute) });
  const simulated = (/** @type {string} */ id, /** @type {number} */ power, /** @type {number} */ minute, /** @type {Record<string, any>} */ check = {}) => ({
    id: `res_${id}_sim`, version: 2, kind: "trial_scenario", subjectId: id, conclusion: "estimable", reviewState: "ai_set", counts: {}, executionId: `ex_${id}_sim`,
    diagnostics: { analyticCheck: { name: "power", value: power - 0.003, simulated: power, difference: 0.003, mcse: 0.004, withinTolerance: true, ...check } },
    measures: [{ name: "power", value: power, simulated: true, mcse: 0.004, source: "synthetic" }], createdAt: at(minute + 5) });
  const scenarios = [design("scn_a", 1, "A 2:1 固定设计", "two_arm_fixed", { nTreat: 120, nControl: 60 }), design("scn_b", 2, "B 1:1 固定设计", "two_arm_fixed", { nTreat: 90, nControl: 90 }),
    design("scn_c", 3, "C 1:1 成组序贯", "group_sequential", { nTreat: 90, nControl: 90 })];
  const boundaries = [{ name: "boundary_1", value: 2.963, source: "calculated" }, { name: "boundary_2", value: 1.969, source: "calculated" }];
  const rows = [analytic("scn_a", 950, 13764, 1), simulated("scn_a", 0.898, 1), analytic("scn_b", 845, 11799, 2), simulated("scn_b", 0.915, 2),
    analytic("scn_c", 847, 11840, 3, boundaries), simulated("scn_c", 0.905, 3)];
  // What the old conversation path left: one result per job, newest first, every one of them a design's own once it has a subject.
  const allResults = staged
    ? scenarios.map((scenarioRow, index) => ({ ...rows[index * 2 + 1], measures: [...rows[index * 2].measures, ...rows[index * 2 + 1].measures],
      diagnostics: { ...rows[index * 2 + 1].diagnostics, stageResults: {
        analytic: { stage: "analytic", jobId: `job_${scenarioRow.id}_a`, measures: rows[index * 2].measures, diagnostics: {} },
        simulation: { stage: "simulation", jobId: `job_${scenarioRow.id}_s`, measures: rows[index * 2 + 1].measures, diagnostics: rows[index * 2 + 1].diagnostics } } } }))
    : [...rows].reverse();
  const executions = new Map(rows.map((row) => [row.executionId, { id: row.executionId, jobId: `job_${row.executionId.slice(3)}`, method: row.id.endsWith("_ana") ? "design.analytic" : "design.simulate",
    seed: 7, replicates: row.id.endsWith("_ana") ? null : 5000, cpuSeconds: 30, scenarioHash: "f".repeat(64) }]));
  if (staged) for (const row of allResults) executions.set(row.executionId, { ...executions.get(row.executionId), jobId: `job_${row.subjectId}_s` });
  return { ...emptyBundle(), scenarios, results: allResults.filter((row) => !row.supersededBy).slice(0, 3), allResults, executions };
}

test("a design's numbers are its analytic size and its simulated power, merged from the results filed under it — the three designs of a conversation are three rows with numbers", () => {
  for (const staged of [false, true]) {
    const tab = presentTrialTab(conversationTrialBundle({ staged }));
    const [a, b, c] = tab.designs;
    assert.deepEqual(tab.designs.map((design) => design.code), ["A", "B", "C"], `staged ${staged}`);
    assert.equal(a.measures.required_events.value, 950, "the closed form's events");
    assert.equal(a.measures.sample_size.value, 13764, "the closed form's patients replace the declared size");
    assert.equal(a.measures.sample_size.source, "calculated");
    assert.equal(b.measures.power.value, 91.5, "the simulated power is a percentage");
    assert.equal(b.measures.power.mcse, 0.4, "with its Monte-Carlo error");
    assert.equal(b.measures.power.source, "synthetic");
    assert.deepEqual(tab.designs.map((design) => design.method), ["解析 + 模拟", "解析 + 模拟", "解析 + 模拟"]);
    assert.equal(a.replicates, 5000);
    assert.equal(b.crossCheck.agrees, true);
    assert.equal(b.crossCheck.differencePoints, 0.3);
    assert.match(b.crossCheck.text, /解析功效 91.2%，与模拟相差 0.3 个百分点，在容许范围内/);
    assert.equal(c.note, "期中界值 z = 2.96", "a group-sequential design says where it stops at the first look");
    assert.equal(a.note, null);
    assert.deepEqual(tab.columns.map((column) => column.key).slice(0, 2), ["required_events", "sample_size"]);
    assert.equal(tab.headline, "方案 A 需要 950 例事件、13,764 名患者；方案 B 需要 845 例事件、11,799 名患者；方案 C 需要 847 例事件、11,840 名患者；已模拟 3 个方案，功效 90%～92%。");
    // nothing of the run's own record on the page: no method id, no hash, no result id
    assert.doesNotMatch(JSON.stringify(tab.runRecord), /design\.|f{12}|res_/);
    assert.match(tab.runRecord[0].title, /方案 A：方案的模拟运行，5,000 次重复/);
  }
});

test("a design that has been simulated and not computed in closed form says so, and one that has neither says nothing", () => {
  const bundle = conversationTrialBundle();
  const onlySimulated = { ...bundle, allResults: bundle.allResults.filter((row) => !row.id.endsWith("_ana") || row.subjectId !== "scn_a") };
  const [a, b] = presentTrialTab(onlySimulated).designs;
  assert.equal(a.method, "模拟");
  assert.equal(a.measures.required_events, undefined);
  assert.equal(b.method, "解析 + 模拟");
  const none = presentTrialTab({ ...bundle, allResults: [], results: [] });
  assert.ok(none.designs.every((design) => design.method === null && design.replicates === null && design.crossCheck === null));
  assert.equal(none.headline, null);
});

test("a registered prediction is shown as the numbers it predicted, never as the ids that make it provable", () => {
  const now = NOW;
  const trial = presentTrialTab({ ...conversationTrialBundle(), now, forecasts: [
    { id: "fct_1", kind: "trial", version: 1, payloadHash: "9f".repeat(32), createdAt: "2026-10-07T11:20:00.000Z", comparedAt: null,
      prediction: { scenarioId: "scn_b", resultId: "res_scn_b_sim", replicates: 5000, measures: { power: { value: 0.915, mcse: 0.004 }, type_one_error: { value: 0.024, mcse: 0.002 } } }, actual: null },
    { id: "fct_2", kind: "accrual", version: 1, payloadHash: "ab".repeat(32), createdAt: "2026-10-07T11:21:00.000Z", comparedAt: null,
      prediction: { resultId: "res_x", measure: "last_patient_in_months", median: 14.2, measures: [{ name: "last_patient_in_months", value: 14.2, unit: "months" }] }, actual: null },
  ] });
  const [design, accrual] = trial.forecasts;
  assert.equal(design.label, "方案预测");
  assert.deepEqual(design.lines.map((line) => [line.label, line.predicted]), [["功效", "91.5% ±0.4%"], ["I 类错误", "2.4% ±0.2%"]]);
  assert.equal(accrual.label, "入组预测");
  assert.equal(accrual.lines[0].predicted, "14.2 个月");
  assert.equal(design.version, 1);
  assert.ok(design.frozenAt);
  const shown = JSON.stringify(trial.forecasts);
  assert.doesNotMatch(shown, /res_|scn_|9f9f|hash|resultId|scenarioId/, "no result id, no scenario id, no hash");
});

/** The profile blocks the engine writes beside a generated table (R10 / package ENG): a scenario population, and an empirical one with small cells withheld. */
const scenarioProfile = [
  { variable: "age", label: "年龄", kind: "continuous", declared: { family: "normal", params: { mean: 63, sd: 9 }, constraints: [{ kind: "bounds", min: 18, max: 95 }, { kind: "rule", name: "adult", rule: {} }] },
    n: 1000, missing: 0, mean: 63.01, sd: 8.935, median: 63.05, q1: 56.97, q3: 68.57, min: 35.92, max: 91.06,
    histogram: { breaks: [35.92, 43.79, 51.67, 59.55, 67.43, 75.31, 83.18, 91.06], counts: [11, 96, 233, 358, 220, 68, 14] } },
  { variable: "female", label: "女性", kind: "binary", declared: { family: "bernoulli", params: { prob: 0.45 }, constraints: [] }, n: 1000, missing: 0,
    levels: [{ level: "0", n: 559, p: 0.559 }, { level: "1", n: 441, p: 0.441 }] },
  { variable: "stage", label: null, kind: "categorical", declared: { family: "categorical", params: { probs: [0.5, 0.3, 0.2] }, constraints: [] }, n: 1000, missing: 0,
    levels: [{ level: "1", n: 494, p: 0.494 }, { level: "2", n: 324, p: 0.324 }, { level: "3", n: 182, p: 0.182 }] },
  { variable: "bmi", label: null, kind: "continuous", declared: { family: "lognormal", params: { meanlog: 3.3, sdlog: 0.15 }, constraints: [] }, n: 1000, missing: 94,
    mean: 27.23, sd: 4.158, median: 26.84, q1: 24.26, q3: 29.88, min: 17.45, max: 40.88, histogram: { breaks: [17.45, 20.8, 24.15, 27.49, 30.84, 34.19, 37.53, 40.88], counts: [40, 180, 280, 225, 120, 45, 16] } },
];
const empiricalProfile = [
  { variable: "age", label: null, kind: "continuous", declared: null, n: 320, missing: 0, mean: 59.75, sd: 9.599, median: 60.36, q1: 53.24, q3: 66.4, min: 30.24, max: 87.71,
    histogram: { breaks: [30.24, 38.45, 46.66, 54.87, 63.08, 71.29, 79.5, 87.71], counts: [null, 28, 60, 108, 88, 25, null] }, suppressed: ["histogram"] },
  { variable: "grp", label: null, kind: "categorical", declared: null, n: 320, missing: 0, suppressed: ["levels"],
    levels: [{ level: "a", n: 148, p: 0.4625 }, { level: "b", n: 109, p: 0.3406 }, { level: "c", n: 49, p: 0.1531 }, { level: "d", n: null, p: null, suppressed: true }, { level: "other", n: null, p: null, suppressed: true }] },
];
const populationBundle = (/** @type {Record<string, any>} */ population, /** @type {Record<string, any> | null} */ resultRow) => ({ ...emptyBundle(),
  populations: [{ id: "pop_1", version: 1, kind: "scenario", name: "情景人群", counts: {}, waterfall: [], profile: {}, quality: {}, allowedUses: ["design", "feasibility"], resultId: "res_pop", reviewState: "ai_set", ...population }],
  results: resultRow ? [resultRow] : [], allResults: resultRow ? [resultRow] : [] });
const populationResult = (/** @type {Record<string, any>} */ diagnostics) => ({ id: "res_pop", version: 1, kind: "population", conclusion: "estimable", reviewState: "ai_set", executionId: null,
  counts: { realPatients: 0, generatedRecords: 1000 }, measures: [], diagnostics });

test("a generated population's tab says what the study set and what came out, variable by variable, from the profile the engine wrote", () => {
  const tab = presentPopulationTab(populationBundle({}, populationResult({ profile: scenarioProfile, constraintViolations: [{ name: "adult", violations: 0 }, { name: "bounded", violations: 3 }] })));
  assert.equal(tab.profileKind, "generated");
  assert.equal(tab.profileNote, null);
  assert.equal(tab.profileMissing, false);
  assert.equal(tab.method, "按设定的分布和相关性抽样");
  assert.deepEqual(tab.allowedUses, [{ key: "design", label: "设计" }, { key: "feasibility", label: "可行性" }]);
  assert.deepEqual(tab.constraints, [{ label: "adult", violations: 0 }, { label: "bounded", violations: 3 }]);
  const [age, female, stage, bmi] = tab.profile;
  assert.equal(age.label, "年龄");
  assert.equal(age.declaredText, "正态分布，均数 63、标准差 9；限定在 18–95；满足「adult」");
  assert.equal(age.generatedText, "均数 63.01，标准差 8.935，中位 63.05（四分位 56.97–68.57），范围 35.92–91.06");
  assert.deepEqual(age.histogram.counts, [11, 96, 233, 358, 220, 68, 14], "the engine's seven bins, passed through");
  assert.equal(age.histogram.breaks.length, 8);
  assert.equal(female.declaredText, "二分类，取 1 的概率 45%");
  assert.equal(female.generatedText, "女性 44.1%");
  assert.deepEqual(female.levels.map((level) => [level.label, level.percent]), [["否", 55.9], ["是", 44.1]]);
  assert.equal(stage.label, "stage", "a variable with no label is called by its name");
  assert.equal(stage.declaredText, "多分类，各水平的概率 0.5、0.3、0.2");
  assert.equal(stage.generatedText, "1 49.4%，2 32.4%，3 18.2%");
  assert.equal(bmi.declaredText, "对数正态分布，对数均值 3.3、对数标准差 0.15");
  assert.equal(bmi.missingText, "缺失 94 条（9.4%）");
  assert.equal(tab.counts.generatedRecords, 1000);
});

test("a generated population's small cells stay withheld on the page, and one without a profile offers to be generated again — it computes nothing in the control plane", () => {
  const empirical = presentPopulationTab(populationBundle({ kind: "empirical_synthetic", allowedUses: ["design"] }, populationResult({ profile: empiricalProfile })));
  assert.equal(empirical.method, "按真实数据经验合成");
  const [age, group] = empirical.profile;
  assert.equal(age.declaredText, null, "an empirical table declares nothing");
  assert.deepEqual(age.histogram.counts, [null, 28, 60, 108, 88, 25, null], "a hidden bin is still hidden");
  assert.deepEqual(group.levels.filter((level) => level.suppressed).map((level) => [level.level, level.n, level.percent]), [["d", null, null], ["other", null, null]]);
  assert.match(group.generatedText, /a 46.3%，b 34.1%，c 15.3%，其余小样本已隐藏/);
  // a result from before the engine wrote a profile (the owner's population): one sentence, no rows, nothing worked out here
  const before = presentPopulationTab(populationBundle({}, populationResult({ valueSource: "synthetic" })));
  assert.deepEqual(before.profile, []);
  assert.equal(before.profileMissing, true);
  assert.match(String(before.profileNote), /点“重新生成”/);
  assert.equal(before.profileKind, null);
  // a population that has not been computed has nothing to apologise for
  const waiting = presentPopulationTab(populationBundle({ resultId: null }, null));
  assert.equal(waiting.profileMissing, false);
  assert.equal(waiting.profileNote, null);
  // a profile with an entry the page cannot read is no profile
  const broken = presentPopulationTab(populationBundle({}, populationResult({ profile: [scenarioProfile[0], { variable: "x", kind: "made_up" }] })));
  assert.equal(broken.profileMissing, true);
});

test("a cohort the engine built is read from its result: the waterfall, the three outcomes and the rules that limit it on their own", () => {
  const steps = [{ rule: "I1", kept: 900, excluded: 100, indeterminate: 0 }, { rule: "I2", kept: 600, excluded: 100, indeterminate: 200 }, { rule: "E1", kept: 580, excluded: 20, indeterminate: 0 }];
  const impact = [{ rule: "I1", failsAlone: 100, indeterminateAlone: 0 }, { rule: "I2", failsAlone: 150, indeterminateAlone: 260 }, { rule: "E1", failsAlone: 30, indeterminateAlone: 5 }];
  const row = { ...populationResult({ waterfall: steps, criterionImpact: impact, startingRows: 1000 }),
    measures: [{ name: "cohort_size", value: 580 }, { name: "cohort_size_strict", value: 580 }, { name: "cohort_size_lenient", value: 790 }] };
  const bundle = { ...populationBundle({ kind: "real", allowedUses: [] }, row), criteria: [
    { id: "c1", ordinal: 1, kind: "inclusion", criterionType: "diagnosis", sourceText: "确诊 NSCLC", sourceLocator: {}, reviewState: "ai_set" },
    { id: "c2", ordinal: 2, kind: "inclusion", criterionType: "biomarker", sourceText: "EGFR 阳性", sourceLocator: {}, reviewState: "ai_set" },
    { id: "c3", ordinal: 3, kind: "exclusion", criterionType: "comorbidity", sourceText: "无活动性脑转移", sourceLocator: {}, reviewState: "ai_set" }] };
  const tab = presentPopulationTab(bundle);
  assert.deepEqual(tab.attrition.map((step) => [step.code, step.remaining, step.unknown, step.removed]), [["I1", 900, 0, 100], ["I2", 600, 200, 100], ["E1", 580, 0, 20]]);
  assert.deepEqual(tab.outcome, { eligible: 580, insufficient: 210, ineligible: 210 });
  assert.deepEqual(tab.criteria.map((criterion) => [criterion.code, criterion.kept, criterion.excluded, criterion.unknown]), [["I1", 900, 100, 0], ["I2", 600, 100, 200], ["E1", 580, 20, 0]]);
  assert.deepEqual(tab.blockers.map((blocker) => [blocker.code, blocker.text, blocker.quote]), [["I2", "无法判断 260", "EGFR 阳性"], ["I1", "排除 100", "确诊 NSCLC"], ["E1", "排除 30", "无活动性脑转移"]],
    "ranked by what each rule does alone — I2 would drop 410 on its own — not by what is left for it after the rules before it");
  assert.equal(tab.method, null, "a real cohort is not generated");
  // criteria the check could not put to the data are not in the count, and the table says so beside them
  const covered = presentPopulationTab({ ...bundle, populations: [{ ...bundle.populations[0], name: "按方案条件查覆盖",
    profile: { coverage: { notEvaluated: [{ code: "E1", why: "要看有没有这类事件或诊断的记录，受试者级的列判断不了" }] } } }] });
  assert.equal(covered.name, "按方案条件查覆盖");
  assert.deepEqual(covered.criteria.map((criterion) => [criterion.code, criterion.notEvaluated]), [["I1", null], ["I2", null], ["E1", "要看有没有这类事件或诊断的记录，受试者级的列判断不了"]]);
  assert.deepEqual(covered.profile, [], "a coverage cohort has no profile of its own rows");
  assert.deepEqual(tab.allowedUses, []);
});

test("a comparator somebody wrote for the unsupported route is still shown as what it found; the library lists what this version does not do, as 暂不支持", () => {
  const bundle = { ...emptyBundle(), comparators: [{ id: "cmp_m", version: 1, route: "model_comparator", conclusion: "not_estimable", gapList: [], resultId: null, reviewState: "ai_set" }] };
  const routes = presentComparatorTab(bundle).routes.map((route) => [route.route, route.state]);
  assert.ok(routes.some(([route, state]) => route === "model_comparator" && state === "not_estimable"));
  const library = presentModels({ models: [], methods: [], usedBy: new Map(), engineAvailable: true, engineMismatch: null });
  assert.deepEqual(library.unsupported.map((entry) => entry.label), ["模型预测比较器", "数字孪生与基线条件化预测模型", "机制模型（QSP、PBPK）", "非劣效设计", "适应性设计", "平台试验设计"]);
  assert.ok(library.unsupported.every((entry) => entry.note === "暂不支持"));
});

test("the matching tab offers one direction, from the protocol to the patients, and a request for the other reads the same view", () => {
  for (const direction of [undefined, "trial_to_patient", "patient_to_trial"]) {
    const tab = presentMatchingTab(emptyBundle(), { direction });
    assert.equal(tab.direction ?? "trial_to_patient", "trial_to_patient");
  }
});

test("the sentence about the designs names a range and never a winner", () => {
  const { designs } = presentDesigns(designsBundle());
  const sentence = designsSentence(designs);
  assert.match(String(sentence), /已模拟 2 个方案，成功把握 58%～71%/);
  assert.doesNotMatch(String(sentence), /最佳|推荐|最优|best/);
  assert.equal(designsSentence([]), null);
});

test("the study's latest conclusion is a rendered sentence, or null when nothing has run", () => {
  assert.equal(conclusionOf({ designs: [], results: [], comparators: [] }), null);
  const { designs } = presentDesigns(designsBundle());
  const said = conclusionOf({ designs, results: designsBundle().results, comparators: [] });
  assert.match(said.text, /已模拟/);
  assert.equal(said.state, "estimable");
});

test("what needs attention is deterministic over the rows: AI-set cards, a route that cannot be estimated, stale results, the budget, a failed step", () => {
  const lines = attentionOf({
    assumptions: [{ id: "a1", key: "hr", name: "目标 HR", reviewState: "ai_set" }, { id: "a2", key: "orr", name: "ORR", reviewState: "reviewed" }],
    scenarios: [{ assumptionIds: ["hr"] }],
    comparators: [{ route: "external_control", conclusion: "not_estimable", gapList: [{ title: "同期治疗记录" }, { title: "ECOG 缺失 38%" }], resultId: null }],
    results: [], stale: [{ node: "x", reason: "criterion_changed" }],
    jobs: [{ state: "awaiting_budget" }, { state: "running" }],
    steps: { trial: { status: "failed" } },
  });
  assert.deepEqual(lines.map((line) => line.kind), ["ai_set", "not_estimable", "stale", "budget_confirm", "step_failed"]);
  assert.equal(lines[0].text, "1 条关键假设由 AI 设定");
  assert.deepEqual(lines[1].items, ["同期治疗记录", "ECOG 缺失 38%"]);
  assert.equal(lines[1].text, "真实外部对照不可估计，缺 2 项数据");
  assert.match(lines[2].text, /入排条件已变更/);
  assert.deepEqual(attentionOf({ assumptions: [], scenarios: [], comparators: [], results: [], stale: [], jobs: [], steps: {} }), [], "a study with nothing wrong says nothing");
  // A step the allowance would not start is a line of its own, marked 模拟 where the wallet is, and only while it is queued.
  const quiet = { assumptions: [], scenarios: [], comparators: [], results: [], stale: [], jobs: [] };
  const one = attentionOf({ ...quiet, steps: { evidence: { status: "queued", waiting: "simulated_allowance" } } });
  assert.deepEqual(one.map((line) => [line.kind, line.text]), [["allowance_waiting", "「证据」这一步在等模拟额度，模拟充值后会自动开始。"]]);
  const many = attentionOf({ ...quiet, steps: { trial: { status: "queued", waiting: "allowance" }, comparator: { status: "queued", waiting: "allowance" } } });
  assert.equal(many[0].text, "2 个步骤在等科研额度，充值后会自动开始。");
  assert.equal(many[0].items.length, 2);
  assert.deepEqual(attentionOf({ ...quiet, steps: { evidence: { status: "running", waiting: "allowance" } } }), [], "a step that has started waits on nothing");
  assert.equal(notEstimableDesign([{ route: "literature_control", conclusion: "limited" }], []), null);
});

test("an export that ended with no document is said under 「需要关注」 the way a failed step is, on the home list and the study page alike", () => {
  const quiet = { assumptions: [], scenarios: [], comparators: [], results: [], stale: [], jobs: [], steps: {} };
  const document = { results: { study: { id: "std_1" } }, reports: [{ section: "main", template: "正文", rendered: "正文" }] };
  const line = (/** @type {string} */ label) => ({ kind: "export_failed", tone: "attention", tab: null, text: `「${label}」没有生成，已算出的结果保留` });
  // Newest first, as the store returns them: the pilot's study after its 模拟报告 and its CDE pack ended 「未完成」.
  const pilot = [
    { id: "exp_5", kind: "cde_communication_pack", state: "failed", cover: {}, createdAt: "2026-10-03T14:10:00.000Z" },
    { id: "exp_3", kind: "simulation_report", state: "failed", cover: {}, createdAt: "2026-10-03T13:30:00.000Z" },
    { id: "exp_2", kind: "study_package", state: "ready", cover: { ...document, revisionOf: "exp_1" }, createdAt: "2026-10-03T13:00:00.000Z" },
    { id: "exp_1", kind: "study_package", state: "ready", cover: document, createdAt: "2026-10-03T12:00:00.000Z" },
  ];
  assert.deepEqual(attentionOf({ ...quiet, exports: pilot }), [line("CDE 沟通交流资料包"), line("模拟报告")]);
  assert.deepEqual(failedExportsOf(pilot).map((row) => row.id), ["exp_5", "exp_3"]);

  // Asked for again: while the new one is on its way the older failure is no longer the newest word, and when it arrives the line is gone.
  const again = (/** @type {string} */ state, /** @type {Record<string, any>} */ cover) =>
    [{ id: "exp_6", kind: "simulation_report", state, cover, createdAt: "2026-10-03T15:00:00.000Z" }, ...pilot];
  assert.deepEqual(attentionOf({ ...quiet, exports: again("queued", {}) }), [line("CDE 沟通交流资料包")]);
  assert.deepEqual(attentionOf({ ...quiet, exports: again("ready", document) }), [line("CDE 沟通交流资料包")]);
  assert.deepEqual(attentionOf({ ...quiet, exports: again("failed", {}) }).map((entry) => entry.text), [line("模拟报告").text, line("CDE 沟通交流资料包").text],
    "a second failure is one line, not two");

  // A revision that did not finish leaves the document it was revising: nothing the reader asked for is missing.
  const revised = [{ id: "exp_2", kind: "study_package", state: "failed", cover: { revisionOf: "exp_1" } }, pilot[3]];
  assert.deepEqual(attentionOf({ ...quiet, exports: revised }), []);
  // The same holds for a document the researcher's own conversation wrote and nobody has converted yet.
  assert.deepEqual(attentionOf({ ...quiet, exports: [{ id: "exp_8", kind: "validation_pack", state: "failed", cover: {} },
    { id: "exp_7", kind: "validation_pack", state: "queued", cover: document }] }), []);
  // No exports, no line; an export still running is not a failure.
  assert.deepEqual(attentionOf({ ...quiet, exports: [{ id: "exp_9", kind: "study_package", state: "running", cover: {} }] }), []);

  // One rule, two pages: the home list's row and the study page's overview say the same lines after a failed step's.
  const steps = { trial: { status: "failed" } };
  const expected = [{ kind: "step_failed", tone: "attention", tab: null, text: "「试验」这一步没有做完，已算出的部分保留" }, line("CDE 沟通交流资料包"), line("模拟报告")];
  const home = presentSummary({ study: { ...study, steps, updatedAt: "2026-09-28T01:00:00.000Z", createdAt: "x" }, results: [], stale: [], jobs: [],
    assumptions: [], scenarios: [], comparators: [], grid: null, exports: pilot, now: NOW });
  assert.deepEqual(home.attention, expected);
  assert.deepEqual(presentStudy({ ...emptyBundle(), study: { ...study, steps }, exports: pilot }).overview.attention, expected);
});

// --- the ceiling -----------------------------------------------------------------------------------------

test("the use ceiling says why in sentences a reader can act on, not vocabulary ids", () => {
  const study = { intendedUse: "specified_analysis" };
  const unreviewed = useCeilingOf({ study, results: [{ diagnostics: { modelsUsed: [{ tier: "literature" }] } }], reviews: [] });
  assert.equal(unreviewed.ceiling, "design_support");
  assert.equal(unreviewed.withinCeiling, false);
  assert.deepEqual(unreviewed.reasons.map((reason) => reason.code), ["model_tier"]);
  assert.ok(unreviewed.reasons.every((reason) => !/[a-z]+_[a-z]+/.test(reason.detail)), "no snake_case id in a sentence");
  const reviewed = useCeilingOf({ study, results: [], reviews: [{ id: "rvw_1" }] });
  assert.equal(reviewed.withinCeiling, true);
  assert.deepEqual(reviewed.reasons, []);
});

// --- budget and jobs -----------------------------------------------------------------------------------------

test("the budget is CPU seconds — no money — and a job says what it would need", () => {
  assert.equal(budgetView(null), null);
  const budget = budgetView({ limitSeconds: 7200, usedSeconds: 222, committedSeconds: 600, remainingSeconds: 6378, awaitingBudget: 1 });
  assert.deepEqual(Object.keys(budget), ["limitSeconds", "usedSeconds", "committedSeconds", "remainingSeconds", "awaitingBudget"]);
  const waiting = jobView({ id: "job_1", kind: "design_grid", state: "awaiting_budget", cpuSecondsLimit: 9000, cpuSecondsUsed: 0, progress: {}, createdAt: "2026-09-28T01:00:00.000Z" }, NOW);
  assert.equal(waiting.cancelable, true);
  assert.equal(waiting.cpuSecondsLimit, 9000);
  assert.equal(waiting.label, "设计网格");
  const failed = jobView({ id: "job_2", kind: "rmst", state: "failed", progress: { done: 3, total: 10 }, error: { code: "engine_unavailable", message: "引擎未接入" } }, NOW);
  assert.equal(failed.cancelable, false);
  assert.equal(failed.error?.message, "引擎未接入");
  assert.deepEqual(failed.progress, { done: 3, total: 10 });
});

// --- charts: a series is a series or nothing --------------------------------------------------------------------

test("a series is drawn only from a well-formed summary; anything else is dropped rather than repaired", () => {
  assert.equal(seriesView(null), null);
  assert.equal(seriesView({ key: "a", label: "A", points: [] }), null, "no points");
  assert.equal(seriesView({ label: "A", points: [{ x: 1, y: 1 }] }), null, "no key");
  assert.equal(seriesView({ key: "a", label: "A", points: [{ x: "1", y: 1 }] }), null, "an x that is not a number");
  const series = seriesView({ key: "a", label: "A", source: "made_up", points: [{ x: 0, y: 1 }, { x: 1, y: null }, { y: 5 }] });
  assert.equal(series.source, "predicted", "an unknown source is the model-output kind, never observed");
  assert.equal(series.points.length, 2, "a point with no x is dropped");
});

// --- the tabs on plain rows ---------------------------------------------------------------------------------------

const study = { id: "std_1", userId: "u", projectId: "p", name: "n", question: "q", dataTier: "T0", intendedUse: "exploratory", status: "active", steps: {} };
const emptyBundle = () => ({
  now: NOW, study, definition: null, results: [], stale: [], reviews: [], jobs: [], budget: null, assumptions: [], members: [], exports: [], decisions: [],
  roles: ["lead"], scenarios: [], comparators: [], comparator: null, populations: [], patientSets: [], grid: null, forecasts: [], models: [],
  executions: new Map(), protocol: null, criteria: [], forecastResults: [], edges: [], evidence: { available: true, precedents: [], items: [] },
  dataPlane: { available: false }, assumptionVersions: new Map(), match: null,
});

test("a study with nothing in it gives every tab its empty state, and none of them throws", () => {
  const bundle = emptyBundle();
  const population = presentPopulationTab(bundle);
  assert.deepEqual([population.criteria, population.attrition, population.profile, population.blockers], [[], [], [], []]);
  assert.equal(population.counts, null);
  const patients = presentPatientsTab(bundle);
  assert.deepEqual([patients.model, patients.trajectories, patients.example, patients.sensitivity], [null, null, null, null]);
  const comparator = presentComparatorTab(bundle);
  assert.equal(comparator.routes.length, 4, "the four routes the engine can compute: the model-prediction comparator is not one of the choices");
  assert.ok(!comparator.routes.some((route) => route.route === "model_comparator"));
  assert.equal(comparator.dimensions.length, 10);
  assert.equal(comparator.gaps, null);
  const trial = presentTrialTab(bundle);
  assert.deepEqual([trial.designs, trial.forecasts, trial.milestones], [[], [], []]);
  assert.equal(trial.decision, null);
  const matching = presentMatchingTab(bundle);
  assert.equal(matching.available, false);
  assert.equal(matching.unavailable.code, "vcr_matching_unavailable");
  const data = presentDataTab(bundle);
  assert.deepEqual([data.assumptions, data.precedents, data.snapshots], [[], [], []]);
  assert.equal(data.headline, null);
});

// --- 匹配与招募: the referral's own trail ---------------------------------------------------------------------

/** A matching bundle with one person, one referral and the moves made on it. @param {any} events @param {{ reviewedBy?: string | null, people?: Map<string, string> | null }} [options] */
function matchingBundle(events, { reviewedBy = null, people } = {}) {
  const criteria = [{ id: "crit_1", kind: "inclusion", ordinal: 1, sourceText: "ECOG 0–1", criterionType: "performance_status" }];
  const subject = { id: "asm_1", subjectKey: "P-0192", summary: "insufficient_evidence", counts: { satisfied: 0, unknown: 1, pending_recheck: 0 }, priority: null, direction: "trial_to_patient", asOf: "2026-09-28T01:00:00.000Z", reviewedBy };
  return {
    study: { dataTier: "T2" }, now: NOW, roles: ["lead"], ...(people === undefined ? {} : { people }),
    match: {
      criteria, referrals: [{ id: "ref_1", subjectKey: "P-0192", state: "needs_evidence", siteId: null }], sites: [], siteFunnel: [], followups: [],
      tallies: { insufficient_evidence: 1 }, openByAssessment: new Map(), gapsByCriterion: new Map(), pendingReview: [], subjects: [subject],
      protocol: null, selected: { ...subject, judgments: [] }, referralEvents: events, forecastResult: null, snapshotAt: null,
    },
    forecastResults: [], scenarios: [],
  };
}

test("the selected person's referral carries every move made on it: to where, when, by whom (by name), and what was said", () => {
  const events = [
    { toState: "candidate", occurredAt: "2026-09-27T09:40:00.000Z", actor: "control-plane", note: "" },
    { toState: "needs_evidence", occurredAt: "2026-09-28T06:32:00.000Z", actor: "u_coord", note: "E1 申请近 4 周头颅 MRI" },
  ];
  const view = presentMatchingTab(matchingBundle(events, { people: new Map([["u_coord", "王协调"]]) }));
  assert.deepEqual(view.selected.trace, [
    { state: "candidate", at: "昨天 17:40", by: "平台", note: null },
    { state: "needs_evidence", at: "今天 14:32", by: "王协调", note: "E1 申请近 4 周头颅 MRI" },
  ]);
});

test("a person is shown by name and never by account id: the name when the account is there, a neutral label when it is gone, the platform's own label for its own hand, and nothing where no name was resolved", () => {
  const events = [
    { toState: "candidate", occurredAt: "2026-09-27T09:40:00.000Z", actor: "control-plane", note: "" },
    { toState: "contactable", occurredAt: "2026-09-28T06:32:00.000Z", actor: "usr_9f2c41e7d0b3", note: null },
    { toState: "contacted", occurredAt: "2026-09-28T07:00:00.000Z", actor: "wang.coordinator", note: null },
  ];
  // The account that moved the referral is gone: its id does not reach the page, what it did stays.
  const gone = presentMatchingTab(matchingBundle(events, { reviewedBy: "usr_deleted_1", people: new Map([["wang.coordinator", "王协调"]]) })).selected;
  assert.deepEqual(gone.trace.map((step) => step.by), ["平台", "已注销的账号", "王协调"]);
  assert.equal(gone.reviewedByName, "已注销的账号");
  assert.equal(gone.reviewedBy, "usr_deleted_1", "the id stays for the page's own logic: somebody countersigned, so the offer to countersign is not made");
  const named = presentMatchingTab(matchingBundle(events, { reviewedBy: "wang.coordinator", people: new Map([["wang.coordinator", "王协调"]]) })).selected;
  assert.equal(named.reviewedByName, "王协调");
  // A presenter given a bundle with no names says nothing of a person; it never says the id.
  const unresolved = presentMatchingTab(matchingBundle(events, { reviewedBy: "wang.coordinator" })).selected;
  assert.deepEqual(unresolved.trace.map((step) => step.by), ["平台", null, null]);
  assert.equal(unresolved.reviewedByName, null);
  for (const view of [gone, named, unresolved]) {
    const printed = JSON.stringify(view.trace) + String(view.reviewedByName);
    assert.equal(/usr_9f2c41e7d0b3|wang\.coordinator|control-plane|usr_deleted_1/.test(printed), false, "no account id in anything a reader is shown");
  }
  assert.equal(presentMatchingTab(matchingBundle([], { reviewedBy: null, people: new Map() })).selected.reviewedByName, null, "nobody countersigned: no name");
});

test("the intake page names whoever confirmed a field map and each account a source is granted to, by name and never by id", () => {
  const source = (/** @type {Record<string, any>} */ fieldMap, /** @type {string[]} */ grantees) => ({
    id: "src_1", name: "合作方基线", mine: true, readable: true, status: "frozen", valueSource: "observed", files: [], upload: { formats: ["csv"] },
    fieldMap: { state: "confirmed", columns: [], issues: [], ...fieldMap },
    grants: grantees.map((grantee, index) => ({ id: `grt_${index}`, grantee, fieldMode: "allow", fields: [], purposes: [] })),
  });
  const bundle = (/** @type {any} */ sources, /** @type {Map<string, string> | undefined} */ people) => ({
    study: { dataTier: "T1" }, now: NOW, roles: ["lead"], seal: {}, ...(people ? { people } : {}),
    dataPlane: { available: true, sources, snapshots: [] },
  });
  const sources = [source({ confirmedBy: "manager.li", by: "run" }, ["role:viewer", "study:std_1", "manager.li", "usr_gone_77"])];
  const view = presentIntake(bundle(sources, new Map([["manager.li", "李数据管理"]]))).sources[0];
  assert.deepEqual([view.fieldMap.confirmedBy, view.fieldMap.confirmedByName], ["manager.li", "李数据管理"], "the id stays for logic; the name is what is shown");
  assert.deepEqual(view.grants.map((grant) => grant.granteeLabel), ["角色：只读查看者", "本研究的所有成员", "李数据管理", "已注销的账号"]);
  // Nobody confirmed it: no name. No names resolved: the label is empty and never the id.
  assert.equal(presentIntake(bundle([source({ confirmedBy: null }, [])], new Map())).sources[0].fieldMap.confirmedByName, null);
  const bare = presentIntake(bundle(sources, undefined)).sources[0];
  assert.deepEqual([bare.fieldMap.confirmedByName, ...bare.grants.slice(2).map((grant) => grant.granteeLabel)], [null, "", ""]);
  for (const shown of [view.grants.map((grant) => grant.granteeLabel), [view.fieldMap.confirmedByName], bare.grants.map((grant) => grant.granteeLabel)]) {
    assert.equal(/manager\.li|usr_gone_77/.test(JSON.stringify(shown)), false, "no account id in what a reader is shown");
  }
});

test("a person with no recorded moves has an empty trail, not a made-up one", () => {
  assert.deepEqual(presentMatchingTab(matchingBundle([])).selected.trace, []);
  assert.deepEqual(presentMatchingTab(matchingBundle(undefined)).selected.trace, []);
});

test("a route the data tier cannot reach says what tier it needs, and a route somebody judged says what it found", () => {
  const routes = presentComparatorTab(emptyBundle()).routes;
  assert.equal(routes.find((route) => route.route === "external_control").state, "not_applicable");
  assert.match(String(routes.find((route) => route.route === "external_control").reason), /T2/);
  const judged = presentComparatorTab({
    ...emptyBundle(),
    comparators: [{ id: "c1", version: 1, route: "external_control", estimand: "ATT", conclusion: "not_estimable", gapList: [{ title: "a" }, { title: "b" }], resultId: null, targetTrial: {}, configuration: {}, reviewState: "ai_set" }],
    comparator: null,
  });
  const external = judged.routes.find((route) => route.route === "external_control");
  assert.equal(external.state, "not_estimable", "a finished finding, whatever the tier");
  assert.equal(external.reason, "缺 2 项数据，见下方清单");
  assert.equal(judged.gaps.items.length, 2);
});

test("criteria are numbered I1… and E1… by kind and position, and a waterfall step finds its rule by id or by code", () => {
  const criteria = [
    { id: "c1", ordinal: 1, kind: "inclusion" }, { id: "c2", ordinal: 2, kind: "exclusion" }, { id: "c3", ordinal: 3, kind: "inclusion" },
  ];
  assert.deepEqual([...criterionCodes(criteria).values()], ["I1", "E1", "I2"]);
  const tab = presentPopulationTab({
    ...emptyBundle(), criteria,
    populations: [{ id: "p1", version: 1, kind: "real", name: "", definition: {}, counts: { realPatients: 100, eligible: 10, indeterminate: 20, excluded: 70 }, profile: {}, quality: {},
      waterfall: [{ criterionId: "c3", kept: 60, excluded: 30, unknown: 10 }, { code: "E1", kept: 50, excluded: 5, unknown: 5 }], resultId: null, reviewState: "ai_set", createdAt: "x" }],
  });
  assert.deepEqual(tab.criteria.map((row) => [row.code, row.kept, row.excluded, row.unknown]), [["I1", null, null, null], ["E1", 50, 5, 5], ["I2", 60, 30, 10]]);
  assert.deepEqual(tab.outcome, { eligible: 10, insufficient: 20, ineligible: 70 });
  assert.deepEqual(tab.blockers.map((row) => row.code), ["I2", "E1"], "the rules that cost the most people, in that order");
});

test("a covariate past the balance floor is flagged, and the population tab carries one comparison of versions: the engine's, never a second one of its own", () => {
  const profile = { rows: [{ key: "a", label: "A", ours: { value: 50 }, theirs: { value: 40 }, smd: 0.31 }, { key: "b", label: "B", ours: 1, theirs: 1, smd: 0.05 }] };
  const older = { id: "p1", version: 1, kind: "real", counts: { realPatients: 90 }, profile: { rows: [{ key: "a", label: "A", ours: { value: 48 } }] }, waterfall: [], quality: {}, createdAt: "2026-09-27T01:00:00.000Z" };
  const newer = { id: "p2", version: 2, kind: "real", counts: { realPatients: 100 }, profile, waterfall: [], quality: {}, createdAt: "2026-09-28T01:00:00.000Z" };
  const tab = presentPopulationTab({ ...emptyBundle(), populations: [newer, older] });
  assert.deepEqual(tab.profile.map((row) => row.flagged), [true, false]);
  // Two stored versions are listed as versions. What they were computed to differ by is the engine's job on a registered dataset
  // (`presentComparison`, the library's `cohort.build` comparison); a side-by-side of what each version stored was a second answer
  // to that question with other numbers, and is gone.
  assert.deepEqual(tab.versions.map((version) => version.label), ["人群 v2", "人群 v1"]);
  assert.equal(Object.hasOwn(tab, "versionCompare"), false);
});

test("the quality report reports numbers and never a verdict", () => {
  const report = qualityReportView({
    fidelity: { univariate: [{ statistic: "ks_d", value: 0.04, missingRateDifference: 0.01 }], pairwise: [{ value: 0.05 }], global: { sPMSE: 1.4, propensityAuc: 0.56 } },
    disclosure: { available: true, replicationRatio: 0.9, membershipAuc: 0.52 }, generator: { trainingObservations: 3412, syntheticCopies: 1 },
  });
  assert.equal(report.tag, "合成 · 探索性");
  assert.equal(report.trainingRecords, 3412);
  assert.deepEqual(report.groups.map((group) => group.key), ["fidelity", "leakage"]);
  assert.ok(report.groups.flatMap((group) => group.rows).every((row) => row.value.source === "synthetic"));
  assert.doesNotMatch(JSON.stringify(report), /安全|匿名|合格|通过|风险低/, "a report is values, not a verdict");
  assert.equal(qualityReportView({}), null);
});

test("a patient set's model card says what the model is, where it may be used, and what label it has earned", () => {
  const card = presentModelCard({
    id: "m1", name: "x", version: "1.2", tier: "literature", risk: "low", endpointType: "time_to_event", useCeiling: "design_support",
    card: { title: "标题", type: "fitted_prediction_model", provider: "研究", knownLimits: ["无更新机制"] },
    applicability: { population: "二线 NSCLC", region: "含中国人群", sources: ["A", "B"] }, validation: { external: false, internal: "ok", declaredEvidence: ["x"] },
    evidence: ["code_verification"], missingEvidence: ["seed_reproducible"],
  }, [{ id: "std_1", label: "EV-201" }]);
  assert.equal(card.name, "标题");
  assert.equal(card.twin, "baseline_conditioned_prediction", "a twin is derived from evidence, never granted");
  assert.equal(card.twinLabel, "基线条件化预测");
  assert.match(String(card.twinReason), /缺少/);
  assert.equal(card.region, "含中国人群");
  assert.deepEqual(card.validation.map((row) => row.label), ["外部验证", "内部验证"], "a key the page has no word for is not printed as a raw id");
  assert.equal(card.useCeiling, "design_support");
});

test("a model card says which call shape it has: the first by default, the second with what it reads, how far it projects and what its contract still lacks", () => {
  const first = presentModelCard({ id: "m1", name: "x", version: "1.0.0", tier: "scenario", risk: "none", card: {}, applicability: {}, validation: {}, evidence: [] }, []);
  assert.deepEqual([first.shape, first.shapeLabel, first.shapeMissing], ["baseline_to_outcome", "基线 → 结局分布", []]);
  assert.equal("events" in first, false, "nothing of the second shape is claimed for the first");
  const second = presentModelCard({
    id: "m2", name: "event-model", version: "2.1.0", tier: "literature", risk: "low",
    card: { interfaceShape: "event_history_to_trajectories", inputs: ["诊断事件"], outputs: "N 条未来轨迹", history: { eventTypes: ["diagnosis", "lab"], fields: ["subject", "time"] },
      trajectories: { max: 500, absorbing: [] }, knownLimits: ["罕见事件"] },
    applicability: { population: "成人", eventTypes: ["death"], horizon: { max: 24, unit: "months" } }, validation: { temporal: "时间外验证" }, evidence: [],
  }, []);
  assert.deepEqual([second.shape, second.shapeLabel, second.events, second.horizon, second.trajectoriesMax], ["event_history_to_trajectories", "事件历史 → 未来轨迹", ["diagnosis", "lab"], "24 months", 500]);
  assert.deepEqual(second.shapeMissing, [], "a complete card has nothing missing");
  const gaps = presentModelCard({ id: "m3", name: "e", version: "1", tier: "literature", risk: "low", card: { interfaceShape: "event_history_to_trajectories" }, applicability: {}, validation: {}, evidence: [] }, []);
  assert.ok(gaps.shapeMissing.length >= 10 && gaps.shapeMissing.every((text) => text.includes("事件历史 → 未来轨迹接口的模型卡缺")));
  assert.equal(presentModelCard({ id: "m4", name: "u", version: "1", tier: "scenario", risk: "none", card: { interfaceShape: "quantum" }, applicability: {}, validation: {}, evidence: [] }, []).shape, "unknown");
});

test("the reader shows a model document as its own sections, and says the snapshot is unchanged while the records still agree", () => {
  const inputs = modelInputs();
  const versions = [frozenVersion(inputs)];
  const results = resultRows();
  const model = reportModelFor({ inputs, versions, results });
  const bundle = {
    now: NOW, study: modelStudy, exports: [], definition: inputs.definition, assumptions: inputs.assumptions, results, seal: null, reviews: [], stale: [],
    models: [], populations: [], comparators: [], comparator: null, scenarios: [], patientSets: [], executions: new Map(), decisions: [], allResults: [], currentNodes: null,
    modelAnalysis: model.modelAnalysis,
  };
  const row = { id: "exp_1", kind: "model_analysis_report", state: "ready", createdAt: "2026-10-04T08:00:00.000Z", cover: { results: model, reports: [{ section: "introduction", template: "引言的文字。", rendered: "引言的文字。" }] } };
  const shown = presentExport(row, { ...bundle, exports: [row] });
  assert.equal(shown.title, "模型分析报告 v1");
  const titles = shown.document.sections.filter((section) => !section.id.includes("-t")).map((section) => section.title);
  assert.deepEqual(titles.slice(0, 3), ["摘要", "引言", "目的"], "M15's sections, not the nine parts of a study package");
  assert.ok(shown.document.sections.some((section) => section.body === "引言的文字。"));
  assert.equal(shown.snapshotChanged, undefined, "the records still say what the document was built from");
  // Another kind keeps the nine parts.
  const other = presentExport({ ...row, kind: "study_package", cover: { results: reportModelFor({ inputs, versions, results }), reports: row.cover.reports } }, { ...bundle, exports: [row] });
  assert.equal(other.document.sections[0].title, "研究与分析概要");
  // A record that moved since is said: the document keeps what it was built from.
  const moved = modelInputs();
  moved.assumptions[0] = { ...moved.assumptions[0], pointValue: 15 };
  const after = presentExport(row, { ...bundle, exports: [row], modelAnalysis: reportModelFor({ inputs: moved, versions, results }).modelAnalysis, assumptions: moved.assumptions });
  assert.equal(after.snapshotChanged, true);
});

test("a precedent keeps planned and actual apart and shows a rate only when its three inputs exist", () => {
  const precedent = presentPrecedent({ id: "p", registry_id: "NCT1", registry: "clinicaltrials.gov", title: "t",
    pico: { conditions: ["NSCLC"] }, design: { phases: ["PHASE3"] }, enrollment: { planned: 420, actual: 400, accrualToPrimaryCompletionMonths: 20 }, sites: { count: 10, countries: ["中国"] },
    eligibility_text: "e", results: { hasResults: true }, sources: [{ url: "https://example.org" }] });
  assert.equal(precedent.planned, 420);
  assert.equal(precedent.actual, 400);
  assert.equal(precedent.perSitePerMonth, 2);
  assert.equal(presentPrecedent({ id: "q", registry_id: "x", enrollment: { planned: 5 } }).perSitePerMonth, null);
});

test("a study summary reads as the home list's row: tier, latest conclusion, attention", () => {
  const { designs } = presentDesigns(designsBundle());
  void designs;
  const row = presentSummary({ study: { ...study, updatedAt: "2026-09-28T01:00:00.000Z", createdAt: "x", steps: {} }, results: designsBundle().results, stale: [], jobs: [],
    assumptions: [], scenarios: designsBundle().scenarios, comparators: [], grid: designsBundle().grid, now: NOW });
  assert.equal(row.tier, "T0");
  assert.equal("dataTier" in row, false, "the page's word is `tier`");
  assert.equal(row.updatedAt, "今天 09:00");
  assert.match(String(row.conclusion.text), /已模拟/);
});

// --- the fixtures the web renders --------------------------------------------------------------------------------------

/** Every string in a parsed value. @param {unknown} value @param {string[]} [into] */
function strings(value, into = []) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, into);
  return into;
}

test("no fixture says what §14 forbids: a best design, an approval, anonymity, a safety verdict, an accuracy claim", () => {
  const files = ["ev201", "empty"].flatMap((dir) => readdirSync(join(FIXTURE_DIR, dir)).map((name) => join(FIXTURE_DIR, dir, name)));
  assert.ok(files.length >= 20, `it walked ${files.length} fixture files`);
  let scanned = 0;
  for (const file of files) {
    for (const text of strings(JSON.parse(readFileSync(file, "utf8")))) {
      scanned += 1;
      assert.doesNotMatch(text, /最佳|最优|推荐方案|已获批|监管级|匿名|准确率|安全无虞/, `${file}: ${text}`);
    }
  }
  assert.ok(scanned > 1000, `it read ${scanned} strings`);
});

test("no fixture carries a database word the page has no use for, and none puts a money sign on compute", () => {
  let scanned = 0;
  for (const dir of ["ev201", "empty"]) {
    for (const name of readdirSync(join(FIXTURE_DIR, dir))) {
      const text = readFileSync(join(FIXTURE_DIR, dir, name), "utf8");
      scanned += 1;
      assert.doesNotMatch(text, /"dataTier"|"user_id"|"study_id"|limitCny|spentCny|"¥/, name);
    }
  }
  assert.ok(scanned >= 20);
});

test("AC-21 a superseded review reads changed without becoming an intended-use gate", () => {
  const study = { intendedUse: "specified_analysis" };
  const review = { id: "rev_1", kind: "statistical", nodes: ["result:res_a@1"] };
  // The reviewed version is the current one: the review counts.
  assert.equal(vcrReviewIsCurrent(review, { results: [{ id: "res_a", version: 1 }] }), true);
  assert.equal(useCeilingOf({ study, results: [{ id: "res_a", version: 1 }], reviews: [review] }).withinCeiling, true);
  // A recompute superseded it — the stale mark has already cleared, and the
  // current result is a new row. The review no longer countersigns anything
  // the study holds, so the ceiling drops back and says why.
  const after = [{ id: "res_b", version: 2 }];
  assert.equal(vcrReviewIsCurrent(review, { results: after }), false);
  const ceiling = useCeilingOf({ study, results: after, reviews: [review] });
  assert.equal(ceiling.withinCeiling, true);
  assert.deepEqual(ceiling.reasons, []);
  // A node still marked stale also makes it changed, whatever the results.
  assert.equal(vcrReviewIsCurrent({ nodes: ["assumption:dropout_rate@1"] }, { results: [], stale: [{ node: "assumption:dropout_rate@1" }] }), false);
});

// --- the verification review's findings, on the presenters ----------------------------------------------------------------

test("C2-9 the overview counts a design as simulated only when it has a number from a result — a configured sample size is not one", () => {
  const written = { code: "A", dominated: false, measures: { sample_size: { value: 120 }, cost: { value: 90 } } };
  const run = { code: "B", dominated: false, measures: { sample_size: { value: 120 }, power: { value: 81.2 } } };
  assert.equal(designsSentence([written]), null, "one design written and none run says nothing of simulation");
  assert.equal(designsSentence([written, written, run]), "已模拟 1 个方案，功效 81%", "three designs on the page, one of them simulated");
  const headline = conclusionOf({ designs: [written, written], results: [], allResults: [], comparators: [] });
  assert.equal(headline, null, "and the study's conclusion does not claim a simulation that was never run");
});

test("C2-3 a grid's cells are read as the engine numbers them, from 1: two designs by two truths are a two-by-two picture", () => {
  const grid = {
    id: "grd_1", version: 1, comparisonGoal: null,
    dimensions: { designs: [{ label: "每组 60" }, { label: "每组 120" }] },
    truthScenarios: [{ label: "效应 0.3", effect: 0.3 }, { label: "效应 0.6", effect: 0.6 }],
    cells: [[1, 1, 0.25], [1, 2, 0.75], [2, 1, 0.5], [2, 2, 0.95]].map(([designIndex, truthIndex, value]) => ({
      designIndex, truthIndex, status: "succeeded", measures: [{ name: "power", value, simulated: true, mcse: 0.004 }] })),
  };
  const tab = presentTrialTab({ ...emptyBundle(), grid });
  assert.equal(tab.grid.rows.length, 2);
  assert.equal(tab.grid.columns.length, 2);
  assert.deepEqual(tab.grid.rows.map((row) => row.header), ["每组 60", "每组 120"]);
  assert.deepEqual(tab.grid.rows.map((row) => row.cells.map((cell) => cell.value)), [[0.25, 0.75], [0.5, 0.95]],
    "the cell (design 2, truth 1) is the second row's first column, not shifted by one");
  // A cell numbered 0 is not a cell of this grid: the page does not invent a row for it.
  const zero = presentTrialTab({ ...emptyBundle(), grid: { ...grid, cells: [{ ...grid.cells[0], designIndex: 0, truthIndex: 0 }] } });
  assert.equal(zero.grid, null);
});

test("C2-4 a design's number is stale while the design is marked and its result is older than the mark — the numbers a later stage wrote are fresh, and the ones it carried say so themselves", () => {
  const design = scenario("a", 1, "A", { resultId: "res_a2" });
  const node = "trial_scenario:a@1";
  const marked = { node, reason: "assumption_changed", markedAt: "2026-09-28T02:00:00.000Z", queuedJobId: "job_9" };
  const base = { ...emptyBundle(), scenarios: [design], stale: [marked] };
  const older = { ...result("a", [measure("power", 0.5)]), id: "res_a2", createdAt: "2026-09-28T01:00:00.000Z" };
  assert.equal(presentDesigns({ ...base, results: [older], allResults: [older] }).designs[0].measures.power.stale, true,
    "the result predates the change: yesterday's world, marked by the design's own node");
  // A later stage landed after the mark: a result version nobody marked. Its own number is fresh; the number it carried says it is old.
  const newer = { ...result("a", [measure("required_events", 300), { ...measure("power", 0.5), stale: true }]), id: "res_a2", version: 2, createdAt: "2026-09-28T03:00:00.000Z" };
  const fresh = presentDesigns({ ...base, results: [newer], allResults: [newer] }).designs[0].measures;
  assert.equal(fresh.required_events.stale, false);
  assert.equal(fresh.power.stale, true);
  const page = presentTrialTab({ ...base, results: [newer], allResults: [newer] });
  assert.ok(page.stale, "the page as a whole stays stale until the mark clears");
  assert.equal(page.stale.queued, true);
});

test("C2-4 a stage the recomputation did not run again is not left on the page: it is dropped and said", () => {
  const design = scenario("a", 1, "A", { resultId: "res_a" });
  const dropped = { ...result("a", [measure("power", 0.5)]), diagnostics: { notRerun: [{ stage: "assurance", measures: ["assurance"] }] } };
  const page = presentTrialTab({ ...emptyBundle(), scenarios: [design], results: [dropped], allResults: [dropped] });
  assert.deepEqual(page.footnotes, ["方案 A：成功把握不再显示——效应假设卡现在没有预测分布，没有可以积分的先验，这一项没有重算。"]);
  const other = { ...dropped, diagnostics: { notRerun: [{ stage: "simulation", measures: ["power"] }] } };
  assert.match(presentTrialTab({ ...emptyBundle(), scenarios: [design], results: [other], allResults: [other] }).footnotes[0], /仿真没有重算/);
});

test("C3-11 the run record says an analytic value is an approximation and what tolerance the simulation was held to", () => {
  const design = scenario("a", 1, "A", { resultId: "res_a" });
  /** @param {Record<string, any>} check */
  const withCheck = (check) => presentTrialTab({ ...emptyBundle(), scenarios: [design], results: [{ ...result("a", [measure("power", 0.5)]), diagnostics: { analyticCheck: check } }],
    allResults: [{ ...result("a", [measure("power", 0.5)]), diagnostics: { analyticCheck: check } }] }).runRecord[0];
  const approximate = withCheck({ difference: -0.011, mcse: 0.0004, withinThreeMcse: false, withinTolerance: true, approximationBias: 0.015, tolerance: 0.0162 });
  assert.equal(approximate.ok, true, "1.1 points against an approximation documented to 1.5 is agreement");
  assert.match(approximate.detail, /一阶近似.*相差 1\.1 个百分点.*容许的 1\.6 个百分点/);
  const exact = withCheck({ difference: 0.0003, withinThreeMcse: true, approximationBias: 0, tolerance: 0.0012, withinTolerance: true });
  assert.match(exact.detail, /解析值与仿真值一致/);
  const off = withCheck({ difference: 0.03, withinThreeMcse: false, withinTolerance: false, approximationBias: 0.015, tolerance: 0.0162 });
  assert.equal(off.ok, false);
  assert.match(off.detail, /超出容许/);
  const older = withCheck({ difference: 0.001, withinThreeMcse: true });
  assert.equal(older.ok, true, "a result written before the tolerance existed still reads");
});

test("C2-8 the comparator page reads a two-arm reconstruction: both arms' quality checks, both medians, the RMST interval to the decimals it supports", () => {
  const check = (reported, reconstructed, pass = true) => ({ name: "n", reported, reconstructed, pass });
  const comparator = { id: "cmp_1", version: 1, route: "literature_control", estimand: "ATT", conclusion: "estimable", gapList: [], resultId: "res_c",
    targetTrial: {}, configuration: {}, reviewState: "ai_set", createdAt: "2026-09-28T01:00:00.000Z" };
  const stored = { id: "res_c", version: 1, kind: "comparator", conclusion: "estimable", reviewState: "ai_set", counts: {}, executionId: null,
    measures: [
      { name: "median_survival_control", value: 12.1, source: "reconstructed" },
      { name: "median_survival_treatment", value: 17.6, source: "reconstructed" },
      { name: "rmst_difference", value: 1.63519536, unit: "months", source: "calculated", interval: { kind: "confidence", low: 0.38681, high: 2.883581, level: 0.95 } },
    ],
    diagnostics: { tau: 18, qualityControl: [
      { checks: { atRisk: check([200, 150], [200, 149]), events: check(130, 128), median: check(12, 12.1) } },
      { checks: { atRisk: check([200, 170], [200, 168]), events: check(90, 91, true), logHazardRatio: check(-0.4, -0.38) } }] } };
  const tab = presentComparatorTab({ ...emptyBundle(), comparators: [comparator], results: [stored], allResults: [stored] });
  assert.equal(tab.qc.length, 6, "three checks for each arm");
  assert.ok(tab.qc.some((row) => row.label === "对照组：总事件数") && tab.qc.some((row) => row.label === "试验组：|Δlog HR|"));
  assert.equal(new Set(tab.qc.map((row) => row.key)).size, 6, "no two rows share a key");
  assert.equal(tab.median.value, 12.1, "the page's median is the control arm's");
  assert.ok(tab.diagnostics.some((row) => row.key === "median_survival_treatment" && row.value.value === 17.6), "and the treatment arm's is beside it");
  assert.deepEqual([tab.rmst.value.value, tab.rmst.value.interval.low, tab.rmst.value.interval.high], [1.63519536, 0.39, 2.88],
    "an interval without a Monte-Carlo error is stated to the decimals its own width supports, not to six");
  assert.equal(tab.rmst.value.precision, 2);
  // One arm keeps its plain shape.
  const single = presentComparatorTab({ ...emptyBundle(), comparators: [comparator], allResults: [{ ...stored, diagnostics: { qualityControl: { checks: { events: check(130, 128) } } } }],
    results: [] });
  assert.deepEqual(single.qc.map((row) => row.label), ["总事件数"]);
});

test("C2-8 C2-13 a hybrid control shows the MAP prior's own numbers, each with its source; typed inputs say so in the headline", () => {
  const comparator = { id: "cmp_h", version: 1, route: "hybrid_control", estimand: "ATT", conclusion: "estimable", gapList: [], resultId: "res_h",
    targetTrial: {}, configuration: {}, reviewState: "ai_set", createdAt: "2026-09-28T01:00:00.000Z" };
  const stored = { id: "res_h", version: 1, kind: "comparator", conclusion: "estimable", reviewState: "ai_set", counts: { priorEffectiveSampleSize: 31.2 }, executionId: null,
    measures: [{ name: "map_mean", value: -0.71, source: "assumed" }, { name: "map_sd", value: 0.4, source: "assumed" },
      { name: "prior_effective_sample_size_moment", value: 31.2, source: "assumed" }, { name: "tau_posterior_median", value: 0.3, source: "assumed" }],
    diagnostics: { inputsAssumed: true } };
  const tab = presentComparatorTab({ ...emptyBundle(), comparators: [comparator], results: [stored], allResults: [stored] });
  assert.deepEqual(tab.diagnostics.map((row) => row.key), ["map_mean", "map_sd", "prior_effective_sample_size_moment", "tau_posterior_median"]);
  assert.ok(tab.diagnostics.every((row) => row.value.source === "assumed"));
  assert.equal(tab.diagnostics[2].label, "先验有效样本量（矩法）");
  assert.match(String(tab.headline), /输入为假设/);
});

test("C2-14 when the latest comparator version has no result, the page keeps the last good one and says it is not the latest", () => {
  const good = { id: "cmp_1", version: 1, route: "external_control", estimand: "ATT", conclusion: "estimable", gapList: [], resultId: "res_1",
    targetTrial: {}, configuration: {}, reviewState: "ai_set", createdAt: "2026-09-27T01:00:00.000Z" };
  const latest = { ...good, id: "cmp_2", version: 2, conclusion: null, resultId: null, createdAt: "2026-09-28T01:00:00.000Z" };
  const stored = { id: "res_1", version: 1, kind: "comparator", conclusion: "estimable", reviewState: "ai_set", counts: { realPatients: 100 }, executionId: null,
    measures: [{ name: "rmst_difference", value: 1.5, unit: "months", source: "calculated" }], diagnostics: { tau: 12 } };
  const node = "comparator_design:cmp_2@2";
  const bundle = { ...emptyBundle(), study: { ...study, dataTier: "T2" }, comparators: [latest, good], results: [stored], allResults: [stored],
    jobMarks: [{ key: `job:${node}`, state: "failed", detail: { node, error: "vcr_scenario_unknown_fields", message: "配置里有引擎不读的字段：foo" } }] };
  const tab = presentComparatorTab(bundle);
  assert.equal(tab.rmst.value.value, 1.5, "the last good result's numbers are still on the page");
  assert.match(tab.partial.done, /上一版对照设计（v1）/);
  assert.match(tab.partial.missing, /最新一版（v2）没有算成：配置里有引擎不读的字段：foo/);
  assert.equal(tab.routes.find((route) => route.route === "external_control").selected, true);
  // A route with only a failed version and nothing before it has nothing to keep.
  const none = presentComparatorTab({ ...bundle, comparators: [latest], results: [], allResults: [] });
  assert.equal(none.rmst, null);
  assert.equal(none.partial, null);
});

test("C3-05 a countersignature moves the node it names to reviewed — who, when, which version — and one on an earlier version says the card changed after it", () => {
  const reviews = [
    { id: "rev_2", kind: "statistical", nodes: ["assumption:dropout_rate@3"], reviewer: "u_stat", reviewerName: "Statistician", createdAt: "2026-09-28T02:00:00.000Z" },
    { id: "rev_1", kind: "clinical", nodes: ["assumption:hazard_ratio@1", "assumption:dropout_rate@2"], reviewer: "u_clin", reviewerName: "Clinician", createdAt: "2026-09-27T02:00:00.000Z" },
  ];
  const signed = reviewOfNode("assumption:hazard_ratio@1", reviews);
  assert.deepEqual([signed.state, signed.reviewedBy, signed.reviewedAt, signed.reviewedVersion, signed.reviewKind],
    ["reviewed", "Clinician", "2026-09-27T02:00:00.000Z", 1, "clinical"]);
  const moved = reviewOfNode("assumption:hazard_ratio@2", reviews);
  assert.deepEqual([moved.state, moved.reviewedVersion, moved.reviewedBy], ["changed_after_review", 1, "Clinician"], "the signed version is the earlier one, and the card says so");
  assert.equal(reviewOfNode("assumption:dropout_rate@3", reviews).reviewedBy, "Statistician", "the newest signature that names the version");
  assert.equal(reviewOfNode("assumption:outcome_sd@1", reviews), null, "nobody signed it: it is what it was stored as");
  const card = { key: "hazard_ratio", version: 1, reviewState: "ai_set" };
  assert.equal(withReviewState(card, "assumption:hazard_ratio@1", reviews).reviewState, "reviewed");
  assert.equal(withReviewState({ ...card, reviewState: "reviewed" }, "assumption:hazard_ratio@2", reviews).reviewState, "reviewed", "a card a person wrote stays theirs");
  assert.equal(withReviewState(card, "assumption:hazard_ratio@9", []), card);
});

test("C3-07 a review is current only when every node it names is at its current version — an edited card, a regenerated population — while evidence, not a signature, defines the use ceiling", () => {
  const study = { id: "std_1", intendedUse: "specified_analysis" };
  const rows = {
    study, assumptions: [{ key: "hazard_ratio", version: 2 }, { key: "outcome_sd", version: 1 }], populations: [{ id: "pop_2", version: 2 }],
    scenarios: [{ id: "scn_a", version: 1, label: "A" }], results: [{ id: "res_a", version: 1 }], comparators: [], patientSets: [], grid: null,
  };
  const current = vcrCurrentNodes(rows);
  assert.ok(current.nodes.has("assumption:hazard_ratio@2") && current.nodes.has("population:pop_2@2") && current.nodes.has("result:res_a@1"));
  const context = { results: rows.results, stale: [], current };
  assert.equal(vcrReviewIsCurrent({ nodes: ["assumption:hazard_ratio@1"] }, context), false, "the card was edited after it was signed: no stale mark says so, the version does");
  assert.equal(vcrReviewIsCurrent({ nodes: ["assumption:hazard_ratio@2", "population:pop_2@2"] }, context), true);
  assert.equal(vcrReviewIsCurrent({ nodes: ["population:pop_1@1"] }, context), false, "a population regenerated since");
  assert.equal(vcrReviewIsCurrent({ nodes: ["snapshot:src_1@1"] }, context), true, "a kind the study does not version is judged by its stale mark alone");

  // What the headline depends on, from the lineage edges backwards.
  const edges = [{ from: "assumption:hazard_ratio@2", to: "trial_scenario:scn_a@1" }, { from: "trial_scenario:scn_a@1", to: "result:res_a@1" },
    { from: "assumption:outcome_sd@1", to: "comparator_design:cmp_1@1" }];
  const depends = vcrDependencies(edges, "result:res_a@1");
  assert.deepEqual([...depends].sort(), ["assumption:hazard_ratio@2", "result:res_a@1", "trial_scenario:scn_a@1"]);
  const useOf = (reviews) => useCeilingOf({ study, results: rows.results, reviews, stale: [], current, dependsOn: depends });
  assert.equal(useOf([{ id: "r1", nodes: ["assumption:hazard_ratio@2"] }]).withinCeiling, true, "a current review of a card the headline rests on");
  const elsewhere = useOf([{ id: "r2", nodes: ["assumption:outcome_sd@1"] }]);
  assert.equal(elsewhere.withinCeiling, true, "an unrelated review does not change the evidence ceiling");
  assert.deepEqual(elsewhere.reasons.map((reason) => reason.code), []);
  const moved = useOf([{ id: "r3", nodes: ["assumption:hazard_ratio@1"] }]);
  assert.deepEqual(moved.reasons.map((reason) => reason.code), []);
});

// --- a criterion taken from the study's pack says so ---------------------------------

test("a locator that names a knowledge pack says 知识包, and 「AI 草拟」 when the study's pack is a draft; the old locators read as they did", () => {
  assert.equal(vcrLocatorText({ page: 12, section: "4.2" }), "第 12 页，4.2");
  assert.equal(vcrLocatorText({ pack: "type_2_diabetes", entry: "c_hba1c" }), "知识包");
  assert.equal(vcrLocatorText({ pack: "rare_thing", entry: "c1" }, { draftPack: true }), "知识包（AI 草拟）");
  assert.equal(vcrLocatorText({ pack: "rare_thing", entry: "c1" }, { draftPack: false }), "知识包");
  assert.equal(vcrLocatorText({ registryId: "NCT02296125", field: "eligibility" }), null);
  assert.equal(vcrLocatorText(null), null);
});
