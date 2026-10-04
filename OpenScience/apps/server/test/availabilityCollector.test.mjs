// The hosted receipt collector: finished runs joined to what they used and produced, folded once.
// What these pin is the row's own named properties — idempotent across replays, a lost lease rolls the fold back
// whole, a transcript that cannot be read costs only the tool observations, and nothing a run does is ever held
// up by this module.
import assert from "node:assert/strict";
import test from "node:test";

import { AvailabilityCollector, AvailabilityWorker, collectableProject } from "../src/availabilityCollector.mjs";
import { AvailabilityStore, availabilityRunKey } from "../src/availabilityStore.mjs";
import { FakeAvailabilityDatabase, FakeJobs } from "./helpers/availabilityFakes.mjs";

const manifest = { id: "adr-analysis", version: "1.3.1", skill: "adr-analysis", companionSkills: [], outputs: [{ path: "safety-report.md", required: true }] };
const run = (id, extra = {}) => ({
  id, dispatchId: `dispatch-${id}`, sessionId: `session-${id}`, status: "succeeded", errorCode: null, effectiveAgentId: "adr-analysis",
  effectiveAgentVersion: "1.3.1", finishedAt: "2026-10-03T09:00:00.000Z", durationMs: 600_000, artifacts: ["safety-report.md"], ...extra,
});
const toolMessage = (tool, output) => ({ role: "assistant", time: Date.parse("2026-10-03T08:00:00.000Z"), parts: [{ type: "tool", tool, callId: "c", status: "completed", input: {}, output }] });

function build({ runs = [run("run_1")], transcript = { messages: [toolMessage("mcp__evimed__drug_safety_analysis", JSON.stringify({ status: "success" }))] },
  results = [], now = () => new Date("2026-10-03T09:10:00.000Z"), projects = new Map([["project-1", { id: "project-1", userId: "alice" }]]), runtimeMode = "kernel" } = {}) {
  const database = new FakeAvailabilityDatabase();
  const jobs = new FakeJobs(database);
  const store = new AvailabilityStore(database);
  const reads = { transcript: 0, runs: 0 };
  const reported = [];
  const collector = new AvailabilityCollector({
    jobs, store,
    documents: { list: async () => ({ items: results }) },
    resolveProject: async (userId, projectId) => projects.get(projectId) ?? null,
    readRuns: async () => { reads.runs += 1; return runs; },
    readTranscript: async () => { reads.transcript += 1; if (transcript instanceof Error) throw transcript; return transcript; },
    costOf: async () => 2.5,
    listFinishedRuns: async () => runs.map((row) => ({ projectId: "project-1", runId: row.id })),
    manifestOf: async (id) => (id === "adr-analysis" ? { manifest, bodyDigest: `sha256:${"c".repeat(64)}` } : null),
    runtimeMode, now, report: (code) => reported.push(code),
  });
  const worker = new AvailabilityWorker({ jobs, collector, perTick: 50 });
  return { database, jobs, store, collector, worker, reads, reported };
}

const project = { id: "project-1", userId: "alice" };

test("a finished run is enqueued once, whatever number of times the finish hook fires", async () => {
  const { collector, database } = build();
  for (let i = 0; i < 4; i += 1) assert.equal(await collector.enqueueRun(project, { id: "run_1", status: "succeeded" }), true);
  assert.equal(database.jobs.length, 1);
  assert.equal(database.jobs[0].idempotency_key, availabilityRunKey("project-1", "run_1"));
  assert.deepEqual(database.jobs[0].payload, { projectId: "project-1", runId: "run_1" });
});

