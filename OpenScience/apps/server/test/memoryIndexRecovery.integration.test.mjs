import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { MemoryIndexing } from "../src/memoryIndexing.mjs";
import { MemoryIndexWorker } from "../src/memoryIndexWorker.mjs";
import { OpenVikingClient, capsuleFactUri, capsuleMemoryRoot } from "../src/openVikingClient.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 15000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const apiKey = "recovery-test-key";

/** An in-memory OpenViking at the recorded wire shapes. It models file loss and
 *  transport failure; it does not certify physical restoration or ranking. */
function openVikingFake() {
  /** @type {Map<string,string>} */
  const files = new Map();
  const mutations = [];
  const state = { unavailable: false };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } });
  const failed = (status, code, message) => reply(status, { status: "error", error: { code, message, details: {} } });

  const impl = async (url, options_ = {}) => {
    const target = new URL(url);
    const method = options_.method ?? "GET";
    const body = options_.body == null ? null : JSON.parse(options_.body);
    if (target.pathname === "/health") return reply(200, { status: "ok", healthy: true, version: "v0.4.19", auth_mode: "trusted" });
    if ((options_.headers ?? {})["X-API-Key"] !== apiKey) return failed(401, "UNAUTHENTICATED", "Missing API Key in trusted mode with Root API Key enabled.");
    if (state.unavailable) return failed(503, "UNAVAILABLE", "The index is unavailable.");
    if (method === "POST" && target.pathname === "/api/v1/content/write") {
      mutations.push(["write", body.uri]);
      files.set(body.uri, String(body.content));
      return reply(200, { status: "ok", result: { uri: body.uri, semantic_status: "skipped", vector_status: body.wait ? "complete" : "queued" } });
    }
    if (method === "DELETE" && target.pathname === "/api/v1/fs") {
      if (body != null) return failed(400, "INVALID_ARGUMENT", "A JSON body is not supported here.");
      const uri = target.searchParams.get("uri") ?? "";
      const recursive = target.searchParams.get("recursive") === "true";
      const victims = [...files.keys()].filter((key) => key === uri || (recursive && key.startsWith(`${uri}/`)));
      mutations.push(["delete", uri]);
      if (!victims.length) return failed(404, "NOT_FOUND", "No such file or directory.");
      for (const victim of victims) files.delete(victim);
      return reply(200, { status: "ok", result: { uri, estimated_deleted_count: victims.length } });
    }
    if (method === "GET" && target.pathname === "/api/v1/fs/ls") {
      const uri = target.searchParams.get("uri") ?? "";
      const offset = Number(target.searchParams.get("offset") ?? 0);
      /** @type {Map<string,boolean>} */
      const children = new Map();
      for (const key of files.keys()) {
        if (!key.startsWith(`${uri}/`)) continue;
        const rest = key.slice(uri.length + 1);
        children.set(`${uri}/${rest.split("/")[0]}`, rest.includes("/"));
      }
      if (!children.size) return failed(404, "NOT_FOUND", "No such directory.");
      const entries = [...children].sort(([left], [right]) => left.localeCompare(right))
        .map(([entryUri, isDir]) => ({ uri: entryUri, size: 1, isDir, modTime: "2026-09-11T00:00:00Z", abstract: "" }));
      return reply(200, { status: "ok", result: entries.slice(offset, offset + 1_000) });
    }
    return failed(404, "NOT_FOUND", "No such route.");
  };

  const client = new OpenVikingClient({
    openVikingUrl: "http://openviking.internal:1933",
    openVikingApiKey: apiKey,
    openVikingAccount: "evimed",
    openVikingRequestTimeoutMs: 2_000,
  }, { fetchImpl: impl });
  return { client, files, mutations, setUnavailable(value) { state.unavailable = value; } };
}

async function fixture(t) {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  const users = [0, 1].map(() => `memory_recovery_${randomUUID()}`);
  const documents = new ProductDocuments(database);
  const jobs = new ProductJobs(database);
  const index = openVikingFake();
  const indexing = new MemoryIndexing({ database, jobs, openViking: index.client });
  const worker = new MemoryIndexWorker({ jobs, indexing });
  t.after(async () => {
    await worker.close();
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [users]);
    await database.close();
  });
  const generations = [];
  for (const userId of users) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Recovery fixture','development')", [userId]);
    await documents.put(userId, "capsule", "capsule", { title: "Recovery fixture" }, { expectedRevision: 0 });
    await documents.put(userId, "fact", "fact", {
      capsuleId: "capsule", factKind: "analysis", layer: "knowledge", content: `Canonical ${userId}`,
      status: "approved", provenance: [{ type: "source", id: "source" }],
    }, { expectedRevision: 0 });
    generations.push((await indexing.snapshot(userId, "capsule")).generation);
  }
  const leaf = (userIndex, revision = 1) => capsuleFactUri(users[userIndex], {
    accountCreatedAt: generations[userIndex], capsuleId: "capsule", factKind: "analysis", factId: "fact", revision,
  });
  const root = (userIndex) => capsuleMemoryRoot(users[userIndex], { accountCreatedAt: generations[userIndex], capsuleId: "capsule" });
  // Drain the real document outbox before introducing index failure.
  for (let remaining = 20; remaining > 0; remaining--) {
    const result = await worker.tick();
    if (!result) break;
    assert.equal(result.status, "succeeded");
  }
  for (const userIndex of [0, 1]) {
    assert.ok(index.files.has(leaf(userIndex)), "the outbox must have published every capsule before the test damages one");
  }
  assert.equal((await indexing.reconcile()).enqueued, 0);
  return { database, users, generations, jobs, indexing, worker, index, leaf, root };
}

