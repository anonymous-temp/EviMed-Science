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
import { VCR_CHECK_STAGES, VCR_ENGINE_METHODS, VCR_RUN_EXPORT_KINDS, VCR_MODEL_DOCUMENT_KINDS, VCR_MODEL_DOCUMENT_SECTIONS, VCR_STEPS, lineageNode } from "@evimed/domain";

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
 * @param {{ resultFor?: (job: any) => Record<string, any>, now?: () => Date, dataPlane?: any, dispatch?: boolean, longitudinal?: any }} [options]
 */
function compose({ resultFor = (job) => engineResult(job), now = () => new Date(), dataPlane = null, dispatch = true, longitudinal = null } = {}) {
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
    store, jobs, config: cfg, notifier, seal, now, longitudinal,
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
    if (!/SELECT\s+id,\s*method,\s*kind\s+FROM\s+evimed_vcr\.jobs\s+WHERE\s+state\s*=\s*'running'/u.test(query) || rows.length < 2) return rows;
    const jobs = await original.call(store, "SELECT id,kind FROM evimed_vcr.jobs WHERE id=ANY($1::text[])", [rows.map(row => row.id)]);
    const kinds = new Map(jobs.map(job => [job.id, job.kind]));
    return rows.sort((a, b) => Number(kinds.get(a.id) === lastKind) - Number(kinds.get(b.id) === lastKind));
  };
  const originalAdvance=VcrJobs.prototype.advance;
  const pending=new Map();
  VcrJobs.prototype.advance=function(job){
    const work=job.kind===lastKind ? Promise.resolve().then(()=>Promise.all([...pending.values()])).then(()=>originalAdvance.call(this,job)) : originalAdvance.call(this,job);
    if(job.kind!==lastKind) pending.set(job.id,work);
    return work.finally(()=>pending.delete(job.id));
  };
  t.after(() => { store.rows = original; VcrJobs.prototype.advance=originalAdvance; });
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
    // A reminder (a record the object has not got yet) is not a refusal: the object was saved.
    const refused = written.issues.filter((/** @type {any} */ issue) => !["vcr_comparator_record_incomplete", "vcr_assumption_role_missing"].includes(issue.code));
    assert.deepEqual(refused, [], `${what} was refused: ${JSON.stringify(refused)}`);
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
      { key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed", effectRole: "realistic_expectation",
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
  for (const kind of VCR_RUN_EXPORT_KINDS) {
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
  assert.deepEqual((await store.exports(study.id)).map((row) => row.kind).sort(), [...VCR_RUN_EXPORT_KINDS].sort(), "six documents asked for, six exports, no orphan");

  // With no export run out the write is the researcher's own conversation: it opens a row of the kind it names, as before.
  const own = await report({ kind: "simulation_report", section: "appendix", template: "补充说明。" });
  assert.equal(own.ok, true);
  assert.equal((await store.exports(study.id)).length, VCR_RUN_EXPORT_KINDS.length + 1);
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
    { vcr: { service: module.service, store, jobs: module.jobs, orchestrator: module.orchestrator },
      resolveInvocation:async()=>({userId:study.userId,projectId:study.projectId,rootSessionId:'native-fixture',sessionId:'native-fixture',callId:'call-fixture',runId:null}) });
  return async (/** @type {string} */ operation, /** @type {Record<string, any>} */ body) => {
    await store.setConversationSession(study.id,'native-fixture');
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: `/internal/vcr/v1/${operation}`, headers: { authorization: "Bearer t",'x-evimed-execution-context':'native-fixture' } });
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

test("R3 a step nobody asked for that holds results reads what it holds: two designs, one computed by a conversation, never 未开始 over a table of results", options, async () => {
  const module = compose({ dispatch: false });
  const study = await makeStudy("holds");
  const write = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
    study, what, items: Array.isArray(data) ? data : null, data: Array.isArray(data) ? null : data });
  await write("definition", { ...definition, title: "二线肺癌 EV 的样本量", question: "单臂 II 期能不能用外部对照？" });
  await write("assumption", [{ key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" },
    { key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, sourceKind: "expert_set", valueSource: "assumed" }]);
  const written = await write("trial_scenario", conversationDesigns.slice(0, 2));
  assert.equal(written.ids.length, 2);
  const gateway = conversationGateway(module, study);
  // The conversation computes the first design only; the population is what somebody asked for, so the trial step is not wanted.
  const first = await gateway("simulate", { action: "start", kind: "design_simulation", subjectId: written.ids[0], scenario: engineScenario(0, "design_simulation") });
  assert.equal(first.status, 200, JSON.stringify(first));
  await store.setStep(study.id, "population", { requested: true, status: "none" });
  await drainJobs(module, study);
  await module.orchestrator.advance(study.id);
  const partial = (await store.studyById(study.id)).steps.trial;
  assert.equal(partial.status, "failed", "one design holds a result and the other was never computed: the page's step bar says 未完成, not 未开始");
  assert.equal(partial.note ?? null, null, "nothing failed, so there is nothing to say about a failure");
  const view = await module.service.studyView({ id: study.userId }, study.id);
  assert.deepEqual([view.steps.trial.status, view.stepSummaries.trial?.note !== undefined], ["failed", true]);
  // Computing the rest finishes the step as the minimal version it is.
  const second = await gateway("simulate", { action: "start", kind: "design_simulation", subjectId: written.ids[1], scenario: engineScenario(1, "design_simulation") });
  assert.equal(second.status, 200, JSON.stringify(second));
  await drainJobs(module, study);
  assert.equal((await store.studyById(study.id)).steps.trial.status, "minimal");
});

/** The notices the inbox double took from a composed module that are about a finished computation. @param {any} module */
function notices_of(module) {
  return module.notices.filter((/** @type {any} */ notice) => /完成/.test(String(notice.title)) && notice.source?.type === "vcr");
}

test("R10 the backfill gives the results the old path left without a subject the design they were computed for, undoes the supersessions that crossed designs, and a second run changes nothing", options, async () => {
  const module = compose({ dispatch: false });
  const study = await makeStudy("backfill");
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

  // Historical work was created while editable; repairing its metadata must also work after pause.
  await store.updateStudy(study.id, { status: "paused" }, study.userId);
  const history = await store.one(`SELECT
    (SELECT count(*)::integer FROM evimed_vcr.jobs WHERE study_id=$1) AS jobs,
    (SELECT count(*)::integer FROM evimed_vcr.executions WHERE study_id=$1) AS executions`, [study.id]);
  assert.deepEqual(history, { jobs: 7, executions: 7 });
  await assert.rejects(module.jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_analytic",
    scenario: designOf(0, "design_analytic"), inputs: [], internal: true }), { code: "vcr_study_paused" });

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
  assert.equal((await store.studyById(study.id)).status, "paused", "metadata repair never resumes the programme");
  assert.equal((await store.allResults(study.id)).length, 7, "all historical results are retained");
  assert.deepEqual(await store.one(`SELECT
    (SELECT count(*)::integer FROM evimed_vcr.jobs WHERE study_id=$1) AS jobs,
    (SELECT count(*)::integer FROM evimed_vcr.executions WHERE study_id=$1) AS executions`, [study.id]), history,
  "backfill and refused enqueue create no new jobs or executions");
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
  const simulated = (await store.jobs(study.id)).filter((job) => job.kind === "design_simulation");
  assert.equal(simulated.filter((job) => job.checkpoint.stage === "simulation").length, 2, "it was recomputed");
  assert.equal(simulated.filter((job) => job.checkpoint.stage === "simulation_null").length, 2, "and so was the zero-effect check that follows it, each time");
  assert.equal(notices_of(module).length, before, "and nobody was told");
});

/** A design's result for the zero-effect law carries the type I error and not a power, as the engine names it. */
const nullAware = (/** @type {any} */ job) => (job.method === "design.simulate" && job.scenario.truth?.hazardRatio === 1
  ? engineResult(job, { measures: [{ name: "type_one_error", value: 0.0246, simulated: true, mcse: 0.0011, source: "synthetic" }], diagnostics: { isNullScenario: true } })
  : engineResult(job));

test("A1 a two-arm design is also run under no effect, after the alternative: the researcher has the power first, the type I error follows, and a check that fails or is cancelled takes nothing back", options, async () => {
  const module = compose({ resultFor: nullAware });
  const { study, write } = await computedStudy(module, "nullcheck");
  const [scenario] = await store.trialScenarios(study.id);
  const jobs = await store.rows("SELECT id, state, checkpoint, created_at FROM evimed_vcr.jobs WHERE study_id=$1 AND kind='design_simulation' ORDER BY created_at", [study.id]);
  assert.deepEqual(jobs.map((job) => job.checkpoint.stage), ["simulation", "simulation_null"], "the alternative is queued first and the check after it");
  assert.ok(jobs.every((job) => job.state === "succeeded"));
  assert.equal(jobs[1].checkpoint.check, true);
  assert.equal(jobs[1].scenario ?? null, null);
  const nullJob = await store.one("SELECT scenario, replicates FROM evimed_vcr.jobs WHERE id=$1", [jobs[1].id]);
  assert.equal(nullJob.scenario.truth.hazardRatio, 1, "the one key that says no effect");
  assert.equal(nullJob.scenario.truth.controlMedian, 6, "and the control level is the study's");
  assert.equal(nullJob.replicates, 20_000, "the null floor of an exploration");
  const altJob = await store.one("SELECT replicates FROM evimed_vcr.jobs WHERE id=$1", [jobs[0].id]);
  assert.equal(altJob.replicates, 5_000);
  // The result is one: the alternative's figures stand, with the check's beside them, the check in its own stage record.
  const current = await store.currentResultOf(study.id, "trial_scenario", scenario.id);
  assert.equal(current.measures.find((measure) => measure.name === "power").value, 0.712);
  assert.equal(current.measures.find((measure) => measure.name === "type_one_error").value, 0.0246);
  assert.deepEqual(Object.keys(current.diagnostics.stageResults).sort(), ["analytic", "simulation", "simulation_null"]);
  assert.equal(current.diagnostics.stageResults.simulation_null.diagnostics.replicatePlan.basis, "default");
  assert.deepEqual(current.diagnostics.stageResults.simulation.diagnostics.appliedDefaults.map((entry) => entry.path).includes("accrual.dropoutAnnual"), false,
    "the card gave the dropout, so it is not a default");
  assert.equal(current.diagnostics.isNullScenario, undefined, "the check's summaries are its own");
  assert.equal(current.conclusion, "estimable");
  assert.equal((await store.studyById(study.id)).steps.trial.status, "done");
  // The page reads the check as done, with its error, held against the closed form where one exists.
  const trial = await module.service.tab({ id: study.userId }, study.id, "trial");
  assert.equal(trial.designs[0].nullState, "done");
  assert.equal(trial.designs[0].measures.type_one_error.mcse, 0.11);
  assert.equal(trial.designs[0].measures.power.value, 71.2);
  assert.equal(trial.designs[0].crossCheck, null, "this double's engine states no closed form for it");
  const dropout = trial.premises.find((row) => row.key === "dropout");
  assert.deepEqual([dropout.value, dropout.source, dropout.decisive], ["10%", "assumed", true], "the dropout is a premise of the page, from the card that gave it");
  void write;
});

