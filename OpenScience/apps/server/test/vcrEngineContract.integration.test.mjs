// The engine seam, on real parts: the orchestrator's own jobs, the queue, the
// engine client and the real engine service running the real R engine.
//
// The first build proved the orchestrator against an engine double and the
// engine against jobs the test wrote by hand, and the two never met: the
// orchestrator emitted scenarios the engine could not read, so the T0 chain —
// the product's headline claim, a whole study with no patient data — failed at
// its third step. This file is the meeting. A T0 study is seeded the way the
// runtime seeds one (through the store, as the gateway's writes do), the
// orchestrator builds every job itself, and each one goes through
// `VcrJobs.enqueue` (which validates it against the domain's per-method schemas),
// over HTTP to `service/app.py` (bearer token, signed receipt, output tables),
// into `Rscript service/run_job.R`, and back through the client's receipt and
// echo checks into the ledger. Nothing between the seed and the result is a
// double except the run dispatcher (no model runs here) and, for the T1 case, the
// data plane's resolver (a faithful one over real files in a scratch directory).
//
// Its own database and its own scratch directory: the engine reads files by
// location and hash, so the files have to be real.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { VCR_ENGINE_METHODS, VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_VALUE_SOURCES, validateEngineJob } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createVcrEngineClient } from "../src/vcrEngineClient.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { VcrOrchestrator, vcrBuildStages } from "../src/vcrOrchestrator.mjs";
import { seedVcrCatalogue } from "../src/vcrService.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createVcrWorkerLoops } from "../src/vcrWorker.mjs";
import { COHORT_SIZE, FIELD_MAP, cohortCsv, streamOf, visitsCsv } from "./helpers/vcrIntakeData.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(HERE, "../../../../项目代码/vcr-engine");
const R_LIBS = process.env.VCR_R_LIBS ?? "/home/coder/R/vcr-4.3";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 900_000 };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {VcrStore} */
let store;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";
/** @type {string} */
let scratch = "";
/** @type {import("node:child_process").ChildProcess | null} */
let service = null;
let servicePort = 0;
/** @type {ReturnType<typeof createVcrEngineClient>} */
let engine;
const token = "t".repeat(48);
const receiptKey = "r".repeat(48);
let serviceLog = "";

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {net.AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  if (!databaseUrl) return;
  // The box has to have R: a skipped engine test would be a green run that proves nothing.
  const rscript = spawnSync("Rscript", ["--version"], { encoding: "utf8" });
  assert.equal(rscript.status, 0, "Rscript must be installed: this file is the proof the control plane and the real engine agree");

  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrseam_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
  await seedVcrCatalogue({ store });

  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-seam-"));
  await fs.mkdir(path.join(scratch, "data-plane"), { recursive: true });
  await fs.mkdir(path.join(scratch, "jobs"), { recursive: true });
  await fs.writeFile(path.join(scratch, "token"), token, { mode: 0o600 });
  await fs.writeFile(path.join(scratch, "receipt-key"), receiptKey, { mode: 0o600 });

  servicePort = await freePort();
  service = spawn("python3", ["-m", "uvicorn", "service.app:app", "--host", "127.0.0.1", "--port", String(servicePort), "--log-level", "warning"], {
    cwd: ENGINE_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? scratch, LANG: "C.UTF-8",
      VCR_ENGINE_ROOT: ENGINE_ROOT, VCR_R_LIBS: R_LIBS,
      VCR_ENGINE_TOKEN_FILE: path.join(scratch, "token"), VCR_ENGINE_RECEIPT_KEY_FILE: path.join(scratch, "receipt-key"),
      VCR_ENGINE_WORK_DIR: path.join(scratch, "jobs"), VCR_ENGINE_DATA_ROOT: path.join(scratch, "data-plane"),
      VCR_ENGINE_CORES: "2", VCR_ENGINE_CPU_SECONDS: "600",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serviceExit = "";
  service.on("error", (error) => { serviceExit = `the engine service could not start: ${error.message}`; });
  service.on("exit", (code, signal) => { serviceExit = `the engine service exited (${code ?? signal})`; });
  service.stdout?.on("data", (chunk) => { serviceLog += String(chunk); });
  service.stderr?.on("data", (chunk) => { serviceLog += String(chunk); });
  engine = createVcrEngineClient({ baseUrl: `http://127.0.0.1:${servicePort}`, token, receiptKey, timeoutMs: 120_000 });
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const health = await engine.health();
      if (health.ok) break;
    } catch { /* still starting */ }
    if (serviceExit || Date.now() > deadline) throw new Error(`${serviceExit || "the engine service did not come up"}:\n${serviceLog.slice(-2000)}`);
    await sleep(500);
  }
});

