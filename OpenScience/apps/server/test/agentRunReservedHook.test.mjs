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

test("the hold is placed after the brief is kept and just before the prompt goes out, so a start that fails before then freezes nothing (review F7)", async () => {
  /** @type {string[]} */
  const order = [];
  const f = await fixture({ onRunReserved: async () => { order.push("reserved"); } });
  try {
    const keepBrief = f.store.keepBrief.bind(f.store);
    f.store.keepBrief = async (/** @type {any[]} */ ...args) => { order.push("brief kept"); return keepBrief(...args); };
    const writeWorkspaceBrief = f.store.writeWorkspaceBrief.bind(f.store);
    f.store.writeWorkspaceBrief = async (/** @type {any[]} */ ...args) => { order.push("brief written"); return writeWorkspaceBrief(...args); };
    await f.store.dispatch(f.project, { ...f.route, dispatchId: "turn-brief", question: "A brief the run is sent for." }, async () => { order.push("prompt"); return { accepted: true }; });
    assert.deepEqual(order, ["brief kept", "brief written", "reserved", "prompt"]);
  } finally { await f.close(); }

  // A brief that cannot be written stops the start before the hold is ever asked for.
  /** @type {string[]} */
  const placed = [];
  const failing = await fixture({ onRunReserved: async () => { placed.push("reserved"); } });
  try {
    failing.store.writeWorkspaceBrief = async () => { throw new Error("the workspace is read-only"); };
    await assert.rejects(failing.store.dispatch(failing.project, { ...failing.route, dispatchId: "turn-nobrief", question: "x" }, async () => ({ accepted: true })), /read-only/);
    assert.deepEqual(placed, [], "nothing was frozen for a run that never started");
  } finally { await failing.close(); }
});