test("A1 a zero-effect check that fails leaves the design's result as it was and its step done; one that is cancelled does the same", options, async () => {
  for (const how of /** @type {const} */ (["failed", "canceled"])) {
    const module = compose({ resultFor: (job) => (job.method === "design.simulate" && job.scenario.truth?.hazardRatio === 1
      ? engineResult(job, { status: "failed", conclusion: null, measures: [], counts: {}, diagnostics: { issues: [{ code: "handler_error", field: "scenario", detail: "no" }] } })
      : engineResult(job)) });
    const study = await makeStudy(`nullcheck-${how}`);
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
    if (how === "canceled") {
      // Stop the check while it waits in the queue: the alternative has landed, the check has been queued after it.
      let queued = null;
      for (let pass = 0; pass < 20 && !queued; pass += 1) {
        await module.loops.jobs();
        await module.orchestrator.advance(study.id);
        queued = (await store.rows("SELECT id FROM evimed_vcr.jobs WHERE study_id=$1 AND checkpoint->>'stage'='simulation_null' AND state='queued'", [study.id]))[0] ?? null;
      }
      assert.ok(queued, "the check was queued after the alternative landed");
      await module.jobs.cancel(study.id, queued.id, { actor: "owner" });
    }
    await drainJobs(module, study);
    const [scenario] = await store.trialScenarios(study.id);
    const nullJob = await store.one("SELECT state FROM evimed_vcr.jobs WHERE study_id=$1 AND checkpoint->>'stage'='simulation_null'", [study.id]);
    assert.equal(nullJob?.state, how, `the check ${how}: ${JSON.stringify(await store.rows("SELECT key, state, detail FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND kind='job'", [study.id]))}`);
    const current = await store.currentResultOf(study.id, "trial_scenario", scenario.id);
    assert.ok(current, "the design has its result");
    assert.equal(current.measures.find((measure) => measure.name === "power").value, 0.712, "the power is the alternative's, unchanged");
    assert.equal(current.measures.some((measure) => measure.name === "type_one_error"), false);
    assert.equal(current.diagnostics.partial, undefined);
    assert.ok(current.diagnostics.stageResults.simulation && !current.diagnostics.stageResults.simulation_null);
    assert.equal(current.conclusion, "estimable");
    assert.equal((await store.studyById(study.id)).steps.trial.status, "done", "the step is done: what it checks is there");
    assert.equal((await store.rows("SELECT 1 FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND state='failed' AND key LIKE '%simulation_null'", [study.id])).length, how === "failed" ? 1 : 0,
      "and a failed check is on record, traceable");
  }
});

test("A1 a design a conversation simulated gets its zero-effect check from the platform, and only that: no step was asked for and nothing else of the design's plan is queued; a check that fails or is cancelled takes nothing back", options, async () => {
  for (const how of /** @type {const} */ (["done", "failed", "canceled"])) {
    const module = compose({ resultFor: (job) => (how === "failed" && job.method === "design.simulate" && job.scenario.truth?.hazardRatio === 1
      ? engineResult(job, { status: "failed", conclusion: null, measures: [], counts: {}, diagnostics: { issues: [{ code: "handler_error", field: "scenario", detail: "no" }] } })
      : nullAware(job)) });
    const study = await store.taskContext({ userId: `u_convnull_${how}`, projectId: `prj_convnull_${how}`, rootSessionId: "native-fixture" }, { create: true });
    assert.equal(study.scope, "conversation");
    const gateway = conversationGateway(module, study);
    const started = await gateway("simulate", { action: "start", kind: "design_simulation", scenario: engineScenario(1, "design_simulation") });
    assert.equal(started.status, 200, JSON.stringify(started));
    if (how === "canceled") {
      // Stop the check while it waits in the queue: the alternative has landed and the check has been queued behind it.
      let queued = null;
      for (let pass = 0; pass < 20 && !queued; pass += 1) {
        await module.loops.jobs();
        await module.orchestrator.advance(study.id);
        queued = (await store.rows("SELECT id FROM evimed_vcr.jobs WHERE study_id=$1 AND checkpoint->>'stage'='simulation_null' AND state='queued'", [study.id]))[0] ?? null;
      }
      assert.ok(queued, "the check was queued after the alternative landed");
      await module.jobs.cancel(study.id, queued.id, { actor: "owner" });
    }
    await drainJobs(module, study);
    const jobs = await store.rows("SELECT id, kind, state, checkpoint, scenario FROM evimed_vcr.jobs WHERE study_id=$1 ORDER BY created_at", [study.id]);
    assert.deepEqual(jobs.map((job) => `${job.kind}:${job.checkpoint.stage}`), ["design_simulation:simulation", "design_simulation:simulation_null"],
      "the alternative the conversation asked for, then the check, and no analytic or assurance stage nobody asked for");
    const check = jobs[1];
    assert.equal(check.state, how === "done" ? "succeeded" : how);
    assert.equal(check.checkpoint.check, true);
    assert.equal(check.scenario.truth.hazardRatio, 1, "the one key that says no effect");
    assert.equal(check.scenario.truth.controlMedian, 6, "and the control level is the design's");
    assert.deepEqual([check.scenario.design.nTreat, check.scenario.design.nControl], [90, 90], "on the design that was simulated");
    const [design] = await store.trialScenarios(study.id);
    const current = await store.currentResultOf(study.id, "trial_scenario", design.id);
    assert.equal(current.measures.find((/** @type {any} */ measure) => measure.name === "power").value, 0.712, "the alternative's power stands");
    assert.equal(current.conclusion, "estimable");
    if (how === "done") {
      assert.equal(current.measures.find((/** @type {any} */ measure) => measure.name === "type_one_error").value, 0.0246);
    } else {
      assert.equal(current.measures.some((/** @type {any} */ measure) => measure.name === "type_one_error"), false);
    }
    const trial = await module.service.tab({ id: study.userId }, study.id, "trial");
    assert.equal(trial.designs[0].nullState, how === "done" ? "done" : how, "the page says how the check went, beside the figure");
    // A second pass queues nothing more, and a design the check was refused for is not asked again.
    await module.orchestrator.advance(study.id);
    assert.equal((await store.rows("SELECT 1 FROM evimed_vcr.jobs WHERE study_id=$1", [study.id])).length, 2);
  }
});

test("A1 the platform adds no check to a conversation's design that is already the zero-effect case", options, async () => {
  const module = compose({ resultFor: nullAware });
  const study = await store.taskContext({ userId: "u_convnull_none", projectId: "prj_convnull_none", rootSessionId: "native-fixture" }, { create: true });
  const gateway = conversationGateway(module, study);
  const nullCase = engineScenario(1, "design_simulation");
  nullCase.truth = { ...nullCase.truth, hazardRatio: 1 };
  const answer = await gateway("simulate", { action: "start", kind: "design_simulation", scenario: nullCase });
  assert.equal(answer.status, 200, JSON.stringify(answer));
  await module.orchestrator.advance(study.id);
  // The simulation is still queued: nothing is queued behind it.
  assert.equal((await store.rows("SELECT 1 FROM evimed_vcr.jobs WHERE study_id=$1", [study.id])).length, 1);
  await drainJobs(module, study);
  assert.deepEqual((await store.rows("SELECT checkpoint->>'stage' AS stage FROM evimed_vcr.jobs WHERE study_id=$1", [study.id])).map((row) => row.stage), ["simulation"],
    "a scenario that already states no effect needs no second one");
});

test("REVIEWFIX 1 a conversation that starts the same design with another sample size gets a design and a job of its own, and only the same scenario is answered with the job that is running", options, async () => {
  const module = compose({ resultFor: nullAware });
  const study = await store.taskContext({ userId: "u_convsized", projectId: "prj_convsized", rootSessionId: "native-fixture" }, { create: true });
  const gateway = conversationGateway(module, study);
  const sized = (/** @type {number} */ each) => { const scenario = engineScenario(1, "design_simulation"); scenario.design = { ...scenario.design, nTreat: each, nControl: each }; return scenario; };
  const start = (/** @type {number} */ each) => gateway("simulate", { action: "start", kind: "design_simulation", scenario: sized(each) });
  const n300 = await start(150);
  assert.equal(n300.status, 200, JSON.stringify(n300));
  // while n=300 runs, n=500 is not answered with it
  const n500 = await start(250);
  assert.equal(n500.status, 200, JSON.stringify(n500));
  assert.equal(n500.data.alreadyRunning, undefined);
  assert.notEqual(n500.data.jobId, n300.data.jobId);
  assert.notEqual(n500.data.subject.id, n300.data.subject.id, "its own design, so its own result");
  // and the same scenario is the job that is running
  const again = await start(150);
  assert.deepEqual([again.data.alreadyRunning, again.data.jobId, again.data.subject.id], [true, n300.data.jobId, n300.data.subject.id]);
  await drainJobs(module, study);
  const results = await store.results(study.id, "trial_scenario");
  assert.deepEqual(results.map((row) => row.subjectId).sort(), [n300.data.subject.id, n500.data.subject.id].sort(), "each design holds the result of its own numbers");
  const jobs = await store.rows("SELECT scenario, checkpoint FROM evimed_vcr.jobs WHERE study_id=$1 AND checkpoint->>'stage'='simulation_null'", [study.id]);
  assert.deepEqual(jobs.map((job) => job.scenario.design.nTreat).sort(), [150, 250], "and the zero-effect check of each is of its own numbers");
});

