import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const owner = `product_${randomUUID()}`;
const other = `product_${randomUUID()}`;
let database;
let documents;
let jobs;
before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Product test','development'),($2,'Other test','development')", [owner, other]);
  documents = new ProductDocuments(database);
  jobs = new ProductJobs(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [[owner, other]]);
  await database.close();
});
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("product documents persist across instances and never cross account scope", options, async () => {
  const id = randomUUID();
  const saved = await documents.put(owner, "capsule", id, { title: "Methods", layers: [] }, { expectedRevision: 0 });
  assert.equal(saved.revision, 1);
  assert.equal((await new ProductDocuments(database).get(owner, "capsule", id)).payload.title, "Methods");
  assert.equal(await documents.get(other, "capsule", id), null);
  assert.equal((await documents.list(other, "capsule")).items.length, 0);
});

test("concurrent document updates accept one writer and retain exact revisions", options, async () => {
  const id = randomUUID();
  await documents.put(owner, "source", id, { name: "first" }, { expectedRevision: 0 });
  const outcomes = await Promise.allSettled([
    documents.put(owner, "source", id, { name: "second" }, { expectedRevision: 1 }),
    documents.put(owner, "source", id, { name: "third" }, { expectedRevision: 1 }),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((x) => x.status === "rejected").reason.code, "product_revision_conflict");
  const history = await documents.history(owner, "source", id);
  assert.deepEqual(history.map((x) => x.revision), [2, 1]);
  assert.equal(history[1].payload.name, "first");
});

test("document removal is scoped, reversible and revision guarded", options, async () => {
  const id = randomUUID();
  await documents.put(owner, "notification", id, { title: "Ready" }, { expectedRevision: 0 });
  await assert.rejects(documents.remove(other, "notification", id, 1), { code: "product_document_not_found" });
  const removed = await documents.remove(owner, "notification", id, 1);
  assert.equal(removed.revision, 2);
  assert.equal(await documents.get(owner, "notification", id), null);
  const restored = await documents.restore(owner, "notification", id, 2);
  assert.equal(restored.revision, 3);
  assert.equal((await documents.get(owner, "notification", id)).payload.title, "Ready");
});

test("document pagination has bounded distinct pages and validates its vocabulary", options, async () => {
  for (let i = 0; i < 3; i++) await documents.put(owner, "agenda", randomUUID(), { title: `Question ${i}` }, { expectedRevision: 0 });
  const first = await documents.list(owner, "agenda", { limit: 2 });
  assert.equal(first.items.length, 2);
  const second = await documents.list(owner, "agenda", { limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map((x) => x.id)).size, 3);
  await assert.rejects(documents.get(owner, "arbitrary_sql_table", "x"), { code: "product_kind_invalid" });
  await assert.rejects(documents.put(owner, "capsule", randomUUID(), { text: "x".repeat(300_000) }, { expectedRevision: 0 }), { code: "product_document_too_large" });
});

test("job enqueue is idempotent and concurrent claims lease a job only once", options, async () => {
  const key = randomUUID();
  const a = await jobs.enqueue(owner, "ingest", { sourceId: "one" }, { idempotencyKey: key });
  const b = await jobs.enqueue(owner, "ingest", { sourceId: "one" }, { idempotencyKey: key });
  assert.equal(a.id, b.id);
  const leased = await Promise.all([jobs.claim(["ingest"], "worker-a", { leaseMs: 1000 }), jobs.claim(["ingest"], "worker-b", { leaseMs: 1000 })]);
  assert.equal(leased.filter(Boolean).length, 1);
  const job = leased.find(Boolean);
  assert.equal(job.id, a.id);
  assert.equal(job.attempts, 1);
  assert.equal(await jobs.get(other, job.id), null);
  await jobs.finish(owner, job.id, job.leaseToken, { recordCount: 3 });
  assert.equal((await jobs.get(owner, job.id)).status, "succeeded");
});

test("expired leases can be reclaimed but the prior worker cannot complete them", options, async () => {
  const row = await jobs.enqueue(owner, "distill", { sourceId: "two" }, { idempotencyKey: randomUUID() });
  const first = await jobs.claim(["distill"], "worker-a", { leaseMs: 1000 });
  await database.query("UPDATE evimed_product.jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [row.id]);
  const second = await jobs.claim(["distill"], "worker-b", { leaseMs: 1000 });
  assert.equal(second.id, row.id);
  assert.notEqual(first.leaseToken, second.leaseToken);
  await assert.rejects(jobs.finish(owner, row.id, first.leaseToken, {}), { code: "product_job_lease_lost" });
  await jobs.finish(owner, row.id, second.leaseToken, { extracted: 1 });
});

test("canceling a job removes execution authority and records a readable terminal state", options, async () => {
  const row = await jobs.enqueue(owner, "episode", { agendaId: "one" }, { idempotencyKey: randomUUID() });
  const lease = await jobs.claim(["episode"], "worker-a", { leaseMs: 1000 });
  await assert.rejects(jobs.cancel(other, row.id), { code: "product_job_not_found" });
  await jobs.cancel(owner, row.id);
  assert.equal((await jobs.get(owner, row.id)).status, "canceled");
  assert.equal(await jobs.renew(owner, row.id, lease.leaseToken, 1000), false);
  await assert.rejects(jobs.finish(owner, row.id, lease.leaseToken, {}), { code: "product_job_lease_lost" });
});

test("history exposes every retained revision through bounded revision pages", options, async () => {
  const id = randomUUID();
  for (let version = 0; version < 51; version++) {
    await documents.put(owner, "profile", id, { version }, { expectedRevision: version });
  }
  const first = await documents.history(owner, "profile", id, { limit: 50 });
  const second = await documents.history(owner, "profile", id, { beforeRevision: first.at(-1).revision, limit: 50 });
  assert.equal(first.length, 50);
  assert.deepEqual(second.map((x) => x.revision), [1]);
});

test("lease completion, failure and renewal recheck time after waiting for a row lock", options, async () => {
  for (const action of ["finish", "fail", "renew"]) {
    const row = await jobs.enqueue(owner, "verify", { action }, { idempotencyKey: randomUUID() });
    const lease = await jobs.claim(["verify"], "slow-worker", { leaseMs: 1000 });
    const blocker = await database.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM evimed_product.jobs WHERE id=$1 FOR UPDATE", [row.id]);
    const promise = (action === "finish" ? jobs.finish(owner, row.id, lease.leaseToken, {})
      : action === "fail" ? jobs.fail(owner, row.id, lease.leaseToken, { code: "test_failure", message: "Fixture" })
        : jobs.renew(owner, row.id, lease.leaseToken, 1000))
      .then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    try { await new Promise((resolve) => setTimeout(resolve, 1100)); }
    finally { await blocker.query("COMMIT"); blocker.release(); }
    const outcome = await promise;
    if (action === "renew") assert.equal(outcome.value, false);
    else assert.equal(outcome.error?.code, "product_job_lease_lost");
    await jobs.cancel(owner, row.id);
  }
});

test("an exhausted job locked by another worker does not block independent claims", options, async () => {
  const exhausted = await jobs.enqueue(owner, "notify", {}, { idempotencyKey: randomUUID(), maxAttempts: 1 });
  await jobs.claim(["notify"], "old-worker", { leaseMs: 1000 });
  await database.query("UPDATE evimed_product.jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [exhausted.id]);
  const ready = await jobs.enqueue(owner, "notify", {}, { idempotencyKey: randomUUID() });
  const blocker = await database.pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM evimed_product.jobs WHERE id=$1 FOR UPDATE", [exhausted.id]);
  const claim = jobs.claim(["notify"], "new-worker");
  try {
    const outcome = await Promise.race([claim, new Promise((resolve) => setTimeout(() => resolve(null), 400))]);
    assert.equal(outcome?.id, ready.id);
  } finally {
    await blocker.query("COMMIT"); blocker.release();
    await claim;
    await jobs.cancel(owner, ready.id);
  }
});


test("batch creation commits documents and revisions together or rolls back everything", options, async () => {
  const id = randomUUID();
  const capsule = { kind: "capsule", id, payload: { title: "Imported methods" } };
  const entry = { kind: "fact", id: randomUUID(), payload: { capsuleId: id, content: "Method" } };
  const saved = await documents.createBatch(owner, [capsule, entry]);
  assert.equal(saved.length, 2);
  assert.equal((await documents.history(owner, "fact", entry.id)).length, 1);
  const fresh = { ...entry, id: randomUUID() };
  await assert.rejects(documents.createBatch(owner, [fresh, capsule]), { code: "product_revision_conflict" });
  assert.equal(await documents.get(owner, "fact", fresh.id), null);
  assert.deepEqual(await documents.history(owner, "fact", fresh.id), []);
  await assert.rejects(documents.createBatch(owner, [fresh, { ...entry, id: randomUUID(), projectId: "not-owned" }]), { code: "23503" });
  assert.equal(await documents.get(owner, "fact", fresh.id), null);
  assert.equal(await documents.get(other, "capsule", id), null);
  await assert.rejects(documents.createBatch(owner, [fresh, fresh]), { code: "product_batch_invalid" });
});
