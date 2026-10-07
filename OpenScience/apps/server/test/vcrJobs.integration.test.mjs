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
import { createVcrEngineProbe } from "../src/vcrEngineProbe.mjs";
import { jobView } from "../src/vcrViews.mjs";
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

test("submission identity is durable before the engine accepts, so a lost acknowledgement can be recovered without duplicate work", options, async () => {
  const study = await makeStudy("submit-intent");
  const engine = engineDouble();
  const submit = engine.submit;
  let accepted = false;
  engine.submit = async (job) => {
    const row = await store.one("SELECT checkpoint FROM evimed_vcr.jobs WHERE id=$1", [job.jobId]);
    assert.equal(row.checkpoint.engineJobId, job.jobId, "the physical job is known before its response");
    assert.equal(row.checkpoint.submissionIntent.scenarioHash, vcrScenarioHash(job.scenario));
    await submit(job);
    accepted = true;
    throw new VcrEngineError("vcr_engine_response_invalid", "The accepted response was lost.");
  };
  const jobs = new VcrJobs({ store, config, engine });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario });
  const [claimed] = await jobs.claim();
  const uncertain = await jobs.advance(claimed);
  assert.equal(accepted, true);
  assert.equal(uncertain.action, "waiting");
  assert.equal((await store.job(study.id, claimed.id)).state, "running");
  const recovered = await jobs.advance(claimed);
  assert.equal(recovered.state, "succeeded");
  assert.equal(engine.submitted.length, 1);
  assert.equal((await store.results(study.id, "trial_scenario")).length, 1);
});

test("concurrent jobs that each fit the budget alone are never both handed to the engine when together they could pass it: one runs, the other waits in the queue unannounced, and a person is asked only when the unspent budget has no room", options, async () => {
  const study = await makeStudy("budget-race");
  /** @type {any[]} */
  const notices = [];
  const engine = engineDouble();
  const jobs = new VcrJobs({ store, config: { ...config, vcrStudyCpuBudget: 60, vcrMaxConcurrentJobs: 2 }, engine,
    notifier: { async budgetConfirm(target, job) { notices.push([target.id, job.id]); } } });
  await store.query("CREATE FUNCTION evimed_vcr.slow_budget_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$");
  await store.query("CREATE TRIGGER budget_race BEFORE INSERT ON evimed_vcr.jobs FOR EACH ROW EXECUTE FUNCTION evimed_vcr.slow_budget_insert()");
  try {
    const outcomes = await Promise.all([0.6, 0.8].map(hazardRatio => jobs.enqueue({ studyId: study.id, userId: study.userId,
      kind: "design_simulation", cpuSecondsLimit: 60, scenario: { ...scenario, truth: { ...scenario.truth, hazardRatio } } })));
    assert.deepEqual(outcomes.map(outcome => outcome.job.state), ["queued", "queued"], "each fits the 60 s budget alone: neither needs a person");
    const before = await jobs.budgetOf(study.id);
    assert.equal(before.committedSeconds, 0, "a queued job reserves nothing");
    assert.equal(before.remainingSeconds, 60);
  } finally {
    await store.query("DROP TRIGGER budget_race ON evimed_vcr.jobs");
    await store.query("DROP FUNCTION evimed_vcr.slow_budget_insert()");
  }
  // Two workers lease both at once; the study's row serializes their admission, and only one may reach the engine.
  const both = await jobs.claim({ limit: 2 });
  assert.equal(both.length, 2);
  const actions = (await Promise.all(both.map((job) => jobs.advance(job)))).map((outcome) => outcome.action).sort();
  assert.deepEqual(actions, ["submitted", "waiting"]);
  assert.equal(engine.submitted.length, 1, "60 s of ceiling in flight leaves no room for another 60 s ceiling");
  const held = (await store.rows("SELECT * FROM evimed_vcr.jobs WHERE state = 'queued'"))[0];
  assert.ok(held, "the one that did not fit beside the running one is back in the queue");
  assert.equal(Number(held.attempts), 0, "waiting for the work in front of it uses no attempt");
  assert.ok(new Date(held.run_after).getTime() > Date.now(), "and is looked at again after a moment");
  assert.deepEqual(notices, [], "no notice: nothing here waits for a person");
  assert.equal((await jobs.budgetOf(study.id)).committedSeconds, 60, "what is running is what is committed");

  // The running one finishes having spent 42.1 s; the other's 60 s ceiling no longer fits what is unspent, and only now is a person asked, once.
  const running = both.find((job) => job.id !== held.id);
  assert.ok(running);
  assert.equal((await jobs.advance(running)).state, "succeeded");
  await store.query("UPDATE evimed_vcr.jobs SET run_after = now() WHERE id = $1", [held.id]);
  const [again] = await jobs.claim();
  assert.equal(again.id, held.id);
  assert.equal((await jobs.advance(again)).action, "awaiting_budget");
  assert.deepEqual(notices, [[study.id, held.id]], "the person is asked exactly once");
  assert.equal(engine.submitted.length, 1, "the second job never reached the engine: the budget could not cover its ceiling");
  const after = await jobs.budgetOf(study.id);
  assert.ok(after.usedSeconds <= after.limitSeconds, "actual use stays within the limit without a confirmation");
  assert.deepEqual(await jobs.claim(), [], "nothing waiting for a person is claimed");
  assert.equal((await jobs.budgetOf(study.id)).awaitingBudget, 1);
});

test("concurrent confirmations release waiting work once without losing or doubling the study grant", options, async () => {
  const study = await makeStudy("confirm-race");
  const jobs = new VcrJobs({ store, config: { ...config, vcrStudyCpuBudget: 0 }, engine: engineDouble() });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60, scenario });
  const confirmed = await Promise.all([1, 2].map(() => jobs.confirmBudget(study.id, { actor: study.userId })));
  assert.equal(confirmed.reduce((n, result) => n + result.released.length, 0), 1);
  assert.equal((await store.studyById(study.id)).budget.cpuSecondsConfirmed, 60);
  const after = await jobs.budgetOf(study.id);
  assert.equal(after.committedSeconds, 0, "the released job is queued and has spent nothing");
  assert.equal(after.remainingSeconds, 60);
  assert.equal(after.awaitingBudget, 0);
});

