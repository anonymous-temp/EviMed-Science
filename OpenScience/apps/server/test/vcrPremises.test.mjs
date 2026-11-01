// 「这个结论的前提」 (remediation plan 5.2): one list for the trial, the population and the comparator, computed here and shown by the page.
// No database: `vcrPremises` is pure, and the trial page is read from a bundle the way `vcrViews.test.mjs` reads it.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_PREMISES_DECISIVE_MAX, VCR_PREMISE_SOURCES, vcrAppliedDefaults } from "@evimed/domain";
import { finishPremises, premiseSourceOfCard, vcrPremises } from "../src/vcrPremises.mjs";
import { presentComparatorTab, presentPopulationTab, presentTrialTab } from "../src/vcrViewsTabs.mjs";

/** The two-arm survival design that states six values and nothing else. */
const SIX_VALUES = Object.freeze({
  design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 }, endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { duration: 18, followup: 12 },
});

const trialInput = (/** @type {Record<string, any>} */ over = {}) => ({
  endpointType: "time_to_event", configuration: SIX_VALUES, diagnostics: {}, bound: [], cards: [],
  appliedDefaults: vcrAppliedDefaults("design.simulate", SIX_VALUES), hasAssurance: true, ...over,
});

const byKey = (/** @type {Array<Record<string, any>>} */ rows) => Object.fromEntries(rows.map((row) => [row.key, row]));

test("the six-value two-arm survival design: at most five open premises, and the dropout is one of them, marked as a default", () => {
  const rows = vcrPremises("trial", trialInput());
  const open = rows.filter((row) => row.decisive);
  assert.ok(open.length <= VCR_PREMISES_DECISIVE_MAX && open.length >= 3, `${open.length} open premises`);
  assert.deepEqual(open.map((row) => row.key), ["effect", "control", "dropout", "accrual", "alpha"]);
  const dropout = byKey(rows).dropout;
  assert.equal(dropout.value, "0%");
  assert.equal(dropout.source, "default", "a dropout nobody wrote is a default, and the page says so");
  assert.equal(dropout.decisive, true);
  assert.equal(dropout.label, "每年脱落率");
  assert.deepEqual([byKey(rows).effect.value, byKey(rows).effect.source], ["0.7", "assumed"], "a value somebody wrote with no evidence under it is an assumption");
  assert.equal(byKey(rows).control.value, "12 个月");
  assert.equal(byKey(rows).accrual.value, "入组 18 个月，随访 12 个月");
  assert.deepEqual([byKey(rows).alpha.value, byKey(rows).alpha.source], ["单侧2.5%", "default"]);
  // What else the run took is listed and folded.
  assert.equal(byKey(rows).controlDistribution.value, "指数分布");
  assert.equal(byKey(rows).method.value, "log-rank 检验");
  assert.ok(rows.filter((row) => !row.decisive).every((row) => row.source === "default" || row.key === "timeUnit"), "nothing but defaults and the unit is folded away");
  // Every row is well-formed: a label, a value and one of the four sources.
  for (const row of rows) {
    assert.ok(row.label && row.value, row.key);
    assert.ok(VCR_PREMISE_SOURCES.includes(row.source), row.key);
  }
});

test("a premise carries where it came from: a card pooled from the literature, one the researcher's own data gave, one somebody assumed", () => {
  const cards = [
    { key: "hazard_ratio", pointValue: 0.65, valueSource: "aggregate", pooling: { k: 4 } },
    { key: "control_median_pfs", pointValue: 9, valueSource: "observed" },
    { key: "dropout_rate", pointValue: 0.12, valueSource: "assumed" },
  ];
  const bound = [{ key: "hazard_ratio", path: "truth.hazardRatio" }, { key: "control_median_pfs", path: "truth.controlMedian" }, { key: "dropout_rate", path: "accrual.dropoutAnnual" }];
  const configuration = { ...SIX_VALUES, accrual: { ...SIX_VALUES.accrual, dropoutAnnual: 0.05 } };
  const rows = byKey(vcrPremises("trial", trialInput({ cards, bound, configuration, appliedDefaults: vcrAppliedDefaults("design.simulate", configuration) })));
  // The card's number is the run's (it wins over what the object typed), and so is its source.
  assert.deepEqual([rows.effect.value, rows.effect.source], ["0.65", "literature"]);
  assert.deepEqual([rows.control.value, rows.control.source], ["9 个月", "given"]);
  assert.deepEqual([rows.dropout.value, rows.dropout.source], ["12%", "assumed"]);
  assert.equal(premiseSourceOfCard({ valueSource: "extracted" }), "literature");
  assert.equal(premiseSourceOfCard({ valueSource: "predicted", pooling: { k: 3 } }), "literature", "pooled evidence stands under it whatever it was labelled");
  assert.equal(premiseSourceOfCard({ valueSource: "imputed" }), "given");
  assert.equal(premiseSourceOfCard(null), "assumed");
});

