// 「虚拟临研」's program rules without a database: what a program wants, which
// job a research object needs, the dispatch tag a run carries, and the five
// notices — their kinds, their titles and who hears them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  VCR_ACCRUAL_TOLERANCE, VCR_ANALYSIS_STEPS, VCR_ASSUMPTION_BINDINGS, VCR_RUN_CAPABILITIES, vcrAssumptionConflicts, vcrBindAssumptions,
  vcrBuildStages, vcrDesignPriorFrom, vcrDispatchId, vcrGapsForRule, vcrJobKindFor, vcrModelApplicabilityIssues, vcrPopulationVariables,
  vcrProgramSteps, vcrProjectScenario, vcrRunId, vcrRunPrompt, vcrSupersededNodes, wantedVcrSteps,
} from "../src/vcrOrchestrator.mjs";
import { VCR_NOTICE_KINDS, createVcrNotifier, vcrNoticeHref, vcrStudyName } from "../src/vcrNotify.mjs";
import {
  VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_NOTIFICATION_KINDS, VCR_NOT_ESTIMABLE_RULES, VCR_SCENARIO_SCHEMAS, VCR_STEPS, VCR_STEP_CAPABILITIES,
  VCR_STEP_NEEDS, validateEngineJob, validateScenario,
} from "@evimed/domain";

/** @param {string[]} requested */
const steps = (requested) => Object.fromEntries(VCR_STEPS.map((step) => [step, { status: "none", requested: requested.includes(step) }]));

test("a full program wants every step; a single step wants its upstream as a minimal version", () => {
  const full = wantedVcrSteps(steps([...VCR_STEPS]));
  assert.equal(full.full, true);
  assert.deepEqual([...full.want].sort(), [...VCR_STEPS].sort());
  assert.equal(full.fidelity("trial"), "full");

  // 「这个单臂试验能不能用外部对照？」 — one step, and the definition under it,
  //补出来的部分标「AI 设定」 (plan §4).
  const comparator = wantedVcrSteps(steps(["comparator"]));
  assert.deepEqual([...comparator.want].sort(), ["comparator", "definition"]);
  assert.equal(comparator.fidelity("definition"), "minimal");
  assert.equal(comparator.fidelity("comparator"), "full");

  // 「这 300 个患者里谁可能符合这个方案？」
  assert.deepEqual([...wantedVcrSteps(steps(["matching"])).want].sort(), ["definition", "matching"]);
  // Virtual patients need a population, which needs a definition.
  assert.deepEqual([...wantedVcrSteps(steps(["patients"])).want].sort(), ["definition", "patients", "population"]);
  // Nothing asked, nothing wanted.
  assert.equal(wantedVcrSteps(steps([])).want.size, 0);
  // The closure is the domain's table, not a second copy.
  assert.deepEqual([...VCR_STEP_NEEDS.patients], ["population"]);
});

test("a study whose definition exists and which nobody asked anything of runs the whole programme", () => {
  const idle = vcrProgramSteps(steps([]));
  assert.equal(VCR_STEPS.every((step) => idle[step].requested === false), true, "nothing exists yet, nothing is wanted");

  const defined = vcrProgramSteps({ ...steps([]), definition: { status: "done", requested: false } });
  assert.equal(VCR_STEPS.every((step) => defined[step].requested), true, "一句话到研究包 is the default path");

  // A step a run left queued counts as requested, so a restart picks it up.
  const queued = vcrProgramSteps({ ...steps([]), trial: { status: "queued", requested: false } });
  assert.equal(queued.trial.requested, true);
});

test("which engine job a research object needs is deterministic, and is the one the engine runs for that method", () => {
  assert.equal(vcrJobKindFor("population", { kind: "real" }), "build_cohort");
  assert.equal(vcrJobKindFor("population", { kind: "empirical_synthetic" }), "synthesize_population");
  assert.equal(vcrJobKindFor("population", { kind: "literature" }), "literature_population");
  assert.equal(vcrJobKindFor("population", { kind: "scenario" }), "generate_population");
  // The patient generator follows the endpoint the scenario (or, failing that, the study definition) states.
  assert.equal(vcrJobKindFor("patient_set", { scenario: { endpoint: { type: "binary" } } }), "generate_patients_binary");
  assert.equal(vcrJobKindFor("patient_set", { scenario: { endpoint: { type: "continuous" } } }), "generate_patients_continuous");
  assert.equal(vcrJobKindFor("patient_set", { scenario: {} }, { definition: { endpointType: "time_to_event" } }), "generate_patients");
  assert.equal(vcrJobKindFor("patient_set", {}), "generate_patients");
  // The comparator routes, each to its own method — no route is wired to a method that only resembles it.
  assert.equal(vcrJobKindFor("comparator", { route: "external_control" }), "weight_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "external_control", estimand: "ATE" }), "propensity_weight_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "external_control", configuration: { method: "propensity" } }), "propensity_weight_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "prognostic_adjustment" }), "procova");
  assert.equal(vcrJobKindFor("comparator", { route: "literature_control" }), "reconstruct_km",
    "a literature control has no rows to read; it rebuilds the published curve, and RMST follows on the pseudo-patients");
  assert.equal(vcrJobKindFor("comparator", { route: "literature_control", configuration: { method: "maic" } }), "maic_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "hybrid_control" }), "map_prior");
  assert.equal(vcrJobKindFor("comparator", { route: "model_comparator" }), null, "the route the engine cannot honestly compute is not wired to another method");
  assert.equal(vcrJobKindFor("trial_scenario", {}), "design_simulation");
  assert.equal(vcrJobKindFor("trial_scenario", { configuration: { analytic: true } }), "design_analytic");
  assert.equal(vcrJobKindFor("design_grid", {}), "design_grid");
  // A configuration may name a method, but only one of the trial methods.
  assert.equal(vcrJobKindFor("trial_scenario", { configuration: { jobKind: "assurance" } }), "assurance");
  assert.equal(vcrJobKindFor("trial_scenario", { configuration: { jobKind: "make_it_up" } }), "design_simulation");
  assert.equal(vcrJobKindFor("trial_scenario", { configuration: { jobKind: "rmst" } }), "design_simulation");
  for (const kind of VCR_JOB_KINDS) assert.ok(VCR_JOB_METHODS[kind], `${kind} has a method`);
});

