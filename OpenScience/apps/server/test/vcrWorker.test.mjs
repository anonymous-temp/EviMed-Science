// The worker's timer and its seven loops, without a database: which loops exist
// and how often they start, what a loop without its function reports, that one
// loop failing leaves the others running, and that the recheck loop is wired to
// the matching package's `recheckDue` and only when it is composed.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_WORKER_LOOPS, VcrWorker, createVcrWorkerLoops, withVcrWorkerWarnings } from "../src/vcrWorker.mjs";

test("the seven loops, their cadences and which of them are leased", () => {
  assert.deepEqual(VCR_WORKER_LOOPS.map((loop) => loop.name), ["jobs", "localJobs", "slowJobs", "completions", "orchestrator", "recompute", "recheck", "frontierEvents", "registryWatch", "packSources", "drafts"]);
  const packs = VCR_WORKER_LOOPS.find((loop) => loop.name === "packSources");
  assert.deepEqual([packs?.leased, packs?.optional], [true, true], "a platform pack is watched once, by whichever control plane sees it first, and only while the switch is on");
  const events = VCR_WORKER_LOOPS.find((loop) => loop.name === "frontierEvents");
  assert.equal(events?.leased, true, "one frontier event is one candidate, whichever control plane sees it first");
  assert.equal(events?.optional, true, "its switch is off by default, which is not a missing loop");
  const recheck = VCR_WORKER_LOOPS.find((loop) => loop.name === "recheck");
  assert.equal(recheck?.package, "matching");
  assert.equal(recheck?.every, 15 * 60_000);
  assert.equal(recheck?.leased, true, "one due date is one job, whichever control plane sees it first");
  assert.equal(VCR_WORKER_LOOPS.find((loop) => loop.name === "jobs")?.leased, undefined, "claiming is already exclusive in the database");
});

test("the registry watch loop is hourly and leased, the watch's own tick, and absent while it is off", async () => {
  const watch = VCR_WORKER_LOOPS.find((loop) => loop.name === "registryWatch");
  assert.deepEqual([watch?.every, watch?.leased, watch?.optional], [60 * 60_000, true, true], "one trial is read once, whichever control plane sees it first, and the switch may be off");
  const loops = createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null, registryWatch: { async tick() { return { due: 3, checked: 2, changed: 1, marked: 4, failed: 1, deferred: 0 }; } } });
  assert.deepEqual(await loops.registryWatch?.(), { due: 3, checked: 2, changed: 1, marked: 4, failed: 1, deferred: 0 });
  assert.equal(createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null }).registryWatch, null);
  assert.equal(createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null, registryWatch: {} }).registryWatch, null);
});

test("the recheck loop is the matching package's own function, and absent when matching is not composed", async () => {
  const calls = [];
  const matching = { async recheckDue() { calls.push("due"); return { studies: 2, enqueued: 1 }; } };
  const loops = createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null, matching });
  assert.equal(typeof loops.recheck, "function");
  assert.deepEqual(await loops.recheck?.(), { studies: 2, enqueued: 1 });
  assert.deepEqual(calls, ["due"]);
  assert.equal(createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null }).recheck, null);
  assert.equal(createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null, matching: {} }).recheck, null);
});

test("the drafts loop is the sweeper's own pass, every ten minutes, and absent where none is composed", async () => {
  const drafts = VCR_WORKER_LOOPS.find((loop) => loop.name === "drafts");
  assert.deepEqual([drafts?.every, drafts?.leased, drafts?.optional], [10 * 60_000, true, true], "a draft is deleted once, by whichever control plane sees it first");
  const sweeper = { async sweep() { return { deleted: 2, kept: 1, failed: 0 }; } };
  const loops = createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null, drafts: sweeper });
  assert.deepEqual(await loops.drafts?.(), { deleted: 2, kept: 1, failed: 0 });
  assert.equal(createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null }).drafts, null);
});

