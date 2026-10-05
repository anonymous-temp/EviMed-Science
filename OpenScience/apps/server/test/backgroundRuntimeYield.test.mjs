// A researcher's start wins over the platform's own background work.
//
// 2026-10-04, live: a deployment with one runtime slot
// (`OPEN_SCIENCE_MAX_RUNNING_RUNTIMES=1`) let the learning loop's runtime hold
// it for ten minutes, and a researcher's start answered 429
// `runtime_limit_exceeded`. `backgroundRuntimeLimit` floors at one, which on a
// one-slot deployment is the whole deployment. The share only bounds what
// background work may take while nobody needs the room; when a researcher's
// start finds the global ceiling reached it retires the background runtime
// and the work resumes later. Never the other way round.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { LEARNING_PROJECT_ID, RUNTIME_YIELDED_CODE, SOURCES_PROJECT_ID } from "../src/internalProjects.mjs";
import { RUNTIME_KERNEL_NAME, RuntimeManager } from "../src/runtimeManager.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A project whose metadata directory exists, so a real stop can write its ledger rows. */
async function projectIn(root, userId, id) {
  const rootDir = path.join(root, userId, id);
  const project = { id, userId, rootDir, baseDir: path.join(rootDir, "workspace"), workspaceDir: path.join(rootDir, "workspace"), metaDir: path.join(rootDir, ".openscience") };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(project.workspaceDir, { recursive: true });
  return project;
}

/** @param {any} project @param {(...args: any[]) => any} [close] */
function runtimeOf(project, close = async () => {}) {
  return {
    kind: RUNTIME_KERNEL_NAME,
    url: `http://127.0.0.1/${project.userId}-${project.id}`,
    close,
    password: null,
    sandboxMode: "host",
    networkMode: null,
    workspaceDir: project.workspaceDir,
    proxyWorkspaceDir: project.workspaceDir,
    startedAt: new Date().toISOString(),
    pid: 123,
    exitedAt: null,
    project,
  };
}

/**
 * A manager on a one-slot deployment whose kernels are fakes that start at once.
 * @param {{ root: string, maxGlobal?: number, maxPerUser?: number, stops?: any[], ledgerBusy?: boolean, config?: any }} options
 */
function managerOn({ root, maxGlobal = 1, maxPerUser = 4, stops = [], ledgerBusy = false, config = {} }) {
  const manager = new RuntimeManager({
    runtimeMode: "kernel", runtimeSandboxMode: "docker", maxRunningRuntimes: maxGlobal, maxRunningRuntimesPerUser: maxPerUser,
    runtimeIdleYieldAfterMs: 30 * 60_000, ...config,
  }, {
    onRuntimeStop: async (project, status, errorCode) => { stops.push({ id: project.id, status, errorCode }); },
    hasRunningRuns: async () => ledgerBusy,
  });
  manager.startKernel = async (project) => runtimeOf(project);
  manager.runtimeBusy = async () => false;
  manager.root = root;
  return manager;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "os-background-yield-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    learning: await projectIn(root, "alice", LEARNING_PROJECT_ID),
    sources: await projectIn(root, "alice", SOURCES_PROJECT_ID),
    paper: await projectIn(root, "alice", "paper1"),
    bob: await projectIn(root, "bob", "paper9"),
  };
}