test("reconciliation repairs missing and stale index files despite an unchanged PostgreSQL fingerprint", options, async t => {
  const f = await fixture(t);
  const [owner] = f.users;
  const untouched = f.leaf(1);
  const fingerprint = (await f.indexing.snapshot(owner, "capsule")).fingerprint;
  const damage = [
    () => { f.index.files.delete(f.leaf(0)); },
    () => { f.index.files.set(f.leaf(0, 9), "a revision this capsule never published"); f.index.files.delete(f.leaf(0)); },
    () => { f.index.files.set(`${f.root(0)}/analysis/fdW5rbm93bg.r1.md`, "a fact this capsule does not own"); },
  ];
  for (const damaged of damage) {
    damaged();
    assert.equal((await f.indexing.reconcile()).enqueued, 1);
    const result = await f.worker.tick();
    assert.equal(result?.status, "succeeded");
    assert.equal(result.result.status, "published", "a matching old SQL fingerprint cannot suppress index recovery");
    const restored = await f.indexing.readback(await f.indexing.snapshot(owner, "capsule"));
    assert.deepEqual(restored.map(row => [row.factId, row.revision]), [["fact", 1]]);
    assert.equal((await f.indexing.snapshot(owner, "capsule")).fingerprint, fingerprint);
    assert.ok(f.index.files.has(untouched), "one user's repair must not touch another user's subtree");
    assert.equal((await f.indexing.reconcile()).enqueued, 0, "successful repair must stop recurring reconciliation");
  }
});

test("an unavailable index retries without deleting its files or reporting already current", options, async t => {
  const f = await fixture(t);
  const owner = f.users[0];
  const job = await f.jobs.enqueue(owner, "memory-index", { capsuleId: "capsule", accountCreatedAt: f.generations[0] },
    { idempotencyKey: "verify-existing", maxAttempts: 3 });
  const previous = [...f.index.files];
  const mutations = f.index.mutations.length;
  f.index.setUnavailable(true);
  assert.equal(await f.worker.tick(), null);
  const queued = await f.jobs.get(owner, job.id);
  assert.equal(queued.status, "queued");
  assert.equal(queued.error.code, "memory_index_unavailable");
  assert.equal(f.index.mutations.length, mutations);
  assert.deepEqual([...f.index.files], previous);
  f.index.setUnavailable(false);
  await f.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND id=$2", [owner, job.id]);
  assert.equal((await f.worker.tick()).result.status, "already_current");
  assert.equal(f.index.mutations.length, mutations, "verified current files must not be rewritten");
});

test("lease expiry during final row locking rolls back index publication before a new worker recovers", options, async t => {
  const f = await fixture(t);
  const owner = f.users[0];
  const previous = (await f.database.query("SELECT * FROM evimed_product.memory_index_state WHERE user_id=$1", [owner])).rows;
  f.index.files.delete(f.leaf(0));
  const queued = await f.jobs.enqueue(owner, "memory-index", { capsuleId: "capsule", accountCreatedAt: f.generations[0] },
    { idempotencyKey: "expired-publication" });
  const claimed = await f.jobs.claim(["memory-index"], "short-lease-recovery", { leaseMs: 1000 });
  assert.equal(claimed.id, queued.id);
  const blocker = await f.database.pool.connect();
  let rebuilding;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='capsule' FOR UPDATE", [owner]);
    rebuilding = f.indexing.rebuild(claimed).then(value => ({ value }), error => ({ error }));
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline) {
      const blocked = await f.database.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE 'SELECT id,revision,payload,deleted_at%FOR SHARE'`);
      if (blocked.rowCount > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "the real final canonical row lock must be reached before expiring the lease");
    await blocker.query("SELECT pg_sleep(1.1)");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const result = await rebuilding;
  assert.equal(result.error?.code, "product_job_lease_lost");
  assert.deepEqual((await f.database.query("SELECT * FROM evimed_product.memory_index_state WHERE user_id=$1", [owner])).rows,
    previous, "a rejected completion must roll back its index-state side effect");
  assert.equal((await f.jobs.get(owner, queued.id)).status, "running");
  assert.equal((await f.worker.tick()).status, "succeeded");
  assert.equal((await f.indexing.readback(await f.indexing.snapshot(owner, "capsule"))).length, 1);
});
