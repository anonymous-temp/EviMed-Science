import assert from "node:assert/strict";
import test from "node:test";
import { completeOwnedAutopilotRun } from "../src/autopilotRunCompletion.mjs";

function fixture() {
  const calls = [];
  const project = { id: "project-one", userId: "user-one" };
  const run = { id: "run-one", sessionId: "session-one", status: "succeeded", artifacts: [] };
  const episode = { id: "episode-one", projectId: project.id, payload: { runId: run.id, sessionId: run.sessionId } };
  const dependencies = {
    service: {
      episodeForRun: async () => episode,
      getEpisode: async () => episode,
      completeRun: async (_userId, input) => { calls.push(["complete", input]); },
    },
    runtimeManager: {
      boundedRuntimeScope: () => ({ runId: episode.id }),
      endBoundedRuntime: async (_project, runId) => { calls.push(["release", runId]); },
    },
    usageLedger: { summaryRun: async (_userId, runId) => { calls.push(["usage", runId]); return { actualCost: 0.25 }; } },
    readDelta: async () => { calls.push(["delta"]); return { claims: [], deltaSchemaVersion: 1 }; },
    audit: async (...args) => { calls.push(["audit", ...args]); },
  };
  return { project, run, episode, dependencies, calls };
}

test("an ordinary or source-understanding completion cannot release a bounded runtime", async () => {
  const f = fixture();
  f.dependencies.service.episodeForRun = async () => null;
  f.run.effectiveRouteReason = "source-understanding:structured";
  assert.equal(await completeOwnedAutopilotRun(f.dependencies, f.project, f.run), false);
  assert.deepEqual(f.calls, []);
});

test("an owned episode uses its own accounting scope and releases only that scope", async () => {
  const f = fixture();
  assert.equal(await completeOwnedAutopilotRun(f.dependencies, f.project, f.run), true);
  assert.deepEqual(f.calls.filter(call => ["usage", "release"].includes(call[0])), [
    ["usage", "episode-one"], ["release", "episode-one"],
  ]);
  assert.equal(f.calls.find(call => call[0] === "complete")[1].costCny, 0.25);
});

test("late episode completion does not stop a newer bounded workflow", async () => {
  const f = fixture();
  f.dependencies.runtimeManager.boundedRuntimeScope = () => ({ runId: "source-generation-two" });
  await completeOwnedAutopilotRun(f.dependencies, f.project, f.run);
  assert.equal(f.calls.filter(call => call[0] === "complete").length, 1);
  assert.equal(f.calls.filter(call => call[0] === "release").length, 0);
});

test("dispatch-race fallback requires the same project, run and session owner", async () => {
  for (const patch of [
    { projectId: "other-project" },
    { payload: { runId: "other-run" } },
    { payload: { sessionId: "other-session" } },
  ]) {
    const f = fixture();
    f.dependencies.service.episodeForRun = async () => null;
    f.run.effectiveRouteReason = "autopilot:literature";
    f.run.dispatchId = f.episode.id;
    f.dependencies.service.getEpisode = async () => ({ ...f.episode, ...patch });
    assert.equal(await completeOwnedAutopilotRun(f.dependencies, f.project, f.run), false);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.dependencies.service.episodeForRun = async () => null;
  f.run.effectiveRouteReason = "autopilot:literature";
  f.run.dispatchId = f.episode.id;
  f.episode.payload = { runId: null, sessionId: null };
  assert.equal(await completeOwnedAutopilotRun(f.dependencies, f.project, f.run), true);
});

test("unavailable ownership evidence cannot authorize completion or runtime release", async () => {
  const f = fixture();
  f.dependencies.service.episodeForRun = async () => { throw new Error("database unavailable"); };
  assert.equal(await completeOwnedAutopilotRun(f.dependencies, f.project, f.run), false);
  assert.equal(f.calls.filter(call => call[0] === "audit").length, 1);
  assert.equal(f.calls.filter(call => call[0] !== "audit").length, 0);
});

test("an independent verification run is not an episode result and cannot be folded as one", async () => {
  // A verification carries its own bounded scope and folds into one claim.
  // `autopilot-verify` is deliberately not `autopilot:`, so a prefix check
  // loosened to `startsWith("autopilot")` would let the episode completion
  // claim it, release the verification's runtime under an episode's name and
  // fold a verdict artifact as an agenda delta.
  // Both route reasons a verification run can carry: the one the caller asks
  // for, and "session-binding", which is what `AgentRunStore.dispatch` actually
  // records for a specialist-bound session and therefore what production sees.
  for (const routeReason of ["autopilot-verify", "session-binding"]) {
    const f = fixture();
    f.dependencies.service.episodeForRun = async () => null;
    f.run.effectiveRouteReason = routeReason;
    f.run.dispatchId = "episode-abcdef01234567890123456789012345-v0";
    assert.equal(await completeOwnedAutopilotRun(f.dependencies, f.project, f.run), false);
    assert.deepEqual(f.calls, [], "a verification run must not reach the episode fold, the usage scope or the runtime release");
  }
});
