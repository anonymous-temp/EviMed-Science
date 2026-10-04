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
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { VCR_ENGINE_METHODS, VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_VALUE_SOURCES, validateEngineJob } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createVcrEngineClient, vcrComputedOutputHash } from "../src/vcrEngineClient.mjs";
import { VcrJobs, vcrRecordedResultHash } from "../src/vcrJobs.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { VcrOrchestrator, vcrBuildStages } from "../src/vcrOrchestrator.mjs";
import { VcrService, seedVcrCatalogue } from "../src/vcrService.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createVcrWorkerLoops } from "../src/vcrWorker.mjs";
import { createVcrCurveEvidence } from "../src/vcrCurveEvidence.mjs";
import { VcrEvidenceStore } from "../src/vcrEvidenceStore.mjs";
import { VcrDataStore } from "../src/vcrDataStore.mjs";
import { VcrAccess } from "../src/vcrAccess.mjs";
import { COHORT_SIZE, FIELD_MAP, cohortCsv, streamOf, visitsCsv } from "./helpers/vcrIntakeData.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(HERE, "../../../../项目代码/vcr-engine");
// The R library is the machine's to name (`scripts/vcr/r-library.sh`); there is no path baked in here.
const R_LIBS = process.env.VCR_R_LIBS ?? "";
// CI runs these with `VCR_ENGINE_TESTS=required`: a box without R, without its library or without uvicorn
// is then a red run with the reason, never a green one that proved nothing.
const ENGINE_REQUIRED = process.env.VCR_ENGINE_TESTS === "required";

/** What this machine lacks of what the real engine needs: `{ code, message }`, or null. */
function engineProblem() {
  if (spawnSync("Rscript", ["--version"]).status !== 0) return { code: "rscript", message: "Rscript is not installed (or not on PATH)" };
  if (!R_LIBS) return { code: "library_unset", message: "VCR_R_LIBS is not set: it names the R library the engine runs on (scripts/vcr/r-library.sh installs it)" };
  if (!existsSync(R_LIBS)) return { code: "library_missing", message: `VCR_R_LIBS names a directory that does not exist: ${R_LIBS}` };
  if (spawnSync("python3", ["-c", "import uvicorn"]).status !== 0) return { code: "uvicorn", message: "python3 cannot import uvicorn (the engine service's server; see requirements.txt in 项目代码/vcr-engine)" };
  return null;
}
const problem = engineProblem();

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
// Not required and no R library named: skipped with the reason. Required, or any other gap: `before` fails with it.
const options = { skip: (!databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured")
  || (!ENGINE_REQUIRED && problem?.code === "library_unset" && `the real engine is not available here: ${problem.message}`), timeout: 900_000 };

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
/** @type {ReturnType<typeof createVcrCurveEvidence>} */
let curves;
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
  // A skipped engine test would be a green run that proves nothing: with the library named (or the run required),
  // what the machine lacks is a failure that says what.
  assert.equal(problem, null, `${ENGINE_REQUIRED ? "VCR_ENGINE_TESTS=required: " : ""}this file is the proof the control plane and the real engine agree, and this machine cannot run the engine — ${problem?.message}`);

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
  // A controlled raster fixture binds the authenticated input to actual source
  // bytes. The synthetic curve below checks numeric reconstruction, not the
  // accuracy of points selected from a published image or a digitizer.
  await fs.writeFile(path.join(scratch, "controlled-curve-source.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L1sAAAAASUVORK5CYII=", "base64"));
  curves = createVcrCurveEvidence({ store: new VcrEvidenceStore({ database }), studyStore: store,
    access: new VcrAccess({ store: new VcrDataStore({ database }) }), resolveProject: async () => ({ workspaceDir: scratch }) });
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
  jobs.curveVerifier = curves.curveVerifier;
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
 * A controlled survival-curve fixture: the Kaplan-Meier estimate of `n` simulated
 * patients (exponential with the given median, administratively censored at 24
 * months) read off every quarter of a month, with a generated risk table,
 * event count and median. Built from a simulated
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
  // The evidence run's own product — one verified extraction and the card that cites it — beside the two settings the runs state
  // by themselves: the evidence step reads done from the first, and from none of the others.
  const extracted = await new VcrEvidenceStore({ database }).appendEvidenceItems({ userId: study.userId, studyId: study.id, items: [{
    parameter: "median_time", arm: "SoC", armRole: "control", endpointKey: "pfs-blinded", value: 6, unit: "月", valueSource: "extracted",
    quote: "Median progression-free survival was 6 months.", locator: { verification: "verified", field: "outcomeMeasures[0]" } }] });
  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, unit: "月",
    sourceKind: "external_evidence", valueSource: "extracted", poolingMethod: "single_study", evidenceIds: extracted.verifiedIds,
    pooling: { k: 1, note: "单项研究直接取值，没有预测区间" } });
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
  const curve = await curves.recordSelection({ studyId: study.id, principal: study.userId,
    imageArtifactId: "controlled-curve-source.png", points: { ...publishedArm(12, 200, 4242), treatmentArm: publishedArm(17.14, 200, 2424) } });
  const comparator = await store.saveComparatorDesign({ studyId: study.id, userId: study.userId, route: "literature_control", estimand: "ATT",
    targetTrial: { population: "二线 NSCLC", treatment: "EV 单药" },
    configuration: { provenance: { receiptId: curve.id }, tau: 18, timeUnit: "months",
      comparability: [{ key: "time_period", state: "approximate", reason: "同期" }] } });
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
  return { study: await store.studyById(study.id), population, patients, comparator, curve, scenarioA, scenarioB, scenarioC, protocol };
}

