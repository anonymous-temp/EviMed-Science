import assert from "node:assert/strict";
import test from "node:test";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
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
    // Simulate exhausted attempts before this worker process went away. The existing
    // lifecycle cadence must re-arm only replica-pending jobs after restart.
    await database.query("UPDATE evimed_product.jobs SET status='failed',attempts=max_attempts,finished_at=clock_timestamp() WHERE user_id=$1 AND kind='ov-resource-sync' AND payload->>'action'='lifecycle'", [ctx.user.id]);
    accepted = true;
    const restarted = new OpenVikingSourceSyncWorker({ jobs, service: ctx.app.sourceSync });
    await restarted.tick();
    await restarted.close();
    const replica = (await current()).payload.runtimeReplica;
    assert.equal(replica.state, "acknowledged");
    assert.equal(replica.sha256, source.payload.fingerprint.sha256);
    assert.equal(replica.generation, source.payload.generation);
    assert.equal(replica.runtimeIdentity, "replica-session-1");
    const events = await database.query("SELECT count(*)::integer AS count FROM evimed_product.jobs WHERE user_id=$1 AND kind='ov-resource-sync' AND payload->>'action'='lifecycle' AND payload->>'sourceId'=$2", [ctx.user.id, source.id]);
    assert.equal(events.rows[0].count, 1, "replica receipt updates emit no recursive lifecycle jobs");
  } finally {
    runtime.runtimes.delete(runtime.key(ctx.project)); runtime.provider = provider; runtime.config.runtimeProvider = providerName;
    await ctx.close();
  }
});

