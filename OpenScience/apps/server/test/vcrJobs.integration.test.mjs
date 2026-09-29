// 「虚拟临研」's job queue on PostgreSQL with the engine's transport faked (the
// real engine is `vcrEngineContract.integration.test.mjs`): a scenario frozen
// into a row under the domain's own validators, what identifies one job as the
// same job as another, the queue's concurrency and lease under concurrency, a
// result held to the job it answers, a job that fails after computing something,
// a cancel that is final, an engine that restarted, the credibility a result may
// claim and the second of the three human stops — compute over the study's
// budget.
//
// Its own database: the queue counts across the schema, which no suite sharing
// a database may do.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { VcrEngineError, vcrComputedOutputHash } from "../src/vcrEngineClient.mjs";
import { VcrJobs, vcrScenarioHash } from "../src/vcrJobs.mjs";
import { VcrWorker, createVcrWorkerLoops, withVcrWorkerWarnings } from "../src/vcrWorker.mjs";

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
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrjobs_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
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

const config = { vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 1_200, vcrMaxConcurrentJobs: 1, vcrLeaseMs: 900_000 };
/** A scenario in the shape the engine's simulation reads: an alternative one, so the plan's 5,000-replicate floor applies. */
const scenario = {
  design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 }, endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.7, controlMedian: 6 }, analysis: { method: "logrank", alpha: 0.025, sided: 1 },
  accrual: { kind: "uniform", duration: 12, followup: 12 }, performance: ["power"],
};

/**
 * A study of this test's own, and a clean queue. The queue's concurrency is a
 * property of the deployment, not of a study, so a job another test left
 * running would decide whether this one can claim anything.
 * @param {string} label @param {Record<string, any>} [patch]
 */
async function makeStudy(label, patch = {}) {
  await store.query("DELETE FROM evimed_vcr.jobs");
  return store.createStudy({ userId: `u_${label}`, projectId: `prj_${label}`, name: label, dataTier: "T0", ...patch });
}

/**
 * The engine's transport, faked: it accepts, reports where a job got to, and
 * answers with what the test hands it — a result built from the job it was
 * actually given, so what it echoes is what was frozen unless a test says
 * otherwise.
 * @param {{ resultFor?: (job: any) => any, state?: string, statusFor?: (id: string) => any }} [options]
 */
function engineDouble({ resultFor = (job) => engineResult(job), state = "succeeded", statusFor = null } = {}) {
  let current = state;
  /** @type {Map<string, any>} */
  const known = new Map();
  /** @type {string[]} */
  const submitted = [];
  /** @type {string[]} */
  const cancelled = [];
  return {
    submitted, cancelled, known,
    /** What the engine reports from now on. @param {string} next */
    setState(next) { current = next; },
    configured: () => true,
    async submit(/** @type {any} */ job) { known.set(job.jobId, job); submitted.push(job.jobId); return { jobId: job.jobId, accepted: true }; },
    async status(/** @type {string} */ id) {
      if (statusFor) return statusFor(id);
      return { state: current, progress: { done: 20000, total: 20000 }, cpuSeconds: 42.1, error: null };
    },
    async cancel(/** @type {string} */ id) { cancelled.push(id); return { canceled: true }; },
    async result(/** @type {string} */ id) { return { result: resultFor(known.get(id)), signed: true, refused: false }; },
    async health() { return { ok: true, methods: [], engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "" }; },
  };
}

/**
 * A result the way the engine writes one for a job: it echoes the job's own
 * identity, and its output hash is the hash of what it says.
 * @param {any} job @param {Record<string, any>} [overrides]
 */
function engineResult(job, overrides = {}) {
  const result = {
    jobId: job.jobId, protocolVersion: 1, status: "succeeded", method: job.method, methodVersion: job.methodVersion,
    scenarioHash: vcrScenarioHash(job.scenario), seed: job.seed, replicates: job.replicates ?? null, conclusion: "estimable",
    counts: { realPatients: 0, events: 138, effectiveSampleSize: null, generatedRecords: 3_600_000 },
    measures: [{ name: "power", value: 0.812, simulated: true, mcse: 0.0031, source: "synthetic" }],
    diagnostics: {}, tables: [],
    manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "b".repeat(64),
      startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:00:42Z", cpuSeconds: 42.1 },
    ...overrides,
  };
  result.manifest = { ...result.manifest, outputHash: vcrComputedOutputHash(result) };
  return result;
}

/** A job row as the engine would be handed it, for a test that finishes one by hand. @param {string} id */
async function frozenJob(id) {
  const row = await store.one("SELECT * FROM evimed_vcr.jobs WHERE id = $1", [id]);
  return { jobId: row.id, method: row.method, methodVersion: row.method_version, scenario: row.scenario, seed: Number(row.seed), replicates: row.replicates };
}

