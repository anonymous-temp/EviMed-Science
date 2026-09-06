import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { SourceService } from "../src/sourceService.mjs";
import { SourceIngestionWorker } from "../src/sourceWorker.mjs";
import { removeSourceCopies, sourceAttemptId } from "../src/sourceFiles.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { MemoryIndexing } from "../src/memoryIndexing.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 15000, skip: !databaseUrl ? "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured"
  : process.platform !== "linux" && "Run the source deletion service pair in the hosted Linux environment" };
const absent = target => stat(target).then(() => false, error => error.code === "ENOENT");

async function fixture(t) {
  const root = await mkdtemp("/tmp/evimed-source-delete-");
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  const owner = `source_delete_${randomUUID()}`;
  const other = `source_delete_${randomUUID()}`;
  const documents = new ProductDocuments(database);
  const jobs = new ProductJobs(database);
  const sources = new SourceService(documents, jobs);
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other]]);
    await database.close(); await rm(root, { recursive: true, force: true });
  });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Owner','development'),($2,'Other','development')", [owner, other]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576),($2,'default','Default',1048576)", [owner, other]);
  const manifest = { projectId: "default", connector: { type: "upload", id: "library" }, path: "knowledge-base/original.txt",
    sha256: "a".repeat(64), size: 10, mimeType: "text/plain", mtime: "2026-09-06T00:00:00Z" };
  const { source } = await sources.register(owner, manifest);
  await documents.put(other, "source", source.id, { ...source.payload, status: "complete" }, { expectedRevision: 0, projectId: "default" });
  await mkdir(path.join(root, "knowledge-base"), { recursive: true });
  await writeFile(path.join(root, manifest.path), "original raw data");
  await writeFile(path.join(root, "report.md"), "existing delivered report");
  await mkdir(path.join(root, "knowledge-base/.evimed-derived/another-source"), { recursive: true });
  await writeFile(path.join(root, "knowledge-base/.evimed-derived/another-source/index.md"), "another source's derived data");
  const parse = async () => ({ extractor: { name: "fixture", version: "1.0.0", parser: "fallback" }, summary: "Extracted fixture", text: "parsed source text",
    units: [{ id: "unit-one", unitType: "chunk", status: "extracted", itemIds: [] }], facts: [], methods: [] });
  const worker = overrides => new SourceIngestionWorker({ jobs, sources, parser: { parse },
    resolveSource: async () => path.join(root, manifest.path),
    materialize: async (job, current, result) => {
      const relative = `knowledge-base/.evimed-derived/${current.id}/generation-${current.payload.generation}-${job.id}-${sourceAttemptId(job)}/index.md`;
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), result.text); return relative;
    },
    discardMaterialized: async (job, current) => removeSourceCopies({ projectRoot: root, sourceId: current.id, jobIds: [job.id], generation: current.payload.generation, attemptId: sourceAttemptId(job) }),
    cleanupSource: async (_job, current, jobIds) => removeSourceCopies({ projectRoot: root, sourceId: current.id, jobIds }),
    leaseMs: 1000, pollMs: 100, ...overrides,
  });
  return { root, database, documents, jobs, sources, source, manifest, owner, other, worker, parse };
}

