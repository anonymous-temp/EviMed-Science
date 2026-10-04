// 「虚拟临研」's program rules without a database: what a program wants, which
// job a research object needs, the dispatch tag a run carries, and the five
// notices — their kinds, their titles and who hears them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  VCR_ACCRUAL_TOLERANCE, VCR_ANALYSIS_STEPS, VCR_ASSUMPTION_BINDINGS, VCR_EXPORT_OUTLINES, VCR_RUN_CAPABILITIES, VcrOrchestrator,
  vcrAssumptionConflicts, vcrBindAssumptions, vcrBuildStages, vcrDefaultBrief, vcrDesignPriorFrom, vcrDispatchId, vcrEvidenceProduct, vcrExportBriefLines,
  vcrGapsForRule, vcrIdleStepStatus, vcrJobKindFor, vcrModelApplicabilityIssues, vcrPopulationVariables,
  vcrProductsOfSteps, vcrProgramSteps, vcrProjectScenario, vcrReviewRepairBrief, vcrRunId, vcrRunPrompt, vcrSimpleStepStatus, vcrStepUpdates, vcrStepsInFlight,
  vcrSupersededNodes, wantedVcrSteps,
} from "../src/vcrOrchestrator.mjs";
import { VCR_NOTICE_KINDS, createVcrNotifier, vcrNoticeHref, vcrStudyName } from "../src/vcrNotify.mjs";
import {
  VCR_ENGINE_METHODS, VCR_EXPORT_KINDS, VCR_EXPORT_KIND_LABELS_ZH, VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_NOTIFICATION_KINDS, VCR_NOT_ESTIMABLE_RULES,
  VCR_NOT_ESTIMABLE_RULE_LABELS_ZH, VCR_SCENARIO_SCHEMAS, VCR_STEPS, VCR_STEP_CAPABILITIES, VCR_STEP_NEEDS, validateEngineJob, validateScenario,
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

test("above T0 a protocol with criteria and nobody judged is not a running matching step: 「进行中」 is a job or a run out for the step, never its input existing", () => {
  const plan = wantedVcrSteps(steps(["matching"]));
  const stored = (/** @type {string} */ status, /** @type {string | null} */ note = null) => ({ ...steps(["matching"]), matching: { status, requested: true, note } });
  // What the data says of matching above T0 with criteria structured and no patient judged: nothing. It used to say running.
  const unjudged = vcrSimpleStepStatus({ complete: false });
  assert.equal(unjudged, null);
  const observe = (/** @type {Record<string, any>} */ studySteps, /** @type {any} */ seen, /** @type {string[]} */ flying = []) =>
    vcrStepUpdates({ steps: studySteps, seen: [["matching", seen]], flying: new Set(flying), plan });

  // Stored running by the old rule and never dispatched: put back to where a run is sent from.
  assert.deepEqual(observe(stored("running"), unjudged), [{ step: "matching", fields: { status: "none", note: null } }]);
  // 「让 AI 做」 stores queued: observation leaves it for the dispatcher — it used to overwrite it with running, and nothing was sent.
  assert.deepEqual(observe(stored("queued"), unjudged), []);
  assert.deepEqual(observe(stored("none"), unjudged), []);
  // The matching run is out: running stands for as long as the slot holds it.
  assert.deepEqual(observe(stored("running"), unjudged, ["matching"]), []);
  assert.deepEqual(observe(stored("running"), unjudged, ["population", "trial"]), [{ step: "matching", fields: { status: "none", note: null } }],
    "a run out for other steps is not this step's");
  // A matching job of its own is out, with or without a run.
  const judging = vcrSimpleStepStatus({ complete: false, jobOpen: true });
  assert.deepEqual(judging, { status: "running", note: null });
  assert.deepEqual(observe(stored("none"), judging), [{ step: "matching", fields: { status: "running" } }]);
  assert.deepEqual(observe(stored("running"), judging), []);
  // Patients judged (or, at T0, criteria structured): done, and a minimal upstream version says it is one.
  assert.deepEqual(observe(stored("running"), vcrSimpleStepStatus({ complete: true })), [{ step: "matching", fields: { status: "done" } }]);
  assert.deepEqual(vcrSimpleStepStatus({ complete: true, minimal: true }), { status: "minimal", note: null });
  // A failure stands, with its note, until somebody asks again; a finished step is not touched by a run going out.
  assert.deepEqual(observe(stored("failed", "引擎暂不可用"), unjudged), []);
  assert.deepEqual(observe(stored("done"), unjudged, ["matching"]), []);
});

test("a run that ended and left nothing does not leave its steps reading 「进行中」, whichever step it was sent for and whether or not it is still wanted", () => {
  const running = (/** @type {string[]} */ names) => Object.fromEntries(VCR_STEPS.map((step) => [step, { status: names.includes(step) ? "running" : "none", requested: false }]));
  const silent = /** @type {Array<[string, null]>} */ (VCR_STEPS.map((step) => [step, null]));
  // The analysis run was sent for four steps and wrote nothing; nothing is requested any more.
  const plan = wantedVcrSteps(steps([]));
  assert.deepEqual(vcrStepUpdates({ steps: running([...VCR_ANALYSIS_STEPS]), seen: silent, flying: new Set(), plan }),
    VCR_ANALYSIS_STEPS.map((step) => ({ step, fields: { status: "none", note: null } })));
  // While it is out, every step in its scope reads running and no other does.
  assert.deepEqual(vcrStepUpdates({ steps: running([...VCR_ANALYSIS_STEPS, "evidence"]), seen: silent, flying: new Set(VCR_ANALYSIS_STEPS), plan }),
    [{ step: "evidence", fields: { status: "none", note: null } }]);
  // Only a stored running is ever put back.
  for (const status of ["none", "queued", "failed", "stale", "done", "minimal"]) assert.equal(vcrIdleStepStatus(status, false), null, status);
  assert.equal(vcrIdleStepStatus("running", true), null);

  // The steps a run is out for are the scope of the marks the slot holds; an export run covers none.
  assert.deepEqual([...vcrStepsInFlight([{ detail: { purpose: "analysis", scope: [{ step: "population", fidelity: "full" }, { step: "trial", fidelity: "minimal" }] } }])], ["population", "trial"]);
  assert.deepEqual([...vcrStepsInFlight([{ detail: { purpose: "matching", scope: [{ step: "matching", fidelity: "full" }] } }, { detail: null }])], ["matching"]);
  assert.deepEqual([...vcrStepsInFlight([{ detail: { purpose: "export", kind: "study_package", exportId: "exp_1" } }])], []);
  assert.deepEqual([...vcrStepsInFlight([{ detail: { scope: ["evidence", "not_a_step"] } }])], ["evidence"]);
  assert.deepEqual([...vcrStepsInFlight([])], []);
});

test("observation still never invents progress: what the data says of a step nobody asked for is written only when it is finished or stale", () => {
  const plan = wantedVcrSteps(steps(["trial"]));
  const seen = /** @type {Array<[string, { status: string, note: string | null } | null]>} */ ([
    ["evidence", { status: "done", note: null }], ["population", { status: "queued", note: null }], ["comparator", { status: "stale", note: null }],
    ["patients", { status: "failed", note: "模型不覆盖这个终点" }], ["trial", { status: "failed", note: "设计不受支持" }],
  ]);
  assert.deepEqual(vcrStepUpdates({ steps: steps(["trial"]), seen, flying: new Set(), plan }), [
    { step: "evidence", fields: { status: "done" } },
    { step: "comparator", fields: { status: "stale" } },
    { step: "trial", fields: { status: "failed", note: "设计不受支持" } },
  ]);
  // A failed step that reads done clears its note; an unchanged status with an unchanged note writes nothing.
  const failed = { ...steps(["trial"]), trial: { status: "failed", requested: true, note: "设计不受支持" } };
  assert.deepEqual(vcrStepUpdates({ steps: failed, seen: [["trial", { status: "done", note: null }]], flying: new Set(), plan }),
    [{ step: "trial", fields: { status: "done", note: null } }]);
  assert.deepEqual(vcrStepUpdates({ steps: failed, seen: [["trial", { status: "failed", note: "设计不受支持" }]], flying: new Set(), plan }), []);
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

const briefStudy = { name: "EV-201", question: "单臂试验能否用外部对照？", dataTier: "T0", intendedUse: "exploratory" };

test("an export run's brief names the one document it is for, in words and by kind, for each of the four", () => {
  const labels = /** @type {Record<string, string>} */ (VCR_EXPORT_KIND_LABELS_ZH);
  assert.deepEqual(Object.keys(VCR_EXPORT_OUTLINES).sort(), [...VCR_EXPORT_KINDS].sort(), "every document has an outline, and nothing else does");
  for (const kind of VCR_EXPORT_KINDS) {
    const brief = vcrDefaultBrief({ study: briefStudy, scope: [], detail: { kind, exportId: "exp_1" } });
    assert.ok(brief.startsWith("研究：EV-201。\n研究问题：单臂试验能否用外部对照？\n数据档位：T0；预期用途：exploratory。\n"), kind);
    assert.ok(brief.includes(`「${labels[kind]}」（kind: ${kind}）`), `the brief says which document (${kind})`);
    assert.ok(brief.includes(VCR_EXPORT_OUTLINES[kind]), `and what that document holds (${kind})`);
    assert.ok(brief.includes(`data.kind 写 ${kind}。`), `and the kind its report is written under (${kind})`);
    assert.ok(brief.includes("写成别的 kind 会被拒绝"), "and that another kind is refused, which the gateway holds it to");
    // Every other document's name is absent: a brief that listed all four would not have said which.
    for (const other of VCR_EXPORT_KINDS.filter((entry) => entry !== kind && entry !== "study_package")) {
      assert.equal(brief.includes(labels[other]), false, `${kind} does not mention ${other}`);
    }
    assert.equal(brief.includes("本次要做的步骤"), false, "an export run has no steps to be told");
    assert.deepEqual(vcrExportBriefLines(kind).filter((line) => !brief.includes(line)), [], "the brief carries every export line");
  }
});

test("a step run's brief is the steps asked of it, and a detail that names no export is not read as one", () => {
  const stepBrief = vcrDefaultBrief({ study: briefStudy, scope: ["population", "trial"], detail: { fidelity: "minimal" } });
  assert.equal(stepBrief, [
    "研究：EV-201。", "研究问题：单臂试验能否用外部对照？", "数据档位：T0；预期用途：exploratory。",
    "本次要做的步骤：population、trial。", "上游缺的部分先补一个最小版本，并标明「AI 设定」。",
    "用 vcr_read 读研究已有的定义、假设与结果；用 vcr_write 写定义、条件、假设、设计与决策；确定性计算一律用 vcr_simulate 排作业，不要自己算数。",
  ].join("\n"));
  for (const detail of [{ kind: "simulation_report" }, { kind: "not_a_document", exportId: "exp_1" }, {}]) {
    assert.equal(vcrDefaultBrief({ study: briefStudy, scope: [], detail }).includes("本次只写一份资料"), false, JSON.stringify(detail));
  }
});

test("the brief of a review's one revision names the document it revises, whichever of the four it is, and keeps what it was told before", () => {
  const labels = /** @type {Record<string, string>} */ (VCR_EXPORT_KIND_LABELS_ZH);
  for (const kind of VCR_EXPORT_KINDS) {
    const brief = vcrReviewRepairBrief({ revisionId: "exp_2", originalId: "exp_1", kind,
      templates: "功效为 {{n:measure(power).value|pct1}}。", findings: [{ kind: "wording", location: "main", fix: "Clarify uncertainty." }] });
    assert.ok(brief.includes(`Document: 「${labels[kind]}」 (kind: ${kind}).`), kind);
    assert.ok(brief.includes(`data.kind: "${kind}"`), `the kind its report is written under (${kind})`);
    assert.match(brief, /any other kind is refused rather than filed elsewhere/);
    assert.match(brief, /^Revise the retained report in place within a new version\. Export ID: exp_2\. Original export: exp_1\.\n/);
    assert.match(brief, /Do not rerun engines or invent inputs\./);
    assert.match(brief, /deliverables\/vcr-review-exp_2\//);
    assert.ok(brief.includes("功效为 {{n:measure(power).value|pct1}}。") && brief.includes("Clarify uncertainty."), "the retained template and the findings are in it");
  }
});

/**
 * An orchestrator over a store that answers the one question `exportDispatch`
 * asks — which run mark holds the study's slot — with the given row.
 * @param {Record<string, any> | null} mark
 */
function slotHeldBy(mark) {
  /** @type {Array<{ sql: string, params: any[] }>} */
  const asked = [];
  const store = { async one(/** @type {string} */ sql, /** @type {any[]} */ params) { asked.push({ sql, params }); return mark; } };
  return { asked, orchestrator: new VcrOrchestrator({ store: /** @type {any} */ (store), jobs: /** @type {any} */ ({}) }) };
}

test("the export a run is out for is read from the study's run slot: an asked-for export, the one revision of a review, and nothing else", async () => {
  const exportMark = { key: "run:export:exp_9", dispatch_id: "vcr-run-export-exp_9-1", run_id: "run_7",
    detail: { purpose: "export", kind: "simulation_report", exportId: "exp_9" } };
  const asked = slotHeldBy(exportMark);
  assert.deepEqual(await asked.orchestrator.exportDispatch("std_1"),
    { key: "run:export:exp_9", exportId: "exp_9", dispatchId: "vcr-run-export-exp_9-1", runId: "run_7" });
  assert.deepEqual(asked.asked[0].params, ["std_1", 10], "the slot is the study's, and a claim older than the stale-claim window does not hold it");
  assert.match(asked.asked[0].sql, /kind = 'run'[\s\S]*state = 'running' OR \(state = 'claimed'/);

  // The revision a review asked for is an export run too, and its export is the new revision row, not the original.
  const repair = slotHeldBy({ key: "run:review-repair:exp_1", dispatch_id: "vcr-run-review-repair-exp_1-1", run_id: null,
    detail: { purpose: "export", kind: "study_package", exportId: "exp_2", revisionOf: "exp_1" } });
  assert.deepEqual(await repair.orchestrator.exportDispatch("std_1"),
    { key: "run:review-repair:exp_1", exportId: "exp_2", dispatchId: "vcr-run-review-repair-exp_1-1", runId: null });

  // A step run holds the slot: its report writes are nobody's export.
  assert.equal(await slotHeldBy({ key: "run:analysis", dispatch_id: "vcr-run-analysis-1", run_id: "run_3",
    detail: { purpose: "analysis", scope: [{ step: "trial" }] } }).orchestrator.exportDispatch("std_1"), null);
  // No run out, or an export mark that names no export.
  assert.equal(await slotHeldBy(null).orchestrator.exportDispatch("std_1"), null);
  assert.equal(await slotHeldBy({ key: "run:export:exp_9", dispatch_id: "d", run_id: null, detail: { purpose: "export" } }).orchestrator.exportDispatch("std_1"), null);
});

test("a runtime reserved for another dispatch is not the export's run; the researcher's own open runtime is judged by the slot alone", async () => {
  const mark = { key: "run:export:exp_9", dispatch_id: "vcr-run-export-exp_9-1", run_id: "run_7", detail: { purpose: "export", kind: "validation_pack", exportId: "exp_9" } };
  const { orchestrator } = slotHeldBy(mark);
  assert.equal((await orchestrator.exportDispatch("std_1", { runtimeRunId: "vcr-run-export-exp_9-1" }))?.exportId, "exp_9");
  assert.equal(await orchestrator.exportDispatch("std_1", { runtimeRunId: "autopilot-episode-4" }), null);
  assert.equal((await orchestrator.exportDispatch("std_1", { runtimeRunId: null }))?.exportId, "exp_9");
  assert.equal((await orchestrator.exportDispatch("std_1", {}))?.exportId, "exp_9");
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

// --- the comparator-effect methods are reachable from the comparator step ------------------------------

const CMP_T2 = { ...context, study: { ...seedStudy, dataTier: "T2" } };
/** @param {Record<string, any>} configuration @param {Record<string, any>} [row] @param {Record<string, any>} [ctx] */
const planComparator = (configuration, row = {}, ctx = CMP_T2) => /** @type {any} */ (vcrBuildStages({ kind: "comparator",
  row: { id: "cmp_x", version: 1, route: "external_control", estimand: "ATT", configuration, ...row } }, ctx));
/** The engine's own verdict on a stage's scenario, once the platform has written the comparator's input id. @param {any} stage */
const stageIssues = (stage) => validateScenario(VCR_JOB_METHODS[stage.jobKind],
  stage.derived.some((/** @type {any} */ entry) => entry.bindTo) ? { ...stage.scenario, pseudoIpdInputId: "res_x:reconstructed-ipd" } : stage.scenario);

test("a study's declared design reaches the comparator-effect methods: weighted Cox, doubly robust, covariate sets", () => {
  const base = { covariates: ["age", "ecog"], tau: 12, parameterCode: "OS", snapshotId: "snp_1" };
  // the declared method and endpoint decide; nothing is read from a word of prose
  assert.equal(vcrJobKindFor("comparator", { route: "external_control", configuration: { method: "weighted_cox" } }), "weighted_cox_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "external_control", configuration: { method: "aipw" } }), "aipw_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "external_control", configuration: { covariateSets: [{ name: "a", covariates: ["x"] }] } }), "covariate_set_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "external_control", configuration: { covariateSets: [], method: "aipw" } }), "aipw_comparator", "an empty list declares no sets");
  assert.equal(vcrJobKindFor("comparator", { route: "external_control", configuration: { method: "weighted_cox", covariateSets: [{ name: "a", covariates: ["x"] }] } }),
    "covariate_set_comparator", "declared sets make the sensitivity analysis of the declared method");
  assert.equal(vcrJobKindFor("comparator", { route: "external_control" }), "weight_comparator", "the old default is untouched");

  const cox = planComparator({ ...base, method: "weighted_cox" });
  assert.equal(cox.ok, true, JSON.stringify(cox));
  assert.equal(cox.stages[0].jobKind, "weighted_cox_comparator");
  assert.equal(cox.stages[0].snapshot, true);
  assert.deepEqual(cox.stages[0].scenario.endpoint, { type: "time_to_event" });
  assert.deepEqual(stageIssues(cox.stages[0]), []);
  const coxAte = planComparator({ ...base, method: "weighted_cox" }, { estimand: "ATE" });
  assert.equal(coxAte.ok, true);
  assert.equal(coxAte.stages[0].scenario.weighting, "propensity", "entropy balancing estimates the ATT only, as in the weighting jobs");
  assert.deepEqual(stageIssues(coxAte.stages[0]), []);

  const binary = { ...CMP_T2, definition: { ...definition, endpointType: "binary" } };
  const aipw = planComparator({ covariates: ["age", "ecog"], outcomeColumn: "response", method: "aipw", snapshotId: "snp_1" }, {}, binary);
  assert.equal(aipw.ok, true, JSON.stringify(aipw));
  assert.equal(aipw.stages[0].jobKind, "aipw_comparator");
  assert.deepEqual(aipw.stages[0].scenario.endpoint, { type: "binary" });
  assert.deepEqual(stageIssues(aipw.stages[0]), []);

  const sets = [{ name: "primary", covariates: ["age", "ecog"] }, { name: "without ecog", covariates: ["age"] }];
  const entropy = planComparator({ covariateSets: sets, tau: 12, parameterCode: "OS", snapshotId: "snp_1" });
  assert.equal(entropy.ok, true, JSON.stringify(entropy));
  assert.equal(entropy.stages[0].jobKind, "covariate_set_comparator");
  assert.equal(entropy.stages[0].scenario.analysis, "entropy_balance");
  assert.deepEqual(stageIssues(entropy.stages[0]), []);
  const propensity = planComparator({ covariateSets: sets, tau: 12, method: "propensity" });
  assert.equal(propensity.stages[0].scenario.analysis, "propensity");
  assert.equal(planComparator({ covariateSets: sets, tau: 12 }, { estimand: "ATE" }).stages[0].scenario.analysis, "propensity", "a non-ATT estimand is not entropy balancing");
  const doubly = planComparator({ covariateSets: sets, method: "aipw", outcomeColumn: "response" }, {}, binary);
  assert.equal(doubly.stages[0].scenario.analysis, "aipw");
  assert.deepEqual(stageIssues(doubly.stages[0]), []);
  // an analysis the run typed in does not choose: the design's method does
  assert.equal(planComparator({ covariateSets: sets, tau: 12, analysis: "aipw" }).stages[0].scenario.analysis, "entropy_balance");
  // the alternatives are the design's, so a covariate list beside them is refused by name rather than ignored
  const both = planComparator({ covariateSets: sets, covariates: ["age"], tau: 12 });
  assert.equal(both.ok, false);
  assert.equal(both.refused.code, "vcr_scenario_unknown_fields");
  assert.ok(both.refused.paths.includes("covariates"));
});

test("a design the study's endpoint cannot support is refused in a sentence, not run as something else", () => {
  const refused = (/** @type {any} */ plan, /** @type {string} */ code, /** @type {RegExp} */ words) => {
    assert.equal(plan.ok, false, JSON.stringify(plan));
    assert.equal(plan.refused.code, code);
    assert.match(plan.refused.message, words);
  };
  const binary = { ...CMP_T2, definition: { ...definition, endpointType: "binary" } };
  refused(planComparator({ covariates: ["age"], method: "weighted_cox", tau: 12 }, {}, binary), "vcr_job_scenario_invalid", /事件时间终点/);
  refused(planComparator({ covariates: ["age"], method: "aipw", tau: 12 }), "vcr_job_scenario_invalid", /连续或二分类/);
  refused(planComparator({ covariates: ["age"], method: "aipw" }, { estimand: "ATE" }, binary), "vcr_job_scenario_invalid", /ATT/);
  refused(planComparator({ covariateSets: [{ name: "a", covariates: ["x"] }, { name: "b", covariates: ["y"] }], method: "aipw", tau: 12 }), "vcr_job_scenario_invalid", /连续或二分类/);
  const noEndpoint = { ...CMP_T2, definition: null };
  refused(planComparator({ covariates: ["age"], method: "weighted_cox", tau: 12 }, {}, noEndpoint), "vcr_scenario_endpoint_missing", /终点类型/);
  // a design with no declared choice keeps the weighting job it always had, whatever the endpoint
  assert.equal(planComparator({ covariates: ["age"] }, {}, binary).stages[0].jobKind, "weight_comparator");
});

test("a time-to-event MAIC takes its comparator from the reconstruction result, by reference, and plans only what its design declares", () => {
  const T0 = { ...context, study: { ...seedStudy, dataTier: "T0" } };
  const curve = { curve: [{ time: 0, surv: 1 }, { time: 12, surv: 0.5 }, { time: 24, surv: 0.3 }], riskTable: [{ time: 0, atRisk: 100 }, { time: 12, atRisk: 50 }],
    provenance: { kind: "digitizer", tool: "platform" } };
  const maic = { method: "maic", covariates: ["age"], targets: { age: 60 }, snapshotId: "snp_1" };
  const plan = (/** @type {Record<string, any>} */ configuration) => planComparator(configuration, { route: "literature_control", estimand: "ATT" }, T0);
  assert.equal(vcrJobKindFor("comparator", { route: "literature_control", configuration: { method: "maic" } }, { definition }), "maic_time_to_event_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "literature_control", configuration: { method: "maic", endpoint: { type: "binary" } } }, { definition }), "maic_comparator",
    "a binary or continuous MAIC is the old method");

  // unanchored: one comparator curve -> reconstruct, then the MAIC reads the reconstruction's table by the stage that wrote it
  const un = plan({ ...maic, ...curve });
  assert.equal(un.ok, true, JSON.stringify(un));
  assert.deepEqual(un.stages.map((/** @type {any} */ entry) => entry.jobKind), ["reconstruct_km", "maic_time_to_event_comparator"]);
  assert.equal(un.stages[0].stage, "reconstruct");
  assert.deepEqual(un.stages[0].keepTables, ["reconstructed-ipd"]);
  assert.equal(un.stages[1].after, "reconstruct");
  assert.deepEqual(un.stages[1].derived, [{ from: "stage", stage: "reconstruct", table: "reconstructed-ipd", bindTo: "pseudoIpdInputId" }]);
  assert.equal(un.stages[1].snapshot, true, "the study's own patients come by snapshot");
  assert.equal(un.stages[1].scenario.pseudoIpdInputId, undefined, "the input's name is written by the queue from the result, never by the plan");
  assert.equal(un.stages[1].scenario.curve, undefined, "the maic stage does not carry the curve it did not read");
  for (const entry of un.stages) assert.deepEqual(stageIssues(entry), [], entry.jobKind);

  // anchored on two reconstructed arms
  const anchored = plan({ ...maic, anchored: true, treatmentColumn: "arm", ...curve, treatmentArm: { curve: curve.curve, riskTable: curve.riskTable } });
  assert.equal(anchored.ok, true, JSON.stringify(anchored));
  assert.deepEqual(anchored.stages.map((/** @type {any} */ entry) => entry.jobKind), ["reconstruct_km", "maic_time_to_event_comparator"]);
  for (const entry of anchored.stages) assert.deepEqual(stageIssues(entry), [], entry.jobKind);
  // anchored on the published contrast: no reconstruction, one stage, no hand-off
  const published = plan({ ...maic, anchored: true, aggregateEstimate: -0.56, aggregateSe: 0.09 });
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.deepEqual(published.stages.map((/** @type {any} */ entry) => entry.jobKind), ["maic_time_to_event_comparator"]);
  assert.deepEqual(published.stages[0].derived, []);
  assert.equal(published.stages[0].scenario.aggregateEstimate, -0.56);
  assert.deepEqual(stageIssues(published.stages[0]), []);

  // what the design does not declare is refused in a sentence, never filled in
  const no = (/** @type {Record<string, any>} */ configuration, /** @type {RegExp} */ words) => {
    const refused = /** @type {any} */ (plan(configuration));
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.refused.code, "vcr_job_scenario_invalid");
    assert.match(refused.refused.message, words);
  };
  no(maic, /发表曲线/);
  no({ ...maic, ...curve, treatmentArm: { curve: curve.curve, riskTable: curve.riskTable } }, /一条曲线/);
  no({ ...maic, ...curve, aggregateEstimate: -0.5, aggregateSe: 0.1 }, /锚定比较/);
  no({ ...maic, anchored: true }, /已发表的风险比/);
  no({ ...maic, anchored: true, ...curve }, /两个臂/);
  no({ ...maic, anchored: true, ...curve, treatmentArm: { curve: curve.curve, riskTable: curve.riskTable }, aggregateEstimate: -0.5, aggregateSe: 0.1 }, /不能两个都写/);
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
    if (kind === "curve_receipt") {
      assert.equal(body.what, "comparator");
      assert.equal(body.data.route, "literature_control");
      assert.equal(typeof body.data.configuration?.provenance?.receiptId, "string");
      assert.equal(body.data.configuration.curve, undefined, "a receipt example cannot invent a digitized curve");
      assert.equal(body.data.configuration.provenance.kind, undefined, "a caller-authored source label is not a receipt");
      continue; // vcrSkillExamples verifies the authorized receipt through the real source and write services.
    }
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
  for (const wanted of ["object:population", "object:patient_set", "object:comparator", "object:trial_scenario", "object:design_grid", "design_analytic", "curve_receipt"]) {
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
  // The list is the domain's, so a rule added there without a sentence here fails this test by name.
  assert.ok(VCR_NOT_ESTIMABLE_RULES.length >= 11, "the walk proves it walked");
  const cjk = /[\u4e00-\u9fff]/;
  for (const rule of VCR_NOT_ESTIMABLE_RULES) {
    const gaps = vcrGapsForRule(rule);
    assert.equal(gaps.length, 1, `${rule} has exactly one gap sentence`);
    const [gap] = gaps;
    for (const part of ["title", "detail", "answers"]) {
      assert.ok(gap[part] && cjk.test(gap[part]), `${rule}.${part} is a Chinese sentence`);
      assert.ok(!gap[part].includes(rule), `${rule}.${part} does not show the rule's id to a reader`);
    }
    assert.ok(/** @type {Record<string, string>} */ (VCR_NOT_ESTIMABLE_RULE_LABELS_ZH)[rule], `${rule} also has its one-line label`);
  }
  for (const rule of ["too_few_events", "nuisance_model_not_estimable"]) assert.ok(VCR_NOT_ESTIMABLE_RULES.includes(rule), rule);
  assert.deepEqual(vcrGapsForRule("something_else"), []);
});

test("a superseded version is found where the graph knows it: an earlier version of the same object is what a change replaces", () => {
  const edges = [{ from: "assumption:dropout_rate@1", to: "trial_scenario:scn_1@1" }];
  assert.deepEqual([...vcrSupersededNodes(edges, ["assumption:dropout_rate@2"])].sort(), ["assumption:dropout_rate@1", "assumption:dropout_rate@2"]);
  assert.equal(Object.keys(VCR_SCENARIO_SCHEMAS).length, Object.keys(VCR_ENGINE_METHODS).length, "one schema per method the domain declares");
  assert.ok(Object.keys(VCR_SCENARIO_SCHEMAS).length >= 24);
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

// --- the evidence step is read from what only it produces ----------------------------------------

test("an assumption card is the evidence step's product only when it cites its evidence: a pooled card, one study taken as it stands, or an expert setting widened from them", () => {
  // What evidence parameterization writes.
  assert.equal(vcrEvidenceProduct({ key: "control_median_pfs", sourceKind: "external_evidence", poolingMethod: "random_effects_reml", evidenceIds: ["evd_1", "evd_2"], pooling: { calibre: "closest" } }), true, "a pooled card");
  assert.equal(vcrEvidenceProduct({ key: "single", sourceKind: "external_evidence", poolingMethod: "single_study", evidenceIds: ["evd_3"], pooling: {} }), true, "one study taken as it stands");
  assert.equal(vcrEvidenceProduct({ key: "dropout_rate", sourceKind: "expert_set", evidenceIds: [], pooling: { basedOn: "evidence:evd_4", widenedBy: 2, reason: "只有一项中国人群研究" } }), true, "widened from the nearest verified value");
  assert.equal(vcrEvidenceProduct({ key: "k2", sourceKind: "expert_set", evidenceIds: [], pooling: { basedOn: { evidenceIds: ["evd_5"], calibre: "overall", k: 2 }, widenedBy: 2 } }), true, "widened from a pool with fewer than three studies");

  // What the protocol run and the analysis run state by themselves: nothing a simulation draws from is anchored in a source.
  assert.equal(vcrEvidenceProduct({ key: "hazard_ratio", sourceKind: "scenario", pointValue: 0.7, evidenceIds: [], pooling: {} }), false, "a scenario the run stated");
  assert.equal(vcrEvidenceProduct({ key: "dropout_rate", sourceKind: "expert_set", pointValue: 0.1, evidenceIds: [], pooling: {} }), false, "an expert setting with nothing behind it");
  assert.equal(vcrEvidenceProduct({ key: "dropout_rate", sourceKind: "expert_set", pointValue: 0.1 }), false, "no pooling record at all");
  assert.equal(vcrEvidenceProduct({ key: "x", sourceKind: "external_evidence", evidenceIds: [] }), false, "a citation that names nothing");
  for (const sourceKind of ["local_observation", "model_prediction"]) assert.equal(vcrEvidenceProduct({ sourceKind, evidenceIds: ["evd_1"], pooling: { basedOn: "x" } }), false, sourceKind);
  for (const nothing of [null, undefined, "card", 7, []]) assert.equal(vcrEvidenceProduct(nothing), false, String(nothing));
});

/**
 * One study in memory, answering exactly what one `advance` pass reads of the
 * store, so the orchestrator's own pass runs without a database: the live shape
 * of a study whose definition is done and whose cards are whatever the caller
 * says. Nothing is dispatched but through the orchestrator's own `#dispatch`.
 * @param {{ assumptions?: any[], openJobs?: any[], steps?: Record<string, any>, dispatch?: ((input: any) => Promise<any>) | null,
 *   tier?: string, protocol?: { id: string } | null, criteria?: number, assessments?: Array<{ protocolVersionId: string | null }> }} [options]
 */
function studyInMemory({ assumptions = [], openJobs = [], steps = {}, dispatch = null, tier = "T0", protocol = null, criteria = 0, assessments = [] } = {}) {
  const state = {
    study: /** @type {Record<string, any>} */ ({
      id: "std_live", userId: "u_live", projectId: "prj_live", name: "EV-201", question: "单臂 II 期能不能用外部对照？", dataTier: tier,
      intendedUse: "exploratory", status: "active",
      steps: Object.fromEntries(VCR_STEPS.map((step) => [step, { status: step === "definition" ? "done" : "none", requested: true, note: null, ...(steps[step] ?? {}) }])),
    }),
    assumptions, openJobs,
    /** @type {any[]} */ claims: [],
  };
  const client = {
    async query(/** @type {string} */ sql, /** @type {any[]} */ params = []) {
      if (/INSERT INTO [\w.]*schedule_marks/.test(sql)) {
        state.claims.push({ key: params[1], dispatchId: params[3], detail: JSON.parse(params[4]) });
        return { rows: [{ study_id: params[0], key: params[1], dispatch_id: params[3], attempts: 0, detail: JSON.parse(params[4]) }] };
      }
      if (/SELECT status FROM/.test(sql)) return { rows: [{ status: "active" }] };
      return { rows: [] };
    },
  };
  const store = {
    async studyById() { return state.study; },
    async edges() { return []; },
    async latestDefinition() { return { id: "def_1", studyId: "std_live", version: 1, pico: { population: "二线 NSCLC" }, estimand: {}, endpointType: "time_to_event" }; },
    async assumptions() { return state.assumptions; },
    async populations() { return []; },
    async patientSets() { return []; },
    async comparatorDesigns() { return []; },
    async trialScenarios() { return []; },
    async latestDesignGrid() { return null; },
    async latestProtocolVersion() { return protocol; },
    async staleMarks() { return []; },
    async setStep(/** @type {string} */ _id, /** @type {string} */ step, /** @type {Record<string, any>} */ fields) {
      state.study = { ...state.study, steps: { ...state.study.steps, [step]: { ...state.study.steps[step], ...fields } } };
      return state.study;
    },
    async rows(/** @type {string} */ sql) {
      if (/FROM [\w.]*jobs\s+WHERE study_id = \$1 AND state IN \('queued', 'running', 'awaiting_budget'\)/.test(sql)) return state.openJobs;
      return [];
    },
    async one(/** @type {string} */ sql, /** @type {any[]} */ params = []) {
      // The two counts the matching step is read from: the criteria of the protocol version, and the assessments made against it.
      if (/FROM [\w.]*matching_assessments/.test(sql)) return { n: assessments.filter((row) => !/AND protocol_version_id = \$2/.test(sql) || row.protocolVersionId === params[1]).length };
      if (/FROM [\w.]*criteria\b/.test(sql)) return { n: criteria };
      if (/UPDATE [\w.]*schedule_marks/.test(sql)) return { key: "run", state: "running" };
      return null;
    },
    async transaction(/** @type {(client: any) => Promise<any>} */ work) { return work(client); },
  };
  /** @type {any[]} */
  const dispatched = [];
  const orchestrator = new VcrOrchestrator({
    store: /** @type {any} */ (store), jobs: /** @type {any} */ ({}),
    dispatchRun: dispatch ?? (async (input) => { dispatched.push(input); return { runId: `run_${dispatched.length}`, sessionId: null }; }),
  });
  return { state, dispatched, orchestrator, steps: () => /** @type {Record<string, any>} */ (state.study.steps) };
}

test("the live shape: the protocol run wrote scenario cards, so cards exist and no evidence product does — the evidence step is not done, and vcr-evidence is the next run", async () => {
  const live = studyInMemory({ assumptions: [
    { key: "hazard_ratio", version: 1, name: "风险比", pointValue: 0.7, sourceKind: "scenario", valueSource: "assumed", evidenceIds: [], pooling: {}, reviewState: "ai_set" },
    { key: "control_median_pfs", version: 1, name: "对照组中位 PFS", pointValue: 6, sourceKind: "expert_set", valueSource: "assumed", evidenceIds: [], pooling: {}, reviewState: "ai_set" },
    { key: "dropout_rate", version: 1, name: "脱落率", pointValue: 0.1, sourceKind: "expert_set", valueSource: "assumed", evidenceIds: [], pooling: {}, reviewState: "ai_set" },
  ] });
  await live.orchestrator.advance("std_live");
  assert.equal(live.dispatched.length, 1, "one run out, and it is the next step");
  assert.equal(live.dispatched[0].capabilityId, "vcr-evidence", "the cards the protocol run wrote did not make the evidence step done");
  assert.equal(live.dispatched[0].reason, "vcr:evidence");
  assert.equal(live.steps().definition.status, "done");
  assert.equal(live.steps().evidence.status, "running", "run out for it now, and the page says so rather than 已完成");
  assert.deepEqual(live.state.claims.map((claim) => claim.key), ["run:evidence"]);
  assert.deepEqual(live.state.claims[0].detail.scope, [{ step: "evidence", fidelity: "full" }]);
});

test("a card that cites verified evidence, or is widened from it, is what makes the evidence step done — and then the programme moves on to the analysis run", async () => {
  for (const card of [
    { key: "control_median_pfs", version: 1, name: "对照组中位 PFS", sourceKind: "external_evidence", valueSource: "aggregate", poolingMethod: "random_effects_reml", evidenceIds: ["evd_1", "evd_2", "evd_3"], pooling: { calibre: "closest" } },
    { key: "dropout_rate", version: 1, name: "脱落率", sourceKind: "expert_set", valueSource: "assumed", evidenceIds: [], pooling: { basedOn: "evidence:evd_4", widenedBy: 2 } },
  ]) {
    const live = studyInMemory({ assumptions: [{ key: "hazard_ratio", version: 1, sourceKind: "scenario", evidenceIds: [], pooling: {} }, card] });
    await live.orchestrator.advance("std_live");
    assert.equal(live.steps().evidence.status, "done", card.key);
    assert.deepEqual(live.dispatched.map((run) => run.capabilityId), ["vcr-analysis"], `${card.key}: evidence needs no run; the analysis run is next`);
  }
});

test("while the platform pools this study's evidence the step reads running, and with no card yet it is neither done nor sent again", async () => {
  const live = studyInMemory({ assumptions: [], openJobs: [{ kind: "pool_evidence", state: "running", node: null }] });
  await live.orchestrator.advance("std_live");
  assert.equal(live.steps().evidence.status, "running", "a job of its own is open");
  assert.equal(live.dispatched.some((run) => run.capabilityId === "vcr-evidence"), false, "a step that reads running is not sent a second run");
});

// --- a run is dispatched for the products of the steps it is out for -----------------------------

test("a run names the contract kinds of the steps it covers, once each; a step whose capability produces one kind names none", () => {
  assert.deepEqual(vcrProductsOfSteps(["population", "patients", "comparator", "trial"]), ["vcr-cohort-snapshot", "vcr-comparator-analysis", "vcr-simulation-report"]);
  assert.deepEqual(vcrProductsOfSteps(["patients"]), ["vcr-cohort-snapshot"]);
  assert.deepEqual(vcrProductsOfSteps(["population", "patients"]), ["vcr-cohort-snapshot"], "two steps of one product are one product");
  assert.deepEqual(vcrProductsOfSteps(["trial", "comparator"]), ["vcr-comparator-analysis", "vcr-simulation-report"], "in the capability's order, not the caller's");
  for (const step of ["definition", "evidence", "matching", "not_a_step"]) assert.deepEqual(vcrProductsOfSteps([step]), [], step);
  assert.deepEqual(vcrProductsOfSteps([]), []);
});

test("a retry scoped to the patients is dispatched for the cohort snapshot alone; the first run for all four steps for all three products; the other steps' runs name none", async () => {
  // The live acceptance: the first analysis run left the patients failed, and the second was sent for them alone.
  const retry = studyInMemory({ assumptions: [{ key: "control_median_pfs", sourceKind: "external_evidence", evidenceIds: ["evd_1"], pooling: {} }],
    steps: { evidence: { status: "done" }, population: { status: "done" }, patients: { status: "failed" }, comparator: { status: "done" }, trial: { status: "done" }, matching: { status: "done" } } });
  await retry.orchestrator.advance("std_live");
  assert.equal(retry.dispatched.length, 1);
  assert.equal(retry.dispatched[0].capabilityId, "vcr-analysis");
  assert.equal(retry.dispatched[0].reason, "vcr:patients");
  assert.deepEqual(retry.dispatched[0].products, ["vcr-cohort-snapshot"], "the delivery gate holds this run to the cohort snapshot's files");
  assert.deepEqual(retry.state.claims[0].detail.scope, [{ step: "patients", fidelity: "full" }]);

  const first = studyInMemory({ assumptions: [{ key: "control_median_pfs", sourceKind: "external_evidence", evidenceIds: ["evd_1"], pooling: {} }], steps: { evidence: { status: "done" } } });
  await first.orchestrator.advance("std_live");
  assert.deepEqual(first.dispatched.map((run) => [run.capabilityId, run.products]), [["vcr-analysis", ["vcr-cohort-snapshot", "vcr-comparator-analysis", "vcr-simulation-report"]]]);

  // Definition, evidence and matching are single-product capabilities: nothing to narrow, so nothing named.
  const evidence = studyInMemory({ assumptions: [] });
  await evidence.orchestrator.advance("std_live");
  assert.equal(evidence.dispatched[0].capabilityId, "vcr-evidence");
  assert.equal(Object.hasOwn(evidence.dispatched[0], "products"), false);
});

// --- a step the allowance would not start says so, and starts by itself once it can ----------------

test("a step the allowance refuses stays queued and says what it waits on; once the allowance allows it, it runs and says nothing", async () => {
  /** @type {any[]} */ const asked = [];
  let refusal = "simulated_credits_exhausted";
  const live = studyInMemory({ dispatch: async (input) => {
    asked.push(input);
    if (refusal) throw Object.assign(new Error("The simulated allowance is too low."), { code: refusal });
    return { runId: "run_funded", sessionId: null };
  } });
  await live.orchestrator.advance("std_live");
  assert.equal(asked.length, 1, "the dispatch was attempted");
  const waiting = live.steps().evidence;
  assert.equal(waiting.status, "queued", "not failed, and not started");
  assert.equal(waiting.waiting, "simulated_allowance");
  assert.equal(waiting.note, "等模拟额度", "the rail says it in two words, marked 模拟");
  assert.equal(live.orchestrator.status().lastDeferral, "simulated_credits_exhausted");

  // The real wallet's refusal is the same wait, unmarked.
  const real = studyInMemory({ dispatch: async () => { throw Object.assign(new Error("credits"), { code: "credits_exhausted" }); } });
  await real.orchestrator.advance("std_live");
  assert.deepEqual([real.steps().evidence.waiting, real.steps().evidence.note], ["allowance", "等科研额度"]);

  // Anything else that defers is a queued step and nothing more: no wait on the allowance is invented for it.
  const busy = studyInMemory({ dispatch: async () => { throw Object.assign(new Error("cap"), { code: "runtime_limit_exceeded" }); } });
  await busy.orchestrator.advance("std_live");
  assert.equal(busy.steps().evidence.status, "queued");
  assert.equal(busy.steps().evidence.waiting ?? null, null);
  assert.equal(busy.steps().evidence.note, null);

  // Topped up: the next tick asks again, the step runs, and the wait is gone with its note.
  refusal = "";
  await live.orchestrator.advance("std_live");
  assert.equal(live.steps().evidence.status, "running");
  assert.equal(live.steps().evidence.runId, "run_funded");
  assert.equal(live.steps().evidence.waiting, null);
  assert.equal(live.steps().evidence.note, null);
});

test("a note the step has for another reason is not taken off with the allowance's wait", async () => {
  const live = studyInMemory({ steps: { evidence: { status: "queued", note: "三篇证据待补", waiting: null } } });
  await live.orchestrator.advance("std_live");
  assert.equal(live.steps().evidence.status, "running");
  assert.equal(live.steps().evidence.note, "三篇证据待补");
});

// --- matching is done by judgments against the criteria as they stand --------------------------------

test("above T0 the matching step is done by patients judged against the latest protocol version; an assessment of an earlier version does not count", async () => {
  const matching = (/** @type {Array<{ protocolVersionId: string | null }>} */ assessments) => studyInMemory({
    tier: "T1", protocol: { id: "pv2" }, criteria: 3, assessments,
    steps: { evidence: { status: "done" }, population: { status: "done" }, patients: { status: "done" }, comparator: { status: "done" }, trial: { status: "done" }, matching: { status: "none" } },
  });
  // Judged against the criteria now in force: the step is done.
  const current = matching([{ protocolVersionId: "pv1" }, { protocolVersionId: "pv2" }]);
  await current.orchestrator.advance("std_live");
  assert.equal(current.steps().matching.status, "done");
  assert.equal(current.dispatched.some((run) => run.capabilityId === "vcr-matching"), false, "nothing is sent for a step that is done");
  // Judged only against the version the protocol has since moved on from: the history is kept, the step is not done,
  // and the matching run goes out to judge the patients against the criteria as they stand.
  const superseded = matching([{ protocolVersionId: "pv1" }, { protocolVersionId: "pv1" }]);
  await superseded.orchestrator.advance("std_live");
  assert.notEqual(superseded.steps().matching.status, "done");
  assert.equal(superseded.dispatched.some((run) => run.capabilityId === "vcr-matching"), true);
  // An assessment that names no version is not one against these criteria either.
  const unversioned = matching([{ protocolVersionId: null }]);
  await unversioned.orchestrator.advance("std_live");
  assert.notEqual(unversioned.steps().matching.status, "done");
  // T0 has nobody's records to judge: the structured criteria are what the step is, whatever was assessed before.
  const t0 = studyInMemory({ tier: "T0", protocol: { id: "pv2" }, criteria: 3, assessments: [{ protocolVersionId: "pv1" }], steps: { matching: { status: "none" } } });
  await t0.orchestrator.advance("std_live");
  assert.equal(t0.steps().matching.status, "done");
});

// --- robustness methods ---

const CMP_BINARY = { ...CMP_T2, definition: { ...definition, endpointType: "binary" } };
/** The prognostic-score route needs the randomized trial's individual data (T3). */
const CMP_BINARY_T3 = { ...CMP_BINARY, study: { ...seedStudy, dataTier: "T3" } };
const COUNTS = { treatment: { n: 60, responders: 30, missing: 8 }, control: { n: 60, responders: 18, missing: 6 } };
const BINARY_TIPPING = { direction: "against_treatment", design: { kind: "two_arm" }, counts: COUNTS, analysis: { method: "fisher_exact" } };

test("a study's declared design reaches the robustness methods: negative controls, a tipping point and a prognostic score, never by a word", () => {
  // the declared score and the declared endpoint choose the prognostic job; a continuous endpoint stays with PROCOVA
  const prognostic = (/** @type {Record<string, any>} */ configuration, /** @type {Record<string, any>} */ ctx = {}) =>
    vcrJobKindFor("comparator", { route: "prognostic_adjustment", configuration }, { definition, ...ctx });
  assert.equal(prognostic({ endpoint: { type: "binary" }, prognosticScoreColumn: "score" }), "prognostic_adjustment_comparator");
  assert.equal(prognostic({ prognosticScoreColumn: "score" }), "prognostic_adjustment_comparator", "the study's own endpoint is time to event");
  assert.equal(prognostic({ endpoint: { type: "continuous" }, prognosticScoreColumn: "score" }), "procova");
  assert.equal(prognostic({ endpoint: { type: "binary" } }), "procova", "no declared score, no marginal-effect analysis");
  assert.equal(vcrJobKindFor("comparator", { route: "prognostic_adjustment" }), "procova", "the old default is untouched");

  // external control with negative controls: the comparison runs as it always did, and the screen is a second stage on the same adjustment
  const controls = [{ name: "骨折", column: "nc_fracture" }, { name: "白内障", column: "nc_cataract" }];
  const nc = planComparator({ covariates: ["age", "ecog"], tau: 12, parameterCode: "OS", snapshotId: "snp_1", negativeControls: controls });
  assert.equal(nc.ok, true, JSON.stringify(nc));
  assert.deepEqual(nc.stages.map((/** @type {any} */ entry) => [entry.stage, entry.jobKind]), [["primary", "weight_comparator"], ["negative_control", "negative_control_comparator"]]);
  assert.equal(nc.stages[0].scenario.negativeControls, undefined, "the primary reads only what it reads");
  assert.equal(nc.stages[1].snapshot, true, "controls are columns of the study's patients");
  assert.equal(nc.stages[1].scenario.endpoint, undefined, "the controls are 0/1 indicators whatever the primary's endpoint is");
  assert.equal(nc.stages[1].scenario.primary, undefined, "a time-to-event primary is not a column the screen can analyse");
  assert.deepEqual(nc.stages[1].scenario.controls, controls);
  assert.equal(nc.stages[1].scenario.weighting, "entropy_balance");
  assert.equal(nc.stages[1].scenario.estimand, "ATT");
  assert.deepEqual(nc.stages[1].scenario.covariates, ["age", "ecog"], "the same adjustment is the same covariates");
  for (const entry of nc.stages) assert.deepEqual(stageIssues(entry), [], entry.jobKind);
  // the adjustment the design names is the one the screen uses
  const ncPropensity = planComparator({ covariates: ["age"], method: "propensity", negativeControls: controls }, { estimand: "ATE" });
  assert.equal(ncPropensity.stages[1].scenario.weighting, "propensity");
  assert.equal(ncPropensity.stages[1].scenario.estimand, "ATE");
  assert.deepEqual(stageIssues(ncPropensity.stages[1]), []);
  // a binary primary's own outcome column is the effect of interest, analysed by the same adjustment, so the calibrated p-value is possible
  const ncBinary = planComparator({ covariates: ["age"], outcomeColumn: "response", method: "aipw", effectScale: "log_odds_ratio", negativeControls: controls }, {}, CMP_BINARY);
  assert.equal(ncBinary.ok, true, JSON.stringify(ncBinary));
  assert.deepEqual(ncBinary.stages[1].scenario.primary, { column: "response" });
  assert.equal(ncBinary.stages[1].scenario.effectScale, "log_odds_ratio");
  assert.deepEqual(stageIssues(ncBinary.stages[1]), []);
  // an empty list declares no controls, and nothing else is planned
  const none = planComparator({ covariates: ["age"], tau: 12, negativeControls: [] });
  assert.equal(none.ok, true, JSON.stringify(none));
  assert.deepEqual(none.stages.map((/** @type {any} */ entry) => [entry.stage, entry.jobKind]), [[null, "weight_comparator"]]);

  // a tipping point: counts need no patients, a time-to-event analysis always does
  const tipBinary = planComparator({ covariates: ["age"], outcomeColumn: "response", method: "aipw", snapshotId: "snp_1", tippingPoint: BINARY_TIPPING }, {}, CMP_BINARY);
  assert.equal(tipBinary.ok, true, JSON.stringify(tipBinary));
  assert.deepEqual(tipBinary.stages.map((/** @type {any} */ entry) => [entry.stage, entry.jobKind, entry.snapshot]),
    [["primary", "aipw_comparator", true], ["tipping_point", "tipping_point", false]]);
  assert.deepEqual(tipBinary.stages[1].scenario.endpoint, { type: "binary" });
  for (const entry of tipBinary.stages) assert.deepEqual(stageIssues(entry), [], entry.jobKind);
  const tipColumn = planComparator({ covariates: ["age"], snapshotId: "snp_1", tippingPoint: { direction: "against_treatment", design: { kind: "two_arm" }, outcomeColumn: "response",
    analysis: { method: "risk_difference", alpha: 0.05, sided: 2 } } }, {}, CMP_BINARY);
  assert.equal(tipColumn.stages[1].snapshot, true, "an outcome column is read from the study's patients");
  assert.deepEqual(stageIssues(tipColumn.stages[1]), []);
  const tipSurvival = planComparator({ covariates: ["age", "ecog"], tau: 12, parameterCode: "OS", snapshotId: "snp_1", method: "weighted_cox",
    tippingPoint: { horizon: 24, deltas: [1, 2, 4, 8], direction: "against_treatment" } });
  assert.equal(tipSurvival.ok, true, JSON.stringify(tipSurvival));
  assert.deepEqual(tipSurvival.stages.map((/** @type {any} */ entry) => [entry.stage, entry.jobKind, entry.snapshot]),
    [["primary", "weighted_cox_comparator", true], ["tipping_point", "tipping_point", true]]);
  assert.deepEqual(stageIssues(tipSurvival.stages[1]), []);

  // everything declared at once: the comparison, then each analysis, each named
  const all = planComparator({ covariates: ["age"], tau: 12, parameterCode: "OS", snapshotId: "snp_1", negativeControls: controls,
    tippingPoint: { horizon: 24, deltas: [1, 2, 4] } });
  assert.deepEqual(all.stages.map((/** @type {any} */ entry) => entry.stage), ["primary", "negative_control", "tipping_point"]);

  // the prognostic-score route: a binary and a time-to-event endpoint, optionally with the other analyses beside it
  const binary = planComparator({ endpoint: { type: "binary" }, prognosticScoreColumn: "score", covariates: ["age"], outcomeColumn: "y", snapshotId: "snp_1" },
    { route: "prognostic_adjustment" }, CMP_BINARY_T3);
  assert.equal(binary.ok, true, JSON.stringify(binary));
  assert.deepEqual(binary.stages.map((/** @type {any} */ entry) => [entry.stage, entry.jobKind, entry.snapshot]), [[null, "prognostic_adjustment_comparator", true]]);
  assert.deepEqual(stageIssues(binary.stages[0]), []);
  const survival = planComparator({ prognosticScoreColumn: "score", tau: 12, parameterCode: "OS", snapshotId: "snp_1", tippingPoint: { horizon: 24, deltas: [1, 2, 4] } },
    { route: "prognostic_adjustment" }, { ...CMP_T2, study: { ...seedStudy, dataTier: "T3" } });
  assert.equal(survival.ok, true, JSON.stringify(survival));
  assert.deepEqual(survival.stages.map((/** @type {any} */ entry) => [entry.stage, entry.jobKind]), [["primary", "prognostic_adjustment_comparator"], ["tipping_point", "tipping_point"]]);
  for (const entry of survival.stages) assert.deepEqual(stageIssues(entry), [], entry.jobKind);
});

test("a robustness declaration the endpoint or the design cannot support is refused in a sentence, and a key nobody reads is refused by name", () => {
  const refused = (/** @type {any} */ plan, /** @type {string} */ code, /** @type {RegExp} */ words) => {
    assert.equal(plan.ok, false, JSON.stringify(plan));
    assert.equal(plan.refused.code, code);
    assert.match(plan.refused.message, words);
    return plan.refused;
  };
  const continuous = { ...CMP_T2, definition: { ...definition, endpointType: "continuous" } };
  refused(planComparator({ covariates: ["age"], tippingPoint: BINARY_TIPPING }, {}, continuous), "vcr_job_scenario_invalid", /二分类和事件时间终点/);
  refused(planComparator({ covariates: ["age"], tippingPoint: true }, {}, CMP_BINARY), "vcr_job_scenario_invalid", /tippingPoint 要写成一个对象/);
  refused(planComparator({ covariates: ["age"], tippingPoint: BINARY_TIPPING }, {}, { ...CMP_T2, definition: null }), "vcr_scenario_endpoint_missing", /终点类型/);
  // a binary prognostic route with no declared score says what to declare instead of reaching the engine's refusal
  refused(planComparator({ endpoint: { type: "binary" }, outcomeColumn: "y" }, { route: "prognostic_adjustment" }, CMP_BINARY_T3), "vcr_job_scenario_invalid", /prognosticScoreColumn/);
  // a number the design states in place of a column would be a result nobody computed: refused, and the sentence says what to write
  refused(planComparator({ covariates: ["age"], tau: 12, negativeControls: [{ name: "a", estimate: 0.05, se: 0.1 }] }), "vcr_job_scenario_invalid", /column/);
  refused(planComparator({ covariates: ["age"], tau: 12, negativeControls: [{ column: "nc_a" }] }), "vcr_job_scenario_invalid", /name 和 column/);
  // a key the declaration wrote and its method does not read is the declaration's own: refused, not dropped
  const typo = refused(planComparator({ covariates: ["age"], tau: 12, negativeControls: [{ name: "a", column: "nc_a", scale: "log" }] }), "vcr_scenario_unknown_fields", /引擎不读的字段/);
  assert.ok(typo.paths.some((/** @type {string} */ path) => path.includes("scale")), JSON.stringify(typo.paths));
  const tipTypo = refused(planComparator({ covariates: ["age"], tippingPoint: { ...BINARY_TIPPING, horizon: 24 } }, {}, CMP_BINARY), "vcr_scenario_unknown_fields", /引擎不读的字段/);
  assert.ok(tipTypo.paths.includes("horizon"), "a time-to-event key on a binary tipping point");
  // a design-level typo is still found when robustness stages are planned beside the comparison
  const design = refused(planComparator({ covarites: ["age"], covariates: ["age"], tau: 12, negativeControls: [{ name: "a", column: "nc_a" }] }), "vcr_scenario_unknown_fields", /covarites/);
  assert.ok(design.paths.includes("covarites"));
  // `effectScale` belongs to the negative-control job, and a typed primary effect belongs to no job: nobody reads them
  refused(planComparator({ covariates: ["age"], tau: 12, effectScale: "log_risk_ratio" }), "vcr_scenario_unknown_fields", /effectScale/);
  refused(planComparator({ covariates: ["age"], tau: 12, primary: { estimate: 0.1, se: 0.1 }, negativeControls: [{ name: "a", column: "nc_a" }] }), "vcr_scenario_unknown_fields", /primary/);
  // a literature or hybrid control reads neither declaration
  refused(planComparator({ method: "maic", endpoint: { type: "binary" }, covariates: ["age"], targets: { age: 60 }, negativeControls: [{ name: "a", column: "nc_a" }] },
    { route: "literature_control" }, { ...CMP_T2, study: { ...seedStudy, dataTier: "T1" } }),
    "vcr_scenario_unknown_fields", /negativeControls/);
});

// --- end robustness methods ---
