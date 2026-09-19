import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RUNTIME_KERNEL_NAME, RUNTIME_START_STAGES, RuntimeManager } from "../src/runtimeManager.mjs";

// The four runtime experience fixes of plan §3.1 #8 that ship on the Docker
// provider: the reaper's ledger rule, the start stages and the refused start a
// waiting shell reads, and the warm start at sign-in.

const project = {
  id: "paper1",
  userId: "alice",
  workspaceDir: "/srv/open-science/users/alice/projects/paper1/workspace",
  runtimeDir: "/srv/open-science/users/alice/projects/paper1/runtime",
};

function fakeRuntime(forProject) {
  return {
    kind: RUNTIME_KERNEL_NAME,
    url: `http://127.0.0.1/${forProject.userId}-${forProject.id}`,
    close: async () => {},
    sandboxMode: "docker",
    networkMode: null,
    workspaceDir: forProject.workspaceDir,
    proxyWorkspaceDir: "/workspace",
    startedAt: new Date().toISOString(),
    pid: 1,
    exitedAt: null,
    project: forProject,
  };
}

function managerWith(config = {}, deps = {}) {
  const manager = new RuntimeManager({
    runtimeMode: "kernel",
    runtimeSandboxMode: "docker",
    maxRunningRuntimes: 10,
    maxRunningRuntimesPerUser: 10,
    ...config,
  }, deps);
  manager.startKernel = async (forProject) => fakeRuntime(forProject);
  manager.runtimeBusy = async () => false;
  return manager;
}

test("the idle sweep leaves a runtime whose ledger still runs a run, and reaps it once the run has ended", async () => {
  let ledgerRunning = true;
  const manager = managerWith({ runtimeIdleTimeoutMs: 60_000 }, { hasRunningRuns: async () => ledgerRunning });
  const stopped = [];
  manager.stopIdleRuntime = async (stopping) => {
    stopped.push(stopping.id);
    manager.runtimes.delete(manager.key(stopping));
  };
  await manager.start(project);
  const key = manager.key(project);
  // Idle by the kernel's account and long past the timeout: a nightly run
  // between two turns looks exactly like this.
  manager.runtimeActivity.get(key).lastUseAt = Date.now() - 120_000;
  assert.equal(await manager.sweepIdleRuntimes(), 0);
  assert.deepEqual(stopped, [], "a run the ledger calls running keeps its runtime");
  assert.ok(Date.now() - manager.runtimeActivity.get(key).lastUseAt < 5_000, "a working runtime waits a full idle period again");

  ledgerRunning = false;
  manager.runtimeActivity.get(key).lastUseAt = Date.now() - 120_000;
  assert.equal(await manager.sweepIdleRuntimes(), 1);
  assert.deepEqual(stopped, ["paper1"]);
  await manager.closeAll();
});

test("a ledger that cannot be read is not an idle one", async () => {
  const manager = managerWith({ runtimeIdleTimeoutMs: 60_000 }, { hasRunningRuns: async () => { throw new Error("ledger unreadable"); } });
  let stops = 0;
  manager.stopIdleRuntime = async () => { stops++; };
  await manager.start(project);
  manager.runtimeActivity.get(manager.key(project)).lastUseAt = Date.now() - 120_000;
  assert.equal(await manager.idleVerdict(project), "unknown");
  assert.equal(await manager.sweepIdleRuntimes(), 0);
  assert.equal(stops, 0);
  await manager.closeAll();
});

test("the per-runtime idle timer holds to the same rule as the sweep", async () => {
  let ledgerRunning = true;
  const manager = managerWith({ runtimeIdleTimeoutMs: 40 }, { hasRunningRuns: async () => ledgerRunning });
  const stopped = [];
  manager.stopIdleRuntime = async (stopping) => {
    stopped.push(stopping.id);
    manager.runtimes.delete(manager.key(stopping));
  };
  await manager.start(project);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(stopped, [], "the timer fired and asked again rather than stopping a runtime with a running run");
  ledgerRunning = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(stopped, ["paper1"]);
  await manager.closeAll();
});

