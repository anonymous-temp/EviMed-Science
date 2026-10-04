// Two versions of a library definition, compared by the REAL engine on a dataset the
// REAL data plane froze: the control plane queues `cohort.build` with the second
// version as `compare`, the engine service runs R, and the page reads sizes, overlap
// and a standardized difference per covariate — every one of which this test
// recomputes from the file's own values with plain arithmetic. Nothing between
// the CSV and the numbers is a double except the run dispatcher (no model runs).
//
// Skipped without PostgreSQL; without R and its library it is skipped with the
// reason, or — with `VCR_ENGINE_TESTS=required`, as CI runs it — a failure that says
// what the machine lacks (the same rule `vcrEngineContract.integration.test.mjs` keeps).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createVcrEngineClient } from "../src/vcrEngineClient.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { VcrKnowledge } from "../src/vcrKnowledge.mjs";
import { VcrOrchestrator } from "../src/vcrOrchestrator.mjs";
import { createVcrWorkerLoops } from "../src/vcrWorker.mjs";
import { COHORT_SIZE, FIELD_MAP, cohortCsv, streamOf, visitsCsv } from "./helpers/vcrIntakeData.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(HERE, "../../../../项目代码/vcr-engine");
const R_LIBS = process.env.VCR_R_LIBS ?? "";
const ENGINE_REQUIRED = process.env.VCR_ENGINE_TESTS === "required";

/** What this machine lacks of what the real engine needs: `{ code, message }`, or null. */
function engineProblem() {
  if (spawnSync("Rscript", ["--version"]).status !== 0) return { code: "rscript", message: "Rscript is not installed (or not on PATH)" };
  if (!R_LIBS) return { code: "library_unset", message: "VCR_R_LIBS is not set: it names the R library the engine runs on (scripts/vcr/r-library.sh installs it)" };
  if (!existsSync(R_LIBS)) return { code: "library_missing", message: `VCR_R_LIBS names a directory that does not exist: ${R_LIBS}` };
  if (spawnSync("python3", ["-c", "import uvicorn"]).status !== 0) return { code: "uvicorn", message: "python3 cannot import uvicorn (the engine service's server)" };
  return null;
}
const problem = engineProblem();
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: (!databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured")
  || (!ENGINE_REQUIRED && problem?.code === "library_unset" && `the real engine is not available here: ${problem.message}`), timeout: 900_000 };

/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {ControlPlaneDatabase} */
let database;
let scratch = "";
/** @type {import("node:child_process").ChildProcess | null} */
let service = null;
/** @type {ReturnType<typeof createVcrEngineClient>} */
let engine;
let serviceLog = "";
const token = "t".repeat(48);
const receiptKey = "r".repeat(48);

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
  assert.equal(problem, null, `${ENGINE_REQUIRED ? "VCR_ENGINE_TESTS=required: " : ""}this file is the proof the library's comparison runs on the real engine, and this machine cannot run it — ${problem?.message}`);
  isolated = await createGeoTestDatabase(databaseUrl, "kgeng");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-knowledge-"));
  await fs.mkdir(path.join(scratch, "data-plane"), { recursive: true });
  await fs.mkdir(path.join(scratch, "jobs"), { recursive: true });
  await fs.writeFile(path.join(scratch, "token"), token, { mode: 0o600 });
  await fs.writeFile(path.join(scratch, "receipt-key"), receiptKey, { mode: 0o600 });
  const port = await freePort();
  service = spawn("python3", ["-m", "uvicorn", "service.app:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
    cwd: ENGINE_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? scratch, LANG: "C.UTF-8",
      VCR_ENGINE_ROOT: ENGINE_ROOT, VCR_R_LIBS: R_LIBS,
      VCR_ENGINE_TOKEN_FILE: path.join(scratch, "token"), VCR_ENGINE_RECEIPT_KEY_FILE: path.join(scratch, "receipt-key"),
      VCR_ENGINE_WORK_DIR: path.join(scratch, "jobs"), VCR_ENGINE_DATA_ROOT: path.join(scratch, "data-plane"),
      VCR_ENGINE_CORES: "1", VCR_ENGINE_CPU_SECONDS: "600",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = "";
  service.on("error", (error) => { exited = `the engine service could not start: ${error.message}`; });
  service.on("exit", (code, signal) => { exited = `the engine service exited (${code ?? signal})`; });
  service.stdout?.on("data", (chunk) => { serviceLog += String(chunk); });
  service.stderr?.on("data", (chunk) => { serviceLog += String(chunk); });
  engine = createVcrEngineClient({ baseUrl: `http://127.0.0.1:${port}`, token, receiptKey, timeoutMs: 120_000 });
  const deadline = Date.now() + 180_000;
  for (;;) {
    try { if ((await engine.health()).ok) break; } catch { /* still starting */ }
    if (exited || Date.now() > deadline) throw new Error(`${exited || "the engine service did not come up"}:\n${serviceLog.slice(-2000)}`);
    await sleep(500);
  }
});