after(async () => {
  service?.kill("SIGTERM");
  await sleep(300);
  service?.kill("SIGKILL");
  if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  await database?.close().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

/** @param {Record<string, any>} [extra] */
const configFor = (extra = {}) => ({
  vcrEnabled: true, vcrAudience: "all", vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 1_000_000, vcrMaxConcurrentJobs: 2,
  vcrLeaseMs: 900_000, vcrDataPlaneDir: path.join(scratch, "data-plane"), ...extra,
});

/**
 * The module composed the way `server.mjs` composes it, over the real engine
 * client. No run is ever dispatched (no model here); every computation is the
 * platform's own.
 * @param {{ dataPlane?: any, config?: Record<string, any> }} [parts]
 */
function compose({ dataPlane = null, config = configFor() } = {}) {
  const jobs = new VcrJobs({ store, config, engine, dataPlane });
  const orchestrator = new VcrOrchestrator({ store, jobs, config, dispatchRun: null });
  const loops = createVcrWorkerLoops({ jobs, orchestrator, store });
  return { jobs, orchestrator, loops, config };
}

/**
 * Run the worker's own `jobs` loop until nothing is queued or running and the
 * orchestrator has nothing more to enqueue.
 * @param {ReturnType<typeof compose>} module @param {string} studyId
 */
async function settle(module, studyId, { limitMs = 600_000 } = {}) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    await module.loops.jobs?.();
    await module.orchestrator.advance(studyId);
    const open = await store.rows(`SELECT id, kind, state FROM evimed_vcr.jobs WHERE study_id = $1 AND state IN ('queued', 'running', 'awaiting_budget')`, [studyId]);
    if (!open.length) {
      // One more pass: what a finished job made possible (the next stage) is enqueued by the pass that heard of it.
      await module.orchestrator.advance(studyId);
      const again = await store.rows(`SELECT id FROM evimed_vcr.jobs WHERE study_id = $1 AND state IN ('queued', 'running')`, [studyId]);
      if (!again.length) return;
    }
    if (Date.now() > deadline) throw new Error(`the jobs did not settle: ${JSON.stringify(open)}\n${serviceLog.slice(-1500)}`);
    await sleep(400);
  }
}

/**
 * A published survival curve, digitized: the Kaplan-Meier estimate of `n` simulated
 * patients (exponential with the given median, administratively censored at 24
 * months) read off every quarter of a month, with the numbers at risk the paper
 * would print and the events and median it would report. Built from a simulated
 * trial and not from the formula, because the reconstruction's quality control
 * holds a curve to the events and the at-risk table of a real cohort — the first
 * version of this fixture was the formula, and the engine (correctly) refused it.
 * @param {number} median @param {number} n @param {number} seed
 */
function publishedArm(median, n, seed) {
  let state = seed;
  const uniform = () => { state = (state * 1103515245 + 12345) % 2147483648; return (state + 1) / 2147483649; };
  const rate = Math.log(2) / median;
  const patients = Array.from({ length: n }, () => {
    const time = -Math.log(uniform()) / rate;
    return time <= 24 ? { time, event: 1 } : { time: 24, event: 0 };
  });
  const survival = (/** @type {number} */ t) => {
    let s = 1;
    for (const at of [...new Set(patients.filter((p) => p.event && p.time <= t).map((p) => p.time))].sort((a, b) => a - b)) {
      const atRisk = patients.filter((p) => p.time >= at).length;
      const events = patients.filter((p) => p.event && p.time === at).length;
      s *= 1 - events / atRisk;
    }
    return s;
  };
  const times = Array.from({ length: 97 }, (_unused, i) => i * 0.25);
  let reportedMedian = null;
  for (let t = 0; t <= 24 && reportedMedian === null; t += 0.05) if (survival(t) <= 0.5) reportedMedian = Math.round(t * 100) / 100;
  return {
    curve: times.map((time) => ({ time, surv: Math.round(survival(time) * 1e4) / 1e4 })),
    riskTable: [0, 6, 12, 18, 24].map((time) => ({ time, atRisk: patients.filter((p) => p.time >= time).length })),
    totalEvents: patients.filter((p) => p.event).length,
    reportedMedian,
  };
}

