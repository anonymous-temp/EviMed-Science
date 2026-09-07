import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HttpError } from "../src/security.mjs";
import { normalizeSourceText, projectSourceUnderstandingOutput, sourceUnderstandingAuditSample, sourceUnderstandingSchema,
  validateSourceUnderstanding } from "@evimed/domain";
import { projectSourceManifestRecord, sourceOmissionRecord, SOURCE_DEPTHS, SOURCE_TYPES, SourceService } from "../src/sourceService.mjs";

// The lease, replay and account-generation fences need a real database, so they
// live in `sourceFolderSync.integration.test.mjs` — the only shape the durable
// step (`scripts/ops/test-product-state.mjs`) collects.

class MemoryDocuments {
  constructor() { this.rows = new Map(); }
  key(userId, kind, id) { return `${userId}:${kind}:${id}`; }
  async get(userId, kind, id) { return this.rows.get(this.key(userId, kind, id)) ?? null; }
  async list(userId, kind, { projectId, filter = {}, limit = 50 } = {}) {
    const items = [...this.rows.values()].filter((row) => row.userId === userId && row.kind === kind
      && (projectId === undefined || row.projectId === projectId)
      && Object.entries(filter).every(([key, value]) => row.payload[key] === value));
    return { items: items.slice(0, limit), nextCursor: items.length > limit ? "next" : null };
  }
  async put(userId, kind, id, payload, { expectedRevision, projectId = null }) {
    const key = this.key(userId, kind, id);
    const current = this.rows.get(key);
    if ((current?.revision ?? 0) !== expectedRevision) {
      const error = new Error("revision conflict");
      error.code = "product_revision_conflict";
      throw error;
    }
    const row = { id, kind, userId, projectId, payload, revision: expectedRevision + 1,
      createdAt: current?.createdAt ?? "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
    this.rows.set(key, row);
    return row;
  }
  async remove(userId, kind, id, expectedRevision) {
    const current = await this.get(userId, kind, id);
    if (!current || current.revision !== expectedRevision) throw new Error("revision conflict");
    this.rows.delete(this.key(userId, kind, id));
    return { ...current, revision: expectedRevision + 1, deletedAt: "2026-09-06T01:00:00.000Z" };
  }
}

class MemoryJobs {
  constructor() { this.enqueued = []; this.leaseHeld = true; this.leaseChecks = 0; this.leaseDepth = 0; }
  async enqueue(userId, kind, payload, options) {
    const existing = this.enqueued.find((job) => job.userId === userId && job.options.idempotencyKey === options.idempotencyKey);
    if (existing) return existing;
    // Whether this enqueue rode the same transaction as the write that made it
    // necessary. Postgres decides that for real; here the call stack does.
    const job = { id: `job-${this.enqueued.length + 1}`, userId, kind, payload, options, status: "queued",
      enqueuedInLease: this.leaseDepth > 0 };
    this.enqueued.push(job);
    return job;
  }
  async withLease(_userId, _id, _leaseToken, operation) {
    this.leaseChecks += 1;
    if (!this.leaseHeld) return null;
    this.leaseDepth += 1;
    try { return await operation({ query: async () => ({ rows: [], rowCount: 0 }) }); }
    finally { this.leaseDepth -= 1; }
  }
}

/** The parts of `ProductJobs` this file needs to observe a run's whole life:
 * an idempotent enqueue that re-arms only a `failed` row (productJobs.mjs:31-38)
 * and a claim that picks only a `queued` one (productJobs.mjs:69-81). Modelling
 * those two rules is what makes a job finished at a key the service will
 * recompute visible here instead of only in production. */
class LedgerJobs {
  constructor() { this.rows = []; }
  async enqueue(userId, kind, payload, options) {
    const existing = this.rows.find((row) => row.userId === userId && row.options.idempotencyKey === options.idempotencyKey);
    if (existing) {
      if (options.rearmFailed && existing.status === "failed") { existing.status = "queued"; existing.payload = payload; }
      return existing;
    }
    const row = { id: `job-${this.rows.length + 1}`, userId, kind, projectId: options.projectId ?? null,
      payload, options, status: "queued", leaseToken: `lease-${this.rows.length + 1}` };
    this.rows.push(row);
    return row;
  }
  /** @param {string[]} kinds */
  async claim(kinds) {
    const row = this.rows.find((item) => kinds.includes(item.kind) && item.status === "queued");
    if (row) row.status = "running";
    return row ?? null;
  }
  async withLease(userId, id, leaseToken, operation) {
    const row = this.rows.find((item) => item.id === id && item.userId === userId
      && item.leaseToken === leaseToken && item.status === "running");
    if (!row) return null;
    return operation({ query: async () => ({ rows: [], rowCount: 0 }) });
  }
  async finish(userId, id, leaseToken, result) {
    const row = this.rows.find((item) => item.id === id && item.userId === userId && item.leaseToken === leaseToken);
    if (!row || row.status !== "running") throw new HttpError(409, "product_job_lease_lost", "This worker no longer owns the job.");
    row.status = "succeeded";
    row.result = result;
    return row;
  }
  /** The ingest queue also carries registration jobs, so claim until it hands
   * over a folder sync rather than assuming the order. */
  async claimFolderSync() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const next = await this.claim(["ingest"]);
      if (!next) return null;
      if (next.payload.action === "source-folder-sync") return next;
    }
    return null;
  }
}

/** A directory whose pages and provider hashes the test controls outright. */
class FakeOpenList {
  constructor(pages = [[]]) { this.pages = pages; this.calls = []; }
  async list(userId, remotePath, { page = 1, perPage = 100 } = {}) {
    this.calls.push({ userId, remotePath, page, perPage });
    const entries = this.pages[page - 1] ?? [];
    return { entries, nextCursor: page < this.pages.length ? String(page + 1) : null };
  }
}

const remoteFile = (name, hash, overrides = {}) => ({ path: `/papers/${name}`, name, size: 2048,
  mtime: "2026-09-06T00:00:00.000Z", entryType: "file", providerHash: `sha256:${hash.repeat(64).slice(0, 64)}`, ...overrides });

const syncJob = (folder, job) => ({ id: job.id, kind: "ingest", userId: "user-one", projectId: folder.projectId,
  leaseToken: "lease-one", payload: job.payload });

function fixture() {
  const documents = new MemoryDocuments();
  const jobs = new MemoryJobs();
  const service = new SourceService(documents, jobs, {
    extractorVersion: "evimed-analysis-1.0.0",
    now: () => new Date("2026-09-06T01:00:00.000Z"),
  });
  return { documents, jobs, service };
}

const upload = (overrides = {}) => ({
  projectId: "project-one",
  connector: { type: "upload", id: "project-one-library" },
  path: "knowledge-base/我的研究方案.docx",
  size: 4096,
  mtime: "2026-09-06T00:00:00.000Z",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sha256: "a".repeat(64),
  ...overrides,
});

