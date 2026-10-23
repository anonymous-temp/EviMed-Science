import assert from "node:assert/strict";
import test from "node:test";
import { OpenVikingSourceSyncWorker } from "../src/openVikingSourceSync.mjs";
import { databaseUrl, signedIn } from "./helpers/knowledgeBaseApp.mjs";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60000 };

test("runtime replica failure survives worker restart and retries the committed generation through the lifecycle outbox", options, async () => {
  const ctx = await signedIn();
  const runtime = ctx.app.runtimeManager;
  const provider = runtime.provider;
  const providerName = runtime.config.runtimeProvider;
  try {
    await ctx.app.sourceSyncWorker.close();
    let accepted = false;
    runtime.config.runtimeProvider = "agentbay";
    runtime.provider = { mirrorUpload: async () => accepted };
    runtime.runtimes.set(runtime.key(ctx.project), { containerName: "replica-session-1" });
    const response = await fetch(`${ctx.base}/api/files/upload`, { method: "POST", headers: ctx.headers,
      body: JSON.stringify({ root: "base", path: "knowledge-base/replica.txt", data: "committed bytes", encoding: "utf8" }) });
    assert.equal(response.status, 200);
    const source = (await response.json()).data.source;
    const jobs = ctx.app.sourceService.jobs;
    const first = new OpenVikingSourceSyncWorker({ jobs, service: ctx.app.sourceSync });
    await first.tick();
    await first.close();
    const current = () => ctx.app.sourceService.documents.get(ctx.user.id, "source", source.id);
    assert.equal((await current()).payload.runtimeReplica?.state, "retryable-failure");
    const database = ctx.app.sourceService.documents.database;
    const pending = await database.query("SELECT status,error FROM evimed_product.jobs WHERE user_id=$1 AND kind='ov-resource-sync' AND payload->>'action'='lifecycle' AND payload->>'sourceId'=$2", [ctx.user.id, source.id]);
    assert.ok(pending.rows.some(row => row.status === "queued" && row.error?.code === "source_runtime_replica_pending"));
    accepted = true;
    await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind='ov-resource-sync'", [ctx.user.id]);
    const restarted = new OpenVikingSourceSyncWorker({ jobs, service: ctx.app.sourceSync });
    await restarted.tick();
    await restarted.close();
    const replica = (await current()).payload.runtimeReplica;
    assert.equal(replica.state, "acknowledged");
    assert.equal(replica.sha256, source.payload.fingerprint.sha256);
    assert.equal(replica.generation, source.payload.generation);
    assert.equal(replica.runtimeIdentity, "replica-session-1");
  } finally {
    runtime.runtimes.delete(runtime.key(ctx.project)); runtime.provider = provider; runtime.config.runtimeProvider = providerName;
    await ctx.close();
  }
});
