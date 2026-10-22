import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { MaintenanceService } from "../src/maintenanceService.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "Dedicated local PostgreSQL required" };
let database;
let service;
let userId;
let admin;
let isolatedDatabase;
let isolatedDatabaseUrl;

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedDatabase = `${decodeURIComponent(source.pathname.slice(1))}_maintenance_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedDatabase, /^evimed_test_[a-z0-9_]+$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedDatabase}"`);
  source.pathname = `/${isolatedDatabase}`;
  isolatedDatabaseUrl = source.href;
  database = new ControlPlaneDatabase({ databaseUrl: isolatedDatabaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  userId = `maintenance_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Maintenance','development')", [userId]);
  service = new MaintenanceService(database, { inspectActivity: async () => EMPTY_ACTIVITY });
  await service.initialize();
});

after(async () => {
  if (!database) return;
  await service.close();
  await database.close();
  await admin.query(`DROP DATABASE "${isolatedDatabase}" WITH (FORCE)`);
  await admin.end();
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_product.maintenance_lease WHERE singleton=true");
  await database.query("DELETE FROM evimed_product.jobs WHERE user_id=$1", [userId]);
});

const EMPTY_ACTIVITY = {
  activeCommands: 0,
  activeTasks: 0,
  backgroundOperations: 0,
  runningAgentRuns: 0,
  runtimes: { busy: 0, idle: 0, unknown: 0 },
};

test("PostgreSQL lease fences ProductJobs claims and expires without cancellation", options, async () => {
  const jobs = new ProductJobs(database);
  const job = await jobs.enqueue(userId, "notify", { synthetic: true }, { idempotencyKey: `maintenance:${randomUUID()}` });
  await service.request({ requestId: "integration-owner", ttlSeconds: 30 });
  assert.equal(await jobs.claim(["notify"], "maintenance-test-worker", { leaseMs: 10_000 }), null);
  assert.equal((await jobs.get(userId, job.id)).status, "queued");

  await database.query(`UPDATE evimed_product.maintenance_lease
    SET requested_at=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()-interval '1 second'
    WHERE singleton=true`);
  const claimed = await jobs.claim(["notify"], "maintenance-test-worker", { leaseMs: 10_000 });
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, "running");
  await jobs.finish(userId, job.id, claimed.leaseToken, { synthetic: true });
});

test("exclusive maintenance request does not wait for already admitted work", options, async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  let entered;
  const began = new Promise((resolve) => { entered = resolve; });
  const running = service.withMutation(async () => { entered(); await gate; });
  await began;
  const requested = await service.request({ requestId: "integration-drain", ttlSeconds: 30 });
  assert.equal(requested.state, "draining");
  assert.equal(requested.blockers.activeMutations, 1);
  finish();
  await running;
  assert.equal((await service.status()).state, "idle");
  await service.release({ requestId: "integration-drain" });
});

test('real PostgreSQL durable hold keeps both mutation and job admission fenced after expiry and service restart', options, async () => {
  await service.request({ requestId: 'durable-integration', ttlSeconds: 30 });
  await service.hold({ requestId: 'durable-integration' });
  await database.query(`UPDATE evimed_product.maintenance_lease SET requested_at=clock_timestamp()-interval '2 hours',
    expires_at=clock_timestamp()-interval '1 hour' WHERE singleton=true`);
  const restarted = new MaintenanceService(database, { inspectActivity: async () => EMPTY_ACTIVITY });
  await restarted.initialize();
  assert.equal(restarted.claimingAllowed(), false);
  assert.equal((await restarted.status()).lease.durableHold, true);
  await assert.rejects(restarted.withMutation(async () => assert.fail('must remain fenced')), { code: 'maintenance_active' });
  const jobs = new ProductJobs(database);
  const job = await jobs.enqueue(userId, 'notify', { synthetic: true }, { idempotencyKey: `hold:${randomUUID()}` });
  assert.equal(await jobs.claim(['notify'], 'durable-test-worker', { leaseMs: 10000 }), null);
  assert.equal((await jobs.get(userId, job.id)).status, 'queued');
  assert.equal((await restarted.request({ requestId: 'durable-integration', ttlSeconds: 30 })).lease.durableHold, true);
  await assert.rejects(restarted.request({ requestId: 'wrong-owner', ttlSeconds: 30 }), { code: 'maintenance_conflict' });
  await restarted.release({ requestId: 'durable-integration' });
  assert.equal((await jobs.claim(['notify'], 'durable-test-worker', { leaseMs: 10000 })).id, job.id);
  await restarted.close();
});

test("loopback operator route blocks new API mutations while health remains readable", options, async (t) => {
  await database.query("DELETE FROM evimed_product.maintenance_lease WHERE singleton=true");
  const dataDir = await mkdtemp(path.join(tmpdir(), "maintenance-api-"));
  const token = "synthetic-maintenance-operator-token-123456789";
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: true,
    stateStore: "postgres",
    databaseUrl: isolatedDatabaseUrl,
    databasePoolMax: 4,
    databaseConnectionTimeoutMs: 2000,
    operatorMetricsToken: token,
    requireDurableUsageLedger: false,
  });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const operator = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const request = await fetch(`${base}/api/ops/maintenance`, {
    method: "POST",
    headers: operator,
    body: JSON.stringify({ action: "request", requestId: "api-owner", ttlSeconds: 30 }),
  });
  assert.equal(request.status, 200);
  let maintenance = await request.json();
  for (let attempt = 0; attempt < 50 && maintenance.data.state !== "idle"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    maintenance = await fetch(`${base}/api/ops/maintenance`, { headers: operator }).then((response) => response.json());
  }
  assert.equal(maintenance.data.state, "idle");
  const unauthorizedHold = await fetch(`${base}/api/ops/maintenance`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'hold', requestId: 'api-owner' }) });
  assert.equal(unauthorizedHold.status, 401);
  const hold = await fetch(`${base}/api/ops/maintenance`, { method: 'POST', headers: operator,
    body: JSON.stringify({ action: 'hold', requestId: 'api-owner' }) });
  assert.equal(hold.status, 200);
  assert.equal((await hold.json()).data.lease.durableHold, true);
  const blocked = await fetch(`${base}/api/auth/dev-login`, { method: "POST" });
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).code, "maintenance_active");
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/ready`)).status, 503);
  const release = await fetch(`${base}/api/ops/maintenance`, {
    method: "POST",
    headers: operator,
    body: JSON.stringify({ action: "release", requestId: "api-owner" }),
  });
  assert.equal(release.status, 200);
  assert.equal((await fetch(`${base}/api/auth/dev-login`, { method: "POST" })).status, 200);
});

