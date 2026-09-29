// 「虚拟临研」's program rules without a database: what a program wants, which
// job a research object needs, the dispatch tag a run carries, and the five
// notices — their kinds, their titles and who hears them.
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_ACCRUAL_TOLERANCE, VCR_ANALYSIS_STEPS, VCR_RUN_CAPABILITIES, vcrDispatchId, vcrJobKindFor, vcrProgramSteps,
  vcrRunId, vcrRunPrompt, wantedVcrSteps,
} from "../src/vcrOrchestrator.mjs";
import { VCR_NOTICE_KINDS, createVcrNotifier, vcrNoticeHref, vcrStudyName } from "../src/vcrNotify.mjs";
import { VCR_NOTIFICATION_KINDS, VCR_STEPS, VCR_STEP_CAPABILITIES, VCR_STEP_NEEDS } from "@evimed/domain";

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

test("which engine job a research object needs is deterministic", () => {
  assert.equal(vcrJobKindFor("population", { kind: "real" }), "build_cohort");
  assert.equal(vcrJobKindFor("population", { kind: "empirical_synthetic" }), "synthesize_population");
  assert.equal(vcrJobKindFor("population", { kind: "literature" }), "generate_population");
  assert.equal(vcrJobKindFor("patient_set", {}), "generate_patients");
  assert.equal(vcrJobKindFor("comparator", { route: "external_control" }), "weight_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "prognostic_adjustment" }), "weight_comparator");
  assert.equal(vcrJobKindFor("comparator", { route: "literature_control" }), "reconstruct_km",
    "a literature control has no rows to read; it rebuilds the published curve");
  assert.equal(vcrJobKindFor("comparator", { route: "model_comparator" }), "rmst");
  assert.equal(vcrJobKindFor("comparator", { route: "hybrid_control" }), "map_prior");
  assert.equal(vcrJobKindFor("trial_scenario", {}), "design_simulation");
  assert.equal(vcrJobKindFor("trial_scenario", { configuration: { analytic: true } }), "design_analytic");
  // A configuration may name a method, but only one the engine publishes.
  assert.equal(vcrJobKindFor("trial_scenario", { configuration: { jobKind: "assurance" } }), "assurance");
  assert.equal(vcrJobKindFor("trial_scenario", { configuration: { jobKind: "make_it_up" } }), "design_simulation");
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
  assert.equal(vcrNoticeHref("std_1/matching/ref_1"), "/app/virtual-research/std_1/matching/ref_1");
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
