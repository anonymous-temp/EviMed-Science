// 「虚拟临研」's seven-step program on PostgreSQL with everything around it
// faked — the dispatch of a run, a run doing what a run does (writing through
// the gateway's own write path), the engine, the inbox: a T0 study from one
// sentence to a finished package, a single step's minimal path, a changed
// assumption propagating, a review going stale, a registered forecast, and a
// result whose intended use its models cannot carry.
//
// Its own database: the orchestrator's tick reads every study, so a shared
// database would let it advance another suite's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrStore, vcrObjectNode } from "../src/vcrStore.mjs";
import { VcrJobs, vcrScenarioHash } from "../src/vcrJobs.mjs";
import { VcrOrchestrator } from "../src/vcrOrchestrator.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { createVcrNotifier } from "../src/vcrNotify.mjs";
import { createVcrSeal } from "../src/vcrSeal.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { VCR_STEPS, lineageNode } from "@evimed/domain";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {VcrStore} */
let store;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrorch_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
});

after(async () => {
  await database?.close().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

const config = {
  vcrEnabled: true, vcrAudience: "all", vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 100_000,
  vcrMaxConcurrentJobs: 4, vcrLeaseMs: 900_000,
};

/** @param {string} jobId @param {Record<string, any>} [overrides] */
function engineResult(jobId, overrides = {}) {
  return {
    jobId, protocolVersion: 1, status: "succeeded", method: "design.simulate", methodVersion: "1.0.0",
    scenarioHash: "a".repeat(64), seed: 20260928, replicates: 20000,
    counts: { realPatients: null, events: 138, effectiveSampleSize: null, generatedRecords: 3_600_000 },
    measures: [{ name: "power", value: 0.712, simulated: true, mcse: 0.0031, interval: { kind: "monte_carlo", low: 0.706, high: 0.718 } }],
    diagnostics: {}, tables: [],
    manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "b".repeat(64),
      startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:00:42Z", cpuSeconds: 12, outputHash: "c".repeat(64) },
    ...overrides,
  };
}

/**
 * The whole module, composed the way `server.mjs` composes it, with the four
 * things outside it faked: the dispatcher, the engine, the inbox and the
 * researcher project.
 * @param {{ resultFor?: (job: any) => Record<string, any> }} [options]
 */
function compose({ resultFor = (job) => engineResult(job.id) } = {}) {
  /** @type {any[]} */
  const dispatched = [];
  /** @type {any[]} */
  const notices = [];
  const engine = {
    configured: () => true,
    async submit(job) { return { jobId: `engine-${job.jobId}`, accepted: true }; },
    async status() { return { state: "succeeded", progress: { done: 1, total: 1 }, cpuSeconds: 12 }; },
    async cancel() { return { canceled: true }; },
    async result(id) {
      const jobId = String(id).replace(/^engine-/, "");
      const row = await store.one("SELECT * FROM evimed_vcr.jobs WHERE id = $1", [jobId]);
      return { result: resultFor({ id: jobId, kind: String(row?.kind ?? ""), scenario: row?.scenario ?? {} }), signed: true };
    },
    async health() { return { ok: true, methods: [], engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "" }; },
  };
  const jobs = new VcrJobs({ store, config, engine });
  const notifier = createVcrNotifier({
    notifications: { async create(userId, input) { notices.push({ userId, ...input }); return { id: `n_${notices.length}` }; } },
    store, config,
  });
  const seal = createVcrSeal({ store });
  const orchestrator = new VcrOrchestrator({
    store, jobs, config, notifier, seal,
    async dispatchRun(input) {
      dispatched.push(input);
      return { runId: `run_${dispatched.length}`, sessionId: `ses_${dispatched.length}` };
    },
  });
  jobs.notifier = notifier;
  const service = new VcrService({ store, config, engine, jobs });
  return { dispatched, notices, engine, jobs, notifier, seal, orchestrator, service };
}

/** Run every queued job to completion, the way the worker's `jobs` loop does. */
async function drainJobs(module) {
  for (let pass = 0; pass < 12; pass += 1) {
    const claimed = await module.jobs.claim({ limit: 8 });
    if (!claimed.length) break;
    for (const job of claimed) {
      await module.jobs.advance(job);
      const outcome = await module.jobs.advance(job);
      if (outcome?.action === "finished") await module.orchestrator.onJobFinished({ job: outcome.job, result: outcome.result });
    }
  }
}

/**
 * One AI run: the orchestrator dispatches it, the run writes what a run of
 * that capability writes (through the very same write path the runtime uses),
 * the ledger reports it finished, and the platform computes what it queued.
 * @param {any} module @param {any} study @param {(write: (what: string, payload: any) => Promise<any>) => Promise<unknown>} body
 */
async function runTurn(module, study, body) {
  // A run may already be out: a run finishing advances the study itself, which
  // is how a programme keeps moving without waiting for the next tick.
  await module.orchestrator.advance(study.id);
  const dispatch = module.dispatched[module.dispatched.length - 1];
  assert.ok(dispatch, "the orchestrator dispatched nothing");
  /** @param {string} what @param {any} payload */
  const write = async (what, payload) => vcrRuntimeWrite({
    store, service: module.service, orchestrator: module.orchestrator, study,
    what, items: Array.isArray(payload) ? payload : null, data: Array.isArray(payload) ? null : payload,
  });
  await body(write);
  await module.orchestrator.onRunFinished(
    { userId: study.userId, id: study.projectId },
    { id: `run_${module.dispatched.length}`, dispatchId: dispatch.dispatchId, status: "succeeded" },
  );
  await drainJobs(module);
  await module.orchestrator.advance(study.id);
  return dispatch;
}

/** @param {string} label */
async function makeStudy(label, patch = {}) {
  const study = await store.createStudy({
    userId: `u_${label}`, projectId: `prj_${label}`, name: `EV-201 ${label}`,
    question: "单臂 II 期能不能用外部对照，还是必须做随机？", dataTier: "T0", ...patch,
  });
  return study;
}

const definition = {
  pico: { population: "二线 NSCLC", intervention: "EV", comparator: "化疗", outcome: "PFS" },
  estimand: { population: "二线 NSCLC", variable: "PFS", treatment: "EV 单药",
    intercurrentEvents: [{ event: "后续抗肿瘤治疗", strategy: "treatment_policy" }], summary: "风险比" },
  endpointType: "time_to_event",
  fieldSources: { endpointType: "AI 设定：按主要终点的测量方式" },
};

test("AC-01 AC-35 a T0 study runs from one sentence to a finished package, and every step is read from the data", options, async () => {
  const module = compose();
  // 「新建研究」 with a question: the study asks for the whole programme, which
  // is what makes 一句话到研究包 the default path rather than seven clicks.
  const created = await module.service.createStudy({ id: "u_t0" }, {
    name: "EV-201 t0", question: "单臂 II 期能不能用外部对照，还是必须做随机？", dataTier: "T0",
  }, {
    async createResearcherProject() { return { id: "prj_t0", name: "EV-201 t0" }; },
    async bindSession() { return { sessionId: "ses_0", bound: true }; },
  });
  assert.deepEqual([...created.requested], [...VCR_STEPS], "a study created from a question wants all seven steps");
  const study = await store.studyById(created.id);

  // The first thing the programme does is the first step.
  await module.orchestrator.advance(study.id);
  assert.equal(module.dispatched.length, 1, "one run at a time, and it is the first step");
  assert.equal(module.dispatched[0].capabilityId, "vcr-protocol");
  assert.match(module.dispatched[0].brief, /单臂 II 期能不能用外部对照/);
  assert.match(module.dispatched[0].brief, /vcr_simulate/, "the brief tells the run where numbers come from");

  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId },
    { id: "run_1", dispatchId: module.dispatched[0].dispatchId, status: "succeeded" });

  let current = await store.studyById(study.id);
  assert.equal(current.steps.definition.status, "done", "read from the definition row, not from the run's word");

  await runTurn(module, study, async (write) => {
    const written = await write("assumption", [
      { key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 4.1, unit: "月", sourceKind: "external_evidence",
        valueSource: "aggregate", evidenceIds: ["evd_1"], distribution: { kind: "lognormal", meanlog: 1.41, sdlog: 0.18 } },
      { key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" },
      { key: "dropout_rate", name: "脱落率", pointValue: 0.1, sourceKind: "expert_set", valueSource: "assumed" },
    ]);
    assert.equal(written.ok, true);
    assert.equal(written.ids.length, 3);
  });
  assert.equal(module.dispatched[1].capabilityId, "vcr-evidence");
  current = await store.studyById(study.id);
  assert.equal(current.steps.evidence.status, "done");

  // The analysis run covers the four steps it is wanted for, in one turn.
  const analysis = await runTurn(module, study, async (write) => {
    await write("population", { kind: "literature", name: "文献人群", definition: { source: "三项主要先例的基线表" } });
    await write("patient_set", { name: "2000 名虚拟患者", modelId: "reference-time-to-event", modelVersion: "1.0.0",
      scenario: { n: 2000 } });
    await write("comparator", { route: "literature_control", estimand: "ATT",
      configuration: { endpoint: { type: "time_to_event" } } });
    await write("trial_scenario", [
      { label: "A 单臂 + 文献对照", design: "single_arm_external", endpointType: "time_to_event",
        configuration: { truth: { hazardRatio: 0.7 }, accrual: { months: 24 } }, assumptionIds: ["hazard_ratio"] },
      { label: "B 2:1 随机", design: "two_arm_fixed", endpointType: "time_to_event",
        configuration: { truth: { hazardRatio: 0.7 }, design: { allocation: "2:1" } } },
    ]);
  });
  assert.equal(analysis.capabilityId, "vcr-analysis");
  assert.deepEqual(analysis.detail ?? null, null, "the dispatch carries only what the run needs");

  current = await store.studyById(study.id);
  for (const step of ["population", "patients", "comparator", "trial"]) {
    assert.equal(current.steps[step].status, "done", `${step} is done once its result is stored`);
  }
  const results = await store.results(study.id);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["comparator", "patient_set", "population", "trial_scenario"]);
  for (const result of results) {
    assert.equal(result.measures[0].mcse, 0.0031, "every simulated measure carries its Monte-Carlo error");
    assert.equal(result.counts.realPatients, null, "nothing was counted at T0 — null, never 0");
  }

  // The lineage was written on the way: the assumptions and the definition are
  // upstream of the trial scenario the platform computed.
  const edges = await store.edges(study.id);
  const scenarios = await store.trialScenarios(study.id);
  const scenarioNode = vcrObjectNode("trial_scenario", scenarios[0]);
  assert.ok(edges.some((edge) => edge.to === scenarioNode && edge.from.startsWith("assumption:")));
  assert.ok(edges.some((edge) => edge.from === scenarioNode && edge.to.startsWith("result:")));

  // Step 7 is wanted too: the run structures the protocol's eligibility, and
  // the step stays open because a T0 study has nobody to match — which is a
  // true statement about the study, not a failure of the programme.
  const matching = await runTurn(module, study, async (write) => {
    await write("protocol", { title: "EV-201 v1.0", criteria: [
      { kind: "inclusion", criterionType: "diagnosis", requirement: { field: "histology", op: "=", value: "nsclc" },
        sourceText: "经组织学确诊的非小细胞肺癌", sourceLocator: { page: 12 } },
    ] });
  });
  assert.equal(matching.capabilityId, "vcr-matching");
  current = await store.studyById(study.id);
  assert.equal(current.steps.matching.status, "running", "structured, but nobody to match at T0");

  // The package: an export run, and one notice when it is ready.
  const exported = await module.orchestrator.requestExport({ id: study.userId }, study, "study_package");
  assert.equal(exported.export.state, "queued");
  await module.orchestrator.advance(study.id);
  const packageDispatch = module.dispatched[module.dispatched.length - 1];
  assert.equal(packageDispatch.capabilityId, "vcr-package");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "report", items: null,
    data: { kind: "study_package", template: "方案 B 的功效为 {{n:results.trial_scenario.measures[0].value|pct1}}。" } });
  await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId },
    { id: "run_x", dispatchId: packageDispatch.dispatchId, status: "succeeded" });

  const rows = await store.exports(study.id);
  assert.equal(rows[0].state, "ready");
  assert.equal(rows[0].cover.reviewed, false, "the cover says what is true: nobody has reviewed it");
  assert.equal(rows[0].cover.staleResults, 0);
  assert.match(rows[0].cover.report.rendered, /功效为 71\.2%/, "the number was rendered from the result");

  const ready = module.notices.filter((notice) => notice.title.includes("研究包完成"));
  assert.equal(ready.length, 1, "one notice, once");
  assert.equal(ready[0].userId, study.userId);
});

