import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_DEPTHS, SOURCE_TYPES, SourceService } from "../src/sourceService.mjs";

class MemoryDocuments {
  constructor() { this.rows = new Map(); }
  key(userId, kind, id) { return `${userId}:${kind}:${id}`; }
  async get(userId, kind, id) { return this.rows.get(this.key(userId, kind, id)) ?? null; }
  async list(userId, kind, { projectId, filter = {} } = {}) {
    const items = [...this.rows.values()].filter((row) => row.userId === userId && row.kind === kind
      && (projectId === undefined || row.projectId === projectId)
      && Object.entries(filter).every(([key, value]) => row.payload[key] === value));
    return { items, nextCursor: null };
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
  constructor() { this.enqueued = []; }
  async enqueue(userId, kind, payload, options) {
    const existing = this.enqueued.find((job) => job.userId === userId && job.options.idempotencyKey === options.idempotencyKey);
    if (existing) return existing;
    const job = { id: `job-${this.enqueued.length + 1}`, userId, kind, payload, options, status: "queued" };
    this.enqueued.push(job);
    return job;
  }
}

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

test("coverage accounts for every source unit and deep omissions require attention", async () => {
  const { service } = fixture();
  const { source } = await service.register("user-one", upload());
  const units = Array.from({ length: 20 }, (_, index) => ({
    id: `page-${index + 1}`,
    unitType: "page",
    status: index === 0 ? "failed" : "extracted",
    itemIds: index === 0 ? [] : [`claim-${index + 1}`],
  }));
  const reviewed = await service.recordExtraction("user-one", source.id, {
    expectedRevision: source.revision,
    extractor: { name: "mineru", version: "3.4.5", parser: "mineru" },
    units,
    summary: "A protocol about a randomized clinical study.",
    facts: 9,
    methods: 2,
  });
  assert.equal(reviewed.payload.coverage.total, 20);
  assert.equal(reviewed.payload.coverage.accounted, 20);
  assert.equal(reviewed.payload.coverage.percent, 100);
  assert.equal(reviewed.payload.coverage.omissionRate, 0.05);
  assert.equal(reviewed.payload.status, "complete");

  const incomplete = await service.recordExtraction("user-one", source.id, {
    expectedRevision: reviewed.revision,
    extractor: { name: "mineru", version: "3.4.5", parser: "mineru" },
    units: units.map((unit, index) => index < 2 ? { ...unit, status: "failed", itemIds: [] } : unit),
    summary: "A protocol about a randomized clinical study.",
    facts: 8,
    methods: 2,
  });
  assert.equal(incomplete.payload.coverage.omissionRate, 0.1);
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
  assert.match(jobs.enqueued[1].options.idempotencyKey, /override/);
});

test("a disappeared upstream source retains its derived understanding", async () => {
  const { service } = fixture();
  const { source } = await service.register("user-one", upload());
  const complete = await service.recordExtraction("user-one", source.id, {
    expectedRevision: source.revision,
    extractor: { name: "plain-text", version: "1.0.0", parser: "fallback" },
    units: [{ id: "chunk-1", unitType: "chunk", status: "extracted", itemIds: ["fact-1"] }],
    summary: "Preserved derived summary.", facts: 1, methods: 0,
  });
  const missing = await service.markMissing("user-one", source.id, { expectedRevision: complete.revision });
  assert.equal(missing.payload.status, "missing");
  assert.equal(missing.payload.outputs.summary, "Preserved derived summary.");
  assert.ok(missing.payload.missingAt);
});

test("cancel, retry and delete preserve explicit lifecycle and idempotent work", async () => {
  const { service, jobs } = fixture();
  const { source } = await service.register("user-one", upload());
  const canceled = await service.cancel("user-one", source.id, { expectedRevision: source.revision });
  assert.equal(canceled.payload.status, "canceled");

  const retried = await service.retry("user-one", source.id, { expectedRevision: canceled.revision });
  assert.equal(retried.payload.status, "queued");
  assert.equal(jobs.enqueued.at(-1).options.rearmFailed, true);

  const removed = await service.remove("user-one", source.id, { expectedRevision: retried.revision });
  assert.ok(removed.deletedAt);
  assert.equal(jobs.enqueued.at(-1).kind, "consolidate");
  assert.equal(jobs.enqueued.at(-1).payload.action, "source-delete");
});
