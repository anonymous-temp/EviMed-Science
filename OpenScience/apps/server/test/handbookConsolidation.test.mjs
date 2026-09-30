import assert from "node:assert/strict";
import test from "node:test";
import { MethodConsolidation } from "../src/methodConsolidation.mjs";

test("optimize consumes the owner-scoped handbook instead of successfully leaving it on a shelf", async () => {
  let consumed = null;
  const handbookConsolidation = { async run(request) { consumed = request; return { action: "optimize", disposition: "applied", verification: "unmeasured" }; } };
  const consolidation = new MethodConsolidation({ learning: {}, dispatch: async () => {}, readResult: async () => {}, handbookConsolidation });
  const job = { id: "job", userId: "alice", payload: { action: "optimize", capabilityId: "geo-content", candidateId: "candidate", candidateDigest: "digest" } };
  const result = await consolidation.run({ job });
  assert.equal(result.disposition, "applied");
  assert.deepEqual(consumed, { job });
  assert.equal(result.verification, "unmeasured");
});

import { HandbookConsolidation } from "../src/handbookConsolidation.mjs";
import { fixture, registry } from "./helpers/handbookFixture.mjs";

test("reviewed candidates enqueue idempotently, apply unmeasured, and never enter personal methods", async () => {
  const f = fixture();
  const candidate = await f.learning.recordHandbookCandidate("alice", f.input());
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].payload.candidateDigest, candidate.payload.contentDigest);
  const loop = new HandbookConsolidation({ ...f, registry });
  const result = await loop.run({ job: f.queued[0] });
  assert.equal(result.disposition, "applied");
  assert.equal(result.verification, "unmeasured");
  const applied = await f.documents.get("alice", "method", result.handbookId);
  assert.equal(applied.payload.body, candidate.payload.body);
  assert.equal(applied.payload.capabilityId, "geo-content");
  assert.equal(applied.payload.source.candidateDigest, candidate.payload.contentDigest);
  assert.deepEqual(await f.learning.approvedMethods("alice"), []);
  assert.deepEqual((await f.learning.listMethods("alice")).items, []);
  const replay = await loop.run({ job: f.queued[0] });
  assert.equal(replay.handbookId, applied.id);
  assert.equal((await f.documents.get("alice", "method", applied.id)).revision, applied.revision);
  await f.learning.recordHandbookCandidate("alice", f.input());
  assert.equal(f.queued.length, 1);
});

test("a rejected or malformed evaluated revision preserves the previously applied bytes", async () => {
  const f = fixture();
  await f.learning.recordHandbookCandidate("alice", f.input());
  const loop = new HandbookConsolidation({ ...f, registry });
  const first = await loop.run({ job: f.queued[0] });
  const previous = await f.documents.get("alice", "method", first.handbookId);
  await f.learning.recordHandbookCandidate("alice", f.input({ body: `${previous.payload.body}\nChanged.` }));
  loop.evaluate = async (request) => ({ ...request.binding, verdict: "worse", report: "reports/paired.json" });
  const rejected = await loop.run({ job: f.queued[1] });
  assert.equal(rejected.disposition, "rejected");
  assert.equal((await f.documents.get("alice", "method", first.handbookId)).revision, previous.revision);
  await f.learning.recordHandbookCandidate("alice", f.input({ body: `${previous.payload.body}\nChanged again.` }));
  loop.evaluate = async () => ({ verdict: "better", report: "reports/forged.json" });
  const malformed = await loop.run({ job: f.queued[2] });
  assert.equal(malformed.disposition, "failed");
  assert.equal(malformed.reason, "handbook_evaluation_binding_invalid");
  assert.equal((await f.documents.get("alice", "method", first.handbookId)).payload.body, previous.payload.body);
});

test("changed candidates, foreign owners and model-invented capabilities cannot apply", async () => {
  const f = fixture();
  const first = await f.learning.recordHandbookCandidate("alice", f.input());
  await f.learning.recordHandbookCandidate("alice", f.input({ body: `${first.payload.body}\nNew version.` }));
  const loop = new HandbookConsolidation({ ...f, registry });
  assert.equal((await loop.run({ job: f.queued[0] })).disposition, "stale");
  await assert.rejects(loop.run({ job: { ...f.queued[1], userId: "bob" } }), { code: "handbook_candidate_unavailable" });
  const wrong = await f.learning.recordHandbookCandidate("alice", f.input({ capabilityId: "meta-analysis" }));
  assert.notEqual(wrong.id, first.id, "same method name in two capabilities has separate history");
  const result = await loop.run({ job: f.queued[2] });
  assert.equal(result.reason, "handbook_source_capability_mismatch");
  assert.equal(result.disposition, "failed");
});

test("pause, missing source and lost lease leave no effective supplement", async () => {
  const f = fixture();
  await f.learning.recordHandbookCandidate("alice", f.input());
  const loop = new HandbookConsolidation({ ...f, registry, enabled: () => false });
  await assert.rejects(loop.run({ job: f.queued[0] }), { code: "learning_paused" });
  loop.enabled = () => true;
  await assert.rejects(loop.run({ job: { ...f.queued[0], leaseToken: "lost" } }), { code: "product_job_lease_lost" });
  loop.resolveSourceRun = async () => null;
  assert.equal((await loop.run({ job: f.queued[0] })).reason, "handbook_source_unavailable");
  assert.equal((await f.documents.list("alice", "method", { filter: { recordType: "capability-handbook" } })).items.length, 0);
});