test("AC-33 everything the run set carries the AI-set label until a person countersigns it", options, async () => {
  const module = compose();
  const study = await makeStudy("aiset");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "assumption", items: [{ key: "dropout_rate", pointValue: 0.1, sourceKind: "expert_set" }], data: null });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "population", items: null, data: { kind: "scenario", name: "情景人群" } });

  assert.equal((await store.latestDefinition(study.id)).reviewState, "ai_set");
  assert.equal((await store.assumptions(study.id))[0].reviewState, "ai_set");
  assert.equal((await store.latestPopulation(study.id)).reviewState, "ai_set");
  // And the value is in force the moment it is written: nothing waits.
  assert.equal((await store.assumptions(study.id))[0].pointValue, 0.1);
});

test("AC-05 a protocol revision is a new version, and the old one is still readable", options, async () => {
  const module = compose();
  const study = await makeStudy("protocol");
  const first = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "protocol", items: null,
    data: { title: "EV-201 v1.0", criteria: [
      { kind: "inclusion", criterionType: "performance_status", requirement: { field: "ecog", op: "<=", value: 1 },
        sourceText: "ECOG 体能状态 0–1", sourceLocator: { page: 12 } },
      { kind: "exclusion", criterionType: "comorbidity", requirement: { free_text: "活动性脑转移" },
        sourceText: "有活动性脑转移者", sourceLocator: { page: 13 }, evidenceNeeded: ["头颅 MRI"] },
    ] } });
  assert.equal(first.ok, true);
  const v1 = await store.latestProtocolVersion(study.id);
  assert.equal(v1.version, 1);
  const v1Criteria = await store.criteria(v1.id);
  assert.equal(v1Criteria.length, 2);
  assert.equal(v1Criteria[0].sourceText, "ECOG 体能状态 0–1", "the sentence it came from is kept beside it");

  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "criteria", items: null,
    data: { criteria: [
      { kind: "inclusion", criterionType: "performance_status", requirement: { field: "ecog", op: "<=", value: 2 },
        sourceText: "ECOG 体能状态 0–2（v1.1 修订）", sourceLocator: { page: 12 } },
    ] } });
  const v2 = await store.latestProtocolVersion(study.id);
  assert.equal(v2.version, 2);
  assert.notEqual(v2.id, v1.id);
  // The old version and its criteria are untouched: an assessment made against
  // v1 still resolves to what v1 said.
  const stillThere = await store.criteria(v1.id);
  assert.equal(stillThere.length, 2);
  assert.equal(stillThere[0].requirement.value, 1);
  assert.equal((await store.criteria(v2.id))[0].requirement.value, 2);
});

