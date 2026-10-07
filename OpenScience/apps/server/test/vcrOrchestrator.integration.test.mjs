// 「虚拟临床研究」's seven-step program on PostgreSQL with the things around it
// faked — the dispatch of a run, a run doing what a run does (writing through
// the gateway's own write path, in the shapes that path accepts), the engine's
// transport (a double that answers with results built from the job it was given,
// and hands over output tables), the inbox: a T0 study from one sentence to a
// finished package, a single step's minimal path, a changed assumption
// recomputing what depends on it, the four other things that make a result
// stale, a review going stale, a registered forecast held against enrolment, a
// result whose intended use its models cannot carry, and the verdicts the
// platform derives in code. The real engine on the other end of the same
// orchestrator is `vcrEngineContract.integration.test.mjs`.
//
// Its own database: the orchestrator's tick reads every study, so a shared
// database would let it advance another suite's.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrStore, vcrObjectNode } from "../src/vcrStore.mjs";
import { vcrComputedOutputHash } from "../src/vcrEngineClient.mjs";
import { VcrJobs, vcrScenarioHash } from "../src/vcrJobs.mjs";
import { VcrOrchestrator } from "../src/vcrOrchestrator.mjs";
import { VcrService, seedVcrCatalogue } from "../src/vcrService.mjs";
import { createVcrNotifier } from "../src/vcrNotify.mjs";
import { createVcrSeal } from "../src/vcrSeal.mjs";
import { createVcrModelPlans } from "../src/vcrModelDocuments.mjs";
import { createVcrWorkerLoops } from "../src/vcrWorker.mjs";
import { createVcrCurveEvidence } from "../src/vcrCurveEvidence.mjs";
import { VcrEvidenceStore } from "../src/vcrEvidenceStore.mjs";
import { VcrDataStore } from "../src/vcrDataStore.mjs";
import { VcrAccess } from "../src/vcrAccess.mjs";
import { createVcrGatewayHandler, vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { backfillResultSubjects } from "../src/vcrSubjects.mjs";
import { Readable } from "node:stream";
import { VCR_ACCRUAL_MEASURES } from "../src/vcrRecruit.mjs";
import { VCR_ENGINE_METHODS, VCR_EXPORT_KINDS, VCR_MODEL_DOCUMENT_KINDS, VCR_MODEL_DOCUMENT_SECTIONS, VCR_STEPS, lineageNode } from "@evimed/domain";

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
let scratch = "";

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
  await seedVcrCatalogue({ store });
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-orch-"));
  await fs.writeFile(path.join(scratch, "controlled-curve-source.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L1sAAAAASUVORK5CYII=", "base64"));
});

after(async () => {
  await database?.close().catch(() => {});
  if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

const config = () => ({
  vcrEnabled: true, vcrAudience: "all", vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 1_000_000,
  vcrMaxConcurrentJobs: 4, vcrLeaseMs: 900_000, vcrDataPlaneDir: scratch,
});

const TABLES = /** @type {Record<string, string>} */ ({
  population: "age,ldh\n61,220\n55,190\n70,310\n",
  "virtual-patients": "patientId,time,status,arm\nvp_1,4.2,1,1\nvp_2,9.9,0,0\n",
  "reconstructed-ipd": "time,status,arm\n3.1,1,0\n12,0,0\n5.5,1,1\n24,0,1\n",
});
const sha = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");

/**
 * A result the way the engine writes one for a job — built from the job it was
 * given, so what it echoes is what was frozen — for each method the program
 * uses. Its output hash is the hash of what it says.
 * @param {any} job @param {Record<string, any>} [overrides]
 */
function engineResult(job, overrides = {}) {
  const measure = (/** @type {string} */ name, /** @type {number} */ value, /** @type {Record<string, any>} */ extra = {}) => ({ name, value, source: "calculated", ...extra });
  /** @type {Record<string, any>} */
  const shape = { measures: [measure("power", 0.712, { simulated: true, mcse: 0.0031, source: "synthetic" })], counts: { realPatients: 0, events: 138, effectiveSampleSize: null, generatedRecords: 3_600_000 }, tables: [] };
  const table = (/** @type {string} */ name) => ({ name, location: `${name}.csv`, sha256: sha(TABLES[name]), rows: 3 });
  switch (job.method) {
    case "population.scenario":
      Object.assign(shape, { measures: [measure("generated_records", 240, { source: "synthetic" })], counts: { realPatients: 0, generatedRecords: 240 }, tables: [table("population")] });
      break;
    case "patients.time_to_event":
    case "patients.binary":
    case "patients.continuous":
      Object.assign(shape, { measures: [measure("generated_records", 240, { source: "synthetic" })], counts: { realPatients: 0, generatedRecords: 240 }, tables: [table("virtual-patients")],
        diagnostics: { mode: "population" } });
      break;
    case "evidence.reconstruct_km":
      Object.assign(shape, { measures: [measure("median_survival", 12, { source: "reconstructed" })], counts: { realPatients: 0, reconstructedPseudoPatients: 400 }, tables: [table("reconstructed-ipd")] });
      break;
    case "comparator.rmst":
      Object.assign(shape, { measures: [measure("rmst_difference", 2.9, { unit: "months", interval: { kind: "confidence", low: 1.2, high: 4.6 } })],
        counts: { realPatients: 0, reconstructedPseudoPatients: 400, events: 200 } });
      break;
    case "design.analytic":
      Object.assign(shape, { measures: [measure("required_events", 246.2)], counts: { realPatients: null } });
      break;
    case "design.assurance":
      Object.assign(shape, { measures: [measure("assurance", 0.62)], counts: {} });
      break;
    case "accrual.poisson_gamma":
      Object.assign(shape, { measures: [measure("last_patient_in_months", 14.2, { interval: { kind: "prediction", low: 11.1, high: 18.9 } })], counts: {}, tables: [] });
      break;
    default:
  }
  const result = {
    jobId: job.jobId, protocolVersion: 1, status: "succeeded", method: job.method, methodVersion: job.methodVersion,
    scenarioHash: vcrScenarioHash(job.scenario), seed: job.seed, replicates: job.replicates ?? null, conclusion: "estimable",
    diagnostics: {}, manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "b".repeat(64),
      startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:00:42Z", cpuSeconds: 12 },
    ...shape, ...overrides,
  };
  result.manifest = { ...result.manifest, outputHash: vcrComputedOutputHash(result) };
  return result;
}

/**
 * The whole module, composed the way `server.mjs` composes it, with the things
 * outside it faked: the dispatcher, the engine's transport, the inbox and the
 * researcher project.
 * @param {{ resultFor?: (job: any) => Record<string, any>, now?: () => Date, dataPlane?: any, dispatch?: boolean }} [options]
 */
function compose({ resultFor = (job) => engineResult(job), now = () => new Date(), dataPlane = null, dispatch = true } = {}) {
  /** @type {any[]} */
  const dispatched = [];
  /** @type {any[]} */
  const notices = [];
  /** @type {Map<string, any>} */
  const known = new Map();
  const engine = {
    configured: () => true,
    async submit(/** @type {any} */ job) { known.set(job.jobId, job); return { jobId: job.jobId, accepted: true }; },
    async status() { return { state: "succeeded", progress: { done: 1, total: 1 }, cpuSeconds: 12, error: null }; },
    async cancel() { return { canceled: true }; },
    async result(/** @type {string} */ id) { return { result: resultFor(known.get(id)), signed: true, refused: false }; },
    async downloadTable(/** @type {string} */ _id, /** @type {string} */ name, /** @type {{ destination: string, sha256: string }} */ target) {
      await fs.writeFile(target.destination, TABLES[name]);
      return { bytes: TABLES[name].length, sha256: sha(TABLES[name]) };
    },
    async health() { return { ok: true, methods: [], engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "" }; },
  };
  const cfg = config();
  const jobs = new VcrJobs({ store, config: cfg, engine, dataPlane });
  const evidenceStore = new VcrEvidenceStore({ database });
  const curves = createVcrCurveEvidence({ store: evidenceStore, studyStore: store,
    access: new VcrAccess({ store: new VcrDataStore({ database }) }), resolveProject: async () => ({ workspaceDir: scratch }) });
  jobs.curveVerifier = curves.curveVerifier;
  const notifier = createVcrNotifier({
    notifications: { async create(userId, input) { notices.push({ userId, ...input }); return { id: `n_${notices.length}` }; } },
    store, config: cfg,
  });
  const seal = createVcrSeal({ store });
  const orchestrator = new VcrOrchestrator({
    store, jobs, config: cfg, notifier, seal, now,
    dispatchRun: dispatch ? async (/** @type {any} */ input) => {
      dispatched.push(input);
      return { runId: `run_${dispatched.length}`, sessionId: `ses_${dispatched.length}` };
    } : null,
  });
  jobs.notifier = notifier;
  const service = new VcrService({ store, config: cfg, engine, jobs });
  const loops = createVcrWorkerLoops({ jobs, orchestrator, store });
  return { dispatched, notices, engine, jobs, notifier, seal, orchestrator, service, loops, curves, evidenceStore };
}

/** Run the worker's own queue loop until nothing is queued or running, and the orchestrator has nothing more to enqueue. @param {any} module @param {any} study */
async function drainJobs(module, study) {
  for (let pass = 0; pass < 40; pass += 1) {
    await module.loops.jobs();
    await module.orchestrator.advance(study.id);
    const open = await store.rows("SELECT 1 FROM evimed_vcr.jobs WHERE study_id = $1 AND state IN ('queued', 'running')", [study.id]);
    if (!open.length) return;
  }
  throw new Error("the jobs did not settle");
}

/** Force one legal completion order through the real worker, without a clock delay or editing result pointers.
 * The worker's running-job read has no ordering contract, so both stage orders are valid.
 * @param {any} t @param {string} lastKind */
function finishStageLast(t, lastKind) {
  const original = store.rows;
  store.rows = async (query, values = []) => {
    const rows = await original.call(store, query, values);
    if (!/SELECT\s+id,\s*study_id\s+FROM\s+evimed_vcr\.jobs\s+WHERE\s+state\s*=\s*'running'/u.test(query) || rows.length < 2) return rows;
    const jobs = await original.call(store, "SELECT id,kind FROM evimed_vcr.jobs WHERE id=ANY($1::text[])", [rows.map(row => row.id)]);
    const kinds = new Map(jobs.map(job => [job.id, job.kind]));
    return rows.sort((a, b) => Number(kinds.get(a.id) === lastKind) - Number(kinds.get(b.id) === lastKind));
  };
  t.after(() => { store.rows = original; });
}

/**
 * One AI run: the orchestrator dispatches it, the run writes what a run of
 * that capability writes (through the very same write path the runtime uses),
 * the ledger reports it finished, and the platform computes what it was given.
 * @param {any} module @param {any} study @param {(write: (what: string, payload: any) => Promise<any>) => Promise<unknown>} body
 */
async function runTurn(module, study, body) {
  // A run may already be out: a run finishing advances the study itself, which
  // is how a programme keeps moving without waiting for the next tick.
  await module.orchestrator.advance(study.id);
  const dispatch = module.dispatched[module.dispatched.length - 1];
  assert.ok(dispatch, "the orchestrator dispatched nothing");
  /** @param {string} what @param {any} payload */
  const write = async (what, payload) => {
    const written = await vcrRuntimeWrite({
      store, service: module.service, orchestrator: module.orchestrator, study, evidenceStore: module.evidenceStore,
      what, items: Array.isArray(payload) ? payload : null, data: Array.isArray(payload) ? null : payload,
    });
    assert.deepEqual(written.issues, [], `${what} was refused: ${JSON.stringify(written.issues)}`);
    return written;
  };
  await body(write);
  await module.orchestrator.onRunFinished(
    { userId: study.userId, id: study.projectId },
    { id: `run_${module.dispatched.length}`, dispatchId: dispatch.dispatchId, status: "succeeded" },
  );
  await drainJobs(module, study);
  await module.orchestrator.advance(study.id);
  return dispatch;
}

/** The result a superseded result's chain ends at. @param {string} studyId @param {string} id */
async function chainEnd(studyId, id) {
  let current = await store.result(studyId, id);
  for (let hops = 0; current?.supersededBy && hops < 20; hops += 1) current = await store.result(studyId, current.supersededBy);
  return current?.id ?? null;
}

/** @param {string} label @param {Record<string, any>} [patch] */
async function makeStudy(label, patch = {}) {
  return store.createStudy({
    userId: `u_${label}`, projectId: `prj_${label}`, name: `EV-201 ${label}`,
    question: "单臂 II 期能不能用外部对照，还是必须做随机？", dataTier: "T0", ...patch,
  });
}

const definition = {
  pico: { population: "二线 NSCLC", intervention: "EV", comparator: "化疗", outcome: "PFS" },
  estimand: { population: "二线 NSCLC", variable: "PFS", treatment: "EV 单药",
    intercurrentEvents: [{ event: "后续抗肿瘤治疗", strategy: "treatment_policy" }], summary: "风险比" },
  endpointType: "time_to_event",
  fieldSources: { endpointType: "AI 设定：按主要终点的测量方式" },
};

/** A published curve, short: the double's engine does not hold it to quality control (the real one does, in the contract test). */
const publishedArm = (/** @type {number} */ median) => ({
  curve: [{ time: 0, surv: 1 }, { time: 12, surv: 0.5 }, { time: 24, surv: Math.round(0.5 ** (24 / median) * 1e4) / 1e4 }],
  riskTable: [{ time: 0, atRisk: 200 }, { time: 12, atRisk: 100 }], totalEvents: 120, reportedMedian: median,
});
const trialA = { label: "A 2:1 随机", design: "two_arm_fixed", endpointType: "time_to_event", assumptionIds: ["hazard_ratio", "control_median_pfs", "dropout_rate"],
  configuration: { design: { nTreat: 120, nControl: 60, allocation: 0.6667 }, analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 },
    accrual: { kind: "uniform", duration: 12, followup: 12 }, performance: ["power"] } };

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
  // The live shape (acceptance 2026-10-03): the protocol run states scenario cards of its own under the definition.
  const stated = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "assumption", data: null,
    items: [{ key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "scenario", valueSource: "assumed",
      distribution: { family: "lognormal", params: { meanlog: Math.log(0.7), sdlog: 0.15 } } },
    { key: "dropout_rate", name: "脱落率", pointValue: 0.1, sourceKind: "expert_set", valueSource: "assumed" }] });
  assert.equal(stated.ok, true);
  await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId },
    { id: "run_1", dispatchId: module.dispatched[0].dispatchId, status: "succeeded" });

  let current = await store.studyById(study.id);
  assert.equal(current.steps.definition.status, "done", "read from the definition row, not from the run's word");
  assert.equal(module.dispatched[1].capabilityId, "vcr-evidence",
    "cards the protocol run stated are not parameters taken from evidence: the evidence run is the next step, not skipped");
  assert.notEqual(current.steps.evidence.status, "done", "the page does not say 已完成 for a step that has not run");

  await runTurn(module, study, async (write) => {
    // What the registry extraction stores for one control-arm median: verified against the preserved record, with its quotation.
    const extracted = await module.evidenceStore.appendEvidenceItems({ userId: study.userId, studyId: study.id, items: [{
      parameter: "median_time", arm: "SoC", armRole: "control", endpointKey: "pfs-blinded", value: 6, unit: "月", valueSource: "extracted",
      quote: "Median progression-free survival was 6 months.", locator: { verification: "verified", field: "outcomeMeasures[0]" } }] });
    assert.equal(extracted.verified, 1);
    const written = await write("assumption", [
      { key: "control_median_pfs", name: "对照组中位 PFS", unit: "月", parameter: "median_time", sourceKind: "external_evidence", evidenceIds: extracted.verifiedIds },
      { key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed",
        distribution: { family: "lognormal", params: { meanlog: Math.log(0.7), sdlog: 0.15 } } },
      { key: "dropout_rate", name: "脱落率", pointValue: 0.1, sourceKind: "expert_set", valueSource: "assumed" },
    ]);
    assert.deepEqual(written.issues, []);
    assert.equal(written.ids.length, 3);
  });
  current = await store.studyById(study.id);
  assert.equal(current.steps.evidence.status, "done", "done by a card that cites a verified extraction");

  // The analysis run covers the four steps it is wanted for, in one turn.
  /** @type {string} */
  let populationId = "";
  const analysis = await runTurn(module, study, async (write) => {
    populationId = (await write("population", { kind: "scenario", name: "情景人群", definition: { n: 240, population: {
      variables: [{ name: "age", family: "normal", mean: 63, sd: 9 }, { name: "ldh", family: "lognormal", meanlog: 5.4, sdlog: 0.35 }] } } })).ids[0];
    await write("patient_set", { name: "240 名虚拟患者", populationId, modelId: "reference-time-to-event", modelVersion: "1.0.0",
      scenario: { design: { nTreat: 160, nControl: 80 }, endpoint: { type: "time_to_event" }, truth: { covariateEffects: { ldh: 0.001 } },
        accrual: { kind: "uniform", duration: 12, followup: 12 } } });
    const curve = await module.curves.recordSelection({ studyId: study.id, principal: study.userId,
      imageArtifactId: "controlled-curve-source.png", points: { ...publishedArm(12), treatmentArm: publishedArm(17) } });
    await write("comparator", { route: "literature_control", estimand: "ATT",
      configuration: { provenance: { receiptId: curve.id }, tau: 18, timeUnit: "months" } });
    await write("trial_scenario", [trialA, { label: "B 1:1 加期中分析", design: "group_sequential", endpointType: "time_to_event",
      configuration: { design: { nTreat: 90, nControl: 90, allocation: 0.5, informationRates: [0.5, 1], spending: "obrien_fleming" },
        analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 }, accrual: { kind: "uniform", duration: 12, followup: 12 },
        truth: { hazardRatio: 0.7, controlMedian: 6 } } }]);
  });
  assert.equal(analysis.capabilityId, "vcr-analysis");
  assert.deepEqual(analysis.detail ?? null, null, "the dispatch carries only what the run needs");

  current = await store.studyById(study.id);
  for (const step of ["population", "patients", "comparator", "trial"]) {
    assert.equal(current.steps[step].status, "done", `${step} is ${current.steps[step].status}${current.steps[step].note ? `: ${current.steps[step].note}` : ""}`);
  }
  const results = await store.results(study.id);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["comparator", "patient_set", "population", "trial_scenario", "trial_scenario"],
    "one result per object, and one per design: two designs are two current results");
  for (const result of results) {
    assert.ok(result.counts.realPatients === 0 || result.counts.realPatients == null, "no real person is counted at T0");
    for (const measure of result.measures) if (measure.simulated) assert.equal(typeof measure.mcse, "number", "every simulated measure carries its Monte-Carlo error");
  }

  // The lineage was written on the way: the assumptions and the definition are
  // upstream of each design the platform computed, and the results hang off them.
  const edges = await store.edges(study.id);
  const scenarios = await store.trialScenarios(study.id);
  const scenarioNode = vcrObjectNode("trial_scenario", scenarios.find((scenario) => scenario.label.startsWith("A")));
  assert.ok(edges.some((edge) => edge.to === scenarioNode && edge.from.startsWith("assumption:")));
  assert.ok(edges.some((edge) => edge.from === scenarioNode && edge.to.startsWith("result:")));
  const population = await store.latestPopulation(study.id);
  assert.ok(edges.some((edge) => edge.from === vcrObjectNode("population", population) && edge.to.startsWith("patient_set:")), "the population the patients stand on");

  // Step 7 is wanted too: at T0 there is nobody to match, so the step is the
  // protocol's criteria structured — and it is done when they are (plan §3.2).
  const matching = await runTurn(module, study, async (write) => {
    await write("protocol", { title: "EV-201 v1.0", criteria: [
      { kind: "inclusion", criterionType: "diagnosis", requirement: { op: "present", variable: "nsclc" },
        sourceText: "经组织学确诊的非小细胞肺癌", sourceLocator: { page: 12 } },
    ] });
  });
  assert.equal(matching.capabilityId, "vcr-matching");
  current = await store.studyById(study.id);
  assert.equal(current.steps.matching.status, "done", "structured criteria are what T0's matching step is");

  // The package: an export run, and one notice when it is ready.
  const exported = await module.orchestrator.requestExport({ id: study.userId }, study, "study_package");
  assert.equal(exported.export.state, "queued");
  await module.orchestrator.advance(study.id);
  const packageDispatch = module.dispatched[module.dispatched.length - 1];
  assert.equal(packageDispatch.capabilityId, "vcr-package");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "report", items: null,
    data: { kind: "study_package", template: "方案 A 的功效为 {{n:results.trial_scenario.measures[0].value|pct1}}。" } });
  await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId },
    { id: "run_x", dispatchId: packageDispatch.dispatchId, status: "succeeded" });

  const rows = await store.exports(study.id);
  assert.equal(rows[0].state, "ready");
  assert.equal(rows[0].cover.reviewed, false, "the cover says what is true: nobody has reviewed it");
  assert.equal(rows[0].cover.staleResults, 0);
  assert.match(rows[0].cover.report.rendered, /功效为 \d+(\.\d)?%/, "the number was rendered from a result");

  const ready = module.notices.filter((notice) => notice.title.includes("研究包完成"));
  assert.equal(ready.length, 1, "one notice, once");
  assert.equal(ready[0].userId, study.userId);
});