test("the other endpoints: a binary design states its rates, and says plainly that nobody drops out", () => {
  const binary = { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "binary" }, truth: { controlRate: 0.3, treatmentRate: 0.45 } };
  const rows = byKey(vcrPremises("trial", { endpointType: "binary", configuration: binary, diagnostics: {}, appliedDefaults: vcrAppliedDefaults("design.simulate", binary), hasAssurance: true }));
  assert.deepEqual([rows.effect.label, rows.effect.value], ["真实效应（试验组事件率）", "45%"]);
  assert.deepEqual([rows.control.label, rows.control.value], ["对照组事件率", "30%"]);
  assert.equal(rows.dropout.source, "default");
  assert.match(rows.dropout.value, /不模拟/);
  assert.equal(rows.accrual, undefined, "a binary endpoint has no accrual to state");
  const continuous = byKey(vcrPremises("trial", { endpointType: "continuous", configuration: { design: { kind: "two_arm_fixed", nTreat: 60, nControl: 60 }, endpoint: { type: "continuous" }, truth: { effect: 4 } },
    appliedDefaults: vcrAppliedDefaults("design.simulate", { design: { kind: "two_arm_fixed" }, endpoint: { type: "continuous" }, truth: { effect: 4 } }), hasAssurance: true }));
  assert.deepEqual([continuous.control.label, continuous.control.value, continuous.control.source], ["结局的标准差", "1", "default"]);
});

test("a success probability that is not there says why, in one line, and a design that cannot have one says nothing", () => {
  const absent = byKey(vcrPremises("trial", trialInput({ hasAssurance: false, assuranceReason: "没有算：效应只有一个值，没有可以积分的预测分布" })));
  assert.equal(absent.assurance.label, "成功把握");
  assert.equal(absent.assurance.value, "没有算：效应只有一个值，没有可以积分的预测分布");
  assert.equal(absent.assurance.decisive, false, "a reason is folded with the rest");
  assert.equal(byKey(vcrPremises("trial", trialInput({ hasAssurance: true }))).assurance, undefined);
});

test("the open premises are the first five in order of what a conclusion turns on, and the rest are not decisive", () => {
  const many = ["alpha", "accrual", "dropout", "control", "effect", "correlation", "similarity"].map((key) => ({ key, label: key, value: "1", source: "assumed", decisive: true }));
  const rows = finishPremises([...many, { key: "extra", label: "extra", value: "2", source: "default", decisive: false }]);
  assert.deepEqual(rows.filter((row) => row.decisive).map((row) => row.key), ["effect", "control", "dropout", "correlation", "similarity"]);
  assert.equal(rows.length, 8, "none is dropped: the page folds them");
  assert.deepEqual(rows.filter((row) => !row.decisive).map((row) => row.key).sort(), ["accrual", "alpha", "extra"]);
  // Malformed rows are not premises; a source the page has no word for is an assumption; a key is listed once.
  const messy = finishPremises([{ key: "a", label: "a", value: "", source: "default" }, { key: "b", label: "b", value: "1", source: "no such source", decisive: true }, { key: "b", label: "again", value: "2", source: "given" },
    { label: "no key", value: "1", source: "given" }]);
  assert.deepEqual(messy.map((row) => [row.key, row.source, row.label]), [["b", "assumed", "b"]]);
  assert.deepEqual(vcrPremises("comparator", {}), [], "the comparator's facts come from its own page");
});