test("AC-16 a changed assumption marks everything downstream stale — and deletes nothing", options, async () => {
  const module = compose();
  const study = await makeStudy("stale");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "assumption", items: [{ key: "dropout_rate", name: "脱落率", pointValue: 0.1, sourceKind: "expert_set" }], data: null });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "trial_scenario", items: null,
    data: { label: "A", design: "two_arm_fixed", endpointType: "time_to_event", configuration: { truth: { hazardRatio: 0.7 } } } });
  await module.orchestrator.advance(study.id);
  await drainJobs(module);
  await module.orchestrator.advance(study.id);

  const before = await store.results(study.id, "trial_scenario");
  assert.equal(before.length, 1);
  const resultNode = lineageNode("result", before[0].id, before[0].version);

  // 脱落率 from 10% to 15%: a new assumption version, and the plan says what it reaches.
  const changed = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "assumption", items: [{ key: "dropout_rate", name: "脱落率", pointValue: 0.15, sourceKind: "expert_set" }], data: null });
  assert.equal(changed.ok, true);

  const marks = await store.staleMarks(study.id);
  assert.ok(marks.length >= 2, `expected the scenario and its result to be stale, got ${marks.length}`);
  assert.ok(marks.every((mark) => mark.reason === "assumption_changed"));
  assert.ok(marks.some((mark) => mark.node === resultNode), "the result the assumption fed is stale");

  // The stale result still has its numbers and its page.
  const kept = await store.result(study.id, before[0].id);
  assert.equal(kept.measures[0].value, 0.712);
  assert.equal(kept.conclusion, "estimable");

  // And the page says so, with the reason attached rather than the row hidden.
  const view = await module.service.studyViewOf(await store.studyById(study.id));
  const shown = view.results.find((result) => result.id === before[0].id);
  assert.ok(shown, "a stale result is still on the page");
  assert.equal(shown.stale.reason, "assumption_changed");
  assert.equal(view.stale.length, marks.length);
});