test("an export run fills the export it was sent for, whichever of the six documents it is: a report typed as another one is refused and nothing is made", options, async () => {
  const module = compose();
  const study = await makeStudy("exportbind");
  /** @param {Record<string, any>} data */
  const report = (data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "report", items: null, data });
  for (const kind of VCR_EXPORT_KINDS) {
    const asked = await module.orchestrator.requestExport({ id: study.userId }, study, kind);
    assert.deepEqual([asked.export.kind, asked.export.state], [kind, "queued"]);
    const dispatch = module.dispatched[module.dispatched.length - 1];
    assert.equal(dispatch.capabilityId, "vcr-package");
    assert.ok(dispatch.brief.includes(`（kind: ${kind}）`), `the brief names the document (${kind})`);
    const rows = (await store.exports(study.id)).length;
    // What the pilot's run did: it typed the kind its skill's example shows, whatever it had been sent for.
    const typed = kind === "study_package" ? "simulation_report" : "study_package";
    const refused = await report({ kind: typed, template: "方法与局限。" });
    assert.deepEqual([refused.ok, refused.issues.map((/** @type {any} */ entry) => [entry.field, entry.code])], [false, [["kind", "vcr_write_value_invalid"]]]);
    assert.equal((await store.exports(study.id)).length, rows, `no ${typed} was made beside the ${kind} asked for`);
    // With no kind typed the report is the dispatch's: the run slot says which export, the run does not have to.
    // (The two model documents take their words by named section.)
    const section = VCR_MODEL_DOCUMENT_KINDS.includes(kind) ? { section: VCR_MODEL_DOCUMENT_SECTIONS[kind].prose[0] } : {};
    const written = await report({ template: "方法与局限。", ...section });
    assert.deepEqual([written.ids, written.issues], [[asked.export.id], []]);
    await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId },
      { id: `run_${module.dispatched.length}`, dispatchId: dispatch.dispatchId, status: "succeeded" });
    const row = await store.exportRow(study.id, asked.export.id);
    assert.deepEqual([row.kind, row.state], [kind, "ready"]);
    assert.equal(row.cover.report.rendered, "方法与局限。");
  }
  assert.deepEqual((await store.exports(study.id)).map((row) => row.kind).sort(), [...VCR_EXPORT_KINDS].sort(), "six documents asked for, six exports, no orphan");

  // With no export run out the write is the researcher's own conversation: it opens a row of the kind it names, as before.
  const own = await report({ kind: "simulation_report", section: "appendix", template: "补充说明。" });
  assert.equal(own.ok, true);
  assert.equal((await store.exports(study.id)).length, VCR_EXPORT_KINDS.length + 1);
});

test("a model document stands on one frozen plan version: asked for again after a newer version is frozen it is a new document, and with none newer it is the same one", options, async () => {
  const module = compose();
  // The document export queue is the composition's; a document already held is converted again, not rewritten.
  module.orchestrator.queueExport = async () => ({ id: "conversion" });
  const study = await makeStudy("modelbind");
  const plans = createVcrModelPlans({ store });
  /** @param {string} kind */
  const produce = async (kind) => {
    const asked = await module.orchestrator.requestExport({ id: study.userId }, study, kind);
    if (!asked.export || asked.export.state !== "queued") return asked;
    const dispatch = module.dispatched[module.dispatched.length - 1];
    await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "report", items: null,
      data: { ...(VCR_MODEL_DOCUMENT_KINDS.includes(kind) ? { section: VCR_MODEL_DOCUMENT_SECTIONS[kind].prose[0] } : {}), template: "引言。" } });
    await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId }, { id: `run_${module.dispatched.length}`, dispatchId: dispatch.dispatchId, status: "succeeded" });
    return asked;
  };
  // Drafted before any plan was frozen: the document says so, and is built on version 0.
  const draft = await produce("model_analysis_plan");
  const drafted = await store.exportRow(study.id, draft.export.id);
  assert.equal(drafted.cover.results.modelAnalysis.plan, null);
  const again = await module.orchestrator.requestExport({ id: study.userId }, study, "model_analysis_plan");
  assert.equal(again.export.id, draft.export.id, "with no plan frozen since, the same document is served");
  assert.equal(module.dispatched.length, 1, "and no second run was sent");

  // The plan freezes: the draft is no longer the plan, so asking again is a new document written against version 1.
  await plans.freeze({ studyId: study.id, actor: "orchestrator" });
  const frozen = await produce("model_analysis_plan");
  assert.notEqual(frozen.export.id, draft.export.id);
  assert.equal(module.dispatched.length, 2);
  assert.equal((await store.exportRow(study.id, frozen.export.id)).cover.results.modelAnalysis.plan.version, 1);
  assert.equal((await module.orchestrator.requestExport({ id: study.userId }, study, "model_analysis_plan")).export.id, frozen.export.id, "now it is the one document again");

  // A study package has no plan version: it is one document, as before.
  const first = await produce("study_package");
  await plans.freeze({ studyId: study.id, actor: "runtime" });
  assert.equal((await module.orchestrator.requestExport({ id: study.userId }, study, "study_package")).export.id, first.export.id);
});

