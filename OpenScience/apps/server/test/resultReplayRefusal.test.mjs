// A calculation the data cannot support is declined under a name, and the name reaches the researcher.
//
// The worker used to answer every failed engine job with `result_replay_failed` and drop what the engine said,
// so a run whose meta.dl input had one study was told only that "the calculation did not finish" and went looking
// for the cause in its container. The engine answers a refusal with a code from a closed list (the `refusals` of
// the method records); the worker passes exactly those through, and nothing else the engine sends.
import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_INPUT_CODES, METHOD_REFUSAL_CODES } from "@evimed/domain/method-records";
import { ResultReplayWorker } from "../src/resultReplayWorker.mjs";

/** A worker over doubles: one claimed job whose engine answers `answer`. Returns what the job was failed with. */
async function failedWith(answer) {
  const failures = []; const stopped = [];
  const job = { id: "job", userId: "owner", projectId: "p", leaseToken: "lease", payload: {} };
  const worker = new ResultReplayWorker({
    service: { reconcileTerminatedAttempts: async () => {}, prepare: async () => ({ execution: {} }), start: async () => answer,
      stop: async (_job, prepared) => { stopped.push(prepared); return true; }, complete: async () => { throw new Error("must not complete"); } },
    jobs: { claim: async () => job, renew: async () => true, fail: async (_user, _id, _lease, error, options) => failures.push({ error, options }) },
    engine: { status: async () => answer }, config: { resultReplayTimeoutMs: 1000 },
  });
  await worker.process();
  return { failures, stopped };
}

test("every refusal in the method records reaches the job as its own code, and the engine is told to stop", async () => {
  assert.ok(METHOD_REFUSAL_CODES.size >= 9);
  for (const code of [...METHOD_REFUSAL_CODES, ...ENGINE_INPUT_CODES]) {
    const { failures, stopped } = await failedWith({ state: "failed", error: code, cleanup: "confirmed" });
    assert.equal(failures.length, 1, code);
    assert.equal(failures[0].error.code, code);
    assert.equal(failures[0].options.retry, false, "a refused input is not retried");
    assert.equal(stopped.length, 1, "cleanup runs for a refusal as for any failure");
  }
});

test("only a code from the records' closed list is repeated, never what an engine merely wrote", async () => {
  for (const error of ["replay_made_up", "an upstream stack trace with a credential", "replay_code_changed", { code: "replay_single_study" }, 7, null, undefined, "REPLAY_SINGLE_STUDY"]) {
    const { failures } = await failedWith({ state: "failed", error, cleanup: "confirmed" });
    assert.equal(failures[0].error.code, "result_replay_failed", JSON.stringify(error));
    assert.equal(failures[0].error.message, "The calculation did not finish.");
  }
});

test("a canceled, timed-out or unconfirmed calculation keeps its own outcome even if it carries a refusal code", async () => {
  assert.equal((await failedWith({ state: "canceled", error: "replay_single_study" })).failures[0].error.code, "result_replay_failed");
  assert.equal((await failedWith({ state: "timed_out", error: "replay_single_study" })).failures[0].error.code, "result_replay_failed");
  assert.equal((await failedWith({ state: "ownership_unknown", error: "replay_single_study" })).failures[0].error.code, "result_replay_stop_unconfirmed");
});
