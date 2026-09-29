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

import { VCR_VALUE_SOURCES } from "@evimed/domain";

import {
  attentionOf, budgetView, conclusionOf, designsSentence, jobView, notEstimableDesign, numberString, presentDesigns, presentModelCard,
  presentPrecedent, presentSummary, useCeilingOf, valueString,
} from "../src/vcrViews.mjs";
import {
  presentComparatorTab, presentDataTab, presentMatchingTab, presentPatientsTab, presentPopulationTab, presentTrialTab, qualityReportView,
  seriesView, criterionCodes,
} from "../src/vcrViewsTabs.mjs";
import {
  countsView, decimalsFor, defaultSourceOf, intervalView, measureValue, rangeString, staleNote, zhDate, zhTime,
} from "../src/vcrViewsKit.mjs";
import { FIXTURE_DIR } from "./vcrViewsFixtures.mjs";

const NOW = new Date("2026-09-28T09:00:00.000Z"); // 17:00 in China standard time

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
  assert.deepEqual(value.detail?.fields?.map((field) => field.label), ["方法", "种子", "重复次数", "蒙特卡洛标准误", "计算用时", "情景哈希"]);
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
  assert.equal(notEstimableDesign([{ route: "literature_control", conclusion: "limited" }], []), null);
});

// --- the ceiling -----------------------------------------------------------------------------------------

test("the use ceiling says why in sentences a reader can act on, not vocabulary ids", () => {
  const study = { intendedUse: "specified_analysis" };
  const unreviewed = useCeilingOf({ study, results: [{ diagnostics: { modelsUsed: [{ tier: "literature" }] } }], reviews: [] });
  assert.equal(unreviewed.ceiling, "design_support");
  assert.equal(unreviewed.withinCeiling, false);
  assert.deepEqual(unreviewed.reasons.map((reason) => reason.code), ["model_tier", "not_reviewed"]);
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
  assert.equal(comparator.routes.length, 5);
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

test("a covariate past the balance floor is flagged, and a version comparison shows what was stored and computes no SMD", () => {
  const profile = { rows: [{ key: "a", label: "A", ours: { value: 50 }, theirs: { value: 40 }, smd: 0.31 }, { key: "b", label: "B", ours: 1, theirs: 1, smd: 0.05 }] };
  const older = { id: "p1", version: 1, kind: "real", counts: { realPatients: 90 }, profile: { rows: [{ key: "a", label: "A", ours: { value: 48 } }] }, waterfall: [], quality: {}, createdAt: "2026-09-27T01:00:00.000Z" };
  const newer = { id: "p2", version: 2, kind: "real", counts: { realPatients: 100 }, profile, waterfall: [], quality: {}, createdAt: "2026-09-28T01:00:00.000Z" };
  const tab = presentPopulationTab({ ...emptyBundle(), populations: [newer, older] });
  assert.deepEqual(tab.profile.map((row) => row.flagged), [true, false]);
  assert.equal(tab.versionCompare.left.counts.realPatients, 90);
  assert.equal(tab.versionCompare.right.counts.realPatients, 100);
  assert.equal(tab.versionCompare.rows.find((row) => row.key === "a").left.value, 48);
  assert.equal(presentPopulationTab({ ...emptyBundle(), populations: [newer] }).versionCompare, null, "one version has nothing to compare with");
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