test("each step's capability is the domain's map, and the four analysis steps share one run", () => {
  assert.equal(VCR_RUN_CAPABILITIES, VCR_STEP_CAPABILITIES, "one map, not a second copy");
  assert.deepEqual([...VCR_ANALYSIS_STEPS], ["population", "patients", "comparator", "trial"]);
  assert.equal(new Set(VCR_ANALYSIS_STEPS.map((step) => VCR_STEP_CAPABILITIES[step])).size, 1, "all four are vcr-analysis");
  assert.equal(VCR_STEP_CAPABILITIES.definition, "vcr-protocol");
  assert.equal(VCR_STEP_CAPABILITIES.evidence, "vcr-evidence");
  assert.equal(VCR_STEP_CAPABILITIES.matching, "vcr-matching");
});

test("a dispatch id is one token, and the prompt carries it as a literal tag", () => {
  assert.equal(vcrDispatchId("run:analysis", 1), "vcr-run-analysis-1");
  assert.equal(vcrDispatchId("run:export:exp_1", 2), "vcr-run-export-exp_1-2");
  assert.equal(vcrRunId("vcr-run analysis/1"), "vcr-run-analysis-1");
  assert.match(vcrRunPrompt("做一下试验设计。", "vcr-run-analysis-1"),
    /^做一下试验设计。\n\n<evimed-vcr-run>vcr-run-analysis-1<\/evimed-vcr-run>$/);
  assert.ok(vcrDispatchId("run:analysis", 1).startsWith("vcr-"), "the ledger finds this module's runs by prefix");
});

test("there are exactly five notices, and they are the domain's five", () => {
  assert.equal(VCR_NOTICE_KINDS, VCR_NOTIFICATION_KINDS);
  assert.deepEqual([...VCR_NOTICE_KINDS],
    ["package_ready", "not_estimable", "budget_confirm", "new_candidates", "accrual_off_forecast"]);
});

test("a notice opens the page it is about", () => {
  assert.equal(vcrNoticeHref("std_1/overview"), "/app/virtual-research/std_1/overview");
  // The page route is `/app/virtual-research/:studyId/:tab?`: one segment after the study, and nothing deeper is a page.
  assert.equal(vcrNoticeHref("std_1/matching/ref_1"), null);
  assert.equal(vcrNoticeHref("../etc/passwd"), null);
  assert.equal(vcrNoticeHref(""), null);
});

/** @param {Record<string, any>} [overrides] */
function notifierFixture(overrides = {}) {
  /** @type {any[]} */
  const sent = [];
  const notifications = { async create(userId, input) { sent.push({ userId, ...input }); return { id: `n_${sent.length}` }; } };
  const store = { async members() { return overrides.members ?? [{ userId: "u1", role: "lead" }]; } };
  return { sent, notifier: createVcrNotifier({ notifications, store, config: {} }) };
}

const study = { id: "std_1", userId: "u1", projectId: "prj_1", name: "EV-201 二线 NSCLC" };