test("a population: how its variables relate, how far it is the source trial's, and how far its parameters moved", () => {
  const literature = byKey(vcrPremises("population", { kind: "literature", diagnostics: { correlationVerification: "independence_assumed", columnSources: { age: "aggregate", "(correlation)": "assumed" }, parameterDraws: 1 } }));
  assert.deepEqual([literature.correlation.value, literature.correlation.source, literature.correlation.decisive], ["假设相互独立", "assumed", true]);
  assert.equal(literature.similarity.value, "未验证，只复现来源给出的汇总数");
  assert.equal(literature.sampling.value, "没有重抽：参数按给定值固定");
  assert.equal(literature.sampling.source, "default");
  // A result from before the engine said it still tells by its sources: a matrix has a source row of its own.
  const old = (/** @type {Record<string, string>} */ columnSources) => byKey(vcrPremises("population", { kind: "literature", diagnostics: { correlationVerification: "assumed", columnSources } })).correlation.value;
  assert.equal(old({ age: "aggregate" }), "假设相互独立");
  assert.equal(old({ age: "aggregate", "(correlation)": "assumed" }), "给定的相关矩阵，未经来源核实");
  assert.equal(byKey(vcrPremises("population", { kind: "literature", diagnostics: { correlationVerification: "declared_citation_not_verified_by_engine", columnSources: { "(correlation)": "aggregate" } } })).correlation.value, "引自文献的相关矩阵，引擎不核实");
  // Draws that were taken are reported with the spread they gave.
  const drawn = byKey(vcrPremises("population", { kind: "scenario", diagnostics: { correlationVerification: "assumed", parameterDraws: 20, parameterSpread: [{ variable: "age", parameter: "mean", value: 1.2345 }] } }));
  assert.equal(drawn.sampling.value, "重抽 20 次，age mean 的标准差 1.23");
  assert.equal(drawn.similarity, undefined, "a scenario population is nobody's source trial");
  // A real cohort is its data, not a premise; a result that never said how its variables relate says nothing about it.
  assert.deepEqual(vcrPremises("population", { kind: "real", diagnostics: {} }), []);
  assert.equal(byKey(vcrPremises("population", { kind: "scenario", diagnostics: {} })).correlation, undefined);
});

// --- the pages -------------------------------------------------------------------------------------------------------------------

const NOW = new Date("2026-11-01T12:00:00.000Z");
const emptyBundle = () => ({
  now: NOW, study: { id: "std_1", intendedUse: "exploratory", dataTier: "T0", steps: {}, abilities: [] }, definition: null, results: [], allResults: [], stale: [], reviews: [], jobs: [], budget: null,
  assumptions: [], members: [], exports: [], decisions: [], roles: [], scenarios: [], comparators: [], comparator: null, populations: [], patientSets: [], grid: null, forecasts: [], models: [],
  executions: new Map(), protocol: null, criteria: [], jobMarks: [], currentNodes: new Set(),
});

/** A two-arm survival design as the programme leaves it: the analytic stage, the alternative's simulation, and — maybe — the zero-effect check. */
function designBundle({ withNull = false, jobs = /** @type {any[]} */ ([]) } = {}) {
  const at = "2026-11-01T11:00:00.000Z";
  const scenario = { id: "scn_a", version: 1, label: "A", design: "two_arm_fixed", endpointType: "time_to_event", configuration: SIX_VALUES, assumptionIds: [], resultId: "res_a" };
  const stage = (/** @type {string} */ name, /** @type {any[]} */ measures, /** @type {Record<string, any>} */ diagnostics = {}) => ({
    stage: name, jobId: `job_${name}`, stale: false, measures, diagnostics, conclusion: "estimable" });
  const applied = vcrAppliedDefaults("design.simulate", SIX_VALUES);
  const stageResults = {
    analytic: stage("analytic", [{ name: "required_events", value: 247, source: "calculated" }]),
    simulation: stage("simulation", [{ name: "power", value: 0.9, simulated: true, mcse: 0.004, source: "synthetic" }],
      { appliedDefaults: applied, replicatePlan: { floor: 5000, basis: "default", intendedUse: "exploratory", targetMcse: null }, analyticCheck: { name: "power", value: 0.897, simulated: 0.9, difference: 0.003, mcse: 0.004, withinTolerance: true } }),
    ...(withNull ? { simulation_null: stage("simulation_null", [{ name: "type_one_error", value: 0.0246, simulated: true, mcse: 0.0011, source: "synthetic" }],
      { appliedDefaults: applied, replicatePlan: { floor: 20000, basis: "default", intendedUse: "exploratory", targetMcse: null },
        analyticCheck: { name: "type_one_error", value: 0.025, basis: "nominal_alpha", simulated: 0.0246, difference: -0.0004, mcse: 0.0011, withinThreeMcse: true } }) } : {}),
  };
  const result = { id: "res_a", version: 3, kind: "trial_scenario", subjectId: "scn_a", conclusion: "estimable", reviewState: "ai_set", counts: {}, executionId: "ex_sim", createdAt: at,
    measures: [{ name: "required_events", value: 247, source: "calculated" }, { name: "power", value: 0.9, simulated: true, mcse: 0.004, source: "synthetic" },
      ...(withNull ? [{ name: "type_one_error", value: 0.0246, simulated: true, mcse: 0.0011, source: "synthetic" }] : [])],
    diagnostics: { stageResults, stages: Object.keys(stageResults).map((name) => ({ stage: name })) } };
  const executions = new Map([["ex_sim", { id: "ex_sim", jobId: "job_simulation", method: "design.simulate", seed: 1, replicates: 5000 }],
    ["ex_null", { id: "ex_null", jobId: "job_simulation_null", method: "design.simulate", seed: 1, replicates: 20000 }]]);
  return { ...emptyBundle(), scenarios: [scenario], results: [result], allResults: [result], executions, jobs };
}