test("with one slot, a researcher's start retires the learning runtime that holds it and takes its place", async (t) => {
  const f = await fixture(t);
  const stops = [];
  const manager = managerOn({ root: f.root, stops });
  let closed = 0;
  manager.startKernel = async (project) => runtimeOf(project, async () => { closed += 1; });
  await manager.start(f.learning);
  manager.beginProxy(f.learning); // a monitor read is in flight: not a reason to wait
  assert.equal(manager.runtimeCount(), 1);

  const started = await manager.start(f.paper);

  assert.equal(started.url, "http://127.0.0.1/alice-paper1");
  assert.equal(manager.runtimes.has(manager.key(f.learning)), false, "the background runtime is gone");
  assert.equal(manager.runtimes.has(manager.key(f.paper)), true, "the researcher's runtime is up");
  assert.equal(closed, 1);
  // The runs it held end as yielded, never as a plain cancel or a failure.
  assert.deepEqual(stops, [{ id: LEARNING_PROJECT_ID, status: "canceled", errorCode: RUNTIME_YIELDED_CODE }]);
  const ledger = (await readFile(path.join(f.learning.metaDir, "runtime.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(ledger.some((row) => row.event === "yielded_to_researcher"), "the runtime ledger says why it stopped");
  await manager.closeAll();
});

test("every kind of background work gives way: learning, document understanding, evaluation cells and the acceptance battery", async (t) => {
  const f = await fixture(t);
  for (const id of [SOURCES_PROJECT_ID, `methodeval-${"ab".repeat(12)}`, "eval-method-release", "acceptance-meta-analysis", "audit-worker-probe"]) {
    const stops = [];
    const manager = managerOn({ root: f.root, stops });
    const background = await projectIn(f.root, "alice", id);
    await manager.start(background);
    await manager.start(f.paper);
    assert.deepEqual(stops.map((stop) => stop.id), [id], id);
    assert.equal(manager.runtimes.has(manager.key(f.paper)), true, id);
    await manager.closeAll();
  }
});

test("only enough background runtimes are retired, the newest first, and a researcher's own are left alone", async (t) => {
  const f = await fixture(t);
  const stops = [];
  // Four slots, two per researcher: background work may hold two of them while nobody needs the room.
  const manager = managerOn({ root: f.root, maxGlobal: 4, maxPerUser: 2, stops });
  const older = await manager.start(f.sources);
  older.startedAt = new Date(Date.now() - 600_000).toISOString();
  await manager.start(f.learning);
  await manager.start(f.bob);
  await manager.start(await projectIn(f.root, "bob", "paper10"));
  assert.equal(manager.runtimeCount(), 4);

  await manager.start(f.paper);

  assert.deepEqual(stops.map((stop) => stop.id), [LEARNING_PROJECT_ID], "one slot was needed, and the runtime up the shortest has done the least");
  assert.equal(manager.runtimes.has(manager.key(f.sources)), true, "the older background runtime keeps working");
  assert.equal(manager.runtimes.has(manager.key(f.bob)), true, "another researcher's runtime is never retired while background work can give way");
  assert.equal(manager.runtimeCount(), 4);
  await manager.closeAll();
});

test("a researcher's runtime is never retired for background work: the background start waits and its job defers", async (t) => {
  const f = await fixture(t);
  const stops = [];
  const manager = managerOn({ root: f.root, stops });
  await manager.start(f.paper);
  manager.beginProxy(f.paper);
  await assert.rejects(() => manager.start(f.learning), (error) => error.status === 429 && error.code === "runtime_capacity_full");
  manager.endProxy(f.paper);
  // Not even an idle one, and not even past the idle age: that rule is for another researcher's start.
  manager.activityFor(manager.key(f.paper)).lastUseAt = Date.now() - 6 * 3_600_000;
  await assert.rejects(() => manager.start(f.sources), (error) => error.code === "runtime_capacity_full");
  assert.deepEqual(stops, []);
  assert.equal(manager.runtimes.has(manager.key(f.paper)), true);
  await manager.closeAll();
});

test("a researcher's runtime stays when the ceiling that binds is theirs: background work is not asked to pay for their own limit", async (t) => {
  const f = await fixture(t);
  const stops = [];
  // The ledger still runs something in `paper1`, so it does not yield to her next project either.
  const manager = managerOn({ root: f.root, maxGlobal: 10, maxPerUser: 1, stops, ledgerBusy: true });
  await manager.start(f.learning);
  await manager.start(f.paper);
  const second = await projectIn(f.root, "alice", "paper2");
  // The per-user ceiling (one) is reached by `paper1`; the global one is not.
  await assert.rejects(() => manager.start(second), (error) => error.code === "runtime_limit_exceeded" && /user/.test(error.message));
  assert.deepEqual(stops, [], "retiring the learning runtime would free nothing the researcher's own ceiling needs");
  await manager.closeAll();
});

test("a speculative start retires nothing", async (t) => {
  const f = await fixture(t);
  const stops = [];
  const manager = managerOn({ root: f.root, stops });
  await manager.start(f.learning);
  await assert.rejects(() => manager.start(f.paper, { speculative: true }), (error) => error.code === "runtime_capacity_full");
  assert.deepEqual(stops, [], "a pointer over a project in the sidebar is a guess, not a researcher's start");
  assert.equal(manager.runtimes.has(manager.key(f.learning)), true);
  await manager.closeAll();
});

test("a background runtime still coming up is waited for, then retired, instead of refusing the researcher", async (t) => {
  const f = await fixture(t);
  const stops = [];
  const manager = managerOn({ root: f.root, stops });
  let release;
  manager.startKernel = async (project) => {
    if (project.id === LEARNING_PROJECT_ID) await new Promise((resolve) => { release = resolve; });
    return runtimeOf(project);
  };
  const background = manager.start(f.learning);
  for (let i = 0; i < 50 && !manager.starts.has(manager.key(f.learning)); i++) await sleep(1);
  const researcher = manager.start(f.paper);
  await sleep(20);
  assert.equal(manager.runtimes.has(manager.key(f.paper)), false, "the researcher waits for the seconds the start takes");
  release();
  await background;
  await researcher;
  assert.deepEqual(stops.map((stop) => stop.id), [LEARNING_PROJECT_ID]);
  assert.equal(manager.runtimes.has(manager.key(f.paper)), true);
  await manager.closeAll();
});

test("a background start that never settles does not hold the researcher past the bound", async (t) => {
  const f = await fixture(t);
  const manager = managerOn({ root: f.root, config: { runtimeBackgroundYieldWaitMs: 40 } });
  manager.startKernel = async (project) => {
    if (project.id === LEARNING_PROJECT_ID) await new Promise(() => {});
    return runtimeOf(project);
  };
  void manager.start(f.learning).catch(() => {});
  for (let i = 0; i < 50 && !manager.starts.has(manager.key(f.learning)); i++) await sleep(1);
  const began = Date.now();
  await assert.rejects(() => manager.start(f.paper), (error) => error.code === "runtime_capacity_full");
  assert.ok(Date.now() - began < 2_000, "the wait is bounded, and the refusal is the old one");
  manager.starts.clear();
});

test("a prompt refused behind a retirement is named as one, so its owner waits instead of counting a failure", async (t) => {
  const f = await fixture(t);
  const manager = managerOn({ root: f.root });
  await manager.start(f.learning);
  await manager.start(f.paper);
  await assert.rejects(
    () => manager.dispatchAdmittedPrompt(f.learning, "session-1", { text: "hello", allowBounded: true }),
    (error) => error.code === RUNTIME_YIELDED_CODE && error.status === 409 && error.definitivelyRejected === true,
  );
  // Another project that simply has no runtime is a plain rejection.
  await assert.rejects(
    () => manager.dispatchAdmittedPrompt(f.bob, "session-1", { text: "hello" }),
    (error) => error.code === "runtime_prompt_rejected",
  );
  // And once the project's runtime has come up again the mark is gone.
  await manager.stop(f.paper);
  await manager.start(f.learning);
  assert.equal(manager.recentlyYielded(manager.key(f.learning)), false);
  await manager.closeAll();
});

test("the operator's runtime counters tell what background work holds and how often it gave way", async (t) => {
  const f = await fixture(t);
  const manager = managerOn({ root: f.root, maxGlobal: 4, maxPerUser: 2 });
  await manager.start(f.learning);
  await manager.start(f.sources);
  assert.deepEqual(
    { active: manager.statsAll().background.active, limit: manager.statsAll().background.limit, yielded: manager.statsAll().background.yielded },
    { active: 2, limit: 2, yielded: 0 },
  );
  await manager.start(f.paper);
  await manager.start(f.bob);
  assert.equal(manager.statsAll().background.yielded, 0, "room enough: nothing was retired");
  await manager.start(await projectIn(f.root, "bob", "paper10"));
  const stats = manager.statsAll();
  assert.equal(stats.background.yielded, 1);
  assert.equal(stats.background.active, 1);
  assert.equal(stats.background.yieldFailures, 0);
  assert.ok(Date.parse(stats.background.lastYieldedAt) > 0);
  assert.equal(stats.running, 4, "the running count still says what is attached");
  await manager.closeAll();
});

test("the runs a retired runtime held end as yielded in the ledger, and nothing else about them changes", async (t) => {
  const f = await fixture(t);
  const store = new AgentRunStore({ get: async () => null }, { model: "deepseek/deepseek-v4-flash" });
  const run = { id: "run-yielded", status: "running" };
  /** @type {any[]} */
  const finished = [];
  store.list = async () => [run];
  store.finishInternal = async (project, id, terminal) => { finished.push({ project: project.id, id, terminal }); };
  await store.closeProject(f.learning, "canceled", RUNTIME_YIELDED_CODE);
  await store.closeProject(f.paper, "canceled");
  assert.deepEqual(finished.map((entry) => ({ project: entry.project, status: entry.terminal.status, errorCode: entry.terminal.errorCode, canceledBy: entry.terminal.canceledBy })), [
    { project: LEARNING_PROJECT_ID, status: "canceled", errorCode: RUNTIME_YIELDED_CODE, canceledBy: "platform" },
    { project: "paper1", status: "canceled", errorCode: "runtime_canceled", canceledBy: "platform" },
  ]);
});