test("a run still going, a mock runtime and the platform's own background work enqueue nothing, and never throw", async () => {
  const mocked = build({ runtimeMode: "mock" });
  assert.equal(await mocked.collector.enqueueRun(project, { id: "run_1", status: "succeeded" }), false);
  const live = build();
  assert.equal(await live.collector.enqueueRun(project, { id: "run_1", status: "running" }), false);
  for (const internal of ["evimed-learning", "evimed-sources", "evimed-frontier", "eval-method-x1", "methodeval-" + "a".repeat(24)]) {
    assert.equal(collectableProject(internal), false, internal);
    assert.equal(await live.collector.enqueueRun({ id: internal, userId: "alice" }, { id: "r", status: "succeeded" }), false, internal);
  }
  // The acceptance battery and the standing audit use the product as an account does: that is the evidence wanted.
  assert.equal(collectableProject("acceptance-adr-analysis"), true);
  assert.equal(collectableProject("audit-release"), true);
  assert.equal(collectableProject("default"), true);
  assert.equal(live.database.jobs.length, 0);
  // An enqueue that fails is reported and swallowed: the run that ended is not held up.
  const broken = build();
  broken.jobs.enqueue = async () => { throw Object.assign(new Error("db down"), { code: "product_state_unavailable" }); };
  assert.equal(await broken.collector.enqueueRun(project, { id: "run_1", status: "succeeded" }), false);
  assert.deepEqual(broken.reported, ["product_state_unavailable"]);
});

test("the worker folds the run into one record per capability version and per tool, with the references the audit cites", async () => {
  const { collector, worker, store, database } = build({ results: [{ payload: { coverage: { producer: "bound" } } }, { payload: { coverage: { producer: "observed" } } }] });
  await collector.enqueueRun(project, { id: "run_1", status: "succeeded" });
  assert.equal(await worker.tick(), 1);
  const { records } = await store.list();
  const byKey = Object.fromEntries(records.map((record) => [`${record.kind}:${record.id}:${record.version}`, record]));
  assert.deepEqual(Object.keys(byKey).sort(), ["capability:adr-analysis:1.3.1", "tool:drug_safety_analysis:"]);
  const capability = byKey["capability:adr-analysis:1.3.1"];
  assert.equal(capability.successes, 1);
  assert.equal(capability.lastSuccess.runId, "run_1");
  assert.equal(capability.lastSuccess.dispatchId, "dispatch-run_1");
  assert.equal(capability.lastSuccess.sessionId, "session-run_1");
  assert.equal(capability.lastSuccess.projectId, "project-1");
  assert.equal(capability.resultVersions, 2);
  assert.equal(capability.boundResultVersions, 1, "only a version whose digest is bound to its producer's receipt is counted as bound");
  assert.deepEqual(capability.durationsMs, [600_000]);
  assert.deepEqual(capability.costsCny, [2.5]);
  assert.equal(capability.lastSuccess.skills[0].digest, `sha256:${"c".repeat(64)}`, "a fresh run ran under the body that is deployed now");
  assert.equal(byKey["tool:drug_safety_analysis:"].successes, 1);
  assert.equal(database.jobs[0].status, "succeeded");
});

test("a replayed job folds nothing twice: the fold and the completion commit together or not at all", async () => {
  const { collector, worker, store, jobs, database } = build();
  await collector.enqueueRun(project, { id: "run_1", status: "succeeded" });
  // The lease is lost between the fold and the completion: the whole transaction, fold included, rolls back.
  jobs.leaseHeld = false;
  await worker.tick();
  assert.equal((await store.list()).records.length, 0, "a lost lease leaves no half-written record");
  assert.equal(database.jobs[0].status, "running", "the job is left with its lapsed lease to be claimed again, not failed");
  assert.equal(jobs.failures.length, 0);
  // It is claimed again and completes; the second pass is the only one that counts.
  jobs.leaseHeld = true;
  await worker.tick();
  const [capability] = (await store.list()).records.filter((record) => record.kind === "capability");
  assert.equal(capability.successes, 1);
  // A restart re-enqueues the same run (the finish hook fires again, a sweep passes): one job exists, it is done, nothing is added.
  await collector.enqueueRun(project, { id: "run_1", status: "succeeded" });
  assert.equal(database.jobs.length, 1);
  assert.equal(await worker.tick(), 0);
  assert.equal((await store.list()).records.find((record) => record.kind === "capability").successes, 1);
});