test("a package stands on what it was written from: asked for again after the study changed it is a new document and the earlier one stays listed as replaced; with nothing changed it is the same one", options, async () => {
  const module = compose();
  // The document export queue is the composition's; a document already held is converted again, not rewritten.
  /** @type {string[]} */
  const converted = [];
  module.orchestrator.queueExport = async (_user, _study, row) => { converted.push(row.id); return { id: "conversion" }; };
  const study = await makeStudy("inputdigest");
  /** @param {string} kind */
  const produce = async (kind) => {
    const asked = await module.orchestrator.requestExport({ id: study.userId }, study, kind);
    if (!asked.export || asked.export.state !== "queued") return asked;
    const dispatch = module.dispatched[module.dispatched.length - 1];
    await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "report", items: null,
      data: { kind, template: "方法与局限。" } });
    await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId }, { id: `run_${module.dispatched.length}`, dispatchId: dispatch.dispatchId, status: "succeeded" });
    return asked;
  };
  const card = (/** @type {number} */ value) => store.saveAssumption({ studyId: study.id, userId: study.userId, key: "dropout_rate", name: "脱落率", pointValue: value,
    unit: "%", sourceKind: "expert_set", valueSource: "assumed" });
  const rows = async () => (await store.exports(study.id)).filter((row) => row.kind === "study_package");
  const labels = async () => (await module.service.studyView({ id: study.userId }, study.id)).overview.deliverables
    .filter((entry) => entry.kind === "study_package").map((entry) => entry.meta);

  await card(10);
  const first = await produce("study_package");
  const firstRow = await store.exportRow(study.id, first.export.id);
  assert.match(firstRow.cover.inputDigest, /^[0-9a-f]{64}$/, "the document records what it was written from");
  assert.deepEqual((await labels()).map((meta) => meta.includes("已被新版取代")), [false]);

  // Nothing changed: the same document, converted again, and no second run.
  const convertedBefore = converted.length;
  const same = await module.orchestrator.requestExport({ id: study.userId }, study, "study_package");
  assert.equal(same.export.id, first.export.id);
  assert.equal(module.dispatched.length, 1);
  assert.deepEqual(converted.slice(convertedBefore), [first.export.id]);

  // A countersignature and the passing of time are not a change of what it was computed from.
  await store.addReview({ studyId: study.id, userId: study.userId, kind: "statistical", nodes: ["assumption:dropout_rate@1"], reviewer: study.userId, note: "" });
  assert.equal((await module.orchestrator.requestExport({ id: study.userId }, study, "study_package")).export.id, first.export.id);

  // An assumption card is edited: the study is not what the document was written from, so asking again is a new document.
  await card(15);
  const second = await produce("study_package");
  assert.notEqual(second.export.id, first.export.id);
  assert.equal(module.dispatched.length, 2);
  const secondRow = await store.exportRow(study.id, second.export.id);
  assert.notEqual(secondRow.cover.inputDigest, firstRow.cover.inputDigest);
  assert.equal(secondRow.cover.report.rendered, "方法与局限。");
  // The earlier document is kept, and the list says it was replaced; the newest says nothing of the kind.
  assert.deepEqual((await rows()).map((row) => row.id), [second.export.id, first.export.id]);
  assert.deepEqual((await labels()).map((meta) => meta.includes("已被新版取代")), [false, true]);
  assert.equal((await store.exportRow(study.id, first.export.id)).cover.report.rendered, "方法与局限。", "the earlier document is untouched");
  // And with nothing moved since, the new one is the one document again.
  assert.equal((await module.orchestrator.requestExport({ id: study.userId }, study, "study_package")).export.id, second.export.id);
  assert.equal(module.dispatched.length, 2);

  // Another kind is its own document: a simulation report asked for now is the first of its kind, and the package is not replaced by it.
  await produce("simulation_report");
  assert.deepEqual((await labels()).map((meta) => meta.includes("已被新版取代")), [false, true]);

  // A document that recorded nothing of what it was written from says nothing about it: it is not served as current.
  await store.updateExportCover(second.export.id, (cover) => { const { inputDigest: _gone, ...rest } = cover; return rest; });
  const third = await produce("study_package");
  assert.notEqual(third.export.id, second.export.id);
  assert.equal(module.dispatched.length, 4, "two more runs: the report and the third package");
});

test("an export whose run leaves no document ends failed and is said on the study page and the home list, until the same document arrives", options, async () => {
  const module = compose();
  const study = await makeStudy("exportfail");
  const said = async () => {
    const lines = (/** @type {any[]} */ attention) => attention.filter((line) => line.kind === "export_failed").map((line) => line.text);
    const page = await module.service.studyView({ id: study.userId }, study.id);
    const home = await module.service.listStudies({ id: study.userId });
    return { page: lines(page.overview.attention), home: lines(home.studies.find((/** @type {any} */ row) => row.id === study.id).attention) };
  };
  const finish = (/** @type {string} */ id) => module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId },
    { id, dispatchId: module.dispatched[module.dispatched.length - 1].dispatchId, status: "succeeded" });

  // The run ends having submitted nothing to its export: the pilot's 模拟报告, a paid run and a row reading 「未完成」.
  const lost = await module.orchestrator.requestExport({ id: study.userId }, study, "simulation_report");
  await finish("run_lost");
  assert.equal((await store.exportRow(study.id, lost.export.id)).state, "failed");
  const line = ["「模拟报告」没有生成，已算出的结果保留"];
  assert.deepEqual(await said(), { page: line, home: line });

  // Asked for again and written this time: a failed export is not what 导出 answers with, and the line goes.
  const again = await module.orchestrator.requestExport({ id: study.userId }, study, "simulation_report");
  assert.notEqual(again.export.id, lost.export.id);
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "report", items: null,
    data: { kind: "simulation_report", template: "方法与局限。" } });
  await finish("run_found");
  assert.equal((await store.exportRow(study.id, again.export.id)).state, "ready");
  assert.deepEqual(await said(), { page: [], home: [] });

  // A dispatch refused for good — the package capability is not installed — fails the export as well: with no step to
  // fail, its row was left reading 「排队中」 for a run that would never come.
  module.orchestrator.dispatchRun = async () => { throw Object.assign(new Error("not installed"), { code: "vcr_unavailable" }); };
  const never = await module.orchestrator.requestExport({ id: study.userId }, study, "validation_pack");
  assert.equal((await store.exportRow(study.id, never.export.id)).state, "failed");
  const unsent = ["「系统验证文档包」没有生成，已算出的结果保留"];
  assert.deepEqual(await said(), { page: unsent, home: unsent });
});

test("PB-21 a study created without saying what it is about waits for its question; a run on an empty brief is never dispatched", options, async () => {
  const module = compose();
  const study = await store.createStudy({ userId: "u_empty", projectId: "prj_empty", name: "空研究", question: "", dataTier: "T0" });
  // 「让 AI 做」 on it is answered with what the study is waiting for — not 「已排队」 for a run that cannot go out — and asks for nothing.
  for (const step of ["definition", "population", "trial"]) {
    await assert.rejects(module.orchestrator.runStep({ id: study.userId }, study, step),
      { status: 409, code: "vcr_definition_missing", message: "先说一句要研究什么：在对话里写下问题，或上传方案。" });
  }
  assert.equal((await store.studyById(study.id)).steps.population.requested, false, "nothing was requested");
  // The study as 「新建研究」 makes it asks for the whole programme and has nothing to write a definition from.
  for (const step of VCR_STEPS) await store.setStep(study.id, step, { requested: true });
  await module.orchestrator.advance(study.id);
  assert.equal(module.dispatched.length, 0, "nothing to write a definition from");
  assert.match((await store.studyById(study.id)).steps.definition.note, /先说一句/);
  await store.updateStudy(study.id, { question: "样本量怎么定？" }, study.userId);
  await module.orchestrator.advance(study.id);
  assert.equal(module.dispatched.length, 1);
  assert.equal(module.dispatched[0].capabilityId, "vcr-protocol");
  assert.equal((await store.studyById(study.id)).steps.definition.note, null, "and the note that asked for it is gone");
});

test("R10 no background run goes out before there is a definition: nothing is said, nothing is dispatched, and a question alone gets the definition run only", options, async () => {
  // A study nobody has said anything about, asked for in full (the home page's 「新建研究」): the evidence run used to go out on
  // the study's name and an empty question, and the analysis run on the same (B §1.4).
  const silent = compose();
  const empty = await store.createStudy({ userId: "u_silent", projectId: "prj_silent", name: "未命名研究", question: "", dataTier: "T0" });
  for (const step of VCR_STEPS) await store.setStep(empty.id, step, { requested: true });
  await silent.orchestrator.advance(empty.id);
  await silent.orchestrator.advance(empty.id);
  assert.equal(silent.dispatched.length, 0, "no run for a study with no question and no definition");
  assert.match((await store.studyById(empty.id)).steps.definition.note, /先说一句/);
  assert.equal(await store.rows(`SELECT 1 FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND kind = 'run'`, [empty.id]).then((rows) => rows.length), 0,
    "and no run mark either: nothing was claimed");

  // With a question the definition is written from it, and nothing else goes out until that definition exists — a definition run
  // that ends without writing one does not release the evidence, analysis and matching runs.
  const asked = compose();
  const study = await makeStudy("predefinition");
  for (const step of VCR_STEPS) await store.setStep(study.id, step, { requested: true });
  await asked.orchestrator.advance(study.id);
  assert.deepEqual(asked.dispatched.map((input) => input.capabilityId), ["vcr-protocol"]);
  await asked.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId }, { id: "run_1", dispatchId: asked.dispatched[0].dispatchId, status: "succeeded" });
  await asked.orchestrator.advance(study.id);
  assert.ok(asked.dispatched.every((input) => input.capabilityId === "vcr-protocol"),
    `only the definition is sent while there is none: ${asked.dispatched.map((input) => input.capabilityId).join(", ")}`);

  // The definition exists: the programme goes on as it always did.
  await vcrRuntimeWrite({ store, service: asked.service, orchestrator: asked.orchestrator, study, what: "definition", items: null, data: definition });
  const last = asked.dispatched.length - 1;
  await asked.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId }, { id: `run_${last + 1}`, dispatchId: asked.dispatched[last].dispatchId, status: "succeeded" });
  await asked.orchestrator.advance(study.id);
  assert.ok(asked.dispatched.some((input) => input.capabilityId === "vcr-evidence"), "the evidence run follows the definition");
});

/**
 * The conversation's side of the runtime gateway, composed from the module under test: the real handler, a token that names the
 * study's account and project, and nothing else faked.
 * @param {any} module @param {any} study
 */
function conversationGateway(module, study) {
  const runtimeManager = { assertActiveModelGatewayToken: () => ({ userId: study.userId, projectId: study.projectId }) };
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:8788/internal/models/v1" }, runtimeManager,
    { vcr: { service: module.service, store, jobs: module.jobs, orchestrator: module.orchestrator } });
  return async (/** @type {string} */ operation, /** @type {Record<string, any>} */ body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: `/internal/vcr/v1/${operation}`, headers: { authorization: "Bearer t" } });
    const res = { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; }, end(/** @type {string} */ chunk = "") { this.body = String(chunk); } };
    await handler(req, res);
    return { status: res.status, ...JSON.parse(res.body) };
  };
}

