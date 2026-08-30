// Production crash-looped 48 times on 2026-08-30 and the cause was one missing
// `.catch`. Startup adopts the previous life's running runs by scheduling a
// monitor per run; the monitor promise is stored so shutdown can await it, and
// on that path `closeProject` does catch. On the detached path — which is the
// one adoption uses — nothing did, so a monitor that threw became an unhandled
// rejection and Node exited. The container reported 137 two seconds after
// "EviMed Web API listening", forty-eight times.
//
// The trigger was a 502 `runtime_cleanup_failed` from the runtime controller:
// an orphaned container that would not go away took down the API for every
// user. Housekeeping must not be able to do that.
import assert from "node:assert/strict";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { HttpError } from "../src/security.mjs";

/** A ledger stub: enough for scheduleMonitor to run and for us to see the verdict. */
function runsWith(listImpl) {
  const runs = Object.create(AgentRunStore.prototype);
  runs.monitors = new Map();
  runs.projects = new Map();
  runs.monitorMaxPolls = 1;
  runs.monitorStallPolls = 0;
  runs.monitorIntervalMs = 1;
  runs.finished = [];
  runs.list = listImpl;
  runs.reconcileSession = async () => ({ status: "running" });
  runs.recordProgress = async () => true;
  runs.finishInternal = async (project, runId, verdict) => { runs.finished.push({ runId, ...verdict }); };
  return runs;
}

test("a monitor that throws finishes its own run instead of killing the process", async () => {
  const runs = runsWith(async () => {
    throw new HttpError(502, "runtime_cleanup_failed", "Runtime controller could not clean up the runtime container.");
  });
  runs.scheduleMonitor({ userId: "u", id: "p" }, "run-1");
  await runs.monitors.get("run-1")?.promise;

  assert.deepEqual(runs.finished, [{ runId: "run-1", status: "failed", errorCode: "runtime_cleanup_failed", artifacts: [] }]);
});

test("the rejection never escapes to the process", async () => {
  // The assertion that matters. Without the catch this test's process would
  // take an unhandledRejection, which is what production actually did.
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const runs = runsWith(async () => { throw new Error("controller unreachable"); });
    runs.scheduleMonitor({ userId: "u", id: "p" }, "run-2");
    await runs.monitors.get("run-2")?.promise;
    // Two turns of the microtask queue, because an unhandled rejection is
    // reported after the promise settles rather than when it rejects.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(seen, [], "a detached monitor must never produce an unhandled rejection");
});

test("a ledger write that also fails does not re-throw into the same catch", async () => {
  // The second failure of one run, with nowhere left to report it. Re-throwing
  // would land back in the catch that exists to prevent exactly this.
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const runs = runsWith(async () => { throw new Error("controller unreachable"); });
    runs.finishInternal = async () => { throw new Error("ledger unwritable"); };
    runs.scheduleMonitor({ userId: "u", id: "p" }, "run-3");
    await runs.monitors.get("run-3")?.promise;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(seen, []);
});

test("the monitor is removed from the map either way", async () => {
  const runs = runsWith(async () => { throw new Error("boom"); });
  runs.scheduleMonitor({ userId: "u", id: "p" }, "run-4");
  await runs.monitors.get("run-4")?.promise;
  assert.equal(runs.monitors.has("run-4"), false, "a failed monitor must not hold its slot forever");
});
