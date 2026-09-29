// 「虚拟临研」's job queue on PostgreSQL with the engine faked: a scenario
// frozen into a row, the queue's concurrency and lease, a job that fails after
// computing something, a job cancelled while it runs, and the second of the
// three human stops — compute over the study's budget.
//
// Its own database: the queue counts across the schema, which no suite sharing
// a database may do.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
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
const scenario = {
  design: { kind: "two_arm_fixed", n: 300 }, endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.7 }, analysis: { method: "logrank" }, accrual: { months: 24 }, performance: ["power"],
};

/**
 * A study of this test's own, and a clean queue. The queue's concurrency is a
 * property of the deployment, not of a study, so a job another test left
 * running would decide whether this one can claim anything.
 * @param {string} label
 */
async function makeStudy(label) {
  await store.query("DELETE FROM evimed_vcr.jobs");
  return store.createStudy({ userId: `u_${label}`, projectId: `prj_${label}`, name: label, dataTier: "T0" });
}

/**
 * An engine double: it accepts, reports progress, and answers with whatever
 * the test handed it.
 * @param {(jobId: string) => any} resultFor
 */
function engineDouble(resultFor, { state = "succeeded" } = {}) {
  /** @type {string[]} */
  const submitted = [];
  /** @type {string[]} */
  const cancelled = [];
  return {
    submitted, cancelled,
    configured: () => true,
    async submit(job) { submitted.push(job.jobId); return { jobId: `engine-${job.jobId}`, accepted: true }; },
    async status() { return { state, progress: { done: 20000, total: 20000 }, cpuSeconds: 42.1 }; },
    async cancel(id) { cancelled.push(id); return { canceled: true }; },
    async result(id) { return { result: resultFor(id.replace(/^engine-/, "")), signed: true }; },
    async health() { return { ok: true, methods: [], engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "" }; },
  };
}

/** @param {string} jobId @param {Record<string, any>} [overrides] */
function engineResult(jobId, overrides = {}) {
  return {
    jobId, protocolVersion: 1, status: "succeeded", method: "design.simulate", methodVersion: "1.0.0",
    scenarioHash: vcrScenarioHash(scenario), seed: 20260928, replicates: 20000,
    counts: { realPatients: 0, events: 138, effectiveSampleSize: null, generatedRecords: 3_600_000 },
    measures: [{ name: "power", value: 0.812, simulated: true, mcse: 0.0031 }],
    diagnostics: {}, tables: [],
    manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "b".repeat(64),
      startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:00:42Z", cpuSeconds: 42.1, outputHash: "c".repeat(64) },
    ...overrides,
  };
}

test("a scenario is frozen into the row, and the same scenario enqueued twice is one job", options, async () => {
  const study = await makeStudy("freeze");
  const jobs = new VcrJobs({ store, config, engine: engineDouble((id) => engineResult(id)) });
  const first = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    inputs: [{ kind: "assumption", id: "assumption:asm_1@3", value: { key: "hr", pointValue: 0.7 } }],
    idempotencyKey: `vcr:${study.id}:trial_scenario:scn_1@1` });
  assert.equal(first.created, true);
  assert.equal(first.job.state, "queued");
  assert.equal(first.job.method, "design.simulate");
  assert.equal(first.job.scenarioHash, vcrScenarioHash(scenario));
  assert.equal(first.job.replicates, 5_000, "an alternative scenario takes the plan's alternative floor");
  assert.ok(first.job.seed > 0, "a seed the scenario decided, not a draw");

  const again = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    idempotencyKey: `vcr:${study.id}:trial_scenario:scn_1@1` });
  assert.equal(again.created, false);
  assert.equal(again.job.id, first.job.id, "the key is what makes a restart idempotent");
  assert.equal((await jobs.listForStudy(study.id)).length, 1);
});

