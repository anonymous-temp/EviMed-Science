import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { PluginService } from "../src/pluginService.mjs";
import { PluginApplyWorker } from "../src/pluginApplyWorker.mjs";
import { EXTENSION_GENERATION_JOB_VARIANT } from "../src/extensionGenerationWorker.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
test("the existing apply consumer dispatches generation variants once and never treats them as citation settings", {
  skip: !url && "Dedicated local PostgreSQL required",
}, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 });
  const userId = `dispatch_${randomUUID()}`;
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Dispatch fixture','development')", [userId]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'project','Dispatch fixture',1048576)", [userId]);
    const service = new PluginService(database);
    const queued = await service.jobs.enqueue(userId, "plugin-apply", { variant: EXTENSION_GENERATION_JOB_VARIANT }, { projectId: "project", idempotencyKey: "generation" });
    await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND id=$2", [userId, queued.id]);
    let dispatched = 0;
    const worker = new PluginApplyWorker({ service, runtime: {}, resolveProject: async () => assert.fail("legacy citation path must not run"), ledgerBusy: async () => false,
      generationWorker: { canHandle: job => job.payload.variant === EXTENSION_GENERATION_JOB_VARIANT, runClaimed: async job => {
        dispatched++; assert.equal(job.id, queued.id); return service.jobs.finish(userId, job.id, job.leaseToken, { scope: "explicit fixture dispatch only" });
      } },
    });
    await worker.tick(); assert.equal(dispatched, 1); assert.equal((await service.jobs.get(userId, queued.id)).status, "succeeded");
    const unsupported = await service.jobs.enqueue(userId, "plugin-apply", { variant: "unknown" }, { projectId: "project", idempotencyKey: "unsupported" });
    await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND id=$2", [userId, unsupported.id]);
    await worker.tick(); assert.equal(dispatched, 1); assert.equal((await service.jobs.get(userId, unsupported.id)).status, "failed");
  } finally { await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]); await database.close(); }
});