after(async () => {
  service?.kill("SIGTERM");
  await sleep(300);
  service?.kill("SIGKILL");
  if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  await database?.close().catch(() => {});
  await isolated?.drop();
});

// The file's own values, from the same formulas `cohortCsv()` writes them with.
const ageOf = (/** @type {number} */ n) => 41 + ((n * 3) % 30);
const ecogOf = (/** @type {number} */ n) => n % 4;
const people = Array.from({ length: COHORT_SIZE }, (_, index) => ({ n: index + 1, age: ageOf(index + 1), ecog: ecogOf(index + 1) }));
const mean = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (/** @type {number[]} */ xs) => { const m = mean(xs); return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1); };
/** The pooled-variance standardized difference of B against A. @param {number[]} a @param {number[]} b */
const smd = (a, b) => (mean(b) - mean(a)) / Math.sqrt((variance(a) + variance(b)) / 2);

const cmp = (/** @type {string} */ column, /** @type {string} */ comparator, /** @type {number} */ value) => ({ op: "compare", column, comparator, value });

test("two versions of a library definition are compared by the real engine on the frozen dataset, and every number is the file's own", options, async () => {
  const OWNER = "kg-owner";
  const config = { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: path.join(scratch, "data-plane"), vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 1_000_000, vcrMaxConcurrentJobs: 1, vcrLeaseMs: 900_000 };
  const vcr = composeVcr({ config, productDatabase: database });
  await vcr.store.ready();
  const study = await vcr.store.createStudy({ userId: OWNER, projectId: "prj_kg", name: "定义版本比较", question: "q", dataTier: "T1", intendedUse: "exploratory" });
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "合作方基线", ownerParty: "合作方医院", allowedUses: ["vcr"], valueSource: "observed" });
  for (const [name, body] of /** @type {Array<[string, string]>} */ ([["cohort.csv", cohortCsv()], ["visits.csv", visitsCsv()]])) {
    await vcr.dataPlane.storeUpload({ actor: OWNER, studyId: study.id, sourceId: source.id, name, stream: streamOf(body), declaredLength: Buffer.byteLength(body) });
  }
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, columns: FIELD_MAP });
  assert.deepEqual([proposed.entryIssues, proposed.mapIssues], [[], []]);
  await vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, hash: proposed.hash });
  const { snapshot } = await vcr.dataPlane.freezeSnapshot({ userId: OWNER, studyId: study.id, sourceId: source.id });

  const jobs = new VcrJobs({ store: vcr.store, config, engine, dataPlane: vcr.dataPlane });
  const orchestrator = new VcrOrchestrator({ store: vcr.store, jobs, config, dispatchRun: null });
  const loops = createVcrWorkerLoops({ jobs, orchestrator, store: vcr.store });
  const knowledge = new VcrKnowledge({ store: vcr.knowledgeStore, studyStore: vcr.store, dataStore: vcr.dataStore, jobs });

  // two versions of one definition, saved from the study's own populations
  await vcr.store.savePopulation({ studyId: study.id, userId: OWNER, name: "成人 ECOG 0–2", kind: "real", snapshotId: snapshot.id,
    definition: { rules: [{ name: "adult", rule: cmp("age", "gte", 18) }, { name: "fit", rule: cmp("ecog", "lte", 2) }] } });
  const v1 = await knowledge.saveFromStudy(study, { populationId: (await vcr.store.populations(study.id, 5))[0].id, text: "成人，ECOG 0 到 2。" }, OWNER);
  await vcr.store.savePopulation({ studyId: study.id, userId: OWNER, name: "成人 ECOG 0–2", kind: "real", snapshotId: snapshot.id,
    definition: { rules: [{ name: "older", rule: cmp("age", "gte", 55) }, { name: "fit", rule: cmp("ecog", "lte", 2) }] } });
  await knowledge.saveFromStudy(study, { populationId: (await vcr.store.populations(study.id, 5))[0].id, definitionId: v1.definitionId, text: "55 岁及以上，ECOG 0 到 2。" }, OWNER);

  const queued = await knowledge.compareVersions(study, { id: OWNER }, { definitionId: v1.definitionId, versionA: 1, versionB: 2 });
  assert.equal(queued.created, true);
  const deadline = Date.now() + 600_000;
  for (;;) {
    await loops.jobs?.();
    const rows = await vcr.store.rows("SELECT id, state, error FROM evimed_vcr.jobs WHERE study_id = $1", [study.id]);
    if (rows.every((row) => !["queued", "running", "awaiting_budget"].includes(row.state))) {
      assert.deepEqual(rows.map((row) => row.state), ["succeeded"], JSON.stringify(rows.map((row) => row.error)));
      break;
    }
    if (Date.now() > deadline) throw new Error(`the comparison did not finish:\n${serviceLog.slice(-1500)}`);
    await sleep(400);
  }

  // the engine's answer, as the page reads it
  const [comparison] = (await knowledge.studyKnowledge(study)).comparisons;
  assert.ok(comparison, "the finished job left a comparison");
  const inA = people.filter((person) => person.age >= 18 && person.ecog <= 2);
  const inB = people.filter((person) => person.age >= 55 && person.ecog <= 2);
  assert.deepEqual([comparison.cohortSizeA, comparison.cohortSizeB], [inA.length, inB.length]);
  assert.deepEqual(comparison.overlap, { both: inB.length, onlyA: inA.length - inB.length, onlyB: 0 });
  assert.deepEqual([comparison.definitionId, comparison.versionA, comparison.versionB, comparison.snapshotId], [v1.definitionId, 1, 2, snapshot.id]);
  /** @param {string} name */
  const row = (name) => comparison.covariates.find((entry) => entry.covariate === name);
  const age = row("age");
  const ecog = row("ecog");
  assert.ok(age && ecog, `the subject table's covariates were compared: ${comparison.covariates.map((entry) => entry.covariate).join(", ")}`);
  assert.ok(Math.abs(/** @type {number} */ (age.standardizedDifference) - smd(inA.map((p) => p.age), inB.map((p) => p.age))) < 1e-9, "age");
  assert.ok(Math.abs(/** @type {number} */ (ecog.standardizedDifference) - smd(inA.map((p) => p.ecog), inB.map((p) => p.ecog))) < 1e-9, "ecog");
  assert.equal(row("sex")?.skipped, "not_numeric", "a text covariate is named, not dropped");
  assert.equal(comparison.floor, 0.1);

  // it is a result of its own: the study's results do not list it, and nothing was queued for the programme
  assert.deepEqual((await vcr.store.results(study.id)).map((result) => result.kind), []);
  const counted = await knowledge.listLibrary(OWNER);
  assert.deepEqual(counted.definitions.map((entry) => [entry.versions, entry.uses]), [[2, 1]]);
  // asking again for the same pair is the same job, not a second computation
  const again = await knowledge.compareVersions(study, { id: OWNER }, { definitionId: v1.definitionId, versionA: 1, versionB: 2 });
  assert.equal(again.created, false);
});