test("the frontier loop is the consumer's own tick, absent while off, and an absent optional loop is not reported missing", async () => {
  const consumer = { async tick() { return { studies: 3, candidates: 1 }; } };
  const loops = createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null, frontierEvents: consumer });
  assert.deepEqual(await loops.frontierEvents?.(), { studies: 3, candidates: 1 });
  assert.equal(createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null }).frontierEvents, null);
  assert.equal(typeof createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null, knowledge: { platform: { enabled: true }, watchPlatformPackSources: async () => ({ checked: 0 }) } }).packSources, "function");
  assert.equal(createVcrWorkerLoops({ jobs: null, orchestrator: null, store: null, knowledge: { platform: { enabled: false }, watchPlatformPackSources: async () => ({}) } }).packSources, null);
  const worker = new VcrWorker({ loops: { jobs: async () => null, orchestrator: async () => null, recompute: async () => null, recheck: async () => null, frontierEvents: null, packSources: null } });
  assert.deepEqual(worker.status().missing, []);
  assert.deepEqual(withVcrWorkerWarnings({ enabled: true, ok: true }, worker).warnings ?? [], []);
  await worker.close();
});

test("a tick starts the loops that are due, a loop that throws leaves the others running, and a loop with no function is reported missing", async () => {
  let clock = new Date("2027-01-01T00:00:00Z").getTime();
  /** @type {string[]} */
  const ran = [];
  const worker = new VcrWorker({
    now: () => new Date(clock),
    loops: {
      jobs: async () => { ran.push("jobs"); return { claimed: 0 }; },
      orchestrator: async () => { ran.push("orchestrator"); throw Object.assign(new Error("boom"), { code: "vcr_boom" }); },
      recompute: null,
      recheck: async () => { ran.push("recheck"); return { studies: 0, enqueued: 0 }; },
    },
    report: () => {},
  });
  await worker.tick();
  assert.deepEqual(ran.sort(), ["jobs", "orchestrator", "recheck"], "a loop that throws does not stop the others");
  let status = worker.status();
  assert.deepEqual(status.missing, ["recompute"]);
  assert.deepEqual(status.failing, ["orchestrator"]);
  assert.equal(status.loops.orchestrator.lastError, "vcr_boom");
  assert.deepEqual(status.loops.recheck.last, { studies: 0, enqueued: 0 });

  // A loop with a cadence is not started again before its time; the base-tick loop is.
  ran.length = 0;
  clock += 5_000;
  await worker.tick();
  assert.deepEqual(ran, ["jobs"]);
  clock += 15 * 60_000;
  ran.length = 0;
  await worker.tick();
  assert.deepEqual(ran.sort(), ["jobs", "orchestrator", "recheck"]);

  const warned = withVcrWorkerWarnings({ enabled: true, ok: true }, worker);
  assert.deepEqual(warned.warnings, ["vcr_worker_loop_missing", "vcr_worker_loop_failing"]);
  status = worker.status();
  assert.equal(status.stalled.length, 0);
  await worker.close();
});

test("a loop the worker does not know is refused when it is built", () => {
  assert.throws(() => new VcrWorker({ loops: { nothing: async () => null } }), /Unknown VCR worker loop/);
});

