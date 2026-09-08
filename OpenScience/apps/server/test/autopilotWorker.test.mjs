import assert from "node:assert/strict";
import test from "node:test";
import { verificationEpisodeId, verificationIdFor } from "../src/autopilotService.mjs";
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
  assert.equal(calls[0].args[0].episodeId, "episode-one");
  assert.equal(calls.some((call) => call.method === "dispatch"), false);
});

// ---------------------------------------------------------------------------
// Verification jobs. `verify` was declared in PRODUCT_JOB_KINDS and nothing had
// ever enqueued one; these cover the leased half of the second process.
// ---------------------------------------------------------------------------

// The real id format, not a readable stand-in: this is the one fixture that
// carries a verification id across the worker -> dispatch -> fold boundary,
// and the format has to survive `safeId` and `verificationEpisodeId` there.
const EPISODE_ID = `episode-${"0123456789abcdef".repeat(2)}`;
const VERIFICATION_ID = verificationIdFor(EPISODE_ID, 0);

function verifyFixture({ enabled = true, dispatchError = null, finishError = null, attempts = 1, verifier = true } = {}) {
  const calls = [];
  const job = { id: "job-verify", kind: "verify", userId: "user-one", projectId: "project-one",
    leaseToken: "lease-one", attempts, maxAttempts: 3,
    payload: { agendaId: "agenda-one", episodeId: EPISODE_ID, digestId: "digest-one",
      verificationId: VERIFICATION_ID, claimId: "claim-one", statement: "A finding",
      sources: ["doi:10.1000/one"], artifact: "reports/evidence.md", budgetCny: 2 } };
  const agenda = { id: "agenda-one", projectId: "project-one", revision: 2,
    payload: { enabled, status: enabled ? "active" : "paused" } };
  const service = {
    get: async () => agenda,
    checkInactivity: async (...args) => { calls.push({ method: "checkInactivity", args }); return agenda; },
    getEpisode: async () => ({ id: EPISODE_ID, projectId: "project-one", revision: 1, payload: { status: "merged" } }),
    markEpisodeFailed: async (...args) => { calls.push({ method: "failed", args }); },
    recordVerification: async (...args) => { calls.push({ method: "record", args }); },
  };
  const claimed = [];
  const jobs = {
    claim: async (kinds) => { claimed.push(kinds); return job; },
    renew: async () => true,
    finish: async (...args) => {
      calls.push({ method: "finish", args });
      if (finishError) throw finishError;
    },
    fail: async (...args) => { calls.push({ method: "jobFail", args }); },
  };
  const dispatchVerification = async (...args) => {
    calls.push({ method: "verify", args });
    if (dispatchError) throw dispatchError;
    return { runId: "verify-run", sessionId: "verify-session" };
  };
  return { calls, claimed, job, service, worker: new AutopilotWorker({ jobs, service,
    dispatchEpisode: async () => assert.fail("a verification must never run the episode dispatch"),
    ...(verifier ? { dispatchVerification } : {}), pollMs: 100, leaseMs: 1000 }) };
}

test("a worker takes verification work only when it has a verifier to run it", () => {
  const withVerifier = verifyFixture();
  assert.deepEqual(withVerifier.worker.kinds, ["episode", "verify"]);
  const without = verifyFixture({ verifier: false });
  assert.deepEqual(without.worker.kinds, ["episode"],
    "a worker with no verifier must leave verification jobs queued, not retire them");
  assert.throws(() => new AutopilotWorker({ jobs: {}, service: {}, dispatchEpisode: () => {}, dispatchVerification: "no" }), TypeError);
});

test("a verification lease dispatches an independent check and settles the job", async () => {
  const { calls, claimed, worker } = verifyFixture();
  await worker.tick();
  assert.deepEqual(claimed[0], ["episode", "verify"], "the worker must ask the queue for verification work");
  assert.deepEqual(calls.map((call) => call.method), ["checkInactivity", "verify", "finish"]);
  const dispatched = calls.find((call) => call.method === "verify").args[0];
  assert.equal(dispatched.verificationId, VERIFICATION_ID);
  assert.equal(verificationEpisodeId(dispatched.verificationId), EPISODE_ID,
    "the id the worker dispatches is the id the completion fold reads back");
  assert.equal(dispatched.userId, "user-one");
  assert.equal(dispatched.projectId, "project-one");
  assert.deepEqual(dispatched.sources, ["doi:10.1000/one"]);
  assert.equal(calls.find((call) => call.method === "finish").args[3].runId, "verify-run");
  assert.equal(worker.status().lastError, null);
});

test("the stop rules bind a verification exactly as they bind the episode that earned it", async () => {
  const { calls, worker } = verifyFixture({ enabled: false });
  await worker.tick();
  assert.equal(calls.some((call) => call.method === "verify"), false, "a parked direction must not spend on re-checking");
  assert.equal(calls.find((call) => call.method === "finish").args[3].skipped, true);
  assert.equal(calls.some((call) => call.method === "record"), false);
});

test("a verification nobody can afford is terminal, and the claim is told so instead of being promoted", async () => {
  const error = new Error("This account reached its spending limit.");
  error.code = "usage_budget_exceeded";
  const { calls, worker } = verifyFixture({ dispatchError: error });
  await worker.tick();
  const recorded = calls.find((call) => call.method === "record");
  assert.ok(recorded, "an unaffordable verification must be recorded, not silently dropped");
  assert.deepEqual(recorded.args[1], { episodeId: EPISODE_ID, verificationId: VERIFICATION_ID, errorCode: "usage_budget_exceeded" });
  const failure = calls.find((call) => call.method === "jobFail");
  assert.equal(failure.args[4].retry, false, "retrying a refused budget spends the claim's budget on the same refusal");
  assert.equal(calls.some((call) => call.method === "failed"), false, "one claim's verification must not fail its whole episode");
});

test("a transient verification failure retries, and the claim is only told once the attempts are gone", async () => {
  const error = new Error("runtime unavailable");
  error.code = "runtime_unavailable";
  const retrying = verifyFixture({ dispatchError: error });
  await retrying.worker.tick();
  assert.equal(retrying.calls.find((call) => call.method === "jobFail").args[4].retry, true);
  assert.equal(retrying.calls.some((call) => call.method === "record"), false);

  const exhausted = verifyFixture({ dispatchError: error, attempts: 3 });
  await exhausted.worker.tick();
  assert.equal(exhausted.calls.find((call) => call.method === "jobFail").args[4].retry, false);
  assert.equal(exhausted.calls.find((call) => call.method === "record").args[1].errorCode, "runtime_unavailable");
});

test("a verification that was actually dispatched is never reported to the claim as unavailable", async () => {
  // The failure comes after the run was accepted -- the settlement throws on the
  // last attempt, so `terminal` is true and the code is not a lost lease. The
  // run is out there and its verdict is on its way; telling the claim its
  // verification never happened would drop that verdict on arrival.
  const error = new Error("job store offline");
  error.code = "product_job_unavailable";
  const { calls, worker } = verifyFixture({ finishError: error, attempts: 3 });
  await worker.tick();
  assert.equal(calls.some((call) => call.method === "verify"), true, "the verification run was dispatched");
  assert.equal(calls.some((call) => call.method === "record"), false,
    "a dispatched verification must not be recorded as one that never ran");
  assert.equal(calls.find((call) => call.method === "jobFail").args[4].retry, false);
});