test("source catalog defines every designed type and the four bounded depths", () => {
  assert.equal(SOURCE_TYPES.length, 22);
  assert.equal(new Set(SOURCE_TYPES).size, 22);
  assert.deepEqual(SOURCE_DEPTHS, ["skip", "index_only", "structured", "deep"]);
});

test("registering an upload creates a traceable manifest and one idempotent ingest job", async () => {
  const { service, jobs } = fixture();
  const result = await service.register("user-one", upload());

  assert.equal(result.duplicate, false);
  assert.equal(result.source.projectId, "project-one");
  assert.equal(result.source.payload.status, "queued");
  assert.equal(result.source.payload.docType, "research-protocol");
  assert.equal(result.source.payload.depth, "deep");
  assert.equal(result.source.payload.extractorVersion, "evimed-analysis-1.0.0");
  assert.equal(result.source.payload.fingerprint.sha256, "a".repeat(64));
  assert.ok(result.source.payload.reasons.length > 0);
  assert.equal(jobs.enqueued.length, 1);
  assert.equal(jobs.enqueued[0].kind, "ingest");
  assert.equal(jobs.enqueued[0].options.projectId, "project-one");
});

test("exact content is deduplicated while a changed path remains in one version family", async () => {
  const { service, jobs } = fixture();
  const first = await service.register("user-one", upload());
  const duplicate = await service.register("user-one", upload({ path: "knowledge-base/copy.docx" }));
  const changed = await service.register("user-one", upload({ sha256: "b".repeat(64), size: 8192 }));

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.source.id, first.source.id);
  assert.deepEqual(duplicate.source.payload.paths.sort(), ["knowledge-base/copy.docx", "knowledge-base/我的研究方案.docx"].sort());
  assert.equal(changed.duplicate, false);
  assert.equal(changed.source.payload.familyId, first.source.payload.familyId);
  assert.equal(changed.source.payload.version, 2);
  assert.equal(jobs.enqueued.length, 2, "an exact duplicate must not enqueue extraction twice");
});

test("parser coverage is separate from the unperformed understanding omission audit", async () => {
  const { service } = fixture();
  const { source } = await service.register("user-one", upload());
  const processing = await service.beginIngestion("user-one", source.id, { generation: source.payload.generation });
  const units = Array.from({ length: 20 }, (_, index) => ({
    id: `page-${index + 1}`,
    unitType: "page",
    status: index === 0 ? "failed" : "extracted",
    itemIds: index === 0 ? [] : [`claim-${index + 1}`],
  }));
  const reviewed = await service.recordExtraction("user-one", source.id, {
    expectedRevision: processing.revision,
    extractor: { name: "mineru", version: "3.4.5", parser: "mineru" },
    units,
    summary: "A protocol about a randomized clinical study.",
    facts: 9,
    methods: 2,
  });
  assert.equal(reviewed.payload.coverage.total, 20);
  assert.equal(reviewed.payload.coverage.accounted, 20);
  assert.equal(reviewed.payload.coverage.accountedPercent, 100);
  assert.equal(reviewed.payload.coverage.percent, 95);
  assert.equal(reviewed.payload.coverage.parserFailureRate, 0.05);
  assert.equal(reviewed.payload.coverage.omissionRate, null);
  assert.equal(reviewed.payload.omissionAudit.status, "not_run");
  assert.equal(reviewed.payload.status, "complete");

  const queued = await service.retry("user-one", source.id, { expectedRevision: reviewed.revision });
  const reprocessing = await service.beginIngestion("user-one", source.id, { generation: queued.payload.generation });
  const incomplete = await service.recordExtraction("user-one", source.id, {
    expectedRevision: reprocessing.revision,
    extractor: { name: "mineru", version: "3.4.5", parser: "mineru" },
    units: units.map((unit, index) => index < 2 ? { ...unit, status: "failed", itemIds: [] } : unit),
    summary: "A protocol about a randomized clinical study.",
    facts: 8,
    methods: 2,
  });
  assert.equal(incomplete.payload.coverage.parserFailureRate, 0.1);
  assert.equal(incomplete.payload.coverage.omissionRate, null);
  assert.equal(incomplete.payload.status, "needs_attention");
});

test("a user override is versioned, explainable and schedules selective reprocessing", async () => {
  const { service, jobs } = fixture();
  const { source } = await service.register("user-one", upload());
  const updated = await service.override("user-one", source.id, {
    expectedRevision: source.revision,
    docType: "lecture-slides",
    depth: "structured",
    reason: "This folder contains teaching material.",
  });
  assert.equal(updated.payload.docType, "lecture-slides");
  assert.equal(updated.payload.depth, "structured");
  assert.equal(updated.payload.status, "queued");
  assert.equal(updated.payload.override.reason, "This folder contains teaching material.");
  assert.equal(jobs.enqueued.length, 2);
  assert.equal(jobs.enqueued[1].payload.sourceGeneration, updated.payload.generation);
});

test("a disappeared upstream source retains its derived understanding", async () => {
  const { service } = fixture();
  const { source } = await service.register("user-one", upload());
  const processing = await service.beginIngestion("user-one", source.id, { generation: source.payload.generation });
  const complete = await service.recordExtraction("user-one", source.id, {
    expectedRevision: processing.revision,
    extractor: { name: "plain-text", version: "1.0.0", parser: "fallback" },
    units: [{ id: "chunk-1", unitType: "chunk", status: "extracted", itemIds: ["fact-1"] }],
    summary: "Preserved derived summary.", facts: 1, methods: 0,
  });
  const missing = await service.markMissing("user-one", source.id, { expectedRevision: complete.revision });
  assert.equal(missing.payload.status, "missing");
  assert.equal(missing.payload.outputs.summary, "Preserved derived summary.");
  assert.ok(missing.payload.missingAt);
});

test("cancel and retry preserve lifecycle while deletion requires a durable transaction", async () => {
  const { service, jobs } = fixture();
  const { source } = await service.register("user-one", upload());
  const canceled = await service.cancel("user-one", source.id, { expectedRevision: source.revision });
  assert.equal(canceled.payload.status, "canceled");

  const retried = await service.retry("user-one", source.id, { expectedRevision: canceled.revision });
  assert.equal(retried.payload.status, "queued");
  assert.equal(jobs.enqueued.at(-1).options.rearmFailed, true);

  await assert.rejects(service.remove("user-one", source.id, { expectedRevision: retried.revision }), { code: "source_state_unavailable" });
});

test("the connector vocabulary no longer names a local agent that does not ship", async () => {
  const { service } = fixture();
  await assert.rejects(service.register("user-one", upload({ connector: { type: "local-agent", id: "desktop" } })),
    { code: "source_connector_invalid" }, "a connector nothing can read must not be registrable");
  const accepted = await service.register("user-one", upload({ connector: { type: "openlist", id: "/papers/a.pdf" } }));
  assert.equal(accepted.source.payload.connector.type, "openlist");
});

