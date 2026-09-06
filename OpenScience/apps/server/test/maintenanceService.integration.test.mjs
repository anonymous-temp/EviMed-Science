import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { MaintenanceService } from "../src/maintenanceService.mjs";
import { ProductJobs } from "../src/productJobs.mjs";

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

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  userId = `maintenance_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Maintenance','development')", [userId]);
  service = new MaintenanceService(database, { inspectActivity: async () => EMPTY_ACTIVITY });
  await service.initialize();
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_product.maintenance_lease WHERE singleton=true");
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
  await service.close();
  await database.close();
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

  await database.query("UPDATE evimed_product.maintenance_lease SET expires_at=clock_timestamp()-interval '1 second' WHERE singleton=true");
  const claimed = await jobs.claim(["notify"], "maintenance-test-worker", { leaseMs: 10_000 });
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, "running");
  await jobs.finish(userId, job.id, claimed.leaseToken, { synthetic: true });
});

test("exclusive maintenance request does not wait for already admitted work", options, async () => {
  await database.query("DELETE FROM evimed_product.maintenance_lease WHERE singleton=true");
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