test("AC-21 a review countersigns one version, and reads as changed once that version moves", options, async () => {
  const module = compose();
  const study = await makeStudy("review");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "assumption", items: [{ key: "hazard_ratio", pointValue: 0.7, sourceKind: "expert_set" }], data: null });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "trial_scenario", items: null,
    data: { label: "A", design: "two_arm_fixed", endpointType: "time_to_event", configuration: {} } });
  await module.orchestrator.advance(study.id);
  await drainJobs(module);
  await module.orchestrator.advance(study.id);

  const [result] = await store.results(study.id, "trial_scenario");
  const node = lineageNode("result", result.id, result.version);
  await store.addReview({ studyId: study.id, userId: study.userId, kind: "statistical", nodes: [node],
    reviewer: "zhang", note: "针对运行 #12" });

  let view = await module.service.studyViewOf(await store.studyById(study.id));
  assert.equal(view.review.reviewed, true);
  assert.equal(view.review.records[0].state, "reviewed");
  // An unreviewed package cannot claim 「指定研究分析」; a reviewed one may.
  assert.equal(view.intendedUseCeiling.ceiling, "submission_preparation");

  // The assumption moves: the version the review countersigned is no longer current.
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "assumption", items: [{ key: "hazard_ratio", pointValue: 0.65, sourceKind: "expert_set" }], data: null });
  view = await module.service.studyViewOf(await store.studyById(study.id));
  assert.equal(view.review.records[0].state, "changed_after_review", "the review did not change; the world did");

  // And a study nobody reviewed cannot be labelled a specified analysis.
  const unreviewed = await makeStudy("unreviewed");
  const bare = await module.service.studyViewOf(unreviewed);
  assert.equal(bare.intendedUseCeiling.ceiling, "design_support");
  assert.ok(bare.intendedUseCeiling.reasons.some((reason) => reason.code === "not_reviewed"));
});