test("a bounded backlog scan queues old candidates once and records exhausted jobs", async () => {
  const f = fixture();
  f.learning.jobs = null;
  const old = await f.learning.recordHandbookCandidate("alice", f.input());
  f.learning.jobs = f.jobs;
  const loop = new HandbookConsolidation({ ...f, registry });
  await loop.reconcile("alice", { limit: 1 });
  await loop.reconcile("alice", { limit: 1 });
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].payload.candidateId, old.id);
});

test("a CAS rollback restores prior handbook bytes without inheriting another version's outcome evidence", async () => {
  const f = fixture();
  await f.learning.recordHandbookCandidate("alice", f.input());
  const loop = new HandbookConsolidation({ ...f, registry });
  const first = await loop.run({ job: f.queued[0] });
  const before = await f.documents.get("alice", "method", first.handbookId);
  await f.learning.recordHandbookCandidate("alice", f.input({ body: `${before.payload.body}\nA revision to undo.` }));
  await loop.run({ job: f.queued[1] });
  const current = await f.documents.get("alice", "method", first.handbookId);
  const restored = await loop.rollback("alice", current.id, { expectedRevision: current.revision, targetRevision: before.revision });
  assert.equal(restored.payload.body, before.payload.body);
  assert.equal(restored.payload.version, 3);
  assert.equal(restored.payload.verification, "unmeasured");
  assert.deepEqual(restored.payload.observations, []);
  await assert.rejects(loop.rollback("bob", current.id, { expectedRevision: restored.revision, targetRevision: before.revision }), { code: "handbook_unavailable" });
});

test("a baseline changed during evaluation gets one fresh digest-bound retry", async () => {
  const f = fixture(); await f.learning.recordHandbookCandidate("alice", f.input());
  const loop = new HandbookConsolidation({ ...f, registry });
  const first = await loop.run({ job: f.queued[0] });
  await f.learning.recordHandbookCandidate("alice", f.input({ body: `${f.input().body}\nNew candidate.` }));
  loop.evaluate = async ({ binding }) => {
    const current = await f.documents.get("alice", "method", first.handbookId);
    await f.documents.put("alice", "method", current.id, current.payload, { expectedRevision: current.revision, telemetry: true });
    return { ...binding, verdict: "better", report: "reports/mock.json" };
  };
  assert.equal((await loop.run({ job: f.queued[1] })).disposition, "stale");
  assert.equal(f.queued.length, 3);
  assert.equal(f.queued[2].payload.retryOf, f.queued[1].id);
  assert.equal((await loop.run({ job: f.queued[2] })).disposition, "stale");
  assert.equal(f.queued.length, 3, "one bounded retry, never an autonomous paid loop");
});

test("legacy candidates missing target metadata derive it from the stored source and do not remain queued forever", async () => {
  const f = fixture(); f.learning.jobs = null;
  const old = await f.learning.recordHandbookCandidate("alice", f.input({ capabilityId: null }));
  const { candidateRevision: _revision, dispositions: _dispositions, ...payload } = old.payload;
  await f.documents.put("alice", "method", old.id, payload, { expectedRevision: old.revision });
  f.learning.jobs = f.jobs;
  const loop = new HandbookConsolidation({ ...f, registry });
  await loop.reconcile("alice");
  assert.equal(f.queued.length, 1);
  const result = await loop.run({ job: f.queued[0] });
  assert.equal(result.disposition, "applied");
  assert.equal(result.capabilityId, "geo-content");
  await loop.reconcile("alice");
  assert.equal(f.queued.length, 1);
});

test("an explicitly configured evaluation records its actual in-progress state", async () => {
  const f = fixture(); const candidate = await f.learning.recordHandbookCandidate("alice", f.input());
  const loop = new HandbookConsolidation({ ...f, registry, evaluate: async ({ binding }) => {
    const during = await f.documents.get("alice", "method", candidate.id);
    assert.equal(during.payload.dispositions[candidate.payload.contentDigest].disposition, "evaluating");
    return { ...binding, verdict: "non_inferior", report: "reports/measured.json" };
  } });
  const result = await loop.run({ job: f.queued[0] });
  assert.equal(result.verification, "evaluated");
  assert.equal(result.evaluation.verdict, "non_inferior");
});

test("personal method lookups and mutations cannot read or reinterpret handbook records", async () => {
  const f = fixture(); const candidate = await f.learning.recordHandbookCandidate("alice", f.input());
  const loop = new HandbookConsolidation({ ...f, registry });
  const applied = await loop.run({ job: f.queued[0] });
  for (const id of [candidate.id, applied.handbookId]) {
    const current = await f.documents.get("alice", "method", id);
    await assert.rejects(f.learning.getMethod("alice", id), { code: "method_not_found" });
    await assert.rejects(f.learning.retire("alice", id, { expectedRevision: current.revision }), { code: "method_not_found" });
    await assert.rejects(f.learning.rollback("alice", id, { expectedRevision: current.revision, targetRevision: 1 }), { code: "method_not_found" });
    assert.deepEqual(await f.documents.get("alice", "method", id), current);
  }
});