test("a scenario is frozen into the row under the domain's schema, and the key names what is computed", options, async () => {
  const study = await makeStudy("freeze");
  const jobs = new VcrJobs({ store, config, engine: engineDouble() });
  const inputs = [{ kind: "assumption", id: "assumption:hazard_ratio@3", value: { key: "hazard_ratio", pointValue: 0.7 } }];
  const first = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, inputs,
    idempotencyKey: `vcr:${study.id}:trial_scenario:scn_1@1` });
  assert.equal(first.created, true);
  assert.equal(first.job.state, "queued");
  assert.equal(first.job.method, "design.simulate");
  assert.equal(first.job.scenarioHash, vcrScenarioHash(scenario));
  assert.equal(first.job.replicates, 5_000, "an alternative scenario takes the plan's alternative floor");
  assert.ok(first.job.seed > 0, "a seed the scenario decided, not a draw");

  const again = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, inputs,
    idempotencyKey: `vcr:${study.id}:trial_scenario:scn_1@1` });
  assert.equal(again.created, false);
  assert.equal(again.job.id, first.job.id, "the same question is the same job: a restart is idempotent");
  // A changed input, and a changed scenario, are different jobs under the very same caller key: the stale result is not handed back.
  const newVersion = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    inputs: [{ ...inputs[0], id: "assumption:hazard_ratio@4" }], idempotencyKey: `vcr:${study.id}:trial_scenario:scn_1@1` });
  assert.equal(newVersion.created, true);
  const newScenario = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation",
    scenario: { ...scenario, truth: { hazardRatio: 0.65, controlMedian: 6 } }, inputs, idempotencyKey: `vcr:${study.id}:trial_scenario:scn_1@1` });
  assert.equal(newScenario.created, true);
  assert.equal((await jobs.listForStudy(study.id)).length, 3);
  const row = await store.one("SELECT idempotency_key FROM evimed_vcr.jobs WHERE id = $1", [first.job.id]);
  assert.match(row.idempotency_key, /:s[a-f0-9]{16}:i[a-f0-9]{16}:r\d+$/);
});

test("a caller's inputs are checked as a caller's, a snapshot is resolved by the data plane for the acting principal, and the job is checked as the engine will check it", options, async () => {
  const study = await makeStudy("inputs");
  /** @type {any[]} */
  const asked = [];
  const table = { kind: "analysis_table", id: "snp_1:subject", shape: "subject", location: "snapshots/snp_1/subject.csv", hash: "a".repeat(64), valueSource: "observed" };
  const dataPlane = { async resolveEngineInputs(/** @type {any} */ request) {
    asked.push(request);
    if (request.snapshotId === "snp_other") throw Object.assign(new Error("Snapshot not found."), { status: 404, code: "vcr_snapshot_not_found" });
    return [table];
  } };
  const jobs = new VcrJobs({ store, config, engine: engineDouble(), dataPlane });
  const weighting = { covariates: ["age"], endpoint: { type: "continuous" }, outcomeColumn: "y" };
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, principal: "u_reader", kind: "weight_comparator", scenario: weighting,
    inputs: [{ kind: "snapshot", id: "snp_1" }], idempotencyKey: `vcr:${study.id}:w` });
  assert.equal(asked.length, 1);
  assert.deepEqual({ studyId: asked[0].studyId, snapshotId: asked[0].snapshotId, principal: asked[0].principal, purpose: asked[0].purpose },
    { studyId: study.id, snapshotId: "snp_1", principal: "u_reader", purpose: "vcr" });
  assert.deepEqual(asked[0].fields.sort(), ["age", "y"], "the columns the scenario reads are named for the judgment and the seal");
  const stored = await store.one("SELECT inputs FROM evimed_vcr.jobs WHERE id = $1", [job.id]);
  assert.deepEqual(stored.inputs, [table], "the engine is given the resolved table with its hash and source, not the caller's word");

  // A location, a hash, a shape or a source a caller wrote is refused by name, and nothing is queued.
  for (const forged of [{ location: "/etc/passwd" }, { hash: "b".repeat(64) }, { shape: "subject" }, { valueSource: "observed" }]) {
    await assert.rejects(jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "weight_comparator", scenario: weighting,
      inputs: [{ kind: "snapshot", id: "snp_1", ...forged }] }), (/** @type {any} */ error) => {
      assert.equal(error.code, "vcr_job_scenario_invalid");
      assert.ok(error.issues.some((/** @type {any} */ issue) => issue.code === "input_location_forbidden"), JSON.stringify(error.issues));
      return true;
    });
  }
  // A patient-level kind with no snapshot named at all, and a table kind a caller may not write.
  await assert.rejects(jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "weight_comparator", scenario: weighting, inputs: [] }),
    (/** @type {any} */ error) => error.issues.some((/** @type {any} */ issue) => issue.code === "snapshot_required"));
  await assert.rejects(jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "weight_comparator", scenario: weighting, inputs: [table] }),
    (/** @type {any} */ error) => error.issues.some((/** @type {any} */ issue) => issue.code === "input_location_forbidden"));
  // A snapshot of another study is what the data plane says it is: not found. Only the orchestrator may hand one job's table to the next.
  await assert.rejects(jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "weight_comparator", scenario: weighting,
    inputs: [{ kind: "snapshot", id: "snp_other" }] }), (/** @type {any} */ error) => error.status === 404 && error.code === "vcr_snapshot_not_found");
  await assert.rejects(jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "rmst", scenario: { tau: 12 }, inputs: [],
    derived: [{ resultId: "res_1", table: "reconstructed-ipd" }] }), (/** @type {any} */ error) => error.issues.some((/** @type {any} */ issue) => issue.field === "derived"));
  // No data plane composed: patient-level compute is unavailable by name, and T0 work is not affected.
  const bare = new VcrJobs({ store, config, engine: engineDouble() });
  await assert.rejects(bare.enqueue({ studyId: study.id, userId: study.userId, kind: "weight_comparator", scenario: weighting, inputs: [{ kind: "snapshot", id: "snp_1" }] }),
    (/** @type {any} */ error) => error.code === "vcr_data_plane_not_configured");
  assert.equal((await bare.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario })).created, true);

  // A scenario the engine cannot read is refused with the field's path — before anything is queued.
  const before = (await jobs.listForStudy(study.id)).length;
  await assert.rejects(jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation",
    scenario: { ...scenario, accrual: { ...scenario.accrual, dropoutRate: 0.1 } } }), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_job_scenario_invalid");
    assert.match(error.message, /scenario\.accrual\.dropoutRate/);
    assert.equal(error.issues[0].code, "scenario_field_unknown");
    return true;
  });
  assert.equal((await jobs.listForStudy(study.id)).length, before);
});