const job = (/** @type {string} */ stage, /** @type {string} */ state, /** @type {Record<string, any>} */ over = {}) => ({
  id: `job_${stage}`, state, checkpoint: { subjectId: "scn_a", stage, plannedStages: ["analytic", "simulation", "simulation_null"], bound: [], ...over } });

test("the trial page: the premises of the design a person is looking at, the dropout among them with its default marked", () => {
  const tab = presentTrialTab(designBundle());
  assert.deepEqual(tab.premises.filter((row) => row.decisive).map((row) => row.key), ["effect", "control", "dropout", "accrual", "alpha"]);
  assert.equal(tab.premises.find((row) => row.key === "dropout").source, "default");
  // The data generation says how patients enter and leave, and which of those numbers the platform filled in.
  const data = tab.ademp.find((line) => line.key === "data").text;
  assert.match(data, /入组 18 个月/);
  assert.match(data, /随访 12 个月/);
  assert.match(data, /脱落 0%\/年（默认）/);
  // Nothing in the list is a back-office word.
  assert.doesNotMatch(JSON.stringify(tab.premises), /job_|res_|design\.|appliedDefaults|stageResults/);
});

test("the type I error is measured after the result: queued, then there with its error, held against its closed form where one exists", () => {
  // Before: the alternative has landed, the check is planned; a column waits for it and the cell says where it stands.
  const planned = presentTrialTab(designBundle({ jobs: [job("simulation", "succeeded")] }));
  assert.equal(planned.designs[0].nullState, "queued");
  assert.ok(planned.columns.some((column) => column.key === "type_one_error"), "the column is there while the figure is not");
  assert.equal(planned.designs[0].measures.type_one_error, undefined);
  assert.equal(planned.designs[0].measures.power.value, 90, "and the result is not held back for it");
  assert.equal(presentTrialTab(designBundle({ jobs: [job("simulation_null", "queued"), job("simulation", "succeeded")] })).designs[0].nullState, "queued");
  assert.equal(presentTrialTab(designBundle({ jobs: [job("simulation_null", "running")] })).designs[0].nullState, "running");
  // A check that failed or was cancelled leaves the result as it was and says what happened to it.
  assert.equal(presentTrialTab(designBundle({ jobs: [job("simulation_null", "failed")] })).designs[0].nullState, "failed");
  const cancelled = presentTrialTab(designBundle({ jobs: [job("simulation_null", "canceled")] }));
  assert.equal(cancelled.designs[0].nullState, "canceled");
  assert.equal(cancelled.designs[0].measures.power.value, 90);
  // A design nobody planned a check for (a single-arm design, a model's) has no state to wait in.
  assert.equal(presentTrialTab(designBundle({ jobs: [] })).designs[0].nullState, null);
  // After: the figure, with its Monte-Carlo error, and the closed form it was held against.
  const done = presentTrialTab(designBundle({ withNull: true, jobs: [job("simulation_null", "succeeded")] }));
  const [design] = done.designs;
  assert.equal(design.nullState, "done");
  assert.equal(design.measures.type_one_error.value, 2.46);
  assert.equal(design.measures.type_one_error.mcse, 0.11);
  assert.deepEqual(design.nullCheck, { name: "type_one_error", analytic: 2.5, simulated: 2.5, differencePoints: 0, agrees: true });
  assert.equal(design.measures.power.value, 90, "the alternative's figures are the alternative's");
  // The record says why each stage ran as many replicates as it did.
  assert.deepEqual(design.record.replicateReasons, ["备择情景 5,000 次（备择情景的默认下限 5,000 次）", "零效应情景 20,000 次（零效应情景的默认下限 20,000 次）"]);
  assert.equal(done.ademp.find((line) => line.key === "replicates").text, design.record.replicateReasons.join("；"));
});