test("the real source deletion producer and leased consumer retire owned understanding and preserve originals, reports and other sources", options, async t => {
  const f = await fixture(t);
  await f.worker().tick();
  const current = await f.sources.get(f.owner, f.source.id);
  const artifact = path.join(f.root, current.payload.outputs.artifactPath);
  assert.equal(await readFile(artifact, "utf8"), "parsed source text");
  await f.documents.put(f.owner, "source-unit", "unit-one", { sourceId: current.id, content: "indexed source content" }, { expectedRevision: 0, projectId: "default" });
  await f.documents.put(f.owner, "capsule", "source-capsule", { title: "Source understanding" }, { expectedRevision: 0 });
  await f.documents.put(f.owner, "preferences", "active-capsules:account", { items: [{ capsuleId: "source-capsule", mode: "own" }] }, { expectedRevision: 0 });
  await f.documents.put(f.owner, "fact", "derived-fact", { capsuleId: "source-capsule", content: "audited derived fact", status: "approved", provenance: [{ type: "source", id: current.id }] }, { expectedRevision: 0 });
  await f.documents.put(f.other, "fact", "derived-fact", { content: "other owner's fact", status: "approved", provenance: [{ type: "source", id: current.id }] }, { expectedRevision: 0 });
  const indexing = new MemoryIndexing({ database: f.database, jobs: f.jobs, engine: { search: async () => [{ entryId: "derived-fact", revision: 1, rank: 0 }] } });
  const capsules = new CapsuleService(f.documents, { indexing });
  assert.equal((await capsules.recall(f.owner, { query: "audited" })).items.length, 1);
  const removed = await f.sources.remove(f.owner, current.id, { expectedRevision: current.revision });
  assert.ok(removed.deletedAt);
  assert.equal((await capsules.recall(f.owner, { query: "audited" })).items.length, 0, "stale index hits must stop before asynchronous copy cleanup");
  assert.equal((await f.database.query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind='memory-index' AND payload->>'documentId'='derived-fact' AND payload->>'revision'='2'", [f.owner])).rowCount, 1);
  await f.worker().tick();
  assert.equal(await absent(artifact), true, "the source deletion job must have a real consumer that removes its materialized index");
  assert.equal(await f.documents.get(f.owner, "source-unit", "unit-one"), null);
  const fact = await f.documents.get(f.owner, "fact", "derived-fact");
  assert.equal(fact.payload.status, "retired");
  assert.equal(fact.payload.content, "audited derived fact");
  assert.equal((await f.documents.get(f.other, "fact", "derived-fact")).payload.status, "approved");
  assert.ok(await f.documents.get(f.other, "source", current.id));
  assert.equal(await readFile(path.join(f.root, "knowledge-base/original.txt"), "utf8"), "original raw data");
  assert.equal(await readFile(path.join(f.root, "report.md"), "utf8"), "existing delivered report");
  assert.equal(await readFile(path.join(f.root, "knowledge-base/.evimed-derived/another-source/index.md"), "utf8"), "another source's derived data");
  const deletion = await f.database.query("SELECT status FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action'='source-delete'", [f.owner]);
  assert.equal(deletion.rows[0].status, "succeeded");
});

test("a slow parser cannot recreate source copies after a second worker completes deletion", options, async t => {
  const f = await fixture(t);
  let began;
  let resume;
  const entered = new Promise(resolve => { began = resolve; });
  const waiting = new Promise(resolve => { resume = resolve; });
  let materialized = 0;
  const slow = f.worker({ parser: { parse: async () => { began(); await waiting; return {}; } },
    materialize: async () => { materialized++; throw new Error("stale parser must not materialize"); } });
  const running = slow.tick();
  await entered;
  const current = await f.sources.get(f.owner, f.source.id);
  await f.sources.remove(f.owner, current.id, { expectedRevision: current.revision });
  await f.worker().tick();
  resume(); await running;
  assert.equal(materialized, 0);
  assert.equal(await absent(path.join(f.root, "knowledge-base/.evimed-derived", current.id)), true);
  assert.equal((await f.documents.get(f.owner, "source", current.id, { includeDeleted: true })).payload.deletion.status, "complete");
  const jobs = (await f.database.query("SELECT status,payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest'", [f.owner])).rows;
  assert.equal(jobs.find(job => !job.payload.action).status, "canceled");
  assert.equal(jobs.find(job => job.payload.action === "source-delete").status, "succeeded");
});

test("cleanup retries under a new worker and repeated deletion retains one durable intent", options, async t => {
  const f = await fixture(t);
  await f.worker().tick();
  const current = await f.sources.get(f.owner, f.source.id);
  const removed = await f.sources.remove(f.owner, current.id, { expectedRevision: current.revision });
  await f.worker({ cleanupSource: async () => { throw Object.assign(new Error("fixture cleanup failure"), { code: "EACCES" }); } }).tick();
  const pending = await f.documents.get(f.owner, "source", current.id, { includeDeleted: true });
  assert.equal(pending.payload.deletion.status, "failed");
  assert.equal(pending.payload.deletion.error.code, "EACCES");
  assert.ok((await stat(path.join(f.root, current.payload.outputs.artifactPath))).isFile());
  await f.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE id=$1", [removed.payload.deletion.jobId]);
  await f.worker().tick();
  const repeated = await f.sources.remove(f.owner, current.id, { expectedRevision: current.revision });
  assert.equal(repeated.payload.deletion.status, "complete");
  assert.equal(repeated.payload.deletion.jobId, removed.payload.deletion.jobId);
  assert.equal((await f.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action'='source-delete'", [f.owner])).rowCount, 1);
});

test("reconciliation consumes the legacy deletion action without claiming unrelated consolidation work", options, async t => {
  const f = await fixture(t);
  const removed = await f.documents.remove(f.owner, "source", f.source.id, f.source.revision);
  const legacy = await f.jobs.enqueue(f.owner, "consolidate", { action: "source-delete", sourceId: f.source.id },
    { idempotencyKey: `source-delete:${f.source.id}:${removed.revision}`, projectId: "default" });
  const unrelated = await f.jobs.enqueue(f.owner, "consolidate", { action: "merge", sourceId: f.source.id }, { idempotencyKey: "unrelated-consolidation", projectId: "default" });
  await f.sources.reconcileJobs();
  await f.worker().tick();
  assert.equal((await f.jobs.get(f.owner, legacy.id)).kind, "ingest");
  assert.equal((await f.jobs.get(f.owner, legacy.id)).status, "succeeded");
  assert.equal((await f.jobs.get(f.owner, unrelated.id)).status, "queued");
  const second = await f.sources.reconcileJobs();
  assert.equal(second.enqueued, 0);
});

test("an expired cleanup cannot commit completion and restart reacquires the same idempotent work", options, async t => {
  const f = await fixture(t);
  await f.sources.remove(f.owner, f.source.id, { expectedRevision: f.source.revision });
  const expired = await f.jobs.claim(["ingest"], "old-source-worker", { leaseMs: 1000 });
  assert.equal(expired.userId, f.owner);
  assert.equal(expired.payload.action, "source-delete");
  await assert.rejects(f.sources.consumeDeletion(expired, async () => { await new Promise(resolve => setTimeout(resolve, 1100)); }), { code: "product_job_lease_lost" });
  const source = await f.documents.get(f.owner, "source", f.source.id, { includeDeleted: true });
  assert.equal(source.payload.deletion.status, "pending");
  await f.worker().tick();
  assert.equal((await f.jobs.get(f.owner, expired.id)).status, "succeeded");
  let cleaned = false;
  await assert.rejects(f.sources.consumeDeletion(expired, async () => { cleaned = true; }), { code: "product_job_lease_lost" });
  assert.equal(cleaned, false);
});

test("old-account and foreign-account cleanup identities cannot touch a replacement's source", options, async t => {
  const f = await fixture(t);
  await f.sources.remove(f.owner, f.source.id, { expectedRevision: f.source.revision });
  const job = await f.jobs.claim(["ingest"], "account-source-worker", { leaseMs: 1000 });
  assert.equal(job.userId, f.owner);
  let cleaned = false;
  await assert.rejects(f.sources.consumeDeletion({ ...job, userId: f.other }, async () => { cleaned = true; }), { code: "product_job_lease_lost" });
  await f.database.query("DELETE FROM evimed_control.users WHERE id=$1", [f.owner]);
  await f.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Replacement','development')", [f.owner]);
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Replacement',1048576)", [f.owner]);
  await f.documents.put(f.owner, "source", f.source.id, f.source.payload, { expectedRevision: 0, projectId: "default" });
  await assert.rejects(f.sources.consumeDeletion(job, async () => { cleaned = true; }), { code: "product_job_lease_lost" });
  assert.equal(cleaned, false);
  assert.ok(await f.sources.get(f.owner, f.source.id));
});

test("a failed outbox insert rolls back the source tombstone and ingestion cancellation", options, async t => {
  const f = await fixture(t);
  const database = Object.create(f.database);
  database.transaction = operation => f.database.transaction(client => operation({ query: async (sql, values) => {
    if (sql.startsWith("INSERT INTO evimed_product.jobs(id,user_id,project_id,kind,payload,idempotency_key)")) throw new Error("fixture outbox unavailable");
    return client.query(sql, values);
  } }));
  const documents = Object.create(f.documents);
  documents.database = database;
  const source = new SourceService(documents, f.jobs);
  await assert.rejects(source.remove(f.owner, f.source.id, { expectedRevision: f.source.revision }), /fixture outbox unavailable/);
  assert.equal((await f.sources.get(f.owner, f.source.id)).revision, f.source.revision);
  const jobs = (await f.database.query("SELECT status,payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest'", [f.owner])).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "queued");
  assert.equal(jobs[0].payload.action, undefined);
});

test("restart repairs an old tombstone with no deletion job and ignores a restored legacy target", options, async t => {
  const f = await fixture(t);
  await f.documents.remove(f.owner, "source", f.source.id, f.source.revision);
  await f.sources.reconcileJobs();
  await f.worker().tick();
  const deleted = await f.documents.get(f.owner, "source", f.source.id, { includeDeleted: true });
  assert.equal(deleted.payload.deletion.status, "complete");
  await f.documents.restore(f.owner, "source", f.source.id, deleted.revision);
  const obsolete = await f.jobs.enqueue(f.owner, "consolidate", { action: "source-delete", sourceId: f.source.id },
    { idempotencyKey: "obsolete-source-delete", projectId: "default" });
  await f.sources.reconcileJobs();
  assert.equal((await f.jobs.get(f.owner, obsolete.id)).status, "canceled");
  assert.ok(await f.sources.get(f.owner, f.source.id));
});

test("cleanup locks the account before its job so account deletion cannot invert the lock order", options, async t => {
  const f = await fixture(t);
  await f.sources.remove(f.owner, f.source.id, { expectedRevision: f.source.revision });
  const job = await f.jobs.claim(["ingest"], "ordered-source-worker", { leaseMs: 1000 });
  let checked = false;
  const database = Object.create(f.database);
  database.transaction = operation => f.database.transaction(client => operation({ query: async (sql, values) => {
    if (sql.startsWith("SELECT id FROM evimed_product.jobs") && sql.endsWith("FOR UPDATE")) {
      checked = true;
      await assert.rejects(f.database.transaction(other => other.query("SELECT id FROM evimed_control.users WHERE id=$1 FOR UPDATE NOWAIT", [f.owner])), { code: "55P03" });
    }
    return client.query(sql, values);
  } }));
  const documents = Object.create(f.documents); documents.database = database;
  const sources = new SourceService(documents, f.jobs);
  await sources.consumeDeletion(job, async (_job, current, jobIds) => removeSourceCopies({ projectRoot: f.root, sourceId: current.id, jobIds }));
  assert.equal(checked, true);
  assert.equal((await f.jobs.get(f.owner, job.id)).status, "succeeded");
});

test("an old parser failure and all stale metadata mutations cannot change a recreated account's source", options, async t => {
  const f = await fixture(t);
  let began;
  let rejectParse;
  let oldJob;
  let released = 0;
  const entered = new Promise(resolve => { began = resolve; });
  const parsing = new Promise((_resolve, reject) => { rejectParse = reject; });
  const jobs = Object.create(f.jobs);
  jobs.claim = async (...args) => { oldJob = await f.jobs.claim(...args); return oldJob; };
  const running = f.worker({ jobs, parser: { parse: async () => { began(); return parsing; } }, releaseResolved: async () => { released++; } }).tick();
  await entered;
  await f.database.query("DELETE FROM evimed_control.users WHERE id=$1", [f.owner]);
  await f.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'New generation','development')", [f.owner]);
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','New generation',1048576)", [f.owner]);
  const fresh = await f.sources.register(f.owner, f.manifest);
  const newJob = await f.jobs.claim(["ingest"], "fresh-account-worker", { leaseMs: 1000 });
  const processing = await f.sources.beginIngestion(f.owner, fresh.source.id, { generation: 1, job: newJob });
  rejectParse(new Error("old parser failed")); await running;
  const unchanged = await f.sources.get(f.owner, fresh.source.id);
  assert.equal(unchanged.payload.status, "parsing");
  assert.equal(unchanged.revision, processing.revision);
  assert.equal(released, 0, "old-account finally cleanup must not touch replacement-account paths");
  const extraction = { generation: 1, expectedRevision: processing.revision, extractor: { name: "fixture", version: "1", parser: "fallback" },
    units: [{ id: "unit-one", unitType: "chunk", status: "extracted", itemIds: [] }], summary: "Current result", facts: 0, methods: 0 };
  await assert.rejects(f.sources.beginIngestion(f.owner, fresh.source.id, { generation: 1, job: oldJob }), { code: "product_job_lease_lost" });
  await assert.rejects(f.sources.recordFailure(f.owner, fresh.source.id, { generation: 1, expectedRevision: processing.revision, code: "old_failure", job: oldJob }), { code: "product_job_lease_lost" });
  await assert.rejects(f.sources.recordExtraction(f.owner, fresh.source.id, { ...extraction, job: oldJob }), { code: "product_job_lease_lost" });
  assert.equal((await f.sources.recordExtraction(f.owner, fresh.source.id, { ...extraction, job: newJob })).payload.status, "complete");
});

test("a stale tombstone reconciliation snapshot cannot delete a recreated account's same-revision source", options, async t => {
  const f = await fixture(t);
  const removed = await f.documents.remove(f.owner, "source", f.source.id, f.source.revision);
  let recreated = false;
  const database = Object.create(f.database);
  database.query = async (sql, values) => {
    const result = await f.database.query(sql, values);
    if (!recreated && sql.includes("FROM evimed_product.documents d") && sql.includes("deleted_at IS NOT NULL") && sql.includes("LIMIT 100")) {
      recreated = true;
      await f.database.query("DELETE FROM evimed_control.users WHERE id=$1", [f.owner]);
      await f.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Replacement','development')", [f.owner]);
      await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Replacement',1048576)", [f.owner]);
      const fresh = await f.sources.register(f.owner, f.manifest);
      const processing = await f.sources.beginIngestion(f.owner, fresh.source.id, { generation: 1 });
      assert.equal(processing.revision, removed.revision);
    }
    return result;
  };
  const documents = Object.create(f.documents); documents.database = database;
  await assert.rejects(new SourceService(documents, f.jobs).reconcileJobs(), { code: "source_account_changed" });
  assert.equal(recreated, true);
  assert.equal((await f.sources.get(f.owner, f.source.id)).deletedAt, null);
});

test("a stale worker discard cannot delete a new lease's published copy of the same job", options, async t => {
  const f = await fixture(t);
  let began;
  let resume;
  let oldJob;
  let renewals = 0;
  const paused = new Promise(resolve => { began = resolve; });
  const waiting = new Promise(resolve => { resume = resolve; });
  const jobs = Object.create(f.jobs);
  jobs.claim = async (...args) => { oldJob = await f.jobs.claim(...args); return oldJob; };
  jobs.renew = async (...args) => {
    if (++renewals === 1) return f.jobs.renew(...args);
    if (renewals === 2) { began(); await waiting; }
    return false;
  };
  const old = f.worker({ jobs }).tick();
  await paused;
  await new Promise(resolve => setTimeout(resolve, 1100));
  const fresh = f.worker({ parser: { parse: async () => ({ ...await f.parse(), text: "NEW_PUBLISHED" }) } });
  const finished = await fresh.tick();
  assert.equal(finished.id, oldJob.id, "the next worker must reclaim the same durable job");
  const source = await f.sources.get(f.owner, f.source.id);
  const published = path.join(f.root, source.payload.outputs.artifactPath);
  assert.equal(await readFile(published, "utf8"), "NEW_PUBLISHED");
  resume(); await old;
  assert.equal(await readFile(published, "utf8"), "NEW_PUBLISHED");
  assert.equal((await f.sources.get(f.owner, f.source.id)).payload.status, "complete");
});
