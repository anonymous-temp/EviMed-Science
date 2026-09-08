import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { SourceService } from "../src/sourceService.mjs";

// A Postgres-gated suite lives in its own `*.integration.test.mjs` file because
// that is the only thing `scripts/ops/test-product-state.mjs` collects. Inside
// the unit suite it was not "skipped here" but dead everywhere: CI runs the unit
// suite without a database and the durable step never sees the file.
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const durable = { timeout: 20_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** A directory whose pages and provider hashes the test controls outright. */
class FakeOpenList {
  constructor(pages = [[]]) { this.pages = pages; this.calls = []; }
  async list(userId, remotePath, { page = 1, perPage = 100 } = {}) {
    this.calls.push({ userId, remotePath, page, perPage });
    return { entries: this.pages[page - 1] ?? [], nextCursor: page < this.pages.length ? String(page + 1) : null };
  }
}

const remoteFile = (name, hash, overrides = {}) => ({ path: `/papers/${name}`, name, size: 2048,
  mtime: "2026-09-06T00:00:00.000Z", entryType: "file", providerHash: `sha256:${hash.repeat(64).slice(0, 64)}`, ...overrides });

async function fixture(t, pages) {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  const owner = `source_folder_${randomUUID()}`;
  const documents = new ProductDocuments(database);
  const jobs = new ProductJobs(database);
  const sources = new SourceService(documents, jobs);
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
    await database.close();
  });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Owner','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [owner]);
  const drive = new FakeOpenList(pages);
  sources.useConnector("openlist", drive);
  return { database, documents, jobs, sources, owner, drive };
}

const ingestJobs = (database, owner) => database.query(`SELECT id,payload->>'sourceId' AS source_id FROM evimed_product.jobs
  WHERE user_id=$1 AND kind='ingest' AND payload->>'action' IS NULL ORDER BY created_at,id`, [owner]);

test("a folder sync claims a real ingest lease, writes once, and cannot be replayed", durable, async (t) => {
  const { database, documents, jobs, sources, owner, drive } = await fixture(t, [[remoteFile("one.pdf", "1"), remoteFile("two.pdf", "2")]]);
  const registered = await sources.registerFolder(owner, { projectId: "default", path: "/papers" });
  assert.equal(registered.job.kind, "ingest", "the sync rides the existing ingest queue, not a new one");

  const claimed = await jobs.claim(["ingest"], `folder-sync-test-${randomUUID()}`, { leaseMs: 60_000 });
  assert.equal(claimed.userId, owner);
  assert.equal(claimed.payload.action, "source-folder-sync");
  assert.equal(claimed.payload.accountCreatedAt != null, true, "the run is cut against the account generation it saw");

  await assert.rejects(sources.consumeFolderSync({ ...claimed, leaseToken: randomUUID() }), { code: "product_job_lease_lost" });
  assert.equal((await documents.get(owner, "preferences", registered.folder.id)).payload.lastSync, null,
    "the folder record is what the lease fences");
  // A fenced attempt has already registered the entries it reached. That is the
  // real contract, and it is safe for a reason worth writing down: a source id
  // is the digest of its project and content, and its ingest job is keyed by
  // source and generation, so the replay below observes those same rows and
  // those same jobs instead of creating second copies of either.
  const afterFenced = await ingestJobs(database, owner);
  assert.equal(afterFenced.rows.length, 2, "a lost lease still wrote the registrations it had reached");
  assert.equal(drive.calls.length, 1);

  const result = await sources.consumeFolderSync(claimed);
  assert.equal(result.registered, 2);
  assert.equal(result.complete, true);
  const stored = await documents.get(owner, "preferences", registered.folder.id);
  assert.equal(stored.payload.sync.run, 2, "a finished run advances past its own job identity");
  assert.equal(Object.keys(stored.payload.entries).length, 2);
  const ingest = await ingestJobs(database, owner);
  assert.deepEqual(ingest.rows.map(row => row.id).sort(), afterFenced.rows.map(row => row.id).sort(),
    "the replay adopts the fenced attempt's ingest jobs rather than duplicating them");
  assert.deepEqual(ingest.rows.map(row => row.source_id).sort(),
    Object.values(stored.payload.entries).map(entry => entry.sourceId).sort());

  assert.equal((await sources.consumeFolderSync(claimed)).skippedRun, "sync_superseded");
  const account = await database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [owner]);
  await assert.rejects(sources.consumeFolderSync({ ...claimed,
    payload: { ...claimed.payload, accountCreatedAt: `${account.rows[0].generation}x` } }), { code: "source_account_changed" });
});