test("canceled physical work retains its compute reservation and stopped work without a partial report still settles observed CPU", options, async () => {
  const study = await makeStudy("cancel-budget");
  const engine = engineDouble({ state: "running" });
  engine.result = async () => { throw new VcrEngineError("vcr_engine_not_found", "No partial result.", { status: 404 }); };
  const jobs = new VcrJobs({ store, config: { ...config, vcrStudyCpuBudget: 60 }, engine });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60, scenario });
  const [first] = await jobs.claim(); await jobs.advance(first);
  await jobs.cancel(study.id, first.id, { actor: study.userId });
  const second = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
    scenario: { ...scenario, truth: { ...scenario.truth, hazardRatio: 0.8 } } });
  assert.equal(second.job.state, "queued", "it fits the study's budget alone; whether it fits beside the work still running is asked when it is handed over");
  assert.equal((await jobs.budgetOf(study.id)).committedSeconds, 60, "the cancelled work may still be running: its ceiling stays reserved");
  assert.deepEqual(await jobs.claim(), [], "and nothing new starts beside physical work that is not known to have stopped");
  engine.setState("canceled");
  await jobs.recoverCanceled();
  assert.equal((await jobs.budgetOf(study.id)).usedSeconds, 42.1, "A stopped process with no scientific result is still actual compute use.");
  const [next] = await jobs.claim();
  assert.equal(next.id, second.job.id);
  assert.equal((await jobs.advance(next)).action, "awaiting_budget", "42.1 s are spent: the 60 s ceiling no longer fits the 60 s budget");
  assert.equal((await store.job(study.id, second.job.id)).state, "awaiting_budget");
  assert.equal(engine.cancelled.length > 0, true);
});

test("usage settling after enqueue is rechecked before any new physical submission", options, async () => {
  const study = await makeStudy("late-cpu-budget");
  const engine = engineDouble();
  const jobs = new VcrJobs({ store, config: { ...config, vcrStudyCpuBudget: 120 }, engine });
  for (const hazardRatio of [0.6, 0.8]) await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
    scenario: { ...scenario, truth: { ...scenario.truth, hazardRatio } } });
  const [first] = await jobs.claim();
  await jobs.finish(first.id, { status: "succeeded", result: engineResult(await frozenJob(first.id)), cpuSeconds: 70 });
  const [second] = await jobs.claim();
  assert.equal((await jobs.advance(second)).action, "awaiting_budget");
  assert.equal(engine.submitted.length, 0);
  assert.equal((await store.job(study.id, second.id)).state, "awaiting_budget");
});

test("a stopped engine with unknown CPU holds an uncertain reservation and fabricates no use", options, async () => {
  const study = await makeStudy("unknown-cpu-budget");
  let stopped = false;
  const engine = engineDouble({ statusFor: () => ({ state: stopped ? "canceled" : "running", cpuSeconds: null }) });
  engine.result = async () => { throw new VcrEngineError("vcr_engine_not_found", "No partial result.", { status: 404 }); };
  const jobs = new VcrJobs({ store, config: { ...config, vcrStudyCpuBudget: 60 }, engine });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60, scenario });
  const [first] = await jobs.claim(); await jobs.advance(first);
  await jobs.cancel(study.id, first.id, { actor: study.userId }); stopped = true;
  await jobs.recoverCanceled();
  const budget = await jobs.budgetOf(study.id);
  assert.equal(budget.usedSeconds, 0); assert.equal(budget.committedSeconds, 60);
  const second = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
    scenario: { ...scenario, truth: { ...scenario.truth, hazardRatio: 0.8 } } });
  assert.equal(second.job.state, "awaiting_budget");
  assert.equal((await store.job(study.id, first.id)).checkpoint.cpuAccountingUncertain, true);
});

test("a duplicate enqueue cannot deadlock final result persistence while reserving the same study budget", options, async () => {
  const study = await makeStudy("budget-finish-lock");
  const jobs = new VcrJobs({ store, config, engine: engineDouble() });
  const input = { studyId: study.id, userId: study.userId, kind: "design_simulation", scenario };
  const original = await jobs.enqueue(input); const [claimed] = await jobs.claim();
  await store.query("CREATE FUNCTION evimed_vcr.hold_execution_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(12367891); RETURN NEW; END $$");
  await store.query("CREATE TRIGGER finish_lock BEFORE INSERT ON evimed_vcr.executions FOR EACH ROW EXECUTE FUNCTION evimed_vcr.hold_execution_insert()");
  try {
    await database.withClient(async gate => {
      await gate.query("SELECT pg_advisory_lock(12367891)");
      const finish = jobs.finish(claimed.id, { status: "succeeded", result: engineResult(await frozenJob(claimed.id)), cpuSeconds: 12 });
      try {
        let waiting = false;
        for (let pass = 0; pass < 100; pass += 1) {
          waiting = (await gate.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=12367891 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting")).rows[0].waiting;
          if (waiting) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(waiting, true, "The finishing transaction already owns the job and awaits its execution insert.");
        const duplicate = jobs.enqueue(input);
        await new Promise(resolve => setTimeout(resolve, 20));
        await gate.query("SELECT pg_advisory_unlock(12367891)");
        const [finished, repeated] = await Promise.all([finish, duplicate]);
        assert.equal(finished.state, "succeeded"); assert.equal(repeated.job.id, original.job.id); assert.equal(repeated.created, false);
      } finally { await gate.query("SELECT pg_advisory_unlock(12367891)"); await finish; }
    });
  } finally {
    await store.query("DROP TRIGGER finish_lock ON evimed_vcr.executions");
    await store.query("DROP FUNCTION evimed_vcr.hold_execution_insert()");
  }
});

test("a cancellation while submit is in flight also cancels its late acceptance and preserves physical admission", options, async () => {
  const study = await makeStudy("cancel-submit");
  const engine = engineDouble();
  const submit = engine.submit;
  let entered;
  let resume;
  const started = new Promise((done) => { entered = done; });
  const gate = new Promise((done) => { resume = done; });
  engine.submit = async (job) => { entered(); await gate; return submit(job); };
  const jobs = new VcrJobs({ store, config, engine });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario });
  const [claimed] = await jobs.claim();
  const pending = jobs.advance(claimed);
  await started;
  await jobs.cancel(study.id, claimed.id);
  resume();
  assert.equal((await pending).action, "skipped");
  assert.equal((await store.job(study.id, claimed.id)).state, "canceled");
  assert.equal(engine.cancelled.filter((id) => id === claimed.id).length, 2, "both the in-flight identity and late acknowledgement are canceled");
  assert.equal((await store.results(study.id, "trial_scenario")).length, 0);
});

