// 2026-11-05 production freeze: the sync of a source held a PostgreSQL transaction (the account fence, the source row's
// registration advisory locks) across its HTTP calls to the engine, so a slow engine kept ingestion's publication and every
// pool connection queued behind it waiting. These tests make the engine slow and look at what the database holds while the
// engine call is in flight: nothing may be open.
import assert from "node:assert/strict";
import test from "node:test";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingResources } from "../src/openVikingResources.mjs";
import { OpenVikingSourceSync } from "../src/openVikingSourceSync.mjs";
import { databaseUrl, ingestCorpus, signedIn } from "./helpers/knowledgeBaseApp.mjs";
import { createOpenVikingStub } from "./helpers/openVikingResourcesStub.mjs";

const skip = !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured";
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** A sync whose engine takes `delayMs` for every write, and a log of what the database held at each write. */
async function slowSync(context, delayMs) {
  const engine = createOpenVikingStub();
  const client = new OpenVikingClient({ openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed" }, { fetchImpl: engine.fetch });
  const resources = new OpenVikingResources({ client });
  const database = context.app.store.database;
  /** @type {Array<{ idle: number, lockWaitMs: number }>} */
  const held = [];
  const push = resources.pushSource.bind(resources);
  resources.pushSource = async (...args) => {
    const idle = await database.pool.query(
      "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state LIKE 'idle in transaction%'");
    // What ingestion's publication needs while the engine answers: the source's registration lock.
    const started = Date.now();
    // Bounded: when the lock is held across this very call the probe would wait for the call it is part of.
    await Promise.race([context.app.sourceService.withRegistrationLocks([`source:${context.user.id}:${args[3]?.sourceId}`], async () => {}), sleep(800)]);
    held.push({ idle: idle.rows[0].n, lockWaitMs: Date.now() - started });
    await sleep(delayMs);
    return push(...args);
  };
  const sync = new OpenVikingSourceSync({ config: { ovKnowledgeEnabled: true }, sources: context.app.sourceService, resources, jobs: {},
    lifecycle: async () => ({}) });
  return { sync, held, engine };
}

test("a source's lifecycle sync keeps no transaction open and no source lock held across the engine call", { skip, timeout: 60000 }, async () => {
  const context = await signedIn();
  try {
    const [source] = await ingestCorpus(context, { names: ["房颤抗凝指南.pdf"] });
    const created = (await context.app.store.database.query("SELECT created_at::text AS g FROM evimed_control.users WHERE id=$1", [context.user.id])).rows[0].g;
    const { sync, held } = await slowSync(context, 1500);
    const result = await sync.runJob({ userId: context.user.id, projectId: source.projectId,
      payload: { action: "lifecycle", scope: "source", sourceId: source.id, projectId: source.projectId, accountCreatedAt: created, documentId: source.id } });
    assert.ok(held.length >= 1, `the engine was written to (${JSON.stringify(result)})`);
    for (const entry of held) {
      assert.equal(entry.idle, 0, "no transaction is open while the engine is written to");
      assert.ok(entry.lockWaitMs < 500, `the source's registration lock is free while the engine is written to (${entry.lockWaitMs} ms)`);
    }
  } finally { await context.close(); }
});

test("convergeSource and the library pass hold nothing across the engine call, and a deleted account is not pushed for", { skip, timeout: 60000 }, async () => {
  const context = await signedIn();
  try {
    const [source] = await ingestCorpus(context, { names: ["房颤抗凝指南.pdf"] });
    const { sync, held, engine } = await slowSync(context, 1000);
    assert.equal((await sync.convergeSource(context.user.id, source.id)).action, "pushed");
    assert.ok(held.length >= 1);
    for (const entry of held) { assert.equal(entry.idle, 0); assert.ok(entry.lockWaitMs < 500, `${entry.lockWaitMs} ms`); }
    // The fence: a lifecycle job of a former incarnation of the account does nothing at all.
    const before = engine.requests.length;
    const stale = await sync.runJob({ userId: context.user.id, projectId: source.projectId,
      payload: { action: "lifecycle", scope: "source", sourceId: source.id, projectId: source.projectId, accountCreatedAt: "1999-01-01 00:00:00+00", documentId: source.id } });
    assert.deepEqual(stale, { skipped: "obsolete-account" });
    assert.equal(engine.requests.length, before, "no engine request is made for an obsolete account");
  } finally { await context.close(); }
});