test("the engine service is the real one: R, the receipt key and the table route", options, async () => {
  const health = await engine.health();
  assert.equal(health.ok, true);
  assert.deepEqual([...health.methods].sort(), Object.keys(VCR_ENGINE_METHODS).sort(), "the engine and the domain publish the same methods");
  assert.equal(VCR_JOB_KINDS.length, Object.keys(VCR_ENGINE_METHODS).length, "one job kind per method");
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
    const reconstruction = await store.one("SELECT scenario, inputs, checkpoint FROM evimed_vcr.jobs WHERE id = $1", [byKind("reconstruct_km")[0].id]);
    assert.deepEqual(reconstruction.scenario.provenance, { kind: "human_click", tool: "EviMed authenticated curve input", toolVersion: "1" });
    assert.equal(reconstruction.checkpoint.curveReceiptId, seed.curve.id);
    assert.equal(reconstruction.checkpoint.curvePrincipal, study.userId);
    assert.equal(reconstruction.checkpoint.curvePointsHash, seed.curve.pointsHash);
    assert.equal(reconstruction.checkpoint.curveImageHash, seed.curve.image.sha256);
    assert.ok(reconstruction.inputs.some((/** @type {any} */ input) => input.id === `evidence:${seed.curve.id}@1`), "the source receipt is an input of the engine job");

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
    // C3-03: what the engine's next job opens is readable by the engine's own user, which is not the control plane's — the
    // filed tables and every directory down to them are world-readable (their rows are generated, never a real person's),
    // where a patient-level file is owner-only. Read off the disk, not off what the code says it did.
    const plane = path.join(scratch, "data-plane");
    for (const listed of [population, results.find((result) => result.kind === "comparator")]) {
      for (const table of listed?.tables ?? []) {
        if (!String(table.location ?? "").startsWith("derived/")) continue;
        assert.equal((await fs.stat(path.join(plane, table.location))).mode & 0o777, 0o644, `${table.location} is readable by the engine's user`);
        const parts = table.location.split("/").slice(0, -1);
        for (let depth = 1; depth <= parts.length; depth += 1) {
          assert.equal((await fs.stat(path.join(plane, ...parts.slice(0, depth)))).mode & 0o777, 0o755, `${parts.slice(0, depth).join("/")} can be walked by the engine's user`);
        }
      }
    }
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

// ---------------------------------------------------------------------------
// The verification review's findings, on the real engine
// ---------------------------------------------------------------------------

/**
 * A T0 study with a definition and nothing else: what a test furnishes itself.
 * @param {string} label @param {Record<string, any>} [patch]
 */
async function bareStudy(label, patch = {}) {
  const study = await store.createStudy({ userId: `u_${label}`, projectId: `prj_${label}`, name: `验证 ${label}`, question: "设计怎么选", dataTier: "T0",
    intendedUse: "design_support", ...patch });
  await store.saveDefinition({ studyId: study.id, userId: study.userId, ...definition, endpointType: patch.endpointType ?? "time_to_event" });
  return study;
}

/** The page's own service over the same store and queue, read as the study's owner. @param {ReturnType<typeof compose>} module */
function pages(module) {
  return new VcrService({ store, config: module.config, jobs: module.jobs, now: () => new Date() });
}

/** An independent finite-binomial reference; no engine probabilities are reused.
 * @param {number} n @param {number} p */
function binomialMass(n, p) {
  const values = [Math.pow(1 - p, n)];
  for (let x = 1; x <= n; x += 1) values.push(values[x - 1] * (n - x + 1) / x * p / (1 - p));
  return values;
}

/** Enumerate both stages of the frozen rule, including the first-stage stop.
 * @param {{n1:number,n:number,r1:number,r:number}} boundary @param {number} p */
function simonReference({ n1, n, r1, r }, p) {
  const first = binomialMass(n1, p);
  const second = binomialMass(n - n1, p);
  let rejection = 0;
  let earlyStop = 0;
  for (let x1 = 0; x1 <= n1; x1 += 1) {
    if (x1 <= r1) earlyStop += first[x1];
    else for (let x2 = 0; x2 <= n - n1; x2 += 1) if (x1 + x2 > r) rejection += first[x1] * second[x2];
  }
  return { rejection, earlyStop, expectedN: n1 * earlyStop + n * (1 - earlyStop) };
}

test("C2-5 C2-6 the assurance stage of a continuous and a binary design runs on the scale the cards state, and a card the method does not read is dropped in silence — not refused as the run's own field", options, async () => {
  const module = compose();
  const study = await bareStudy("scales", { endpointType: "continuous" });
  const card = (/** @type {Record<string, any>} */ fields) => store.saveAssumption({ studyId: study.id, userId: study.userId, sourceKind: "expert_set", valueSource: "assumed", ...fields });
  await card({ key: "mean_difference", name: "均值差", pointValue: 4, unit: "mmHg", distribution: { family: "normal", params: { mean: 4, sd: 1.2 }, range: { kind: "prediction", low: 1.6, high: 6.4 } } });
  await card({ key: "outcome_sd", name: "结局标准差", pointValue: 12, unit: "mmHg" });
  await card({ key: "risk_difference", name: "率差", pointValue: 0.15, distribution: { family: "normal", params: { mean: 0.15, sd: 0.05 }, range: { kind: "prediction", low: 0.05, high: 0.25 } } });
  await card({ key: "control_event_rate", name: "对照应答率", pointValue: 0.3 });
  const continuous = await store.saveTrialScenario({ studyId: study.id, userId: study.userId, label: "连续 1:1", design: "two_arm_fixed", endpointType: "continuous",
    assumptionIds: ["mean_difference", "outcome_sd"],
    configuration: { design: { nTreat: 150, nControl: 150, allocation: 0.5 }, analysis: { method: "ttest", alpha: 0.025, sided: 1, power: 0.9 }, performance: ["power"] } });
  const binary = await store.saveTrialScenario({ studyId: study.id, userId: study.userId, label: "二分类 1:1", design: "two_arm_fixed", endpointType: "binary",
    assumptionIds: ["control_event_rate", "risk_difference"],
    configuration: { design: { nTreat: 200, nControl: 200, allocation: 0.5 }, analysis: { method: "risk_difference", alpha: 0.025, sided: 1, power: 0.9 }, performance: ["power"] } });
  // Simon states its own rates: the unrelated 「对照应答率」 card binds no
  // parameter. Its analytic selection precedes two simulations of that exact
  // boundary, under the null and alternative response laws.
  const simon = await store.saveTrialScenario({ studyId: study.id, userId: study.userId, label: "Simon 两阶段", design: "simon_two_stage", endpointType: "binary",
    assumptionIds: ["control_event_rate"],
    configuration: { design: { maxN: 60 }, truth: { nullRate: 0.2, alternativeRate: 0.4 }, analysis: { alpha: 0.05, power: 0.8 },
      performance: ["power", "type_one_error", "expected_sample_size"] } });

  await settle(module, study.id);
  const jobs = await store.jobs(study.id, 100);
  for (const job of jobs) assert.equal(job.state, "succeeded", `${job.kind} ${job.id} ended ${job.state}: ${JSON.stringify(job.error)}`);
  assert.deepEqual(jobs.map((job) => job.kind).sort(), ["assurance", "assurance", "design_analytic", "design_analytic", "design_analytic",
    "design_simulation", "design_simulation", "design_simulation", "design_simulation"],
    "both fixed designs have their assurance, and Simon has one analytic selection and both operating-characteristic laws");
  const marks = await store.rows("SELECT key, state, detail FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND kind = 'job'", [study.id]);
  assert.ok(marks.every((mark) => mark.state === "done"), `every mark is done: ${JSON.stringify(marks.map((mark) => [mark.key, mark.state, mark.detail.message ?? mark.detail.error]))}`);

  const frozen = (/** @type {string} */ subject, /** @type {string} */ kind) => store.one(
    "SELECT id, scenario, scenario_hash, method_version, checkpoint FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = $2 AND checkpoint ->> 'subjectId' = $3", [study.id, kind, subject]);
  // The continuous assurance integrates on the outcome's own standard deviation (12), not the schema's default of 1.
  const continuousAssurance = await frozen(continuous.id, "assurance");
  assert.equal(continuousAssurance.scenario.truth.sd, 12);
  assert.deepEqual(continuousAssurance.scenario.designPrior, { mean: 4, sd: 1.2, kind: "normal", basis: "prediction" });
  assert.deepEqual(continuousAssurance.checkpoint.bound.map((/** @type {any} */ entry) => entry.path), ["truth.sd"],
    "only what the job actually used is said to have been bound: the effect's point value is not an input of this integral");
  const binaryAssurance = await frozen(binary.id, "assurance");
  assert.equal(binaryAssurance.scenario.truth.controlRate, 0.3);
  assert.equal(binaryAssurance.scenario.design.nTreat, 200);
  // Simon's job carries no rate the card 「对照应答率」 was bound to, and says it bound nothing.
  const simonAnalytic = await frozen(simon.id, "design_analytic");
  assert.deepEqual(simonAnalytic.scenario.truth, { nullRate: 0.2, alternativeRate: 0.4 });
  assert.deepEqual(simonAnalytic.checkpoint.bound, []);

  const results = await store.results(study.id, "trial_scenario");
  for (const subject of [continuous.id, binary.id]) {
    const result = results.find((row) => row.subjectId === subject);
    const assurance = result?.measures.find((/** @type {any} */ measure) => measure.name === "assurance");
    assert.ok(assurance && assurance.value > 0.3 && assurance.value < 1, `${subject} assurance ${assurance?.value}`);
  }
  const analytic = await module.jobs.resultOf(study.id, simonAnalytic.id);
  assert.ok(analytic, "the selected design is an immutable result of the analytic job");
  const selected = analytic.diagnostics.simon.optimal;
  const boundary = Object.fromEntries(["n1", "n", "r1", "r"].map((key) => [key, selected[key]]));
  const expectedSource = { resultId: analytic.id, resultVersion: analytic.version, executionId: analytic.executionId,
    jobId: simonAnalytic.id, methodVersion: simonAnalytic.method_version, scenarioHash: simonAnalytic.scenario_hash, selection: "optimal" };
  const simulations = await store.rows(`SELECT id, scenario, inputs, checkpoint, replicates, method_version
    FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'design_simulation' AND checkpoint ->> 'subjectId' = $2`, [study.id, simon.id]);
  assert.equal(simulations.length, 2);
  const simonResult = results.find((row) => row.subjectId === simon.id);
  assert.ok(simonResult, "all three stages have a current stored result");
  const stages = simonResult.diagnostics.stageResults;
  assert.deepEqual(Object.keys(stages).sort(), ["analytic", "simulation", "simulation_null"], "neither simulated law overwrites the other's stage record");
  const nullReference = simonReference(/** @type {{n1:number,n:number,r1:number,r:number}} */ (boundary), 0.2);
  const alternativeReference = simonReference(/** @type {{n1:number,n:number,r1:number,r:number}} */ (boundary), 0.4);
  assert.ok(Math.abs(selected.alpha - nullReference.rejection) < 1e-12);
  assert.ok(Math.abs(selected.power - alternativeReference.rejection) < 1e-12);
  assert.ok(Math.abs(selected.PET0 - nullReference.earlyStop) < 1e-12);
  assert.ok(Math.abs(selected.EN0 - nullReference.expectedN) < 1e-12);
  for (const simulation of simulations) {
    const nullLaw = simulation.scenario.truth.responseRate === 0.2;
    assert.ok(nullLaw || simulation.scenario.truth.responseRate === 0.4);
    const stageName = nullLaw ? "simulation_null" : "simulation";
    const reference = nullLaw ? nullReference : alternativeReference;
    const retained = stages[stageName];
    assert.deepEqual(simulation.scenario.design, { kind: "simon_two_stage", ...boundary }, "both laws run the exact selected boundary");
    assert.deepEqual(simulation.checkpoint.analyticSource, expectedSource, "the immutable analytic job/result/version/hash are the selection's source");
    const selectionInput = simulation.inputs.find((/** @type {any} */ input) => input.kind === "evidence" && input.id === `result:${analytic.id}@${analytic.version}`);
    assert.ok(selectionInput, "the selected result is an engine input");
    assert.deepEqual(selectionInput.value, expectedSource);
    assert.equal(simulation.method_version, VCR_ENGINE_METHODS["design.simulate"].version);
    assert.equal(simulation.replicates, nullLaw ? 20_000 : 5_000, "the law, rather than a caller label, sets the replicate floor");
    assert.equal(retained.jobId, simulation.id);
    assert.equal(retained.stale, false);
    assert.equal(retained.counts.realPatients, 0);
    assert.equal(retained.diagnostics.replicatesCompleted, simulation.replicates);
    const raw = await engine.result(simulation.checkpoint.engineJobId);
    assert.equal(raw.signed, true);
    assert.equal(raw.refused, false);
    assert.deepEqual(retained.measures, raw.result.measures, "the stored law's measures and MCSE are exactly the verified engine output");
    assert.deepEqual(retained.counts, raw.result.counts);
    assert.deepEqual(retained.diagnostics, raw.result.diagnostics, "each law retains its own diagnostics rather than the last stage's");
    const expected = { [nullLaw ? "type_one_error" : "power"]: reference.rejection,
      early_stop_probability: reference.earlyStop, expected_sample_size: reference.expectedN };
    for (const [name, value] of Object.entries(expected)) {
      const measured = retained.measures.find((/** @type {any} */ measure) => measure.name === name);
      assert.ok(measured?.simulated === true && typeof measured.mcse === "number" && Number.isFinite(measured.mcse), `${stageName} ${name} carries its own Monte-Carlo error`);
      assert.ok(Math.abs(measured.value - value) <= 3 * measured.mcse + 1e-12, `${stageName} ${name}: ${measured.value} vs independent exact ${value} (MCSE ${measured.mcse})`);
    }
    assert.equal(retained.measures.some((/** @type {any} */ measure) => measure.name === "coverage"), false, "unimplemented sequentially adjusted coverage is not invented");
    const execution = await store.one("SELECT output_hash, receipt FROM evimed_vcr.executions WHERE job_id = $1", [simulation.id]);
    assert.equal(execution.receipt.stageVerified, true);
    assert.equal(vcrComputedOutputHash(execution.receipt.stageOutput), execution.output_hash, "the receipt hashes the raw stage rather than the multi-stage aggregate");
    const recorded = await module.jobs.resultOf(study.id, simulation.id);
    assert.equal(execution.receipt.recordedResultHash, vcrRecordedResultHash(recorded), "the aggregate has a separate stored integrity proof");
  }
  const measureValue = (/** @type {string} */ stageName, /** @type {string} */ name) => stages[stageName].measures.find((/** @type {any} */ measure) => measure.name === name).value;
  assert.ok(measureValue("simulation_null", "early_stop_probability") > measureValue("simulation", "early_stop_probability"));
  assert.ok(measureValue("simulation_null", "expected_sample_size") < measureValue("simulation", "expected_sample_size"));
});

test("C2-6 a key the run itself wrote that no stage reads is still refused by its path — only what the platform injected is dropped in silence", options, async () => {
  const seed = await seedT0("typo");
  const context = { study: seed.study, definition: await store.latestDefinition(seed.study.id), assumptions: await store.assumptions(seed.study.id),
    populations: [seed.population], scenarios: [seed.scenarioA], grid: null, analytic: null };
  // The run's own `truth.controlRate` on a time-to-event design is a key nothing reads, and the run wrote it.
  const stated = vcrBuildStages({ kind: "trial_scenario", row: { ...seed.scenarioA, configuration: { ...seed.scenarioA.configuration, truth: { controlRate: 0.3 } } } }, context);
  assert.equal(stated.ok, false);
  assert.deepEqual(/** @type {any} */ (stated).refused.paths, ["truth.controlRate"]);
  // The same card, injected into a plan that only has a stage which cannot read it, is not the run's mistake.
  const injected = vcrBuildStages({ kind: "trial_scenario", row: { ...seed.scenarioC, design: "simon_two_stage", endpointType: "binary", assumptionIds: ["control_event_rate"],
    configuration: { design: { maxN: 60 }, truth: { nullRate: 0.2, alternativeRate: 0.4 }, analysis: { alpha: 0.05, power: 0.8 } } } },
  { ...context, assumptions: [{ key: "control_event_rate", version: 1, pointValue: 0.3 }] });
  assert.equal(injected.ok, true, JSON.stringify(injected));
});

test("C2-3 a design grid the engine computed is drawn as the engine numbered it: two designs by two truths are a two-by-two picture, each cell in its own place", options, async () => {
  const module = compose();
  const study = await bareStudy("grid", { endpointType: "continuous" });
  const grid = await store.saveDesignGrid({ studyId: study.id, userId: study.userId,
    dimensions: { designs: [{ label: "每组 60", kind: "two_arm_fixed", nTreat: 60, nControl: 60 }, { label: "每组 120", kind: "two_arm_fixed", nTreat: 120, nControl: 120 }],
      base: { endpoint: { type: "continuous" }, analysis: { method: "ttest", alpha: 0.025, sided: 1 }, performance: ["power"] } },
    truthScenarios: [{ label: "效应 0.3", effect: 0.3, sd: 1 }, { label: "效应 0.6", effect: 0.6, sd: 1 }] });
  await settle(module, study.id);
  const [job] = await store.jobs(study.id, 10);
  assert.equal(job.kind, "design_grid");
  assert.equal(job.state, "succeeded", JSON.stringify(job.error));
  const stored = await store.latestDesignGrid(study.id);
  assert.equal(stored?.id, grid.id);
  assert.deepEqual((stored?.cells ?? []).map((/** @type {any} */ cell) => [cell.designIndex, cell.truthIndex]).sort(), [[1, 1], [1, 2], [2, 1], [2, 2]],
    "the engine numbers a grid from 1, and the cells are kept as it numbered them");
  const powerAt = (/** @type {number} */ design, /** @type {number} */ truth) => stored?.cells
    .find((/** @type {any} */ cell) => cell.designIndex === design && cell.truthIndex === truth).measures.find((/** @type {any} */ measure) => measure.name === "power").value;
  assert.ok(powerAt(2, 1) > powerAt(1, 1) && powerAt(2, 2) > powerAt(1, 2), "more patients, more power — under either truth");
  assert.ok(powerAt(1, 2) > powerAt(1, 1) && powerAt(2, 2) > powerAt(2, 1), "a bigger effect, more power — under either design");

  const page = await pages(module).tab({ id: study.userId }, study.id, "trial");
  assert.equal(page.grid?.rows.length, 2, "two designs are two rows, not three with an empty first");
  assert.equal(page.grid?.columns.length, 2);
  assert.deepEqual(page.grid?.rows.map((/** @type {any} */ row) => row.header), ["每组 60", "每组 120"]);
  assert.deepEqual(page.grid?.columns.map((/** @type {any} */ column) => column.header), ["效应 0.3", "效应 0.6"]);
  for (const [row, design] of [[0, 1], [1, 2]]) {
    for (const [column, truth] of [[0, 1], [1, 2]]) {
      const cell = page.grid?.rows[row].cells[column];
      assert.equal(cell.value, powerAt(design, truth), `row ${row} column ${column} is the engine's cell (${design}, ${truth})`);
      assert.match(cell.text, /^\d+(\.\d)?%$/);
    }
  }
});

test("C2-4 while a change is recomputed the page says its numbers are old; an edit that drops the prior drops the assurance it made; an edit that keeps the value keeps the prior", options, async () => {
  const module = compose({ config: configFor({ vcrMaxConcurrentJobs: 1 }) });
  const study = await bareStudy("stale");
  const card = (/** @type {Record<string, any>} */ fields) => store.saveAssumption({ studyId: study.id, userId: study.userId, sourceKind: "expert_set", valueSource: "assumed", ...fields });
  const prior = { family: "lognormal", params: { meanlog: Math.log(0.7), sdlog: 0.15 }, range: { kind: "prediction", low: 0.52, high: 0.94 } };
  await card({ key: "hazard_ratio", name: "风险比", pointValue: 0.7, distribution: prior });
  await card({ key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 6, unit: "月" });
  await card({ key: "dropout_rate", name: "脱落率", pointValue: 0.1 });
  const scenarioRow = await store.saveTrialScenario({ studyId: study.id, userId: study.userId, label: "A 2:1 随机", design: "two_arm_fixed", endpointType: "time_to_event",
    assumptionIds: ["hazard_ratio", "control_median_pfs", "dropout_rate"],
    configuration: { design: { nTreat: 120, nControl: 60, allocation: 2 / 3 }, analysis: { method: "logrank", alpha: 0.025, sided: 1, power: 0.9 },
      accrual: { kind: "uniform", duration: 12, followup: 12 }, performance: ["power"] } });
  const service = pages(module);
  const owner = { id: study.userId };
  const design = async () => (await service.tab(owner, study.id, "trial")).designs[0];
  const measuresOf = async () => Object.fromEntries(Object.entries((await design()).measures).map(([key, value]) => [key, /** @type {any} */ (value)]));

  await settle(module, study.id);
  const first = await measuresOf();
  assert.ok(first.assurance && first.power && first.required_events, Object.keys(first).join());
  assert.equal(first.power.stale, false);

  // A person's edit of the card, exactly as the UI sends it: a number, no distribution. The old prior was centred on the old number.
  const edited = await card({ key: "hazard_ratio", name: "风险比", pointValue: 0.85, reviewState: "reviewed" });
  assert.deepEqual(edited?.distribution, {}, "a value that moved takes the distribution centred on the value that is gone with it");
  await module.orchestrator.recomputeAfterChange({ studyId: study.id, changed: [`assumption:hazard_ratio@${edited?.version}`], reason: "assumption_changed" });
  // One job at a time, so the analytic recomputation lands while the simulation is still queued: the window in which the page
  // used to show yesterday's simulated power as if it were current (the analytic result is a new version nobody had marked).
  const analyticDone = async () => (await store.rows("SELECT state FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'design_analytic' ORDER BY created_at DESC LIMIT 1", [study.id]))[0]?.state === "succeeded";
  for (let turn = 0; turn < 200 && !(await analyticDone()); turn += 1) { await module.loops.jobs?.(); await sleep(50); }
  const simulation = await store.rows("SELECT state FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'design_simulation' ORDER BY created_at DESC LIMIT 1", [study.id]);
  assert.equal(simulation[0].state, "queued", "the window is real: the analytic stage has landed and the simulation has not run");
  const during = await measuresOf();
  assert.equal(during.power.value, first.power.value, "the simulated power on the page is still yesterday's");
  assert.equal(during.power.stale, true, "and the page says so — the stage that made it has not been redone");
  assert.ok(during.required_events.value !== first.required_events.value && during.required_events.stale === false, "what was just recomputed is fresh");
  assert.equal(during.assurance, undefined, "there is no prior to integrate over any more: the old assurance is not left beside the new numbers");
  const trialDuring = await service.tab(owner, study.id, "trial");
  assert.ok(trialDuring.stale, "the design's page is stale until every stage of it has landed");
  assert.ok(trialDuring.footnotes.some((/** @type {string} */ note) => /方案 A：成功把握不再显示/.test(note)), JSON.stringify(trialDuring.footnotes));

  await settle(module, study.id);
  const settled = await measuresOf();
  assert.equal(settled.power.stale, false);
  assert.notEqual(settled.power.value, first.power.value, "the new simulation is the new number");
  assert.equal(settled.assurance, undefined);
  assert.deepEqual(await store.staleMarks(study.id), []);

  // The other half: an edit that leaves the number where it was (a note) keeps the prior it had, and the assurance is computed again.
  const restored = await card({ key: "hazard_ratio", name: "风险比", pointValue: 0.7, distribution: prior });
  const noted = await card({ key: "hazard_ratio", name: "风险比", pointValue: 0.7, note: "与统计师核对过", reviewState: "reviewed" });
  assert.equal(noted?.distribution.family, "lognormal", "the value did not move: the distribution stays");
  assert.equal(noted?.version, (restored?.version ?? 0) + 1);
  await module.orchestrator.recomputeAfterChange({ studyId: study.id, changed: [`assumption:hazard_ratio@${noted?.version}`], reason: "assumption_changed" });
  await settle(module, study.id);
  const again = await measuresOf();
  assert.ok(again.assurance && again.assurance.stale === false, "the assurance is back, on the prior the card kept");
  const finalPage = await service.tab(owner, study.id, "trial");
  assert.deepEqual(finalPage.footnotes, [], "and nothing is said to have been dropped any more");
  assert.equal(scenarioRow.id, (await store.trialScenarios(study.id))[0].id);
});

test("C2-1 an engine refusal reaches the study's own words: a cohort rule naming a column the table does not have fails the job with that column, on the real engine", options, async () => {
  const OWNER = "refusal-owner";
  const plane = path.join(scratch, "data-plane");
  const vcr = composeVcr({ config: { vcrEnabled: true, vcrDataPlaneDir: plane, vcrAudience: "all" }, productDatabase: database });
  await vcr.store.ready();
  const study = await store.createStudy({ userId: OWNER, projectId: "prj_refusal", name: "队列被拒", question: "外部对照", dataTier: "T2", intendedUse: "exploratory" });
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "合作方", ownerParty: "合作方医院", allowedUses: ["vcr"], valueSource: "observed" });
  for (const [name, body] of /** @type {Array<[string, string]>} */ ([["cohort.csv", cohortCsv()], ["visits.csv", visitsCsv()]])) {
    await vcr.dataPlane.storeUpload({ actor: OWNER, studyId: study.id, sourceId: source.id, name, stream: streamOf(body), declaredLength: Buffer.byteLength(body) });
  }
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, columns: FIELD_MAP });
  await vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, hash: proposed.hash });
  const { snapshot } = await vcr.dataPlane.freezeSnapshot({ userId: OWNER, studyId: study.id, sourceId: source.id });
  const module = compose({ dataPlane: vcr.dataPlane });
  const { job } = await module.jobs.enqueue({ studyId: study.id, userId: OWNER, kind: "build_cohort", inputs: [{ kind: "snapshot", id: snapshot.id }],
    scenario: { rules: [{ name: "肌酐正常", rule: { op: "compare", column: "creatinine_umol", comparator: "lt", value: 110 } }] } });
  for (let turn = 0; turn < 100 && (await store.job(study.id, job.id))?.state !== "failed"; turn += 1) { await module.loops.jobs?.(); await sleep(200); }
  const row = await store.job(study.id, job.id);
  assert.equal(row?.state, "failed");
  assert.equal(row?.error?.code, "rule_column_unknown", "the reason the engine gave");
  assert.match(String(row?.error?.message), /creatinine_umol/, "and the column it named");
  assert.equal(row?.error?.issues[0].code, "rule_column_unknown");
  assert.match(String(row?.error?.field), /rules?\b/, "the field of the scenario it refused");
  // What the study page shows is the same reason.
  const page = await pages(module).studyView({ id: OWNER }, study.id);
  const shown = page.jobs.find((/** @type {any} */ entry) => entry.id === job.id);
  assert.equal(shown.error.code, "rule_column_unknown");
  assert.match(shown.error.message, /creatinine_umol/);
  assert.equal((await store.results(study.id)).length, 0, "a refusal computed nothing");
});