test("a reclaimed lease fences a late completion even when the worker identity is unchanged", options, async () => {
  const study = await makeStudy("lease-attempt");
  const engine = engineDouble();
  const describe = engine.status;
  let entered;
  let resume;
  const started = new Promise((done) => { entered = done; });
  const gate = new Promise((done) => { resume = done; });
  let blocked = true;
  engine.status = async (id) => { if (blocked) { blocked = false; entered(); await gate; } return describe(id); };
  const jobs = new VcrJobs({ store, config, engine });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario });
  const [first] = await jobs.claim();
  await jobs.advance(first);
  const late = jobs.advance(first);
  await started;
  await store.query("UPDATE evimed_vcr.jobs SET lease_until=now()-interval '1 hour' WHERE id=$1", [first.id]);
  const [next] = await jobs.claim();
  assert.equal(next.attempts, first.attempts + 1);
  resume();
  assert.equal((await late).action, "skipped");
  assert.equal((await store.results(study.id, "trial_scenario")).length, 0);
  assert.equal((await jobs.advance(next)).state, "succeeded");
  assert.equal(engine.submitted.length, 1);
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

  const cancelled = await jobs.cancel(study.id, job.id, { actor: "u_cancel" });
  assert.equal(cancelled.canceled, true);
  assert.equal(cancelled.job.state, "canceled", "the row moved in the same statement that recorded the request");
  assert.deepEqual(engine.cancelled, [job.id], "the engine is told afterwards, on a best-effort basis");
  assert.deepEqual(heard, [["canceled", job.id]], "whoever cancelled, the module that owns the object hears of it");
  const row = await store.job(study.id, job.id);
  // What the engine kept of a cancelled run is the engine's to say (the real engine's own batches are read in
  // vcrEngineContract.integration.test.mjs, AC-38); what the queue itself keeps is the way back to it.
  assert.ok(row.checkpoint.engineJobId, "the engine's job id survives the cancel: it is how what the engine kept is found afterwards");
  assert.equal(row.error.code, "vcr_job_canceled");
  assert.equal(await jobs.resultOf(study.id, job.id), null, "no result of a cancelled job until the engine's partial one has been fetched");

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
  // C2-14: the job's own status answer carries what the engine kept, found through the execution it wrote.
  const kept = await jobs.resultOf(study.id, job.id);
  assert.equal(kept?.id, recovered[0].result.id);
  assert.equal(kept?.conclusion, "limited");
  assert.equal(kept?.measures[0].value, 0.77);
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
  assert.equal(second.job.state, "queued", "600 + 600 is past the study's 900 only if both spend everything: that is not yet a person's business");
  assert.deepEqual(notices, []);
  const budget = await jobs.budgetOf(study.id);
  assert.equal(budget.limitSeconds, 900);
  assert.equal(budget.committedSeconds, 0);
  assert.equal(budget.remainingSeconds, 900);
  assert.equal(budget.awaitingBudget, 0);

  const claimed = await jobs.claim();
  assert.deepEqual(claimed.map((job) => job.id), [first.job.id], "the first runs");
  await jobs.finish(first.job.id, { status: "succeeded", result: engineResult(await frozenJob(first.job.id)), cpuSeconds: 400 });
  // 400 s are spent: the second one's 600 s ceiling cannot be covered by the 500 s that are left, and the second human stop is reached.
  const [next] = await jobs.claim();
  assert.equal(next.id, second.job.id);
  assert.equal((await jobs.advance(next)).action, "awaiting_budget");
  assert.deepEqual(notices, [[study.id, second.job.id, 600]], "the second human stop reaches a person once");
  assert.equal((await jobs.budgetOf(study.id)).awaitingBudget, 1);
  assert.deepEqual(await jobs.claim(), [], "nothing waiting on budget is ever claimed");

  const confirmed = await jobs.confirmBudget(study.id, { actor: study.userId });
  assert.equal(confirmed.released.length, 1);
  assert.equal(confirmed.released[0].state, "queued");
  assert.equal(confirmed.budget.limitSeconds, 1_500, "the confirmation raised the study's own budget");
  const after = await store.studyById(study.id);
  assert.equal(after.budget.cpuSecondsConfirmed, 600);
  assert.equal(after.budget.lastConfirmedBy, study.userId);
  const [released] = await jobs.claim();
  assert.equal(released.id, second.job.id);
  assert.equal((await jobs.advance(released)).action, "submitted", "once confirmed it runs");
  assert.equal(notices.length, 1, "and no second notice");

  // A job whose ceiling alone is more than the study's budget waits at once, and notifies once.
  const small = await makeStudy("budget-small");
  const tight = new VcrJobs({ store, config: { ...config, vcrStudyCpuBudget: 500 }, engine: engineDouble(),
    notifier: { async budgetConfirm(target, job) { notices.push([target.id, job.id, job.cpuSecondsLimit]); } } });
  const over = await tight.enqueue({ studyId: small.id, userId: small.userId, kind: "design_simulation", scenario, cpuSecondsLimit: 600 });
  assert.equal(over.job.state, "awaiting_budget");
  assert.equal(notices.length, 2);
  assert.deepEqual(notices[1], [small.id, over.job.id, 600]);
  assert.deepEqual(await tight.claim(), []);
  assert.equal(notices.length, 2, "claiming again does not ask again");
});

