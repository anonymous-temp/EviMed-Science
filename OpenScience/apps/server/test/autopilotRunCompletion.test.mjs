import assert from "node:assert/strict";
import test from "node:test";
import { completeOwnedAutopilotRun, sweepAutopilotOrphans } from "../src/autopilotRunCompletion.mjs";

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

test("completion preserves safe stored-run artifacts and never accepts an artifact URL supplied by the delta", async () => {
  const f = fixture();
  f.run.artifacts = ["reports/result.md", "scripts/reproduce.py", "../secret", "https://invented.test/output"];
  f.run.unverifiedArtifacts = ["data/partial.csv"];
  f.run.status = "failed";
  f.dependencies.readDelta = async () => ({ projectId: "other", runId: "fake", sessionId: "fake", status: "succeeded", deltaSchemaVersion: 1, claims: [], artifactRefs: [{ projectId: "other", runId: "fake", sessionId: "fake", path: "fake.md" }] });
  await completeOwnedAutopilotRun(f.dependencies, f.project, f.run);
  const completed = f.calls.find(call => call[0] === "complete")[1];
  assert.equal(completed.runId, f.run.id);
  assert.equal(completed.status, "failed");
  assert.deepEqual(completed.artifactRefs, ["reports/result.md", "scripts/reproduce.py", "data/partial.csv"].map(path => ({ projectId: f.project.id, runId: f.run.id, sessionId: f.run.sessionId, path })));
});

test("a proven pre-prompt pause is canceled without folding a scientific failure", async () => {
  const f = fixture();
  f.run.status = "failed"; f.run.dispatchStatus = "rejected"; f.run.errorCode = "autopilot_paused";
  f.dependencies.service.markEpisodeCanceled = async (...args) => f.calls.push(["canceled", ...args]);
  await completeOwnedAutopilotRun(f.dependencies, f.project, f.run);
  assert.equal(f.calls.some(call => call[0] === "delta" || call[0] === "complete" || call[0] === "usage"), false);
  assert.equal(f.calls.filter(call => call[0] === "canceled").length, 1);
  assert.equal(f.calls.filter(call => call[0] === "release").length, 1);
});

test("an expired worker's proven unsent lease loss records facts without science outcomes or runtime cleanup", async () => {
  const f = fixture();
  f.run.status="failed"; f.run.dispatchStatus="rejected"; f.run.errorCode="product_job_lease_lost";
  f.dependencies.service.recordUnsentAttempt=async(...args)=>f.calls.push(["unsent",...args]);
  await completeOwnedAutopilotRun(f.dependencies,f.project,f.run);
  assert.deepEqual(f.calls.map(call=>call[0]),["unsent"]);
});

test("an episode whose run ended while its fold failed is folded by the sweep; one still working is left alone (2026-10-05 EAI_AGAIN)", async () => {
  const rows = [
    { user_id: "u1", project_id: "p1", run_id: "run-failed" },
    { user_id: "u1", project_id: "p1", run_id: "run-still-working" },
    { user_id: "u1", project_id: "p-gone", run_id: "run-of-a-deleted-project" },
    { user_id: "u1", project_id: "p1", run_id: "run-unreadable" },
  ];
  const queries = [];
  const database = { query: async (sql) => { queries.push(sql); return { rows }; } };
  const runs = { "run-failed": { id: "run-failed", status: "failed" }, "run-still-working": { id: "run-still-working", status: "running" } };
  const folded = [];
  const result = await sweepAutopilotOrphans({
    database,
    readRun: async ({ projectId, runId }) => {
      if (runId === "run-unreadable") throw new Error("EAI_AGAIN");
      return projectId === "p-gone" ? null : { project: { id: projectId }, run: runs[runId] };
    },
    fold: async (project, run) => { folded.push([project.id, run.id]); },
  });
  assert.deepEqual(folded, [["p1", "run-failed"]]);
  assert.deepEqual(result, { looked: 4, folded: 1 });
  assert.match(queries[0], /payload->>'status'='running'/);
  assert.match(queries[0], /interval '15 minutes'/, "a record that moved recently is not swept");
});

