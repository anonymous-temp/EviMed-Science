// A start that finds every runtime slot taken is a place in line, not a failure
// (2026-10-05, live acceptance: the deployment's four slots shared with other
// products were taken and the researcher was shown a refusal).
//
// What is held here: the two refusals are different codes — the deployment's
// full house (`runtime_capacity_full`, waited out) and the researcher's own
// ceiling (`runtime_limit_exceeded`, theirs to lift), the researcher's own
// ceiling asked first; a dispatch waits for a slot for a bounded time without
// raising any slot count; and the operator's books say how often people waited
// and for how long.
import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_KERNEL_NAME, RuntimeManager } from "../src/runtimeManager.mjs";

const projectOf = (userId, id) => ({
  id, userId,
  workspaceDir: `/srv/open-science/users/${userId}/projects/${id}/workspace`,
  runtimeDir: `/srv/open-science/users/${userId}/projects/${id}/runtime`,
});

function runtimeOf(project) {
  return {
    kind: RUNTIME_KERNEL_NAME, url: `http://127.0.0.1/${project.userId}-${project.id}`, close: async () => {}, password: null,
    sandboxMode: "host", networkMode: null, workspaceDir: project.workspaceDir, proxyWorkspaceDir: project.workspaceDir,
    startedAt: new Date().toISOString(), pid: 123, exitedAt: null, project,
  };
}

/** The holder's slot comes free: its runtime is gone, whatever ended it. */
const free = (manager, project) => { manager.runtimes.delete(manager.key(project)); };

function managerOf(config = {}) {
  const manager = new RuntimeManager({
    runtimeMode: "kernel", runtimeSandboxMode: "docker", maxRunningRuntimes: 1, maxRunningRuntimesPerUser: 2,
    runtimeIdleYieldAfterMs: 30 * 60_000, runtimeStartWaitMs: 60_000, ...config,
  }, { hasRunningRuns: async () => true });
  manager.startKernel = async (project) => runtimeOf(project);
  // Nothing is idle: a start is refused, never made room for, which is the case under test.
  manager.runtimeBusy = async () => true;
  return manager;
}

test("a full deployment refuses with its own code and a time to ask again; the researcher's own ceiling keeps its own", async () => {
  const manager = managerOf({ maxRunningRuntimes: 2, maxRunningRuntimesPerUser: 1 });
  await manager.start(projectOf("alice", "a1"));
  await manager.start(projectOf("bob", "b1"));
  // Both ceilings are reached for alice: hers is asked first, because waiting for the host's room would not give her a slot.
  await assert.rejects(() => manager.start(projectOf("alice", "a2")), (error) => error.status === 429 && error.code === "runtime_limit_exceeded");
  // Carol's own ceiling is nowhere near: the host is simply full.
  await assert.rejects(() => manager.start(projectOf("carol", "c1")),
    (error) => error.status === 429 && error.code === "runtime_capacity_full" && error.retryAfterSeconds === 5);
  await manager.closeAll();
});

test("a start that waited is on the operator's books: a refusal begins the wait, the project's next start ends it", async () => {
  const manager = managerOf();
  const holder = projectOf("alice", "a1");
  const waiter = projectOf("bob", "b1");
  await manager.start(holder);
  assert.deepEqual(manager.roomWaitsSnapshot().researcher, { started: 0, gaveUp: 0, seconds: 0, maxSeconds: 0, waiting: 0 });
  await assert.rejects(() => manager.start(waiter), { code: "runtime_capacity_full" });
  await assert.rejects(() => manager.start(waiter), { code: "runtime_capacity_full" });
  assert.equal(manager.roomWaitsSnapshot().researcher.waiting, 1, "two refusals of one project are one person waiting");
  manager.roomWaits.get(manager.key(waiter)).since -= 42_000;
  free(manager, holder);
  await manager.start(waiter);
  const books = manager.roomWaitsSnapshot();
  assert.equal(books.researcher.started, 1);
  assert.equal(books.researcher.waiting, 0);
  assert.ok(books.researcher.seconds >= 42 && books.researcher.seconds < 60, `the wait is its length, not a count: ${books.researcher.seconds}`);
  assert.equal(books.researcher.maxSeconds, books.researcher.seconds);
  assert.equal(books.background.started, 0);
  await manager.closeAll();
});

