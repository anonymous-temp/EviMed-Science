// The worker's timer and its six loops, without a database: which loops exist
// and how often they start, what a loop without its function reports, that one
// loop failing leaves the others running, and that the recheck loop is wired to
// the matching package's `recheckDue` and only when it is composed.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_WORKER_LOOPS, VcrWorker, createVcrWorkerLoops, withVcrWorkerWarnings } from "../src/vcrWorker.mjs";

test("the six loops, their cadences and which of them are leased", () => {
  assert.deepEqual(VCR_WORKER_LOOPS.map((loop) => loop.name), ["jobs", "orchestrator", "recompute", "recheck", "frontierEvents", "packSources"]);
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