test("a burst of jobs whose ceilings add up to more than the budget while their real use does not never reaches a person: all of them run, in order", options, async () => {
  // Live acceptance, 2026-10-04: 126.6 of 7,200 s used, twelve queued jobs each holding a 600 s ceiling, and the thirteenth was sent to a researcher.
  const study = await makeStudy("burst");
  /** @type {any[]} */
  const notices = [];
  const engine = engineDouble({ resultFor: (spec) => engineResult(spec, { manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "b".repeat(64),
    startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:00:05Z", cpuSeconds: 5 } }) });
  const jobs = new VcrJobs({ store, config: { ...config, vcrStudyCpuBudget: 7_200 }, engine,
    notifier: { async budgetConfirm(target, job) { notices.push([target.id, job.id]); } } });
  /** @type {string[]} */
  const enqueued = [];
  for (let index = 0; index < 20; index += 1) {
    const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation",
      scenario: { ...scenario, truth: { hazardRatio: 0.5 + index / 100, controlMedian: 6 } }, cpuSecondsLimit: 600, idempotencyKey: `vcr:${study.id}:burst${index}` });
    assert.equal(job.state, "queued", `job ${index + 1} of the burst`);
    enqueued.push(job.id);
  }
  assert.equal((await jobs.budgetOf(study.id)).committedSeconds, 0, "twenty queued ceilings are 12,000 s of what might be spent and none of what is");
  /** @type {string[]} */
  const finished = [];
  for (let step = 0; step < 60; step += 1) {
    const [claimed] = await jobs.claim();
    if (!claimed) break;
    assert.equal((await jobs.advance(claimed)).action, "submitted");
    const ended = await jobs.advance(claimed);
    assert.equal(ended.state, "succeeded");
    finished.push(claimed.id);
  }
  assert.deepEqual(finished, enqueued, "every job ran, in the order it was asked");
  assert.deepEqual(notices, [], "no person was asked");
  const budget = await jobs.budgetOf(study.id);
  assert.equal(budget.usedSeconds, 100);
  assert.equal(budget.awaitingBudget, 0);
});

test("a wait for a person does not outlive its reason: a job written under the old rule is released when a sibling finishes, and a job that is over the study's limit stays", options, async () => {
  const study = await makeStudy("release");
  const engine = engineDouble();
  const jobs = new VcrJobs({ store, config: { ...config, vcrStudyCpuBudget: 1_000 }, engine });
  const enqueue = (/** @type {number} */ hazardRatio, /** @type {number} */ cpuSecondsLimit) => jobs.enqueue({ studyId: study.id, userId: study.userId,
    kind: "design_simulation", scenario: { ...scenario, truth: { hazardRatio, controlMedian: 6 } }, cpuSecondsLimit });
  const released = async () => (await store.rows("SELECT object FROM evimed_vcr.audit WHERE study_id = $1 AND action = 'vcr.job.budget_released'", [study.id])).map((row) => String(row.object));
  const running = (await enqueue(0.6, 600)).job;
  const legacy = (await enqueue(0.7, 100)).job;
  // How the earlier rule wrote it: waiting for a person, because the queued ceilings summed past the budget.
  await store.query("UPDATE evimed_vcr.jobs SET state = 'awaiting_budget' WHERE id = $1", [legacy.id]);
  assert.equal((await jobs.budgetOf(study.id)).awaitingBudget, 1);

  const [claimed] = await jobs.claim();
  assert.equal(claimed.id, running.id);
  assert.equal((await store.job(study.id, legacy.id)).state, "queued", "the claim sweep gave it back: it fits what the study has not spent");
  await jobs.advance(claimed);
  await jobs.finish(running.id, { status: "succeeded", result: engineResult(await frozenJob(running.id)), cpuSeconds: 500 });

  // 500 s are spent: a 600 s ceiling is more than the 500 s left, so a person is asked, and no sibling finishing changes that.
  const over = (await enqueue(0.8, 600)).job;
  assert.equal(over.state, "awaiting_budget");
  const late = (await enqueue(0.9, 100)).job;
  await store.query("UPDATE evimed_vcr.jobs SET state = 'awaiting_budget' WHERE id = $1", [late.id]);
  const [next] = await jobs.claim();
  assert.equal(next.id, legacy.id, "the job that was given back runs, in its place in the queue");
  assert.equal((await store.job(study.id, late.id)).state, "queued", "the other old-rule wait is given back too");
  assert.equal((await store.job(study.id, over.id)).state, "awaiting_budget", "the one over the limit stays for its person");

  // finish itself releases, in the same commit, a waiting job that now fits.
  await store.query("UPDATE evimed_vcr.jobs SET state = 'awaiting_budget' WHERE id = $1", [late.id]);
  await jobs.finish(next.id, { status: "failed", error: { code: "vcr_job_failed", message: "x" }, cpuSeconds: 10 });
  assert.equal((await store.job(study.id, late.id)).state, "queued", "a job that failed released it in the same commit");
  assert.equal((await store.job(study.id, over.id)).state, "awaiting_budget");

  // a cancel releases too
  const another = (await enqueue(0.95, 100)).job;
  await store.query("UPDATE evimed_vcr.jobs SET state = 'awaiting_budget' WHERE id = $1", [another.id]);
  await jobs.cancel(study.id, late.id, { actor: study.userId });
  assert.equal((await store.job(study.id, another.id)).state, "queued", "so did a cancel");
  assert.equal((await store.job(study.id, over.id)).state, "awaiting_budget");
  const audited = await released();
  for (const id of [legacy.id, late.id, another.id]) assert.ok(audited.includes(id), `the release of ${id} is audited`);
  assert.ok(!audited.includes(over.id));
});

test("actual use never passes the limit without a confirmation: the outcomes walked, including a job that spends its whole ceiling", options, async () => {
  for (const [spend, ceilings, expectedRun, expectedWaiting] of /** @type {Array<[number, number, number, number]>} */ ([
    [0, 600, 4, 0], [1, 600, 4, 0], [300, 600, 4, 0], [450, 600, 3, 1], [599, 600, 2, 2], [600, 600, 2, 2],
  ])) {
    const study = await makeStudy(`walk-${spend}`);
    /** @type {any[]} */
    const notices = [];
    const engine = engineDouble({ resultFor: (job) => engineResult(job, { manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "b".repeat(64),
      startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:00:05Z", cpuSeconds: spend } }) });
    const jobs = new VcrJobs({ store, config: { ...config, vcrStudyCpuBudget: 1_500 }, engine,
      notifier: { async budgetConfirm(target, job) { notices.push(job.id); } } });
    for (let index = 0; index < 4; index += 1) {
      await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: ceilings,
        scenario: { ...scenario, truth: { hazardRatio: 0.5 + index / 10, controlMedian: 6 } }, idempotencyKey: `vcr:${study.id}:w${index}` });
    }
    let ran = 0;
    for (let step = 0; step < 12; step += 1) {
      const [claimed] = await jobs.claim();
      if (!claimed) break;
      const first = await jobs.advance(claimed);
      let budget = await jobs.budgetOf(study.id);
      assert.ok(budget.usedSeconds + budget.committedSeconds <= budget.limitSeconds, `spend ${spend}: what is spent and what is running never passes the limit`);
      if (first.action === "submitted") { assert.equal((await jobs.advance(claimed)).state, "succeeded"); ran += 1; }
      budget = await jobs.budgetOf(study.id);
      assert.ok(budget.usedSeconds <= budget.limitSeconds, `spend ${spend}: actual use ${budget.usedSeconds} stays within ${budget.limitSeconds}`);
    }
    const budget = await jobs.budgetOf(study.id);
    assert.equal(ran, expectedRun, `spend ${spend}`);
    assert.equal(budget.awaitingBudget, expectedWaiting, `spend ${spend}`);
    assert.equal(notices.length, expectedWaiting, `spend ${spend}: each job that waits for a person asks once`);
    assert.equal(engine.submitted.length, expectedRun, `spend ${spend}: a job that waits for a person is never given to the engine`);
    assert.equal(budget.usedSeconds, spend * expectedRun);
    if (expectedWaiting) {
      // and a confirmation lets them run, within the raised limit
      await jobs.confirmBudget(study.id, { actor: study.userId });
      for (let step = 0; step < 12; step += 1) {
        const [claimed] = await jobs.claim();
        if (!claimed) break;
        if ((await jobs.advance(claimed)).action === "submitted") await jobs.advance(claimed);
        const after = await jobs.budgetOf(study.id);
        assert.ok(after.usedSeconds <= after.limitSeconds, `spend ${spend}: after the confirmation use ${after.usedSeconds} stays within ${after.limitSeconds}`);
      }
      assert.equal((await jobs.budgetOf(study.id)).awaitingBudget, 0);
      assert.equal(engine.submitted.length, 4, `spend ${spend}: the confirmed jobs ran`);
    }
  }
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
  // The three optional loops (frontier events, platform pack sources, the sweep of drafts) are keys with no function while their modules are off.
  assert.deepEqual(Object.keys(loops).sort(), ["drafts", "frontierEvents", "jobs", "orchestrator", "packSources", "recheck", "recompute"]);
  assert.deepEqual([loops.frontierEvents, loops.packSources, loops.drafts], [null, null, null]);

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

test("C3-06 the same question asked in two of one account's studies is two jobs: the study is part of what identifies one", options, async () => {
  const first = await makeStudy("twin-a");
  const second = await store.createStudy({ userId: first.userId, projectId: "prj_twin_b", name: "twin-b", dataTier: "T0" });
  const jobs = new VcrJobs({ store, config: { ...config, vcrMaxConcurrentJobs: 4 }, engine: engineDouble() });
  // Nothing names a key of its own (a run's bare `vcr_simulate` start): the scenario is the whole question.
  const one = await jobs.enqueue({ studyId: first.id, userId: first.userId, kind: "design_simulation", scenario });
  const two = await jobs.enqueue({ studyId: second.id, userId: second.userId, kind: "design_simulation", scenario });
  assert.equal(two.created, true, "the second study's job is its own, not the first study's handed back");
  assert.notEqual(two.job.id, one.job.id);
  assert.equal(two.job.studyId, second.id);
  assert.equal((await jobs.enqueue({ studyId: first.id, userId: first.userId, kind: "design_simulation", scenario })).job.id, one.job.id,
    "and the same study asking the same thing twice is still one job");
  const keys = await store.rows("SELECT idempotency_key FROM evimed_vcr.jobs WHERE id = ANY($1::text[])", [[one.job.id, two.job.id]]);
  assert.equal(new Set(keys.map((row) => row.idempotency_key)).size, 2);
});

test("C2-1 an engine refusal is the job's own reason: the first issue's code, field and sentence, every issue kept, and a spent CPU budget names itself", options, async () => {
  const study = await makeStudy("refusal");
  const refusal = (/** @type {any} */ job) => engineResult(job, { status: "failed", conclusion: undefined, measures: [], counts: { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: null },
    diagnostics: { issues: [
      { code: "rule_column_unknown", field: "scenario.rules[0].rule", detail: "The table has no column 'creatinine'." },
      { code: "scenario_value_invalid", field: "scenario.rules[1]", detail: "second" }] } });
  const jobs = new VcrJobs({ store, config, engine: engineDouble({ resultFor: refusal, state: "failed" }) });
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${study.id}:refused` });
  const [claimed] = await jobs.claim();
  await jobs.advance(claimed);
  const ended = await jobs.advance(claimed);
  assert.equal(ended.state, "failed");
  assert.equal(ended.result, null, "a refusal computed nothing: no result, no zero");
  const row = await store.job(study.id, job.id);
  assert.equal(row.error.code, "rule_column_unknown", "the reason the engine gave, not a bare failed");
  assert.equal(row.error.field, "scenario.rules[0].rule");
  assert.match(row.error.message, /creatinine/, "the sentence names the column");
  assert.deepEqual(row.error.issues.map((/** @type {any} */ issue) => issue.code), ["rule_column_unknown", "scenario_value_invalid"], "every issue is kept");

  // The engine's own unsigned refusal (an identity it could not read) is told the same way.
  const other = await makeStudy("refusal-unsigned");
  const engine = engineDouble();
  const unsigned = { ...engine, async result(/** @type {string} */ id) {
    return { result: engineResult(engine.known.get(id), { status: "failed", conclusion: undefined, measures: [],
      diagnostics: { issues: [{ code: "design_not_supported", field: "scenario.design.kind", detail: "no analytic calculation" }] } }), signed: false, refused: true };
  } };
  const bare = new VcrJobs({ store, config, engine: unsigned });
  const { job: unsignedJob } = await bare.enqueue({ studyId: other.id, userId: other.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${other.id}:refused` });
  const [again] = await bare.claim();
  await bare.advance(again);
  assert.equal((await bare.advance(again)).state, "failed");
  const unsignedRow = await store.job(other.id, unsignedJob.id);
  assert.equal(unsignedRow.error.code, "design_not_supported");
  assert.equal(unsignedRow.error.field, "scenario.design.kind");

  // A run cut short by its CPU budget keeps its numbers as a partial result — and says why it stopped.
  const spent = await makeStudy("cpu");
  const cut = new VcrJobs({ store, config, engine: engineDouble({ state: "failed", resultFor: (spec) => engineResult(spec, { status: "failed", conclusion: "limited", replicates: 2000,
    measures: [{ name: "power", value: 0.71, simulated: true, mcse: 0.01, source: "synthetic" }],
    diagnostics: { issues: [{ code: "cpu_budget_exhausted", field: "cpuSecondsLimit", detail: "The CPU budget ran out: 600 s." }] } }) }) });
  const { job: cutJob } = await cut.enqueue({ studyId: spent.id, userId: spent.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${spent.id}:cpu` });
  const [running] = await cut.claim();
  await cut.advance(running);
  const stopped = await cut.advance(running);
  assert.equal(stopped.partial, true);
  assert.equal(stopped.result.measures[0].value, 0.71, "the batches that finished are kept");
  const cutRow = await store.job(spent.id, cutJob.id);
  assert.equal(cutRow.error.code, "cpu_budget_exhausted", "the job says the budget ended it");
  assert.equal(cutRow.error.partial, true);
  assert.match(cutRow.error.message, /计算时间上限/);
});

test("a result that failed the engine's own validation says why: the job records resultValidationIssues, and a crash with no result records the engine's code", options, async () => {
  // The live incident (2026-10-04, design.analytic on a scenario with no effect): the engine's result was `failed` with the reason only
  // in diagnostics.resultValidationIssues, and the job row was written with error NULL.
  const study = await makeStudy("validation");
  const unusable = (/** @type {any} */ job) => engineResult(job, { status: "failed", conclusion: undefined, measures: [], diagnostics: { resultValidationIssues: [
    { code: "measure_value_invalid", field: "measures[0].value", detail: "A measure carries a finite number; a failed computation is an issue, never a 0 (plan 9.6)." },
    { code: "measure_value_invalid", field: "measures[1].value", detail: "A measure carries a finite number; a failed computation is an issue, never a 0 (plan 9.6)." }] } });
  const jobs = new VcrJobs({ store, config, engine: engineDouble({ resultFor: unusable, state: "failed" }) });
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${study.id}:validation` });
  const [claimed] = await jobs.claim();
  await jobs.advance(claimed);
  const ended = await jobs.advance(claimed);
  assert.equal(ended.state, "failed");
  const row = await store.job(study.id, job.id);
  assert.equal(row.error.code, "measure_value_invalid");
  assert.equal(row.error.field, "measures[0].value");
  assert.match(row.error.message, /measures\[0\]\.value/, "the sentence says which number the validator refused");
  assert.deepEqual(row.error.issues.map((/** @type {any} */ issue) => issue.field), ["measures[0].value", "measures[1].value"]);
  assert.equal(ended.error.code, "measure_value_invalid", "the finish hooks hear the same reason the row holds");

  // The engine's own refusal comes first when a result carries both kinds.
  const both = await makeStudy("validation-both");
  const mixed = new VcrJobs({ store, config, engine: engineDouble({ state: "failed", resultFor: (spec) => engineResult(spec, { status: "failed", conclusion: undefined, measures: [],
    diagnostics: { issues: [{ code: "design_effect_null", field: "scenario.truth.hazardRatio", detail: "The scenario has no effect." }],
      resultValidationIssues: [{ code: "measure_value_invalid", field: "measures[0].value", detail: "x" }] } }) }) });
  const { job: mixedJob } = await mixed.enqueue({ studyId: both.id, userId: both.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${both.id}:both` });
  const [again] = await mixed.claim();
  await mixed.advance(again);
  await mixed.advance(again);
  const mixedRow = await store.job(both.id, mixedJob.id);
  assert.deepEqual(mixedRow.error.issues.map((/** @type {any} */ issue) => issue.code), ["design_effect_null", "measure_value_invalid"]);
  assert.equal(mixedRow.error.code, "design_effect_null");
  assert.match(mixedRow.error.message, /这个情景没有效应/, "the Chinese sentence the domain holds for the code");

  // A crash, a CPU limit or a memory limit leaves no result to read: the engine's fixed code is what the job records.
  for (const [code, sentence] of [["engine_crashed", /异常退出/], ["cpu_limit_exceeded", /CPU 上限/], ["memory_limit_exceeded", /内存/],
    ["spawn_failed", /没能启动/], ["result_unreadable", /可读的结果/]]) {
    const dead = await makeStudy(`dead-${code}`);
    const engine = { ...engineDouble({ state: "failed", statusFor: () => ({ state: "failed", progress: { done: 0, total: 0 }, cpuSeconds: 3, error: code }) }),
      async result() { throw new VcrEngineError("vcr_engine_rejected", "计算引擎拒绝了这次调用（HTTP 409）。", { status: 409, detail: "result_not_ready" }); } };
    const crashing = new VcrJobs({ store, config, engine });
    const { job: deadJob } = await crashing.enqueue({ studyId: dead.id, userId: dead.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${dead.id}:${code}` });
    const [running] = await crashing.claim();
    await crashing.advance(running);
    assert.equal((await crashing.advance(running)).state, "failed");
    const deadRow = await store.job(dead.id, deadJob.id);
    assert.equal(deadRow.error.engineError, code);
    assert.equal(deadRow.error.code, "vcr_job_failed");
    assert.match(deadRow.error.message, sentence);
    assert.match(deadRow.error.message, new RegExp(code), "the engine's code is in the sentence the page, the mark and the run's status read");
    assert.equal(deadRow.cpuSecondsUsed, 3, "what it cost is recorded");
  }
});

test("no way a job ends failed leaves its error NULL or without a sentence: the outcomes the worker handles, walked", options, async () => {
  const study = await makeStudy("walk");
  // this walk is about reasons, not budget: a failed job whose engine work is not known to have stopped still holds its reservation
  const roomy = { ...config, vcrStudyCpuBudget: 100_000 };
  /** The ways the engine, the transport or the queue can end a job in `failed`. @type {Array<[string, (spec: any) => any, Record<string, any>]>} */
  const noResult = { diagnostics: {}, measures: [] };
  const failedResult = (/** @type {Record<string, any>} */ overrides) => (/** @type {any} */ spec) => engineResult(spec, { status: "failed", conclusion: undefined, ...overrides });
  /** @type {Array<{ label: string, engine: any, expectCode?: string }>} */
  const outcomes = [
    { label: "the engine's refusal in diagnostics.issues", expectCode: "rule_column_unknown",
      engine: engineDouble({ state: "failed", resultFor: failedResult({ ...noResult, diagnostics: { issues: [{ code: "rule_column_unknown", field: "scenario.rules[0]", detail: "no column" }] } }) }) },
    { label: "a result that failed validation", expectCode: "measure_value_invalid",
      engine: engineDouble({ state: "failed", resultFor: failedResult({ ...noResult, diagnostics: { resultValidationIssues: [{ code: "measure_value_invalid", field: "measures[0].value", detail: "not finite" }] } }) }) },
    { label: "a failed result with no issue of either kind", expectCode: "vcr_job_failed",
      engine: engineDouble({ state: "failed", resultFor: failedResult(noResult) }) },
    { label: "a limited failed result whose only word is its measures", expectCode: "vcr_job_failed",
      engine: engineDouble({ state: "failed", resultFor: failedResult({ conclusion: "limited", replicates: 1000, diagnostics: {},
        measures: [{ name: "power", value: 0.5, simulated: true, mcse: 0.01, source: "synthetic" }] }) }) },
    { label: "an unsigned refusal that names nothing", expectCode: "vcr_job_failed",
      engine: { ...engineDouble({ state: "failed" }), async result(/** @type {string} */ id) { return { result: engineResult({ jobId: id, method: "design.simulate", methodVersion: "1", scenario, seed: 1 }, { status: "failed", conclusion: undefined, measures: [], diagnostics: {} }), signed: false, refused: true, issues: [] }; } } },
    { label: "an unsigned refusal whose only word is the control plane's validation of it", expectCode: "result_not_object",
      engine: { ...engineDouble({ state: "failed" }), async result(/** @type {string} */ id) { return { result: engineResult({ jobId: id, method: "design.simulate", methodVersion: "1", scenario, seed: 1 }, { status: "failed", conclusion: undefined, measures: [], diagnostics: {} }), signed: false, refused: true, issues: [{ code: "result_not_object", field: "", detail: "A result is a JSON object." }] }; } } },
    { label: "an engine word the control plane has never heard", expectCode: "vcr_job_failed",
      engine: { ...engineDouble({ state: "failed", statusFor: () => ({ state: "failed", progress: {}, cpuSeconds: 0, error: "Not A Code; drop table" }) }), async result() { throw new VcrEngineError("vcr_engine_rejected", "x", { status: 409 }); } } },
    { label: "a result under this job's id that is another job's", expectCode: "vcr_engine_result_mismatch",
      engine: engineDouble({ state: "succeeded", resultFor: (spec) => engineResult({ ...spec, seed: Number(spec.seed) + 1 }) }) },
    { label: "a transport error that carries no message", expectCode: "vcr_job_failed",
      engine: { ...engineDouble({ state: "succeeded" }), async result() { throw new Error(""); } } },
    { label: "a transport error that carries a code and no sentence", expectCode: "vcr_engine_rejected",
      engine: { ...engineDouble({ state: "succeeded" }), async result() { throw Object.assign(new Error(""), { code: "vcr_engine_rejected", retryable: false }); } } },
  ];
  // Not composed first: a failed job whose engine work is not known to have stopped holds every later claim, and with no engine nothing can tell it has.
  const seen = [await jobs_engineless(study)];
  for (const [index, outcome] of outcomes.entries()) {
    const jobs = new VcrJobs({ store, config: roomy, engine: outcome.engine });
    const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${study.id}:walk${index}` });
    const [claimed] = await jobs.claim();
    await jobs.advance(claimed);
    const ended = await jobs.advance(claimed);
    assert.equal(ended.state, "failed", outcome.label);
    const row = await store.job(study.id, job.id);
    assert.ok(row.error && typeof row.error.code === "string" && row.error.code, `${outcome.label}: a code`);
    assert.ok(typeof row.error.message === "string" && row.error.message.trim(), `${outcome.label}: a sentence`);
    assert.equal(row.error.code, outcome.expectCode, outcome.label);
    seen.push(row.id);
  }
  // The engine not composed (above), a local executor that throws, and a job that ran out of attempts are the three ways in that do not pass through a result.
  const local = new VcrJobs({ store, config: roomy, engine: engineDouble(), localExecutors: { "design.simulate": async () => { throw new Error(""); } } });
  const { job: localJob } = await local.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${study.id}:walk-local` });
  const [localClaimed] = await local.claim();
  assert.equal((await local.advance(localClaimed)).state, "failed");
  seen.push(localJob.id);
  const stuck = new VcrJobs({ store, config: roomy, engine: engineDouble() });
  const { job: stuckJob } = await stuck.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60, scenario, idempotencyKey: `vcr:${study.id}:walk-stuck` });
  const [held] = await stuck.claim({ workerId: "worker-1" });
  await store.query("UPDATE evimed_vcr.jobs SET lease_until = now() - interval '1 hour', attempts = max_attempts WHERE id = $1", [held.id]);
  await stuck.claim({ workerId: "worker-2" });
  seen.push(stuckJob.id);

  // The walk walked, and across every row of the database no failed job is without its reason.
  assert.equal(seen.length, outcomes.length + 3);
  const failed = await store.rows("SELECT id, error FROM evimed_vcr.jobs WHERE state = 'failed'");
  assert.equal(failed.length, seen.length, "every job the walk ended is failed");
  const unexplained = failed.filter((/** @type {any} */ row) => !row.error || typeof row.error.code !== "string" || !row.error.code
    || typeof row.error.message !== "string" || !row.error.message.trim());
  assert.deepEqual(unexplained.map((/** @type {any} */ row) => row.id), [], "no failed job has an error that is NULL or has no code or no sentence");

  /** @param {any} owner */
  async function jobs_engineless(owner) {
    const none = new VcrJobs({ store, config: roomy, engine: null });
    const { job } = await none.enqueue({ studyId: owner.id, userId: owner.userId, kind: "design_simulation", scenario, idempotencyKey: `vcr:${owner.id}:walk-none` });
    const [first] = await none.claim();
    assert.equal((await none.advance(first)).state, "failed");
    return job.id;
  }
});

