// A runtime stop says who asked for it (review F2). The researcher's own stop, restart or project
// deletion is a user stop and is charged for what ran; a release restart, an idle reap, a capacity
// yield and the autopilot are the platform's and are free; and when nobody says, it is the platform's.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { createCommandRegistry } from "../src/commands.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";

async function fixture() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-runtime-stop-by-"));
  const project = { id: "stop-by", userId: "alice", rootDir: tmp, baseDir: path.join(tmp, "workspace"), workspaceDir: path.join(tmp, "workspace"),
    runtimeDir: path.join(tmp, "runtime"), metaDir: path.join(tmp, ".openscience") };
  await Promise.all([project.workspaceDir, project.runtimeDir, project.metaDir].map((dir) => mkdir(dir, { recursive: true })));
  const binding = { sessionId: "ses_stop_by", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const runs = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-pro", monitorIntervalMs: 60_000, monitorMaxPolls: 100, readSessionHistory: async () => [] });
  /** @type {Array<[string, string | null]>} */
  const notified = [];
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 1, runtimeQuotaCheckIntervalMs: 0, maxProjectBytes: 1024, maxLogFileBytes: 1024 * 1024 }, {
    onRuntimeStop: async (/** @type {any} */ stopped, /** @type {string} */ status, /** @type {string | undefined} */ errorCode, /** @type {any} */ options) => {
      notified.push([status, options?.by ?? null]);
      await runs.closeProject(stopped, status, errorCode, options);
    },
  });
  const runtime = () => ({ kind: "dsh", url: "http://127.0.0.1/x", close: async () => {}, password: null, sandboxMode: "host", networkMode: null,
    workspaceDir: project.workspaceDir, proxyWorkspaceDir: project.workspaceDir, startedAt: new Date().toISOString(), pid: 123, exitedAt: null, project });
  /** A running runtime with a run working in it. */
  async function working() {
    manager.runtimes.set(manager.key(project), runtime());
    return runs.start(project, { sessionId: binding.sessionId });
  }
  const run = async (/** @type {string} */ id) => (await runs.list(project)).find((item) => item.id === id);
  return { project, manager, runs, notified, working, run, close: async () => { await runs.closeProject(project); await rm(tmp, { recursive: true, force: true }); } };
}

test("the researcher's own stop is a user stop; a stop nobody names, a release and an idle reap are the platform's", async () => {
  const f = await fixture();
  try {
    const mine = await f.working();
    await f.manager.stop(f.project, { by: "user" });
    assert.deepEqual(f.notified, [["canceled", "user"]]);
    assert.equal((await f.run(mine.id)).canceledBy, "user", "charged for what ran");

    const unnamed = await f.working();
    await f.manager.stop(f.project);
    assert.deepEqual(f.notified.at(-1), ["canceled", null]);
    assert.equal((await f.run(unnamed.id)).canceledBy, "platform", "default: platform, which cannot overcharge");

    const reaped = await f.working();
    f.manager.runtimeActivity.set(f.manager.key(f.project), { activeProxies: 0, idleTimer: null });
    await f.manager.stopIdleRuntime(f.project);
    assert.equal((await f.run(reaped.id)).canceledBy, "platform", "the idle reaper is the platform");

    const released = await f.working();
    await f.manager.closeAll();
    assert.equal((await f.run(released.id)).canceledBy, "platform", "a release shutting the process down is the platform");
  } finally { await f.close(); }
});

test("a restart the researcher asked for stops the runtime as theirs", async () => {
  const f = await fixture();
  try {
    const run = await f.working();
    f.manager.start = async () => ({ url: "http://127.0.0.1/x" });
    await f.manager.restart(f.project, { by: "user" });
    assert.deepEqual(f.notified, [["canceled", "user"]]);
    assert.equal((await f.run(run.id)).canceledBy, "user");
  } finally { await f.close(); }
});

test("stop_runtime and restart_runtime are the researcher's: the commands name them", async () => {
  /** @type {any[]} */
  const calls = [];
  const runtimeManager = {
    stop: async (/** @type {any} */ project, /** @type {any} */ options) => { calls.push(["stop", options?.by ?? null]); },
    restart: async (/** @type {any} */ project, /** @type {any} */ options) => { calls.push(["restart", options?.by ?? null]); },
  };
  const config = {};
  const registry = createCommandRegistry({ config, runtimeManager });
  const ctx = { config, project: { id: "p", userId: "u" }, store: { setProjectWorkspace: async () => {} }, request: { headers: {} } };
  await registry.invoke("stop_runtime", {}, ctx);
  await registry.invoke("restart_runtime", {}, ctx).catch(() => {});
  assert.deepEqual(calls, [["stop", "user"], ["restart", "user"]]);
});