test("AC-23 a forecast is registered with its hash before the outcome, and a change is a new version", options, async () => {
  const module = compose();
  const study = await makeStudy("forecast");
  const first = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "forecast", items: null,
    data: { kind: "accrual", prediction: { enrolled: 120, byMonth: "2027-03", interval: { kind: "prediction", low: 96, high: 141 } } } });
  assert.equal(first.ok, true);
  const [registered] = await store.forecasts(study.id);
  assert.match(registered.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(registered.version, 1);
  assert.equal(registered.actual, null, "registered before the outcome exists");

  // A changed prediction is a new version with its own hash: the first one stands.
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "forecast", items: null, data: { kind: "accrual", prediction: { enrolled: 96, byMonth: "2027-03" } } });
  const all = await store.forecasts(study.id);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((row) => row.version).sort(), [1, 2]);
  assert.notEqual(all[0].payloadHash, all[1].payloadHash);

  // The actual arrives and is compared against what was registered; a drift
  // past the study's tolerance is one of the five notices.
  const current = all.find((row) => row.version === 2);
  await store.compareForecast(current.id, { enrolled: 60, asOf: "2027-03" });
  await module.orchestrator.advance(study.id);
  const drift = module.notices.filter((notice) => notice.title.includes("实际入组偏离预测"));
  assert.equal(drift.length, 1);
  assert.match(drift[0].body, /预测 96 例，实际 60 例/);
});