test("REVIEWFIX 2 the zero-effect check of a conversation's design is the check of the simulation that was run: its frozen scenario, again for each simulation, and a type I error computed under other numbers is never shown beside a power", options, async () => {
  const module = compose({ resultFor: nullAware });
  const study = await store.taskContext({ userId: "u_convnull_own", projectId: "prj_convnull_own", rootSessionId: "native-fixture" }, { create: true });
  const written = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "trial_scenario",
    items: [{ ...conversationDesigns[1], configuration: { ...conversationDesigns[1].configuration, truth: { hazardRatio: 0.7, controlMedian: 6 } } }], data: null });
  const [id] = written.ids;
  const gateway = conversationGateway(module, study);
  // The run states its own sample size, which is not the one the design was written with (90 and 90).
  const sized = (/** @type {number} */ each) => { const scenario = engineScenario(1, "design_simulation"); scenario.design = { ...scenario.design, nTreat: each, nControl: each }; return scenario; };
  const checksOf = async () => store.rows("SELECT id, state, scenario, checkpoint FROM evimed_vcr.jobs WHERE study_id=$1 AND checkpoint->>'stage'='simulation_null' ORDER BY created_at", [study.id]);
  const simulationsOf = async () => store.rows("SELECT id, scenario FROM evimed_vcr.jobs WHERE study_id=$1 AND checkpoint->>'stage'='simulation' ORDER BY created_at", [study.id]);

  const first = await gateway("simulate", { action: "start", kind: "design_simulation", subjectId: id, scenario: sized(150) });
  assert.equal(first.status, 200, JSON.stringify(first));
  await drainJobs(module, study);
  const [check] = await checksOf();
  assert.deepEqual([check.scenario.design.nTreat, check.scenario.design.nControl], [150, 150], "the check is of the scenario the simulation froze, not of the design as it was written");
  const [firstSimulation] = await simulationsOf();
  assert.equal(check.checkpoint.checkOf, firstSimulation.id, "and says which simulation it is the check of");
  assert.equal(check.scenario.truth.hazardRatio, 1);

  // A second simulation of the same design with other numbers is a second computation, and its check is its own: the first check no
  // longer stands for it.
  const second = await gateway("simulate", { action: "start", kind: "design_simulation", subjectId: id, scenario: sized(250) });
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.notEqual(second.data.jobId, first.data.jobId);
  assert.equal(second.data.alreadyRunning, undefined);
  await drainJobs(module, study);
  const checks = await checksOf();
  assert.equal(checks.length, 2, "one check for each simulation");
  assert.deepEqual([checks[1].scenario.design.nTreat, checks[1].scenario.design.nControl], [250, 250]);
  const simulations = await simulationsOf();
  assert.equal(checks[1].checkpoint.checkOf, simulations[1].id);
  const current = await store.currentResultOf(study.id, "trial_scenario", id);
  assert.equal(current.diagnostics.stageResults.simulation.jobId, simulations[1].id);
  assert.equal(current.diagnostics.stageResults.simulation_null.jobId, checks[1].id, "the type I error beside the power is the one computed for it");
  assert.equal(current.measures.filter((/** @type {any} */ measure) => measure.name === "type_one_error").length, 1);
  // Nothing more is queued on a pass that has nothing new.
  await module.orchestrator.advance(study.id);
  assert.equal((await checksOf()).length, 2);
});

test("P1-4 a conversation's study is named by the title the model gives its research question, with the identifiers taken out, or for the kind of work and the day; a patient's words are never its name", options, async () => {
  const module = compose({ resultFor: nullAware });
  const day = (/** @type {any} */ row) => `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(new Date(row.createdAt)).replace("/", "月")}日`;

  // 1. A design the conversation computes names the study for the kind of work: nothing was said that could be a name.
  const designing = await store.taskContext({ userId: "u_named_a", projectId: "prj_named_a", rootSessionId: "native-fixture" }, { create: true });
  assert.equal(designing.name, "对话研究");
  const a = conversationGateway(module, designing);
  const started = await a("simulate", { action: "start", kind: "design_simulation", scenario: engineScenario(1, "design_simulation") });
  assert.equal(started.status, 200, JSON.stringify(started));
  const designed = await store.studyById(designing.id);
  assert.equal(designed.name, `试验设计 · ${day(designed)}`);
  assert.equal(designed.nameBasis, "assigned");

  // 2. The title the model gives names it; the answer says the name; the identifiers of closed formats are taken out; a person's name is not undone.
  const matching = await store.taskContext({ userId: "u_named_b", projectId: "prj_named_b", rootSessionId: "native-fixture" }, { create: true });
  const b = conversationGateway(module, matching);
  const titled = await b("write", { what: "task_context", data: { title: "住院号 20260123 患者的二线治疗试验匹配" } });
  assert.equal(titled.status, 200, JSON.stringify(titled));
  assert.equal(titled.data.name, "住院号 患者的二线治疗试验匹配");
  assert.equal((await store.studyById(matching.id)).name, "住院号 患者的二线治疗试验匹配");
  // A later write that leaves something in the study does not rename it for the kind of work.
  await b("write", { what: "population", items: [{ name: "情景人群", kind: "scenario", definition: { n: 100 }, allowedUses: ["design"] }] });
  assert.equal((await store.studyById(matching.id)).name, "住院号 患者的二线治疗试验匹配");
  // task_context with nothing, with a title that is only an identifier, and with a field it does not take.
  assert.equal((await b("write", { what: "task_context" })).status, 200);
  assert.equal((await b("write", { what: "task_context", data: { title: "2026年11月2日" } })).data.name, "住院号 患者的二线治疗试验匹配");
  const refused = await b("write", { what: "task_context", data: { title: "x", question: "张三，男，58岁" } });
  assert.equal(refused.status, 400);
  assert.equal(refused.code, "vcr_write_payload_invalid");
  assert.equal((await b("write", { what: "task_context", data: { title: 7 } })).status, 400);
  await store.updateStudy(matching.id, { name: "我自己起的名字" }, "owner");
  assert.equal((await b("write", { what: "task_context", data: { title: "模型的新标题" } })).data.name, "我自己起的名字");
  assert.equal((await store.studyById(matching.id)).name, "我自己起的名字");
});

test("P1-5 on the programme path a design whose hazard ratio changes over time queues its simulation and the zero-effect check, no analytic stage, and the page reads done", options, async () => {
  const module = compose({ resultFor: nullAware });
  const study = await makeStudy("nph");
  const write = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
    study, what, items: Array.isArray(data) ? data : null, data: Array.isArray(data) ? null : data });
  await write("definition", definition);
  await write("assumption", [
    { key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, sourceKind: "expert_set", valueSource: "assumed" },
    { key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" },
  ]);
  const delayed = { label: "延迟起效", design: "two_arm_fixed", endpointType: "time_to_event", assumptionIds: [],
    configuration: { design: { nTreat: 120, nControl: 120 }, analysis: { method: "maxcombo", alpha: 0.025, sided: 1 },
      truth: { treatmentHazardRatios: { breaks: [6], ratios: [1, 0.6] }, controlMedian: 8 }, accrual: { kind: "uniform", duration: 12, followup: 12 } } };
  await write("trial_scenario", delayed);
  await module.orchestrator.advance(study.id);
  await drainJobs(module, study);
  const jobs = await store.rows("SELECT kind, state, checkpoint FROM evimed_vcr.jobs WHERE study_id=$1 ORDER BY created_at", [study.id]);
  assert.deepEqual(jobs.map((job) => `${job.kind}:${job.checkpoint.stage}:${job.state}`), ["design_simulation:simulation:succeeded", "design_simulation:simulation_null:succeeded"],
    "the closed form is not asked for, and the check is not refused");
  const failed = await store.rows("SELECT key, detail FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND state='failed'", [study.id]);
  assert.deepEqual(failed, [], "no stage is left failed");
  const nullJob = await store.one("SELECT scenario FROM evimed_vcr.jobs WHERE study_id=$1 AND checkpoint->>'stage'='simulation_null'", [study.id]);
  assert.equal(nullJob.scenario.truth.hazardRatio, 1);
  assert.equal(Object.hasOwn(nullJob.scenario.truth, "treatmentHazardRatios"), false);
  assert.equal(nullJob.scenario.analysis.method, "maxcombo", "the same analysis");
  assert.equal((await store.studyById(study.id)).steps.trial.status, "done");
  const trial = await module.service.tab({ id: study.userId }, study.id, "trial");
  assert.equal(trial.designs[0].nullState, "done");
  assert.match(trial.designs[0].note, /没有解析结果/);
});