test("a claim is exclusive, and the deployment's concurrency is the ceiling", options, async () => {
  const study = await makeStudy("claim");
  const jobs = new VcrJobs({ store, config, engine: engineDouble((id) => engineResult(id)) });
  // Small ceilings on purpose: this test is about who may claim, not about the
  // study's compute budget, and three jobs at the deployment's default ceiling
  // would take the third past it.
  for (const label of ["a", "b", "c"]) {
    await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", cpuSecondsLimit: 60,
      scenario: { ...scenario, label }, idempotencyKey: `vcr:${study.id}:${label}` });
  }
  const first = await jobs.claim({ workerId: "worker-1", limit: 5 });
  assert.equal(first.length, 1, "global concurrency is 1 on the shared host");
  assert.equal(first[0].state, "running");
  const second = await jobs.claim({ workerId: "worker-2", limit: 5 });
  assert.deepEqual(second, [], "nothing else may run while one is out");
  await jobs.finish(first[0].id, { status: "succeeded", result: engineResult(first[0].id), cpuSeconds: 42.1 });
  const third = await jobs.claim({ workerId: "worker-2", limit: 5 });
  assert.equal(third.length, 1);
  assert.notEqual(third[0].id, first[0].id);
  await jobs.finish(third[0].id, { status: "succeeded", result: engineResult(third[0].id), cpuSeconds: 1 });

  // A lease that ran out is taken over rather than left stranded.
  const [fourth] = await jobs.claim({ workerId: "worker-1" });
  await store.query("UPDATE evimed_vcr.jobs SET lease_until = now() - interval '1 hour' WHERE id = $1", [fourth.id]);
  const rescued = await jobs.claim({ workerId: "worker-3" });
  assert.deepEqual(rescued.map((job) => job.id), [fourth.id]);
  assert.equal(rescued[0].attempts, 2, "the retake is counted as another attempt");
});

test("a finished job writes an execution and an immutable result, and supersedes the previous one", options, async () => {
  const study = await makeStudy("result");
  const engine = engineDouble((id) => engineResult(id));
  const jobs = new VcrJobs({ store, config, engine });
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    idempotencyKey: `vcr:${study.id}:one` });
  const [claimed] = await jobs.claim();
  assert.equal(claimed.id, job.id);
  const submitted = await jobs.advance(claimed);
  assert.equal(submitted.action, "submitted");
  assert.deepEqual(engine.submitted, [job.id]);
  const finished = await jobs.advance(claimed);
  assert.equal(finished.action, "finished");
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.result.kind, "trial_scenario");
  assert.equal(finished.result.measures[0].mcse, 0.0031);
  assert.equal(finished.result.counts.generatedRecords, 3_600_000);
  assert.equal(finished.result.counts.realPatients, 0);
  assert.equal(finished.execution.seed, job.seed, "the execution froze the seed the job carried");
  assert.equal(finished.execution.receipt.signed, true);

  // A recomputation supersedes rather than replaces: the old numbers stay.
  const second = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation",
    scenario: { ...scenario, truth: { hazardRatio: 0.65 } }, idempotencyKey: `vcr:${study.id}:two` });
  const [next] = await jobs.claim();
  await jobs.advance(next);
  await jobs.advance(next);
  const current = await store.results(study.id, "trial_scenario");
  assert.equal(current.length, 1, "only the current result is current");
  assert.equal(current[0].version, 2);
  const all = await store.allResults(study.id);
  assert.equal(all.length, 2);
  assert.equal(all.find((row) => row.version === 1).supersededBy, current[0].id, "the first result is kept and marked");
  assert.equal(second.created, true);
});

