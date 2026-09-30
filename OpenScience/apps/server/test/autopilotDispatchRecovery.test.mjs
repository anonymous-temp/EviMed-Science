import assert from "node:assert/strict";
import test from "node:test";
import { inspectAutopilotDispatch, reclaimUnsentAutopilotRuntime } from "../src/autopilotDispatchRecovery.mjs";

const episodeId = `episode-${"a".repeat(32)}`;
const project = { id: "p", userId: "u" };
function fixture(runs = []) {
  const calls = [];
  const episode = { id: episodeId, projectId: "p", payload: {} };
  const service = { getEpisode: async () => episode, recordUnsentAttempt: async (...args) => { calls.push(args); return episode; } };
  return { service, agentRuns: { list: async () => runs }, calls, episode };
}
const failed = { id: "old", sessionId: "s", dispatchId: episodeId, status: "failed", dispatchStatus: "rejected", errorCode: "product_job_lease_lost", effectiveRouteReason: "autopilot:literature-sentinel" };

test("only a proved unsent attempt may become a new execution; accepted and unknown are reused", async () => {
  for (const run of [{ ...failed, status: "running", dispatchStatus: "accepted" }, { ...failed, status: "running", dispatchStatus: "unknown" },
    { ...failed, status: "succeeded", dispatchStatus: "accepted" }, { ...failed, errorCode: "scientific_failure" }]) {
    const f = fixture([run]);
    assert.equal((await inspectAutopilotDispatch(f, project, { episodeId, dispatchId: `${episodeId}-a2` })).replay.id, run.id);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture([failed]);
  const result = await inspectAutopilotDispatch(f, project, { episodeId, dispatchId: `${episodeId}-a2` });
  assert.equal(result.unsent.id, failed.id);
  assert.equal(result.replay, null);
});

test("a dispatch still sending, a missing recorded run, or the same failed attempt waits instead of duplicating work", async () => {
  const f = fixture([{ ...failed, status: "running", dispatchStatus: "dispatching" }]);
  await assert.rejects(inspectAutopilotDispatch(f, project, { episodeId, dispatchId: `${episodeId}-a2` }), { code: "autopilot_dispatch_pending" });
  await assert.rejects(inspectAutopilotDispatch(fixture([failed]), project, { episodeId, dispatchId: episodeId }), { code: "autopilot_dispatch_pending" });
  const missing = fixture(); missing.episode.payload.runId = "unknown-previous";
  await assert.rejects(inspectAutopilotDispatch(missing, project, { episodeId, dispatchId: `${episodeId}-a2` }), { code: "autopilot_dispatch_pending" });
});

test("reclaim requires a current lease and a known captured generation, including failed-close recovery", async () => {
  const f = fixture([failed]);
  let cleaned = 0, allowed = 0;
  const manager = { boundedRuntimeCleanupTarget: () => ({ runId: episodeId, generation: "generation-one" }),
    endBoundedRuntime: async (_project, scope, generation) => { assert.equal(scope, episodeId); assert.equal(generation, "generation-one"); cleaned += 1; return true; } };
  const input = { episodeId, assertDispatchAllowed: async () => { allowed += 1; } };
  await reclaimUnsentAutopilotRuntime({ ...f, runtimeManager: manager }, project, input, failed);
  assert.equal(cleaned, 1); assert.equal(allowed, 1); assert.equal(f.calls.length, 1);
  manager.boundedRuntimeCleanupTarget = () => ({ runId: episodeId, generation: null });
  await assert.rejects(reclaimUnsentAutopilotRuntime({ ...f, runtimeManager: manager }, project, input, failed), { code: "autopilot_dispatch_pending" });
  manager.boundedRuntimeCleanupTarget = () => ({ runId: episodeId, generation: "generation-two" });
  await assert.rejects(reclaimUnsentAutopilotRuntime({ ...f, runtimeManager: manager }, project, { ...input, assertDispatchAllowed: async () => { throw Object.assign(new Error("Lost"), { code: "product_job_lease_lost" }); } }, failed), { code: "product_job_lease_lost" });
  assert.equal(cleaned, 1);
});

test("other scopes and forged ordinary dispatch ids never authorize cleanup or replay", async () => {
  const f = fixture([{ ...failed, effectiveRouteReason: "classifier" }]);
  assert.equal((await inspectAutopilotDispatch(f, project, { episodeId, dispatchId: `${episodeId}-a2` })).replay, null);
  const manager = { boundedRuntimeCleanupTarget: () => ({ runId: "another-scope", generation: "g" }), endBoundedRuntime: async () => { throw new Error("Must not close another scope"); } };
  await assert.rejects(reclaimUnsentAutopilotRuntime({ ...f, runtimeManager: manager }, project, { episodeId, assertDispatchAllowed: async () => {} }, failed), { code: "autopilot_dispatch_pending" });
});