test("each notice states the fact, in the study's own words, keyed by its own event", async () => {
  const { sent, notifier } = notifierFixture();
  await notifier.packageReady(study, { exportId: "exp_1", headline: "方案 B 成功把握 71%，高于方案 A", gaps: 3 });
  await notifier.notEstimable(study, { resultId: "res_1", rule: "effective_sample_size_below_floor", what: "对照分析",
    gaps: ["同期治疗数据"] });
  await notifier.budgetConfirm(study, { id: "job_1", cpuSecondsLimit: 1_800 });
  await notifier.accrualOffForecast(study, { forecastId: "fct_1", predicted: 120, actual: 84, byMonth: "2027-03" });

  assert.deepEqual(sent.map((item) => item.idempotencyKey), [
    "vcr:std_1:package:study_package:exp_1:u1",
    "vcr:std_1:not-estimable:res_1:u1",
    "vcr:std_1:budget:job_1:u1",
    "vcr:std_1:accrual:fct_1:u1",
  ]);
  assert.match(sent[0].title, /^EV-201 二线 NSCLC：研究包完成$/);
  assert.match(sent[0].body, /方案 B 成功把握 71%，高于方案 A；还有 3 项缺口/);
  assert.match(sent[1].title, /对照分析判定为不可估计/);
  assert.match(sent[1].body, /有效样本量低于下限/);
  assert.match(sent[1].body, /缺：同期治疗数据/);
  assert.match(sent[2].body, /约 30 分钟机时/);
  assert.match(sent[3].body, /预测 120 例，实际 84 例/);
  assert.deepEqual(sent.map((item) => item.severity), ["info", "attention", "attention", "attention"]);
  for (const item of sent) {
    assert.equal(item.source.type, "vcr");
    assert.match(item.source.id, /^std_1\//);
    assert.equal(item.projectId, "prj_1");
  }
});

test("new candidates go to the coordinators and the lead, not to the statistician", async () => {
  const { sent, notifier } = notifierFixture({
    members: [
      { userId: "lead", role: "lead" },
      { userId: "coordinator", role: "recruiter" },
      { userId: "site", role: "site" },
      { userId: "statistician", role: "statistical_reviewer" },
      { userId: "viewer", role: "viewer" },
    ],
  });
  await notifier.newCandidates(study, { batchKey: "2026-09-28", candidates: 12, needsEvidence: 4 });
  assert.deepEqual(sent.map((item) => item.userId).sort(), ["coordinator", "lead", "site"]);
  assert.match(sent[0].title, /有 12 位新的匹配候选，其中 4 人还缺证据/);
  assert.match(sent[0].body, /联系之前需要协调员逐人确认/);
  // One event, many readers: the key carries the reader so the inbox does not
  // fold a coordinator's copy into the lead's.
  assert.equal(new Set(sent.map((item) => item.idempotencyKey)).size, 3);
});

test("with no coordinator named, the owner hears it: a notice nobody gets did not happen", async () => {
  const { sent, notifier } = notifierFixture({ members: [{ userId: "statistician", role: "statistical_reviewer" }] });
  await notifier.newCandidates(study, { batchKey: "2026-09-28", candidates: 3 });
  assert.deepEqual(sent.map((item) => item.userId), ["u1"]);
});

test("an inbox that is down is counted and does not stop a tick; a replay is taken as already sent", async () => {
  /** @type {any[]} */
  const audits = [];
  const down = createVcrNotifier({
    notifications: { async create() { const error = new Error("inbox down"); /** @type {any} */ (error).code = "notification_unavailable"; throw error; } },
    store: { async members() { return []; } }, audit: (...args) => audits.push(args),
  });
  assert.equal(await down.packageReady(study, { exportId: "exp_1" }), null);
  assert.equal(down.counts.failed, 1);
  assert.equal(audits[0][0], "vcr.notice");

  const replayed = createVcrNotifier({
    notifications: { async create() { const error = new Error("already"); /** @type {any} */ (error).code = "notification_idempotency_conflict"; throw error; } },
    store: { async members() { return []; } },
  });
  assert.equal(await replayed.packageReady(study, { exportId: "exp_1" }), true, "a replay is a send that happened");
  assert.equal(replayed.counts.failed, 0);

  const unwired = createVcrNotifier({ notifications: null, store: { async members() { return []; } } });
  assert.equal(await unwired.packageReady(study, { exportId: "exp_1" }), null);
  assert.equal(unwired.counts.skipped, 1);
  assert.deepEqual(unwired.status(), { wired: false, counts: unwired.counts, kinds: [...VCR_NOTICE_KINDS] });
});

test("a study with no name is still named in a notice", () => {
  assert.equal(vcrStudyName({ name: "", question: "单臂 II 期能不能用外部对照" }), "单臂 II 期能不能用外部对照");
  assert.equal(vcrStudyName({}), "虚拟临研研究");
  assert.equal(vcrStudyName({ name: "x".repeat(50) }).length, 30, "a title never runs away");
});

test("the accrual tolerance is a number with a reason, and a study may set its own", () => {
  assert.equal(VCR_ACCRUAL_TOLERANCE, 0.2);
});


// --- scenarios: what the engine is told, built from the objects -----------------------------------

const cards = [
  { key: "hazard_ratio", version: 2, pointValue: 0.7,
    distribution: { family: "lognormal", params: { meanlog: Math.log(0.7), sdlog: 0.15 }, range: { kind: "prediction", low: 0.52, high: 0.94 } } },
  { key: "control_median_pfs", version: 1, pointValue: 6 },
  { key: "dropout_rate", version: 3, pointValue: 0.1 },
];
const seedStudy = { id: "std_1", userId: "u1", dataTier: "T0", intendedUse: "design_support" };
const definition = { id: "def_1", version: 1, endpointType: "time_to_event" };
const context = { study: seedStudy, definition, assumptions: cards, populations: [], scenarios: [], grid: null, analytic: null,
  models: [{ id: "mdl_reference", name: "reference-time-to-event", version: "1.0.0", endpointType: "time_to_event", applicability: { endpoints: ["time_to_event"] }, card: {} }] };

/** @param {Record<string, any>} configuration @param {Record<string, any>} [row] */
const trialRow = (configuration, row = {}) => ({ id: "scn_1", version: 1, label: "A", design: "two_arm_fixed", endpointType: "time_to_event",
  assumptionIds: [], configuration, ...row });

test("a scenario is the object projected onto the schema of the method that runs it — and what the schema does not read is named, not ignored", () => {
  const candidate = {
    design: { kind: "two_arm_fixed", nTreat: 120, nControl: 60, allocation: 0.6667 }, endpoint: { type: "time_to_event" },
    truth: { hazardRatio: 0.7, controlMedian: 6 }, analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 },
    accrual: { kind: "uniform", duration: 12, followup: 12, dropoutRate: 0.1 }, performance: ["power"], nonsense: 1,
  };
  const simulate = vcrProjectScenario("design.simulate", candidate);
  assert.deepEqual(simulate.dropped.sort(), ["accrual.dropoutRate", "analysis.power", "design.allocation", "nonsense"],
    "the analytic keys are not the simulation's, and a misspelt dropout is named");
  assert.equal(simulate.scenario.design.nTreat, 120);
  assert.equal(simulate.scenario.accrual.dropoutRate, undefined);
  const analytic = vcrProjectScenario("design.analytic", candidate);
  assert.ok(analytic.dropped.includes("design.nTreat") && analytic.dropped.includes("analysis.method"));
  assert.equal(analytic.scenario.analysis.power, 0.9);
  assert.equal(analytic.scenario.design.allocation, 0.6667);
  // A null is not a value in the protocol: the key is left out.
  assert.deepEqual(vcrProjectScenario("design.simulate", { ...candidate, truth: { ...candidate.truth, null: null } }).scenario.truth, candidate.truth);
});