const definition = {
  pico: { population: "二线 NSCLC", intervention: "EV", comparator: "化疗", outcome: "PFS" },
  estimand: { population: "二线 NSCLC", variable: "PFS", treatment: "EV 单药", intercurrentEvents: [], summary: "风险比" },
  endpointType: "time_to_event", fieldSources: {},
};

/**
 * A T0 study as the runtime leaves one after its runs: the definition, three
 * assumption cards, a scenario population, a patient set on that population, a
 * literature control, and three trial designs (two the engine can simulate and
 * one it cannot). Written through the store, which is what the gateway's
 * validated writes end in.
 * @param {string} label @param {Record<string, any>} [patch]
 */
async function seedT0(label, patch = {}) {
  const study = await store.createStudy({ userId: `u_${label}`, projectId: `prj_${label}`, name: `EV-201 ${label}`,
    question: "单臂 II 期能不能用外部对照，还是必须做随机？", dataTier: "T0", intendedUse: "design_support", ...patch });
  await store.saveDefinition({ studyId: study.id, userId: study.userId, ...definition });
  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "hazard_ratio", name: "风险比", pointValue: 0.7,
    sourceKind: "expert_set", valueSource: "assumed",
    distribution: { family: "lognormal", params: { meanlog: Math.log(0.7), sdlog: 0.15 }, range: { kind: "prediction", low: 0.52, high: 0.94 } } });
  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, unit: "月",
    sourceKind: "expert_set", valueSource: "assumed" });
  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "dropout_rate", name: "脱落率", pointValue: 0.1,
    sourceKind: "expert_set", valueSource: "assumed" });
  const population = await store.savePopulation({ studyId: study.id, userId: study.userId, name: "情景人群", kind: "scenario",
    definition: { n: 240, population: { variables: [
      { name: "age", family: "normal", mean: 63, sd: 9 },
      { name: "ldh", family: "lognormal", meanlog: 5.4, sdlog: 0.35 },
    ] } } });
  const patients = await store.savePatientSet({ studyId: study.id, userId: study.userId, populationId: population.id, name: "240 名虚拟患者",
    modelId: "reference-time-to-event", modelVersion: "1.0.0",
    scenario: { design: { nTreat: 160, nControl: 80 }, endpoint: { type: "time_to_event" },
      truth: { covariateEffects: { ldh: 0.001 } }, accrual: { kind: "uniform", duration: 12, followup: 12 } } });
  const comparator = await store.saveComparatorDesign({ studyId: study.id, userId: study.userId, route: "literature_control", estimand: "ATT",
    targetTrial: { population: "二线 NSCLC", treatment: "EV 单药" },
    configuration: { ...publishedArm(12, 200, 4242), provenance: { kind: "digitizer", tool: "WebPlotDigitizer", toolVersion: "4.6" },
      treatmentArm: publishedArm(17.14, 200, 2424), tau: 18, timeUnit: "months", comparability: [{ key: "time_period", state: "approximate", reason: "同期" }] } });
  const scenarioA = await store.saveTrialScenario({ studyId: study.id, userId: study.userId, label: "A 2:1 随机", design: "two_arm_fixed", endpointType: "time_to_event",
    configuration: { design: { nTreat: 120, nControl: 60, allocation: 2 / 3 }, analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 },
      accrual: { kind: "uniform", duration: 12, followup: 12 }, performance: ["power"], cost: 180 } });
  const scenarioB = await store.saveTrialScenario({ studyId: study.id, userId: study.userId, label: "B 1:1 加期中分析", design: "group_sequential", endpointType: "time_to_event",
    configuration: { design: { nTreat: 90, nControl: 90, allocation: 0.5, informationRates: [0.5, 1], spending: "obrien_fleming" },
      analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 }, accrual: { kind: "uniform", duration: 12, followup: 12 }, performance: ["power"] } });
  const scenarioC = await store.saveTrialScenario({ studyId: study.id, userId: study.userId, label: "C 单臂加外部对照", design: "single_arm_external", endpointType: "time_to_event",
    configuration: { design: { nTreat: 80 }, analysis: { alpha: 0.025, sided: 1 } } });
  const protocol = await store.saveProtocolVersion({ studyId: study.id, userId: study.userId, title: "EV-201 v1.0", criteria: [
    { kind: "inclusion", criterionType: "diagnosis", requirement: { op: "present", variable: "nsclc" }, sourceText: "经组织学确诊的非小细胞肺癌" }] });
  return { study: await store.studyById(study.id), population, patients, comparator, scenarioA, scenarioB, scenarioC, protocol };
}