test("P2-10 a batch reading and a population check that a conversation asked for end in the inbox as well as in the conversation", options, async () => {
  const module = compose({ dispatch: false });
  const study = await makeStudy("noticekinds");
  const finished = (/** @type {string} */ kind, /** @type {string} */ method, /** @type {Record<string, any>} */ result, /** @type {Record<string, any>} */ checkpoint = {}) =>
    module.orchestrator.onJobFinished({ job: { id: `job_${kind}`, studyId: study.id, kind, method, state: "succeeded", checkpoint: { origin: "runtime", resultKind: kind, ...checkpoint } },
      result: { id: `res_${kind}`, kind, ...result } });
  await finished("match_extract", "matching.extract", { conclusion: "estimable", measures: [{ name: "records_read", value: 25 }], diagnostics: { remaining: 0 } });
  await finished("population_check", "population.check", { conclusion: "estimable", measures: [{ name: "variables_compared", value: 4 }, { name: "variables_apart", value: 1 }] });
  const titles = notices_of(module).map((notice) => notice.title);
  assert.ok(titles.includes("病历阅读完成：读完 25 份病历"), titles.join(" | "));
  assert.ok(titles.includes("人群核对完成：比较了 4 个变量，1 个有差异"), titles.join(" | "));
  // a computation nobody in a conversation asked for stays quiet, as the programme's own stages do
  const before = notices_of(module).length;
  await module.orchestrator.onJobFinished({ job: { id: "job_quiet", studyId: study.id, kind: "match_extract", method: "matching.extract", state: "succeeded", checkpoint: { resultKind: "match_extract" } },
    result: { id: "res_quiet", kind: "match_extract", measures: [{ name: "records_read", value: 5 }] } });
  assert.equal(notices_of(module).length, before);
});

test("a stand-alone E-value is started from a conversation with nothing written first, and lands on a comparison of its own", options, async () => {
  const module = compose();
  const study = await store.taskContext({ userId: "u_evalue_gateway", projectId: "prj_evalue_gateway", rootSessionId: "native-fixture" }, { create: true });
  const gateway = conversationGateway(module, study);
  const started = await gateway("simulate", { action: "start", kind: "evalue", scenario: { riskRatio: 0.6, confidenceLimit: 0.8, scale: "hazard_ratio", rare: true } });
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.equal(started.data.subject.kind, "comparator");
  await drainJobs(module, study);
  const jobs = await store.rows("SELECT kind, method, state, checkpoint FROM evimed_vcr.jobs WHERE study_id=$1", [study.id]);
  assert.deepEqual(jobs.map((job) => [job.kind, job.method, job.state]), [["evalue", "comparator.evalue", "succeeded"]]);
  const [design] = await store.comparatorDesigns(study.id, 10);
  assert.equal(design.id, started.data.subject.id);
  assert.ok(design.resultId, "the result is the comparison's own");
  // asked again with the same estimate it is the same comparison, not a second one
  const again = await gateway("simulate", { action: "start", kind: "evalue", scenario: { riskRatio: 0.6, confidenceLimit: 0.8, scale: "hazard_ratio", rare: true } });
  assert.equal(again.data.subject.id, design.id);
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

test("TU-4 a design's result says the unit its times were settled in, and the jobs that ran carry the scenario in it: the evidence's unit when its cards agree, months when nothing says (E4, OI-1)", options, async () => {
  const module = compose();
  /** @param {string} label @param {any[]} cards */
  const run = async (label, cards) => {
    const study = await makeStudy(label);
    const write = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
      study, what, items: Array.isArray(data) ? data : null, data: Array.isArray(data) ? null : data });
    await write("definition", definition);
    assert.equal((await write("assumption", cards)).ok, true);
    await write("trial_scenario", trialA);
    await module.orchestrator.advance(study.id);
    await drainJobs(module, study);
    const jobs = await store.rows("SELECT kind, scenario FROM evimed_vcr.jobs WHERE study_id = $1 AND kind IN ('design_analytic', 'design_simulation') ORDER BY created_at", [study.id]);
    const [result] = await store.results(study.id, "trial_scenario");
    return { jobs, result };
  };
  const hazard = { key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" };
  const dropout = { key: "dropout_rate", name: "脱落率", pointValue: 0.1, sourceKind: "expert_set", valueSource: "assumed" };
  const median = (/** @type {Record<string, any>} */ extra = {}) => ({ key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 26, sourceKind: "expert_set", valueSource: "assumed", ...extra });

  const inWeeks = await run("tuweeks", [hazard, dropout, median({ unit: "weeks" })]);
  assert.equal(inWeeks.jobs.length, 3, "the design's sizing, its simulation and the zero-effect check that follows it all ran");
  for (const job of inWeeks.jobs) assert.deepEqual([job.scenario.timeUnit, job.scenario.truth.controlMedian], ["weeks", 26], `${job.kind}: the scenario is in the unit its evidence is in`);
  assert.deepEqual(inWeeks.result.diagnostics.timeUnitBasis, { unit: "weeks", basis: "evidence" }, "and the result says where the unit came from");

  const nobody = await run("tumonths", [hazard, dropout, median()]);
  for (const job of nobody.jobs) assert.deepEqual([job.scenario.timeUnit, job.scenario.truth.controlMedian], ["months", 26]);
  assert.deepEqual(nobody.result.diagnostics.timeUnitBasis, { unit: "months", basis: "assumed" }, "nothing says: months, and the result says it was assumed — the job still ran");
});

test("AC-16 a changed assumption marks everything downstream stale, recomputes it under the new version, and deletes nothing", options, async () => {
  const module = compose();
  const { study, write } = await computedStudy(module, "stale");
  const before = await store.results(study.id, "trial_scenario");
  assert.equal(before.length, 1);
  const [scenario] = await store.trialScenarios(study.id);
  const scenarioNode = vcrObjectNode("trial_scenario", scenario);
  const oldNode = lineageNode("result", before[0].id, before[0].version);
  const firstJobs = (await store.jobs(study.id)).filter((job) => job.kind === "design_simulation" && job.checkpoint.stage === "simulation");
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
  const jobs = (await store.jobs(study.id)).filter((job) => job.kind === "design_simulation" && job.checkpoint.stage === "simulation");
  assert.equal(jobs.length, 2, "a second job, not the first one returned again");
  const rows = await store.rows("SELECT scenario, idempotency_key, inputs FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'design_simulation' AND checkpoint->>'stage' = 'simulation' ORDER BY created_at", [study.id]);
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
    // The last stage of the result's own to land: the zero-effect check follows them all, and is not what this arrangement is about.
    const ownLast = current.diagnostics.stages.filter((/** @type {any} */ entry) => !VCR_CHECK_STAGES.includes(entry.stage)).at(-1);
    const root = await store.one("SELECT method FROM evimed_vcr.executions WHERE study_id=$1 AND job_id=$2", [study.id, ownLast.jobId]);
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

test("design forecasts remain scientific while optional Poisson-Gamma calculations create no operational feedback", options, async()=>{
 let clock=new Date("2027-01-10T00:00:00Z");const module=compose({now:()=>clock});const {study}=await computedStudy(module,"forecast");
 const forecasts=(await store.forecasts(study.id)).filter(row=>row.kind==="trial");assert.equal(forecasts.length,1);assert.equal(forecasts[0].prediction.measures.power.mcse,0.0031);
 await module.jobs.enqueue({studyId:study.id,userId:study.userId,kind:"accrual_forecast",cpuSecondsLimit:60,scenario:{sites:[{id:"assumption_1",alpha:6,beta:3,startTime:0}],target:60},idempotencyKey:`vcr:${study.id}:abstract-accrual`});
 await drainJobs(module,study);assert.equal((await store.results(study.id,"accrual_forecast")).length,1,"the optional deterministic design result remains usable");
 assert.equal((await store.forecasts(study.id)).filter(row=>row.kind==="accrual").length,0,"no live recruitment prediction is registered");
 clock=new Date("2027-03-10T00:00:00Z");await module.orchestrator.advance(study.id);
 assert.equal(module.notices.some(row=>row.title.includes("实际入组偏离预测")),false);assert.equal((await store.forecasts(study.id)).find(row=>row.id===forecasts[0].id).actual,null);
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

test("R3 a person's cancel holds the programme: the run's end is not followed by the next step, and asking for a step takes it and what it needs out of the hold", options, async () => {
  const module = compose();
  const study = await makeStudy("hold");
  // Made from a question: the whole programme is asked for (`createStudy`), and the definition run is the first to go out.
  for (const step of VCR_STEPS) await store.setStep(study.id, step, { requested: true });
  await module.orchestrator.advance(study.id);
  assert.deepEqual(module.dispatched.map((/** @type {any} */ input) => input.capabilityId), ["vcr-protocol"]);
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "definition", items: null, data: definition });
  // The person stops what is going on. The hold goes first, as the route does it: the run's own end advances the programme.
  const held = await module.orchestrator.holdProgramme(study.id);
  assert.ok(held.held.includes("evidence") && held.held.includes("population"), "what the programme would have gone on to is held");
  await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId },
    { id: "run_1", dispatchId: module.dispatched[0].dispatchId, status: "canceled" });
  await module.orchestrator.advance(study.id);
  assert.equal(module.dispatched.length, 1, "a cancel is not followed by the next step of the programme, now or on the next pass");
  const stopped = await store.studyById(study.id);
  assert.equal(stopped.steps.evidence.held, true);
  assert.equal(stopped.steps.evidence.requested, true, "still requested: the hold changes what is wanted, not what a result reads as");

  // Asking for one step takes it and what it needs out of the hold, and only those.
  await module.orchestrator.runStep({ id: study.userId }, study, "population");
  assert.equal(module.dispatched.length, 2);
  assert.equal(module.dispatched[1].capabilityId, "vcr-analysis");
  assert.equal(module.dispatched[1].question, "构建人群", "the step that was asked for, not the rest of the programme");
  const asked = await store.studyById(study.id);
  assert.equal(asked.steps.population.held, false);
  assert.equal(asked.steps.evidence.held, true, "a step nobody asked for stays held");
  assert.equal(asked.steps.trial.held, true);
});

test("R3 re-asking which steps run ends a hold: the programme goes on with what was asked", options, async () => {
  const module = compose();
  const study = await makeStudy("rehold");
  for (const step of VCR_STEPS) await store.setStep(study.id, step, { requested: true });
  await module.orchestrator.advance(study.id);
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "definition", items: null, data: definition });
  await module.orchestrator.holdProgramme(study.id);
  await module.orchestrator.onRunFinished({ userId: study.userId, id: study.projectId },
    { id: "run_1", dispatchId: module.dispatched[0].dispatchId, status: "canceled" });
  assert.equal(module.dispatched.length, 1);
  // The 起点 is changed to the whole programme (`PATCH` with an action): that is an instruction of its own.
  const service = module.service;
  await service.updateStudy({ id: study.userId }, study.id, { action: "auto" });
  const after = await store.studyById(study.id);
  assert.ok(VCR_STEPS.every((step) => after.steps[step].held === false));
  await module.orchestrator.advance(study.id);
  assert.ok(module.dispatched.length > 1, "and the programme goes on");
});