test("a registered folder syncs incrementally: new, changed and unchanged entries are told apart", async () => {
  const { service, jobs, documents } = fixture();
  const drive = new FakeOpenList([[remoteFile("one.pdf", "1"), remoteFile("two.pdf", "2")]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  assert.equal(registered.created, true);
  assert.equal(registered.job.payload.action, "source-folder-sync");
  assert.equal(registered.job.options.idempotencyKey, `source-folder-sync:${registered.folder.id}:1`);

  const first = await service.consumeFolderSync(syncJob(registered.folder, registered.job));
  assert.equal(first.registered, 2, "both entries are new on the first pass");
  assert.equal(first.unchanged, 0);
  assert.equal(first.complete, true);
  assert.equal(first.continuedAs, null);
  assert.deepEqual(drive.calls.map(call => call.remotePath), ["/papers"], "only the registered folder is walked");
  const ingested = jobs.enqueued.filter(job => job.payload.action == null);
  assert.equal(ingested.length, 2, "each new entry gets exactly one ingest job");

  // A second run over the same bytes registers nothing and enqueues nothing.
  const afterFirst = await documents.get("user-one", "preferences", registered.folder.id);
  const second = await service.syncFolder("user-one", registered.folder.id, { expectedRevision: afterFirst.revision });
  const secondResult = await service.consumeFolderSync(syncJob(afterFirst, second.job));
  assert.equal(secondResult.unchanged, 2);
  assert.equal(secondResult.registered, 0);
  assert.equal(jobs.enqueued.filter(job => job.payload.action == null).length, 2, "an unchanged folder must not re-enqueue extraction");

  // One entry's provider hash changes: that file, and only that file, is re-registered.
  drive.pages = [[remoteFile("one.pdf", "1"), remoteFile("two.pdf", "9")]];
  const afterSecond = await documents.get("user-one", "preferences", registered.folder.id);
  const third = await service.syncFolder("user-one", registered.folder.id, { expectedRevision: afterSecond.revision });
  const thirdResult = await service.consumeFolderSync(syncJob(afterSecond, third.job));
  assert.equal(thirdResult.updated, 1);
  assert.equal(thirdResult.unchanged, 1);
  const family = await service.family("user-one", (await documents.get("user-one", "preferences", registered.folder.id)).payload.entries["/papers/two.pdf"].sourceId);
  assert.deepEqual(family.items.map(item => item.payload.version), [2, 1], "the changed file becomes version 2 of the same family");
});

test("a folder sync is bounded per run and resumes on a follow-up job", async () => {
  const { service, jobs, documents } = fixture();
  const page = Array.from({ length: 60 }, (_, index) => remoteFile(`paper-${index}.pdf`, String(index % 10)));
  const drive = new FakeOpenList([page.slice(0, 55), page.slice(55)]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const first = await service.consumeFolderSync(syncJob(registered.folder, registered.job));
  assert.equal(first.registered, 50, "one run registers at most fifty entries");
  assert.equal(first.complete, false);
  assert.equal(first.removalCheck, "partial", "a partial run claims nothing about what it did not read");
  assert.deepEqual(first.removedPaths, []);
  assert.ok(first.continuedAs, "an unfinished folder continues on a follow-up job");
  const follow = jobs.enqueued.find(job => job.id === first.continuedAs);
  assert.equal(follow.options.idempotencyKey, `source-folder-sync:${registered.folder.id}:2`);
  // The folder record and its continuation are one write. Enqueued afterwards,
  // a failed enqueue would leave a folder whose run has already advanced: the
  // retry reads a superseded run, succeeds, and nothing names the next page.
  assert.equal(follow.enqueuedInLease, true, "the continuation rides the transaction that advanced the run");

  const stored = await documents.get("user-one", "preferences", registered.folder.id);
  const second = await service.consumeFolderSync(syncJob(stored, follow));
  assert.equal(second.complete, true);
  assert.equal(second.unchanged, 50, "the finished half is recognised, not registered again");
  assert.equal(Object.keys((await documents.get("user-one", "preferences", registered.folder.id)).payload.entries).length, 60);
});

test("a folder sync records what it could not use and never fails the whole folder for one entry", async () => {
  const { service } = fixture();
  const drive = new FakeOpenList([[
    remoteFile("good.pdf", "a"),
    remoteFile("legacy.pdf", "b", { providerHash: `md5:${"c".repeat(32)}` }),
    { path: "/papers/sub", name: "sub", size: 0, mtime: null, entryType: "dir", providerHash: null },
  ]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const result = await service.consumeFolderSync(syncJob(registered.folder, registered.job));
  assert.equal(result.registered, 1);
  assert.equal(result.directories, 1, "sub-directories are counted, never walked");
  assert.deepEqual(result.skipped, [{ path: "/papers/legacy.pdf", reason: "provider_hash_unsupported" }]);
});

test("a completed pass reports files that disappeared without deleting their analysis", async () => {
  const { service, documents } = fixture();
  const drive = new FakeOpenList([[remoteFile("one.pdf", "1"), remoteFile("two.pdf", "2")]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  await service.consumeFolderSync(syncJob(registered.folder, registered.job));
  const removedSourceId = (await documents.get("user-one", "preferences", registered.folder.id)).payload.entries["/papers/two.pdf"].sourceId;

  drive.pages = [[remoteFile("one.pdf", "1")]];
  const stored = await documents.get("user-one", "preferences", registered.folder.id);
  const next = await service.syncFolder("user-one", registered.folder.id, { expectedRevision: stored.revision });
  const result = await service.consumeFolderSync(syncJob(stored, next.job));
  assert.equal(result.removalCheck, "full");
  assert.deepEqual(result.removedPaths, ["/papers/two.pdf"]);
  assert.equal(result.tracked, 1);
  assert.ok(await documents.get("user-one", "source", removedSourceId), "a vanished remote file keeps its registered analysis");
});

test("a paused folder is not walked and a superseded run is not repeated", async () => {
  const { service } = fixture();
  const drive = new FakeOpenList([[remoteFile("one.pdf", "1")]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const paused = await service.setFolderStatus("user-one", registered.folder.id, { expectedRevision: registered.folder.revision, status: "paused" });
  assert.equal(paused.job, null);
  const skipped = await service.consumeFolderSync(syncJob(registered.folder, registered.job));
  assert.equal(skipped.skippedRun, "folder_paused");
  assert.equal(drive.calls.length, 0, "a paused folder is never listed");

  const resumed = await service.setFolderStatus("user-one", registered.folder.id, { expectedRevision: paused.folder.revision, status: "active" });
  await service.consumeFolderSync(syncJob(resumed.folder, resumed.job));
  const stale = await service.consumeFolderSync(syncJob(resumed.folder, resumed.job));
  assert.equal(stale.skippedRun, "sync_superseded", "a finished run cannot be replayed");
  assert.equal(drive.calls.length, 1);
});

test("a folder resumed after a no-op run can still be synced, run after run", async () => {
  const documents = new MemoryDocuments();
  const jobs = new LedgerJobs();
  const service = new SourceService(documents, jobs, { extractorVersion: "evimed-analysis-1.0.0",
    now: () => new Date("2026-09-06T01:00:00.000Z") });
  const drive = new FakeOpenList([[remoteFile("one.pdf", "1")]]);
  service.useConnector("openlist", drive);

  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const paused = await service.setFolderStatus("user-one", registered.folder.id,
    { expectedRevision: registered.folder.revision, status: "paused" });

  // The worker claims the queued run while the folder is paused. It does no
  // work, and the run is retired `succeeded` all the same — which is exactly
  // what makes the key that named it unusable for every later sync.
  const noop = await jobs.claimFolderSync();
  assert.equal(noop.id, registered.job.id);
  assert.equal((await service.consumeFolderSync(noop)).skippedRun, "folder_paused");
  await jobs.finish(noop.userId, noop.id, noop.leaseToken, { skippedRun: "folder_paused" });
  assert.equal(drive.calls.length, 0);

  const resumed = await service.setFolderStatus("user-one", registered.folder.id,
    { expectedRevision: paused.folder.revision, status: "active" });
  assert.notEqual(resumed.job.id, noop.id, "resuming queues a run of its own, never the finished one");
  assert.equal(resumed.job.status, "queued");
  const asked = await service.syncFolder("user-one", registered.folder.id, { expectedRevision: resumed.folder.revision });
  assert.equal(asked.job.status, "queued", "and a manual sync request lands on a job that can still be claimed");

  const claimed = await jobs.claimFolderSync();
  assert.ok(claimed, "a folder that is active always has a sync run a worker can claim");
  const ran = await service.consumeFolderSync(claimed);
  assert.equal(ran.skippedRun, undefined, "the run the researcher asked for is neither paused nor superseded");
  assert.equal(ran.registered, 1);
  assert.equal(drive.calls.length, 1, "the folder was walked, not only reported as scheduled");

  // Re-registering a paused folder is the second way it becomes active, and it
  // has to mint a run for the same reason the first way does.
  const active = await service.getFolder("user-one", registered.folder.id);
  const queued = await service.syncFolder("user-one", active.id, { expectedRevision: active.revision });
  await service.setFolderStatus("user-one", active.id, { expectedRevision: active.revision, status: "paused" });
  const secondNoop = await jobs.claimFolderSync();
  assert.equal(secondNoop.id, queued.job.id);
  assert.equal((await service.consumeFolderSync(secondNoop)).skippedRun, "folder_paused");
  await jobs.finish(secondNoop.userId, secondNoop.id, secondNoop.leaseToken, { skippedRun: "folder_paused" });

  const reregistered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  assert.equal(reregistered.folder.payload.status, "active");
  assert.notEqual(reregistered.job.id, secondNoop.id, "re-registration resumes with a run of its own too");
  const lastClaim = await jobs.claimFolderSync();
  assert.ok(lastClaim, "a folder resumed by re-registration is claimable as well");
  assert.equal((await service.consumeFolderSync(lastClaim)).skippedRun, undefined);
  assert.equal(drive.calls.length, 2, "and the second walk happened");
});

test("a folder paused mid-walk resumes at the page it stopped on, under a new run", async () => {
  const { service, jobs, documents } = fixture();
  // Six pages of one entry each: one run reads five and leaves the sixth.
  const drive = new FakeOpenList(Array.from({ length: 6 }, (_, index) => [remoteFile(`paper-${index}.pdf`, String(index))]));
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const first = await service.consumeFolderSync(syncJob(registered.folder, registered.job));
  assert.equal(first.complete, false);
  assert.equal((await documents.get("user-one", "preferences", registered.folder.id)).payload.sync.page, 6);

  const stopped = await documents.get("user-one", "preferences", registered.folder.id);
  const paused = await service.setFolderStatus("user-one", stopped.id, { expectedRevision: stopped.revision, status: "paused" });
  const resumed = await service.setFolderStatus("user-one", stopped.id, { expectedRevision: paused.folder.revision, status: "active" });
  // Minting a run is what keeps the folder syncable; it must not also throw away
  // the walk, or a paused folder would re-read every page it had already read.
  assert.deepEqual(resumed.folder.payload.sync, { run: 3, page: 6 }, "a new run, the same page");
  assert.equal(resumed.job.payload.page, 6, "and the queued run is told where to start");
  assert.equal(resumed.job.options.idempotencyKey, `source-folder-sync:${stopped.id}:3`);
  const ran = await service.consumeFolderSync(syncJob(resumed.folder, resumed.job));
  assert.equal(ran.startPage, 6);
  assert.equal(ran.complete, true);
  assert.equal(jobs.enqueued.filter((job) => job.payload.action === "source-folder-sync").length, 3,
    "the register, the continuation and the resume — no run is queued twice");
});

test("a lost lease leaves the folder record untouched and its registrations replayable", async () => {
  const { service, jobs, documents } = fixture();
  const drive = new FakeOpenList([[remoteFile("one.pdf", "1"), remoteFile("two.pdf", "2")]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  jobs.leaseHeld = false;
  await assert.rejects(service.consumeFolderSync(syncJob(registered.folder, registered.job)), { code: "product_job_lease_lost" });
  assert.ok(jobs.leaseChecks > 0, "the sync must actually check its lease before writing");
  assert.equal((await documents.get("user-one", "preferences", registered.folder.id)).payload.lastSync, null,
    "the folder record is what the lease fences");
  // The lease does not fence the registrations, and claiming it did was false.
  // The entries the fenced run reached are already in the ledger with their
  // ingest jobs; this asserts that, so the real contract is written down.
  const written = jobs.enqueued.filter((job) => job.payload.action == null).map((job) => job.payload.sourceId);
  assert.equal(written.length, 2, "a lost lease still wrote the registrations it had already made");
  for (const sourceId of written) assert.ok(await documents.get("user-one", "source", sourceId));

  // That is safe only because the replay observes those same rows: a source id
  // is the digest of its project and content, and its ingest job is keyed by
  // source and generation, so nothing is registered or extracted twice.
  jobs.leaseHeld = true;
  const replay = await service.consumeFolderSync(syncJob(registered.folder, registered.job));
  assert.equal(replay.registered, 2, "the replay adopts the fenced attempt's sources");
  assert.deepEqual(jobs.enqueued.filter((job) => job.payload.action == null).map((job) => job.payload.sourceId), written,
    "and enqueues no second extraction for them");
});

test("one run reads at most five provider pages and asks for the page size it budgets for", async () => {
  const { service, documents } = fixture();
  // Six pages the folder already tracks: nothing is new, so the registration
  // budget can never be what stops this walk. Only the page cap can.
  const pages = Array.from({ length: 6 }, (_, page) => Array.from({ length: 3 },
    (_, index) => remoteFile(`page-${page}-${index}.pdf`, String(index))));
  const drive = new FakeOpenList(pages);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const entries = Object.fromEntries(pages.flat().map((entry, index) => [entry.path,
    { providerHash: entry.providerHash, sourceId: `src_${index}`, version: 1, size: entry.size }]));
  const primed = await documents.put("user-one", "preferences", registered.folder.id,
    { ...registered.folder.payload, entries }, { expectedRevision: registered.folder.revision, projectId: "project-one" });

  const result = await service.consumeFolderSync(syncJob(primed, registered.job));
  assert.deepEqual(drive.calls.map((call) => call.page), [1, 2, 3, 4, 5], "one lease makes at most five provider list calls");
  assert.deepEqual([...new Set(drive.calls.map((call) => call.perPage))], [100], "and asks for the page size the budgets assume");
  assert.equal(result.unchanged, 15);
  assert.equal(result.registered, 0);
  assert.equal(result.complete, false, "a folder longer than one run's page budget is not reported as fully read");
  assert.equal(result.endPage, 6);
  assert.ok(result.continuedAs, "the sixth page continues on a follow-up job");
});

test("a folder stops tracking at the entry cap, before its byte budget can bite", async () => {
  const { service, documents } = fixture();
  const tracked = {};
  const listed = [];
  for (let index = 0; index < 500; index += 1) {
    const entry = remoteFile(`${index}.pdf`, String(index % 10));
    tracked[entry.path] = { providerHash: entry.providerHash, sourceId: `src_${index}`, version: 1, size: entry.size };
    listed.push(entry);
  }
  assert.equal(Object.keys(tracked).length, 500, "the published per-folder entry cap");
  assert.ok(Buffer.byteLength(JSON.stringify(tracked)) < 95_000,
    "these names are short on purpose: the 100 KB byte budget must not be what stops this run");
  const drive = new FakeOpenList([[...listed, remoteFile("brand-new.pdf", "3")]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const primed = await documents.put("user-one", "preferences", registered.folder.id,
    { ...registered.folder.payload, entries: tracked }, { expectedRevision: registered.folder.revision, projectId: "project-one" });

  const result = await service.consumeFolderSync(syncJob(primed, registered.job));
  assert.equal(result.unchanged, 500);
  assert.equal(result.registered, 0, "a folder that already tracks its cap takes on no more entries");
  assert.deepEqual(result.skipped, [{ path: "/papers/brand-new.pdf", reason: "entry_budget_exhausted" }]);
  assert.equal(result.tracked, 500);
});

test("a storage failure fails the folder run instead of passing as one skipped file", async () => {
  const { service, documents } = fixture();
  const drive = new FakeOpenList([[remoteFile("one.pdf", "1"), remoteFile("two.pdf", "2")]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  service.register = async () => { throw new HttpError(503, "source_state_unavailable", "Source storage is temporarily unavailable."); };
  await assert.rejects(service.consumeFolderSync(syncJob(registered.folder, registered.job)),
    { code: "source_state_unavailable" }, "a 5xx is not the entry's fault and must not be swallowed into the skip list");
  assert.equal((await documents.get("user-one", "preferences", registered.folder.id)).payload.lastSync, null,
    "a run that hit a storage outage never records a finished pass");
});

test("the sync reports how many entries it skipped and lost, not how many it named", async () => {
  const { service, documents } = fixture();
  const unusable = Array.from({ length: 25 }, (_, index) =>
    remoteFile(`legacy-${index}.pdf`, "b", { providerHash: `md5:${"c".repeat(32)}` }));
  const drive = new FakeOpenList([unusable]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const vanished = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`/papers/gone-${index}.pdf`,
    { providerHash: `sha256:${"e".repeat(64)}`, sourceId: `src_gone_${index}`, version: 1, size: 2048 }]));
  const primed = await documents.put("user-one", "preferences", registered.folder.id,
    { ...registered.folder.payload, entries: vanished }, { expectedRevision: registered.folder.revision, projectId: "project-one" });

  const result = await service.consumeFolderSync(syncJob(primed, registered.job));
  assert.equal(result.skipped.length, 20, "the named examples stay bounded so the record stays writable");
  assert.equal(result.skippedCount, 25, "the count is the whole truth, and it is what the researcher is shown");
  assert.equal(result.removedPaths.length, 20);
  assert.equal(result.removedCount, 25, "the same for files that disappeared from the drive");
});

test("folder sync and status changes refuse a stale revision, and re-registering a paused folder resumes it", async () => {
  const { service, documents } = fixture();
  const drive = new FakeOpenList([[remoteFile("one.pdf", "1")]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const stale = registered.folder.revision - 1;
  await assert.rejects(service.syncFolder("user-one", registered.folder.id, { expectedRevision: stale }),
    { code: "source_folder_conflict" }, "a sync taken against a stale view of the folder is refused");
  await assert.rejects(service.setFolderStatus("user-one", registered.folder.id, { expectedRevision: stale, status: "paused" }),
    { code: "source_folder_conflict" });
  assert.equal((await documents.get("user-one", "preferences", registered.folder.id)).payload.status, "active",
    "a refused status change changed nothing");

  const paused = await service.setFolderStatus("user-one", registered.folder.id, { expectedRevision: registered.folder.revision, status: "paused" });
  assert.equal(paused.folder.payload.status, "paused");
  await assert.rejects(service.syncFolder("user-one", registered.folder.id, { expectedRevision: paused.folder.revision }),
    { code: "source_folder_conflict" }, "a paused folder has no sync to run");

  const again = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  assert.equal(again.created, false);
  assert.equal(again.folder.payload.status, "active", "registering a paused folder again resumes it");
  assert.ok(again.job, "and queues a run");
  const resumed = await service.consumeFolderSync(syncJob(again.folder, again.job));
  assert.equal(resumed.skippedRun, undefined, "a run queued by re-registration must not be skipped as paused");
  assert.equal(resumed.registered, 1);
});

test("a duplicate scan reads at most five source pages and says when it stopped early", async () => {
  const { service, documents } = fixture();
  const cursors = [];
  const inner = documents.list.bind(documents);
  documents.list = async (userId, kind, options = {}) => {
    if (kind !== "source") return inner(userId, kind, options);
    cursors.push(options.cursor ?? null);
    return { items: [], nextCursor: `page-${cursors.length + 1}` };
  };
  const result = await service.duplicateCandidates("user-one", { projectId: "project-one" });
  assert.deepEqual(cursors, [null, "page-2", "page-3", "page-4", "page-5"],
    "five pages, each resuming from the cursor the last one returned");
  assert.equal(result.truncated, true, "a scan that stopped early says so instead of implying it saw everything");
});

test("a similar-name group is keyed by its members, so another path cannot reopen a decision", async () => {
  const { service } = fixture();
  const mine = await service.register("user-one", upload());
  const other = await service.register("user-one", upload({ path: "archive/我的研究方案.docx", sha256: "b".repeat(64) }));
  const before = (await service.duplicateCandidates("user-one", { projectId: "project-one" }))
    .items.find((group) => group.kind === "similar-name");
  assert.deepEqual(before.sourceIds.sort(), [mine.source.id, other.source.id].sort());
  await service.decideDuplicate("user-one", { projectId: "project-one", groupKey: before.groupKey,
    sourceIds: before.sourceIds, decision: "dismissed" });

  // A second, alphabetically earlier path for the same bytes used to rewrite the
  // name the group was keyed by, which silently reopened the dismissal.
  await service.register("user-one", upload({ path: "archive/AAA 备份.docx", sha256: "b".repeat(64) }));
  const after = (await service.duplicateCandidates("user-one", { projectId: "project-one" }))
    .items.filter((group) => group.kind === "similar-name");
  assert.equal(after.length, 1, "the same two sources are one group, offered once");
  assert.equal(after[0].groupKey, before.groupKey, "and keep the identity the decision was taken against");
  assert.equal(after[0].decision.decision, "dismissed");
});


test("a folder sync cut against one account generation refuses to run against another", async () => {
  const { service, documents } = fixture();
  // The fence needs an account row to read, so give the in-memory store the one
  // query it makes. Deleting and recreating an account reuses the user id; the
  // generation is what tells a queued job that its owner is gone.
  const account = { generation: "2026-09-06T00:00:00.000Z" };
  documents.database = { query: async () => ({ rows: [{ generation: account.generation }] }) };
  const drive = new FakeOpenList([[remoteFile("one.pdf", "1")]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  assert.equal(registered.job.payload.accountCreatedAt, "2026-09-06T00:00:00.000Z", "the job is cut against the generation it saw");

  account.generation = "2026-09-07T00:00:00.000Z";
  await assert.rejects(service.consumeFolderSync(syncJob(registered.folder, registered.job)), { code: "source_account_changed" });
  assert.equal(drive.calls.length, 0, "a fenced run never reaches the provider");
  assert.equal((await documents.get("user-one", "preferences", registered.folder.id)).payload.lastSync, null);
});

test("two names over the same two sources are one group, not the same decision asked twice", async () => {
  const { service } = fixture();
  // Both sources carry both names. Keyed by a name, this is two groups with two
  // identities over one member set, so dismissing one leaves the other open.
  const mine = await service.register("user-one", upload());
  await service.register("user-one", upload({ path: "archive/共同名字.docx" }));
  const other = await service.register("user-one", upload({ path: "archive/我的研究方案.docx", sha256: "b".repeat(64) }));
  await service.register("user-one", upload({ path: "backup/共同名字.docx", sha256: "b".repeat(64) }));
  const groups = (await service.duplicateCandidates("user-one", { projectId: "project-one" }))
    .items.filter((group) => group.kind === "similar-name");
  assert.equal(groups.length, 1, "one member set is offered once, however many names it shares");
  assert.deepEqual(groups[0].sourceIds.slice().sort(), [mine.source.id, other.source.id].sort());

  await service.decideDuplicate("user-one", { projectId: "project-one", groupKey: groups[0].groupKey,
    sourceIds: groups[0].sourceIds, decision: "linked" });
  const after = (await service.duplicateCandidates("user-one", { projectId: "project-one" }))
    .items.filter((group) => group.kind === "similar-name");
  assert.equal(after.length, 1);
  assert.equal(after[0].decision.decision, "linked", "and one decision settles it");
});

test("a folder sync refuses a connector the deployment never configured", async () => {
  const { service } = fixture();
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  await assert.rejects(service.consumeFolderSync(syncJob(registered.folder, registered.job)),
    { code: "source_folder_connector_unavailable" });
});

test("the version chain reads back the family every source has been writing", async () => {
  const { service } = fixture();
  const first = await service.register("user-one", upload());
  const second = await service.register("user-one", upload({ sha256: "b".repeat(64) }));
  const other = await service.register("user-one", upload({ path: "knowledge-base/其他.docx", sha256: "c".repeat(64) }));
  const chain = await service.family("user-one", first.source.id);
  assert.equal(chain.familyId, first.source.payload.familyId);
  assert.equal(chain.currentVersion, 1);
  assert.deepEqual(chain.items.map(item => item.id), [second.source.id, first.source.id], "newest version first");
  assert.equal(chain.items.some(item => item.id === other.source.id), false, "another path is another family");
  const filtered = await service.list("user-one", { projectId: "project-one", familyId: first.source.payload.familyId });
  assert.deepEqual(filtered.items.map(item => item.id).sort(), [first.source.id, second.source.id].sort());
});

test("duplicate candidates are deterministic groups a researcher can link or dismiss", async () => {
  const { service } = fixture();
  const v1 = await service.register("user-one", upload());
  const v2 = await service.register("user-one", upload({ sha256: "b".repeat(64) }));
  await service.register("user-one", upload({ path: "knowledge-base/我的研究方案 (1).docx", sha256: "d".repeat(64) }));
  await service.register("user-one", upload({ path: "knowledge-base/copy.docx", sha256: "b".repeat(64) }));

  const first = await service.duplicateCandidates("user-one", { projectId: "project-one" });
  const kinds = first.items.map(group => group.kind);
  assert.ok(kinds.includes("version-family"), "two versions of one path are a candidate");
  assert.ok(kinds.includes("similar-name"), "the same normalised name in another family is a candidate");
  assert.ok(kinds.includes("shared-content"), "identical bytes under two paths are a candidate");
  const versions = first.items.find(group => group.kind === "version-family");
  assert.deepEqual(versions.sourceIds.sort(), [v1.source.id, v2.source.id].sort());
  assert.equal(versions.decision, null);

  await service.decideDuplicate("user-one", { projectId: "project-one", groupKey: versions.groupKey,
    sourceIds: versions.sourceIds, decision: "dismissed" });
  const decided = await service.duplicateCandidates("user-one", { projectId: "project-one" });
  assert.equal(decided.items.find(group => group.groupKey === versions.groupKey).decision.decision, "dismissed");

  // A new version is new information: the dismissal no longer covers the group.
  await service.register("user-one", upload({ sha256: "e".repeat(64) }));
  const reopened = await service.duplicateCandidates("user-one", { projectId: "project-one" });
  assert.equal(reopened.items.find(group => group.groupKey === versions.groupKey).decision, null);
});

test("a dismissal is honoured however many other decisions the project has taken", async () => {
  const { service, documents } = fixture();
  const listed = [];
  const inner = documents.list.bind(documents);
  documents.list = async (userId, kind, options = {}) => {
    listed.push(kind);
    if (kind !== "preferences") return inner(userId, kind, options);
    // Production reads preferences `ORDER BY created_at DESC,id DESC`, so a
    // fixed window holds the newest decisions and the oldest fall out of it.
    const limit = options.limit ?? 50;
    const rows = (await inner(userId, kind, { ...options, limit: Number.MAX_SAFE_INTEGER })).items.reverse();
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? "next" : null };
  };

  const mine = await service.register("user-one", upload());
  const mineV2 = await service.register("user-one", upload({ sha256: "b".repeat(64) }));
  await service.register("user-one", upload({ path: "knowledge-base/其他.docx", sha256: "c".repeat(64) }));
  await service.register("user-one", upload({ path: "knowledge-base/其他.docx", sha256: "d".repeat(64) }));
  const groups = (await service.duplicateCandidates("user-one", { projectId: "project-one" })).items;
  assert.equal(groups.length, 2, "two families, each with two versions, are two candidate groups");
  const dismissed = groups.find((group) => group.sourceIds.includes(mine.source.id));
  assert.deepEqual(dismissed.sourceIds.slice().sort(), [mine.source.id, mineV2.source.id].sort());
  await service.decideDuplicate("user-one", { projectId: "project-one", groupKey: dismissed.groupKey,
    sourceIds: dismissed.sourceIds, decision: "dismissed" });

  // A desk that has been in use has more decisions than any one page holds, and
  // the ones outside the window are the oldest — settled longest ago, and the
  // least deserving of being asked again.
  for (let index = 0; index < 120; index += 1) {
    const key = createHash("sha256").update(`filler-${index}`).digest("hex").slice(0, 32);
    await documents.put("user-one", "preferences", `srcdup_${key}`, { recordType: "source-duplicate-decision",
      schemaVersion: 1, groupKey: `version-family:${key}`, kind: "version-family", sourceIds: [`src_${key}`],
      decision: "dismissed", note: "", at: "2026-09-07T00:00:00.000Z" }, { expectedRevision: 0, projectId: "project-one" });
  }

  listed.length = 0;
  const after = await service.duplicateCandidates("user-one", { projectId: "project-one" });
  assert.equal(after.items.length, 2);
  assert.equal(after.items.find((group) => group.groupKey === dismissed.groupKey)?.decision?.decision, "dismissed",
    "a decision the researcher took is not forgotten because later ones were taken");
  assert.equal(after.items[0].decision, null, "the undecided group is the one at the top of the desk");
  assert.notEqual(after.items[0].groupKey, dismissed.groupKey);
  assert.equal(listed.filter((kind) => kind === "preferences").length, 0,
    "decisions are looked up by the keys the scan computed, never paged as a set");
});

test("a duplicate decision cannot name a source from another project", async () => {
  const { service } = fixture();
  const mine = await service.register("user-one", upload());
  const other = await service.register("user-one", upload({ projectId: "project-two", sha256: "f".repeat(64) }));
  await assert.rejects(service.decideDuplicate("user-one", { projectId: "project-one",
    groupKey: `version-family:${"a".repeat(32)}`, sourceIds: [mine.source.id, other.source.id], decision: "linked" }),
  { code: "source_scope_conflict" });
  await assert.rejects(service.decideDuplicate("user-one", { projectId: "project-one",
    groupKey: "made-up:zzz", sourceIds: [mine.source.id], decision: "linked" }), { code: "source_duplicate_invalid" });
  await assert.rejects(service.decideDuplicate("user-one", { projectId: "project-one",
    groupKey: `version-family:${"a".repeat(32)}`, sourceIds: [mine.source.id], decision: "merge" }), { code: "source_duplicate_invalid" });
});

test("a folder stops tracking new entries before its own record becomes unwritable", async () => {
  const { service, documents } = fixture();
  const drive = new FakeOpenList([[]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  // Fill the folder's remembered entries to just under the byte budget, then
  // offer it one more file. The budget is what keeps the 256 KiB product record
  // writable, so exceeding it must skip an entry, not fail the folder forever.
  const seeded = {};
  const seededEntries = [];
  let index = 0;
  while (Buffer.byteLength(JSON.stringify(seeded)) < 99_900) {
    const name = `${String(index).padStart(4, "0")}-${"n".repeat(100)}.pdf`;
    const entry = remoteFile(name, "7");
    seeded[entry.path] = { providerHash: entry.providerHash, sourceId: `src_${String(index).padStart(32, "0")}`, version: 1, size: entry.size };
    seededEntries.push(entry);
    index += 1;
  }
  const stored = await documents.get("user-one", "preferences", registered.folder.id);
  const primed = await documents.put("user-one", "preferences", registered.folder.id, { ...stored.payload, entries: seeded },
    { expectedRevision: stored.revision, projectId: "project-one" });
  drive.pages = [[...seededEntries, remoteFile("brand-new.pdf", "3")]];

  const result = await service.consumeFolderSync(syncJob(primed, registered.job));
  assert.equal(result.unchanged, seededEntries.length, "everything already tracked is recognised, not re-registered");
  assert.equal(result.registered, 0, "the one new file does not fit the folder's budget");
  assert.deepEqual(result.skipped, [{ path: "/papers/brand-new.pdf", reason: "entry_budget_exhausted" }]);
  assert.deepEqual(result.removedPaths, [], "nothing was removed; the folder still lists all of it");
  const after = await documents.get("user-one", "preferences", registered.folder.id);
  assert.ok(Buffer.byteLength(JSON.stringify(after.payload)) < 262_144, "the folder record stays inside the product-document limit");
});

test("one entry the ledger refuses is recorded and the rest of the folder still syncs", async () => {
  const { service } = fixture();
  // A remote path longer than the manifest's connector-id limit is a 400 from
  // register. The folder must record it and carry on, not stop on it.
  const drive = new FakeOpenList([[remoteFile(`${"long-name-".repeat(20)}.pdf`, "9"), remoteFile("fine.pdf", "4")]]);
  service.useConnector("openlist", drive);
  const registered = await service.registerFolder("user-one", { projectId: "project-one", path: "/papers" });
  const result = await service.consumeFolderSync(syncJob(registered.folder, registered.job));
  assert.equal(result.registered, 1, "the usable file is still registered");
  assert.deepEqual(result.skipped, [{ path: `/papers/${"long-name-".repeat(20)}.pdf`, reason: "source_payload_invalid" }]);
  assert.equal(result.complete, true);
});

// --- what a delivered omission audit contributes to the source row -----------
//
// `publishUnderstanding` writes inside a real transaction, so its durable half
// is Postgres-gated. The decision it makes about the audit is a pure function,
// and it is the decision the understanding contract's hand-off names: keep what
// the run delivered, measure it against the frozen capture rather than trusting
// the run's arithmetic, state the measured rate on the source, and let none of
// it refuse a delivery. These cases run on every push.

/** Ten quotable units, the shape a real capture has. */
function auditCapture(sourceId = "src_fix", generation = 4, depth = "structured") {
  const text = Array.from({ length: 10 }, (_, index) => `unit${index + 1} body `.padEnd(8000, ".")).join("");
  return normalizeSourceText({ sourceId, generation, docType: "note-memo", depth, text });
}

/** An output whose claims anchor exactly the named units, carrying the audit a
 * run would deliver for them.
 * @param {any} input @param {string[]} anchoredUnitIds @param {any} auditOverrides */
function auditedDelivery(input, anchoredUnitIds, auditOverrides = {}) {
  const plan = sourceUnderstandingAuditSample(input);
  const anchored = new Set(anchoredUnitIds);
  const anchorFor = (unitId) => {
    const index = input.units.findIndex((unit) => unit.id === unitId);
    const unit = input.units[index];
    const quote = `unit${index + 1} body`;
    return { sourceId: input.sourceId, generation: input.generation, unitId, start: unit.start, end: unit.start + quote.length, quote };
  };
  return { plan, output: {
    schemaVersion: 1, sourceId: input.sourceId, generation: input.generation, docType: input.docType, depth: input.depth,
    summary: "A fixture source.",
    slots: Object.fromEntries(sourceUnderstandingSchema(input.docType).slots.map((key) => [key, { state: "unknown", reason: "Not stated in the source." }])),
    claims: anchoredUnitIds.map((unitId, index) => ({ id: `c${index}`, statement: `Anchored in ${unitId}.`, evidence: [anchorFor(unitId)] })),
    methods: [],
    omissionAudit: { status: "audited", reason: "Sampled units were checked.",
      omissionRate: Number((plan.filter((unitId) => !anchored.has(unitId)).length / plan.length).toFixed(4)),
      samples: plan.map((unitId) => (anchored.has(unitId) ? { unitId, represented: true }
        : { unitId, represented: false, note: "No claim or slot reaches this unit." })), ...auditOverrides } } };
}

test("a delivered omission audit reaches the source row with the rate the control plane measured", () => {
  const input = auditCapture();
  const { plan, output } = auditedDelivery(input, ["src_fix:g4:u8"]);
  assert.equal(plan.length, 2, "two of ten units are sampled");
  const record = sourceOmissionRecord(projectSourceUnderstandingOutput(output, input), output, input);
  assert.equal(record.audit.status, "audited", "a delivered verdict is kept, not overwritten with 'not run'");
  assert.equal(record.audit.omissionRate, 0.5, "one of the two sampled units is unrepresented");
  assert.equal(record.omissionRate, 0.5, "and that is the number the source card states");
  assert.deepEqual(record.audit.samples.map((sample) => sample.represented), [true, false]);
  assert.equal(record.notice.status, "audited");
  assert.equal(record.notice.planned, 2);
  assert.equal(record.notice.audited, 2);
  assert.equal(record.notice.target, 0.15);
  assert.equal(record.notice.withinTarget, false, "0.5 is over the structured target, and is recorded as such");
  assert.deepEqual(record.notice.disagreements, [], "the run and the control plane agree here");
});

test("an omission audit that contradicts its own output is a metric, never a refusal", () => {
  const input = auditCapture();
  // The run reports a perfect audit; its anchors reach one of the two sampled
  // units. Nothing here may throw, and the source must carry the measured rate.
  const { output } = auditedDelivery(input, ["src_fix:g4:u8"], { omissionRate: 0, samples: [
    { unitId: "src_fix:g4:u8", represented: true }, { unitId: "src_fix:g4:u9", represented: true }] });
  const record = sourceOmissionRecord(projectSourceUnderstandingOutput(output, input), output, input);
  assert.equal(record.omissionRate, 0.5, "the control plane's own reading is what the source states");
  assert.equal(record.notice.reportedRate, 0, "the run's self-report is kept beside it, not confused with it");
  assert.ok(record.notice.disagreements.length >= 1, "the disagreement is recorded");
  assert.ok(record.notice.disagreements.every((line) => line.length <= 300), "and bounded, because a source page reads it back");
  assert.equal(record.notice.blocking, undefined, "the source row keeps a metric, not a verdict to act on");
  // The delivery itself is still valid: this whole record exists to measure a
  // package, not to refuse one.
  assert.deepEqual(validateSourceUnderstanding(output, input), []);
});

test("an unaudited or absent understanding states that instead of inventing a rate", () => {
  const input = auditCapture();
  const { output } = auditedDelivery(input, ["src_fix:g4:u8"]);
  const notRun = { ...output, omissionAudit: { status: "not_run", reason: "Question audit did not run.", omissionRate: null } };
  const unaudited = sourceOmissionRecord(projectSourceUnderstandingOutput(notRun, input), notRun, input);
  assert.equal(unaudited.audit.status, "not_run");
  assert.equal(unaudited.omissionRate, null, "an audit that did not run is not an omission rate of zero");
  assert.equal(unaudited.notice.status, "not_run");
  const skipped = sourceOmissionRecord(null, null, null);
  assert.equal(skipped.audit.status, "not_run");
  assert.equal(skipped.omissionRate, null);
  assert.equal(skipped.notice, null, "a source with no understanding has nothing to measure");
});

test("a run recovered from a stored capture is handed the same sample plan as a fresh parse", async () => {
  // Every retry and every process restart reads the capture back instead of
  // reparsing. Without the plan the recovered run has nothing to audit and
  // correctly delivers `not_run`, so the audit would never survive one retry.
  const { service } = fixture();
  const fresh = auditCapture("src_recovered", 2);
  const source = { id: "src_recovered", projectId: "project-one", revision: 4, payload: {
    docType: fresh.docType, depth: fresh.depth, generation: 2,
    analysis: { generation: 2, unitCount: fresh.units.length, extractor: { name: "mineru", version: "3.4.5", parser: "mineru" },
      summary: "A fixture source.", parserCoverage: null,
      textSha256: createHash("sha256").update(fresh.text).digest("hex") } } };
  const client = { query: async () => ({ rows: fresh.units.map((unit) => ({ payload: { unit } })) }) };

  const recovered = await service.loadCapture("user-one", source, client);
  assert.deepEqual(recovered.input.auditSample, sourceUnderstandingAuditSample(fresh),
    "the recovered input names the same units the fresh capture would have audited");
  assert.deepEqual(recovered.input.auditSample, fresh.auditSample);
  assert.equal(recovered.input.auditSample.length, 2);
});

test("the source card carries the audit verdict without the units it sampled", () => {
  const input = auditCapture();
  const { output } = auditedDelivery(input, ["src_fix:g4:u8"]);
  const record = sourceOmissionRecord(projectSourceUnderstandingOutput(output, input), output, input);
  const card = projectSourceManifestRecord({ id: "src_one", revision: 2, payload: {
    paths: ["knowledge-base/note.md"], status: "complete", omissionAudit: record.audit, outputs: { summary: "s" } } });
  assert.deepEqual(card.payload.omissionAudit, { status: "audited", reason: "Sampled units were checked.", omissionRate: 0.5 });
  assert.equal(card.payload.omissionAudit.samples, undefined,
    "fifty cards on one page must not each carry a sample list to state one verdict");
});
