import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskManager } from "../src/taskManager.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeProject(root, userId, projectId) {
  const rootDir = path.join(root, userId, projectId);
  const metaDir = path.join(rootDir, ".openscience");
  await mkdir(metaDir, { recursive: true });
  return { userId, id: projectId, rootDir, metaDir };
}

function context(project, config) {
  return {
    config,
    store: {},
    runtimeManager: {},
    commands: {},
    req: { url: "/api/tasks", headers: {}, socket: {} },
    res: null,
    user: { id: project.userId, name: project.userId },
    project,
  };
}

function controlledInvoker(records) {
  return (command, args, ctx) =>
    new Promise((resolve, reject) => {
      const record = {
        command,
        projectId: ctx.project.id,
        value: args.value,
        resolve,
      };
      records.push(record);
      ctx.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
}

async function waitForStatus(manager, ctx, taskId, status) {
  const deadline = Date.now() + 1_000;
  let current = null;
  while (Date.now() < deadline) {
    current = await manager.get(ctx, taskId);
    if (current.status === status) return current;
    await sleep(20);
  }
  assert.equal(current?.status, status);
  return current;
}

async function waitForRecords(records, count) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (records.length >= count) return;
    await sleep(20);
  }
  assert.equal(records.length, count);
}

test("task queue enforces per-project concurrency while preserving cross-project slots", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-task-manager-"));
  const config = {
    maxConcurrentTasks: 2,
    maxConcurrentTasksPerProject: 1,
    commandTimeoutMs: 0,
  };
  const records = [];
  const manager = new TaskManager(config, controlledInvoker(records));
  try {
    const projectA = await makeProject(dataDir, "alice", "paper-a");
    const projectB = await makeProject(dataDir, "alice", "paper-b");
    const ctxA = context(projectA, config);
    const ctxB = context(projectB, config);

    const a1 = await manager.enqueue("hold", { value: "a1" }, ctxA);
    const a2 = await manager.enqueue("hold", { value: "a2" }, ctxA);
    const b1 = await manager.enqueue("hold", { value: "b1" }, ctxB);

    assert.equal((await manager.get(ctxA, a1.id)).status, "running");
    assert.equal((await manager.get(ctxA, a2.id)).status, "queued");
    assert.equal((await manager.get(ctxB, b1.id)).status, "running");
    await waitForRecords(records, 2);
    assert.deepEqual(
      records.map((record) => `${record.projectId}:${record.value}`),
      ["paper-a:a1", "paper-b:b1"],
    );

    records.find((record) => record.value === "a1").resolve("done-a1");
    await waitForStatus(manager, ctxA, a2.id, "running");
    await waitForRecords(records, 3);
    assert.deepEqual(
      records.map((record) => `${record.projectId}:${record.value}`),
      ["paper-a:a1", "paper-b:b1", "paper-a:a2"],
    );

    records.find((record) => record.value === "b1").resolve("done-b1");
    records.find((record) => record.value === "a2").resolve("done-a2");
    const finishedA1 = await waitForStatus(manager, ctxA, a1.id, "succeeded");
    const finishedA2 = await waitForStatus(manager, ctxA, a2.id, "succeeded");
    const finishedB1 = await waitForStatus(manager, ctxB, b1.id, "succeeded");
    assert.equal(Object.hasOwn(finishedA1, "result"), false);
    assert.equal(Object.hasOwn(finishedA2, "result"), false);
    assert.equal(Object.hasOwn(finishedB1, "result"), false);
    assert.equal(Object.hasOwn(manager.tasks.get(a1.id), "result"), false);
  } finally {
    await Promise.allSettled(
      [...manager.tasks.values()]
        .map((task) => task.runPromise)
        .filter(Boolean),
    );
    await manager.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task queue rejects work when the global queue is full", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-task-manager-"));
  const config = {
    maxConcurrentTasks: 0,
    maxConcurrentTasksPerProject: 1,
    maxQueuedTasks: 1,
    maxQueuedTasksPerProject: 10,
    commandTimeoutMs: 0,
  };
  const manager = new TaskManager(config, controlledInvoker([]));
  try {
    const projectA = await makeProject(dataDir, "alice", "paper-a");
    const projectB = await makeProject(dataDir, "alice", "paper-b");
    const ctxA = context(projectA, config);
    const ctxB = context(projectB, config);

    const first = await manager.enqueue("hold", { value: "a1" }, ctxA);
    assert.equal(first.status, "queued");

    await assert.rejects(
      () => manager.enqueue("hold", { value: "b1" }, ctxB),
      (err) => {
        assert.equal(err.status, 429);
        assert.equal(err.code, "task_queue_full");
        assert.match(err.message, /server/);
        return true;
      },
    );
    assert.equal((await manager.list(ctxA)).length, 1);
    assert.equal((await manager.list(ctxB)).length, 0);
  } finally {
    await manager.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task queue rejects work when the project queue is full", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-task-manager-"));
  const config = {
    maxConcurrentTasks: 0,
    maxConcurrentTasksPerProject: 1,
    maxQueuedTasks: 10,
    maxQueuedTasksPerProject: 1,
    commandTimeoutMs: 0,
  };
  const manager = new TaskManager(config, controlledInvoker([]));
  try {
    const projectA = await makeProject(dataDir, "alice", "paper-a");
    const projectB = await makeProject(dataDir, "alice", "paper-b");
    const ctxA = context(projectA, config);
    const ctxB = context(projectB, config);

    const first = await manager.enqueue("hold", { value: "a1" }, ctxA);
    assert.equal(first.status, "queued");

    await assert.rejects(
      () => manager.enqueue("hold", { value: "a2" }, ctxA),
      (err) => {
        assert.equal(err.status, 429);
        assert.equal(err.code, "task_queue_full");
        assert.match(err.message, /project/);
        return true;
      },
    );

    const otherProject = await manager.enqueue("hold", { value: "b1" }, ctxB);
    assert.equal(otherProject.status, "queued");
    assert.equal((await manager.list(ctxA)).length, 1);
    assert.equal((await manager.list(ctxB)).length, 1);
  } finally {
    await manager.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