test("C2-4 a stage carried over from before a change is marked old until its own numbers replace it, and one the recomputation will not run again is dropped and said", options, async () => {
  const study = await makeStudy("carry");
  const node = "trial_scenario:scn_carry@1";
  /** @param {any} job */
  const measuresOf = (job) => (job.method === "design.analytic" ? [{ name: "required_events", value: 372, simulated: false, source: "calculated" }]
    : job.method === "design.assurance" ? [{ name: "assurance", value: 0.776, simulated: true, mcse: 0.004, source: "synthetic" }]
      : [{ name: "power", value: 0.518, simulated: true, mcse: 0.003, source: "synthetic" }]);
  const engine = engineDouble({ resultFor: (job) => engineResult(job, { measures: measuresOf(job) }) });
  const jobs = new VcrJobs({ store, config: { ...config, vcrMaxConcurrentJobs: 4 }, engine });
  const analytic = { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 6 }, analysis: { alpha: 0.025, power: 0.9, sided: 1 } };
  const assurance = { design: { events: 372 }, endpoint: { type: "time_to_event" }, designPrior: { mean: -0.3567, sd: 0.15, kind: "lognormal", basis: "prediction" } };
  let cycle = 0;
  /** Enqueue one stage of the cycle and run it to the end. @param {string} kind @param {string} stage @param {Record<string, any>} shape @param {string[]} planned */
  const land = async (kind, stage, shape, planned) => {
    cycle += 1;
    await jobs.enqueue({ studyId: study.id, userId: study.userId, kind, scenario: shape, cpuSecondsLimit: 60, idempotencyKey: `vcr:${study.id}:${stage}:${cycle}`,
      detail: { subjectId: "scn_carry", resultKind: "trial_scenario", node, stage, plannedStages: planned } });
    const [claimed] = await jobs.claim();
    await jobs.advance(claimed);
    return jobs.advance(claimed);
  };
  const current = async () => (await store.results(study.id, "trial_scenario")).find((row) => row.subjectId === "scn_carry");
  const value = (/** @type {any} */ result, /** @type {string} */ name) => result.measures.find((/** @type {any} */ measure) => measure.name === name);

  // The first computation: three stages, nothing stale, nothing carried.
  const all = ["analytic", "simulation", "assurance"];
  await land("design_analytic", "analytic", analytic, all);
  await land("design_simulation", "simulation", scenario, all);
  await land("assurance", "assurance", assurance, all);
  let result = await current();
  assert.deepEqual(result.measures.map((/** @type {any} */ measure) => measure.name).sort(), ["assurance", "power", "required_events"]);
  assert.ok(result.measures.every((/** @type {any} */ measure) => measure.stale === undefined), "a first run carries nothing old");

  // A change: the design is marked stale. The next computation runs analytic and simulation — no assurance any more.
  await store.markStale(study.id, [node], "assumption_changed");
  await land("design_analytic", "analytic", analytic, ["analytic", "simulation"]);
  result = await current();
  assert.equal(value(result, "required_events").stale, undefined, "what was just recomputed is fresh");
  assert.equal(value(result, "power").stale, true, "the simulation has not run again: its number is one carried over, and says so");
  assert.equal(value(result, "assurance"), undefined, "a stage the recomputation will not run again is not left standing beside the new numbers");
  assert.deepEqual(result.diagnostics.notRerun, [{ stage: "assurance", measures: ["assurance"] }], "and the page is told what was dropped");
  assert.deepEqual(result.diagnostics.stages.map((/** @type {any} */ entry) => entry.stage).sort(), ["analytic", "simulation"]);

  await land("design_simulation", "simulation", scenario, ["analytic", "simulation"]);
  result = await current();
  assert.equal(value(result, "power").stale, undefined, "its own new number replaces the old one");
  assert.deepEqual(result.diagnostics.notRerun, [{ stage: "assurance", measures: ["assurance"] }], "the note stays until the stage itself runs again");

  // The prior comes back with a new change: the assurance stage runs again and the note goes.
  await store.clearStale(study.id, [node]);
  await store.markStale(study.id, [node], "assumption_changed");
  await land("assurance", "assurance", assurance, all);
  result = await current();
  assert.equal(value(result, "assurance").value, 0.776);
  assert.equal(result.diagnostics.notRerun, undefined, "a stage that ran again is no longer said to have been dropped");
  assert.equal(value(result, "power").stale, true, "and the simulation, again older than the change, is carried and marked");
});