test("AC-34 a result never claims a use its weakest model can carry, and says why it was lowered", options, async () => {
  const module = compose();
  const study = await makeStudy("downgrade", { intendedUse: "specified_analysis" });

  const carried = await store.recordResult({
    studyId: study.id, userId: study.userId, kind: "trial_scenario", conclusion: "estimable",
    counts: { realPatients: null, events: 138, effectiveSampleSize: null, generatedRecords: 2000 },
    measures: [{ name: "power", value: 0.71, simulated: true, mcse: 0.003 }],
    models: [{ name: "fitted-weibull", tier: "data", risk: "low",
      evidence: ["code_verification", "seed_reproducible", "input_traceable", "sensitivity_analysis"] }],
    requestedUse: "specified_analysis",
  });
  assert.equal(carried.intendedUse, "specified_analysis", "a data-tier model with its low-risk evidence carries it");
  assert.equal(carried.useDowngrade, null);

  const lowered = await store.recordResult({
    studyId: study.id, userId: study.userId, kind: "comparator", conclusion: "estimable",
    counts: { realPatients: null, events: 41, effectiveSampleSize: null, generatedRecords: 0 },
    measures: [],
    models: [{ name: "literature-weibull", tier: "literature", risk: "low", evidence: ["code_verification", "seed_reproducible"] }],
    requestedUse: "specified_analysis",
  });
  assert.equal(lowered.intendedUse, "exploratory", "a literature model short of its own evidence carries less than its tier");
  assert.equal(lowered.useDowngrade.requested, "specified_analysis");
  assert.equal(lowered.useDowngrade.reason, "model_evidence_missing");
  assert.deepEqual(lowered.useDowngrade.missingEvidence[0].missing, ["input_traceable", "sensitivity_analysis"]);

  const scenarioOnly = await store.recordResult({
    studyId: study.id, userId: study.userId, kind: "patient_set", conclusion: "estimable",
    counts: { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: 2000 }, measures: [],
    models: [{ name: "reference-time-to-event", tier: "scenario", risk: "none", evidence: ["code_verification", "seed_reproducible"] }],
    requestedUse: "specified_analysis",
  });
  assert.equal(scenarioOnly.intendedUse, "exploratory");
  assert.equal(scenarioOnly.useDowngrade.reason, "model_tier_ceiling");
  // Nothing was withheld: the result is on the page, labelled down with its reason.
  const view = await module.service.studyViewOf(await store.studyById(study.id));
  assert.equal(view.results.length, 3);
  assert.ok(view.results.every((result) => result.intendedUse));
  // Every model a result used travels with it whether or not it lowered the
  // use, so the study's own ceiling is read from all of them and not only
  // from the ones that happened to force a downgrade.
  assert.deepEqual(view.results.find((result) => result.kind === "trial_scenario").diagnostics.modelsUsed.map((model) => model.tier),
    ["data"]);
  assert.equal(view.intendedUseCeiling.ceiling, "exploratory", "the weakest model this study used decides");
  assert.ok(view.intendedUseCeiling.reasons.some((reason) => reason.code === "model_tier"));
});

test("a single step brings its upstream as a minimal version, and asking for it in full redoes it", options, async () => {
  const module = compose();
  const study = await makeStudy("minimal");
  // 「这个单臂试验能不能用外部对照？」 — the comparator step, and a definition under it.
  await module.orchestrator.runStep({ id: study.userId }, study, "comparator");
  assert.equal(module.dispatched[0].capabilityId, "vcr-protocol", "the minimal upstream comes first");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId },
    { id: "run_1", dispatchId: module.dispatched[0].dispatchId, status: "succeeded" });

  let current = await store.studyById(study.id);
  assert.equal(current.steps.definition.status, "minimal", "补出来的部分标「AI 设定」, and the page says it is minimal");
  assert.equal(current.steps.evidence.status, "none", "a step nobody wanted was not started");

  await module.orchestrator.advance(study.id);
  assert.equal(module.dispatched[1].capabilityId, "vcr-analysis");

  // Now the researcher asks for the definition in full: it is redone, and what
  // was done already is not.
  await module.orchestrator.runStep({ id: study.userId }, study, "definition");
  current = await store.studyById(study.id);
  assert.equal(current.steps.definition.requested, true);
});