test("a wait nobody asked about for ten minutes was given up on, with the time that person waited", async () => {
  const manager = managerOf();
  await manager.start(projectOf("alice", "a1"));
  const waiter = projectOf("bob", "b1");
  await assert.rejects(() => manager.start(waiter), { code: "runtime_capacity_full" });
  const wait = manager.roomWaits.get(manager.key(waiter));
  wait.lastAt = Date.now() - 11 * 60_000;
  wait.since = wait.lastAt - 95_000;
  const books = manager.roomWaitsSnapshot().researcher;
  assert.equal(books.gaveUp, 1);
  assert.equal(books.started, 0);
  assert.ok(Math.abs(books.seconds - 95) < 1, `${books.seconds}`);
  assert.equal(manager.roomWaits.size, 0);
  await manager.closeAll();
});

test("a pointer-guess warm-up refused for room is no one waiting; background work is counted apart from researchers", async () => {
  const manager = managerOf();
  await manager.start(projectOf("alice", "a1"));
  await assert.rejects(() => manager.start(projectOf("bob", "b1"), { speculative: true }), { code: "runtime_capacity_full" });
  assert.equal(manager.roomWaits.size, 0);
  // The learning project is the platform's own work, whoever it runs as.
  await assert.rejects(() => manager.start(projectOf("alice", "evimed-learning")), { code: "runtime_capacity_full" });
  assert.equal([...manager.roomWaits.values()].map((wait) => wait.audience).join(), "background");
  assert.equal(manager.roomWaitsSnapshot().background.waiting, 1);
  assert.equal(manager.roomWaitsSnapshot().researcher.waiting, 0);
  await manager.closeAll();
});

test("a dispatch waits for a slot, backing off by the refusal's own hint, and starts when one is free", async () => {
  const manager = managerOf();
  const holder = projectOf("alice", "a1");
  const waiter = projectOf("bob", "b1");
  await manager.start(holder);
  const sleeps = [];
  const started = await manager.startWhenRoom(waiter, {}, {
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 3) free(manager, holder);
    },
  });
  assert.equal(started.url, "http://127.0.0.1/bob-b1");
  assert.equal(sleeps.length, 3, "three refusals, then the slot");
  assert.equal(sleeps[0], 5_000, "the refusal's own retryAfterSeconds first");
  assert.ok(sleeps[1] > sleeps[0] && sleeps.every((ms) => ms <= 15_000), `widening, never past fifteen seconds: ${sleeps}`);
  assert.equal(manager.roomWaitsSnapshot().researcher.started, 1, "and the books say that person waited");
  await manager.closeAll();
});

test("a dispatch that waited its whole allowance is refused as a full house; nothing else is waited on", async () => {
  const manager = managerOf({ runtimeStartWaitMs: 20_000 });
  await manager.start(projectOf("alice", "a1"));
  const slept = [];
  let clock = 0;
  const hooks = { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } };
  await assert.rejects(() => manager.startWhenRoom(projectOf("bob", "b1"), {}, hooks), { code: "runtime_capacity_full" });
  assert.ok(slept.length >= 2 && clock === 20_000, `the allowance is spent to the millisecond, not past it: ${slept}`);

  // A zero allowance is no wait at all.
  const impatient = managerOf({ runtimeStartWaitMs: 0 });
  await impatient.start(projectOf("alice", "a1"));
  await assert.rejects(() => impatient.startWhenRoom(projectOf("bob", "b1"), {}, { sleep: async () => assert.fail("must not sleep") }), { code: "runtime_capacity_full" });

  // The researcher's own ceiling is theirs: waiting would change nothing.
  const own = managerOf({ maxRunningRuntimes: 5, maxRunningRuntimesPerUser: 1 });
  await own.start(projectOf("alice", "a1"));
  await assert.rejects(() => own.startWhenRoom(projectOf("alice", "a2"), {}, { sleep: async () => assert.fail("must not sleep") }), { code: "runtime_limit_exceeded" });
  await manager.closeAll();
  await impatient.closeAll();
  await own.closeAll();
});