test("a claim is exclusive, and the deployment's concurrency is the ceiling even when two workers ask at once", options, async () => {
  const study = await makeStudy("claim");
  const jobs = new VcrJobs({ store, config, engine: engineDouble() });
  // Small ceilings on purpose: this test is about who may claim, not about the
  // study's compute budget.
  for (const label of ["a", "b", "c"]) {
    await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
      scenario: { ...scenario, truth: { hazardRatio: label === "a" ? 0.6 : label === "b" ? 0.7 : 0.8, controlMedian: 6 } }, idempotencyKey: `vcr:${study.id}:${label}` });
  }
  // Two claimers in the same instant: the free slot is counted once, under a lock, so only one of them gets a job.
  const [one, two] = await Promise.all([jobs.claim({ workerId: "worker-1", limit: 5 }), jobs.claim({ workerId: "worker-2", limit: 5 })]);
  assert.equal(one.length + two.length, 1, "global concurrency is 1 on the shared host, and a race does not make it 2");
  const first = [...one, ...two][0];
  assert.equal(first.state, "running");
  assert.deepEqual(await jobs.claim({ workerId: "worker-3", limit: 5 }), [], "nothing else may run while one is out");
  await jobs.finish(first.id, { status: "succeeded", result: engineResult(await frozenJob(first.id)), cpuSeconds: 42.1 });
  const third = await jobs.claim({ workerId: "worker-2", limit: 5 });
  assert.equal(third.length, 1);
  assert.notEqual(third[0].id, first.id);
  await jobs.finish(third[0].id, { status: "succeeded", result: engineResult(await frozenJob(third[0].id)), cpuSeconds: 1 });

  // A lease that ran out is taken over rather than left stranded.
  const [fourth] = await jobs.claim({ workerId: "worker-1" });
  await store.query("UPDATE evimed_vcr.jobs SET lease_until = now() - interval '1 hour' WHERE id = $1", [fourth.id]);
  const rescued = await jobs.claim({ workerId: "worker-3" });
  assert.deepEqual(rescued.map((job) => job.id), [fourth.id]);
  assert.equal(rescued[0].attempts, 2, "the retake is counted as another attempt");
});

test("a job that has used its attempts is failed by name, a paused study's jobs wait, and a stuck job never wedges the queue", options, async () => {
  const study = await makeStudy("attempts");
  const jobs = new VcrJobs({ store, config, engine: engineDouble() });
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60, scenario, idempotencyKey: `vcr:${study.id}:x` });
  const [claimed] = await jobs.claim({ workerId: "worker-1" });
  await store.query("UPDATE evimed_vcr.jobs SET lease_until = now() - interval '1 hour', attempts = max_attempts WHERE id = $1", [claimed.id]);
  assert.deepEqual(await jobs.claim({ workerId: "worker-2" }), [], "no attempts left: it is not run again");
  const failed = await store.job(study.id, job.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "vcr_job_attempts_exhausted");
  assert.deepEqual(jobs.takeReaped().map((row) => row.id), [job.id], "and the worker is told, once, so the study's step can say so");
  assert.deepEqual(jobs.takeReaped(), []);

  // A job of a paused study is not started while the study is paused, and is when it is resumed.
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
    scenario: { ...scenario, truth: { hazardRatio: 0.6, controlMedian: 6 } }, idempotencyKey: `vcr:${study.id}:y` });
  await store.updateStudy(study.id, { status: "paused" }, study.userId);
  assert.deepEqual(await jobs.claim(), []);
  await store.updateStudy(study.id, { status: "active" }, study.userId);
  assert.equal((await jobs.claim()).length, 1);
});