async function tempProject(root, userId, id) {
  const rootDir = path.join(root, userId, id);
  const metaDir = path.join(rootDir, ".openscience");
  await mkdir(metaDir, { recursive: true });
  return { id, userId, rootDir, metaDir, workspaceDir: path.join(rootDir, "workspace"), runtimeDir: path.join(rootDir, "runtime") };
}

test("a start under way reports which moment it is in, and a refused one says why", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rt-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await tempProject(root, "alice", "paper1");
  const manager = managerWith({ maxRunningRuntimes: 1 });
  let release;
  manager.startKernel = (forProject) => new Promise((resolve) => {
    manager.noteStartStage(forProject, "kernel");
    release = () => resolve(fakeRuntime(forProject));
  });
  const starting = manager.start(project);
  await new Promise((resolve) => setImmediate(resolve));
  const during = await manager.status(project);
  assert.equal(during.running, false);
  assert.equal(during.startStage, "kernel");
  assert.equal(during.provider, "docker");
  assert.ok(RUNTIME_START_STAGES.includes(during.startStage));
  release();
  await starting;
  manager.startKernel = async (forProject) => fakeRuntime(forProject);
  const up = await manager.status(project);
  assert.equal(up.running, true);
  assert.equal(up.startStage, null);

  // The one slot is taken by another account: the refusal is the slot cap, and
  // the status the shell polls says so rather than leaving a clock to guess.
  const other = await tempProject(root, "bob", "paper2");
  await assert.rejects(() => manager.start(other), (error) => error.status === 429 && error.code === "runtime_limit_exceeded");
  const refused = await manager.status(other);
  assert.equal(refused.running, false);
  assert.equal(refused.startStage, null);
  assert.equal(refused.startError?.code, "runtime_limit_exceeded");
  assert.equal(refused.startError?.status, 429);

  // Freed, the next start is the newer answer and the refusal is gone.
  await manager.stop(project);
  await manager.start(other);
  assert.equal((await manager.status(other)).startError, null);
  await manager.closeAll();
});