test("the engine service is the real one: R, the receipt key and the table route", options, async () => {
  const health = await engine.health();
  assert.equal(health.ok, true);
  assert.deepEqual([...health.methods].sort(), Object.keys(VCR_ENGINE_METHODS).sort(), "the engine and the domain publish the same 24 methods");
  assert.equal(VCR_JOB_KINDS.length, 24);
  assert.match(health.rVersion, /^R 4\./);
});

test("AC-02 AC-35 the T0 chain runs on the real engine: population, patients, comparator and three designs, from one seeded study", options, async () => {
  const module = compose();
  await seedT0("chain").then(async (seed) => {
    const study = seed.study;
    await settle(module, study.id);

    const jobs = await store.jobs(study.id, 100);
    const byKind = (/** @type {string} */ kind) => jobs.filter((job) => job.kind === kind);
    for (const job of jobs) assert.equal(job.state, "succeeded", `${job.kind} ${job.id} ended ${job.state}: ${JSON.stringify(job.error)}`);
    const marks = await store.rows("SELECT key, state, detail FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND kind = 'job' ORDER BY key", [study.id]);
    assert.deepEqual([...new Set(jobs.map((job) => job.kind))].sort(),
      ["assurance", "design_analytic", "design_simulation", "generate_patients", "generate_population", "reconstruct_km", "rmst"],
      `every step the T0 study asks for was computed by a job the orchestrator built; marks: ${JSON.stringify(marks.map((mark) => [mark.key, mark.state, mark.detail.message ?? mark.detail.error ?? null]))}`);
    assert.equal(byKind("design_analytic").length, 2);
    assert.equal(byKind("design_simulation").length, 2);
    assert.equal(byKind("assurance").length, 1, "assurance for the fixed design whose effect card states a prediction distribution");

    // The whole chain on real parts: every result is one the domain validates, signed, and hashed by what it says.
    const executions = await store.rows("SELECT * FROM evimed_vcr.executions WHERE study_id = $1", [study.id]);
    assert.equal(executions.length, jobs.length);
    for (const execution of executions) {
      assert.equal(execution.receipt.signed, true, "the engine's receipt was checked against the key");
      assert.match(execution.output_hash, /^[a-f0-9]{64}$/);
      assert.equal(execution.environment.engineVersion, "1.0.0");
    }

    // No real person is in any of it: 0 at every step, never a made-up number.
    const results = await store.results(study.id);
    for (const result of results) {
      const real = result.counts.realPatients;
      assert.ok(real === 0 || real === null || real === undefined, `${result.kind} claims ${real} real patients`);
      for (const measure of result.measures) {
        assert.ok(VCR_VALUE_SOURCES.includes(measure.source), `${result.kind}/${measure.name} names its source`);
        if (measure.simulated) assert.equal(typeof measure.mcse, "number", "every simulated measure carries its Monte-Carlo error");
      }
    }

    // The steps are read from the data: four computed steps done, and the criteria step is done at T0.
    const current = await store.studyById(study.id);
    for (const step of ["definition", "evidence", "population", "patients", "comparator", "trial", "matching"]) {
      assert.equal(current.steps[step].status, "done", `${step} is ${current.steps[step].status}`);
    }

    // The population's table reached the patients job through the data plane, and the patients are exactly its members.
    const population = results.find((result) => result.kind === "population");
    assert.equal(population.counts.generatedRecords, 240);
    assert.ok(population.tables.find((table) => table.name === "population")?.location.startsWith("derived/"));
    const patientsJob = byKind("generate_patients")[0];
    const patientsRow = await store.one("SELECT inputs FROM evimed_vcr.jobs WHERE id = $1", [patientsJob.id]);
    const table = patientsRow.inputs.find((/** @type {any} */ input) => input.kind === "snapshot_file");
    assert.equal(table.valueSource, "synthetic");
    assert.match(table.hash, /^[a-f0-9]{64}$/);
    const patients = results.find((result) => result.kind === "patient_set");
    assert.equal(patients.counts.generatedRecords, 240);
    assert.equal(patients.counts.realPatients, 0);
    assert.equal(patients.diagnostics.mode, "population");
    assert.equal(patients.diagnostics.trajectories.series.length, 2, "the patients page has its survival curves");
    for (const series of patients.diagnostics.trajectories.series) {
      assert.ok(series.points.length >= 2 && series.points.length <= 200);
      assert.equal(series.source, "synthetic");
    }
    assert.ok(patients.diagnostics.sensitivity.rows.length >= 1);

    // The literature control: reconstruction, then RMST on the pseudo-patients, counted apart from real patients.
    const comparator = results.find((result) => result.kind === "comparator");
    assert.equal(comparator.subjectId, seed.comparator.id);
    assert.equal(comparator.counts.realPatients, 0);
    assert.equal(comparator.counts.reconstructedPseudoPatients, 400);
    assert.ok(comparator.measures.some((measure) => measure.name === "rmst_difference"));
    assert.ok(comparator.measures.some((measure) => measure.name.startsWith("median_survival")));
    assert.ok(comparator.diagnostics.stages.length === 2, "both stages of the route are on the one result");
    assert.equal(comparator.intendedUse, "design_support", "the weakest tier of the two stages (literature) decides, and design_support is what it carries");
    const stored = await store.latestComparatorDesign(study.id);
    assert.equal(stored.resultId, comparator.id);
    assert.equal(stored.conclusion, comparator.conclusion);

    // N designs are N current results, each under its own subject; the design the engine cannot simulate is said, not faked.
    const trial = results.filter((result) => result.kind === "trial_scenario");
    assert.deepEqual(trial.map((result) => result.subjectId).sort(), [seed.scenarioA.id, seed.scenarioB.id].sort());
    for (const result of trial) {
      assert.ok(result.measures.some((measure) => measure.name === "power"), "the simulation's power");
      assert.ok(result.measures.some((measure) => measure.name === "required_events"), "and the analytic calculation's events, on the same result");
      assert.equal(result.intendedUse, "exploratory", "a scenario-tier method carries exploratory, whatever the study asked for");
      assert.equal(result.useDowngrade.requested, "design_support");
    }
    const resultA = trial.find((result) => result.subjectId === seed.scenarioA.id);
    const resultB = trial.find((result) => result.subjectId === seed.scenarioB.id);
    // The fixed design has a closed form, so its simulation is checked against it and the page draws its power curve with the simulated point on it;
    // the group-sequential one has none, and says nothing rather than something made up.
    assert.ok(resultA.diagnostics.analyticCheck, "the fixed design's simulation carries its analytic check");
    assert.equal(resultA.diagnostics.analyticCheck.withinThreeMcse, true, "and it agrees with it");
    assert.deepEqual(resultA.diagnostics.powerCurve.series.map((/** @type {any} */ series) => series.key), ["analytic", "simulated"]);
    assert.equal(resultB.diagnostics.analyticCheck ?? null, null);
    assert.equal(resultB.diagnostics.powerCurve ?? null, null);
    assert.ok(resultB.measures.some((measure) => measure.name === "boundary_1"), "the analytic stage's group-sequential boundaries are on the result");
    assert.ok(resultA.measures.some((measure) => measure.name === "assurance"), "assurance from the effect card's own distribution");
    const powerA = resultA.measures.find((measure) => measure.name === "power");
    assert.ok(powerA.value > 0.3 && powerA.value < 1, `power ${powerA.value}`);
    const skipped = await store.one("SELECT * FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND key = $2", [study.id, `job:trial_scenario:${seed.scenarioC.id}@${seed.scenarioC.version}`]);
    assert.equal(skipped.state, "skipped");
    assert.equal(skipped.detail.reason, "design_not_supported");

    // The numbers the simulation used are the cards' numbers: the frozen scenario says so, and so does the row.
    const simulationRow = await store.one("SELECT scenario, checkpoint FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'design_simulation' AND checkpoint ->> 'subjectId' = $2", [study.id, seed.scenarioA.id]);
    assert.equal(simulationRow.scenario.truth.hazardRatio, 0.7);
    assert.equal(simulationRow.scenario.truth.controlMedian, 6);
    assert.equal(simulationRow.scenario.accrual.dropoutAnnual, 0.1);
    assert.ok(simulationRow.checkpoint.bound.some((/** @type {any} */ entry) => entry.key === "hazard_ratio" && entry.path === "truth.hazardRatio"));
    assert.equal(simulationRow.scenario.truth.null, undefined, "the control plane spells it truth.null when it says it at all, never isNull");
  });
});