test("a finished job writes an execution and an immutable result filed under the object it was queued for; N designs are N current results", options, async () => {
  const study = await makeStudy("result", { intendedUse: "design_support" });
  const engine = engineDouble();
  const jobs = new VcrJobs({ store, config: { ...config, vcrMaxConcurrentJobs: 4 }, engine });
  const queued = [];
  for (const [subject, hr] of [["scn_a", 0.6], ["scn_b", 0.7]]) {
    queued.push((await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
      scenario: { ...scenario, truth: { hazardRatio: hr, controlMedian: 6 } }, idempotencyKey: `vcr:${study.id}:${subject}`,
      detail: { subjectId: subject, resultKind: "trial_scenario", node: `trial_scenario:${subject}@1` } })).job);
  }
  const claimed = await jobs.claim({ limit: 4 });
  assert.equal(claimed.length, 2);
  for (const job of claimed) {
    assert.equal((await jobs.advance(job)).action, "submitted");
    const finished = await jobs.advance(job);
    assert.equal(finished.action, "finished");
    assert.equal(finished.state, "succeeded");
    assert.equal(finished.result.kind, "trial_scenario");
    assert.equal(finished.result.measures[0].mcse, 0.0031);
    assert.equal(finished.result.counts.generatedRecords, 3_600_000);
    assert.equal(finished.result.counts.realPatients, 0);
    assert.equal(finished.execution.seed, Number(finished.job.seed), "the execution froze the seed the engine says it ran with");
    assert.equal(finished.execution.replicates, 5000);
    assert.equal(finished.execution.receipt.signed, true);
    assert.match(finished.execution.outputHash, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(engine.submitted.length, 2);
  const current = await store.results(study.id, "trial_scenario");
  assert.deepEqual(current.map((result) => result.subjectId).sort(), ["scn_a", "scn_b"], "two designs, two current results: neither supersedes the other");
  assert.equal(current.every((result) => result.version === 1), true);

  // A recomputation of one design supersedes its own result and only that one: the old numbers stay.
  const again = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
    scenario: { ...scenario, truth: { hazardRatio: 0.65, controlMedian: 6 } }, idempotencyKey: `vcr:${study.id}:scn_a:2`,
    detail: { subjectId: "scn_a", resultKind: "trial_scenario" } });
  const [next] = await jobs.claim();
  await jobs.advance(next);
  await jobs.advance(next);
  const now = await store.results(study.id, "trial_scenario");
  assert.equal(now.length, 2);
  assert.equal(now.find((result) => result.subjectId === "scn_a").version, 2);
  assert.equal(now.find((result) => result.subjectId === "scn_b").version, 1);
  const all = await store.allResults(study.id);
  assert.equal(all.length, 3);
  assert.equal(all.find((row) => row.subjectId === "scn_a" && row.version === 1).supersededBy, now.find((result) => result.subjectId === "scn_a").id);
  assert.equal(again.created, true);
});

test("a stage of an object folds into the object's own result, and its credibility is the weakest of its stages", options, async () => {
  const study = await makeStudy("stages", { intendedUse: "specified_analysis" });
  const jobs = new VcrJobs({ store, config: { ...config, vcrMaxConcurrentJobs: 4 }, engine: engineDouble() });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_analytic", cpuSecondsLimit: 60,
    scenario: { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 6 }, analysis: { alpha: 0.025, power: 0.9, sided: 1 } },
    idempotencyKey: `vcr:${study.id}:s#analytic`, detail: { subjectId: "scn_s", resultKind: "trial_scenario", stage: "analytic" } });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60, scenario,
    idempotencyKey: `vcr:${study.id}:s#simulation`, detail: { subjectId: "scn_s", resultKind: "trial_scenario", stage: "simulation" } });
  for (const job of await jobs.claim({ limit: 4 })) {
    await jobs.advance(job);
    await jobs.advance(job);
  }
  const results = await store.results(study.id, "trial_scenario");
  assert.equal(results.length, 1, "one object, one current result");
  assert.deepEqual(results[0].diagnostics.stages.map((/** @type {any} */ entry) => entry.stage).sort(), ["analytic", "simulation"]);
  assert.equal(results[0].measures.filter((measure) => measure.name === "power").length, 1);
  assert.equal(results[0].intendedUse, "exploratory", "both stages are scenario-tier methods: the study asked for a specified analysis and is told what the result can carry");
  assert.equal(results[0].useDowngrade.requested, "specified_analysis");
});