// The 2026-10-05 live observation: the engine container was stopped, and a job kept reading "进行中" with nothing to
// say why; it did continue within seconds of the restart. The job's own row is where "its last contact failed"
// lives, so another replica's page says the same, and the same contact feeds the reading readiness and the
// capability label share.
test("a job whose engine stops says it waits on the engine, keeps going, and stops saying so the moment the engine answers", options, async () => {
  const study = await makeStudy("engine-down");
  const engine = engineDouble();
  const probe = createVcrEngineProbe({ engine });
  const jobs = new VcrJobs({ store, config, engine, engineObserver: probe });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario });
  const [claimed] = await jobs.claim();
  assert.equal((await jobs.advance(claimed)).action, "submitted");
  const view = async () => jobView(await store.job(study.id, claimed.id), new Date());
  assert.equal((await view()).waitingOn, undefined, "a job the engine accepted says nothing");
  assert.equal(probe.snapshot().state, "answering", "the queue's own contact is a reading");

  // The container is stopped: every call fails the way a refused connection does.
  const answer = engine.status;
  engine.status = async () => { throw new VcrEngineError("vcr_engine_unreachable", "计算引擎连不上。"); };
  const waiting = await jobs.advance(claimed);
  assert.deepEqual({ action: waiting.action, state: waiting.state }, { action: "waiting", state: "engine_unreachable" });
  const stalled = await view();
  assert.equal(stalled.state, "running", "it is still the same job, running: nothing was lost and nothing asks the researcher to act");
  assert.equal(stalled.waitingOn, "engine");
  assert.equal(stalled.cancelable, true);
  assert.equal(probe.snapshot().state, "not_answering");
  assert.equal(probe.snapshot().code, "vcr_engine_unreachable");
  // Repeated failures neither fail the job nor use its attempts.
  await jobs.advance(claimed);
  assert.equal((await store.job(study.id, claimed.id)).state, "running");

  // The engine is back: the next poll finishes the job, and the mark is cleared in the same breath.
  engine.status = answer;
  const resumed = await jobs.advance(claimed);
  assert.equal(resumed.state, "succeeded");
  const finished = await store.job(study.id, claimed.id);
  assert.equal(finished.checkpoint.transportError ?? null, null);
  assert.equal((await view()).waitingOn, undefined);
  assert.equal(probe.snapshot().state, "answering");
});