test("the lineage the chain wrote is what a change would follow, and a changed assumption recomputes the object under its new version", options, async () => {
  const module = compose();
  const seed = await seedT0("recompute");
  const study = seed.study;
  await settle(module, study.id);
  const before = await store.results(study.id, "trial_scenario");
  assert.equal(before.length, 2);
  const oldA = before.find((result) => result.subjectId === seed.scenarioA.id);

  // 脱落率 10% -> 15%: the next version of the card is written and the change is raised.
  const card = await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "dropout_rate", name: "脱落率", pointValue: 0.15,
    sourceKind: "expert_set", valueSource: "assumed" });
  assert.equal(card.version, 2);
  const plan = await module.orchestrator.recomputeAfterChange({ studyId: study.id, changed: ["assumption:dropout_rate@2"], reason: "assumption_changed" });
  assert.ok(plan.marked >= 2, "the designs and their results are marked");
  assert.ok((await store.staleMarks(study.id)).some((mark) => mark.node === `trial_scenario:${seed.scenarioA.id}@${seed.scenarioA.version}`));
  // The stale result keeps its numbers until its successor lands.
  assert.equal((await store.result(study.id, oldA.id)).measures.find((measure) => measure.name === "power").value,
    oldA.measures.find((measure) => measure.name === "power").value);

  await settle(module, study.id);
  const after = await store.results(study.id, "trial_scenario");
  assert.equal(after.length, 2, "still one current result per design");
  const newA = after.find((result) => result.subjectId === seed.scenarioA.id);
  assert.notEqual(newA.id, oldA.id, "a new result");
  // A design's stages land one after the other, each a version that supersedes the last: the old result leads by its chain to the current one.
  let tip = await store.result(study.id, oldA.id);
  assert.ok(tip.supersededBy, "the old one is superseded, not deleted");
  for (let hops = 0; tip.supersededBy && hops < 20; hops += 1) tip = await store.result(study.id, tip.supersededBy);
  assert.equal(tip.id, newA.id);
  const rerun = await store.rows(`SELECT scenario, idempotency_key FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'design_simulation'
    AND checkpoint ->> 'subjectId' = $2 ORDER BY created_at`, [study.id, seed.scenarioA.id]);
  assert.equal(rerun.length, 2, "a second job, not the first one returned again");
  assert.notEqual(rerun[0].idempotency_key, rerun[1].idempotency_key);
  assert.equal(rerun[0].scenario.accrual.dropoutAnnual, 0.1);
  assert.equal(rerun[1].scenario.accrual.dropoutAnnual, 0.15, "the new card version is the number the recomputation used");
  assert.deepEqual(await store.staleMarks(study.id), [], "every mark is cleared once the successors have landed");
  assert.equal((await store.studyById(study.id)).steps.trial.status, "done");
});

