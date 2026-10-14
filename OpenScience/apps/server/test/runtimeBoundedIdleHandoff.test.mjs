import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeManager } from "../src/runtimeManager.mjs";

const budget = { runId: "scheduled-episode", dailyLimit: 50, weeklyLimit: 200, runLimit: 10 };

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "bounded-idle-handoff-"));
  const project = { id: "scheduled-project", userId: "alice", rootDir, baseDir: rootDir,
    metaDir: path.join(rootDir, ".openscience"), workspaceDir: path.join(rootDir, "workspace"),
    runtimeDir: path.join(rootDir, "runtime") };
  await mkdir(project.workspaceDir);
  const manager = new RuntimeManager({ runtimeMode: "mock", allowMockRuntime: true, production: false,
    runtimeIdleTimeoutMs: 12 * 60 * 60_000 });
  t.after(async () => { await manager.closeAll(); await rm(rootDir, { recursive: true, force: true }); });
  const warm = await manager.start(project);
  return { manager, project, warm };
}

test("scheduled work takes over a disconnected idle warm runtime without losing files or waiting twelve hours", async t => {
  const { manager, project, warm } = await fixture(t);
  await writeFile(path.join(project.workspaceDir, "retained.md"), "Existing research stays available.");
  const session = await manager.reserveBoundedRuntimeSession(project, budget);
  assert(session.id);
  assert.notEqual(manager.runtimes.get(manager.key(project)), warm);
  assert.equal(warm.closedByManager, true);
  assert.equal(manager.boundedRuntimeScope(project).runId, budget.runId);
  assert.equal(await readFile(path.join(project.workspaceDir, "retained.md"), "utf8"), "Existing research stays available.");
  await assert.rejects(manager.dispatchPrompt(project, session.id, { text: "unbudgeted prompt" }), { code: "runtime_reserved_for_autopilot" });
});

// 2026-10-14 (R3): the one 423 said 「定时任务」 to a person who had just pressed a step of a study. The code stays what every client knows;
// the reason the project is held rides in its declared detail, and the sentence is picked by it.
for (const [said, expected] of [["module-step", "module-step"], ["scheduled-task", "scheduled-task"], [undefined, "platform-task"], ["something-new", "platform-task"]]) {
  test(`a project held for ${said ?? "an unnamed reason"} refuses the person's prompt with the reason ${expected}`, async t => {
    const { manager, project } = await fixture(t);
    const session = await manager.reserveBoundedRuntimeSession(project, { ...budget, ...(said === undefined ? {} : { reason: said }) });
    for (const refuse of [
      () => manager.dispatchPrompt(project, session.id, { text: "interactive" }),
      () => manager.createRuntimeSession(project),
    ]) {
      await assert.rejects(refuse(), (error) => {
        assert.equal(error.status, 423);
        assert.equal(error.code, "runtime_reserved_for_autopilot");
        assert.deepEqual(error.details, { reason: expected });
        return true;
      });
    }
    assert.equal(manager.boundedLockReason(project), expected);
  });
}

for (const state of ["kernel-working", "ledger-working", "kernel-unknown", "ledger-unknown", "browser-connected"]) {
  test(`scheduled work preserves a warm runtime that is ${state}`, async t => {
    const { manager, project, warm } = await fixture(t);
    if (state === "kernel-working") manager.runtimeBusy = async () => true;
    if (state === "ledger-working") manager.hasRunningRuns = async () => true;
    if (state === "kernel-unknown") manager.runtimeBusy = async () => { throw new Error("kernel unavailable"); };
    if (state === "ledger-unknown") manager.hasRunningRuns = async () => { throw new Error("ledger unavailable"); };
    if (state === "browser-connected") manager.beginProxy(project);
    await assert.rejects(manager.reserveBoundedRuntimeSession(project, budget), { code: "runtime_busy" });
    assert.equal(manager.runtimes.get(manager.key(project)), warm);
    assert.notEqual(warm.closedByManager, true);
    assert.equal(manager.boundedRuntimeScope(project), null);
    if (state === "browser-connected") {
      manager.endProxy(project);
      await manager.reserveBoundedRuntimeSession(project, budget);
      assert.equal(manager.boundedRuntimeScope(project).runId, budget.runId);
    }
  });
}

