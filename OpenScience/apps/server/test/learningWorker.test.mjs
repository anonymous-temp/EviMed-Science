// The claimer for the two learning job kinds, and the two things that make it
// different from the other four workers.
//
// It declines outside its window, because nothing it does is urgent and model
// calls are half price at night. And it ends a job rather than retrying it when
// another attempt would only spend money to reach the same conclusion.
import assert from "node:assert/strict";
import test from "node:test";

import { LearningWorker, parseWindow, withinWindow } from "../src/learningWorker.mjs";

/** A ProductJobs stand-in with the three failure signals the real one has:
 *  claim returns null, renew returns a boolean, fail/finish throw on lease loss. */
function fakeJobs(queue = []) {
  /** @type {any[]} */
  const finished = [];
  /** @type {any[]} */
  const failed = [];
  return {
    queue, finished, failed,
    renewals: 0,
    leaseAlive: true,
    async claim(kinds, workerId) {
      const index = queue.findIndex((job) => kinds.includes(job.kind));
      if (index < 0) return null;
      const [job] = queue.splice(index, 1);
      return { leaseToken: "lease_1", attempts: 0, workerId, ...job };
    },
    async renew() { this.renewals += 1; return this.leaseAlive; },
    async finish(userId, id, token, result) {
      if (!this.leaseAlive) { const error = new Error("lost"); /** @type {any} */ (error).code = "product_job_lease_lost"; throw error; }
      finished.push({ id, result });
      return true;
    },
    async fail(userId, id, token, error, options) { failed.push({ id, error, options }); return true; },
  };
}

const distillation = { calls: [], async execute(request) { this.calls.push(request); return { state: "complete", methodId: "m1" }; } };
const consolidation = { calls: [], async run(request) { this.calls.push(request); return { action: request.job.payload.action }; } };

/** @param {any} [options] */
function worker(options = {}) {
  const jobs = options.jobs ?? fakeJobs();
  return {
    jobs,
    worker: new LearningWorker({
      jobs,
      distillation: options.distillation ?? { ...distillation, calls: [] },
      consolidation: options.consolidation ?? { ...consolidation, calls: [] },
      resolveProject: options.resolveProject ?? (async () => ({ id: "p1", userId: "u1" })),
      resolveRun: options.resolveRun ?? (async () => ({ id: "run_1", sessionId: "s1" })),
      enabled: options.enabled ?? true,
      ...(options.maintain ? { maintain: options.maintain } : {}),
      window: options.window ?? "",
      now: options.now ?? (() => new Date("2026-09-07T23:00:00")),
      pollMs: 1000,
      leaseMs: 60_000,
      reconcileMs: 60_000,
    }),
  };
}

test("an off-peak window is parsed, wraps midnight, and a typo costs the discount rather than the feature", () => {
  const night = parseWindow("22:00-09:00");
  assert.deepEqual(night, { startMinutes: 22 * 60, endMinutes: 9 * 60 });
  assert.equal(withinWindow(night, new Date("2026-09-07T23:30:00")), true);
  assert.equal(withinWindow(night, new Date("2026-09-07T03:00:00")), true);
  assert.equal(withinWindow(night, new Date("2026-09-07T12:00:00")), false);
  assert.equal(withinWindow(night, new Date("2026-09-07T09:00:00")), false, "the end is exclusive");

  const day = parseWindow("09:00-17:00");
  assert.equal(withinWindow(day, new Date("2026-09-07T12:00:00")), true);
  assert.equal(withinWindow(day, new Date("2026-09-07T20:00:00")), false);

  for (const bad of ["", "nonsense", "25:00-09:00", "09:00-09:00", "9-17"]) {
    assert.equal(parseWindow(bad), null, bad);
  }
  assert.equal(withinWindow(null, new Date("2026-09-07T12:00:00")), true, "no window means always");
});

