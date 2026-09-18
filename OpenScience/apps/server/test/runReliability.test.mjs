// What a run keeps across a restart, and what a refused dispatch leaves behind
// (2026-09-18 review, appendix E §9.1 and §9.3).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { HttpError } from "../src/security.mjs";

async function withProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "os-run-reliability-"));
  const project = {
    id: "p1", userId: "u1", rootDir: root,
    workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience"),
  };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  try {
    await fn(project);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const binding = { sessionId: "ses_rel", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };

function store(options = {}) {
  const created = new AgentRunStore({ get: async () => binding }, {
    model: "deepseek/deepseek-flash", monitorIntervalMs: 60_000, monitorMaxPolls: 1,
    readSessionHistory: options.readSessionHistory ?? (async () => []), readSessionStatus: async () => "idle",
  });
  created.scheduleMonitor = () => {};
  return created;
}

test("a run's brief outlives a restart of the control plane, and leaves with the run", async () => {
  // It lived only in this process's memory, so a restart mid-run judged the
  // package without it: the question-scoped clinical safety rules silently did
  // not run for that run.
  await withProject(async (project) => {
    const brief = "请评估≥70 岁人群阿司匹林一级预防的获益与出血风险。\n".repeat(80);
    const first = store();
    const run = await first.dispatch(project, { sessionId: binding.sessionId, dispatchId: "brief_1", question: brief }, async () => ({ accepted: true }));
    const kept = first.briefFile(project, run.id);
    assert.equal(await readFile(kept, "utf8"), brief, "the whole brief, not the ledger's preview of it");
    assert.equal((await stat(kept)).mode & 0o777, 0o600, "readable by the control plane alone");
    assert.equal(kept.startsWith(project.metaDir), true, "beside the ledger, outside the workspace the run can write");

    // The process dies mid-run (a graceful shutdown cancels its runs instead,
    // and a cancelled run needs no brief): the ledger still says `running`,
    // and the next process resumes it with nothing in memory.
    const second = store();
    assert.equal(await second.dispatchedBrief(project, run.id), brief);
    await second.finishInternal(project, run.id, { status: "succeeded", artifacts: [] });
    await assert.rejects(stat(kept), { code: "ENOENT" }, "the brief leaves with the delivery decision");
    assert.equal(await second.dispatchedBrief(project, run.id), null);
    await second.closeAll();
    await first.closeAll();
  });
});

test("a dispatch the runtime refuses for capacity ends the run, and the retry is not refused as active", async () => {
  await withProject(async (project) => {
    const runs = store();
    await assert.rejects(runs.dispatch(project, { sessionId: binding.sessionId, dispatchId: "busy_1", question: "问题" }, async () => {
      throw new HttpError(429, "runtime_limit_exceeded", "Too many running runtimes for this user; limit is 1.");
    }), { code: "runtime_limit_exceeded" });
    const [refused] = await runs.list(project);
    assert.equal(refused.status, "failed", "a refusal before the prompt was sent is not a run still going");
    assert.equal(refused.dispatchStatus, "rejected");
    assert.equal(refused.errorCode, "runtime_limit_exceeded");
    // A lock refusal is the same shape.
    await assert.rejects(runs.dispatch(project, { sessionId: binding.sessionId, dispatchId: "busy_2", question: "问题" }, async () => {
      throw new HttpError(423, "runtime_reserved_for_autopilot", "Reserved.");
    }), { code: "runtime_reserved_for_autopilot" });
    const retried = await runs.dispatch(project, { sessionId: binding.sessionId, dispatchId: "busy_3", question: "问题" }, async () => ({ accepted: true }));
    assert.equal(retried.status, "running", "the retry on the same session is accepted, not answered agent_run_active");
    assert.equal(retried.dispatchStatus, "accepted");
    await runs.closeAll();
  });
});

test("a prompt that may have reached the kernel still leaves its run to the monitor", async () => {
  // The other side of the rule above: a failure after sending proves nothing
  // about whether the kernel took the prompt, so the run is watched, not ended.
  await withProject(async (project) => {
    const runs = store();
    await assert.rejects(runs.dispatch(project, { sessionId: binding.sessionId, dispatchId: "lost_1", question: "问题" }, async () => {
      throw new HttpError(502, "runtime_history_unavailable", "Lost.");
    }));
    const [run] = await runs.list(project);
    assert.equal(run.status, "running");
    assert.equal(run.dispatchStatus, "unknown");
    await runs.closeAll();
  });
});

test("concurrent reconciles of one run are one evaluation, so its repair count is read and written once", async () => {
  // The server-side repair budget is a read-modify-write across awaits
  // (`clinicalRepairAttempts`). What makes it safe is that a run's whole
  // evaluation is single-flight per run; this is the property that has to hold.
  await withProject(async (project) => {
    let reads = 0;
    let holding = false;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runs = store({ readSessionHistory: async () => { if (!holding) return []; reads += 1; await gate; return []; } });
    const run = await runs.start(project, { sessionId: binding.sessionId });
    holding = true;
    const first = runs.reconcileSession(project, binding.sessionId, run.id);
    const second = runs.reconcileSession(project, binding.sessionId, run.id);
    // Held inside the evaluation, so every later caller arrives while it is
    // in flight — including one that names only the session and has to find
    // the run in the ledger first.
    for (let waited = 0; reads === 0 && waited < 200; waited += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(reads, 1, "the evaluation never reached the session read");
    const third = runs.reconcileSession(project, binding.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([first, second, third]);
    assert.equal(reads, 1, `three reconciles evaluated the run ${reads} times`);
    await runs.closeAll();
  });
});
