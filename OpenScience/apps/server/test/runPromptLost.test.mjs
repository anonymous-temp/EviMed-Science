// A prompt the kernel never received is not a stalled run; there is no run.
//
// 2026-09-21: a learning step's acceptance timed out on a host out of swap, no
// message ever reached the kernel, and the monitor — whose window is a day —
// held the learning project with nothing running while every later lesson
// waited behind it. The kernel's own session log is what decides: a notice
// stays a notice for a run that did start.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { awaitBackgroundMonitor } from "./helpers/awaitBackgroundMonitor.mjs";

/** @param {any} t @param {any[]} history what the kernel's log of the session holds */
async function seeded(t, history) {
  const root = await mkdtemp(path.join(tmpdir(), "os-prompt-lost-"));
  const project = { id: "p", userId: "u", rootDir: root, metaDir: path.join(root, ".openscience"), workspaceDir: root, baseDir: root };
  await mkdir(project.metaDir, { recursive: true });
  const lines = [
    { event: "started", id: "run_lost", dispatchId: "method-distillation-abc-a3", dispatchStatus: "dispatching",
      kernelRequestIds: ["req_lost"], sessionId: "ses_lost", mode: "specialist", agentId: "method-distillation", agentVersion: "1.0.0",
      runtimeAgent: "evimed-method-distillation", effectiveAgentId: "method-distillation", effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-method-distillation", effectiveRouteReason: "method-distillation", model: "deepseek/deepseek-flash",
      question: "q", createdAt: "2026-09-21T06:21:22.926Z", startedAt: "2026-09-21T06:21:22.926Z", baselineCursor: null },
    { event: "dispatch", id: "run_lost", status: "unknown" },
  ];
  await writeFile(path.join(project.metaDir, "runs.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  const store = new AgentRunStore({ get: async () => null }, {
    model: "deepseek/deepseek-flash", monitorIntervalMs: 1, monitorMaxPolls: 40, monitorStallPolls: 3,
    readSessionHistory: async () => history, readSessionStatus: async () => "running", runtimeWorkspaceRoot: () => root,
  });
  t.after(async () => { await store.closeAll?.(); await rm(root, { recursive: true, force: true }); });
  return { project, store };
}

test("a run whose prompt never reached the kernel ends by name at the stall threshold", async (t) => {
  const { project, store } = await seeded(t, []);
  store.scheduleMonitor(project, "run_lost");
  await awaitBackgroundMonitor(store.monitors.get("run_lost")?.promise);
  const [run] = await store.list(project);
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "runtime_prompt_lost");
});

test("a prompt that did land is a run still working: it gets the notice, never an ending", async (t) => {
  const landed = [{ info: { id: "m1", role: "user", source: "user", sourceRequestId: "req_lost", turnStartSeq: 1 },
    parts: [{ type: "text", text: "Distil one method." }] }];
  const { project, store } = await seeded(t, landed);
  store.scheduleMonitor(project, "run_lost");
  await awaitBackgroundMonitor(store.monitors.get("run_lost")?.promise);
  const [run] = await store.list(project);
  assert.equal(run.errorCode, "runtime_monitor_timeout", "only the day's budget ends a run that started");
  assert.match(JSON.stringify(run.qualityNotices), /没有可观测的进展/);
});