test("an assumption card's point value is the number the scenario uses, and a new version of the card is a different scenario", () => {
  const candidate = { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.9 }, accrual: { duration: 12 } };
  const bound = vcrBindAssumptions(candidate, cards, "time_to_event");
  assert.deepEqual(bound.map((entry) => `${entry.key}@${entry.version}:${entry.path}`),
    ["hazard_ratio@2:truth.hazardRatio", "control_median_pfs@1:truth.controlMedian", "dropout_rate@3:accrual.dropoutAnnual"]);
  assert.equal(candidate.truth.hazardRatio, 0.7, "the card wins over what the object typed for the same parameter");
  assert.equal(candidate.accrual.dropoutAnnual, 0.1);
  // A card for another endpoint's parameter binds nothing; a binary card replaces the whole exclusive group.
  assert.deepEqual(vcrBindAssumptions({ truth: {} }, [{ key: "hazard_ratio", version: 1, pointValue: 0.7 }], "binary"), []);
  const binary = { truth: { controlRate: 0.3, oddsRatio: 2 } };
  vcrBindAssumptions(binary, [{ key: "risk_difference", version: 1, pointValue: 0.1 }], "binary");
  assert.deepEqual(binary.truth, { controlRate: 0.3, riskDifference: 0.1 });
  assert.ok(VCR_ASSUMPTION_BINDINGS.every((binding) => Object.isFrozen(binding) || Object.isFrozen(VCR_ASSUMPTION_BINDINGS)));
  // The card's number reaches the stage's scenario, and a different version of the card is a different scenario.
  const row = trialRow({ design: { nTreat: 120, nControl: 60 }, analysis: { method: "logrank", alpha: 0.025 }, accrual: { kind: "uniform", duration: 12, followup: 12 } });
  const first = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row }, context));
  assert.equal(first.ok, true);
  const simulation = first.stages.find((entry) => entry.stage === "simulation");
  assert.equal(simulation.scenario.truth.hazardRatio, 0.7);
  assert.equal(simulation.scenario.accrual.dropoutAnnual, 0.1);
  const later = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row }, { ...context,
    assumptions: cards.map((card) => (card.key === "dropout_rate" ? { ...card, version: 4, pointValue: 0.15 } : card)) }));
  assert.equal(later.stages.find((entry) => entry.stage === "simulation").scenario.accrual.dropoutAnnual, 0.15);
  assert.equal(row.configuration.accrual.dropoutAnnual, undefined, "the object itself is never edited");
});

test("a trial scenario is an analytic stage, a simulation stage and — when the effect card states a prediction distribution — assurance", () => {
  const row = trialRow({ design: { nTreat: 120, nControl: 60 }, analysis: { method: "logrank", alpha: 0.025 }, accrual: { kind: "uniform", duration: 12, followup: 12 } });
  const plan = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row }, context));
  // The assurance stage needs the events the analytic calculation says the design needs: it is planned once that result exists.
  assert.deepEqual(plan.stages.map((entry) => entry.jobKind), ["design_analytic", "design_simulation"]);
  const withEvents = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row }, { ...context, analytic: { measures: [{ name: "required_events", value: 246.2 }] } }));
  assert.deepEqual(withEvents.stages.map((entry) => `${entry.stage}:${entry.jobKind}`), ["analytic:design_analytic", "simulation:design_simulation", "assurance:assurance"]);
  const assurance = withEvents.stages[2];
  assert.equal(assurance.after, "analytic");
  assert.deepEqual(assurance.scenario.designPrior, { mean: Math.log(0.7), sd: 0.15, kind: "lognormal", basis: "prediction" });
  assert.equal(assurance.scenario.design.events, 247);
  for (const entry of withEvents.stages) {
    assert.deepEqual(validateScenario(VCR_JOB_METHODS[entry.jobKind], entry.scenario), [], `${entry.jobKind}: ${JSON.stringify(validateScenario(VCR_JOB_METHODS[entry.jobKind], entry.scenario))}`);
  }
  // A prior built from a confidence interval understates the spread of a new trial, and a point value has none: no assurance.
  assert.equal(vcrDesignPriorFrom([{ ...cards[0], pooling: { basis: "confidence" } }], "time_to_event"), null);
  assert.equal(vcrDesignPriorFrom([{ key: "hazard_ratio", version: 1, pointValue: 0.7, distribution: { family: "point", params: { point: 0.7 } } }], "time_to_event"), null);
  assert.deepEqual(vcrDesignPriorFrom([{ key: "mean_difference", version: 1, pointValue: 2, distribution: { kind: "normal", mean: 2, sd: 0.5 } }], "continuous")?.prior,
    { mean: 2, sd: 0.5, kind: "normal", basis: "prediction" }, "the flat shape an earlier run wrote is read too");
});

test("a design the engine does not implement is said in a sentence and never run as something else; a key it does not read is refused by its path", () => {
  const single = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({ design: { nTreat: 80 } }, { design: "single_arm_external" }) }, context));
  assert.equal(single.ok, false);
  assert.equal(single.unavailable.reason, "design_not_supported");
  assert.match(single.unavailable.gaps[0].title, /single_arm_external/);
  // Simon search is analytic until a stored result selects frozen boundaries.
  const simon = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({ truth: { nullRate: 0.1, alternativeRate: 0.3 }, analysis: { alpha: 0.05, power: 0.8 } },
    { design: "simon_two_stage", endpointType: "binary" }) }, context));
  assert.equal(simon.ok, true);
  assert.deepEqual(simon.stages.filter((entry) => !entry.detail.awaitingAnalytic).map((entry) => entry.jobKind), ["design_analytic"]);
  const typo = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({ accrual: { kind: "uniform", duration: 12, followup: 12, dropoutRate: 0.1 } }) }, context));
  assert.equal(typo.ok, false);
  assert.deepEqual(typo.refused.paths, ["accrual.dropoutRate"]);
  assert.match(typo.refused.message, /accrual\.dropoutRate/);
  // The old spelling of the null case is refused the same way, not translated.
  const legacy = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({ truth: { isNull: true } }) }, context));
  assert.deepEqual(legacy.refused.paths, ["truth.isNull"]);
  // The words a page shows an object by are the only keys allowed to go without a word.
  const shown = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({ cost: 180, notes: "x", design: { nTreat: 10, nControl: 10 } }) }, context));
  assert.equal(shown.ok, true);
});