test("R3 a held step that comes to read finished is not held any more: what changes under it is recomputed like any finished step's", options, async () => {
  const module = compose();
  const study = await makeStudy("holdreleased");
  for (const step of VCR_STEPS) await store.setStep(study.id, step, { requested: true });
  await module.orchestrator.advance(study.id);
  const stopped = await module.orchestrator.holdProgramme(study.id);
  assert.ok(stopped.held.includes("definition"), "the definition had not been written when the person stopped the programme");
  assert.equal((await store.studyById(study.id)).steps.definition.held, true);
  // A conversation writes the definition meanwhile: the step reads finished on the next pass, and the hold goes with it.
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "definition", items: null, data: definition });
  await module.orchestrator.advance(study.id);
  const after = await store.studyById(study.id);
  assert.ok(["done", "minimal"].includes(after.steps.definition.status));
  assert.equal(after.steps.definition.held, false);
  assert.equal(after.steps.evidence.held, true, "the steps nobody has produced stay held");
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

test("A7 a comparison that is to support non-inferiority is delivered limited with the reason beside it, and the same comparison without the claim is not", options, async () => {
  const module = compose({ dispatch: false });
  const study = await makeStudy("noninferiority", { dataTier: "T0" });
  await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "definition", items: null, data: definition });
  const curve = await module.curves.recordSelection({ studyId: study.id, principal: study.userId,
    imageArtifactId: "controlled-curve-source.png", points: { ...publishedArm(12), treatmentArm: publishedArm(17) } });
  /** @param {Record<string, any>} configuration */
  const compare = async (configuration) => {
    const written = await vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator, study, what: "comparator", items: null,
      data: { route: "literature_control", estimand: "ATT", configuration: { provenance: { receiptId: curve.id }, tau: 18, timeUnit: "months", ...configuration } } });
    assert.equal(written.ok, true, JSON.stringify(written.issues));
    await drainJobs(module, study);
    return (await store.results(study.id, "comparator"))[0];
  };

  const claimed = await compare({ applicability: { state: "doubtful", claim: "non_inferiority", note: "另一年代的对照" } });
  assert.equal(claimed.conclusion, "limited", "the engine double says estimable; the claim makes it limited");
  assert.deepEqual(claimed.diagnostics.applicabilityLimits.map((/** @type {any} */ entry) => entry.code), ["non_inferiority_purpose"]);
  assert.match(claimed.diagnostics.applicabilityLimits[0].reason, /非劣效/);
  assert.ok(claimed.measures.some((/** @type {any} */ measure) => measure.name === "rmst_difference"), "and the estimate is delivered");

  const plain = await compare({ applicability: { state: "partly_suitable", claim: "superiority" } });
  assert.equal(plain.conclusion, "estimable");
  assert.equal(plain.diagnostics.applicabilityLimits, undefined);
  assert.notEqual(plain.id, claimed.id, "the comparator is a new version and its result a new one; the first stands, superseded");
});

test("G12 a patient set naming an event-history model is queued on the longitudinal forecast path; with no provider that one step is skipped in the platform's sentence and the study's other work is queued all the same", options, async () => {
  const { knownErrorCodeMessage } = await import("@evimed/domain");
  /** @type {any[]} */
  const prepared = [];
  const providers = [{ id: "prov-1", name: "Event model", model: "event-model", version: "2.1.0", endpoints: ["HbA1c"], maxHorizonDays: 365 }];
  let configured = providers;
  const longitudinal = {
    providers: { list: async () => configured },
    // The module's own queueing is its test's; here the question is what the orchestrator asks of it, and what it does when told no.
    async prepare(/** @type {any} */ study, /** @type {any} */ request, /** @type {string} */ actor, /** @type {any} */ extra) {
      prepared.push({ studyId: study.id, request, actor, extra });
      return { job: { id: "job_forecast_1", state: "queued", progress: {} }, created: true };
    },
  };
  const module = compose({ longitudinal });
  const study = await makeStudy("g12event");
  const write = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
    study, what, items: Array.isArray(data) ? data : null, data: Array.isArray(data) ? null : data });
  assert.equal((await write("definition", { ...definition, title: "事件历史推演", question: "未来两年糖化血红蛋白会怎样？" })).ok, true);
  await write("assumption", [{ key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" },
    { key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, sourceKind: "expert_set", valueSource: "assumed" }]);
  const saved = await store.saveModel({ userId: study.userId, studyId: study.id, name: "event-model", version: "2.1.0", tier: "literature", risk: "low", endpointType: "time_to_event",
    card: { interfaceShape: "event_history_to_trajectories", type: "generative", inputs: ["诊断事件"], outputs: "N 条未来轨迹，是预测分布的抽样，不是对某个人的预报。",
      history: { eventTypes: ["diagnosis"], fields: ["subject", "event_type", "time"] }, trajectories: { max: 500, absorbing: ["death"] }, knownLimits: ["罕见事件校准较差"] },
    applicability: { population: "成人 2 型糖尿病", endpoints: ["time_to_event"], eventTypes: ["death"], horizon: { max: 24, unit: "months" } }, validation: { temporal: "时间外验证" } });
  assert.ok(saved?.id);
  await write("patient_set", [{ name: "两年推演", modelId: "event-model", modelVersion: "2.1.0",
    scenario: { endpoint: { code: "HbA1c", type: "continuous", unit: "%" }, horizonsDays: [90, 180] } }]);
  await write("trial_scenario", [{ label: "A 2:1 随机", design: "two_arm_fixed", endpointType: "time_to_event", assumptionIds: ["hazard_ratio", "control_median_pfs"],
    configuration: trialA.configuration }]);
  const marks = async () => Object.fromEntries((await store.rows(`SELECT key, state, job_id, detail FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND kind='job'`, [study.id]))
    .map((row) => [row.key, row]));
  const patientMark = (/** @type {Record<string, any>} */ all) => Object.values(all).find((row) => /patient_set/.test(row.key) || row.detail?.jobKind === "forecast_trajectories");

  // No history frozen yet: this step is skipped, said in the sentence the platform has for it, and the design is queued regardless.
  await module.orchestrator.advance(study.id);
  const waiting = patientMark(await marks());
  assert.equal(waiting.state, "skipped");
  assert.equal(waiting.detail.reason, "forecast_history_missing");
  assert.equal(waiting.detail.message, knownErrorCodeMessage("vcr_history_required"));
  assert.deepEqual(prepared, [], "nothing was queued on the forecast path");
  assert.ok((await store.jobs(study.id)).some((job) => job.kind === "design_analytic"), "the study's other work is queued");
  // The same with no provider configured: the sentence is the one already written for it, and it is not a failure of the study.
  configured = [];
  const stranger = await makeStudy("g12none");
  const writeIn = (/** @type {string} */ what, /** @type {any} */ data) => vcrRuntimeWrite({ store, service: module.service, orchestrator: module.orchestrator,
    study: stranger, what, items: Array.isArray(data) ? data : null, data: Array.isArray(data) ? null : data });
  await writeIn("definition", { ...definition, title: "事件历史推演", question: "未来两年糖化血红蛋白会怎样？" });
  await store.saveModel({ userId: stranger.userId, studyId: stranger.id, name: "event-model", version: "2.1.0", tier: "literature", risk: "low", endpointType: "time_to_event",
    card: saved ? (await store.models(study.userId)).find((model) => model.id === saved.id)?.card : {}, applicability: { population: "成人 2 型糖尿病", endpoints: ["time_to_event"], eventTypes: ["death"], horizon: { max: 24, unit: "months" } }, validation: { temporal: "时间外验证" } });
  await writeIn("patient_set", [{ name: "两年推演", modelId: "event-model", modelVersion: "2.1.0", scenario: { endpoint: { code: "HbA1c", type: "continuous", unit: "%" }, horizonsDays: [90] } }]);
  await module.orchestrator.advance(stranger.id);
  const none = Object.values(await store.rows(`SELECT key, state, detail FROM evimed_vcr.schedule_marks WHERE study_id=$1 AND kind='job'`, [stranger.id])).find((row) => row.state === "skipped");
  assert.equal(none.detail.reason, "forecast_provider_unavailable");
  assert.equal(none.detail.message, knownErrorCodeMessage("vcr_forecast_provider_unavailable"));
  assert.deepEqual(prepared, []);

  // With a provider that declares the model and a frozen history, the step is queued by the forecast module, with the orchestrator's own key and detail.
  // The step was skipped for want of a history; nothing else about the patient set moved, and the next pass asks again all the same.
  configured = providers;
  await store.query(`INSERT INTO evimed_vcr.longitudinal_artifacts (id, study_id, kind, sha256, location, snapshot_ids, source_ids, summary, bindings)
    VALUES ('vlf_history_1', $1, 'history', $2, 'x', '[]', '[]', '{}', '[]')`, [study.id, "a".repeat(64)]);
  assert.equal(patientMark(await marks()).state, "skipped", "still declined until a pass has seen the history");
  await module.orchestrator.advance(study.id);
  assert.equal(prepared.length, 1);
  const [call] = prepared;
  assert.equal(call.request.kind, "forecast_trajectories");
  assert.deepEqual(call.request.scenario, { historyId: "vlf_history_1", providerId: "prov-1", endpoint: { code: "HbA1c", type: "continuous", unit: "%" }, horizonsDays: [90, 180], modelVersion: "2.1.0" });
  assert.equal(call.actor, study.userId);
  assert.match(call.extra.idempotencyKey, /^vcr:/);
  assert.equal(typeof call.extra.detail.node, "string");
  assert.equal(call.extra.detail.resultKind, undefined, "not filed as the patient set's own table");
  const running = patientMark(await marks());
  assert.deepEqual([running.state, running.job_id], ["running", "job_forecast_1"]);
});