test("T1 the snapshot a study names reaches the engine as tables it can open, and a weighting runs on observed rows", options, async () => {
  // A small observed cohort in the scratch data plane: the external-control candidates and the trial arm, one row per person.
  const n = 240;
  const arm = (/** @type {number} */ i) => (i < 80 ? 1 : 0);
  let state = 12345;
  const uniform = () => { state = (state * 1103515245 + 12345) % 2147483648; return (state + 1) / 2147483649; };
  const gaussian = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const subject = ["USUBJID,arm,x"];
  const events = ["USUBJID,PARAMCD,AVAL,CNSR"];
  for (let i = 0; i < n; i += 1) {
    const id = `S${String(i).padStart(4, "0")}`;
    const x = Math.round((gaussian() + (arm(i) ? 0.25 : 0)) * 1000) / 1000;
    const time = -Math.log(uniform()) / (Math.log(2) / 12 * Math.exp(0.1 * x) * (arm(i) ? 0.8 : 1));
    const cut = time > 30;
    subject.push(`${id},${arm(i)},${x}`);
    events.push(`${id},OS,${Math.round(Math.min(time, 30) * 1000) / 1000},${cut ? 1 : 0}`);
  }
  const directory = path.join(scratch, "data-plane", "snapshots", "snp_t1");
  await fs.mkdir(directory, { recursive: true });
  const sha = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");
  await fs.writeFile(path.join(directory, "subject.csv"), subject.join("\n"));
  await fs.writeFile(path.join(directory, "events.csv"), events.join("\n"));
  const tables = [
    { kind: "analysis_table", id: "snp_t1:subject", shape: "subject", location: "snapshots/snp_t1/subject.csv", hash: sha(subject.join("\n")), valueSource: "observed" },
    { kind: "analysis_table", id: "snp_t1:events", shape: "events", location: "snapshots/snp_t1/events.csv", hash: sha(events.join("\n")), valueSource: "observed" },
  ];
  /** @type {any[]} */
  const asked = [];
  // The data plane's resolver, faithful to the contract (§3.2): the study's own snapshot, judged for the acting principal, as tables with a location and a hash.
  const dataPlane = { async resolveEngineInputs(/** @type {any} */ request) {
    asked.push(request);
    if (request.snapshotId !== "snp_t1") throw Object.assign(new Error("Snapshot not found."), { status: 404, code: "vcr_snapshot_not_found" });
    return tables;
  } };
  const module = compose({ dataPlane });
  const study = await store.createStudy({ userId: "u_t1", projectId: "prj_t1", name: "EV-201 T1", question: "外部对照", dataTier: "T2", intendedUse: "design_support" });
  await store.saveDefinition({ studyId: study.id, userId: study.userId, ...definition });
  const comparator = await store.saveComparatorDesign({ studyId: study.id, userId: study.userId, route: "external_control", estimand: "ATT",
    configuration: { covariates: ["x"], tau: 12, timeUnit: "months", parameterCode: "OS", snapshotId: "snp_t1" } });
  await settle(module, study.id);

  const [job] = await store.jobs(study.id);
  assert.equal(job.kind, "weight_comparator");
  assert.equal(job.state, "succeeded", JSON.stringify(job.error));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].studyId, study.id);
  assert.equal(asked[0].principal, study.userId, "access is judged for the acting principal, the study's owner");
  assert.equal(asked[0].purpose, "vcr");
  assert.deepEqual(asked[0].fields, ["x"]);
  const result = (await store.results(study.id, "comparator"))[0];
  assert.equal(result.subjectId, comparator.id);
  assert.equal(result.counts.realPatients, n, "observed rows are real patients");
  assert.ok(result.counts.effectiveSampleSize <= result.counts.realPatients, "the effective sample size never exceeds the people it weights");
  assert.ok(result.measures.some((measure) => measure.name === "rmst_difference" && measure.interval.kind === "confidence"));
  assert.equal(result.intendedUse, "design_support", "a data-tier method carries design_support for a study that asked for it");
  assert.deepEqual(result.diagnostics.curves.map((/** @type {any} */ series) => series.key), ["treated", "control", "control_weighted"]);
  assert.equal(result.diagnostics.curves[0].source, "observed");
  assert.ok(result.diagnostics.balance.length === 1);
});