test("an unreadable transcript costs the tool observations of that run and nothing else", async () => {
  const { collector, worker, store } = build({ transcript: new Error("history gone") });
  await collector.enqueueRun(project, { id: "run_1", status: "succeeded" });
  await worker.tick();
  const { records } = await store.list();
  assert.deepEqual(records.map((record) => record.kind), ["capability"]);
});

test("a failure is recorded with its code, a platform stop says nothing, and a cancel says nothing", async () => {
  const runs = [
    run("run_ok"),
    run("run_down", { status: "failed", errorCode: "specialist_agent_unavailable", artifacts: [], finishedAt: "2026-10-04T09:00:00.000Z" }),
    run("run_stop", { status: "failed", errorCode: "runtime_canceled", artifacts: [] }),
    run("run_cancel", { status: "canceled", artifacts: [] }),
  ];
  const { collector, worker, store } = build({ runs, transcript: { messages: [] } });
  for (const row of runs) await collector.enqueueRun(project, row);
  await worker.tick();
  const [capability] = (await store.list()).records;
  assert.equal(capability.successes, 1);
  assert.equal(capability.failures, 1);
  assert.equal(capability.lastFailure.code, "specialist_agent_unavailable");
  assert.equal(capability.operations, 2, "the stop and the cancel are not operations");
});

test("a project or run that is gone is closed as skipped, never retried forever", async () => {
  const gone = build({ projects: new Map() });
  await gone.collector.enqueueRun(project, { id: "run_1", status: "succeeded" });
  await gone.worker.tick();
  assert.equal(gone.database.jobs[0].status, "succeeded");
  assert.deepEqual(gone.jobs.finished[0].result, { skipped: "project_unavailable" });
  const missing = build({ runs: [] });
  await missing.collector.enqueueRun(project, { id: "run_1", status: "succeeded" });
  await missing.worker.tick();
  assert.deepEqual(missing.jobs.finished[0].result, { skipped: "run_unavailable" });
});

test("a run that has not finished yet is retried later, and not as a failed attempt", async () => {
  const open = build({ runs: [run("run_1", { status: "running", finishedAt: null })] });
  await open.collector.enqueueRun(project, { id: "run_1", status: "succeeded" });
  await open.worker.tick();
  assert.equal(open.jobs.failures.length, 1);
  assert.equal(open.jobs.failures[0].error.code, "availability_run_open");
  assert.equal(open.jobs.failures[0].options.retry, true);
  assert.equal(open.database.jobs[0].status, "queued");
});

test("the sweep queues the runs no job exists for, once per period, and counts nothing itself", async () => {
  const { collector, worker, database, store } = build({ runs: [run("run_1"), run("run_2"), run("run_3")] });
  await collector.enqueueRun(project, { id: "run_1", status: "succeeded" });
  await collector.enqueueSweep("alice", "480000");
  await collector.enqueueSweep("alice", "480000");
  assert.equal(database.jobs.filter((job) => job.payload.sweep === true).length, 1, "one sweep per account per period");
  await worker.tick();
  const keys = database.jobs.filter((job) => !job.payload.sweep).map((job) => job.idempotency_key).sort();
  assert.deepEqual(keys, ["run_1", "run_2", "run_3"].map((id) => availabilityRunKey("project-1", id)), "run_1 already had its job; the sweep added only the other two");
  assert.equal((await store.collectorState()).swept, true);
  const capability = (await store.list()).records.find((record) => record.kind === "capability");
  assert.equal(capability.successes, 3, "each run counted exactly once");
});

test("the collector's state reports the backlog, the jobs that gave up, and whether a sweep has ever completed", async () => {
  const { collector, worker, store, database } = build();
  assert.deepEqual(await store.collectorState(), { backlog: 0, failed: 0, swept: false });
  await collector.enqueueRun(project, { id: "run_1", status: "succeeded" });
  assert.equal((await store.collectorState()).backlog, 1);
  await worker.tick();
  assert.equal((await store.collectorState()).backlog, 0);
  database.jobs.push({ id: "x", user_id: "alice", kind: "availability-collect", idempotency_key: "availability:run:p:r", status: "failed", payload: {} });
  assert.equal((await store.collectorState()).failed, 1);
});
