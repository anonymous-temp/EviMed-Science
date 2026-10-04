// What a recalculation found is carried to the methods the original's run read, after the lease that finished it (N14).
//
// What these cases are for: `complete` runs inside the worker's own try, so a thing that throws after the calculation
// has been admitted would stop a process that is already over and fail a job that already succeeded. The hook is told
// what the replay was compared to and never decides; and the engine's own diagnostics become an applicability
// observation only in the vocabulary the method's record lists.
import assert from "node:assert/strict";
import test from "node:test";
import { ResultReplayService, replayApplicability } from "../src/resultReplayService.mjs";

const ORIGINAL = { versionId: `rv_${"1".repeat(64)}`, digest: "a".repeat(64), producer: { runId: "run-1" } };
const COMPARISON = { bytes: "changed", numbers: { status: "within-tolerance" }, environment: { status: "same" }, scientificApplicability: "not_assessed" };

/** A service whose lease and calculation are stand-ins: `complete` is what is under test. */
function service(compared, { comparison = COMPARISON, original = ORIGINAL, applicability = { state: "flagged", basis: "engine_diagnostics", codes: ["few_studies"] } } = {}) {
  const calls = [];
  const replay = new ResultReplayService({ results: {}, documents: {}, jobs: {}, engine: {}, compared });
  replay.withProjectLease = async (job, operation) => { calls.push("lease:start"); try { return await operation(); } finally { calls.push("lease:end"); } };
  replay.completeOwned = async (job, prepared) => { calls.push("completed"); prepared.comparison = comparison; prepared.applicability = applicability; return { versionId: `rv_${"7".repeat(64)}` }; };
  return { replay, calls, prepared: { project: { id: "p", userId: "owner" }, original } };
}

test("the comparison is told after the lease has ended, with the original, the output, the comparison and what the diagnostics said", async () => {
  const told = [];
  const { replay, calls, prepared } = service(async input => { calls.push("told"); told.push(input); });
  const output = await replay.complete({ payload: { replayId: "replay-1" } }, prepared, { state: "succeeded" });
  assert.deepEqual(calls, ["lease:start", "completed", "lease:end", "told"]);
  assert.equal(output.versionId, `rv_${"7".repeat(64)}`);
  assert.deepEqual(told.map(input => [input.project.id, input.original.versionId, input.replayId, input.output.versionId, input.comparison.numbers.status, input.applicability.codes]),
    [["p", ORIGINAL.versionId, "replay-1", `rv_${"7".repeat(64)}`, "within-tolerance", ["few_studies"]]]);
});

test("a hook that throws never fails the calculation that has finished, and a recalculation with no original has nothing to tell", async () => {
  const failing = service(async () => { throw Object.assign(new Error("down"), { code: "method_ledger_down" }); });
  const output = await failing.replay.complete({ payload: { replayId: "replay-1" } }, failing.prepared, { state: "succeeded" });
  assert.ok(output.versionId, "the result stands");
  const told = [];
  const orphan = service(async input => told.push(input), { original: null });
  await orphan.replay.complete({ payload: { replayId: "replay-2" } }, { project: { id: "p" }, original: null }, { state: "succeeded" });
  assert.deepEqual(told, []);
  // And a deployment without the join runs as it always did.
  const bare = service(null);
  assert.ok((await bare.replay.complete({ payload: { replayId: "replay-3" } }, bare.prepared, { state: "succeeded" })).versionId);
});

test("the engine's diagnostics are an applicability observation only in the vocabulary the method's record lists, and no list is unknown", () => {
  assert.deepEqual(replayApplicability("meta.dl", { result: { diagnostics: [{ code: "few_studies" }, { code: "made_up_by_the_engine" }] } }),
    { state: "flagged", basis: "engine_diagnostics", codes: ["few_studies"] });
  assert.deepEqual(replayApplicability("meta.dl", { result: { diagnostics: [] } }), { state: "unflagged", basis: "engine_diagnostics", codes: [] });
  assert.deepEqual(replayApplicability("meta.dl", { result: {} }), { state: "unknown", basis: "none", codes: [] });
  assert.deepEqual(replayApplicability("meta.dl", null), { state: "unknown", basis: "none", codes: [] });
  // The R engine writes an object, not a list; it is not read as one.
  assert.deepEqual(replayApplicability("design.analytic", { result: { diagnostics: { arms: [] } } }), { state: "unknown", basis: "none", codes: [] });
  // A method with no record has nothing to be read against.
  assert.equal(replayApplicability("not.a.method", { result: { diagnostics: [{ code: "few_studies" }] } }), undefined);
});
