import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MaintenanceService } from "../src/maintenanceService.mjs";
import { TaskManager } from "../src/taskManager.mjs";

const EMPTY_ACTIVITY = Object.freeze({
  activeCommands: 0,
  activeTasks: 0,
  backgroundOperations: 0,
  runningAgentRuns: 0,
  runtimes: { busy: 0, idle: 0, unknown: 0 },
});

class FakeDatabase {
  constructor(now) {
    this.now = now;
    this.lease = null;
    this.runningJobs = 0;
    this.trace = [];
  }

  async transaction(operation) {
    this.trace.push("begin");
    try {
      const result = await operation({ query: (text, values = []) => this.query(text, values) });
      this.trace.push("commit");
      return result;
    } catch (error) {
      this.trace.push("rollback");
      throw error;
    }
  }

  async query(text, values = []) {
    const sql = typeof text === "string" ? text : text.text;
    this.trace.push(sql.replace(/\s+/g, " ").trim());
    if (/pg_advisory_xact_lock_shared/.test(sql)) return { rows: [{ locked: true }] };
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }] };
    if (/INSERT INTO evimed_product\.maintenance_lease/.test(sql)) {
      const [requestId, ttlSeconds] = values;
      if (this.lease && this.lease.expiresAt > this.now() && this.lease.requestId !== requestId) return { rows: [] };
      const requestedAt = new Date(this.now());
      this.lease = {
        requestId,
        requestedAt,
        expiresAt: new Date(this.now() + ttlSeconds * 1000),
      };
      return { rows: [this.row()] };
    }
    if (/DELETE FROM evimed_product\.maintenance_lease/.test(sql)) {
      if (!this.lease || this.lease.requestId !== values[0]) return { rows: [] };
      const row = this.row();
      this.lease = null;
      return { rows: [row] };
    }
    if (/FROM evimed_product\.maintenance_lease/.test(sql)) {
      return { rows: this.lease && this.lease.expiresAt > this.now() ? [this.row()] : [] };
    }
    if (/FROM evimed_product\.jobs/.test(sql)) return { rows: [{ count: String(this.runningJobs) }] };
    throw new Error(`Unexpected query: ${sql}`);
  }

  row() {
    return {
      request_id: this.lease.requestId,
      requested_at: this.lease.requestedAt,
      expires_at: this.lease.expiresAt,
    };
  }
}

function fixture(activity = async () => EMPTY_ACTIVITY) {
  let now = Date.parse("2026-09-07T02:00:00.000Z");
  const database = new FakeDatabase(() => now);
  const timers = [];
  const service = new MaintenanceService(database, {
    inspectActivity: activity,
    now: () => new Date(now),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });
  return { database, service, timers, advance(ms) { now += ms; } };
}

test("maintenance admission closes atomically while admitted work is allowed to finish", async () => {
  const { database, service } = fixture();
  await service.initialize();
  let finishMutation;
  const mutationFinished = new Promise((resolve) => { finishMutation = resolve; });
  const mutation = service.withMutation(async () => {
    database.trace.push("operation");
    await mutationFinished;
  });
  while (!database.trace.includes("operation")) await new Promise((resolve) => setImmediate(resolve));

  const requested = await service.request({ requestId: "recovery-set-1", ttlSeconds: 30 });
  assert.equal(requested.state, "draining");
  assert.equal(requested.blockers.activeMutations, 1);
  await assert.rejects(service.withMutation(async () => assert.fail("must not enter")), {
    code: "maintenance_active",
    status: 503,
  });

  finishMutation();
  await mutation;
  assert.equal((await service.status()).state, "idle");
  const commit = database.trace.indexOf("commit");
  const operation = database.trace.indexOf("operation");
  assert.ok(commit >= 0 && commit < operation, "customer work must run after the shared advisory-lock transaction has ended");
  assert.equal(database.trace.some((row) => row.includes("pg_advisory_xact_lock_shared")), true);
  assert.equal(database.trace.some((row) => row.includes("pg_advisory_xact_lock") && !row.includes("_shared")), true);
});

test("unknown activity fails closed and a competing owner cannot replace or release the lease", async () => {
  const { service } = fixture(async () => { throw new Error("synthetic inspector failure"); });
  await service.initialize();
  await service.request({ requestId: "recovery-set-owner", ttlSeconds: 30 });
  const status = await service.status();
  assert.equal(status.state, "draining");
  assert.equal(status.blockers.unknown, 1);
  assert.equal(JSON.stringify(status).includes("synthetic inspector failure"), false);
  await assert.rejects(service.request({ requestId: "another-owner", ttlSeconds: 30 }), {
    code: "maintenance_conflict",
    status: 409,
  });
  await assert.rejects(service.release({ requestId: "another-owner" }), {
    code: "maintenance_conflict",
    status: 409,
  });
});

test("lease expiry automatically reopens admission without a release request", async () => {
  const { service, timers, advance } = fixture();
  await service.initialize();
  await service.request({ requestId: "expiring-owner", ttlSeconds: 30 });
  assert.equal(service.claimingAllowed(), false);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 0 && timers[0].delay <= 30_000);
  advance(30_001);
  await timers[0].callback();
  assert.equal(service.claimingAllowed(), true);
  assert.equal((await service.status()).state, "open");
});

test("running jobs, tasks, background work and runtime unknowns all prevent idle", async () => {
  const activity = async () => ({
    activeCommands: 1,
    activeTasks: 2,
    backgroundOperations: 3,
    runningAgentRuns: 4,
    runtimes: { busy: 5, idle: 6, unknown: 7 },
  });
  const { database, service } = fixture(activity);
  database.runningJobs = 8;
  await service.initialize();
  const result = await service.request({ requestId: "busy-owner", ttlSeconds: 30 });
  assert.equal(result.state, "draining");
  assert.deepEqual(result.blockers, {
    activeMutations: 0,
    activeCommands: 1,
    activeTasks: 2,
    backgroundOperations: 3,
    runningAgentRuns: 4,
    runningProductJobs: 8,
    busyRuntimes: 5,
    unknownRuntimes: 7,
    unknown: 0,
  });
});

test("TaskManager keeps already queued work intact while maintenance pauses claims", async (t) => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "maintenance-task-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metaDir = path.join(root, "meta");
  await mkdir(metaDir);
  let allowed = false;
  let invoked = 0;
  const manager = new TaskManager({
    commandTimeoutMs: 1000,
    maxConcurrentTasks: 1,
    maxConcurrentTasksPerProject: 1,
    maxLogFileBytes: 1024 * 1024,
    maxQueuedTasks: 10,
    maxQueuedTasksPerProject: 10,
  }, async () => { invoked += 1; }, { claimAllowed: () => allowed });
  t.after(() => manager.close());
  const project = { id: "project", userId: "user", rootDir: root, metaDir };
  const ctx = { config: {}, store: {}, runtimeManager: {}, commands: {}, req: { url: "/api/tasks", headers: {}, socket: {} },
    res: null, user: { id: "user" }, project };
  const queued = await manager.enqueue("synthetic", {}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invoked, 0);
  assert.equal((await manager.get(ctx, queued.id)).status, "queued");

  allowed = true;
  manager.resumeClaims();
  for (let attempt = 0; attempt < 20 && invoked === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(invoked, 1);
  assert.equal((await manager.get(ctx, queued.id)).status, "succeeded");
});