test("old lifecycle generations cannot mirror over a replacement and no active remote stays durably deferred", options, async () => {
  const ctx = await signedIn();
  const runtime = ctx.app.runtimeManager;
  const provider = runtime.provider;
  const providerName = runtime.config.runtimeProvider;
  try {
    await ctx.app.sourceSyncWorker.close();
    const response = await fetch(`${ctx.base}/api/files/upload`, { method: "POST", headers: ctx.headers,
      body: JSON.stringify({ root: "base", path: "knowledge-base/generation.txt", data: "version bytes", encoding: "utf8" }) });
    const source = (await response.json()).data.source;
    const database = ctx.app.sourceService.documents.database;
    const initial = (await database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='ov-resource-sync' AND payload->>'action'='lifecycle' AND payload->>'sourceId'=$2 ORDER BY created_at,id LIMIT 1", [ctx.user.id, source.id])).rows[0].payload;
    const replacement = await ctx.app.sourceService.override(ctx.user.id, source.id, { expectedRevision: source.revision,
      docType: source.payload.docType, depth: "index_only", reason: "Generation fence regression." });
    let calls = 0;
    runtime.config.runtimeProvider = "agentbay";
    runtime.provider = { mirrorUpload: async () => { calls++; return true; } };
    runtime.runtimes.set(runtime.key(ctx.project), { containerName: "replacement-session" });
    const oldAccount = await ctx.app.sourceSync.runJob({ userId: ctx.user.id, payload: { ...initial, accountCreatedAt: "1900-01-01" } });
    assert.equal(oldAccount.skipped, "obsolete-account");
    assert.equal(calls, 0);
    const obsolete = await ctx.app.sourceSync.runJob({ userId: ctx.user.id, payload: initial });
    assert.equal(obsolete.runtimeReplica.state, "obsolete");
    assert.equal(calls, 0);
    runtime.runtimes.delete(runtime.key(ctx.project));
    const deferred = await ctx.app.sourceSync.runJob({ userId: ctx.user.id, payload: { ...initial, generation: replacement.payload.generation } });
    assert.equal(deferred.runtimeReplica.state, "deferred");
    assert.equal(calls, 0);
    const current = await ctx.app.sourceService.documents.get(ctx.user.id, "source", source.id);
    assert.equal(current.payload.runtimeReplica.generation, replacement.payload.generation);
    assert.equal(current.payload.runtimeReplica.state, "deferred");
  } finally {
    runtime.runtimes.delete(runtime.key(ctx.project)); runtime.provider = provider; runtime.config.runtimeProvider = providerName;
    await ctx.close();
  }
});


test("local bind replicas need no remote acknowledgment and lifecycle replay recovers a missing first alias", options, async () => {
  const ctx = await signedIn();
  try {
    await ctx.app.sourceSyncWorker.close();
    const response = await fetch(`${ctx.base}/api/files/upload`, { method: "POST", headers: ctx.headers,
      body: JSON.stringify({ root: "base", path: "knowledge-base/local-replay.txt", data: "local original", encoding: "utf8" }) });
    const source = (await response.json()).data.source;
    await unlink(path.join(ctx.project.baseDir, source.payload.logicalPath));
    const database = ctx.app.sourceService.documents.database;
    const event = (await database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='ov-resource-sync' AND payload->>'action'='lifecycle' AND payload->>'sourceId'=$2 ORDER BY created_at,id LIMIT 1", [ctx.user.id, source.id])).rows[0].payload;
    const result = await ctx.app.sourceSync.runJob({ userId: ctx.user.id, payload: event });
    assert.equal(result.runtimeReplica.state, "not-needed");
    assert.equal(result.runtimeReplica.code, "local-bind-mount");
    assert.equal(await readFile(path.join(ctx.project.baseDir, source.payload.logicalPath), "utf8"), "local original");
    const current = await ctx.app.sourceService.documents.get(ctx.user.id, "source", source.id);
    assert.equal(current.revision, source.revision);
    assert.equal(current.payload.runtimeReplica.generation, source.payload.generation);
  } finally { await ctx.close(); }
});

test("a paused lifecycle mirror and concurrent registration finish without a JavaScript-mutex/database-row deadlock", options, async () => {
  const ctx = await signedIn();
  const runtime = ctx.app.runtimeManager;
  const provider = runtime.provider;
  const providerName = runtime.config.runtimeProvider;
  const knowledgeEnabled = ctx.app.sourceSync.config.ovKnowledgeEnabled;
  const resources = ctx.app.sourceSync.resources;
  const sources = ctx.app.sourceService;
  const guard = sources.withRegistrationLocks.bind(sources);
  let releaseMirror;
  const mirrorReleased = new Promise(resolve => { releaseMirror = resolve; });
  let mirrorReached;
  const reached = new Promise(resolve => { mirrorReached = resolve; });
  let registrationWork;
  const enteredRegistration = new Promise(resolve => { registrationWork = resolve; });
  let lifecycle;
  let registration;
  let blockedPid;
  try {
    await ctx.app.sourceSyncWorker.close();
    const upload = await fetch(`${ctx.base}/api/files/upload`, { method: "POST", headers: ctx.headers,
      body: JSON.stringify({ root: "base", path: "knowledge-base/mutex.txt", data: "mutex bytes", encoding: "utf8" }) });
    const source = (await upload.json()).data.source;
    const database = sources.documents.database;
    const event = (await database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='ov-resource-sync' AND payload->>'action'='lifecycle' AND payload->>'sourceId'=$2 ORDER BY created_at,id LIMIT 1", [ctx.user.id, source.id])).rows[0].payload;
    let competing = false;
    let lifecycleOwnsGuard = false;
    sources.withRegistrationLocks = (keys, work) => guard(keys, async () => {
      if (keys.includes(`source:${ctx.user.id}:${source.id}`)) {
        if (competing) registrationWork(); else lifecycleOwnsGuard = true;
      }
      return work();
    });
    runtime.config.runtimeProvider = "agentbay";
    runtime.provider = { mirrorUpload: async () => {
      const pid = (await database.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      mirrorReached(pid);
      await mirrorReleased;
      return true;
    } };
    runtime.runtimes.set(runtime.key(ctx.project), { containerName: "mutex-session" });
    ctx.app.sourceSync.config.ovKnowledgeEnabled = true;
    ctx.app.sourceSync.resources = { configured: true, sourceUri: () => "/source", removeSource: async () => false,
      listSources: async () => [], roots: () => ({ library: "/library" }) };
    lifecycle = ctx.app.sourceSync.runJob({ userId: ctx.user.id, payload: event });
    const lifecyclePid = await reached;
    competing = true;
    registration = sources.register(ctx.user.id, { projectId: source.projectId, connector: source.payload.connector,
      path: `${path.posix.dirname(source.payload.paths[0])}/duplicate.txt`, logicalPath: source.payload.logicalPath,
      ...source.payload.fingerprint, mtime: new Date().toISOString() });
    if (!lifecycleOwnsGuard) {
      await enteredRegistration;
      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await database.query("SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))", [lifecyclePid]);
        if (waiting.rowCount) { blockedPid = waiting.rows[0].pid; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(blockedPid, "the concurrent registration reached its held-row barrier");
    }
    releaseMirror();
    await Promise.race([Promise.all([lifecycle, registration]), new Promise((_, reject) => setTimeout(() => reject(new Error("Lifecycle and registration deadlocked after the mirror barrier")), 500))]);
  } finally {
    releaseMirror();
    if (blockedPid) await sources.documents.database.query("SELECT pg_cancel_backend($1)", [blockedPid]);
    await Promise.allSettled([lifecycle, registration].filter(Boolean));
    sources.withRegistrationLocks = guard;
    ctx.app.sourceSync.resources = resources; ctx.app.sourceSync.config.ovKnowledgeEnabled = knowledgeEnabled;
    runtime.runtimes.delete(runtime.key(ctx.project)); runtime.provider = provider; runtime.config.runtimeProvider = providerName;
    await ctx.close();
  }
});