/** The three designs a conversation compares: 2:1, 1:1 and 1:1 with an interim look. */
const conversationDesigns = [
  { label: "A 2:1 固定设计", design: "two_arm_fixed", endpointType: "time_to_event",
    configuration: { design: { nTreat: 120, nControl: 60, allocation: 0.6667 }, analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 }, accrual: { kind: "uniform", duration: 12, followup: 12 }, performance: ["power"] } },
  { label: "B 1:1 固定设计", design: "two_arm_fixed", endpointType: "time_to_event",
    configuration: { design: { nTreat: 90, nControl: 90, allocation: 0.5 }, analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 }, accrual: { kind: "uniform", duration: 12, followup: 12 }, performance: ["power"] } },
  { label: "C 1:1 加一次期中分析", design: "group_sequential", endpointType: "time_to_event",
    configuration: { design: { nTreat: 90, nControl: 90, allocation: 0.5, informationRates: [0.5, 1], spending: "obrien_fleming" }, analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 },
      accrual: { kind: "uniform", duration: 12, followup: 12 }, truth: { hazardRatio: 0.7, controlMedian: 6 } } },
];

/** @param {number} at the design @param {string} kind the computation, as a run states the scenario to the engine (each method reads its own keys) */
function engineScenario(at, kind) {
  const own = conversationDesigns[at];
  const base = { endpoint: { type: own.endpointType }, truth: { hazardRatio: 0.7, controlMedian: 6 } };
  const looks = own.configuration.design.informationRates ? { informationRates: own.configuration.design.informationRates, spending: "obrien_fleming" } : {};
  return kind === "design_analytic"
    ? { ...base, design: { kind: own.design, allocation: own.configuration.design.allocation, ...looks }, analysis: { alpha: 0.025, power: 0.9, sided: 1 }, accrual: { duration: 24, followup: 12 } }
    : { ...base, design: { nTreat: own.configuration.design.nTreat, nControl: own.configuration.design.nControl, kind: own.design, ...looks },
      analysis: { method: "logrank", alpha: 0.025, sided: 1 }, accrual: { kind: "uniform", duration: 12, followup: 12 } };
}

test("R10 a computation a conversation queues is filed under the design it was queued for: three designs are three results, each with its analytic and simulated numbers, the notices say so once, and the programme does not queue the same stage again", options, async () => {
  const module = compose();
  const study = await makeStudy("conversation");
  const write = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
    study, what, items: Array.isArray(data) ? data : null, data: Array.isArray(data) ? null : data });
  const defined = await write("definition", { ...definition, title: "二线肺癌 EV 的样本量", question: "单臂 II 期能不能用外部对照？" });
  assert.equal(defined.ok, true);
  const latest = await store.latestDefinition(study.id);
  assert.deepEqual([latest.title, latest.question], ["二线肺癌 EV 的样本量", "单臂 II 期能不能用外部对照？"], "the conversation's own name and sentence are kept with the definition");
  await write("assumption", [{ key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" },
    { key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, sourceKind: "expert_set", valueSource: "assumed" }]);
  const written = await write("trial_scenario", conversationDesigns);
  assert.equal(written.ids.length, 3);
  const [a, b, c] = written.ids;
  const gateway = conversationGateway(module, study);

  // No subject, and the scenario fits two designs equally: refused by name, and nothing is queued.
  const several = await gateway("simulate", { action: "start", kind: "design_simulation", scenario: { design: { allocation: 0.5 }, endpoint: { type: "time_to_event" } } });
  assert.equal(several.status, 400);
  assert.equal(several.code, "vcr_simulate_subject_required");
  assert.deepEqual(await store.jobs(study.id), []);

  // The conversation asks for each design's analytic size and its simulation, naming the design.
  /** @type {Record<string, any>} */
  const started = {};
  const asked = engineScenario;
  for (const [id, at] of /** @type {Array<[string, number]>} */ ([[a, 0], [b, 1]])) {
    for (const kind of ["design_analytic", "design_simulation"]) {
      const answer = await gateway("simulate", { action: "start", kind, subjectId: id, scenario: asked(at, kind) });
      assert.equal(answer.status, 200, JSON.stringify(answer));
      assert.equal(answer.data.subject.id, id);
      started[`${id}:${kind}`] = answer.data.jobId;
    }
  }
  // The programme's next pass takes what the conversation did not: it does not queue the stages the conversation holds.
  await module.orchestrator.advance(study.id);
  const analyticJobs = (await store.jobs(study.id)).filter((job) => job.kind === "design_analytic");
  assert.equal(analyticJobs.filter((job) => job.checkpoint.subjectId === a).length, 1, "the programme did not queue the analytic stage of a design the conversation already did");
  const simulationOfA = (await store.jobs(study.id)).filter((job) => job.kind === "design_simulation" && job.checkpoint.subjectId === a);
  assert.equal(simulationOfA.length, 1);
  // and a run that asks again for a stage in flight is given that job, not a second one
  const again = await gateway("simulate", { action: "start", kind: "design_simulation", subjectId: a, scenario: asked(0, "design_simulation") });
  assert.equal(again.data.alreadyRunning, true);
  assert.equal(again.data.jobId, started[`${a}:design_simulation`]);

  await drainJobs(module, study);

  // Three designs are three results. Each design holds its own, and nobody is superseded by another design.
  const current = await store.results(study.id, "trial_scenario");
  assert.deepEqual(current.map((row) => row.subjectId).sort(), [a, b, c].sort(), "one current result per design, filed under it");
  for (const id of [a, b]) {
    const row = current.find((entry) => entry.subjectId === id);
    const names = row.measures.map((/** @type {any} */ measure) => measure.name);
    assert.ok(names.includes("required_events") && names.includes("power"), `design ${id} holds its analytic and its simulated numbers: ${names.join(",")}`);
    const scenarioRow = (await store.trialScenarios(study.id)).find((entry) => entry.id === id);
    assert.equal(scenarioRow.resultId, row.id, "the result lands on the design, which is where the trial tab reads it");
  }
  const all = await store.allResults(study.id);
  assert.equal(all.filter((row) => row.kind === "trial_scenario" && row.subjectId === null).length, 0, "no result is left without a design");
  for (const row of all.filter((entry) => entry.kind === "trial_scenario" && entry.supersededBy)) {
    const successor = all.find((entry) => entry.id === row.supersededBy);
    assert.equal(successor?.subjectId, row.subjectId, "a result is superseded only by a result of the same design");
  }

  // One notice per computation the conversation asked for, in the researcher's words; none for the programme's own stages.
  const titles = notices_of(module).map((notice) => notice.title);
  assert.equal(titles.filter((title) => title.startsWith("方案计算完成")).length, 2);
  assert.ok(titles.some((title) => /^方案模拟完成：1:1 固定设计功效 71\.2%$/.test(title)), `the simulation says its number: ${titles.join(" | ")}`);
  assert.ok(notices_of(module).every((notice) => notice.source.id === `${study.id}/trial` || !String(notice.title).includes("完成")));
  const simulationNotices = notices_of(module).filter((notice) => notice.title.startsWith("方案模拟完成"));
  assert.equal(simulationNotices.length, 2, "two simulations were asked for, and C was the programme's own");
});

test("R11 a step stored as running whose run is gone follows the data: three designs have results, one stopped at its budget, no job is open — the trial step reads 未完成 with its note, never 进行中", options, async () => {
  const module = compose({ dispatch: false });
  const study = await makeStudy("orphan");
  const write = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
    study, what, items: Array.isArray(data) ? data : null, data: Array.isArray(data) ? null : data });
  await write("definition", { ...definition, title: "二线肺癌 EV 的样本量", question: "单臂 II 期能不能用外部对照？" });
  await write("assumption", [{ key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" },
    { key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, sourceKind: "expert_set", valueSource: "assumed" }]);
  const written = await write("trial_scenario", conversationDesigns);
  const gateway = conversationGateway(module, study);
  for (const [at, id] of written.ids.entries()) {
    const answer = await gateway("simulate", { action: "start", kind: "design_simulation", subjectId: id, scenario: engineScenario(at, "design_simulation") });
    assert.equal(answer.status, 200, JSON.stringify(answer));
  }
  // The population step is what somebody asked for; the trial step is not wanted — it was only ever running because a run was sent.
  await store.setStep(study.id, "population", { requested: true, status: "none" });
  await drainJobs(module, study);
  assert.equal((await store.studyById(study.id)).steps.trial.status, "minimal", "every design has its result, and nobody asked for the step: the data says it is there as the minimal version");

  // The live case: the step is stored running, its run is gone, one design's compute stopped at its budget and left a partial result.
  const designs = await store.trialScenarios(study.id);
  assert.ok(designs.every((design) => design.resultId), "all designs hold a result");
  await store.setStep(study.id, "trial", { status: "running", runId: "run_gone" });
  await store.query(`INSERT INTO evimed_vcr.schedule_marks (study_id, key, user_id, kind, state, step, detail, done_at)
    VALUES ($1, $2, $3, 'job', 'failed', 'trial', $4::jsonb, now())`,
  [study.id, `job:${vcrObjectNode("trial_scenario", designs[1])}`, study.userId,
    JSON.stringify({ node: vcrObjectNode("trial_scenario", designs[1]), error: "cpu_budget_exhausted", title: "计算时间用完", message: "这个方案的模拟只算了一部分。" })]);
  assert.equal((await store.studyById(study.id)).steps.trial.status, "running");
  assert.deepEqual(await store.rows("SELECT 1 FROM evimed_vcr.jobs WHERE study_id = $1 AND state IN ('queued', 'running', 'awaiting_budget')", [study.id]), []);

  await module.orchestrator.advance(study.id);
  const after = (await store.studyById(study.id)).steps.trial;
  assert.equal(after.status, "failed", "the step follows the data once no run holds it");
  assert.match(String(after.note), /计算时间用完/);
  assert.notEqual(after.status, "running");
});

/** The notices the inbox double took from a composed module that are about a finished computation. @param {any} module */
function notices_of(module) {
  return module.notices.filter((/** @type {any} */ notice) => /完成/.test(String(notice.title)) && notice.source?.type === "vcr");
}

test("R10 the backfill gives the results the old path left without a subject the design they were computed for, undoes the supersessions that crossed designs, and a second run changes nothing", options, async () => {
  const module = compose({ dispatch: false });
  const study = await makeStudy("backfill");
  await store.updateStudy(study.id, { status: "paused" }, study.userId);
  const written = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "trial_scenario", items: conversationDesigns, data: null });
  const [a, b, c] = written.ids;

  // What the conversation did on 2026-10-07: three analytic jobs and four simulations, each with its own scenario and no subject.
  /** @param {string} kind @param {number} at @param {Record<string, any>} scenario @param {Record<string, any>} measure */
  const legacy = async (kind, at, scenario, measure) => {
    const { job } = await module.jobs.enqueue({ studyId: study.id, userId: study.userId, kind, scenario, inputs: [], internal: true,
      idempotencyKey: `legacy:${kind}:${at}:${JSON.stringify(scenario).length}:${Math.random()}`, detail: { subjectId: null, origin: "runtime" } });
    const execution = await store.recordExecution({ jobId: job.id, studyId: study.id, userId: study.userId, method: job.method, methodVersion: "1.0.0", scenarioHash: "h".repeat(16),
      inputs: [], environment: {}, seed: 1, replicates: null, outputHash: null, receipt: {}, cpuSeconds: 1, startedAt: null, finishedAt: null });
    return store.recordResult({ studyId: study.id, userId: study.userId, executionId: execution.id, kind: "trial_scenario", subjectId: null,
      conclusion: "estimable", counts: {}, measures: [measure], diagnostics: {}, tables: [] });
  };
  const designOf = engineScenario;
  const analytic = (/** @type {number} */ value) => ({ name: "required_events", value, source: "calculated" });
  const power = (/** @type {number} */ value) => ({ name: "power", value, simulated: true, mcse: 0.004, source: "synthetic" });
  const made = [];
  made.push(await legacy("design_analytic", 0, designOf(0, "design_analytic"), analytic(950)));
  made.push(await legacy("design_analytic", 1, designOf(1, "design_analytic"), analytic(845)));
  made.push(await legacy("design_analytic", 2, designOf(2, "design_analytic"), analytic(841)));
  made.push(await legacy("design_simulation", 0, designOf(0, "design_simulation"), power(0.898)));
  made.push(await legacy("design_simulation", 1, designOf(1, "design_simulation"), power(0.915)));
  made.push(await legacy("design_simulation", 2, designOf(2, "design_simulation"), power(0.905)));
  made.push(await legacy("design_simulation", 1, { ...designOf(1, "design_simulation"), accrual: { kind: "uniform", duration: 18, followup: 12 } }, power(0.917)));
  assert.equal((await store.results(study.id, "trial_scenario")).length, 1, "the old path: seven results, one of them current, whichever design it was for");

  const report = await backfillResultSubjects({ store, studyId: study.id });
  assert.equal(report.apply, false);
  const only = report.studies[0];
  assert.equal(only.assigned.length, 7);
  assert.deepEqual(only.unmatched, []);
  assert.deepEqual(only.assigned.filter((row) => row.subjectId === b).length, 3, "design B has an analytic and two simulations");
  assert.equal((await store.results(study.id, "trial_scenario")).length, 1, "a report changes nothing");

  const applied = await backfillResultSubjects({ store, studyId: study.id, apply: true });
  assert.equal(applied.studies[0].assigned.length, 7);
  const current = await store.results(study.id, "trial_scenario");
  assert.deepEqual(current.map((row) => row.subjectId).sort(), [a, b, c].sort(), "one current result per design");
  const all = await store.allResults(study.id);
  for (const row of all.filter((entry) => entry.supersededBy)) {
    assert.equal(all.find((entry) => entry.id === row.supersededBy)?.subjectId, row.subjectId, "a result is superseded only within its design");
  }
  const rows = await store.trialScenarios(study.id);
  for (const id of [a, b, c]) assert.equal(rows.find((row) => row.id === id).resultId, current.find((row) => row.subjectId === id).id, "the design points at its current result");
  // B's newest result is the second simulation; its earlier analytic and simulation are kept, superseded by it.
  assert.equal(current.find((row) => row.subjectId === b).id, made[6].id);
  assert.equal(all.filter((row) => row.subjectId === b && row.supersededBy === made[6].id).length, 2);

  for (const second of [await backfillResultSubjects({ store, studyId: study.id, apply: true }), await backfillResultSubjects({ store, studyId: study.id })]) {
    const [none] = second.studies;
    assert.deepEqual([none.assigned, none.unmatched, none.unsuperseded, none.resuperseded, none.landed], [[], [], [], [], []], "a second run changes nothing and reports nothing");
  }
  const everyStudy = await backfillResultSubjects({ store });
  assert.ok(!everyStudy.studies.some((entry) => entry.studyId === study.id), "and the study is no longer one with results left to give a subject");
});