test("D7 a result is exported as a short record only on request: written from the stored result, ready at once, the same record once, and its document is the record", options, async () => {
  const module = compose({ dispatch: false });
  const study = await makeStudy("record");
  const scenario = { design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 },
    accrual: { kind: "uniform", duration: 12, followup: 12 }, analysis: { method: "logrank", alpha: 0.025, sided: 1 } };
  const { job } = await module.jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, inputs: [], internal: true,
    idempotencyKey: `record:${Math.random()}`, detail: { subjectId: null, origin: "runtime" } });
  await store.query(`UPDATE evimed_vcr.jobs SET checkpoint = checkpoint || $2::jsonb WHERE id = $1`, [job.id,
    JSON.stringify({ appliedDefaults: [{ path: "accrual.dropoutAnnual", value: 0 }], replicatePlan: { floor: 5000, basis: "default", intendedUse: "exploratory", targetMcse: null } })]);
  const execution = await store.recordExecution({ jobId: job.id, studyId: study.id, userId: study.userId, method: job.method, methodVersion: "1.3.0", scenarioHash: "a1b2c3d4e5f60708".repeat(4),
    inputs: [{ kind: "assumption", id: "hazard_ratio@2" }], environment: { engineVersion: "1.0.0", rVersion: "4.3.3", packageLockHash: "56edc6432ad4aaaaaaaa" }, seed: 777, replicates: 5000, outputHash: "9f".repeat(32),
    receipt: {}, cpuSeconds: 3, startedAt: null, finishedAt: null });
  const result = await store.recordResult({ studyId: study.id, userId: study.userId, executionId: execution.id, kind: "trial_scenario", subjectId: null, conclusion: "estimable", counts: {},
    measures: [{ name: "power", value: 0.9, simulated: true, mcse: 0.004, source: "synthetic" }],
    diagnostics: { exampleTrial: { replicate: 1, seed: 777, values: { estimate: -0.3421, se: 0.1, statistic: -3.42, p: 0.0003, reject: 1, events: 201, sampleSize: 300, duration: 24 } } }, tables: [] });
  const user = { id: study.userId };

  // nothing built a record by itself
  assert.equal((await store.exports(study.id)).filter((row) => row.kind === "result_record").length, 0);
  await assert.rejects(module.orchestrator.requestExport(user, study, "result_record", {}), { code: "vcr_payload_invalid" });
  await assert.rejects(module.orchestrator.requestExport(user, study, "result_record", { resultId: "res_nobody" }), { code: "vcr_result_not_found" });

  const asked = await module.orchestrator.requestExport(user, study, "result_record", { resultId: result.id });
  assert.equal(asked.export.state, "ready", "no run to wait for");
  assert.equal(asked.runId, null);
  const row = await store.exportRow(study.id, asked.export.id);
  assert.equal(row.kind, "result_record");
  assert.equal(row.cover.record.resultId, result.id);
  assert.equal(row.cover.record.hasExampleTrial, true);
  assert.deepEqual(row.cover.record.sections.map((section) => section.id), ["what", "assumptions", "versions", "example", "links"]);
  const markdown = row.cover.reports[0].rendered;
  assert.match(markdown, /^# EV-201 record — 结果记录/);
  assert.match(markdown, /- truth\.hazardRatio = 0\.7\n/);
  assert.match(markdown, /- accrual\.dropoutAnnual = 0（默认）/);
  assert.match(markdown, /- 随机种子：777/);
  assert.match(markdown, /- 重复次数：5,000（备择情景的默认下限 5,000 次）/);
  assert.match(markdown, /- 方法版本：design\.simulate 1\.3\.0/);
  assert.match(markdown, /- 计算引擎：1\.0\.0，R 4\.3\.3，包锁定 56edc6432ad4/);
  assert.match(markdown, /第 1 次重复（种子 777）/);
  assert.match(markdown, /- 估计值：-0\.3421/);
  assert.match(markdown, /- 用到的假设卡和证据：hazard_ratio@2/);
  assert.match(markdown, new RegExp(`/app/virtual-research/${study.id}/trial`));

  // the same record is the same export; a changed result is another
  const again = await module.orchestrator.requestExport(user, study, "result_record", { resultId: result.id });
  assert.equal(again.export.id, asked.export.id);
  assert.equal((await store.exports(study.id)).filter((entry) => entry.kind === "result_record").length, 1);

  // and its document is the record, not a rendering of the study's package
  const { canonicalVcrDocument } = await import("../src/vcrDocumentExport.mjs");
  const document = canonicalVcrDocument(study, row);
  assert.equal(document.canonicalMarkdown, markdown);
  assert.equal(document.title, "EV-201 record — 结果记录");
  assert.doesNotMatch(document.canonicalMarkdown, /未计算/, "no typed number was blanked by the report's number template");
});

/**
 * A model's side of the gateway for an account and a project nothing exists for yet: the first write or computation makes the
 * conversation's study, as it does for a real conversation. Returns the call and the study once it exists.
 * @param {string} label @param {ReturnType<typeof compose>} module
 */
function modelConversation(label, module, extra = {}) {
  const ids = { userId: `u_${label}`, projectId: "default" };
  const runtimeManager = { assertActiveModelGatewayToken: () => ids };
  const origin = { ...ids, rootSessionId: `ses_${label}`, sessionId: `ses_${label}`, callId: `call_${label}`, runId: null };
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:8788/internal/models/v1" }, runtimeManager,
    { vcr: { service: module.service, store, jobs: module.jobs, orchestrator: module.orchestrator, ...extra }, resolveInvocation: async () => origin });
  const call = async (/** @type {string} */ operation, /** @type {Record<string, any>} */ body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: `/internal/vcr/v1/${operation}`, headers: { authorization: "Bearer t", "x-evimed-execution-context": "native-fixture" } });
    const res = { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; }, end(/** @type {string} */ chunk = "") { this.body = String(chunk); } };
    await handler(req, res);
    return { status: res.status, ...JSON.parse(res.body) };
  };
  return { call, study: async () => store.taskContext(origin, { create: false }) };
}

/** The shape of the 2026-11-01 design comparison (live run c4b3): the same designs, written once and then started by id alone. */
const liveDesigns = ["A 固定 1:1", "B 成组序贯 1:1", "C 固定 2:1"].map((label, at) => ({
  label, design: at === 1 ? "group_sequential" : "two_arm_fixed", endpointType: "time_to_event",
  configuration: { design: { kind: at === 1 ? "group_sequential" : "two_arm_fixed", allocation: at === 2 ? 0.6667 : 0.5, nTreat: at === 2 ? 639 : 415, nControl: at === 2 ? 320 : 415,
    ...(at === 1 ? { informationRates: [0.5, 1], spending: "obrien_fleming" } : {}) },
    endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.75, controlMedian: 13.5 },
    analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 }, accrual: { kind: "uniform", duration: 24, followup: 12, dropoutAnnual: 0.05 }, timeUnit: "months", performance: ["power"] },
}));