test("runtime creation releases its read fence inside an ambient PostgreSQL transaction before the deferred boot", options, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-maintenance-cold-start-"));
  const app = createWebApiApp({ dataDir, devAuth: true, runtimeMode: "mock", stateStore: "postgres",
    databaseUrl: isolatedDatabaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000,
    requireDurableUsageLedger: false,
  });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await app.listen(0, "127.0.0.1");
  const user = await app.store.devUser();
  const project = await app.store.requireProject(user, "default");
  const manager = app.runtimeManager, db = app.store.database;
  manager.config = { ...manager.config, runtimeMode: "kernel" };
  manager.onRuntimeStart = () => {};
  let finish, entered, outerPid, checkOuterContext = true;
  const gate = new Promise(resolve => { finish = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  manager.startKernel = async () => {
    const current = await db.query("SELECT pg_backend_pid() AS pid");
    if (checkOuterContext) assert.equal(current.rows[0].pid, outerPid, "only the short admission detaches; creation retains its original transaction context");
    entered(); await gate;
    return { kind: "dsh", workspaceDir: project.workspaceDir, project, close: async () => {} };
  };
  const started = db.transaction(async client => {
    outerPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return db.withTransactionClient(client, () => manager.startAdmitted(project));
  });
  const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("maintenance waited for a deferred cold start")), 2000); timer.unref(); });
  try {
    await began;
    const requested = await Promise.race([app.maintenanceService.request({ requestId: "cold-start-drain", ttlSeconds: 30 }), timeout]);
    assert.equal(requested.state, "draining");
    assert.ok(requested.blockers.activeMutations >= 1, "the admitted container boot remains visible until it settles");
    const second = { ...project, id: "not-admitted", workspaceDir: project.workspaceDir + "-other" };
    await assert.rejects(manager.startAdmitted(second), { code: "maintenance_active" });
  } finally { finish(); await started; }
  assert.equal(app.maintenanceService.activeMutations, 0);
  manager.runtimes.clear();
  await app.maintenanceService.release({ requestId: "cold-start-drain" });
  checkOuterContext = false;
  assert.ok(await manager.startAdmitted(project), "creation works again after the lease is released");
});