test("AC-19 a job that fails after computing something keeps what it computed and says it is partial", options, async () => {
  const study = await makeStudy("partial");
  const engine = engineDouble((id) => engineResult(id, {
    status: "failed",
    measures: [{ name: "power", value: 0.79, simulated: true, mcse: 0.004 }],
    counts: { realPatients: 0, events: 96, effectiveSampleSize: null, generatedRecords: 1_800_000 },
  }), { state: "failed" });
  const jobs = new VcrJobs({ store, config, engine });
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    idempotencyKey: `vcr:${study.id}:partial` });
  const [claimed] = await jobs.claim();
  await jobs.advance(claimed);
  await jobs.checkpoint(job.id, { completedBatches: 9, ofBatches: 20 });
  const finished = await jobs.advance(claimed);

  assert.equal(finished.state, "failed");
  assert.equal(finished.partial, true);
  assert.equal(finished.result.conclusion, "limited", "what was computed stands, labelled for what it is");
  assert.equal(finished.result.measures[0].value, 0.79);
  assert.equal(finished.result.diagnostics.partial, true);
  const row = await store.job(study.id, job.id);
  assert.equal(row.state, "failed");
  assert.equal(row.error.partial, true);
  assert.equal(row.checkpoint.completedBatches, 9, "the restart point survives the failure");
  assert.equal(row.cpuSecondsUsed, 42.1, "what it cost is recorded whatever the outcome");
});

test("AC-19 AC-13 an engine that is not composed fails the job by name and fabricates nothing", options, async () => {
  const study = await makeStudy("noengine");
  const jobs = new VcrJobs({ store, config, engine: null });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    idempotencyKey: `vcr:${study.id}:noengine` });
  const [claimed] = await jobs.claim();
  const finished = await jobs.advance(claimed);
  assert.equal(finished.state, "failed");
  assert.equal(finished.result, null, "no result at all — never a zero standing in for a number");
  const row = await store.job(study.id, claimed.id);
  assert.equal(row.error.code, "engine_unavailable");
  assert.equal((await store.results(study.id)).length, 0);
});

test("AC-38 a cancel takes effect at once and keeps the completed batches", options, async () => {
  const study = await makeStudy("cancel");
  const engine = engineDouble((id) => engineResult(id));
  const jobs = new VcrJobs({ store, config, engine });
  const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    idempotencyKey: `vcr:${study.id}:cancel` });
  const [claimed] = await jobs.claim();
  await jobs.advance(claimed);
  await jobs.checkpoint(job.id, { completedBatches: 12, ofBatches: 20 });

  const cancelled = await jobs.cancel(study.id, job.id, { actor: "u_cancel" });
  assert.equal(cancelled.canceled, true);
  assert.equal(cancelled.job.state, "canceled", "the row moved in the same statement that recorded the request");
  assert.deepEqual(engine.cancelled, [`engine-${job.id}`], "the engine is told afterwards, on a best-effort basis");
  const row = await store.job(study.id, job.id);
  assert.equal(row.checkpoint.completedBatches, 12, "已完成的批次保留");
  assert.equal(row.error.code, "vcr_job_canceled");

  // A second cancel is not an error, and a cancelled job is not advanced again.
  const again = await jobs.cancel(study.id, job.id, { actor: "u_cancel" });
  assert.equal(again.canceled, false);
  assert.equal((await jobs.advance(claimed)).action, "skipped");
  await assert.rejects(jobs.cancel(study.id, "job_absent", {}), (/** @type {any} */ error) => error.code === "vcr_job_not_found");
});