test("AC-38 a cancel keeps what the real engine had completed: batches it finished, measures with the error of exactly those replicates", options, async () => {
  const module = compose({ config: configFor({ vcrMaxConcurrentJobs: 1 }) });
  const study = await bareStudy("cancel", { endpointType: "continuous" });
  const scenario = { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "continuous" }, truth: { effect: 0.3, sd: 1 },
    analysis: { method: "ttest", alpha: 0.025, sided: 1 }, performance: ["power"] };
  const { job } = await module.jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, replicates: 100_000 });
  await module.loops.jobs?.();
  const engineJobId = (await store.job(study.id, job.id))?.checkpoint.engineJobId;
  assert.ok(engineJobId, "the job reached the engine");
  // Wait until the engine itself says a batch is done, then cancel: nothing here is a number the test wrote.
  let done = 0;
  for (let turn = 0; turn < 300 && done < 500; turn += 1) { done = (await engine.status(engineJobId)).progress.done; if (done < 500) await sleep(100); }
  assert.ok(done >= 500 && done < 100_000, `the engine had completed ${done} replicates`);
  const cancelled = await module.jobs.cancel(study.id, job.id, { actor: "u_cancel" });
  assert.equal(cancelled.job.state, "canceled");
  /** @type {any[]} */
  let recovered = [];
  for (let turn = 0; turn < 300 && !recovered.length; turn += 1) { recovered = await module.jobs.recoverCanceled(); if (!recovered.length) await sleep(200); }
  assert.equal(recovered.length, 1, `the engine's partial result was fetched: ${serviceLog.slice(-500)}`);
  const kept = recovered[0].result;
  assert.equal(kept.conclusion, "limited");
  assert.equal(kept.diagnostics.canceled, true);
  const completed = kept.diagnostics.replicatesCompleted;
  assert.ok(Number.isInteger(completed) && completed >= done && completed < 100_000 && completed % 500 === 0, `the engine kept ${completed} replicates, whole batches`);
  const power = kept.measures.find((/** @type {any} */ measure) => measure.name === "power");
  assert.ok(power.value > 0.3 && power.value < 0.9, `power ${power.value}`);
  // The error the engine reported is the error of the replicates it kept, and of no others.
  const binomial = Math.sqrt(power.value * (1 - power.value) / completed);
  assert.ok(Math.abs(power.mcse - binomial) < 0.05 * binomial, `mcse ${power.mcse} against ${binomial} for ${completed} replicates`);
  const execution = await store.one("SELECT replicates, receipt FROM evimed_vcr.executions WHERE job_id = $1", [job.id]);
  assert.equal(execution.replicates, completed, "the execution says how many replicates were kept, as the engine did");
  assert.equal(execution.receipt.partial, true);
  assert.equal((await store.job(study.id, job.id))?.state, "canceled", "the job stays cancelled");
  assert.equal((await module.jobs.resultOf(study.id, job.id))?.id, kept.id, "and its status answer carries the partial result");
});