test("one-connection cold readers share actual plugin admission without starving maintenance read fencing", options, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-maintenance-one-client-"));
  const app = createWebApiApp({ dataDir, devAuth: true, runtimeMode: "mock", stateStore: "postgres",
    databaseUrl: isolatedDatabaseUrl, databasePoolMax: 1, databaseConnectionTimeoutMs: 500,
    requireDurableUsageLedger: false,
  });
  t.after(async () => {
    // This composition-only fixture deliberately never starts HTTP or workers.
    try { await app.close(); }
    catch (error) { if (error.code !== "ERR_SERVER_NOT_RUNNING") throw error; await app.store.close(); }
    await rm(dataDir, { recursive: true, force: true });
  });
  await app.maintenanceService.initialize();
  const user = await app.store.devUser();
  const project = await app.store.requireProject(user, "default");
  const manager = app.runtimeManager, db = app.store.database;
  manager.config = { ...manager.config, runtimeMode: "kernel" };
  manager.onRuntimeStart = () => {};
  let finish, entered, pluginAdmissions = 0, boots = 0, parentPid;
  const gate = new Promise(resolve => { finish = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  const pluginAdmission = app.pluginService.withAdmission.bind(app.pluginService);
  app.pluginService.withAdmission = (p, operation, settings) => pluginAdmission(p, async () => {
    pluginAdmissions += 1;
    parentPid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await db.query("UPDATE evimed_control.projects SET name='before read fence' WHERE user_id=$1 AND id=$2", [user.id, project.id]);
    const result = await operation();
    await db.query("UPDATE evimed_control.projects SET name=name || ' and after' WHERE user_id=$1 AND id=$2", [user.id, project.id]);
    return result;
  }, settings);
  manager.startKernel = async () => {
    boots += 1;
    assert.equal((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, parentPid);
    entered(); await gate;
    return { kind: "dsh", workspaceDir: project.workspaceDir, project, close: async () => {} };
  };
  const started = Promise.all([manager.start(project), manager.start(project), manager.start(project)]);
  try {
    await Promise.race([began, started.then(() => assert.fail("must wait for the deferred boot"))]);
    assert.equal(db.pool.totalCount, 1);
    assert.equal(app.maintenanceService.activeMutations, 1);
    // This independent operator connection must acquire the exclusive maintenance
    // lock while the one-connection pool retains its original plugin transaction.
    const requested = await Promise.race([
      service.request({ requestId: "one-client-drain", ttlSeconds: 30 }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("admission lock survived its read fence")), 1500); timer.unref(); }),
    ]);
    assert.equal(requested.lease.requestId, "one-client-drain");
  } finally { finish(); await started; }
  assert.equal(boots, 1);
  assert.equal(pluginAdmissions, 1, "cold readers join before taking another plugin connection");
  assert.equal(app.maintenanceService.activeMutations, 0);
  assert.equal((await db.query("SELECT name FROM evimed_control.projects WHERE user_id=$1 AND id=$2", [user.id, project.id])).rows[0].name,
    "before read fence and after", "neither parent write was rolled back by admission");
  await assert.rejects(manager.startAdmitted({ ...project, id: "blocked", workspaceDir: project.workspaceDir + "-other" }), { code: "maintenance_active" });
  const warm = manager.runtimes.get(manager.key(project));
  await assert.rejects(manager.replacePersonalSkillRuntime(project, {}), { code: "maintenance_active" });
  assert.equal(manager.runtimes.get(manager.key(project)), warm, "denied replacement preserves the admitted warm runtime");
  await service.release({ requestId: "one-client-drain" });
  manager.runtimes.clear();
  manager.startKernel = async () => { throw new Error("synthetic provider failure"); };
  await assert.rejects(manager.start(project), /synthetic provider failure/);
  assert.equal(app.maintenanceService.activeMutations, 0, "a failed provider releases its admission exactly once");
});