test("P2-9 the slow lane starts a batch and does not wait for it: another account's batch is taken while the first is out, and a batch in flight is not advanced twice", async () => {
  /** @type {Map<string, () => void>} */ const release = new Map();
  /** @type {string[]} */ const advanced = [];
  /** @type {string[]} */ const finishedHooks = [];
  const queue = [[{ id: "job_a" }], [{ id: "job_b" }], [], []];
  const jobs = {
    owner: "me", config: { vcrLocalConcurrency: 2 }, localExecutors: { "matching.extract": () => null },
    async claim() { return queue.shift() ?? []; },
    advance(/** @type {{ id: string }} */ job) {
      advanced.push(job.id);
      return new Promise((resolve) => release.set(job.id, () => resolve({ action: "finished", job })));
    },
    takeReaped() { return []; },
  };
  // the store reports what this process holds as running, as the database does while a batch is out
  const store = { async rows() { return [...release.keys()].map((id) => ({ id, method: "matching.extract", kind: "match_extract" })); } };
  const orchestrator = { async onJobFinished(/** @type {{ job: { id: string } }} */ outcome) { finishedHooks.push(outcome.job.id); } };
  const loops = createVcrWorkerLoops({ jobs, orchestrator, store });
  const slow = /** @type {() => Promise<any>} */ (loops.slowJobs);

  const first = await slow();
  assert.deepEqual([first.claimed, first.advanced, first.inFlight], [1, 1, 1], "the tick returned with the batch out");
  const second = await slow();
  assert.deepEqual([second.claimed, second.advanced, second.inFlight], [1, 1, 2], "another account's batch was taken while the first is out");
  const third = await slow();
  assert.deepEqual([third.claimed, third.advanced, third.inFlight], [0, 0, 2], "a batch in flight is not advanced again");
  assert.deepEqual(advanced, ["job_a", "job_b"]);

  // a batch that ends is finished once: the orchestrator hears of it, and the next tick says so
  /** @type {() => void} */ (release.get("job_a"))();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(finishedHooks, ["job_a"]);
  release.delete("job_a");
  const fourth = await slow();
  assert.deepEqual([fourth.finished, fourth.inFlight], [1, 1]);
  /** @type {() => void} */ (release.get("job_b"))();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(finishedHooks, ["job_a", "job_b"]);

  // a batch that throws leaves the lane running and is reported, not lost in a rejected promise
  /** @type {string[]} */ const reports = [];
  const failing = { ...jobs, report: (/** @type {string} */ code) => reports.push(code), async claim() { return [{ id: "job_x" }]; }, advance() { return Promise.reject(Object.assign(new Error("x"), { code: "vcr_job_failed_here" })); } };
  const lane = /** @type {() => Promise<any>} */ (createVcrWorkerLoops({ jobs: failing, orchestrator, store: { async rows() { return []; } } }).slowJobs);
  await lane();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, ["vcr_job_failed_here"]);
});

test("P2-9 the engine and the local lanes still wait for the jobs they start", async () => {
  /** @type {string[]} */ const order = [];
  const jobs = {
    owner: "me", config: { vcrLocalConcurrency: 2 }, localExecutors: {}, maxConcurrent: 1,
    async claim() { return [{ id: "job_e" }]; },
    async advance() { await new Promise((resolve) => setTimeout(resolve, 5)); order.push("advanced"); return { action: "finished" }; },
    takeReaped() { return []; },
  };
  const loops = createVcrWorkerLoops({ jobs, orchestrator: { async onJobFinished() { order.push("hook"); } }, store: { async rows() { return []; } } });
  const result = await /** @type {() => Promise<any>} */ (loops.jobs)();
  assert.deepEqual(order, ["advanced", "hook"], "the tick returned after the job did");
  assert.equal(result.finished, 1);
});

test("the worker's slow lane lets a long job give its turn back, and no other lane does", async () => {
  const asked = [];
  const rows = [{ id: "job_slow", method: "matching.judge" }, { id: "job_short", method: "matching.evaluate" }];
  const jobs = { owner: "w", config: { vcrLocalConcurrency: 2 }, maxConcurrent: 1, localExecutors: { "matching.judge": () => {}, "matching.evaluate": () => {} },
    async claim({ lane }) { return lane === "slow" ? [{ id: "job_slow" }] : lane === "local" ? [{ id: "job_short" }] : []; },
    async advance(job, options) { asked.push([job.id, options?.mayYield === true]); return { action: "yielded" }; }, takeReaped() { return []; } };
  const loops = createVcrWorkerLoops({ jobs, orchestrator: null, store: { rows: async () => rows.slice(0, 0) } });
  await loops.slowJobs();
  await loops.localJobs();
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.deepEqual(asked.sort(), [["job_short", false], ["job_slow", true]]);
});