test("C2-13 a hybrid control's historical counts are `aggregate` only when verified extractions hold them; typed into a configuration they are `assumed`, and the result says so", options, async () => {
  const module = compose();
  const historical = { events: [12, 30, 22], n: [40, 90, 60] };
  const build = async (/** @type {string} */ label, /** @type {boolean} */ verified) => {
    const study = await bareStudy(label, { endpointType: "binary" });
    if (verified) {
      for (const [index, [events, n]] of historical.events.map((count, at) => [count, historical.n[at]]).entries()) {
        await store.query(`INSERT INTO evimed_vcr.evidence_items (id, user_id, study_id, parameter, arm, arm_role, value, events, sample_size, source_ref, quote, locator)
          VALUES ($1, $2, $3, 'response_rate', '对照组', 'control', $4, $5, $6, 'NCT0000000${index}', $7, $8::jsonb)`,
        [`evd_${label}_${index}`, study.userId, study.id, events / n, events, n, `${events} of ${n} patients responded`, JSON.stringify({ verification: "verified" })]);
      }
    }
    await store.saveComparatorDesign({ studyId: study.id, userId: study.userId, route: "hybrid_control", estimand: "ATT",
      configuration: { historical, robustWeight: 0.2, tauPrior: { kind: "half_normal", scale: 1 } } });
    await settle(module, study.id);
    const [result] = await store.results(study.id, "comparator");
    return { study, result };
  };
  const typed = await build("typed", false);
  assert.equal(typed.result.conclusion === "estimable" || typed.result.conclusion === "limited", true, typed.result.conclusion);
  assert.ok(typed.result.measures.length >= 4);
  assert.deepEqual([...new Set(typed.result.measures.map((/** @type {any} */ measure) => measure.source))], ["assumed"], "numbers somebody typed are not a summary of evidence");
  assert.equal(typed.result.diagnostics.inputsAssumed, true);
  const page = await pages(module).tab({ id: typed.study.userId }, typed.study.id, "comparator");
  assert.match(page.headline, /输入为假设/);
  assert.ok(page.diagnostics.some((/** @type {any} */ row) => row.key === "map_mean" && row.value.source === "assumed"), "the MAP prior's numbers are on the page, each with its source");
  assert.ok(page.diagnostics.some((/** @type {any} */ row) => row.key === "prior_effective_sample_size_moment"));

  const held = await build("held", true);
  assert.deepEqual([...new Set(held.result.measures.map((/** @type {any} */ measure) => measure.source))], ["aggregate"], "the same counts, each backed by a verified extraction");
  assert.equal(held.result.diagnostics.inputsAssumed, undefined);
});