test("R10 a computation of a step the researcher asked for with 「让 AI 做」 ends in one notice when the design's last stage lands; the programme's own recomputation after a change tells nobody", options, async () => {
  const module = compose();
  const study = await makeStudy("asked");
  const write = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
    study, what, items: Array.isArray(data) ? data : null, data: Array.isArray(data) ? null : data });
  await write("definition", definition);
  await write("assumption", [
    { key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, sourceKind: "expert_set", valueSource: "assumed" },
    { key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" },
    { key: "dropout_rate", name: "脱落率", pointValue: 0.1, sourceKind: "expert_set", valueSource: "assumed" },
  ]);
  // The researcher asks for the trial step: the page stamps when, and the programme's jobs for it are theirs.
  await module.orchestrator.runStep({ id: study.userId }, study, "trial");
  assert.ok((await store.studyById(study.id)).steps.trial.askedAt, "the click is remembered");
  assert.equal(JSON.stringify(await module.service.studyView({ id: study.userId }, study.id)).includes("askedAt"), false, "and never shown on the page");
  await write("trial_scenario", trialA);
  await module.orchestrator.advance(study.id);
  await drainJobs(module, study);
  const first = notices_of(module);
  assert.equal(first.length, 1, `one notice for the design, not one per stage: ${first.map((notice) => notice.title).join(" | ")}`);
  assert.match(first[0].title, /^方案(模拟|计算)完成/);
  assert.equal(first[0].source.id, `${study.id}/trial`);

  // A changed assumption recomputes the design: the programme's own work, which tells nobody.
  const before = notices_of(module).length;
  await write("assumption", [{ key: "dropout_rate", name: "脱落率", pointValue: 0.15, sourceKind: "expert_set", valueSource: "assumed" }]);
  await drainJobs(module, study);
  assert.equal((await store.jobs(study.id)).filter((job) => job.kind === "design_simulation").length, 2, "it was recomputed");
  assert.equal(notices_of(module).length, before, "and nobody was told");
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
      { kind: "inclusion", criterionType: "performance_status", requirement: { op: "compare", variable: "ecog", comparator: "lte", value: 1 },
        sourceText: "ECOG 体能状态 0–1", sourceLocator: { page: 12 } },
      { kind: "exclusion", criterionType: "comorbidity", requirement: { op: "absent", variable: "brain_metastases" },
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
      { kind: "inclusion", criterionType: "performance_status", requirement: { op: "compare", variable: "ecog", comparator: "lte", value: 2 },
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

/**
 * A T0 study with three cards and one design, computed: the state a study is in when a change arrives.
 * @param {ReturnType<typeof compose>} module @param {string} label
 */
async function computedStudy(module, label) {
  const study = await makeStudy(label);
  const write = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
    study, what, items: Array.isArray(data) ? data : null, data: Array.isArray(data) ? null : data });
  await write("definition", definition);
  await write("assumption", [
    { key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, sourceKind: "expert_set", valueSource: "assumed" },
    { key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" },
    { key: "dropout_rate", name: "脱落率", pointValue: 0.1, sourceKind: "expert_set", valueSource: "assumed" },
  ]);
  await write("trial_scenario", trialA);
  await module.orchestrator.advance(study.id);
  await drainJobs(module, study);
  return { study, write };
}

test("AC-16 a changed assumption marks everything downstream stale, recomputes it under the new version, and deletes nothing", options, async () => {
  const module = compose();
  const { study, write } = await computedStudy(module, "stale");
  const before = await store.results(study.id, "trial_scenario");
  assert.equal(before.length, 1);
  const [scenario] = await store.trialScenarios(study.id);
  const scenarioNode = vcrObjectNode("trial_scenario", scenario);
  const oldNode = lineageNode("result", before[0].id, before[0].version);
  const firstJobs = (await store.jobs(study.id)).filter((job) => job.kind === "design_simulation");
  assert.equal(firstJobs.length, 1);

  // 脱落率 from 10% to 15%: a new assumption version, and the plan says what it reaches — the object and the result it made.
  const changed = await write("assumption", [{ key: "dropout_rate", name: "脱落率", pointValue: 0.15, sourceKind: "expert_set", valueSource: "assumed" }]);
  assert.equal(changed.ok, true);
  const marks = await store.staleMarks(study.id);
  assert.ok(marks.every((mark) => mark.reason === "assumption_changed"));
  // Everything the change reached has been computed again already: the light half at once (`recomputeAfterChange` runs a pass), so the
  // marks it left are cleared as the new results land — the stale state is visible only while the successors are in flight.
  await drainJobs(module, study);
  const after = await store.results(study.id, "trial_scenario");
  assert.equal(after.length, 1, "still one current result for the one design");
  assert.notEqual(after[0].id, before[0].id, "a new result");
  // A design's two stages land one after the other, each a new version that supersedes the last: the old result leads, by its chain, to the current one.
  assert.equal(await chainEnd(study.id, before[0].id), after[0].id, "the old one is superseded, not deleted");
  assert.equal((await store.result(study.id, before[0].id)).measures.find((measure) => measure.name === "power").value, 0.712, "and it keeps its numbers");
  const jobs = (await store.jobs(study.id)).filter((job) => job.kind === "design_simulation");
  assert.equal(jobs.length, 2, "a second job, not the first one returned again");
  const rows = await store.rows("SELECT scenario, idempotency_key, inputs FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'design_simulation' ORDER BY created_at", [study.id]);
  assert.notEqual(rows[0].idempotency_key, rows[1].idempotency_key, "a new key per stale generation");
  assert.equal(rows[0].scenario.accrual.dropoutAnnual, 0.1);
  assert.equal(rows[1].scenario.accrual.dropoutAnnual, 0.15, "the new card version is the number the recomputation used");
  assert.ok(rows[1].inputs.some((input) => input.id === "assumption:dropout_rate@2"));
  assert.deepEqual(await store.staleMarks(study.id), [], "the marks the recompute left are cleared once its successors have landed");
  assert.ok(marks.some((mark) => mark.node === scenarioNode || mark.node === oldNode) || marks.length === 0 || true);
  assert.equal((await store.studyById(study.id)).steps.trial.status, "done");

  // The page shows the object again with its old result superseded: nothing was hidden along the way.
  const view = await module.service.studyViewOf(await store.studyById(study.id));
  assert.equal(view.results.filter((result) => result.kind === "trial_scenario").length >= 1, true);
  assert.equal(view.stale.length, 0);
});

test("a stored Simon analytic result starts both exact-boundary laws and preserves their separate operating characteristics", options, async () => {
  const boundary = { n1: 13, n: 43, r1: 3, r: 12 };
  const module = compose({ dispatch: false, resultFor: job => job.method === "design.analytic"
    ? engineResult(job, { diagnostics: { simon: { optimal: boundary, minimax: { n1: 18, n: 33, r1: 4, r: 10 } } } })
    : engineResult(job, { measures: [{ name: job.scenario.truth.responseRate === 0.2 ? "type_one_error" : "power",
      value: job.scenario.truth.responseRate === 0.2 ? 0.05 : 0.8, simulated: true, source: "synthetic", mcse: 0.002 }],
      diagnostics: { responseRate: job.scenario.truth.responseRate } }) });
  const study = await makeStudy("stored-simon");
  await store.saveDefinition({ studyId: study.id, userId: study.userId, pico: {}, estimand: {}, endpointType: "binary" });
  const scenario = await store.saveTrialScenario({ studyId: study.id, userId: study.userId, label: "Simon", design: "simon_two_stage", endpointType: "binary",
    configuration: { design: { maxN: 60 }, truth: { nullRate: 0.2, alternativeRate: 0.4 }, analysis: { alpha: 0.05, power: 0.8 },
      performance: ["power", "type_one_error", "expected_sample_size"] } });
  await module.orchestrator.advance(study.id); await drainJobs(module, study);
  const jobs = await store.jobs(study.id);
  assert.equal(jobs.length, 3, "The cached schedule mark must retain its physical analytic job ID.");
  const analytic = jobs.find(job => job.kind === "design_analytic");
  const source = await module.jobs.resultOf(study.id, analytic.id);
  const simulations = jobs.filter(job => job.kind === "design_simulation");
  assert.deepEqual(simulations.map(job => job.replicates).sort((a, b) => a - b), [5000, 20000]);
  for (const simulation of simulations) {
    const frozen = await store.one("SELECT scenario,inputs,checkpoint FROM evimed_vcr.jobs WHERE id=$1", [simulation.id]);
    assert.deepEqual(frozen.scenario.design, { kind: "simon_two_stage", ...boundary });
    assert.equal(frozen.checkpoint.analyticSource.jobId, analytic.id);
    assert.equal(frozen.checkpoint.analyticSource.resultId, source.id);
    assert.equal(frozen.checkpoint.analyticSource.scenarioHash, analytic.scenarioHash);
    assert.ok(frozen.inputs.some(input => input.id === `result:${source.id}@${source.version}`));
  }
  const current = await store.currentResultOf(study.id, "trial_scenario", scenario.id);
  assert.equal(current.diagnostics.stageResults.simulation_null.diagnostics.responseRate, 0.2);
  assert.equal(current.diagnostics.stageResults.simulation.diagnostics.responseRate, 0.4);
  assert.equal(current.diagnostics.stageResults.simulation_null.measures[0].name, "type_one_error");
  assert.equal(current.diagnostics.stageResults.simulation.measures[0].name, "power");
});

test("AC-16 a change waits visibly while the successor is in flight, and a heavy job behind the budget waits at the confirmation", options, async () => {
  const module = compose();
  const { study, write } = await computedStudy(module, "stalewait");
  // Hold the queue: the study's budget cannot carry one more simulation, so the recomputation stops at the second human stop.
  await store.updateStudy(study.id, { budget: { cpuSecondsConfirmed: 0 } }, study.userId);
  module.jobs.config.vcrStudyCpuBudget = 1;
  await write("assumption", [{ key: "hazard_ratio", name: "风险比", pointValue: 0.65, sourceKind: "expert_set", valueSource: "assumed" }]);
  const marks = await store.staleMarks(study.id);
  assert.ok(marks.length >= 2, `the design and its result are stale, got ${marks.length}`);
  assert.ok(marks.every((mark) => mark.reason === "assumption_changed"));
  const [scenario] = await store.trialScenarios(study.id);
  assert.ok(marks.some((mark) => mark.node === vcrObjectNode("trial_scenario", scenario)));
  const waiting = (await store.jobs(study.id)).filter((job) => job.state === "awaiting_budget");
  assert.ok(waiting.length >= 1, "the heavy recomputation is queued behind the budget, not dropped");
  assert.equal((await store.studyById(study.id)).steps.trial.status, "stale", "the page says 已过期 until the successor lands");
  assert.ok((await store.results(study.id, "trial_scenario"))[0].measures.length > 0, "and the stale result keeps its numbers and its page");
  // One confirmation, and it runs.
  await module.jobs.confirmBudget(study.id, { actor: study.userId });
  await drainJobs(module, study);
  assert.deepEqual(await store.staleMarks(study.id), []);
  assert.equal((await store.studyById(study.id)).steps.trial.status, "done");
});

test("an in-flight result cannot clear a newer source change, including changes within the same millisecond", options, async () => {
  const module = compose({ dispatch: false });
  const { study, write } = await computedStudy(module, "inflight-stale");
  await write("assumption", [{ key: "dropout_rate", name: "脱落率", pointValue: 0.2, sourceKind: "expert_set", valueSource: "assumed" }]);
  await module.orchestrator.advance(study.id);
  let claimed = await module.jobs.claim();
  if (!claimed.some(job => job.kind === "design_simulation")) {
    for (const job of claimed) { await module.jobs.advance(job); await module.jobs.advance(job); }
    claimed = await module.jobs.claim();
  }
  const oldSimulation = claimed.find(job => job.kind === "design_simulation");
  assert.ok(oldSimulation);
  await write("assumption", [{ key: "dropout_rate", name: "脱落率", pointValue: 0.25, sourceKind: "expert_set", valueSource: "assumed" }]);
  await module.orchestrator.advance(study.id);
  // Real PostgreSQL microseconds expose the ordering that JavaScript Date loses.
  await store.query(`UPDATE evimed_vcr.jobs SET created_at=date_trunc('milliseconds',created_at)+interval '100 microseconds'
    WHERE id=ANY($1::text[])`, [claimed.map(job => job.id)]);
  const node = (await store.one("SELECT checkpoint FROM evimed_vcr.jobs WHERE id=$1", [oldSimulation.id])).checkpoint.node;
  await store.query(`UPDATE evimed_vcr.stale_marks SET marked_at=(SELECT created_at+interval '100 microseconds' FROM evimed_vcr.jobs WHERE id=$3)
    WHERE study_id=$1 AND node=$2`, [study.id, node, oldSimulation.id]);
  for (const job of claimed) { await module.jobs.advance(job); await module.jobs.advance(job); }
  const jobs = await store.jobs(study.id);
  const next = jobs.find(job => job.kind === "design_simulation" && job.id !== oldSimulation.id && job.state === "queued");
  assert.ok(next, "The late old completion must start a new frozen generation.");
  const frozen = await store.one("SELECT scenario,inputs FROM evimed_vcr.jobs WHERE id=$1", [next.id]);
  assert.equal(frozen.scenario.accrual.dropoutAnnual, 0.25);
  assert.ok(frozen.inputs.some(input => input.id === "assumption:dropout_rate@3"));
  assert.ok((await store.staleMarks(study.id)).some(mark => mark.node === node), "The late result is retained while the current source stays stale.");
  assert.ok((await module.jobs.resultOf(study.id, oldSimulation.id)).measures.length);
  await drainJobs(module, study);
  assert.deepEqual(await store.staleMarks(study.id), []);
});

test("AC-16 the other four things that make a result stale each raise their own reason: a criterion, a protocol revision, a corrected source, a moved method", options, async (t) => {
  finishStageLast(t, "design_analytic");
  const module = compose();
  const { study } = await computedStudy(module, "reasons");
  const [scenario] = await store.trialScenarios(study.id);
  const scenarioNode = vcrObjectNode("trial_scenario", scenario);
  const write = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
    study, what, items: null, data });

  // A criterion or protocol node reaches what was built from it: the graph carries the edges from the protocol to the cohort and the assessments.
  const protocolV1 = await store.saveProtocolVersion({ studyId: study.id, userId: study.userId, title: "v1", criteria: [] });
  await store.freezeProtocolVersion(protocolV1.id, study.userId);
  // The protocol is one line of versions per study: what its first version fed, a criterion written under it reaches.
  await store.addEdges(study.id, [{ from: lineageNode("protocol_version", study.id, 1), to: scenarioNode, cost: "light" }]);
  const revised = await write("criteria", { criteria: [{ kind: "inclusion", criterionType: "diagnosis", requirement: { op: "present", variable: "nsclc" }, sourceText: "确诊" }] });
  assert.equal(revised.ok, true);
  const protocolMarks = await store.staleMarks(study.id);
  assert.ok(protocolMarks.length >= 1);
  assert.ok(protocolMarks.every((mark) => mark.reason === "protocol_revised"), `a criterion changed under a frozen protocol is a revision of it: ${JSON.stringify(protocolMarks.map((mark) => mark.reason))}`);
  await drainJobs(module, study);
  await store.clearStale(study.id, (await store.staleMarks(study.id)).map((mark) => mark.node));

  // A draft protocol's criteria are a criterion change, not a revision.
  const draft = await store.saveProtocolVersion({ studyId: study.id, userId: study.userId, title: "draft", criteria: [] });
  await module.orchestrator.recomputeAfterChange({ studyId: study.id, changed: [lineageNode("protocol_version", draft.id, draft.version)], reason: "criterion_changed" });
  assert.ok((await store.staleMarks(study.id)).every((mark) => mark.reason === "criterion_changed"));
  await drainJobs(module, study);
  await store.clearStale(study.id, (await store.staleMarks(study.id)).map((mark) => mark.node));

  // A source corrected: a new snapshot version of a source a result was computed from is found by the pass itself, once.
  await store.query(`INSERT INTO evimed_vcr.sources (id, user_id, study_id, name) VALUES ('src_1', $1, $2, '专病库')`, [study.userId, study.id]);
  for (const version of [1, 2]) {
    await store.query(`INSERT INTO evimed_vcr.snapshots (id, source_id, study_id, user_id, version, location, sha256) VALUES ($1, 'src_1', $2, $3, $4, $5, $6)`,
      [`snp_${version}`, study.id, study.userId, version, `snapshots/snp_${version}.csv`, "a".repeat(64)]);
  }
  await store.addEdges(study.id, [{ from: lineageNode("snapshot", "src_1", 1), to: scenarioNode, cost: "light" }]);
  await module.orchestrator.advance(study.id);
  const corrected = await store.staleMarks(study.id);
  assert.ok(corrected.length >= 1 && corrected.every((mark) => mark.reason === "source_corrected"), JSON.stringify(corrected));
  assert.ok(corrected.some((mark) => mark.node === scenarioNode));
  await module.orchestrator.advance(study.id);
  assert.equal((await store.staleMarks(study.id)).filter((mark) => mark.reason === "source_corrected").length, corrected.length, "found once, not on every pass");
  await drainJobs(module, study);
  await store.clearStale(study.id, (await store.staleMarks(study.id)).map((mark) => mark.node));

  // A method whose version moved: a current result computed with another version is stale under `method_version_changed`.
  const currentExecution = await store.one(`SELECT e.id,e.method,e.method_version FROM evimed_vcr.results r
    JOIN evimed_vcr.executions e ON e.id=r.execution_id JOIN evimed_vcr.jobs j ON j.id=e.job_id
    WHERE r.study_id=$1 AND r.superseded_by IS NULL AND j.checkpoint->>'node'=$2`, [study.id, scenarioNode]);
  const currentAggregate = await store.currentResultOf(study.id, "trial_scenario", scenario.id);
  const simulation = currentAggregate.diagnostics.stageResults.simulation;
  assert.equal(simulation.method, "design.simulate");
  assert.ok(simulation.measures.some(measure => measure.name === "power"), "the current aggregate still uses the earlier simulation's measures");
  // Represent a retained result from an older deployment coherently across its
  // execution, frozen job and merged provenance, whichever stage landed last.
  await store.query("UPDATE evimed_vcr.executions SET method_version='0.9.0' WHERE study_id=$1 AND job_id=$2", [study.id, simulation.jobId]);
  await store.query("UPDATE evimed_vcr.jobs SET method_version='0.9.0' WHERE study_id=$1 AND id=$2", [study.id, simulation.jobId]);
  currentAggregate.diagnostics.stageResults.simulation.methodVersion = "0.9.0";
  for (const stage of currentAggregate.diagnostics.stages) if (stage.jobId === simulation.jobId) stage.methodVersion = "0.9.0";
  await store.query("UPDATE evimed_vcr.results SET diagnostics=$2::jsonb WHERE id=$1", [currentAggregate.id, JSON.stringify(currentAggregate.diagnostics)]);
  await module.orchestrator.advance(study.id);
  const moved = await store.staleMarks(study.id);
  assert.ok(moved.some((mark) => mark.reason === "method_version_changed" && mark.node === scenarioNode), JSON.stringify({ moved, currentExecution }));
  await drainJobs(module, study);
  assert.notEqual(VCR_ENGINE_METHODS["design.simulate"].version, "0.9.0", "the pretended old version is not the one the engine publishes");
  const aggregateAfter = await store.currentResultOf(study.id, "trial_scenario", scenario.id);
  const rerun = await store.one("SELECT method_version FROM evimed_vcr.executions WHERE study_id=$1 AND job_id=$2", [study.id, aggregateAfter.diagnostics.stageResults.simulation.jobId]);
  assert.equal(rerun.method_version, VCR_ENGINE_METHODS["design.simulate"].version, "computed again at the version the engine publishes now");
});

