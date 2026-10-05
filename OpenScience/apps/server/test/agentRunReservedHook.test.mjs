// The moment billing places its hold: a dispatched run has just been created, its
// prompt has not gone out, and nothing about a hold can refuse or fail the run.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";

/** @param {{ onRunReserved?: (project: any, run: any) => Promise<any> }} options */
async function fixture(options) {
  const root = await mkdtemp(path.join(tmpdir(), "os-run-reserved-"));
  const project = { id: "hold-project", userId: "researcher", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  const binding = { sessionId: "ses_hold", mode: "specialist", agentId: "adr-analysis", agentVersion: "1.0.0", runtimeAgent: "evimed-adr-analysis" };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  const store = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-flash", readSessionHistory: async () => [], monitorIntervalMs: 60_000, ...options });
  const route = { sessionId: binding.sessionId, effectiveAgentId: binding.agentId, effectiveAgentVersion: binding.agentVersion, effectiveRuntimeAgent: binding.runtimeAgent };
  return { root, project, binding, store, route, close: async () => { await store.cancelSession(project, binding.sessionId); await store.closeProject(project); await rm(root, { recursive: true, force: true }); } };
}

test("the run's reservation is announced once, with the run, before its prompt is sent", async () => {
  /** @type {string[]} */
  const order = [];
  /** @type {any[]} */
  const reserved = [];
  const f = await fixture({ onRunReserved: async (project, run) => { order.push("reserved"); reserved.push({ project: project.id, run }); } });
  try {
    const started = await f.store.dispatch(f.project, { ...f.route, dispatchId: "turn-one" }, async () => { order.push("prompt"); return { accepted: true }; });
    assert.deepEqual(order, ["reserved", "prompt"]);
    assert.equal(reserved.length, 1);
    assert.equal(reserved[0].project, "hold-project");
    assert.equal(reserved[0].run.id, started.id);
    assert.deepEqual([reserved[0].run.effectiveAgentId, reserved[0].run.status], ["adr-analysis", "running"]);
    assert.ok(reserved[0].run.startedAt, "the record carries the start the hold's rule is chosen by");
    // The same dispatch asked again is the run that exists, not a new one: no second announcement.
    await f.store.dispatch(f.project, { ...f.route, dispatchId: "turn-one" }, async () => { order.push("prompt again"); return { accepted: true }; });
    assert.equal(reserved.length, 1);
  } finally { await f.close(); }
});

test("a hold that cannot be placed never stops the run: the hook's failure is swallowed and the prompt goes out", async () => {
  /** @type {string[]} */
  const sent = [];
  const f = await fixture({ onRunReserved: async () => { throw Object.assign(new Error("the wallet is down"), { code: "57P01" }); } });
  try {
    const started = await f.store.dispatch(f.project, { ...f.route, dispatchId: "turn-two" }, async () => { sent.push("prompt"); return { accepted: true }; });
    assert.deepEqual(sent, ["prompt"]);
    assert.equal((await f.store.list(f.project)).find((run) => run.id === started.id)?.status, "running");
  } finally { await f.close(); }
});