test("AC-38 compute over the study's budget stops at the confirmation, and one confirmation releases it", options, async () => {
  const study = await makeStudy("budget");
  /** @type {any[]} */
  const notices = [];
  const jobs = new VcrJobs({
    store, config: { ...config, vcrStudyCpuBudget: 900, vcrJobCpuSeconds: 600 },
    engine: engineDouble((id) => engineResult(id)),
    notifier: { async budgetConfirm(target, job) { notices.push([target.id, job.id, job.cpuSecondsLimit]); } },
  });

  const first = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    cpuSecondsLimit: 600, idempotencyKey: `vcr:${study.id}:b1` });
  assert.equal(first.job.state, "queued");
  const second = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation",
    scenario: { ...scenario, label: "B" }, cpuSecondsLimit: 600, idempotencyKey: `vcr:${study.id}:b2` });
  assert.equal(second.job.state, "awaiting_budget", "600 + 600 is past the study's 900");
  assert.deepEqual(notices, [[study.id, second.job.id, 600]], "the second human stop reaches a person once");

  const budget = await jobs.budgetOf(study.id);
  assert.equal(budget.limitSeconds, 900);
  assert.equal(budget.committedSeconds, 600);
  assert.equal(budget.awaitingBudget, 1);
  const claimed = await jobs.claim();
  assert.deepEqual(claimed.map((job) => job.id), [first.job.id], "the job inside the budget runs");
  await jobs.finish(first.job.id, { status: "succeeded", result: engineResult(first.job.id), cpuSeconds: 10 });
  assert.deepEqual(await jobs.claim(), [], "nothing waiting on budget is ever claimed");

  const confirmed = await jobs.confirmBudget(study.id, { actor: study.userId });
  assert.equal(confirmed.released.length, 1);
  assert.equal(confirmed.released[0].state, "queued");
  assert.equal(confirmed.budget.limitSeconds, 1_500, "the confirmation raised the study's own budget");
  const after = await store.studyById(study.id);
  assert.equal(after.budget.cpuSecondsConfirmed, 600);
  assert.equal(after.budget.lastConfirmedBy, study.userId);
});

test("a local executor runs a method the control plane computes itself", options, async () => {
  const study = await makeStudy("local");
  /** @type {any[]} */
  const seen = [];
  const jobs = new VcrJobs({
    store, config, engine: engineDouble((id) => engineResult(id)),
    localExecutors: {
      "matching.evaluate": async ({ job, onProgress }) => {
        seen.push(job.method);
        await onProgress({ done: 1, total: 1 });
        return {
          status: "succeeded", conclusion: "estimable",
          counts: { realPatients: 42, events: null, effectiveSampleSize: null, generatedRecords: 0 },
          measures: [{ name: "eligible", value: 7, simulated: false }],
          manifest: { cpuSeconds: 0.4 },
        };
      },
    },
  });
  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "match_criteria",
    scenario: { protocolVersion: 1 },
    inputs: [{ kind: "snapshot", id: "snp_1", hash: "a".repeat(64), location: "/data/snapshot.parquet" }],
    idempotencyKey: `vcr:${study.id}:match` });
  const [claimed] = await jobs.claim();
  const finished = await jobs.advance(claimed);
  assert.deepEqual(seen, ["matching.evaluate"], "it never reached the engine");
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.result.kind, "matching");
  assert.equal(finished.result.counts.realPatients, 42);
  assert.equal(finished.execution.receipt.local, true, "the record says who computed it");
});

test("the worker's three loops drive the queue, the programme and the recompute backlog", options, async () => {
  const study = await makeStudy("worker");
  const engine = engineDouble((id) => engineResult(id));
  const jobs = new VcrJobs({ store, config, engine });
  /** @type {any[]} */
  const finished = [];
  const orchestrator = {
    async onJobFinished(outcome) { finished.push(outcome.job.id); },
    async tick() { return { studies: 1, advanced: 1 }; },
    async advance() { return { dispatched: null }; },
  };
  const loops = createVcrWorkerLoops({ jobs, orchestrator, store });
  assert.deepEqual(Object.keys(loops).sort(), ["jobs", "orchestrator", "recompute"]);

  await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario,
    idempotencyKey: `vcr:${study.id}:worker` });

  // A lease no other process may take, a loop that never overlaps itself, and
  // one timer for all three (the maintenance pause clears it).
  /** @type {string[]} */
  const leased = [];
  const worker = new VcrWorker({
    loops, pollMs: 1_000, leaseMs: 60_000,
    lease: async (name, work) => { leased.push(name); return { acquired: true, value: await work() }; },
  });
  await worker.tick();
  // The engine answers on the second pass: submit, then read.
  await worker.runNow("jobs");
  assert.deepEqual(finished.length, 1, "the queue finished the job and told the orchestrator");
  assert.deepEqual(leased.sort(), ["orchestrator", "recompute"], "the queue loop is deliberately unleased");

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