test("the replicates of a stage say what set them: the intended use, a borrowing design, a precision asked for", () => {
  const bundle = designBundle({ withNull: true });
  const plan = bundle.allResults[0].diagnostics.stageResults.simulation_null.diagnostics;
  for (const [replicatePlan, text] of /** @type {Array<[Record<string, any>, RegExp]>} */ ([
    [{ floor: 100000, basis: "intended_use", intendedUse: "specified_analysis" }, /指定研究分析.*零效应情景至少 100,000 次/],
    [{ floor: 100000, basis: "borrowing", intendedUse: "exploratory" }, /借用外部数据的设计，零效应情景至少 100,000 次/],
    [{ floor: 152344, basis: "target_mcse", targetMcse: 0.0004 }, /按要求的蒙特卡洛误差 0.0004 需要 152,344 次/],
  ])) {
    plan.replicatePlan = replicatePlan;
    assert.match(presentTrialTab(bundle).designs[0].record.replicateReasons[1], text);
  }
});

test("the data columns of a design: the bias and the coverage appear when the engine computed them", () => {
  const bundle = designBundle();
  const simulation = bundle.allResults[0].diagnostics.stageResults.simulation;
  simulation.measures.push({ name: "bias", value: 0.002, simulated: true, mcse: 0.001, source: "synthetic" }, { name: "coverage", value: 0.951, simulated: true, mcse: 0.003, source: "synthetic" });
  const tab = presentTrialTab(bundle);
  assert.deepEqual(tab.columns.map((column) => column.key).filter((key) => ["bias", "coverage"].includes(key)), ["bias", "coverage"]);
  assert.equal(tab.designs[0].measures.coverage.value, 95.1);
  assert.equal(tab.designs[0].measures.coverage.mcse, 0.3);
  assert.equal(presentTrialTab(designBundle()).columns.some((column) => column.key === "bias"), false, "and not before");
});

test("the population page and the comparator page carry the same block", () => {
  const population = { id: "pop_1", version: 1, kind: "literature", resultId: "res_pop", counts: {}, definition: {}, quality: {}, profile: {}, waterfall: [] };
  const result = { id: "res_pop", version: 1, kind: "population", conclusion: "estimable", counts: {}, measures: [], createdAt: "2026-11-01T11:00:00.000Z",
    diagnostics: { correlationVerification: "independence_assumed", columnSources: { age: "aggregate", "(correlation)": "assumed" }, parameterDraws: 1 } };
  const tab = presentPopulationTab({ ...emptyBundle(), populations: [population], results: [result], allResults: [result] });
  assert.deepEqual(tab.premises.map((row) => row.key), ["correlation", "similarity", "sampling"]);
  assert.equal(tab.premises[0].value, "假设相互独立");
  assert.deepEqual(presentPopulationTab({ ...emptyBundle(), populations: [{ ...population, kind: "real" }], results: [result], allResults: [result] }).premises, []);
  assert.deepEqual(presentComparatorTab(emptyBundle()).premises, []);
});