test("the worker declines to claim outside its window, and says which reason", async () => {
  const { jobs, worker: instance } = worker({
    window: "22:00-09:00",
    now: () => new Date("2026-09-07T12:00:00"),
    jobs: fakeJobs([{ id: "j1", kind: "consolidate", userId: "u1", projectId: "p1", payload: { action: "sleep" } }]),
  });
  assert.equal(await instance.tick(), null);
  assert.equal(jobs.queue.length, 1, "the job is still queued, not consumed and dropped");
  assert.equal(instance.status().lastSkippedReason, "outside_learning_window");

  const disabled = worker({ enabled: false, jobs: fakeJobs([{ id: "j1", kind: "distill", userId: "u1", payload: {} }]) });
  assert.equal(await disabled.worker.tick(), null);
  assert.equal(disabled.worker.status().lastSkippedReason, "learning_disabled");
});

test("inside the window a consolidate job reaches the consolidation and finishes", async () => {
  const consolidator = { calls: [], async run(request) { this.calls.push(request); return { action: "sleep", promoted: [] }; } };
  const { jobs, worker: instance } = worker({
    window: "22:00-09:00",
    consolidation: consolidator,
    jobs: fakeJobs([{ id: "j1", kind: "consolidate", userId: "u1", projectId: "p1", payload: { action: "sleep" } }]),
  });
  const result = await instance.tick();
  assert.equal(result.action, "sleep");
  assert.equal(consolidator.calls.length, 1);
  assert.deepEqual(jobs.finished.map((entry) => entry.id), ["j1"]);
  assert.ok(jobs.renewals >= 1, "the lease is re-checked before the irreversible write");
});

test("a distill job carries its run, and a run that no longer exists ends the job for good", async () => {
  const distiller = { calls: [], async execute(request) { this.calls.push(request); return { state: "complete", methodId: "m1" }; } };
  const { jobs, worker: instance } = worker({
    distillation: distiller,
    jobs: fakeJobs([{ id: "j1", kind: "distill", userId: "u1", projectId: "p1", payload: { runId: "run_1", trigger: "repair_accepted" } }]),
  });
  await instance.tick();
  assert.equal(distiller.calls[0].run.id, "run_1");
  assert.deepEqual(jobs.finished.map((entry) => entry.id), ["j1"]);

  const orphan = worker({
    resolveRun: async () => null,
    jobs: fakeJobs([{ id: "j2", kind: "distill", userId: "u1", projectId: "p1", payload: { runId: "gone" } }]),
  });
  await orphan.worker.tick();
  assert.equal(orphan.jobs.failed[0].error.code, "distillation_run_unavailable");
  assert.equal(orphan.jobs.failed[0].options.retry, false, "a run that is gone will not come back");
});

test("a bounded run that has not finished is retried later, not failed", async () => {
  const pending = { async execute() { return { state: "pending", runId: "r1" }; } };
  const { jobs, worker: instance } = worker({
    distillation: pending,
    jobs: fakeJobs([{ id: "j1", kind: "distill", userId: "u1", projectId: "p1", payload: { runId: "run_1" } }]),
  });
  const result = await instance.tick();
  assert.equal(result.state, "pending");
  assert.deepEqual(jobs.finished, [], "a pending run must not be recorded as a finished job");
  assert.equal(jobs.failed[0].error.code, "learning_run_pending");
  assert.equal(jobs.failed[0].options.retry, true);
});

test("a shape error ends the job and a transient one backs off", async () => {
  const shapeError = {
    async run() { const error = new Error("bad"); /** @type {any} */ (error).code = "consolidate_payload_invalid"; throw error; },
  };
  const { jobs } = worker({
    consolidation: shapeError,
    jobs: fakeJobs([{ id: "j1", kind: "consolidate", userId: "u1", payload: { action: "integrate" } }]),
  });
  await worker({ consolidation: shapeError, jobs }).worker.tick();
  assert.equal(jobs.failed[0].options.retry, false, "retrying a malformed payload only spends money");

  const busy = { async run() { const error = new Error("busy"); /** @type {any} */ (error).code = "runtime_busy"; throw error; } };
  const second = worker({
    consolidation: busy,
    jobs: fakeJobs([{ id: "j2", kind: "consolidate", userId: "u1", payload: { action: "sleep" } }]),
  });
  await second.worker.tick();
  assert.equal(second.jobs.failed[0].options.retry, true, "a busy project is a reason to wait, not to give up");
  assert.ok(second.jobs.failed[0].options.delayMs > 0);
});