test("Simon simulation freezes the selected analytic result and both declared null/alternative laws", () => {
  const row = trialRow({ simonSelection: "minimax", design: { maxN: 35 }, truth: { nullRate: 0.1, alternativeRate: 0.3 },
    analysis: { alpha: 0.05, power: 0.8, sided: 1 }, performance: ["power", "expected_sample_size"] }, { design: "simon_two_stage", endpointType: "binary" });
  const analytic = { id: "res_simon", version: 1, executionId: "exe_simon", diagnostics: {
    simon: { optimal: { n1: 10, n: 29, r1: 1, r: 5 }, minimax: { n1: 15, n: 25, r1: 1, r: 5 } },
  } };
  const analyticJob = { id: "job_simon", methodVersion: "1.1.0", scenarioHash: "a".repeat(64) };
  const plan = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row }, { ...context, analytic, analyticJob }));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.stages.map((stage) => stage.stage), ["analytic", "simulation_null", "simulation"]);
  for (const stage of plan.stages.slice(1)) {
    assert.deepEqual(stage.scenario.design, { kind: "simon_two_stage", n1: 15, n: 25, r1: 1, r: 5 });
    assert.equal(stage.after, "analytic");
    assert.deepEqual(stage.detail.analyticSource, { resultId: "res_simon", resultVersion: 1, executionId: "exe_simon",
      jobId: "job_simon", methodVersion: "1.1.0", scenarioHash: "a".repeat(64), selection: "minimax" });
  }
  assert.deepEqual(plan.stages.slice(1).map((stage) => stage.scenario.truth.responseRate), [0.1, 0.3]);
  const incomplete = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row }, { ...context, analytic }));
  assert.deepEqual(incomplete.stages.filter((stage) => !stage.detail.awaitingAnalytic).map((stage) => stage.stage), ["analytic"], "unbound numbers never enter a simulation");
  const explicit = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({
    design: { n1: 10, n: 29, r1: 1, r: 5 }, truth: { nullRate: 0.1, alternativeRate: 0.3, responseRate: 0.3 },
    analysis: { alpha: 0.05, sided: 1 },
  }, { design: "simon_two_stage", endpointType: "binary" }) }, context));
  assert.equal(explicit.ok, true);
  assert.equal(explicit.stages.length, 1);
  assert.equal(explicit.stages[0].after, null, "a declared fixed rule is simulated, never replaced by a search");
});

test("each comparator route becomes the jobs the engine runs for it; a route the tier cannot reach is a derived verdict, not a job", () => {
  const literature = /** @type {any} */ (vcrBuildStages({ kind: "comparator", row: { id: "cmp_1", version: 1, route: "literature_control", estimand: "ATT", configuration: {
    curve: [{ time: 0, surv: 1 }, { time: 12, surv: 0.5 }, { time: 24, surv: 0.25 }], riskTable: [{ time: 0, atRisk: 200 }, { time: 12, atRisk: 100 }],
    provenance: { kind: "digitizer", tool: "WebPlotDigitizer" }, treatmentArm: { curve: [{ time: 0, surv: 1 }, { time: 24, surv: 0.5 }], riskTable: [{ time: 0, atRisk: 200 }, { time: 24, atRisk: 100 }] },
    tau: 18, timeUnit: "months", comparability: [] } } }, context));
  assert.equal(literature.ok, true, JSON.stringify(literature));
  assert.deepEqual(literature.stages.map((entry) => `${entry.stage}:${entry.jobKind}`), ["reconstruct:reconstruct_km", "rmst:rmst"]);
  assert.deepEqual(literature.stages[1].derived, [{ from: "stage", stage: "reconstruct", table: "reconstructed-ipd" }]);
  assert.equal(literature.stages[1].after, "reconstruct");
  assert.equal(literature.stages[1].snapshot, false, "the pseudo-patients are the control plane's own file, not a granted snapshot");
  assert.equal(literature.stages[1].scenario.tau, 18);
  assert.equal(literature.stages[0].scenario.tau, undefined);
  // One arm is a benchmark, not a comparison: no RMST stage.
  const oneArm = /** @type {any} */ (vcrBuildStages({ kind: "comparator", row: { id: "cmp_1", version: 1, route: "literature_control", configuration: {
    curve: [{ time: 0, surv: 1 }, { time: 24, surv: 0.5 }], riskTable: [{ time: 0, atRisk: 200 }, { time: 24, atRisk: 100 }], provenance: { kind: "human_click", tool: "manual" } } } }, context));
  assert.deepEqual(oneArm.stages.map((entry) => entry.jobKind), ["reconstruct_km"]);

  const t0External = /** @type {any} */ (vcrBuildStages({ kind: "comparator", row: { id: "cmp_2", version: 1, route: "external_control", configuration: {} } }, context));
  assert.equal(t0External.ok, false);
  assert.equal(t0External.unavailable.rule, "data_tier_insufficient");
  assert.match(t0External.unavailable.gaps[0].detail, /T0/);
  assert.match(t0External.unavailable.gaps[0].detail, /T2/);
  const model = /** @type {any} */ (vcrBuildStages({ kind: "comparator", row: { id: "cmp_3", version: 1, route: "model_comparator", configuration: {} } }, context));
  assert.equal(model.unavailable.reason, "model_comparator_unavailable");
  assert.ok(model.unavailable.gaps[0].detail.length > 30, "and it says why");

  const t2 = { ...context, study: { ...seedStudy, dataTier: "T2" } };
  const external = /** @type {any} */ (vcrBuildStages({ kind: "comparator", row: { id: "cmp_2", version: 1, route: "external_control", estimand: "ATT",
    configuration: { covariates: ["age", "ecog"], tau: 12, parameterCode: "OS", snapshotId: "snp_1", comparability: [], e10: [] } } }, t2));
  assert.equal(external.ok, true, JSON.stringify(external));
  assert.equal(external.stages[0].jobKind, "weight_comparator");
  assert.equal(external.stages[0].snapshot, true);
  assert.equal(external.stages[0].scenario.estimand, "ATT");
  assert.deepEqual(external.stages[0].scenario.endpoint, { type: "time_to_event" });
  assert.equal(external.stages[0].scenario.snapshotId, undefined, "the snapshot is named as an input, never as a scenario key");
  const t3 = { ...context, study: { ...seedStudy, dataTier: "T3" } };
  const prognostic = /** @type {any} */ (vcrBuildStages({ kind: "comparator", row: { id: "cmp_4", version: 1, route: "prognostic_adjustment", configuration: {
    endpoint: { type: "continuous" }, truth: { effect: 3, sd: 8 }, analysis: { alpha: 0.025, power: 0.9, sided: 1 }, prognostic: { rho: 0.5 } } } }, t3));
  assert.equal(prognostic.stages[0].jobKind, "procova");
  assert.equal(prognostic.stages[0].snapshot, false, "a sample-size calculator reads no rows");
  const hybrid = /** @type {any} */ (vcrBuildStages({ kind: "comparator", row: { id: "cmp_5", version: 1, route: "hybrid_control", configuration: {
    historical: { events: [12, 15], n: [40, 50] }, tauPrior: { kind: "half_normal", scale: 0.5 } } } }, context));
  assert.equal(hybrid.stages[0].jobKind, "map_prior");
});