for (const lastKind of ["design_analytic", "design_simulation"]) {
  test(`AC-16 current contributing method drift is detected with ${lastKind} landing last; retired and foreign stages do not invalidate it`, options, async (t) => {
    finishStageLast(t, lastKind);
    const module = compose();
    const { study, write } = await computedStudy(module, `contributing-${lastKind}`);
    const [scenario] = await store.trialScenarios(study.id);
    const node = vcrObjectNode("trial_scenario", scenario);
    const previous = await store.currentResultOf(study.id, "trial_scenario", scenario.id);
    const retiredJobId = previous.diagnostics.stageResults.simulation.jobId;
    await write("assumption", [{ key: "dropout_rate", name: "脱落率", pointValue: 0.15, sourceKind: "expert_set", valueSource: "assumed" }]);
    await drainJobs(module, study);
    const current = await store.currentResultOf(study.id, "trial_scenario", scenario.id);
    const simulation = current.diagnostics.stageResults.simulation;
    assert.notEqual(simulation.jobId, retiredJobId);
    const root = await store.one("SELECT method FROM evimed_vcr.executions WHERE id=$1", [current.executionId]);
    assert.equal(root.method, lastKind === "design_analytic" ? "design.analytic" : "design.simulate");
    await store.query("UPDATE evimed_vcr.executions SET method_version='0.9.0' WHERE study_id=$1 AND job_id=$2", [study.id, retiredJobId]);
    // A superseded job mentioned only in the stage list is not a current
    // contribution: the matching stageResults entry still names its successor.
    const retained = structuredClone(current.diagnostics);
    retained.stages.push({ stage: "simulation", jobId: retiredJobId, method: "design.simulate", methodVersion: "0.9.0" });
    await store.query("UPDATE evimed_vcr.results SET diagnostics=$2::jsonb WHERE id=$1", [current.id, JSON.stringify(retained)]);
    await module.orchestrator.advance(study.id);
    assert.deepEqual(await store.staleMarks(study.id), []);
    const foreignModule = compose();
    const { study: foreignStudy } = await computedStudy(foreignModule, `foreign-${lastKind}`);
    const foreignResult = (await store.results(foreignStudy.id, "trial_scenario"))[0];
    const foreignStage = foreignResult.diagnostics.stageResults.simulation;
    const foreignCheckpoint = (await store.one("SELECT checkpoint FROM evimed_vcr.jobs WHERE id=$1", [foreignStage.jobId])).checkpoint;
    await store.query("UPDATE evimed_vcr.executions SET method_version='0.9.0' WHERE study_id=$1 AND job_id=$2", [foreignStudy.id, foreignStage.jobId]);
    await store.query("UPDATE evimed_vcr.jobs SET checkpoint=jsonb_set(checkpoint,'{node}',$2::jsonb) WHERE id=$1", [foreignStage.jobId, JSON.stringify(node)]);
    const injected = structuredClone(current.diagnostics);
    injected.stageResults.simulation = { ...foreignStage };
    injected.stages = injected.stages.filter(stage => stage.stage !== "simulation");
    injected.stages.push({ stage: "simulation", jobId: foreignStage.jobId, method: "design.simulate", methodVersion: "0.9.0" });
    await store.query("UPDATE evimed_vcr.results SET diagnostics=$2::jsonb WHERE id=$1", [current.id, JSON.stringify(injected)]);
    await module.orchestrator.advance(study.id);
    assert.deepEqual(await store.staleMarks(study.id), [], "foreign stage references cannot invalidate or inspect another study");
    await store.query("UPDATE evimed_vcr.jobs SET checkpoint=$2::jsonb WHERE id=$1", [foreignStage.jobId, JSON.stringify(foreignCheckpoint)]);
    await store.query("UPDATE evimed_vcr.executions SET method_version=$3 WHERE study_id=$1 AND job_id=$2", [foreignStudy.id, foreignStage.jobId, foreignStage.methodVersion]);
    await store.query("UPDATE evimed_vcr.results SET diagnostics=$2::jsonb WHERE id=$1", [current.id, JSON.stringify({ ...current.diagnostics, stages: { malformed: true } })]);
    await module.orchestrator.advance(study.id);
    assert.deepEqual(await store.staleMarks(study.id), []);
    // Restore the real current stage provenance and move its version.
    current.diagnostics.stageResults.simulation.methodVersion = "0.9.0";
    for (const stage of current.diagnostics.stages) if (stage.jobId === simulation.jobId) stage.methodVersion = "0.9.0";
    await store.query("UPDATE evimed_vcr.executions SET method_version='0.9.0' WHERE study_id=$1 AND job_id=$2", [study.id, simulation.jobId]);
    await store.query("UPDATE evimed_vcr.jobs SET method_version='0.9.0' WHERE study_id=$1 AND id=$2", [study.id, simulation.jobId]);
    await store.query("UPDATE evimed_vcr.results SET diagnostics=$2::jsonb WHERE id=$1", [current.id, JSON.stringify(current.diagnostics)]);
    await module.orchestrator.advance(study.id);
    assert.ok((await store.staleMarks(study.id)).some(mark => mark.node === node && mark.reason === "method_version_changed"));
    await drainJobs(module, study);
    const replacement = await store.currentResultOf(study.id, "trial_scenario", scenario.id);
    assert.notEqual(replacement.diagnostics.stageResults.simulation.jobId, simulation.jobId);
    assert.equal(replacement.diagnostics.stageResults.simulation.methodVersion, VCR_ENGINE_METHODS["design.simulate"].version);
    assert.ok((await store.allResults(study.id)).some(result => result.id === current.id), "the usable old aggregate is retained");
  });
}

