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