test("an unknown consolidation action never reaches the consolidation", async () => {
  const consolidator = { calls: [], async run(request) { this.calls.push(request); return {}; } };
  const { jobs } = worker({
    consolidation: consolidator,
    jobs: fakeJobs([{ id: "j1", kind: "consolidate", userId: "u1", payload: { action: "improvise" } }]),
  });
  await worker({ consolidation: consolidator, jobs }).worker.tick();
  assert.deepEqual(consolidator.calls, []);
  assert.equal(jobs.failed[0].error.code, "consolidate_action_invalid");
  assert.equal(jobs.failed[0].options.retry, false);
});

test("a lease lost mid-job stops the write rather than committing it", async () => {
  const jobs = fakeJobs([{ id: "j1", kind: "consolidate", userId: "u1", payload: { action: "sleep" } }]);
  const slow = { async run() { jobs.leaseAlive = false; return { action: "sleep" }; } };
  const { worker: instance } = worker({ consolidation: slow, jobs });
  await instance.tick();
  assert.deepEqual(jobs.finished, [], "the finish is skipped when the lease is gone");
  assert.equal(instance.status().lastError, "product_job_lease_lost");
});

test("the worker names its timers the way the maintenance drain looks for them", () => {
  const { worker: instance } = worker();
  instance.start();
  assert.ok(instance.timer, "pauseRecurringWork clears `timer` by name");
  assert.ok(instance.reconcileTimer, "pauseRecurringWork clears `reconcileTimer` by name");
  instance.close();
});

test("bad intervals and missing dependencies are refused at construction", () => {
  assert.throws(() => new LearningWorker({ jobs: null, distillation: {}, consolidation: {} }), TypeError);
  assert.throws(() => new LearningWorker({ jobs: {}, distillation: {}, consolidation: {}, pollMs: 1 }), /Invalid learning poll interval/);
  assert.throws(() => new LearningWorker({ jobs: {}, distillation: {}, consolidation: {}, leaseMs: 0 }), /Invalid learning lease interval/);
});

test("maintenance runs on reconcile even when the loop may not spend a cent", async () => {
  // Transcript retention is the first thing on this hook, and it must not be
  // gated on `enabled` or on the spending window: deleting old files costs no
  // model calls, and a deployment that switched the loop off after trying it is
  // exactly the one whose transcripts nobody else is going to prune.
  let calls = 0;
  const { worker: off } = worker({
    enabled: false,
    window: "02:00-03:00",
    now: () => new Date("2026-09-07T23:00:00"),
    maintain: async () => { calls += 1; },
  });
  assert.equal(off.claimBlockedReason(), "learning_disabled", "the job side is closed");
  await off.reconcile();
  assert.equal(calls, 1, "and the housekeeping side is not");
});

test("a maintenance failure is recorded and never escapes the timer", async () => {
  const { worker: failing } = worker({
    maintain: async () => { const error = new Error("nope"); /** @type {any} */ (error).code = "prune_failed"; throw error; },
  });
  await failing.reconcile();
  assert.equal(failing.status().lastError, "prune_failed");
  // And a second call still runs: one bad sweep does not stop the next.
  let second = 0;
  failing.maintain = async () => { second += 1; };
  await failing.reconcile();
  assert.equal(second, 1);
});

test("overlapping reconciles collapse into one, like the job tick", async () => {
  let running = 0;
  let peak = 0;
  const { worker: slow } = worker({
    maintain: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
    },
  });
  await Promise.all([slow.reconcile(), slow.reconcile(), slow.reconcile()]);
  assert.equal(peak, 1, "a slow sweep must not be started again on top of itself");
});