test("the idle probe reserves admission before waiting, so a second reservation or interactive prompt cannot race it", async t => {
  const { manager, project } = await fixture(t);
  let release;
  let entered;
  const probing = new Promise(resolve => { entered = resolve; });
  manager.runtimeBusy = async () => { entered(); await new Promise(resolve => { release = resolve; }); return false; };
  const reserving = manager.reserveBoundedRuntimeSession(project, budget);
  // Attach immediately: the old implementation rejects before reaching the probe.
  const observation = reserving.then(value => ({ value }), error => ({ error }));
  await Promise.race([probing, observation.then(result => { if (result.error) throw result.error; })]);
  try {
    await assert.rejects(manager.reserveBoundedRuntimeSession(project, { ...budget, runId: "competing-episode" }), { code: "runtime_busy" });
    await assert.rejects(manager.dispatchPrompt(project, "old-session", { text: "racing prompt" }), { code: "runtime_reserved_for_autopilot" });
  } finally { release(); }
  const result = await observation;
  assert.equal(result.error, undefined);
  assert(result.value.id);
});

test("an invalid budget never closes the warm runtime", async t => {
  const { manager, project, warm } = await fixture(t);
  await assert.rejects(manager.reserveBoundedRuntimeSession(project, { ...budget, runLimit: 0 }), { code: "runtime_model_gateway_scope_invalid" });
  assert.equal(manager.runtimes.get(manager.key(project)), warm);
  assert.notEqual(warm.closedByManager, true);
});

test("a reconnect during idle cleanup cannot consume the isolated verifier's startup reservation", async t => {
  const { manager, project, warm } = await fixture(t);
  const verifier = { ...project, workspaceDir: path.join(project.rootDir, "isolated-verifier") };
  await mkdir(verifier.workspaceDir);
  let release;
  let entered;
  const closing = new Promise(resolve => { entered = resolve; });
  const originalClose = warm.close;
  warm.close = async () => { entered(); await new Promise(resolve => { release = resolve; }); await originalClose(); };
  const reserving = manager.reserveBoundedRuntimeSession(verifier, { ...budget, runId: "independent-verifier" });
  await closing;
  const reconnect = manager.start(project).then(value => ({ value }), error => ({ error }));
  release();
  await reserving;
  const reconnected = await reconnect;
  assert.equal(reconnected.error?.code, "runtime_reserved_for_autopilot");
  assert.equal(manager.runtimes.get(manager.key(project)).workspaceDir, verifier.workspaceDir);
  assert.equal(manager.boundedRuntimeScope(project).runId, "independent-verifier");
});

test("a live bounded runtime still supports the baseline-history read used before dispatch", async t => {
  const { manager, project } = await fixture(t);
  const session = await manager.reserveBoundedRuntimeSession(project, budget);
  const runtime = manager.runtimes.get(manager.key(project));
  const messages = await manager.sessionMessages(project, session.id, { wake: true });
  assert.deepEqual(messages, []);
  assert.equal(manager.runtimes.get(manager.key(project)), runtime);
  await assert.rejects(manager.dispatchPrompt(project, session.id, { text: "interactive" }), { code: "runtime_reserved_for_autopilot" });
});

test("failed provider cleanup cannot start the bounded replacement", async t => {
  const { manager, project, warm } = await fixture(t);
  const close = warm.close;
  warm.close = async () => { throw new Error("provider cleanup unconfirmed"); };
  try {
    await assert.rejects(manager.reserveBoundedRuntimeSession(project, budget), /provider cleanup unconfirmed/);
    assert.equal(manager.runtimes.has(manager.key(project)), false);
    assert.equal(manager.failedRuntimeStops.has(manager.key(project)), true);
    assert.equal(manager.pendingModelGatewayScopes.has(manager.key(project)), false);
    await assert.rejects(manager.reserveBoundedRuntimeSession(project, budget), { code: "runtime_cleanup_required" });
  } finally { warm.close = close; }
});