test("populations, patient sets and grids are built as their own schemas, and a patient set waits for the population it stands on", () => {
  const population = /** @type {any} */ (vcrBuildStages({ kind: "population", row: { id: "pop_1", version: 1, kind: "scenario", definition: { n: 100, population: {
    variables: [{ name: "age", family: "normal", mean: 63, sd: 9 }] } } } }, context));
  assert.equal(population.stages[0].jobKind, "generate_population");
  assert.deepEqual(population.stages[0].keepTables, ["population"], "its table is what the patients read");
  const real = /** @type {any} */ (vcrBuildStages({ kind: "population", row: { id: "pop_2", version: 1, kind: "real", snapshotId: "snp_1", definition: {
    rules: [{ name: "成年", rule: { op: "compare", column: "age", comparator: "gte", value: 18 } }], timeZero: { column: "index_date" }, exit: { column: "last_seen" } } } }, context));
  assert.equal(real.stages[0].jobKind, "build_cohort");
  assert.equal(real.stages[0].snapshot, true);
  const patientRow = { id: "pts_1", version: 1, populationId: "pop_1", modelId: "reference-time-to-event", modelVersion: "1.0.0",
    scenario: { design: { nTreat: 60, nControl: 40 }, endpoint: { type: "time_to_event" }, truth: { covariateEffects: { age: 0.01 } } } };
  const waiting = /** @type {any} */ (vcrBuildStages({ kind: "patient_set", row: patientRow }, { ...context, populations: [{ id: "pop_1", resultId: null }] }));
  assert.deepEqual(waiting, { ok: false, waiting: "population_pending" });
  const ready = /** @type {any} */ (vcrBuildStages({ kind: "patient_set", row: patientRow }, { ...context, populations: [{ id: "pop_1", resultId: "res_1" }] }));
  assert.equal(ready.stages[0].jobKind, "generate_patients");
  assert.deepEqual(ready.stages[0].derived, [{ from: "object", table: "population" }]);
  assert.equal(ready.stages[0].scenario.truth.hazardRatio, 0.7, "the cards' truth is laid over the patients too");
  assert.deepEqual(ready.stages[0].detail, { modelId: "reference-time-to-event", modelVersion: "1.0.0" });
  const noEndpoint = /** @type {any} */ (vcrBuildStages({ kind: "patient_set", row: { ...patientRow, scenario: { design: { nTreat: 6 } } } }, { ...context, definition: null, populations: [{ id: "pop_1", resultId: "r" }] }));
  assert.equal(noEndpoint.refused.code, "vcr_scenario_endpoint_missing");

  const grid = /** @type {any} */ (vcrBuildStages({ kind: "design_grid", row: { id: "grd_1", version: 1,
    dimensions: { designs: [{ label: "每组 100", kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, { label: "每组 200", kind: "two_arm_fixed", nTreat: 200, nControl: 200 }],
      base: { endpoint: { type: "binary" }, analysis: { method: "risk_difference", alpha: 0.025, sided: 1 }, performance: ["power"] } },
    truthScenarios: [{ label: "零效应", controlRate: 0.3, treatmentRate: 0.3 }, { label: "有效应", controlRate: 0.3, treatmentRate: 0.45 }] } }, context));
  assert.equal(grid.ok, true, JSON.stringify(grid));
  assert.equal(grid.stages[0].scenario.designs.length, 2);
  assert.equal(grid.stages[0].scenario.designs[0].label, undefined, "the words a page shows a design by never reach the engine");
  assert.deepEqual(validateScenario("design.grid", grid.stages[0].scenario), []);
});

test("every example in the skill is a shape the platform accepts: the objects build, and the direct scenarios validate", () => {
  const skill = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../capabilities/vcr-analysis/SKILL.md"), "utf8");
  const blocks = [...skill.matchAll(/```json vcr:(\S+)\n([\s\S]*?)```/g)].map((match) => ({ kind: match[1], body: JSON.parse(match[2]) }));
  assert.ok(blocks.length >= 7, `the skill teaches supported designs by example (${blocks.length} blocks)`);
  const t2 = { ...context, study: { ...seedStudy, dataTier: "T2" },
    populations: [{ id: "pop_example", resultId: "res_example" }] };
  const kinds = new Set();
  for (const { kind, body } of blocks) {
    kinds.add(kind);
    if (kind.startsWith("object:")) {
      const objectKind = kind.slice("object:".length);
      const row = { id: `${objectKind}_example`, version: 1, ...body, ...(objectKind === "design_grid" ? { truthScenarios: body.truthScenarios } : {}) };
      if (objectKind === "comparator" && row.configuration?.provenance?.receiptId) {
        assert.equal(row.configuration.curve, undefined, "the skill references a source receipt rather than inventing points");
        continue; // The authorized receipt is resolved by the real planner/queue integration tests.
      }
      const plan = /** @type {any} */ (vcrBuildStages({ kind: objectKind, row }, t2));
      assert.equal(plan.ok, true, `${kind}: ${JSON.stringify(plan)}`);
      for (const stage of plan.stages) {
        const method = VCR_JOB_METHODS[stage.jobKind];
        assert.deepEqual(validateScenario(method, stage.scenario), [], `${kind} → ${stage.jobKind}`);
      }
    } else {
      const method = VCR_JOB_METHODS[/** @type {keyof typeof VCR_JOB_METHODS} */ (kind)];
      assert.ok(method, `${kind} is a job kind`);
      assert.deepEqual(validateEngineJob({ jobId: "job_x", studyId: "std_x", kind, method, methodVersion: "1.0.0", protocolVersion: 1, seed: 1,
        cpuSecondsLimit: 60, inputs: [], scenario: body }), [], kind);
    }
  }
  for (const wanted of ["object:population", "object:patient_set", "object:comparator", "object:trial_scenario", "object:design_grid", "design_analytic"]) {
    assert.ok(kinds.has(wanted), `the skill has an example of ${wanted}`);
  }
  // The skill speaks to the model in its own words: no plan section numbers, no acceptance-case ids, no retired spellings.
  assert.doesNotMatch(skill, /§\s?\d|\bAC-\d|\bEB-\d|\bPA-\d/);
  assert.doesNotMatch(skill, /isNull|dropoutRate/);
  assert.match(skill, /mcp__evimed__vcr_write/);
  assert.equal(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../capability-skills/vcr-analysis/SKILL.md"), "utf8"), skill,
    "the capability's skill and the shared copy are one file");
});

test("two assumptions that cannot both hold are found by closed-form identities and named with their versions", () => {
  assert.deepEqual(vcrAssumptionConflicts(cards), []);
  const conflicts = vcrAssumptionConflicts([
    { key: "hazard_ratio", version: 2, pointValue: 0.5, name: "风险比" }, { key: "control_median_pfs", version: 1, pointValue: 6 },
    { key: "treatment_median_pfs", version: 1, pointValue: 7 },
    { key: "dropout_rate", version: 1, pointValue: 0.3, name: "脱落率", distribution: { range: { low: 0.05, high: 0.15 } } },
  ]);
  assert.deepEqual(conflicts.map((entry) => entry.code).sort(), ["hazard_ratio_vs_medians", "point_outside_range"]);
  const medians = conflicts.find((entry) => entry.code === "hazard_ratio_vs_medians");
  assert.deepEqual(medians.versions, ["hazard_ratio@2", "control_median_pfs@1", "treatment_median_pfs@1"]);
  assert.match(medians.detail, /0\.857/);
  const rates = vcrAssumptionConflicts([{ key: "control_event_rate", version: 1, pointValue: 0.3 }, { key: "treatment_event_rate", version: 1, pointValue: 0.45 },
    { key: "risk_difference", version: 1, pointValue: 0.05 }]);
  assert.equal(rates[0].code, "risk_difference_vs_rates");
});

test("a not-estimable result names what is missing and what would answer it, for every rule the engine can fire", () => {
  for (const rule of VCR_NOT_ESTIMABLE_RULES) {
    const [gap] = vcrGapsForRule(rule);
    assert.ok(gap?.title && gap.detail && gap.answers, `${rule} has its gap sentence`);
  }
  assert.deepEqual(vcrGapsForRule("something_else"), []);
});

test("a superseded version is found where the graph knows it: an earlier version of the same object is what a change replaces", () => {
  const edges = [{ from: "assumption:dropout_rate@1", to: "trial_scenario:scn_1@1" }];
  assert.deepEqual([...vcrSupersededNodes(edges, ["assumption:dropout_rate@2"])].sort(), ["assumption:dropout_rate@1", "assumption:dropout_rate@2"]);
  assert.ok(Object.keys(VCR_SCENARIO_SCHEMAS).length === 24);
});

test("C2-5 the assurance stage binds what its own schema takes from the cards — the outcome's standard deviation, the control rate — and says it used exactly those", () => {
  const prior = { family: "normal", params: { mean: 4, sd: 1.2 }, range: { kind: "prediction", low: 1.6, high: 6.4 } };
  const continuous = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({ design: { nTreat: 150, nControl: 150 }, analysis: { method: "ttest", alpha: 0.025 } },
    { endpointType: "continuous" }) }, { ...context, assumptions: [{ key: "mean_difference", version: 1, pointValue: 4, distribution: prior }, { key: "outcome_sd", version: 2, pointValue: 12 }] }));
  const assurance = continuous.stages.find((entry) => entry.stage === "assurance");
  assert.equal(assurance.scenario.truth.sd, 12, "not the schema's default of 1, which read a 4-unit effect as four standard deviations");
  assert.deepEqual(assurance.scenario.designPrior, { mean: 4, sd: 1.2, kind: "normal", basis: "prediction" });
  assert.deepEqual(assurance.bound, [{ key: "outcome_sd", version: 2, path: "truth.sd" }], "the effect's point value is not an input of this integral, and the job does not claim it");
  assert.deepEqual(validateScenario("design.assurance", assurance.scenario), []);
  const binary = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({ design: { nTreat: 200, nControl: 200 }, analysis: { method: "risk_difference", alpha: 0.025 } },
    { endpointType: "binary" }) }, { ...context, assumptions: [{ key: "control_event_rate", version: 1, pointValue: 0.3 },
    { key: "risk_difference", version: 1, pointValue: 0.15, distribution: { family: "normal", params: { mean: 0.15, sd: 0.05 } } }] }));
  const binaryAssurance = binary.stages.find((entry) => entry.stage === "assurance");
  assert.equal(binaryAssurance.scenario.truth.controlRate, 0.3, "the binary assurance schema requires the control rate");
  assert.deepEqual(validateScenario("design.assurance", binaryAssurance.scenario), []);
});