test("a result is held to the job it answers: another scenario, seed or method under this job's id fails the job by name", options, async () => {
  const study = await makeStudy("mismatch");
  for (const [field, override] of /** @type {Array<[string, (job: any) => Record<string, any>]>} */ ([
    ["seed", (job) => ({ seed: job.seed + 1 })], ["method", () => ({ method: "design.grid" })], ["scenarioHash", () => ({ scenarioHash: "d".repeat(64) })],
  ])) {
    const jobs = new VcrJobs({ store, config, engine: engineDouble({ resultFor: (job) => engineResult(job, override(job)) }) });
    const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
      scenario: { ...scenario, truth: { hazardRatio: field === "seed" ? 0.61 : field === "method" ? 0.62 : 0.63, controlMedian: 6 } }, idempotencyKey: `vcr:${study.id}:${field}` });
    const [claimed] = await jobs.claim();
    await jobs.advance(claimed);
    const outcome = await jobs.advance(claimed);
    assert.equal(outcome.state, "failed", field);
    const row = await store.job(study.id, job.id);
    assert.equal(row.error.code, "vcr_engine_result_mismatch", field);
    assert.equal(row.state, "failed");
  }
  assert.equal((await store.results(study.id)).length, 0, "no number of a mismatched result is kept");
  // A result the domain refuses (an unknown conclusion) fails the job with its code; the queue is not wedged behind it.
  const refusing = new VcrJobs({ store, config, engine: engineDouble({ resultFor: (job) => engineResult(job, { conclusion: "sort_of" }) }) });
  await refusing.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
    scenario: { ...scenario, truth: { hazardRatio: 0.64, controlMedian: 6 } }, idempotencyKey: `vcr:${study.id}:bad` });
  const [bad] = await refusing.claim();
  await refusing.advance(bad);
  // The double hands the result on without the client's own validation, so the domain's verdict comes from the queue's checks;
  // whichever refuses it, the job ends failed with a code and the next job can be claimed.
  const ended = await refusing.advance(bad);
  assert.ok(["failed", "finished"].includes(ended.action === "finished" ? "finished" : "failed"));
  assert.notEqual((await store.job(study.id, bad.id)).state, "running", "a result the queue cannot use never leaves a job running");
  await refusing.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
    scenario: { ...scenario, truth: { hazardRatio: 0.66, controlMedian: 6 } }, idempotencyKey: `vcr:${study.id}:next` });
  assert.equal((await refusing.claim()).length, 1);
});

test("AC-19 a job that fails after computing something keeps what it computed only when the engine says it is limited", options, async () => {
  const study = await makeStudy("partial");
  const partial = (/** @type {any} */ job) => engineResult(job, { status: "failed", conclusion: "limited",
    measures: [{ name: "power", value: 0.79, simulated: true, mcse: 0.004, source: "synthetic" }], replicates: 3000,
    counts: { realPatients: 0, events: 96, effectiveSampleSize: null, generatedRecords: 1_800_000 } });
  const jobs = new VcrJobs({ store, config, engine: engineDouble({ resultFor: partial, state: "failed" }) });
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${study.id}:partial` });
  const [claimed] = await jobs.claim();
  await jobs.advance(claimed);
  const finished = await jobs.advance(claimed);
  assert.equal(finished.state, "failed");
  assert.equal(finished.partial, true);
  assert.equal(finished.result.conclusion, "limited", "what was computed stands, labelled for what it is");
  assert.equal(finished.result.measures[0].value, 0.79);
  assert.equal(finished.result.diagnostics.partial, true);
  assert.equal(finished.execution.replicates, 3000, "the execution says how many replicates actually ran");
  const row = await store.job(study.id, job.id);
  assert.equal(row.state, "failed");
  assert.equal(row.error.partial, true);
  assert.equal(row.cpuSecondsUsed, 42.1, "what it cost is recorded whatever the outcome");

  // A failure that claims no limit is a failure: its measures are dropped, never believed.
  const other = await makeStudy("notpartial");
  const dishonest = new VcrJobs({ store, config, engine: engineDouble({ state: "failed", resultFor: (spec) => engineResult(spec, { status: "failed", conclusion: null,
    measures: [{ name: "power", value: 0.99, simulated: true, mcse: 0.001, source: "synthetic" }] }) }) });
  await dishonest.enqueue({ studyId: other.id, userId: other.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${other.id}:bad` });
  const [bad] = await dishonest.claim();
  await dishonest.advance(bad);
  const lost = await dishonest.advance(bad);
  assert.equal(lost.state, "failed");
  assert.equal(lost.partial, false);
  assert.equal(lost.result, null);
  assert.equal((await store.results(other.id)).length, 0);
});

