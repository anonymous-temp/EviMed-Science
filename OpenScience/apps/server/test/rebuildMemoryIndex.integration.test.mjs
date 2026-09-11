// `pnpm rebuild:memory-index` is the whole recovery story for the recall index:
// the index holds nothing of its own, so a lost volume or a changed embedding
// model is repaired by running this and nothing else. That makes two properties
// worth a real process rather than a unit test of a function it does not
// export: that the command builds its store and its index client from the
// server's own configuration, and that it rebuilds BOTH halves — the research
// records it writes itself, and the capsule facts that go through the durable
// job the server's worker also claims. Rebuilding one half and reporting
// success is the failure this test exists to refuse.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { MemoryIndexing } from "../src/memoryIndexing.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { createStore } from "../src/store.mjs";
import { OpenVikingClient, openVikingUserId, parseCapsuleFactUri, parseMemoryUri } from "../src/openVikingClient.mjs";
import { loadConfig } from "../src/config.mjs";
import { startOpenVikingServer } from "./fixtures/openVikingServer.mjs";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/rebuild-memory-index.mjs");
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("the rebuild command restores both halves of the index from the control-plane database", options, async (t) => {
  const index = await startOpenVikingServer();
  const dataDir = await mkdtemp("/tmp/evimed-rebuild-index-");
  const userId = `rebuild${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const environment = {
    ...process.env,
    OPEN_SCIENCE_DATA_DIR: dataDir,
    OPEN_SCIENCE_STATE_STORE: "postgres",
    OPEN_SCIENCE_DATABASE_URL: databaseUrl,
    OPEN_SCIENCE_RUNTIME_MODE: "mock",
    OPEN_SCIENCE_MEMORY_INDEX_PROVIDER: "openviking",
    OPEN_SCIENCE_OPENVIKING_URL: index.url,
    OPEN_SCIENCE_OPENVIKING_API_KEY: index.apiKey,
  };
  const store = createStore(loadConfig({
    dataDir, stateStore: "postgres", databaseUrl, runtimeMode: "mock", authMode: "local", devAuth: false,
  }));
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
    await database.close();
    await store.close();
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await store.createUser(userId, "test-only-rebuild-password", "rebuild");
  const documents = new ProductDocuments(database);
  await documents.put(userId, "capsule", "capsule-one", { title: "a capsule", imported: false }, { expectedRevision: 0 });
  await documents.put(userId, "fact", "fact-one",
    { capsuleId: "capsule-one", factKind: "preference", layer: "stable", content: "prefers tables over prose", status: "approved" },
    { expectedRevision: 0 });
  const { ResearchMemoryStore } = await import("../src/researchMemory.mjs");
  const memory = new ResearchMemoryStore({}, { database });
  await memory.upsertRecord(userId, {
    scope: "user", scopeId: "", kind: "preference", key: "reporting.format",
    value: "prefers tables over prose", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.8, sensitive: false,
  });

  const { stdout } = await run(process.execPath, [script, "--user", userId, "--json"], { env: environment });
  const summary = JSON.parse(stdout);
  assert.equal(summary.ok, true, stdout);
  assert.equal(summary.written, 1, "the research record was not written to the index");
  assert.equal(summary.capsules, 1, "the capsule half of the index was not rebuilt");
  assert.equal(summary.capsulesFailed, 0, stdout);

  // Read back through the same parsers recall uses: a file the index holds
  // under a path recall cannot parse is a file recall will never return.
  const written = [...index.files.keys()];
  assert.equal(written.filter((uri) => parseMemoryUri(uri)?.recordId).length, 1,
    `the research record copy is missing from ${written.join(", ")}`);
  assert.equal(written.filter((uri) => parseCapsuleFactUri(uri)?.factId === "fact-one").length, 1,
    `the capsule fact is missing from ${written.join(", ")}`);

  // The publication ledger is what the server's own worker reads to decide that
  // a capsule needs no work. A rebuild that left it behind would be reported as
  // done and then be undone by the next reconcile.
  const published = await database.query(
    "SELECT status,entry_count FROM evimed_product.memory_index_state WHERE user_id=$1 AND capsule_id=$2",
    [userId, "capsule-one"]);
  assert.equal(published.rows[0]?.status, "published");
  assert.equal(published.rows[0]?.entry_count, 1);

  // Running it again is the recovery case that matters: after a lost volume the
  // files are gone and the ledger still says published, and the command has to
  // write them again rather than believe the ledger.
  index.files.clear();
  const second = JSON.parse((await run(process.execPath, [script, "--user", userId, "--json"], { env: environment })).stdout);
  assert.equal(second.ok, true);
  assert.equal(index.files.size, 2, "a second run rebuilt nothing, so a lost index would stay lost");
});

test("the rebuild command refuses to run against a deployment with no index selected", options, async (t) => {
  const dataDir = await mkdtemp("/tmp/evimed-rebuild-index-");
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  // `builtin` is the term matcher: there is no index to rebuild, and the useful
  // answer is which provider the deployment is on rather than a stack trace.
  const result = await run(process.execPath, [script, "--user", "nobody", "--json"], {
    env: {
      ...process.env,
      OPEN_SCIENCE_DATA_DIR: dataDir,
      OPEN_SCIENCE_STATE_STORE: "postgres",
      OPEN_SCIENCE_DATABASE_URL: databaseUrl,
      OPEN_SCIENCE_RUNTIME_MODE: "mock",
      OPEN_SCIENCE_MEMORY_INDEX_PROVIDER: "builtin",
      OPEN_SCIENCE_OPENVIKING_URL: "",
    },
  }).catch((error) => error);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).status.provider, "builtin");
});

/** One user with one capsule holding one fact, which is all either test below
 *  needs from the product: something for the index job to publish. */
async function seedCapsule(store, documents, userId, capsuleId) {
  await store.createUser(userId, "test-only-rebuild-password", "rebuild");
  await documents.put(userId, "capsule", capsuleId, { title: "a capsule", imported: false }, { expectedRevision: 0 });
  await documents.put(userId, "fact", `${capsuleId}-fact`,
    { capsuleId, factKind: "preference", layer: "stable", content: "prefers tables over prose", status: "approved" },
    { expectedRevision: 0 });
}

function rebuildEnvironment(dataDir, index) {
  return {
    ...process.env,
    OPEN_SCIENCE_DATA_DIR: dataDir,
    OPEN_SCIENCE_STATE_STORE: "postgres",
    OPEN_SCIENCE_DATABASE_URL: databaseUrl,
    OPEN_SCIENCE_RUNTIME_MODE: "mock",
    OPEN_SCIENCE_MEMORY_INDEX_PROVIDER: "openviking",
    OPEN_SCIENCE_OPENVIKING_URL: index.url,
    OPEN_SCIENCE_OPENVIKING_API_KEY: index.apiKey,
  };
}

function rebuildConfig(dataDir, index) {
  return loadConfig({
    dataDir, stateStore: "postgres", databaseUrl, runtimeMode: "mock", authMode: "local", devAuth: false,
    memoryIndexProvider: "openviking", openVikingUrl: index.url, openVikingApiKey: index.apiKey,
  });
}

// `ProductJobs.claim` takes kinds and no user — it cannot take one, a worker
// claims for every account — so this command, run for one researcher, is handed
// the index jobs of researchers nobody named on its command line. Doing their
// work is right: it is the same work, against the same index. Deciding their
// retries is not. The server's worker enqueues with ten attempts and backs off,
// and a job this command marked terminally failed would leave another account's
// capsule unsearchable until somebody noticed.
test("a failure on another account's index job leaves that job retryable", options, async (t) => {
  const mine = `rebuild${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const theirs = `rebuild${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // The refusal is confined to the other account's subtree, so this run is the
  // ordinary one for the user it was asked about and a failure for the user it
  // was not.
  const index = await startOpenVikingServer({
    refuse: ({ uri }) => (uri.includes(openVikingUserId(theirs)) ? { status: 503, code: "unavailable" } : null),
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-rebuild-foreign-"));
  const config = rebuildConfig(dataDir, index);
  const store = createStore(config);
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1)", [[mine, theirs]]);
    await database.close();
    await store.close();
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const documents = new ProductDocuments(database);
  await seedCapsule(store, documents, mine, "capsule-mine");
  await seedCapsule(store, documents, theirs, "capsule-theirs");

  // Nothing is enqueued by hand: writing a capsule fires the outbox trigger,
  // which is where the other account's ten-attempt index jobs come from on a
  // live deployment too.
  const jobs = new ProductJobs(database);
  const foreign = (await database.query(
    "SELECT id,max_attempts FROM evimed_product.jobs WHERE user_id=$1 AND kind='memory-index'", [theirs])).rows;
  assert.ok(foreign.length > 0, "the outbox never enqueued the other account's index jobs");
  assert.ok(foreign.every((row) => row.max_attempts > 1), "these jobs are only interesting because they have retries left");

  const summary = JSON.parse(
    (await run(process.execPath, [script, "--user", mine, "--json"], { env: rebuildEnvironment(dataDir, index) })).stdout);
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.capsules, 1, "the report covers the capsules this invocation asked for, and no others");

  for (const row of foreign) {
    const after = await jobs.get(theirs, row.id);
    assert.equal(after?.status, "queued",
      "another account's index job was ended by a command run for someone else");
    assert.equal(after?.attempts, 1, "the job must have been claimed and tried, or this proves nothing");
    assert.equal(after?.error?.code, "memory_index_unavailable");
    assert.ok(Date.parse(after?.runAfter ?? "") > Date.now(), "a retried job must come back after a backoff, not at once");
  }
});

// The other half of claiming a shared queue: the command can be handed nothing,
// because the server's own worker is holding the job it just enqueued. That is
// not a failure — it is the same work, in another process — and a command that
// exits non-zero for it would turn running the recovery tool on a live
// deployment into an alarm. Maintenance is how this test takes the claim away
// on purpose; from the command's side a queue it cannot claim from looks the
// same whoever is holding it, and the lease is lifted below so that this test
// can stand in for the worker and finish the job.
test("a capsule finished by another worker is waited for, not reported as a failure", options, async (t) => {
  const userId = `rebuild${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const index = await startOpenVikingServer();
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-rebuild-elsewhere-"));
  const config = rebuildConfig(dataDir, index);
  const store = createStore(config);
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  t.after(async () => {
    await database.query("DELETE FROM evimed_product.maintenance_lease WHERE singleton=true");
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
    await database.close();
    await store.close();
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const documents = new ProductDocuments(database);
  await seedCapsule(store, documents, userId, "capsule-one");
  // The outbox trigger enqueues an index job for every capsule and fact write.
  // This test is about the job the command enqueues for itself, so the seed's
  // are cleared rather than left to be claimed in some order.
  await database.query("DELETE FROM evimed_product.jobs WHERE user_id=$1 AND kind='memory-index'", [userId]);
  const jobs = new ProductJobs(database);
  const indexing = new MemoryIndexing({ database, openViking: new OpenVikingClient(config), jobs });
  await database.query(`INSERT INTO evimed_product.maintenance_lease(singleton,request_id,requested_at,expires_at)
    VALUES (true,$1,clock_timestamp(),clock_timestamp()+interval '20 seconds')
    ON CONFLICT (singleton) DO UPDATE SET request_id=excluded.request_id,
      requested_at=excluded.requested_at,expires_at=excluded.expires_at`, ["rebuild-claimed-elsewhere"]);

  const finished = run(process.execPath, [script, "--user", userId, "--json"], { env: rebuildEnvironment(dataDir, index) });

  let queued = null;
  for (let attempt = 0; attempt < 200 && !queued; attempt += 1) {
    const rows = await database.query(
      "SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND kind='memory-index' AND status='queued'", [userId]);
    queued = rows.rows[0]?.id ?? null;
    if (!queued) await sleep(50);
  }
  assert.ok(queued, "the command never enqueued the capsule job");

  await database.query("DELETE FROM evimed_product.maintenance_lease WHERE singleton=true");
  const claimed = await jobs.claim(["memory-index"], `test-worker-${randomUUID()}`, { leaseMs: 60_000 });
  assert.equal(claimed?.id, queued, "the command claimed the job this test meant to hold");
  await indexing.rebuild(claimed);

  const summary = JSON.parse((await finished).stdout);
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.capsulesFailed, 0, JSON.stringify(summary));
  assert.deepEqual(summary.capsuleResults.map((row) => row.status), ["rebuilt_elsewhere"]);
});