test("an unfinished folder run leaves its continuation queued in the same transaction", durable, async (t) => {
  // Six pages of one entry each: more pages than one run may read, so the run
  // stops with work left and must not stop without a job naming the next page.
  const pages = Array.from({ length: 6 }, (_, index) => [remoteFile(`paper-${index}.pdf`, String(index))]);
  const { database, documents, jobs, sources, owner } = await fixture(t, pages);
  const registered = await sources.registerFolder(owner, { projectId: "default", path: "/papers" });
  const claimed = await jobs.claim(["ingest"], `folder-sync-partial-${randomUUID()}`, { leaseMs: 60_000 });
  const result = await sources.consumeFolderSync(claimed);
  assert.equal(result.complete, false, "five pages is one run's budget; the sixth is left for the follow-up");
  assert.ok(result.continuedAs, "an unfinished run reports the job it queued");

  const stored = await documents.get(owner, "preferences", registered.folder.id);
  assert.equal(stored.payload.sync.run, 2);
  assert.equal(stored.payload.sync.page, 6);
  const queued = await database.query(`SELECT id,status,payload FROM evimed_product.jobs
    WHERE user_id=$1 AND kind='ingest' AND payload->>'action'='source-folder-sync' AND id=$2`, [owner, result.continuedAs]);
  assert.equal(queued.rows.length, 1, "the continuation is durable, not only reported");
  assert.equal(queued.rows[0].status, "queued");
  assert.equal(queued.rows[0].payload.run, 2, "the continuation names the run the folder record now waits for");
  assert.equal(queued.rows[0].payload.page, 6, "and resumes at the page the run stopped on");
  // The continuation shares the ingest queue with the registrations this run
  // made, so claim until the queue hands it over rather than assuming an order.
  let continued = null;
  for (let attempt = 0; attempt < 20 && !continued; attempt += 1) {
    const next = await jobs.claim(["ingest"], `folder-sync-continue-${randomUUID()}`, { leaseMs: 60_000 });
    if (!next) break;
    if (next.payload.action === "source-folder-sync") continued = next;
  }
  assert.ok(continued, "the continuation is claimable from the ordinary ingest queue");
  assert.equal(continued.id, result.continuedAs);
  const finished = await sources.consumeFolderSync(continued);
  assert.equal(finished.complete, true);
  assert.equal(finished.startPage, 6);
  assert.equal(Object.keys((await documents.get(owner, "preferences", registered.folder.id)).payload.entries).length, 6);
});

test("a folder resumed after a no-op run is queued a run the ledger can still hand out", durable, async (t) => {
  const { jobs, sources, owner, drive } = await fixture(t, [[remoteFile("one.pdf", "1")]]);
  const registered = await sources.registerFolder(owner, { projectId: "default", path: "/papers" });
  const paused = await sources.setFolderStatus(owner, registered.folder.id,
    { expectedRevision: registered.folder.revision, status: "paused" });

  // A run claimed while the folder is paused does no work and is retired
  // `succeeded` all the same. `ON CONFLICT DO UPDATE` re-arms only a `failed`
  // row and `claim` picks only a `queued` one, so recomputing the key that
  // named this run would leave the folder with no runnable job, forever.
  const noop = await jobs.claim(["ingest"], `folder-noop-${randomUUID()}`, { leaseMs: 60_000 });
  assert.equal(noop.id, registered.job.id);
  assert.equal((await sources.consumeFolderSync(noop)).skippedRun, "folder_paused");
  await jobs.finish(owner, noop.id, noop.leaseToken, { skippedRun: "folder_paused" });
  assert.equal((await jobs.get(owner, noop.id)).status, "succeeded");
  assert.equal(drive.calls.length, 0, "a paused folder is never listed");

  const resumed = await sources.setFolderStatus(owner, registered.folder.id,
    { expectedRevision: paused.folder.revision, status: "active" });
  assert.notEqual(resumed.job.id, noop.id, "resuming queues a run of its own, never the retired one");
  assert.equal(resumed.job.status, "queued");
  const claimed = await jobs.claim(["ingest"], `folder-resume-${randomUUID()}`, { leaseMs: 60_000 });
  assert.equal(claimed.id, resumed.job.id, "a folder that is active always has a sync run the queue hands out");
  const ran = await sources.consumeFolderSync(claimed);
  assert.equal(ran.skippedRun, undefined, "and that run is neither paused nor superseded");
  assert.equal(ran.registered, 1);
  assert.equal(drive.calls.length, 1, "the folder was walked, not only reported as scheduled");
});