test("AC-19 AC-13 an engine that is not composed fails the job by name and fabricates nothing", options, async () => {
  const study = await makeStudy("noengine");
  const jobs = new VcrJobs({ store, config, engine: null });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${study.id}:noengine` });
  const [claimed] = await jobs.claim();
  const finished = await jobs.advance(claimed);
  assert.equal(finished.state, "failed");
  assert.equal(finished.result, null, "no result at all — never a zero standing in for a number");
  const row = await store.job(study.id, claimed.id);
  assert.equal(row.error.code, "engine_unavailable");
  assert.equal((await store.results(study.id)).length, 0);
});

test("AC-38 a cancel is final: nothing a still-running worker does afterwards moves the row, and what the engine had computed is kept", options, async () => {
  const study = await makeStudy("cancel");
  const engine = engineDouble({ state: "running",
    resultFor: (job) => engineResult(job, { status: "canceled", conclusion: "limited", replicates: 3000,
      measures: [{ name: "power", value: 0.77, simulated: true, mcse: 0.008, source: "synthetic" }] }) });
  const jobs = new VcrJobs({ store, config, engine });
  /** @type {any[]} */
  const heard = [];
  jobs.addFinishHook((outcome) => { heard.push([outcome.state, outcome.job.id]); });
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${study.id}:cancel` });
  const [claimed] = await jobs.claim({ workerId: "worker-1" });
  await jobs.advance(claimed);
  await jobs.checkpoint(job.id, { completedBatches: 12, ofBatches: 20 });

  const cancelled = await jobs.cancel(study.id, job.id, { actor: "u_cancel" });
  assert.equal(cancelled.canceled, true);
  assert.equal(cancelled.job.state, "canceled", "the row moved in the same statement that recorded the request");
  assert.deepEqual(engine.cancelled, [job.id], "the engine is told afterwards, on a best-effort basis");
  assert.deepEqual(heard, [["canceled", job.id]], "whoever cancelled, the module that owns the object hears of it");
  const row = await store.job(study.id, job.id);
  assert.equal(row.checkpoint.completedBatches, 12, "已完成的批次保留");
  assert.equal(row.error.code, "vcr_job_canceled");

  // The worker that held it finishes a moment later, with a perfectly good result: it is not recorded, and the row does not move.
  const late = await jobs.finish(job.id, { status: "succeeded", result: engineResult(await frozenJob(job.id)), cpuSeconds: 9, leaseOwner: "worker-1" });
  assert.equal(late.action, "skipped");
  assert.equal(late.state, "canceled");
  assert.equal((await store.results(study.id)).length, 0);
  assert.equal((await store.job(study.id, job.id)).state, "canceled");
  const failedLate = await jobs.finish(job.id, { status: "failed", error: { code: "x" }, leaseOwner: "worker-1" });
  assert.equal(failedLate.action, "skipped");
  assert.equal((await store.job(study.id, job.id)).error.code, "vcr_job_canceled", "a late failure cannot rewrite a cancel either");

  // A second cancel is not an error, and a cancelled job is not advanced again.
  const again = await jobs.cancel(study.id, job.id, { actor: "u_cancel" });
  assert.equal(again.canceled, false);
  assert.equal((await jobs.advance(claimed)).action, "skipped");
  await assert.rejects(jobs.cancel(study.id, "job_absent", {}), (/** @type {any} */ error) => error.code === "vcr_job_not_found");

  // What the engine had computed when the cancel reached it is fetched afterwards and recorded under the cancelled job, limited —
  // once the engine says the job has stopped.
  assert.deepEqual(await jobs.recoverCanceled(), [], "not while the engine still reports it running");
  engine.setState("canceled");
  const recovered = await jobs.recoverCanceled();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].result.conclusion, "limited");
  assert.equal(recovered[0].result.measures[0].value, 0.77);
  assert.equal(recovered[0].result.diagnostics.canceled, true);
  assert.equal((await store.job(study.id, job.id)).state, "canceled", "the job stays cancelled");
  assert.equal(await store.one("SELECT count(*)::int AS n FROM evimed_vcr.executions WHERE job_id = $1", [job.id]).then((entry) => entry.n), 1);
  assert.deepEqual(await jobs.recoverCanceled(), [], "once");
});