test("an ambient read fence releases only its own locks and rolls back only its own savepoint", options, async () => {
  const observer = new pg.Client({ connectionString: isolatedDatabaseUrl });
  await observer.connect();
  try {
    await database.transaction(client => database.withTransactionClient(client, async () => {
      await client.query("CREATE TEMP TABLE g15_read_fence_parent(value text) ON COMMIT DROP");
      await client.query("INSERT INTO g15_read_fence_parent VALUES ('before')");
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await database.readFence(async borrowed => {
        assert.equal((await borrowed.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, pid);
        await borrowed.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('g15-read-only-admission',0))");
        // Even an accidental write in the fence must not escape or undo its parent.
        await borrowed.query("UPDATE g15_read_fence_parent SET value='discard me'");
      });
      assert.equal((await client.query("SELECT value FROM g15_read_fence_parent")).rows[0].value, 'before');
      await observer.query("BEGIN");
      const lock = await observer.query("SELECT pg_try_advisory_xact_lock(hashtextextended('g15-read-only-admission',0)) AS acquired");
      assert.equal(lock.rows[0].acquired, true, 'the shared admission lock ended before the parent transaction');
      await observer.query("ROLLBACK");
      await assert.rejects(database.readFence(async borrowed => {
        await borrowed.query("UPDATE g15_read_fence_parent SET value='also discard'");
        throw new Error('synthetic read-fence error');
      }), /synthetic read-fence error/);
      assert.equal((await client.query("SELECT value FROM g15_read_fence_parent")).rows[0].value, 'before');
      await client.query("UPDATE g15_read_fence_parent SET value=value || ' and after'");
      assert.equal((await client.query("SELECT value FROM g15_read_fence_parent")).rows[0].value, 'before and after');
    }));
  } finally { await observer.end(); }
});

test("repeatable-read admission rejects a stale ambient lease snapshot without damaging its parent", options, async () => {
  let release;
  try {
    await database.transaction(client => database.withTransactionClient(client, async () => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await client.query("SELECT count(*) FROM evimed_product.maintenance_lease");
      await client.query("CREATE TEMP TABLE g15_snapshot_parent(value text) ON COMMIT DROP");
      await client.query("INSERT INTO g15_snapshot_parent VALUES ('before')");
      await database.withoutTransactionClient(() => service.request({ requestId: "snapshot-owner", ttlSeconds: 30 }));
      try {
        await assert.rejects(async () => { release = await service.admitMutation(); }, { code: "maintenance_state_invalid" });
      } finally { release?.(); }
      assert.equal(service.activeMutations, 0);
      assert.equal((await client.query("SELECT value FROM g15_snapshot_parent")).rows[0].value, 'before');
      await client.query("UPDATE g15_snapshot_parent SET value=value || ' and after'");
      assert.equal((await client.query("SELECT value FROM g15_snapshot_parent")).rows[0].value, 'before and after');
    }));
  } finally { await service.release({ requestId: "snapshot-owner" }); }
});

test("standalone admission fails closed when the connection defaults to repeatable read", options, async () => {
  const db = new ControlPlaneDatabase({ databaseUrl: isolatedDatabaseUrl, databasePoolMax: 1, databaseConnectionTimeoutMs: 500 });
  const guard = new MaintenanceService(db, { inspectActivity: async () => EMPTY_ACTIVITY });
  let release;
  try {
    await guard.initialize();
    await db.withClient(client => client.query("SET default_transaction_isolation TO 'repeatable read'"));
    try {
      await assert.rejects(async () => { release = await guard.admitMutation(); }, { code: "maintenance_state_invalid" });
    } finally { release?.(); }
    assert.equal(guard.activeMutations, 0);
    assert.equal((await db.query("SELECT 1 AS usable")).rows[0].usable, 1);
  } finally { await guard.close(); await db.close(); }
});
