import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVcrStudyStart, vcrStartIdentity } from "../src/vcrStudyStart.mjs";
import { AgentRunStore } from "../src/agentRuns.mjs";

function fixture() {
  const study = { id: "study_1", projectId: "project_1", userId: "owner", status: "draft", purpose: "programme" };
  const rows = []; const prompts = []; const saved = []; const claims = [];
  let busy = false;
  const orchestrator = {
    async claimIntake(_study, input) { claims.push(input); return { async bind(run) { run.bound = true; }, async release() {} }; },
    async recoverIntake() {}, async intakeStatus() { return "accepted"; },
  };
  const start = createVcrStudyStart({
    conversations: async () => ({ exists: true, sessionId: "canonical" }),
    projectFor: async () => ({ id: study.projectId }),
    runs: { list: async () => rows, existingDispatch: async (_project, run) => run },
    inbox: async () => ({ running: busy, queued: 0 }), orchestrator: () => orchestrator,
    save: async (_user, _study, input) => saved.push(input.brief),
    dispatch: async (_user, _project, sessionId, dispatchId, text, options) => {
      const run = { id: "run_1", sessionId, dispatchId, dispatchFingerprint: options.dispatchFingerprint, status: "running", dispatchStatus: "accepted" };
      await options.beforeReserve(); rows.push(run); await options.beforeSend(run); await options.beforePrompt();
      assert.equal(run.bound, true, "reserve binding precedes the actual visible message");
      prompts.push({ sessionId, text, system: options.systemSupplement }); return run;
    },
  });
  return { study, rows, prompts, saved, claims, start, busy: () => { busy = true; } };
}

test("Start sends the exact partial brief once into the canonical conversation and rereads while busy", async () => {
  const f = fixture(); const brief = "  A partial research idea\nPopulation not decided yet.  ";
  const input = { brief, requestId: "request_123" };
  const first = await f.start({ id: "owner" }, f.study, input); f.busy();
  assert.deepEqual(await f.start({ id: "owner" }, f.study, input), first);
  assert.deepEqual(f.prompts.map(p => [p.sessionId, p.text]), [["canonical", brief]]);
  assert.deepEqual(f.saved, [brief]); assert.equal(f.claims[0].action, "definition");
  assert.match(f.prompts[0].system, /missing essentials/);
  await assert.rejects(f.start({ id: "owner" }, f.study, { ...input, brief: brief + "changed" }), { code: "agent_run_dispatch_conflict" });
  assert.equal(f.saved.length, 1);
});

test("busy and calculation refuse without mutating the study or sending", async () => {
  const f = fixture(); f.busy();
  await assert.rejects(f.start({ id: "owner" }, f.study, { brief: "Question", requestId: "request_123" }), { code: "vcr_conversation_busy" });
  await assert.rejects(f.start({ id: "owner" }, { ...f.study, purpose: "calculation" }, { brief: "Question", requestId: "request_123" }), { code: "vcr_calculation_research_required" });
  assert.deepEqual(f.saved, []); assert.deepEqual(f.claims, []); assert.deepEqual(f.prompts, []);
});

test("ledger persists fingerprint across restart and rejects payload/session collisions, including locked reservation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vcr-start-ledger-"));
  const project = { id: "project", userId: "owner", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const binding = { sessionId: "canonical", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const make = () => new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-flash", readSessionHistory: async () => [], monitorIntervalMs: 60_000 });
  const store = make(); const restarted = make(); let calls = 0;
  const base = { brief: "Q".repeat(1000) + "tail-A", requestId: "request_123" };
  const identity = vcrStartIdentity({ id: "study" }, binding.sessionId, base, "owner");
  try {
    const run = await store.dispatch(project, { sessionId: binding.sessionId, ...identity }, async () => { calls++; return { accepted: true }; });
    assert.equal(run.dispatchFingerprint, identity.dispatchFingerprint);
    const replay = await restarted.dispatch(project, { sessionId: binding.sessionId, ...identity }, async () => { calls++; });
    assert.equal(replay.id, run.id); assert.equal(calls, 1);
    const changed = vcrStartIdentity({ id: "study" }, binding.sessionId, { ...base, brief: "Q".repeat(1000) + "tail-B" }, "owner");
    assert.equal(changed.dispatchId, identity.dispatchId);
    for (const input of [{ ...identity, dispatchFingerprint: changed.dispatchFingerprint, sessionId: binding.sessionId }, { ...identity, sessionId: "other" }]) {
      await assert.rejects(restarted.dispatch(project, input, async () => { calls++; }), { code: "agent_run_dispatch_conflict" });
    }
    await assert.rejects(restarted.reserveRun(project, binding, { ...identity, dispatchFingerprint: changed.dispatchFingerprint }), { code: "agent_run_dispatch_conflict" });
    assert.equal(calls, 1);
  } finally { await store.closeProject(project); await restarted.closeProject(project); await rm(root, { recursive: true, force: true }); }
});

test("concurrent different briefs with one request id preserve 409 when the winner reserves during the loser's claim", async () => {
  const study = { id: "study_race", projectId: "project", userId: "owner", status: "draft" };
  const rows = []; let reads = 0; let claims = 0; let sent = 0;
  let openReads; const bothRead = new Promise(resolve => { openReads = resolve; });
  let reserved; const firstReserved = new Promise(resolve => { reserved = resolve; });
  const start = createVcrStudyStart({
    projectFor: async () => ({}), conversations: async () => ({ exists: true, sessionId: "canonical" }),
    runs: { list: async () => { if (++reads <= 2) { if (reads === 2) openReads(); await bothRead; return []; } return rows; }, existingDispatch: async (_project, run) => run },
    inbox: async () => ({ running: false, queued: 0 }), save: async () => {},
    orchestrator: () => ({
      async claimIntake() {
        if (++claims === 2) { await firstReserved; throw Object.assign(new Error("different fingerprint"), { code: "agent_run_dispatch_conflict", status: 409 }); }
        return { async bind() {}, async release() {} };
      },
      async recoverIntake() {}, async intakeStatus() { return "accepted"; },
    }),
    dispatch: async (_user, _project, sessionId, dispatchId, _brief, options) => {
      await options.beforeReserve();
      const run = { id: "run_winner", sessionId, dispatchId, dispatchFingerprint: options.dispatchFingerprint, status: "running", dispatchStatus: "accepted" };
      rows.push(run); reserved(); await options.beforeSend(run); await options.beforePrompt(); sent++; return run;
    },
  });
  const outcome = await Promise.allSettled([
    start({ id: "owner" }, study, { brief: "First brief", requestId: "same_request" }),
    start({ id: "owner" }, study, { brief: "Different brief", requestId: "same_request" }),
  ]);
  assert.equal(outcome.filter(item => item.status === "fulfilled").length, 1);
  const refused = outcome.find(item => item.status === "rejected");
  assert.equal(refused.reason.code, "agent_run_dispatch_conflict");
  assert.equal(refused.reason.status, 409);
  assert.equal(sent, 1);
});