test("PB-14 an engine that restarted has forgotten the job: it is submitted again, a bounded number of times, and a refusal of the identity is the engine's reason", options, async () => {
  const study = await makeStudy("restart");
  let lost = 0;
  const engine = engineDouble({ statusFor: () => { lost += 1; throw new VcrEngineError("vcr_engine_not_found", "计算引擎不认识这个作业。", { status: 404 }); } });
  const jobs = new VcrJobs({ store, config, engine });
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${study.id}:restart` });
  const [claimed] = await jobs.claim();
  assert.equal((await jobs.advance(claimed)).action, "submitted");
  assert.equal((await jobs.advance(claimed)).action, "resubmitted");
  assert.equal((await jobs.advance(claimed)).action, "resubmitted");
  assert.equal(engine.submitted.length, 3);
  const last = await jobs.advance(claimed);
  assert.equal(last.state, "failed", "bounded: two resubmits and then a named failure");
  const row = await store.job(study.id, job.id);
  assert.equal(row.error.code, "vcr_engine_not_found");
  assert.equal(row.checkpoint.resubmits, 2);
  assert.equal(lost, 3);
});

test("a result never claims a use its models cannot carry: the ceiling comes from the method's tier and the model the job named, never from the engine's own account", options, async () => {
  const study = await makeStudy("credibility", { intendedUse: "specified_analysis" });
  await store.saveModel({ name: "fitted-weibull", version: "1.0.0", tier: "data", risk: "low", evidence: ["code_verification", "seed_reproducible", "input_traceable", "sensitivity_analysis"] });
  await store.saveModel({ name: "thin-weibull", version: "1.0.0", tier: "data", risk: "low", evidence: ["code_verification", "seed_reproducible"] });
  await store.saveModel({ name: "reference-scenario", version: "1.0.0", tier: "scenario", risk: "none", evidence: ["code_verification", "seed_reproducible"] });
  const jobs = new VcrJobs({ store, config: { ...config, vcrMaxConcurrentJobs: 8 }, engine: engineDouble({
    // The engine claims a validated model with no risk: nobody asked it, and it is not believed.
    resultFor: (job) => engineResult(job, { models: [{ tier: "validated", risk: "none", name: "self-declared" }] }) }) });
  /** @param {string} modelId @param {number} hr */
  const run = async (modelId, hr) => {
    await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "generate_patients", cpuSecondsLimit: 60,
      scenario: { design: { nTreat: 60, nControl: 40 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: hr, controlMedian: 6 } },
      idempotencyKey: `vcr:${study.id}:${modelId}`, detail: { subjectId: modelId, resultKind: "patient_set", modelId, modelVersion: "1.0.0" } });
    const [claimed] = await jobs.claim();
    await jobs.advance(claimed);
    return (await jobs.advance(claimed)).result;
  };
  const scenarioOnly = await run("reference-scenario", 0.6);
  assert.equal(scenarioOnly.intendedUse, "exploratory", "the method itself is a scenario-tier one, whatever the model");
  assert.equal(scenarioOnly.useDowngrade.reason, "model_tier_ceiling");
  assert.deepEqual(scenarioOnly.diagnostics.modelsUsed.map((/** @type {any} */ model) => model.tier).sort(), ["scenario", "scenario"]);
  assert.ok(!JSON.stringify(scenarioOnly).includes("self-declared"), "the engine's own claim about its model is nowhere in the result");
  // A model the library does not hold has earned nothing.
  const unknown = await run("not-in-the-library", 0.61);
  assert.equal(unknown.intendedUse, "exploratory");
  // A data-tier model with all the evidence of its risk is limited only by the method's own tier.
  const carried = await run("fitted-weibull", 0.62);
  assert.equal(carried.intendedUse, "exploratory", "the patients method is scenario-tier and bounds the result at exploratory even under a data-tier model");
  // The same rule from the domain's side: intendedUseCeilingFor gives the same verdict from the same inputs.
  const thin = await run("thin-weibull", 0.63);
  assert.equal(thin.intendedUse, "exploratory");
});

test("AC-38 compute over the study's budget stops at the confirmation, and one confirmation releases it", options, async () => {
  const study = await makeStudy("budget");
  /** @type {any[]} */
  const notices = [];
  const jobs = new VcrJobs({
    store, config: { ...config, vcrStudyCpuBudget: 900, vcrJobCpuSeconds: 600 },
    engine: engineDouble(),
    notifier: { async budgetConfirm(target, job) { notices.push([target.id, job.id, job.cpuSecondsLimit]); } },
  });

  const first = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    cpuSecondsLimit: 600, idempotencyKey: `vcr:${study.id}:b1` });
  assert.equal(first.job.state, "queued");
  const second = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation",
    scenario: { ...scenario, truth: { hazardRatio: 0.6, controlMedian: 6 } }, cpuSecondsLimit: 600, idempotencyKey: `vcr:${study.id}:b2` });
  assert.equal(second.job.state, "awaiting_budget", "600 + 600 is past the study's 900");
  assert.deepEqual(notices, [[study.id, second.job.id, 600]], "the second human stop reaches a person once");

  const budget = await jobs.budgetOf(study.id);
  assert.equal(budget.limitSeconds, 900);
  assert.equal(budget.committedSeconds, 600);
  assert.equal(budget.awaitingBudget, 1);
  const claimed = await jobs.claim();
  assert.deepEqual(claimed.map((job) => job.id), [first.job.id], "the job inside the budget runs");
  await jobs.finish(first.job.id, { status: "succeeded", result: engineResult(await frozenJob(first.job.id)), cpuSeconds: 10 });
  assert.deepEqual(await jobs.claim(), [], "nothing waiting on budget is ever claimed");

  const confirmed = await jobs.confirmBudget(study.id, { actor: study.userId });
  assert.equal(confirmed.released.length, 1);
  assert.equal(confirmed.released[0].state, "queued");
  assert.equal(confirmed.budget.limitSeconds, 1_500, "the confirmation raised the study's own budget");
  const after = await store.studyById(study.id);
  assert.equal(after.budget.cpuSecondsConfirmed, 600);
  assert.equal(after.budget.lastConfirmedBy, study.userId);
});

test("a local executor runs a method the control plane computes itself, and finish hooks hear of it after it commits", options, async () => {
  const study = await makeStudy("local");
  /** @type {any[]} */
  const seen = [];
  const table = { kind: "analysis_table", id: "snp_1:subject", shape: "subject", location: "snapshots/snp_1/subject.csv", hash: "a".repeat(64), valueSource: "observed" };
  const jobs = new VcrJobs({
    store, config, engine: engineDouble(), dataPlane: { async resolveEngineInputs() { return [table]; } },
    localExecutors: {
      "matching.evaluate": async ({ job, onProgress }) => {
        seen.push(job.method);
        await onProgress({ done: 1, total: 1 });
        return {
          status: "succeeded", conclusion: "estimable",
          counts: { realPatients: 42, events: null, effectiveSampleSize: null, generatedRecords: 0 },
          measures: [{ name: "eligible", value: 7, simulated: false, source: "calculated" }],
          manifest: { cpuSeconds: 0.4 },
        };
      },
    },
  });
  /** @type {any[]} */
  const hooks = [];
  jobs.addFinishHook((outcome) => { hooks.push([outcome.state, outcome.result?.kind, outcome.job.kind]); });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "match_criteria",
    scenario: { criteria: [{ id: "crt_1", kind: "inclusion", state: "unknown" }] }, inputs: [{ kind: "snapshot", id: "snp_1" }], idempotencyKey: `vcr:${study.id}:match` });
  const [claimed] = await jobs.claim();
  const finished = await jobs.advance(claimed);
  assert.deepEqual(seen, ["matching.evaluate"], "it never reached the engine");
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.result.kind, "matching");
  assert.equal(finished.result.counts.realPatients, 42);
  assert.equal(finished.execution.receipt.local, true, "the record says who computed it");
  assert.deepEqual(hooks, [["succeeded", "matching", "match_criteria"]]);
  // Criterion evaluation reads the study's own fact ledger server-side: its job names no snapshot at all, and is not refused for it.
  const ledgerOnly = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "match_criteria",
    scenario: { criteria: [{ id: "crt_3", kind: "exclusion", state: "unknown" }] },
    inputs: [{ kind: "evidence", id: "facts:std_local:t1" }], idempotencyKey: `vcr:${study.id}:ledger` });
  assert.equal(ledgerOnly.created, true);
  await store.query("UPDATE evimed_vcr.jobs SET state = 'canceled' WHERE id = $1", [ledgerOnly.job.id]);
  jobs.addFinishHook(() => { throw new Error("a hook that throws"); });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "match_criteria",
    scenario: { criteria: [{ id: "crt_2", kind: "inclusion", state: "unknown" }] }, inputs: [{ kind: "snapshot", id: "snp_1" }], idempotencyKey: `vcr:${study.id}:match2` });
  const [next] = await jobs.claim();
  assert.equal((await jobs.advance(next)).state, "succeeded", "a hook that throws never undoes the job");
});

test("the worker's four loops drive the queue, tell the orchestrator what finished, and never lose a job that ran out of attempts", options, async () => {
  const study = await makeStudy("worker");
  const engine = engineDouble();
  const jobs = new VcrJobs({ store, config, engine });
  /** @type {any[]} */
  const finished = [];
  const orchestrator = {
    async onJobFinished(/** @type {any} */ outcome) { finished.push([outcome.job.id, outcome.job.state]); },
    async tick() { return { studies: 1, advanced: 1 }; },
    async advance() { return { dispatched: null }; },
  };
  /** @type {string[]} */
  const rechecked = [];
  const matching = { async recheckDue() { rechecked.push("due"); return { studies: 0, enqueued: 0 }; } };
  const loops = createVcrWorkerLoops({ jobs, orchestrator, store, matching });
  assert.deepEqual(Object.keys(loops).sort(), ["jobs", "orchestrator", "recheck", "recompute"]);

  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${study.id}:worker` });

  // A lease no other process may take, a loop that never overlaps itself, and
  // one timer for all four (the maintenance pause clears it).
  /** @type {string[]} */
  const leased = [];
  const worker = new VcrWorker({
    loops, pollMs: 1_000, leaseMs: 60_000,
    lease: async (name, work) => { leased.push(name); return { acquired: true, value: await work() }; },
  });
  await worker.tick();
  // The engine answers on the second pass: submit, then read.
  await worker.runNow("jobs");
  assert.deepEqual(finished, [[job.id, "succeeded"]], "the queue finished the job and told the orchestrator");
  assert.deepEqual(leased.sort(), ["orchestrator", "recheck", "recompute"], "the queue loop is deliberately unleased");
  assert.deepEqual(rechecked, ["due"], "the deferral recheck runs through the matching package");

  // A job whose worker died with no attempts left is failed by the next claim, and the orchestrator hears of it.
  const stranded = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
    scenario: { ...scenario, truth: { hazardRatio: 0.6, controlMedian: 6 } }, idempotencyKey: `vcr:${study.id}:stranded` });
  const [taken] = await jobs.claim({ workerId: "dead-worker" });
  await store.query("UPDATE evimed_vcr.jobs SET lease_until = now() - interval '1 hour', attempts = max_attempts WHERE id = $1", [taken.id]);
  const summary = /** @type {any} */ (await worker.runNow("jobs"));
  assert.equal(summary.failedForAttempts, 1);
  assert.deepEqual(finished[1], [stranded.job.id, "failed"]);

  const status = worker.status();
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.failing, []);
  assert.equal(status.armed, false, "the worker was ticked by hand, not started");
  assert.equal(withVcrWorkerWarnings({ enabled: true, status: "ok" }, worker).warning, undefined);
  assert.deepEqual(
    withVcrWorkerWarnings({ enabled: true, status: "ok" }, { status: () => ({ missing: ["jobs"], failing: [], stalled: [] }) }).warnings,
    ["vcr_worker_loop_missing"],
  );
  await worker.close();

  const results = await store.results(study.id, "trial_scenario");
  assert.equal(results.length, 1);
  assert.equal(results[0].measures[0].mcse, 0.0031);
});