test("sign-in warms the project whose runtime was used last, or the default one when none ever ran", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rt-warm-"));
  try {
    const makeProject = async (id, updatedAt) => {
      const rootDir = path.join(root, id);
      const metaDir = path.join(rootDir, ".openscience");
      await mkdir(metaDir, { recursive: true });
      if (updatedAt) {
        await writeFile(path.join(metaDir, "runtime-state.json"), JSON.stringify({ version: 1, updatedAt, event: "idle_timeout", running: false }));
      }
      return { id, userId: "alice", rootDir, metaDir, workspaceDir: path.join(rootDir, "workspace"), runtimeDir: path.join(rootDir, "runtime") };
    };
    const manager = managerWith({ runtimeWarmOnSignIn: true });
    const started = [];
    manager.start = async (forProject) => { started.push(forProject.id); return fakeRuntime(forProject); };
    const projects = [
      await makeProject("default", null),
      await makeProject("older", "2026-09-18T01:00:00.000Z"),
      await makeProject("latest", "2026-09-19T08:00:00.000Z"),
    ];
    assert.equal(await manager.warmMostRecent(projects), "latest");
    assert.deepEqual(started, ["latest"]);

    started.length = 0;
    const fresh = [await makeProject("paper9", null), await makeProject("default-2", null)];
    const withDefault = [fresh[0], { ...fresh[1], id: "default" }];
    assert.equal(await manager.warmMostRecent(withDefault), "default", "a first sign-in lands on the default project");

    started.length = 0;
    const off = managerWith({ runtimeWarmOnSignIn: false });
    off.start = async () => { throw new Error("must not start"); };
    assert.equal(await off.warmMostRecent(projects), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the knowledge base and the personal library reach a Docker runtime read-only, and only where they belong", async (t) => {
  const { buildRuntimeLaunchPlan, RUNTIME_KNOWLEDGE_BASE_DIR, RUNTIME_LIBRARY_DIR, personalLibraryDir } = await import("../src/runtimeManager.mjs");
  const { symlink } = await import("node:fs/promises");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "rt-views-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const rootDir = path.join(dataDir, "users", "alice", "projects", "paper1");
  const baseDir = path.join(rootDir, "workspace");
  const docker = {
    dataDir,
    runtimeSandboxMode: "docker",
    runtimeContainerBin: "docker",
    runtimeContainerImage: "evimed-runtime-dsh:test",
    runtimeTransport: "unix",
    runtimeNetworkMode: "none",
    runtimeCpuLimit: "1",
    runtimeMemoryLimit: "1g",
  };
  const base = { id: "paper1", userId: "alice", rootDir, baseDir, workspaceDir: baseDir, runtimeDir: path.join(rootDir, "runtime") };
  const mounts = (plan) => plan.args.filter((_, index) => plan.args[index - 1] === "--mount");

  // Nothing to view yet: no extra mount, and nothing about the plan changes.
  let plan = buildRuntimeLaunchPlan(docker, base, 4096);
  assert.equal(mounts(plan).some((mount) => mount.includes(RUNTIME_KNOWLEDGE_BASE_DIR)), false);
  assert.equal(mounts(plan).some((mount) => mount.includes(RUNTIME_LIBRARY_DIR)), false);

  await mkdir(path.join(baseDir, "knowledge-base"), { recursive: true });
  await mkdir(personalLibraryDir(docker, "alice"), { recursive: true });
  plan = buildRuntimeLaunchPlan(docker, base, 4096);
  assert.ok(mounts(plan).includes(`type=bind,src=${path.join(baseDir, "knowledge-base")},dst=${RUNTIME_KNOWLEDGE_BASE_DIR},readonly`));
  assert.ok(mounts(plan).includes(`type=bind,src=${path.join(dataDir, "users", "alice", "library")},dst=${RUNTIME_LIBRARY_DIR},readonly`));
  // Nested after the workspace mount, or the workspace would cover them.
  const order = mounts(plan);
  assert.ok(order.findIndex((mount) => mount.endsWith("dst=/workspace")) < order.findIndex((mount) => mount.includes(RUNTIME_KNOWLEDGE_BASE_DIR)));

  // A volume-backed deployment mounts the same subpaths, still read-only.
  plan = buildRuntimeLaunchPlan({ ...docker, runtimeDataVolume: "open-science-data" }, base, 4096);
  assert.ok(mounts(plan).includes(`type=volume,src=open-science-data,dst=${RUNTIME_KNOWLEDGE_BASE_DIR},volume-subpath=users/alice/projects/paper1/workspace/knowledge-base,readonly`));

  // A scratch sub-workspace never contained the knowledge base and gains no
  // view of it; the account's library is still its own.
  const scratch = { ...base, workspaceDir: path.join(baseDir, "session_2026") };
  await mkdir(scratch.workspaceDir, { recursive: true });
  plan = buildRuntimeLaunchPlan(docker, scratch, 4096);
  assert.equal(mounts(plan).some((mount) => mount.includes(RUNTIME_KNOWLEDGE_BASE_DIR)), false);
  assert.ok(mounts(plan).some((mount) => mount.includes(RUNTIME_LIBRARY_DIR)));

  // A library that is a symlink is a way out of the account, not a library.
  await rm(personalLibraryDir(docker, "alice"), { recursive: true });
  await mkdir(path.join(dataDir, "elsewhere"), { recursive: true });
  await symlink(path.join(dataDir, "elsewhere"), personalLibraryDir(docker, "alice"));
  plan = buildRuntimeLaunchPlan(docker, base, 4096);
  assert.equal(mounts(plan).some((mount) => mount.includes(RUNTIME_LIBRARY_DIR)), false);
});

test("a launch creates the knowledge-base directory first, so its view is mounted from the first start", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "rt-kbdir-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const baseDir = path.join(dataDir, "users", "alice", "projects", "paper1", "workspace");
  await mkdir(baseDir, { recursive: true });
  const manager = managerWith({ dataDir });
  await manager.ensureKnowledgeBaseDir({ id: "paper1", userId: "alice", baseDir, workspaceDir: baseDir });
  const { stat } = await import("node:fs/promises");
  assert.ok((await stat(path.join(baseDir, "knowledge-base"))).isDirectory());
  // Not in a scratch workspace: nothing is created there.
  const scratch = path.join(baseDir, "session_x");
  await mkdir(scratch);
  await manager.ensureKnowledgeBaseDir({ id: "paper1", userId: "alice", baseDir, workspaceDir: scratch });
  await assert.rejects(() => stat(path.join(scratch, "knowledge-base")));
});
