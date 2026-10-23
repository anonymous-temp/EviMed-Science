// A runtime launched for the other memory engine than its account is on now (2026-10-23, D2 of the capsule review): the plugin that
// learns and recalls is wired by an environment variable at launch, so an account switched to the native engine under a runtime that
// stayed open was learned from by nobody and remembered for by nobody. Every such runtime is marked, an idle one is let go, and the
// next dispatch between two runs replaces the rest — a turn that is running is never stopped for it.
import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeManager, memoryGatewayEndpointUrl } from "../src/runtimeManager.mjs";
import { NativeTurnCommit } from "../src/nativeTurnCommit.mjs";
import { nativeMemoryCounters, nativeMemoryMetricFamilies, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";

const config = {
  runtimeMode: "mock", ovNativeMemoryEnabled: true, memoryEnabled: true, stateStore: "postgres", evimedWorkloadSigningSecret: "test-secret-for-the-workload",
  modelGatewayInternalUrl: "http://gateway:8787/internal/model/v1",
};
const GATEWAY = memoryGatewayEndpointUrl(config);

/** A manager with live kernel runtimes, an engine per account, and a stub for idleness and for stopping. */
function managerWith({ engines, runtimes }) {
  const manager = new RuntimeManager(config);
  manager.memoryEngineOf = async (userId) => {
    const engine = engines[userId];
    if (engine instanceof Error) throw engine;
    return engine ?? "legacy";
  };
  for (const [userId, id, launched] of runtimes) {
    const project = { userId, id, workspaceDir: `/w/${id}` };
    manager.runtimes.set(manager.key(project), { kind: "dsh", project, workspaceDir: project.workspaceDir, memoryGatewayUrl: launched });
  }
  const stopped = [];
  const verdicts = {};
  manager.idleVerdict = async (project) => verdicts[project.id] ?? "idle";
  manager.stopIdleRuntime = async (project, options) => {
    stopped.push({ id: project.id, event: options?.event, evenIfConnected: options?.evenIfConnected === true });
    manager.runtimes.delete(manager.key(project));
    return true;
  };
  return { manager, stopped, verdicts, runtimeOf: (userId, id) => manager.runtimes.get(manager.key({ userId, id })) };
}

test("a switch to the native engine marks every runtime of the account that was launched without the gateway and lets go of the idle ones", async () => {
  resetNativeMemoryMetrics();
  const { manager, stopped, verdicts, runtimeOf } = managerWith({
    engines: { owner: "native", other: "legacy" },
    runtimes: [["owner", "p-idle", ""], ["owner", "p-busy", ""], ["owner", "p-right", GATEWAY], ["other", "p-other", ""]],
  });
  verdicts["p-busy"] = "working";
  assert.deepEqual(await manager.releaseMemoryEngineRuntimes("owner"), ["p-idle"]);
  assert.deepEqual(stopped, [{ id: "p-idle", event: "memory_engine_changed", evenIfConnected: false }]);
  // The busy one is marked, not stopped: a running turn is never killed for memory.
  assert.equal(runtimeOf("owner", "p-busy").memoryEngineStale, true);
  assert.equal(runtimeOf("owner", "p-right").memoryEngineStale, undefined, "a runtime that was launched right is left alone");
  assert.equal(runtimeOf("other", "p-other").memoryEngineStale, undefined, "another account is not asked about");
  assert.deepEqual(nativeMemoryCounters().runtimeSwitches, { released: 1, marked: 2, adopted: 0, deferred: 0 });
  // Asked again, the marked runtime is not counted twice.
  await manager.releaseMemoryEngineRuntimes("owner");
  assert.equal(nativeMemoryCounters().runtimeSwitches.marked, 2);
  // The way back is the same: an account on the legacy engine whose runtime holds the gateway address.
  const back = managerWith({ engines: { owner: "legacy" }, runtimes: [["owner", "p-had-gateway", GATEWAY]] });
  assert.deepEqual(await back.manager.releaseMemoryEngineRuntimes(), ["p-had-gateway"]);
});

test("an engine that cannot be read is not a switch: nothing is marked and nothing is stopped", async () => {
  resetNativeMemoryMetrics();
  const { manager, stopped, runtimeOf } = managerWith({ engines: { owner: new Error("database unavailable") }, runtimes: [["owner", "p-native", GATEWAY]] });
  assert.deepEqual(await manager.releaseMemoryEngineRuntimes(), []);
  assert.deepEqual(await manager.adoptMemoryEngine({ userId: "owner", id: "p-native" }), { adopted: false });
  assert.deepEqual(stopped, []);
  assert.equal(runtimeOf("owner", "p-native").memoryEngineStale, undefined);
  assert.deepEqual(nativeMemoryCounters().runtimeSwitches, { released: 0, marked: 0, adopted: 0, deferred: 0 });
});

test("the next dispatch between two runs replaces a runtime a tab holds open; one with a turn running keeps it and is counted", async () => {
  resetNativeMemoryMetrics();
  const { manager, stopped, verdicts } = managerWith({ engines: { owner: "native" }, runtimes: [["owner", "p-tab", ""]] });
  const project = { userId: "owner", id: "p-tab", workspaceDir: "/w/p-tab" };
  /** @type {any[]} */ const replaced = [];
  manager.startAdmitted = async (given, options) => {
    // What `startAdmitted` does with a replace hook: stop what is there, then start the next one.
    const done = await options.replaceRuntime();
    replaced.push({ project: given.id, done });
    return null;
  };

  verdicts["p-tab"] = "working";
  assert.deepEqual(await manager.adoptMemoryEngine(project), { adopted: false, pending: true });
  assert.deepEqual(stopped, [], "a running turn is never stopped");
  assert.equal(nativeMemoryCounters().runtimeWithoutGateway.dispatch, 1, "the dispatch found a native account's runtime with no gateway");
  assert.equal(replaced.length, 0, "no replacement was attempted while something ran");

  verdicts["p-tab"] = "idle";
  assert.deepEqual(await manager.adoptMemoryEngine(project), { adopted: true });
  // Even a runtime a tab is connected to: this is a boundary between two runs, the same as a new platform skill generation.
  assert.deepEqual(stopped, [{ id: "p-tab", event: "memory_engine_changed", evenIfConnected: true }]);
  assert.deepEqual(replaced, [{ project: "p-tab", done: true }]);
  assert.deepEqual(nativeMemoryCounters().runtimeSwitches, { released: 0, marked: 1, adopted: 1, deferred: 1 });
  // A runtime that is right is not touched, and a project with no runtime has nothing to adopt.
  assert.deepEqual(await manager.adoptMemoryEngine(project), { adopted: false });
  assert.deepEqual(await manager.adoptMemoryEngine({ userId: "owner", id: "never-started" }), { adopted: false });
});

test("the guard of the replacement refuses a runtime that became busy between the check and the stop", async () => {
  resetNativeMemoryMetrics();
  const { manager, verdicts } = managerWith({ engines: { owner: "native" }, runtimes: [["owner", "p-race", ""]] });
  const project = { userId: "owner", id: "p-race", workspaceDir: "/w/p-race" };
  manager.stopIdleRuntime = async (_project, options) => { verdicts["p-race"] = "working"; return options.guard(); };
  manager.startAdmitted = async (_given, options) => { await options.replaceRuntime(); return null; };
  assert.deepEqual(await manager.adoptMemoryEngine(project), { adopted: false, pending: true });
  assert.equal(nativeMemoryCounters().runtimeSwitches.adopted, 0);
  assert.equal(nativeMemoryCounters().runtimeSwitches.deferred, 1);
});

test("a plugin lock held elsewhere defers the replacement, and the lock is the plugin service's own key", async () => {
  resetNativeMemoryMetrics();
  const { manager, stopped } = managerWith({ engines: { owner: "native" }, runtimes: [["owner", "p-locked", ""]] });
  const project = { userId: "owner", id: "p-locked", workspaceDir: "/w/p-locked" };
  /** @type {any[]} */ const asked = [];
  let acquired = false;
  manager.pluginService = {
    database: { transaction: async (work) => work({ query: async (sql, values) => { asked.push([sql, values]); return { rows: [{ acquired }] }; } }) },
    scope: async () => {},
    hasPendingPrompts: async () => false,
  };
  manager.startAdmitted = async (_given, options) => { await options.replaceRuntime(); return null; };
  assert.deepEqual(await manager.adoptMemoryEngine(project), { adopted: false, pending: true });
  assert.match(asked[0][0], /pg_try_advisory_xact_lock/);
  assert.deepEqual(asked[0][1], ["plugin-project:owner:p-locked"]);
  assert.deepEqual(stopped, []);
  acquired = true;
  assert.deepEqual(await manager.adoptMemoryEngine(project), { adopted: true });
  // A queued plugin prompt is also a reason to wait.
  const queued = managerWith({ engines: { owner: "native" }, runtimes: [["owner", "p-queued", ""]] });
  queued.manager.pluginService = { database: { transaction: async (work) => work({ query: async () => ({ rows: [{ acquired: true }] }) }) }, scope: async () => {}, hasPendingPrompts: async () => true };
  assert.deepEqual(await queued.manager.adoptMemoryEngine({ userId: "owner", id: "p-queued", workspaceDir: "/w/p-queued" }), { adopted: false, pending: true });
  assert.deepEqual(queued.stopped, []);
});

test("the end of a native account's turn counts a runtime that was launched without the gateway, and says nothing of one that was not", async () => {
  resetNativeMemoryMetrics();
  const { manager } = managerWith({ engines: { owner: "native" }, runtimes: [["owner", "p-without", ""], ["owner", "p-with", GATEWAY]] });
  assert.equal(manager.launchedWithoutMemoryGateway({ userId: "owner", id: "p-without" }), true);
  assert.equal(manager.launchedWithoutMemoryGateway({ userId: "owner", id: "p-with" }), false);
  assert.equal(manager.launchedWithoutMemoryGateway({ userId: "owner", id: "no-runtime" }), false);
  const committer = (engine, without) => new NativeTurnCommit({
    config: { ovNativeMemoryEnabled: true, memoryEnabled: true }, researchMemory: { configured: true, memoryEngine: async () => engine }, sessions: { configured: true, readSession: async () => ({}) },
    admission: { admit: async () => ({ native: true, learn: false, learnReason: "paused" }) }, conversations: { runsOf: async () => [] }, commit: async () => ({ commit: "nothing_pending" }),
    setTimer: () => 0, clearTimer: () => {}, runtimeWithoutGateway: without,
  });
  const run = { sessionId: "session_abc", status: "completed" };
  await committer("native", (project) => manager.launchedWithoutMemoryGateway(project)).noteRunFinished({ userId: "owner", id: "p-without" }, run);
  await committer("native", (project) => manager.launchedWithoutMemoryGateway(project)).noteRunFinished({ userId: "owner", id: "p-with" }, run);
  await committer("legacy", () => true).noteRunFinished({ userId: "owner", id: "p-without" }, run);
  await committer("native", null).noteRunFinished({ userId: "owner", id: "p-without" }, run);
  assert.deepEqual(nativeMemoryCounters().runtimeWithoutGateway, { dispatch: 0, turn_end: 1 });
  const family = nativeMemoryMetricFamilies().find((entry) => entry.name === "open_science_native_memory_runtime_without_gateway_total");
  assert.ok(family && family.series.find((entry) => entry.labels?.at === "turn_end")?.value === 1);
});

// The hook itself: asked at every dispatch, before the run is reserved (after it, the run would read as working and a runtime
// would never be idle), and a hook that fails never stops the dispatch.
async function dispatchWith(/** @type {(project: any) => Promise<void>} */ hook, /** @type {string[]} */ order) {
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { AgentRunStore } = await import("../src/agentRuns.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "os-run-adopt-"));
  const project = { id: "adopt-project", userId: "researcher", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  const binding = { sessionId: "ses_adopt", mode: "specialist", agentId: "adr-analysis", agentVersion: "1.0.0", runtimeAgent: "evimed-adr-analysis" };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  const store = new AgentRunStore({ get: async () => binding }, {
    model: "deepseek/deepseek-v4-flash", readSessionHistory: async () => [], monitorIntervalMs: 60_000,
    adoptRuntimeMemoryEngine: hook, onRunReserved: async () => { order.push("reserved"); },
  });
  const route = { sessionId: binding.sessionId, effectiveAgentId: binding.agentId, effectiveAgentVersion: binding.agentVersion, effectiveRuntimeAgent: binding.runtimeAgent };
  try {
    return await store.dispatch(project, { ...route, dispatchId: "adopt-one" }, async () => { order.push("prompt"); return { accepted: true }; });
  } finally {
    await store.cancelSession(project, binding.sessionId);
    await store.closeProject(project);
    await rm(root, { recursive: true, force: true });
  }
}

test("a dispatch asks the runtime to adopt the account's memory engine before its run is reserved", async () => {
  /** @type {string[]} */ const order = [];
  await dispatchWith(async (given) => { order.push(`adopt:${given.id}`); }, order);
  assert.deepEqual(order, ["adopt:adopt-project", "reserved", "prompt"]);
});

test("a hook that fails never stops the dispatch", async () => {
  /** @type {string[]} */ const order = [];
  await dispatchWith(async (given) => { order.push(`adopt:${given.id}`); throw new Error("the account's engine could not be read"); }, order);
  assert.deepEqual(order, ["adopt:adopt-project", "reserved", "prompt"]);
});