test("C2-6 a key only the binder injected, which the stage's schema does not read, is dropped in silence; a key the run wrote is refused by its path", () => {
  const simon = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({ design: { maxN: 60 }, truth: { nullRate: 0.2, alternativeRate: 0.4 }, analysis: { alpha: 0.05, power: 0.8 } },
    { design: "simon_two_stage", endpointType: "binary" }) }, { ...context, assumptions: [{ key: "control_event_rate", version: 1, pointValue: 0.3 }] }));
  assert.equal(simon.ok, true, JSON.stringify(simon));
  assert.deepEqual(simon.stages[0].scenario.truth, { nullRate: 0.2, alternativeRate: 0.4 });
  assert.deepEqual(simon.stages[0].bound, [], "and the job does not say it used a card it did not");
  const written = /** @type {any} */ (vcrBuildStages({ kind: "trial_scenario", row: trialRow({ design: { maxN: 60 }, truth: { nullRate: 0.2, alternativeRate: 0.4, controlRate: 0.3 }, analysis: { alpha: 0.05, power: 0.8 } },
    { design: "simon_two_stage", endpointType: "binary" }) }, context));
  assert.equal(written.ok, false);
  assert.deepEqual(written.refused.paths, ["truth.controlRate"]);
});

test("C3-09 a model answers only for what it declares it covers: the endpoint, the fields it needs and the ranges it was fitted on", () => {
  const variables = vcrPopulationVariables({ definition: { population: { variables: [{ name: "age", family: "normal", mean: 63, sd: 9, min: 30, max: 92 }, { name: "egfr", family: "normal", mean: 75, sd: 20 }] } } });
  assert.deepEqual([...variables.keys()], ["age", "egfr"]);
  assert.deepEqual(variables.get("age"), { min: 30, max: 92 });
  const referenceBinary = { id: "mdl_1", name: "reference-binary", version: "1.0.0", endpointType: "binary", applicability: { endpoints: ["binary"] }, card: {} };
  assert.deepEqual(vcrModelApplicabilityIssues(referenceBinary, { endpointType: "binary", variables }), [], "a reference simulator declares an endpoint and nothing else");
  const outside = vcrModelApplicabilityIssues(referenceBinary, { endpointType: "time_to_event", variables });
  assert.deepEqual(outside.map((issue) => [issue.code, issue.field]), [["endpoint_not_covered", "endpoint.type"]]);
  const fitted = { id: "mdl_2", name: "fitted-os", version: "1.0.0", endpointType: "time_to_event",
    applicability: { endpoints: ["time_to_event"], requiredFields: ["age", "creatinine"], inputRanges: { age: [40, 80], egfr: [15, 140] } }, card: {} };
  const issues = vcrModelApplicabilityIssues(fitted, { endpointType: "time_to_event", variables });
  assert.deepEqual(issues.map((issue) => [issue.code, issue.field]), [["required_field_missing", "creatinine"], ["input_out_of_range", "age"]],
    "creatinine is not in the population; age reaches 30 and 92, outside the 40–80 the model was fitted on; egfr is inside its range");
  assert.match(issues[1].text, /40–80/);

  // The plan refuses the patient set before any job is queued, and names the model and what fell outside.
  const patientRow = { id: "pts_1", version: 1, populationId: "pop_1", modelId: "fitted-os", modelVersion: "1.0.0",
    scenario: { design: { nTreat: 60, nControl: 40 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 6 } } };
  const population = { id: "pop_1", resultId: "res_1", definition: { population: { variables: [{ name: "age", family: "normal", mean: 63, sd: 9, min: 30, max: 92 }] } } };
  const refused = /** @type {any} */ (vcrBuildStages({ kind: "patient_set", row: patientRow }, { ...context, populations: [population], models: [fitted] }));
  assert.equal(refused.ok, false);
  assert.equal(refused.refused.code, "vcr_model_not_applicable");
  assert.deepEqual(refused.refused.paths, ["creatinine", "age"]);
  assert.match(refused.refused.message, /fitted-os/);
  // An explicitly selected missing model is refused; it never becomes a different generator.
  const unknown = /** @type {any} */ (vcrBuildStages({ kind: "patient_set", row: { ...patientRow, modelId: "absent" } }, { ...context, populations: [population], models: [fitted] }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.refused.code, "vcr_model_not_found");
  const covered = /** @type {any} */ (vcrBuildStages({ kind: "patient_set", row: { ...patientRow, modelId: "reference-time-to-event" } },
    { ...context, populations: [population], models: [{ id: "mdl_3", name: "reference-time-to-event", version: "1.0.0", endpointType: "time_to_event", applicability: { endpoints: ["time_to_event"] }, card: {} }] }));
  assert.equal(covered.ok, true);
});