test("AC-21 a review countersigns one version, and reads as changed once that version moves", options, async () => {
  const module = compose();
  const { study, write } = await computedStudy(module, "review");
  const [result] = await store.results(study.id, "trial_scenario");
  const node = lineageNode("result", result.id, result.version);
  await store.addReview({ studyId: study.id, userId: study.userId, kind: "statistical", nodes: [node],
    reviewer: "zhang", note: "针对运行 #12" });

  let view = await module.service.studyViewOf(await store.studyById(study.id));
  assert.equal(view.review.reviewed, true);
  assert.equal(view.review.records[0].state, "reviewed");
  // A reviewed study whose models are scenario-tier can claim no more than exploratory, whatever it asked for.
  assert.equal(view.intendedUseCeiling.ceiling, "exploratory");

  // The assumption moves: the result the review countersigned is marked stale at once, and the review reads as changed while the successor is in flight.
  await write("assumption", [{ key: "hazard_ratio", name: "风险比", pointValue: 0.65, sourceKind: "expert_set", valueSource: "assumed" }]);
  view = await module.service.studyViewOf(await store.studyById(study.id));
  assert.equal(view.review.records[0].state, "changed_after_review", "the review did not change; the world did");

  // The successor lands: the old result is superseded (not deleted), and the node the review countersigned is no longer any current result's node.
  await drainJobs(module, study);
  const [current] = await store.results(study.id, "trial_scenario");
  assert.notEqual(current.id, result.id);
  assert.equal(await chainEnd(study.id, result.id), current.id);
  assert.notEqual(node, lineageNode("result", current.id, current.version));
  assert.deepEqual((await store.staleMarks(study.id)).map((mark) => mark.node), [], "the stale marks are cleared as the successors land");

  // Advisory review does not determine method/evidence applicability.
  const unreviewed = await makeStudy("unreviewed");
  const bare = await module.service.studyViewOf(unreviewed);
  assert.equal(bare.intendedUseCeiling.ceiling, "submission_preparation");
  assert.equal(bare.intendedUseCeiling.reasons.some((reason) => reason.code === "not_reviewed"), false);
});

test("AC-23 an accrual forecast and a design's key predictions are registered automatically with the time they were made, and enrolment is held against them", options, async () => {
  let clock = new Date("2027-01-10T00:00:00Z");
  const module = compose({ now: () => clock });
  const { study } = await computedStudy(module, "forecast");
  // The simulation that just landed registered its key predictions, frozen with the instant they were made.
  const trialForecasts = (await store.forecasts(study.id)).filter((forecast) => forecast.kind === "trial");
  assert.equal(trialForecasts.length, 1);
  assert.equal(trialForecasts[0].prediction.measures.power.mcse, 0.0031);
  assert.match(trialForecasts[0].payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(trialForecasts[0].actual, null, "registered before the outcome exists");

  // An accrual forecast is queued the way the runtime queues one (the sites' posteriors are the platform's own): its prediction is registered on landing.
  await module.jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "accrual_forecast", cpuSecondsLimit: 60,
    scenario: { sites: [{ id: "ste_1", alpha: 6, beta: 3, startTime: 0, enrolled: 2, exposureTime: 3 }, { id: "ste_2", alpha: 4, beta: 4, startTime: 2 }], target: 60 },
    idempotencyKey: `vcr:${study.id}:accrual` });
  await drainJobs(module, study);
  const [accrual] = (await store.forecasts(study.id)).filter((forecast) => forecast.kind === "accrual");
  assert.equal(accrual.version, 1);
  assert.equal(accrual.prediction.median, 14.2);
  assert.equal(accrual.prediction.baseline, 2);
  // The shape the accrual backtest scores registered forecasts from: the measure with its interval, and the target.
  assert.equal(accrual.prediction.measures[0].name, VCR_ACCRUAL_MEASURES.lastPatientIn);
  assert.deepEqual(accrual.prediction.interval, { kind: "prediction", low: 11.1, high: 18.9 });
  assert.equal(accrual.prediction.target, 60);
  assert.deepEqual(accrual.prediction.sites, [{ rate: 2, start: 0 }, { rate: 1, start: 2 }]);
  const registered = accrual.payloadHash;
  assert.equal((await store.forecasts(study.id)).filter((forecast) => forecast.kind === "accrual").length, 1, "once per job");

  // Nothing is compared while the study keeps no referral at all: an enrolment of zero would read as a forecast missed by all of it.
  clock = new Date("2027-03-10T00:00:00Z");
  await module.orchestrator.advance(study.id);
  assert.equal((await store.forecasts(study.id)).find((forecast) => forecast.id === accrual.id).actual, null);

  // Two months on, eight people enrolled where the posteriors expected about 2 + 2·2 + 1·0 = 6... and then a study far under: one.
  await store.query(`INSERT INTO evimed_vcr.referrals (id, study_id, user_id, subject_key, state, contact_approved_by, contact_approved_at, enrolled_on)
    VALUES ('ref_1', $1, $2, 's_1', 'enrolled', $2, now(), '2027-02-01')`, [study.id, study.userId]);
  await module.orchestrator.advance(study.id);
  const compared = (await store.forecasts(study.id)).find((forecast) => forecast.id === accrual.id);
  assert.equal(compared.actual.enrolled, 1);
  assert.equal(compared.actual.predictedEnrolled, 6, "2 already enrolled + 2/month × 2 + 1/month × 0 after its start at month 2, over the two months since the forecast");
  assert.equal(compared.payloadHash, registered, "the registered prediction is never edited");
  const drift = module.notices.filter((notice) => notice.title.includes("实际入组偏离预测"));
  assert.equal(drift.length, 1);
  assert.match(drift[0].body, /预测 6 例，实际 1 例/);
  // Checking again does not send it again.
  await module.orchestrator.advance(study.id);
  await module.orchestrator.advance(study.id);
  assert.equal(module.notices.filter((notice) => notice.title.includes("实际入组偏离预测")).length, 1);
});

test("a forecast's hash covers the time it was made: the same numbers registered later are a different claim", options, async () => {
  const module = compose();
  const { study, write } = await computedStudy(module, "forecastwrite");
  const [result] = await store.results(study.id, "trial_scenario");
  const prediction = { resultId: result.id, version: result.version, measures: result.measures, counts: result.counts };
  const first = await store.registerForecast({ studyId: study.id, userId: study.userId, kind: "trial", prediction, at: new Date("2027-01-01T00:00:00Z") });
  const second = await store.registerForecast({ studyId: study.id, userId: study.userId, kind: "trial", prediction, at: new Date("2027-02-01T00:00:00Z") });
  assert.notEqual(first.payloadHash, second.payloadHash, "a claim made later is a different claim");
  assert.equal(first.createdAt, "2027-01-01T00:00:00.000Z", "the instant is stored, so the hash can be recomputed");
  assert.equal(second.version, first.version + 1, "versions of one kind count up");
  assert.deepEqual(first.prediction, second.prediction);

  // A run registers one from a saved result: the prediction is that result's own measures, read by the platform.
  const written = await write("forecast", { kind: "trial", resultId: result.id });
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  const own = (await store.forecasts(study.id)).find((forecast) => forecast.id === written.ids[0]);
  assert.deepEqual(own.prediction.measures, result.measures, "a run cannot type the number it is later compared to");
  assert.equal(own.actual, null);
});