test("T1 through the real data plane: a partner's file is registered, mapped and frozen, the orchestrator names the snapshot, and the real engine weights the rows the plane resolved", options, async () => {
  // Nothing between the file and the result is a double: the composed module's own plane (grants, seal, pseudonymised subject key, content-addressed views), the queue, the service and R.
  const OWNER = "t1real-owner";
  const plane = path.join(scratch, "data-plane");
  const vcr = composeVcr({ config: { vcrEnabled: true, vcrDataPlaneDir: plane, vcrAudience: "all" }, productDatabase: database });
  await vcr.store.ready();
  const study = await store.createStudy({ userId: OWNER, projectId: "prj_t1real", name: "外部对照（真实数据平面）", question: "外部对照", dataTier: "T2", intendedUse: "exploratory" });
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "合作方外部对照", ownerParty: "合作方医院", allowedUses: ["vcr"], valueSource: "observed" });
  for (const [name, body] of /** @type {Array<[string, string]>} */ ([["cohort.csv", cohortCsv()], ["visits.csv", visitsCsv()]])) {
    await vcr.dataPlane.storeUpload({ actor: OWNER, studyId: study.id, sourceId: source.id, name, stream: streamOf(body), declaredLength: Buffer.byteLength(body) });
  }
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, columns: FIELD_MAP });
  assert.deepEqual([proposed.entryIssues, proposed.mapIssues], [[], []]);
  await vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, hash: proposed.hash });
  const { snapshot } = await vcr.dataPlane.freezeSnapshot({ userId: OWNER, studyId: study.id, sourceId: source.id });

  await store.saveDefinition({ studyId: study.id, userId: OWNER, ...definition });
  const comparator = await store.saveComparatorDesign({ studyId: study.id, userId: OWNER, route: "external_control", estimand: "ATT",
    configuration: { covariates: ["age", "ecog"], treatmentColumn: "arm", tau: 12, timeUnit: "months", parameterCode: "OS", snapshotId: snapshot.id } });
  const module = compose({ dataPlane: vcr.dataPlane });
  await settle(module, study.id);

  const jobs = await store.jobs(study.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "weight_comparator");
  assert.equal(jobs[0].state, "succeeded", JSON.stringify(jobs[0].error));
  const inputs = (await store.rows("SELECT inputs FROM evimed_vcr.jobs WHERE id = $1", [jobs[0].id]))[0].inputs;
  assert.ok(inputs.some((/** @type {any} */ input) => input.shape === "subject"), "the plane handed over the subject table");
  const tables = inputs.filter((/** @type {any} */ input) => input.location);
  assert.ok(tables.length >= 1 && tables.every((/** @type {any} */ input) => !path.isAbsolute(input.location) && input.valueSource === "observed" && /^[a-f0-9]{64}$/.test(input.hash)));
  const [result] = await store.results(study.id, "comparator");
  assert.equal(result.subjectId, comparator.id);
  assert.equal(result.counts.realPatients, COHORT_SIZE, "the rows the engine weighted are the frozen snapshot's own");
  assert.ok(["estimable", "limited", "not_estimable"].includes(result.conclusion), result.conclusion);
});