test("a MAP prior's operating characteristics are drawn from the result, with the floor they ran at and what set it", () => {
  const comparator = { id: "cmp_1", version: 1, route: "hybrid_control", resultId: "res_cmp", conclusion: "estimable", gapList: [], createdAt: "2026-11-01T11:00:00.000Z", configuration: {} };
  const rows = [
    { drift: 0, prior: "none", scenario: "null", rejection: 0.0239, mcse: 0.00108, replicates: 100000 },
    { drift: 0, prior: "robust_0.2", scenario: "null", rejection: 0.0139, mcse: 0.00083, replicates: 100000 },
    { drift: 0.5, prior: "robust_0.2", scenario: "alternative", rejection: 0.5821, mcse: 0.00156, replicates: 100000 },
  ];
  const result = { id: "res_cmp", version: 1, kind: "comparator", conclusion: "estimable", counts: {}, measures: [], createdAt: "2026-11-01T11:00:00.000Z",
    diagnostics: { replicatePlan: { floor: 100000, basis: "borrowing", intendedUse: "exploratory", targetMcse: null }, operatingCharacteristics: { replicates: 100000, asked: 100000, capped: false, rows } } };
  const tab = presentComparatorTab({ ...emptyBundle(), comparators: [comparator], comparator, results: [result], allResults: [result] });
  const oc = tab.operatingCharacteristics;
  assert.equal(oc.rows.length, 3);
  assert.deepEqual(oc.rows[0], { drift: 0, prior: "none", priorLabel: "不借用（只用本研究对照）", scenario: "null", rejection: 2.39, mcse: 0.11, replicates: 100000 });
  assert.equal(oc.rows[1].priorLabel, "借用（稳健权重 0.2）");
  assert.equal(oc.reason, "借用历史数据的设计，零效应的各行至少 100,000 次");
  assert.equal(oc.capped, false);
  // A table the engine's ceiling held below what was asked says so.
  result.diagnostics.operatingCharacteristics = { replicates: 600, asked: 5000, capped: true, rows: rows.map((row) => ({ ...row, replicates: 600 })) };
  const capped = presentComparatorTab({ ...emptyBundle(), comparators: [comparator], comparator, results: [result], allResults: [result] }).operatingCharacteristics;
  assert.deepEqual([capped.capped, capped.replicates, capped.asked], [true, 600, 5000]);
  assert.equal(presentComparatorTab(emptyBundle()).operatingCharacteristics, null);
});

test("a reconstruction says what the paper gave it, lists the checks it could not hold and delivers the curves at every level", () => {
  const comparator = { id: "cmp_2", version: 1, route: "literature_control", resultId: "res_rec", conclusion: "limited", gapList: [], createdAt: "2026-11-01T11:00:00.000Z", configuration: {} };
  const diagnostics = {
    informationLevel: { level: 4, key: "curve_only", arms: [{ name: "control", key: "curve_only" }, { name: "treatment", key: "events_only" }] },
    hazardRatio: { status: "not_estimable", reason: "risk_table_and_total_events_missing" },
    qualityControl: [
      { checks: { atRisk: { name: "numbers at risk", status: "not_reported", pass: null }, events: { name: "total events", status: "not_reported", pass: null }, median: { name: "median survival", reported: 12, reconstructed: 12.2, pass: true } } },
      { checks: { atRisk: { name: "numbers at risk", status: "not_reported", pass: null }, events: { name: "total events", reported: 130, reconstructed: 131, pass: true } } },
    ],
  };
  const result = { id: "res_rec", version: 1, kind: "comparator", conclusion: "limited", counts: {}, measures: [], createdAt: "2026-11-01T11:00:00.000Z", diagnostics };
  const tab = presentComparatorTab({ ...emptyBundle(), comparators: [comparator], comparator, results: [result], allResults: [result] });
  assert.equal(tab.reconstruction.key, "curve_only");
  assert.equal(tab.reconstruction.limited, true);
  assert.equal(tab.reconstruction.hazardRatio, "风险比不可估计：没有风险人数表，也没有总事件数");
  assert.deepEqual(tab.reconstruction.arms, [{ name: "对照组", label: "论文只给了曲线和起始人数" }, { name: "试验组", label: "论文只给了总事件数（没有风险人数表）" }]);
  const unchecked = tab.qc.filter((row) => row.notChecked);
  assert.deepEqual(unchecked.map((row) => row.key), ["atRisk_control", "events_control", "atRisk_treatment"]);
  assert.ok(unchecked.every((row) => row.passed === false && /没有核对/.test(row.value)));
  assert.equal(tab.qc.filter((row) => row.passed).length, 2, "what was held and passed is counted; what was not held is not");
});