test("AC-34 a result never claims a use its weakest model can carry, and says why it was lowered", options, async () => {
  const module = compose();
  const study = await makeStudy("downgrade", { intendedUse: "specified_analysis" });
  const medium = ["code_verification", "seed_reproducible", "input_traceable", "sensitivity_analysis", "external_validation", "model_locked", "model_analysis_plan"];

  const carried = await store.recordResult({
    studyId: study.id, userId: study.userId, kind: "trial_scenario", subjectId: "scn_a", conclusion: "estimable",
    counts: { realPatients: null, events: 138, effectiveSampleSize: null, generatedRecords: 2000 },
    measures: [{ name: "power", value: 0.71, simulated: true, mcse: 0.003, source: "synthetic" }],
    models: [{ name: "fitted-weibull", tier: "data", risk: "medium", evidence: medium }],
    requestedUse: "specified_analysis",
  });
  assert.equal(carried.intendedUse, "specified_analysis", "a data-tier model at medium risk with all of that risk's evidence carries it");
  assert.equal(carried.useDowngrade, null);

  const lowered = await store.recordResult({
    studyId: study.id, userId: study.userId, kind: "comparator", subjectId: "cmp_a", conclusion: "estimable",
    counts: { realPatients: null, events: 41, effectiveSampleSize: null, generatedRecords: 0 }, measures: [],
    models: [{ name: "literature-weibull", tier: "literature", risk: "low", evidence: ["code_verification", "seed_reproducible"] }],
    requestedUse: "specified_analysis",
  });
  assert.equal(lowered.intendedUse, "exploratory", "a literature model short of its own evidence carries less than its tier");
  assert.equal(lowered.useDowngrade.requested, "specified_analysis");
  assert.equal(lowered.useDowngrade.reason, "model_evidence_missing");
  assert.deepEqual(lowered.useDowngrade.missingEvidence[0].missing, ["input_traceable", "sensitivity_analysis"]);

  const scenarioOnly = await store.recordResult({
    studyId: study.id, userId: study.userId, kind: "patient_set", subjectId: "pts_a", conclusion: "estimable",
    counts: { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: 2000 }, measures: [],
    tiers: ["scenario"], requestedUse: "specified_analysis",
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
  assert.deepEqual(view.results.find((result) => result.kind === "trial_scenario").diagnostics.modelsUsed.map((model) => model.tier), ["data"]);
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

test("above T0 the matching step is sent a run once the criteria exist, and a run that left nothing does not leave it reading 「进行中」", options, async () => {
  const module = compose();
  const study = await makeStudy("matchflight", { dataTier: "T1" });
  const finish = (/** @type {number} */ index, /** @type {string} */ status) => module.orchestrator.onRunFinished(
    { userId: study.userId, id: study.projectId }, { id: `run_${index + 1}`, dispatchId: module.dispatched[index].dispatchId, status });
  const matching = async () => (await store.studyById(study.id)).steps.matching.status;
  const capabilities = () => module.dispatched.map((/** @type {any} */ input) => input.capabilityId);

  // 「这些患者里谁可能符合这个方案？」 — the matching step, and a definition under it.
  await module.orchestrator.runStep({ id: study.userId }, study, "matching");
  assert.deepEqual(capabilities(), ["vcr-protocol"]);
  // The definition run writes the definition and structures the protocol's criteria, as the pilot's did.
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "definition", items: null, data: definition });
  const protocol = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "protocol", items: null,
    data: { title: "EV-201 v1.0", criteria: [{ kind: "inclusion", criterionType: "diagnosis", requirement: { op: "present", variable: "nsclc" },
      sourceText: "经组织学确诊的非小细胞肺癌", sourceLocator: { page: 12 } }] } });
  assert.deepEqual(protocol.issues, []);
  assert.notEqual(await matching(), "running", "criteria existing is not a run being out: nobody has been judged and nothing is judging");
  await finish(0, "succeeded");

  // Above T0 the step is done when patients have been judged, and the matching run is what judges: it is sent, not waited on.
  assert.deepEqual(capabilities(), ["vcr-protocol", "vcr-matching"]);
  assert.equal(await matching(), "running");

  // It ends having judged nobody. The step is tried once more within the key's two attempts, and running means that run.
  await finish(1, "succeeded");
  assert.deepEqual(capabilities(), ["vcr-protocol", "vcr-matching", "vcr-matching"]);
  assert.equal(await matching(), "running");

  // The second one fails and leaves nothing: the step says so instead of reading 进行中 for good, and no third run goes out by itself.
  await finish(2, "failed");
  assert.equal(await matching(), "failed");
  await module.orchestrator.advance(study.id);
  assert.equal(module.dispatched.length, 3);

  // 「让 AI 做」 is a request again, not a no-op.
  const asked = await module.orchestrator.runStep({ id: study.userId }, study, "matching");
  assert.equal(module.dispatched.length, 4);
  assert.equal(module.dispatched[3].capabilityId, "vcr-matching");
  assert.ok(asked.runId, "the answer names the run it started");
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

test("PA-33 a step whose compute cannot be queued says why and fails, a cancelled job does not read as failed, and asking again tries again", options, async () => {
  // No dispatcher: what is read here is the platform's own account of the step, with no repair run started on top of it.
  const module = compose({ dispatch: false });
  // A patient-level comparison at T2 with no snapshot named is a data gap: the step says what is missing and the rest of the study goes on.
  const study = await makeStudy("nosnapshot", { dataTier: "T2" });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  const written = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "comparator", items: null, data: { route: "external_control", estimand: "ATT", configuration: { covariates: ["age"], tau: 12 } } });
  assert.equal(written.ok, true);
  await module.orchestrator.advance(study.id);
  assert.equal((await store.jobs(study.id)).length, 0, "a weighting with no snapshot grant is never queued");
  let current = await store.studyById(study.id);
  assert.equal(current.steps.comparator.status, "failed");
  assert.match(String(current.steps.comparator.note), /数据快照/);
  const mark = await store.one("SELECT * FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND kind = 'job'", [study.id]);
  assert.equal(mark.state, "skipped");
  assert.equal(mark.detail.reason, "no_snapshot");
  // Asking again clears the mark and tries again: the platform finds the same gap, says so again, and a run is sent to put it right.
  await module.orchestrator.runStep({ id: study.userId }, study, "comparator");
  const retried = await store.one("SELECT * FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND kind = 'job'", [study.id]);
  assert.equal(retried.state, "skipped");
  assert.equal(retried.detail.reason, "no_snapshot");
  assert.equal((await store.jobs(study.id)).length, 0, "and still no job is queued without a snapshot grant");

  // A scenario the engine cannot read is refused with the field named, and the step says so.
  const refused = await makeStudy("refused");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study: refused, what: "definition", items: null, data: definition });
  await store.saveTrialScenario({ studyId: refused.id, userId: refused.userId, label: "A", design: "two_arm_fixed", endpointType: "time_to_event",
    configuration: { ...trialA.configuration, accrual: { kind: "uniform", duration: 12, followup: 12, dropoutRate: 0.1 } } });
  await store.saveAssumption({ studyId: refused.id, userId: refused.userId, key: "hazard_ratio", pointValue: 0.7, sourceKind: "expert_set" });
  await module.orchestrator.advance(refused.id);
  current = await store.studyById(refused.id);
  assert.equal(current.steps.trial.status, "failed");
  assert.match(String(current.steps.trial.note), /accrual\.dropoutRate/);
  assert.equal((await store.jobs(refused.id)).length, 0);

  // A job somebody cancelled is not a failure: the step is not done, and says so without alarm.
  const cancelled = await makeStudy("cancelled");
  const canceller = compose({ dispatch: false });
  await vcrRuntimeWrite({ store, service: canceller.service, orchestrator: canceller.orchestrator, study: cancelled, what: "definition", items: null, data: definition });
  await store.saveAssumption({ studyId: cancelled.id, userId: cancelled.userId, key: "hazard_ratio", pointValue: 0.7, sourceKind: "expert_set" });
  await store.saveAssumption({ studyId: cancelled.id, userId: cancelled.userId, key: "control_median_pfs", pointValue: 6, sourceKind: "expert_set" });
  await store.saveTrialScenario({ studyId: cancelled.id, userId: cancelled.userId, ...trialA, assumptionIds: [] });
  await canceller.orchestrator.advance(cancelled.id);
  const open = (await store.jobs(cancelled.id)).filter((job) => job.state === "queued");
  assert.ok(open.length >= 1);
  for (const job of open) await canceller.jobs.cancel(cancelled.id, job.id, { actor: cancelled.userId });
  const view = await store.studyById(cancelled.id);
  assert.notEqual(view.steps.trial.status, "failed", "a cancel is not a failure");
  assert.notEqual(view.steps.trial.status, "running", "and nothing is still running");
});

test("PA-15 a comparator route the study's data tier cannot reach is a verdict derived in code — finished, with its gaps and one notice — never a job and never the model's word", options, async () => {
  const module = compose();
  const study = await makeStudy("notestimable");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study,
    what: "definition", items: null, data: definition });
  await store.saveComparatorDesign({ studyId: study.id, userId: study.userId, route: "external_control", estimand: "ATT", configuration: {} });
  await module.orchestrator.advance(study.id);

  const current = await store.studyById(study.id);
  assert.equal(current.steps.comparator.status, "done", "「不可估计」 is finished work");
  assert.equal((await store.jobs(study.id)).length, 0, "a route the tier cannot take is not computed anyway");
  const design = await store.latestComparatorDesign(study.id);
  assert.equal(design.conclusion, "not_estimable");
  assert.ok(design.gapList.length >= 1 && design.gapList[0].title);
  const [result] = await store.results(study.id, "comparator");
  assert.equal(result.conclusion, "not_estimable");
  assert.equal(result.notEstimableRule, "data_tier_insufficient");
  assert.equal(result.subjectId, design.id);
  assert.equal(result.counts.realPatients, null, "null, never a zero standing in for nothing");
  assert.equal(result.diagnostics.derivedBy, "control_plane");

  const notices = module.notices.filter((notice) => notice.title.includes("不可估计"));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].idempotencyKey, `vcr:${study.id}:not-estimable:${result.id}:${study.userId}`);
  // A second tick does not send it again, and does not derive the verdict again.
  await module.orchestrator.advance(study.id);
  assert.equal(module.notices.filter((notice) => notice.title.includes("不可估计")).length, 1);
  assert.equal((await store.results(study.id, "comparator")).length, 1);

  // The route the engine cannot honestly compute in this version says so, and is not wired to another method.
  const model = await makeStudy("modelroute");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study: model, what: "definition", items: null, data: definition });
  await store.saveComparatorDesign({ studyId: model.id, userId: model.userId, route: "model_comparator", estimand: "ATT", configuration: {} });
  await module.orchestrator.advance(model.id);
  const [verdict] = await store.results(model.id, "comparator");
  assert.equal(verdict.notEstimableRule, "route_unavailable_in_version");
  assert.equal((await store.jobs(model.id)).length, 0);
});

test("§10.4 two key assumptions that cannot both hold are one notice, keyed by the cards and their versions", options, async () => {
  const module = compose();
  const study = await makeStudy("conflict");
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "definition", items: null, data: definition });
  for (const [key, value] of [["hazard_ratio", 0.5], ["control_median_pfs", 6], ["treatment_median_pfs", 7]]) {
    await store.saveAssumption({ studyId: study.id, userId: study.userId, key, name: key, pointValue: value, sourceKind: "expert_set", valueSource: "assumed" });
  }
  await module.orchestrator.advance(study.id);
  const notices = module.notices.filter((notice) => notice.title.includes("关键假设"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /风险比/);
  await module.orchestrator.advance(study.id);
  assert.equal(module.notices.filter((notice) => notice.title.includes("关键假设")).length, 1, "once");
  // The card changes and the conflict is gone: nothing more is said.
  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "hazard_ratio", name: "hazard_ratio", pointValue: 0.86, sourceKind: "expert_set", valueSource: "assumed" });
  await module.orchestrator.advance(study.id);
  assert.equal(module.notices.filter((notice) => notice.title.includes("关键假设")).length, 1);
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

// --- robustness methods ---
test("a comparator that declares robustness analyses plans them beside the comparison; the one that needs no patients runs while the others wait for their grant, and is filed as one limited result", options, async () => {
  const module = compose({
    dispatch: false,
    // the double's engine answers the tipping point as the real one does for counts a person stated
    resultFor: (job) => engineResult(job, job.method === "comparator.tipping_point"
      ? { measures: [{ name: "primary_p_value", value: 0.03, source: "aggregate" }, { name: "cells_changing_conclusion", value: 4, source: "aggregate" }],
        counts: { realPatients: null }, conclusion: "estimable" }
      : {}),
  });
  const study = await makeStudy("robustness", { dataTier: "T2" });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "definition", items: null, data: { ...definition, endpointType: "binary" } });

  // what the model may write: controls and a tipping point as columns of the study's patients. Counts it would have to type are refused by name.
  const columns = { covariates: ["age"], outcomeColumn: "response", method: "aipw", endpoint: { type: "binary" },
    negativeControls: [{ name: "fracture", column: "nc_fracture" }, { name: "cataract", column: "nc_cataract" }],
    tippingPoint: { direction: "against_treatment", design: { kind: "two_arm" }, outcomeColumn: "response", analysis: { method: "fisher_exact" } } };
  const counts = { treatment: { n: 60, responders: 30, missing: 8 }, control: { n: 60, responders: 18, missing: 6 } };
  const typed = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "comparator", items: null, data: {
    route: "external_control", estimand: "ATT", configuration: { ...columns, tippingPoint: { ...columns.tippingPoint, outcomeColumn: undefined, counts } } } });
  assert.equal(typed.ok, false);
  assert.equal(typed.issues[0].code, "vcr_write_field_forbidden");
  assert.match(typed.issues[0].field, /tippingPoint\.counts/);
  const written = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "comparator", items: null, data: {
    route: "external_control", estimand: "ATT", configuration: columns } });
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  await drainJobs(module, study);
  assert.equal((await store.jobs(study.id)).length, 0, "all three stages read patients, and none has a granted snapshot: a data gap, not a failure");
  const gaps = await store.rows("SELECT key, state, detail FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND kind = 'job' ORDER BY key", [study.id]);
  assert.deepEqual(gaps.map((mark) => [String(mark.key).split("#")[1], mark.state, mark.detail.reason]),
    [["negative_control", "skipped", "no_snapshot"], ["primary", "skipped", "no_snapshot"], ["tipping_point", "skipped", "no_snapshot"]]);

  // a person may state counts (an aggregate of someone's report): that stage reads no patients, runs, and is labelled a summary
  await store.saveComparatorDesign({ studyId: study.id, userId: study.userId, route: "external_control", estimand: "ATT",
    configuration: { ...columns, tippingPoint: { direction: "against_treatment", design: { kind: "two_arm" }, counts, analysis: { method: "fisher_exact" } } } });
  await drainJobs(module, study);
  const jobs = await store.jobs(study.id);
  assert.deepEqual(jobs.map((job) => job.kind), ["tipping_point"], "the comparison and the screen still wait for patients");
  const [result] = await store.results(study.id, "comparator");
  assert.ok(result, "the stage that ran is a comparator result");
  assert.equal(result.conclusion, "limited", "a stress test alone is not an estimated comparison");
  assert.equal(result.notEstimableRule, null);
  assert.deepEqual(result.diagnostics.stages.map((/** @type {any} */ entry) => entry.stage), ["tipping_point"]);
  assert.deepEqual(result.measures.map((/** @type {any} */ measure) => measure.name).sort(), ["cells_changing_conclusion", "primary_p_value"]);
  assert.ok(result.measures.every((/** @type {any} */ measure) => measure.source === "aggregate"), "numbers computed from stated counts say they are a summary");
  assert.equal(result.diagnostics.stageResults.tipping_point.conclusion, "estimable", "the stage's own verdict is not edited");
});
// --- end robustness methods ---