test("every job kind the domain pairs with a method is built as the schema that method reads (no orchestrator scenario is refused by name)", options, async () => {
  // The orchestrator's builders, held to the domain's own validator on a full set of objects: this is the schema half of the chain, without running R.
  const seed = await seedT0("schemas");
  const context = { study: seed.study, definition: await store.latestDefinition(seed.study.id), assumptions: await store.assumptions(seed.study.id),
    populations: [seed.population], scenarios: [seed.scenarioA, seed.scenarioB], grid: null, analytic: null };
  /** @type {Record<string, string>} */
  const built = {};
  for (const [kind, row] of /** @type {Array<[string, any]>} */ ([["population", seed.population], ["trial_scenario", seed.scenarioA], ["trial_scenario", seed.scenarioB]])) {
    const plan = vcrBuildStages({ kind, row }, context);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    for (const stage of /** @type {any} */ (plan).stages) {
      built[stage.jobKind] = VCR_JOB_METHODS[/** @type {keyof typeof VCR_JOB_METHODS} */ (stage.jobKind)];
      const issues = validateEngineJob({ jobId: "job_x", studyId: seed.study.id, kind: stage.jobKind, method: built[stage.jobKind],
        methodVersion: "1.0.0", protocolVersion: 1, seed: 1, cpuSecondsLimit: 60, inputs: [], scenario: stage.scenario });
      assert.deepEqual(issues, [], `${stage.jobKind}: ${JSON.stringify(issues)}`);
    }
  }
  assert.deepEqual(Object.keys(built).sort(), ["design_analytic", "design_simulation", "generate_population"]);
  // A design the engine does not implement is said in a sentence, and no job is built for it.
  const single = vcrBuildStages({ kind: "trial_scenario", row: seed.scenarioC }, context);
  assert.equal(single.ok, false);
  assert.equal(/** @type {any} */ (single).unavailable.reason, "design_not_supported");
  // A key the engine does not read is refused by its path, not ignored (the `dropoutRate` defect).
  const typo = vcrBuildStages({ kind: "trial_scenario", row: { ...seed.scenarioA, configuration: { ...seed.scenarioA.configuration, accrual: { kind: "uniform", duration: 12, followup: 12, dropoutRate: 0.1 } } } }, context);
  assert.equal(typo.ok, false);
  assert.deepEqual(/** @type {any} */ (typo).refused.paths, ["accrual.dropoutRate"]);
});