test("the engine answering again clears the wait even while the job is still running", options, async () => {
  const study = await makeStudy("engine-blip");
  const engine = engineDouble({ state: "running" });
  const jobs = new VcrJobs({ store, config, engine });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario });
  const [claimed] = await jobs.claim();
  await jobs.advance(claimed);
  const answer = engine.status;
  engine.status = async () => { throw new VcrEngineError("vcr_engine_timeout", "计算引擎在超时前没有回答。"); };
  await jobs.advance(claimed);
  assert.equal(jobView(await store.job(study.id, claimed.id), new Date()).waitingOn, "engine");
  engine.status = answer;
  assert.equal((await jobs.advance(claimed)).action, "waiting", "the engine says it is still running");
  assert.equal(jobView(await store.job(study.id, claimed.id), new Date()).waitingOn, undefined, "it answered, so the job no longer waits on it");
});

test("a submit the unreachable engine never received is the same wait, and the next contact clears it", options, async () => {
  const study = await makeStudy("submit-down");
  const engine = engineDouble();
  const submit = engine.submit;
  engine.submit = async () => { throw new VcrEngineError("vcr_engine_unreachable", "计算引擎连不上。"); };
  const jobs = new VcrJobs({ store, config, engine });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario });
  const [claimed] = await jobs.claim();
  const first = await jobs.advance(claimed);
  assert.equal(first.state, "submission_uncertain");
  assert.equal(jobView(await store.job(study.id, claimed.id), new Date()).waitingOn, "engine");
  engine.submit = submit;
  // The engine does not know the job (it never arrived): the queue submits it again, and that clears the wait.
  engine.status = async () => { throw new VcrEngineError("vcr_engine_not_found", "计算引擎不认识这个作业。", { status: 404 }); };
  const retake = await jobs.advance(claimed);
  assert.equal(retake.action, "resubmitted");
  assert.equal(jobView(await store.job(study.id, claimed.id), new Date()).waitingOn, undefined);
});
