import assert from "node:assert/strict";
import test from "node:test";
import { AutopilotWorker } from "../src/autopilotWorker.mjs";

function fixture({ enabled = true, dispatchError = null, cancelJob = false } = {}) {
  const calls = [];
  const job = { id: "job-one", userId: "user-one", projectId: "project-one", leaseToken: "lease-one", attempts: 1,
    payload: cancelJob
      ? { action: "cancel", episodeId: "episode-one", runId: "run-one", sessionId: "session-one" }
      : { agendaId: "agenda-one", episodeId: "episode-one", taskType: "evidence-update", budgetCny: 3, prompt: "Run evidence update" } };
  const service = {
    get: async () => ({ id: "agenda-one", projectId: "project-one", revision: 2, payload: { enabled, status: enabled ? "active" : "paused" } }),
    checkInactivity: async () => ({ id: "agenda-one", projectId: "project-one", revision: 2, payload: { enabled, status: enabled ? "active" : "paused" } }),
    getEpisode: async () => ({ id: "episode-one", projectId: "project-one", revision: 1, payload: { status: "queued" } }),
    markEpisodeDispatched: async (...args) => { calls.push({ method: "mark", args }); return { revision: 2 }; },
    markEpisodeFailed: async (...args) => { calls.push({ method: "failed", args }); },
    markEpisodeCanceled: async (...args) => { calls.push({ method: "canceled", args }); },
    markCancellationCompleted: async (...args) => { calls.push({ method: "cancellationComplete", args }); },
    queueDispatchedCancellation: async (...args) => { calls.push({ method: "queueCancellation", args }); },
  };
  const jobs = {
    claim: async () => job,
    renew: async () => true,
    finish: async (...args) => { calls.push({ method: "finish", args }); },
    fail: async (...args) => { calls.push({ method: "jobFail", args }); },
  };
  const dispatchEpisode = async (...args) => {
    calls.push({ method: "dispatch", args });
    if (dispatchError) throw dispatchError;
    return { runId: "run-one", sessionId: "session-one" };
  };
  const cancelDispatched = async (...args) => { calls.push({ method: "cancelDispatched", args }); };
  return { calls, service, worker: new AutopilotWorker({ jobs, service, dispatchEpisode, cancelDispatched, pollMs: 100, leaseMs: 1000 }) };
}

test("an episode lease dispatches through the ordinary run path and records identity", async () => {
  const { calls, worker } = fixture();
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["dispatch", "finish"]);
  assert.equal(calls[0].args[0].prompt, "Run evidence update");
  assert.equal(calls[1].args[3].runId, "run-one");
  assert.equal(worker.status().lastError, null);
});

test("a paused agenda prevents a claimed job from spending", async () => {
  const { calls, worker } = fixture({ enabled: false });
  await worker.tick();
  assert.equal(calls.some((call) => call.method === "dispatch"), false);
  assert.equal(calls.find((call) => call.method === "finish").args[3].skipped, true);
});

test("a lease lost while checking activity prevents dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { calls, service, worker } = fixture();
  let readsStarted;
  let finishRead;
  const reading = new Promise((resolve) => { readsStarted = resolve; });
  service.checkInactivity = async () => {
    readsStarted();
    return new Promise((resolve) => { finishRead = resolve; });
  };
  let renewals = 0;
  worker.jobs.renew = async () => ++renewals === 1;
  const tick = worker.tick();
  await reading;
  t.mock.timers.tick(1000);
  await Promise.resolve();
  finishRead({ payload: { enabled: true, status: "active" } });
  await tick;
  assert.equal(calls.some(call => call.method === "dispatch"), false);
  assert.equal(worker.status().lastError, "product_job_lease_lost");
});

test("an expired lease with a pending background renewal is revalidated after the activity check", { timeout: 5000 }, async () => {
  const { calls, service, worker } = fixture();
  const sequence = [];
  let finishPending;
  let renewals = 0;
  worker.jobs.renew = async () => {
    renewals++;
    sequence.push(`renew-${renewals}`);
    if (renewals === 1) return true;
    if (renewals === 2) return new Promise((resolve) => { finishPending = resolve; });
    return false;
  };
  service.checkInactivity = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return { payload: { enabled: true, status: "active" } };
  };
  const dispatch = worker.dispatchEpisode;
  worker.dispatchEpisode = async (...args) => { sequence.push("dispatch"); return dispatch(...args); };
  try {
    await worker.tick();
    assert.deepEqual(sequence, ["renew-1", "renew-2", "renew-3"]);
    assert.equal(calls.some(call => call.method === "dispatch"), false);
    assert.equal(worker.status().lastError, "product_job_lease_lost");
  } finally {
    finishPending?.(false);
  }
});

test("dispatch failures update the episode and use bounded queue retry", async () => {
  const error = new Error("runtime unavailable");
  error.code = "runtime_unavailable";
  const { calls, worker } = fixture({ dispatchError: error });
  await worker.tick();
  assert.equal(calls.some((call) => call.method === "failed"), true);
  const failure = calls.find((call) => call.method === "jobFail");
  assert.equal(failure.args[3].code, "runtime_unavailable");
  assert.equal(failure.args[4].retry, true);
  assert.equal(worker.status().lastError, "runtime_unavailable");
});

test("an occupied project waits past the runtime idle window before consuming another attempt", async () => {
  const error = new Error("runtime busy");
  error.code = "runtime_busy";
  const { calls, worker } = fixture({ dispatchError: error });
  await worker.tick();
  const failure = calls.find((call) => call.method === "jobFail");
  assert.equal(failure.args[4].retry, true);
  assert.equal(failure.args[4].delayMs, 31 * 60_000);
});

test("a durable cancellation job terminates one runtime session and records completion", async () => {
  const { calls, worker } = fixture({ cancelJob: true });
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["cancelDispatched", "cancellationComplete", "finish"]);
  assert.equal(calls.some((call) => call.method === "dispatch"), false);
});