test("a study that is paused dispatches nothing and queues nothing", options, async () => {
  const module = compose();
  const study = await makeStudy("paused");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await store.updateStudy(study.id, { status: "paused" }, study.userId);
  const result = await module.orchestrator.advance(study.id);
  assert.deepEqual(result, { skipped: "paused" });
  assert.equal(module.dispatched.length, 0);
  await assert.rejects(module.orchestrator.runStep({ id: study.userId }, study, "definition"),
    (/** @type {any} */ error) => error.code === "vcr_study_paused");
});

test("a job kind that needs patient-level rows without a snapshot is skipped by name, and the study goes on", options, async () => {
  const module = compose();
  const study = await makeStudy("nosnapshot", { dataTier: "T2" });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "population", items: null, data: { kind: "real", name: "真实队列", definition: { source: "上传的队列" } } });
  await module.orchestrator.advance(study.id);

  const jobs = await store.jobs(study.id);
  assert.equal(jobs.length, 0, "a cohort build with no snapshot grant is never queued");
  const current = await store.studyById(study.id);
  assert.match(String(current.steps.population.note), /数据快照/);
  const mark = await store.one("SELECT * FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND kind = 'job'", [study.id]);
  assert.equal(mark.state, "skipped");
  assert.equal(mark.detail.reason, "no_snapshot");
});

test("a not-estimable comparator is a finished step and one notice, not a failure", options, async () => {
  const module = compose();
  const study = await makeStudy("notestimable");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "comparator", items: null,
    data: { route: "external_control", estimand: "ATT", conclusion: "not_estimable",
      gapList: [{ field: "concomitant_therapy", missingFor: 0.62 }] } });
  await module.orchestrator.advance(study.id);

  const current = await store.studyById(study.id);
  assert.equal(current.steps.comparator.status, "done", "「不可估计」 is finished work");
  assert.equal((await store.jobs(study.id)).filter((job) => job.kind === "weight_comparator").length, 0,
    "a route the run already judged unusable is not computed anyway");

  // The notice comes from a recorded result, which is what a reader opens.
  const recorded = await store.recordResult({
    studyId: study.id, userId: study.userId, kind: "comparator", conclusion: "not_estimable",
    notEstimableRule: "effective_sample_size_below_floor",
    counts: { realPatients: null, events: null, effectiveSampleSize: 12, generatedRecords: 0 },
    measures: [], diagnostics: { gaps: ["同期治疗数据"] }, requestedUse: "exploratory",
  });
  await module.orchestrator.advance(study.id);
  const notices = module.notices.filter((notice) => notice.title.includes("不可估计"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /有效样本量低于下限/);
  assert.equal(notices[0].idempotencyKey, `vcr:${study.id}:not-estimable:${recorded.id}:${study.userId}`);
  // A second tick does not send it again.
  await module.orchestrator.advance(study.id);
  assert.equal(module.notices.filter((notice) => notice.title.includes("不可估计")).length, 1);
});

test("one run per study at a time, and a study another process holds is left alone", options, async () => {
  const module = compose();
  const study = await makeStudy("onerun");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await module.orchestrator.advance(study.id);
  const dispatched = module.dispatched.length;
  assert.equal(dispatched, 1);
  await module.orchestrator.advance(study.id);
  await module.orchestrator.advance(study.id);
  assert.equal(module.dispatched.length, dispatched, "a run already out holds the slot");
  assert.equal(vcrScenarioHash({}), vcrScenarioHash({}), "the hash is stable, which is what makes the job key idempotent");
});