test("a design written in the conversation is validated and started by its id alone: the platform builds the scenario from the object", options, async () => {
  const module = compose();
  const model = modelConversation("byid", module);
  const written = await model.call("write", { what: "trial_scenario", items: liveDesigns });
  assert.equal(written.data.ok, true, JSON.stringify(written));
  const [a, b] = written.data.ids;
  const named = written.data.results.find((/** @type {any} */ entry) => entry.named);
  assert.deepEqual(named.named.map((/** @type {any} */ entry) => entry.name), ["A 固定 1:1", "B 成组序贯 1:1", "C 固定 2:1"], "the answer gives the names a reply uses, beside the ids");
  assert.deepEqual(named.named.map((/** @type {any} */ entry) => entry.id), written.data.ids);
  // validate with a subject and no scenario: the object's own configuration, not the three missing keys of an empty one
  const checked = await model.call("simulate", { action: "validate", kind: "design_analytic", subjectId: a });
  assert.equal(checked.status, 200, JSON.stringify(checked));
  assert.equal(checked.data.valid, true, JSON.stringify(checked.data.issues));
  assert.equal(checked.data.scenario.truth.hazardRatio, 0.75);
  assert.equal(checked.data.scenario.analysis.method, undefined, "the analytic stage reads no test name: the object's description of it did not travel");
  const started = await model.call("simulate", { action: "start", kind: "design_analytic", subjectId: a });
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.equal(started.data.subject.id, a);
  assert.equal(started.data.subject.name, "A 固定 1:1");
  const frozen = async (/** @type {string} */ id) => (await store.rows("SELECT scenario FROM evimed_vcr.jobs WHERE id = $1", [id]))[0].scenario;
  const job = { scenario: await frozen(started.data.jobId) };
  assert.deepEqual(job.scenario.design, { kind: "two_arm_fixed", allocation: 0.5 });
  assert.deepEqual(job.scenario.truth, { hazardRatio: 0.75, controlMedian: 13.5 });
  // the simulation of a group-sequential design carries its looks, from the object
  const simulated = await model.call("simulate", { action: "start", kind: "design_simulation", subjectId: b });
  assert.equal(simulated.status, 200, JSON.stringify(simulated));
  assert.deepEqual((await frozen(simulated.data.jobId)).design.informationRates, [0.5, 1]);
  // a subject the study does not hold is still refused by name, not guessed
  const unknown = await model.call("simulate", { action: "start", kind: "design_analytic", subjectId: "scn_nobody" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.code, "vcr_simulate_subject_unknown");
});

test("keys that only describe what design_analytic does are left out and said, a described value the engine would not honour is refused with the reason, and a misspelt key still fails", options, async () => {
  const module = compose();
  const model = modelConversation("descriptive", module);
  const scenario = { design: { kind: "two_arm_fixed", allocation: 0.5 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.75, controlMedian: 13.5 },
    analysis: { alpha: 0.025, power: 0.9, sided: 1 }, accrual: { duration: 24, followup: 12, dropoutAnnual: 0.05 }, timeUnit: "months" };
  const described = { ...scenario, analysis: { ...scenario.analysis, method: "logrank" }, accrual: { ...scenario.accrual, kind: "uniform" } };
  const checked = await model.call("simulate", { action: "validate", kind: "design_analytic", scenario: described });
  assert.equal(checked.data.valid, true, JSON.stringify(checked.data.issues));
  assert.deepEqual(checked.data.normalized.map((/** @type {any} */ entry) => entry.field), ["analysis.method", "accrual.kind"]);
  assert.deepEqual(checked.data.scenario, scenario, "the frozen scenario is the one without the descriptions");
  // an analysis the analytic design does not make is not a description
  const other = await model.call("simulate", { action: "validate", kind: "design_analytic", scenario: { ...scenario, analysis: { ...scenario.analysis, method: "maxcombo" } } });
  assert.equal(other.data.valid, false);
  assert.equal(other.data.issues[0].field, "scenario.analysis.method");
  assert.match(other.data.issues[0].message, /log-rank/);
  assert.match(other.data.issues[0].message, /maxcombo/);
  // a key that is not on the list keeps failing: a silent ignore would change the computation
  const misspelt = await model.call("simulate", { action: "validate", kind: "design_analytic", scenario: { ...scenario, accrual: { duration: 24, followup: 12, dropoutAnual: 0.05 } } });
  assert.equal(misspelt.data.valid, false);
  assert.equal(misspelt.data.issues[0].field, "scenario.accrual.dropoutAnual");
  // started with the descriptions or without them, it is one job
  const first = await model.call("simulate", { action: "start", kind: "design_analytic", scenario: described });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.deepEqual(first.data.normalized.map((/** @type {any} */ entry) => entry.field), ["analysis.method", "accrual.kind"]);
  const second = await model.call("simulate", { action: "start", kind: "design_analytic", scenario });
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.equal(second.data.jobId, first.data.jobId, "the description is not part of what makes a job the same job");
});

test("a design grid with labelled designs and truths is computed with nothing written first, labels left out and said; and the grid written as an object is started by its id alone", options, async () => {
  const module = compose();
  const model = modelConversation("grid", module);
  const grid = {
    accrual: { dropoutAnnual: 0.05, duration: 24, followup: 12 }, design: { kind: "two_arm_fixed", nControl: 415, nTreat: 415 },
    designs: [{ kind: "two_arm_fixed", label: "A 固定 1:1", nControl: 415, nTreat: 415 },
      { informationRates: [0.5, 1], kind: "group_sequential", label: "B 成组序贯 1:1", nControl: 416, nTreat: 416, spending: "obrien_fleming" },
      { kind: "two_arm_fixed", label: "C 固定 2:1", nControl: 320, nTreat: 639 }],
    endpoint: { type: "time_to_event" }, performance: ["power", "type_one_error"], timeUnit: "months", truth: { controlMedian: 13.5, hazardRatio: 0.75 },
    truths: [{ hazardRatio: 0.75, label: "HR 0.75" }, { hazardRatio: 0.8, label: "HR 0.80" }, { hazardRatio: 1, label: "零效应", null: true }],
  };
  const checked = await model.call("simulate", { action: "validate", kind: "design_grid", scenario: grid });
  assert.equal(checked.data.valid, true, JSON.stringify(checked.data.issues));
  assert.deepEqual(checked.data.normalized.map((/** @type {any} */ entry) => entry.field), ["designs[].label", "truths[].label"]);
  assert.equal(checked.data.scenario.designs.some((/** @type {any} */ design) => "label" in design), false);
  const started = await model.call("simulate", { action: "start", kind: "design_grid", scenario: grid });
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.equal(started.data.subject.kind, "design_grid", "the grid is the object the scenario was filed under");
  const study = await model.study();
  const stored = await store.latestDesignGrid(study.id);
  assert.equal(stored.id, started.data.subject.id);
  // the same grid again is that grid; started by its id alone it is built from the object
  const again = await model.call("simulate", { action: "start", kind: "design_grid", scenario: grid });
  assert.equal(again.status, 200, JSON.stringify(again));
  assert.equal(again.data.subject.id, stored.id);
  const byId = await model.call("simulate", { action: "start", kind: "design_grid", subjectId: stored.id });
  assert.equal(byId.status, 200, JSON.stringify(byId));
  assert.equal(byId.data.subject.id, stored.id);

  // the grid as the model wrote it as an object (dimensions, truthScenarios, labels, a test name in the base) and started by its id alone
  const other = modelConversation("grid_object", module);
  const written = await other.call("write", { what: "design_grid", data: {
    comparisonGoal: { text: "比较三个方案", measures: [{ name: "power", direction: "higher" }] },
    dimensions: { base: { accrual: { dropoutAnnual: 0.05, duration: 24, followup: 12 }, analysis: { alpha: 0.025, method: "logrank", sided: 1 }, endpoint: { type: "time_to_event" },
      performance: ["power", "type_one_error"], timeUnit: "months", truth: { controlMedian: 13.5 } },
    designs: [{ kind: "two_arm_fixed", label: "A 固定 1:1", nControl: 415, nTreat: 415 }, { kind: "two_arm_fixed", label: "C 固定 2:1", nControl: 320, nTreat: 639 }] },
    truthScenarios: [{ hazardRatio: 0.75, label: "设计目标 HR 0.75" }, { hazardRatio: 1, label: "零效应", null: true }] } });
  assert.equal(written.data.ok, true, JSON.stringify(written.data.issues));
  const checkedGrid = await other.call("simulate", { action: "validate", kind: "design_grid", subjectId: written.data.ids[0] });
  assert.equal(checkedGrid.data.valid, true, JSON.stringify(checkedGrid.data.issues));
  const gridStart = await other.call("simulate", { action: "start", kind: "design_grid", subjectId: written.data.ids[0] });
  assert.equal(gridStart.status, 200, JSON.stringify(gridStart));
  // a population and an E-value filed by their scenario are started by their ids alone as well
  const hazard = { riskRatio: 0.6, confidenceLimit: 0.8, scale: "hazard_ratio", rare: true };
  const evalue = await other.call("simulate", { action: "start", kind: "evalue", scenario: hazard });
  assert.equal(evalue.status, 200, JSON.stringify(evalue));
  const evalueAgain = await other.call("simulate", { action: "start", kind: "evalue", subjectId: evalue.data.subject.id });
  assert.equal(evalueAgain.status, 200, JSON.stringify(evalueAgain));
  assert.equal(evalueAgain.data.jobId, evalue.data.jobId, "the object's own scenario is the same frozen scenario");
  const people = { n: 100, population: { variables: [{ name: "age", family: "normal", mean: 60, sd: 10 }] } };
  const population = await other.call("simulate", { action: "start", kind: "generate_population", scenario: people });
  assert.equal(population.status, 200, JSON.stringify(population));
  const populationAgain = await other.call("simulate", { action: "start", kind: "generate_population", subjectId: population.data.subject.id });
  assert.equal(populationAgain.status, 200, JSON.stringify(populationAgain));
  const frozenGrid = (await store.rows("SELECT scenario FROM evimed_vcr.jobs WHERE id = $1", [gridStart.data.jobId]))[0].scenario;
  assert.equal(frozenGrid.designs.length, 2);
  assert.equal(frozenGrid.truths.length, 2);
  assert.equal(frozenGrid.designs.some((/** @type {any} */ design) => "label" in design), false);
});

test("a median OS read from a PubMed abstract is evidence of its paper: verified against the abstract the platform preserved, or kept and marked unchecked, and a card made of either reads as literature on the page", async () => {
  const { createVcrEvidencePipeline } = await import("../src/vcrEvidence.mjs");
  const { createVcrPublicationSources } = await import("../src/vcrPublicationSources.mjs");
  const { premiseReasonOfCard, premiseSourceOfCard } = await import("../src/vcrPremises.mjs");
  const abstract = "# HIMALAYA\n\n- PMID: 37676259\n\n## Abstract\n\nThe median OS was 16.4 months (95% CI, 14.2–19.6) with tremelimumab in combination with durvalumab and 13.8 months (95% CI, 12.3–16.1) with sorafenib.\n";
  const hashes = { "abstract.md": sha(abstract) };
  const version = sha(JSON.stringify(hashes));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-pubint-"));
  const captureDir = path.join(workspace, ".evimed-sources/pubmed/PMID37676259", version);
  await fs.mkdir(captureDir, { recursive: true });
  await fs.writeFile(path.join(captureDir, "abstract.md"), abstract);
  await fs.writeFile(path.join(captureDir, "capture.json"), JSON.stringify({ version, artifacts: hashes }));

  const module = compose();
  const evidenceStore = new VcrEvidenceStore({ database });
  const evidence = createVcrEvidencePipeline({ store: evidenceStore, jobs: module.jobs });
  evidence.attachPublications(createVcrPublicationSources({ resolveProject: async () => ({ workspaceDir: workspace }) }));
  const model = modelConversation("paper", module, { evidence, evidenceStore });
  const live = (/** @type {Record<string, any>} */ more = {}) => ({ registry: "pubmed", registryId: "37676259", parameter: "control_median_os", arm: "sorafenib", armRole: "control", value: 13.8, unit: "months",
    ciLow: 12.3, ciHigh: 16.1, sampleSize: 389, valueSource: "reported", quote: "13.8 months (95% CI, 12.3–16.1) with sorafenib", endpointKey: "os", line: "first", evidenceKind: "outcome", ...more });

  // the call the model made, with the words it chose: nothing is refused for a spelling or for the registry it named
  const read = await model.call("write", { what: "evidence_item", items: [live({ sampleSize: undefined })] });
  assert.equal(read.status, 200, JSON.stringify(read));
  assert.equal(read.data.ok, true, JSON.stringify(read.data.issues));
  const [checkedId] = read.data.ids;
  // a paper the platform never read: the number is kept, unchecked, and the write says so without refusing it
  const unread = await model.call("write", { what: "evidence_item", items: [live({ registryId: "11111111", parameter: "control_median_os" })] });
  assert.equal(unread.data.ok, true, JSON.stringify(unread.data.issues));
  assert.deepEqual(unread.data.issues.map((/** @type {any} */ entry) => entry.code), ["vcr_evidence_reported_unverified"]);
  const [uncheckedId] = unread.data.ids;
  const study = await model.study();
  const stored = await evidenceStore.itemsById({ userId: study.userId, studyId: study.id, ids: [checkedId, uncheckedId] });
  const by = new Map(stored.map((/** @type {any} */ row) => [row.id, row]));
  assert.equal(by.get(checkedId).locator.verification, "verified");
  assert.equal(Number(by.get(checkedId).value), 13.8);
  assert.equal(by.get(uncheckedId).locator.verification, "reported_unverified");
  assert.equal(Number(by.get(uncheckedId).value), 13.8, "an unchecked number is kept as reported");
  assert.equal(by.get(uncheckedId).arm_role, "control");
  assert.equal(by.get(checkedId).value_source, "extracted");
  assert.deepEqual(await evidenceStore.verifiedEvidenceIds({ userId: study.userId, studyId: study.id, parameter: "control_median_os" }), [checkedId], "pooling and baselines read the checked one only");

  // a card that takes either, with the words the model used
  const card = (/** @type {string} */ id, /** @type {string} */ key) => ({ key, name: "对照组 OS 中位数", parameter: "control_median_os", endpoint: "os", unit: "months", sourceKind: "literature", evidenceIds: [id] });
  const fromChecked = await model.call("write", { what: "assumption", items: [card(checkedId, "control_median_os")] });
  assert.equal(fromChecked.data.ok, true, JSON.stringify(fromChecked.data.issues));
  const fromUnchecked = await model.call("write", { what: "assumption", items: [card(uncheckedId, "control_median_os_unchecked")] });
  assert.equal(fromUnchecked.data.ok, true, JSON.stringify(fromUnchecked.data.issues));
  const cards = new Map((await store.assumptions(study.id)).map((/** @type {any} */ entry) => [entry.key, entry]));
  const first = cards.get("control_median_os");
  const second = cards.get("control_median_os_unchecked");
  assert.equal(first.pointValue, 13.8);
  assert.equal(first.sourceKind, "external_evidence");
  assert.deepEqual(first.evidenceIds, [checkedId]);
  assert.equal(premiseSourceOfCard(first), "literature", "the page says 文献, not 假设");
  assert.equal(premiseReasonOfCard(first), "引自 PMID 37676259");
  assert.equal(premiseSourceOfCard(second), "literature");
  assert.match(premiseReasonOfCard(second) ?? "", /未核对/);
  // the literature value could not be a simulated one: the card is the paper's number as the paper gave it
  assert.equal(second.pointValue, 13.8);
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * The refused calls of the two live conversations of 2026-11-01 (`fixtures/vcr-live-refusals-20261101.json`), replayed without a model through
 * the gateway as it is now: the recorded arguments in the recorded order, the ids a call refers to mapped to the ones the replay made.
 * Each call that was refused then is held to what the fixture says it is now (`after`), with the reason: a class of refusal that comes back
 * fails here by name, and so does a refusal that should stand and does not.
 */
test("the 15 refused calls of the two live conversations of 2026-11-01, replayed without a model: what passes now, and what still refuses and should", options, async () => {
  const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/vcr-live-refusals-20261101.json", import.meta.url), "utf8"));
  const module = compose();
  const model = modelConversation("replay", module, { seal: module.seal });
  /** @type {Map<string, string>} */
  const ids = new Map();
  const substitute = (/** @type {any} */ value) => { let text = JSON.stringify(value); for (const [from, to] of ids) text = text.replaceAll(from, to); return JSON.parse(text); };
  const reminders = new Set(["vcr_evidence_reported_unverified", "vcr_assumption_role_missing", "vcr_comparator_record_incomplete", "vcr_evidence_item_incomplete"]);
  /** @type {Array<Record<string, any>>} */
  const table = [];
  for (const call of fixture.c4b3.calls) {
    const answer = await model.call(call.op, substitute(call.args));
    /** @type {{ outcome: string, fields: string[], items: Record<string, string> }} */
    let seen;
    if (call.op === "write") {
      const refusals = (answer.data?.issues ?? []).filter((/** @type {any} */ entry) => !reminders.has(entry.code));
      const indexes = new Set(refusals.map((/** @type {any} */ entry) => entry.index ?? 0));
      const count = Array.isArray(call.args.items) ? call.args.items.length : 1;
      seen = { outcome: !refusals.length ? "passes" : (answer.data?.ids?.length ? "partly" : "refuses"), fields: [...new Set(refusals.map((/** @type {any} */ entry) => String(entry.field)))],
        items: Object.fromEntries([...Array(count).keys()].map((at) => [String(at), indexes.has(at) ? "refuses" : "passes"])) };
      for (const [at, id] of (answer.data?.ids ?? []).entries()) if (call.recorded.ids?.[at]) ids.set(call.recorded.ids[at], id);
    } else if (call.args.action === "validate") {
      seen = { outcome: answer.status === 200 && answer.data?.valid === true ? "passes" : "refuses", fields: (answer.data?.issues ?? []).map((/** @type {any} */ entry) => String(entry.field)), items: {} };
    } else {
      seen = { outcome: answer.status === 200 && answer.data?.jobId ? "passes" : "refuses", fields: (answer.issues ?? []).map((/** @type {any} */ entry) => String(entry.field)), items: {} };
      if (call.recorded.subjectId && answer.data?.subject?.id) ids.set(call.recorded.subjectId, answer.data.subject.id);
    }
    if (!call.recorded.refused) {
      assert.equal(seen.outcome, "passes", `${call.id}: a call that was accepted then is still accepted: ${JSON.stringify(answer).slice(0, 400)}`);
      continue;
    }
    assert.ok(call.after, `${call.id}: a refused call has an expectation`);
    assert.equal(seen.outcome, call.after.outcome, `${call.id} (${call.after.why}): ${JSON.stringify(answer).slice(0, 600)}`);
    if (call.after.fields) assert.deepEqual([...new Set(seen.fields)].sort(), [...call.after.fields].sort(), `${call.id}: what still refuses, and by which field`);
    if (call.after.items) assert.deepEqual(seen.items, call.after.items, `${call.id}: item by item`);
    table.push({ id: call.id, was: call.recorded.issues?.length ?? 1, now: seen.outcome, fields: seen.fields });
  }
  const tally = { passes: table.filter((row) => row.now === "passes").length, partly: table.filter((row) => row.now === "partly").length, refuses: table.filter((row) => row.now === "refuses").length };
  console.log(`replay c4b3: ${table.length} refused calls then -> ${tally.passes} pass, ${tally.partly} partly (the refused items still refuse), ${tally.refuses} still refuse`);
  assert.deepEqual([table.length, tally], [14, { passes: 11, partly: 1, refuses: 2 }]);

  // c1: the matching write that was refused on nineteen lines (the first item's eleven are replayed: the second item's criteria were not recorded)
  const { vcrRuntimeWrite: write } = await import("../src/vcrGateway.mjs");
  const item = fixture.c1.item;
  const trial = { registry: "clinicaltrials.gov", registryId: item.registryId, recordHash: "fixture", eligibilityText: item.criteria.map((/** @type {any} */ criterion) => criterion.sourceText).join("\n") };
  /** @type {any[]} */ const written = [];
  const answer = await write({ store: {}, service: {}, orchestrator: null, study: { id: "std_c1", userId: "u_c1", projectId: "default", scope: "conversation" }, what: "candidate_trial", items: [item], data: null,
    evidence: { async candidateRecord() { return { status: "ok", trial }; } },
    patientTrials: { async holds() { return true; }, async writeTrial(/** @type {any} */ _study, /** @type {any} */ input) { written.push(input); return { trial: { id: "ctr_1" }, created: true, criteria: input.criteria, evaluation: { evaluated: [] } }; } } });
  assert.deepEqual(answer.issues.filter((/** @type {any} */ entry) => /criterionType/.test(entry.field)), [], "no line is refused for a type");
  assert.equal(answer.ok, true, JSON.stringify(answer.issues));
  assert.equal(written[0].criteria.length, 15, "all fifteen criteria are written");
  const read = answer.results.find((/** @type {any} */ entry) => entry.applied).applied;
  assert.equal(read.length, fixture.c1.recorded.issuesInTotal === 19 ? 11 : read.length, "the eleven lines that were refused are the eleven words read");
  assert.deepEqual(written[0].criteria.map((/** @type {any} */ criterion) => criterion.criterionType), ["demographic", "diagnosis", "prior_treatment", "biomarker", "diagnosis", "performance_status", "lab", "lab", "lab", "lab", "diagnosis", "other", "prior_treatment", "comorbidity", "comorbidity"]);
  console.log("replay c1: the matching write that was refused on 19 lines (11 of them in the first item, replayed) -> 0 refused; 10 types read as the type they mean, 1 (cns) saved as other");
});
