import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sourceUnderstandingSchema } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { SourceService, projectSourceManifestRecord } from "../src/sourceService.mjs";
import { SourceIngestionWorker } from "../src/sourceWorker.mjs";
import { SourceUnderstandingRuns } from "../src/sourceUnderstandingRuns.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) { const url = new URL(databaseUrl); assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname)); assert.match(url.pathname, /evimed_test/); }
const options = { skip: !databaseUrl, timeout: 20000 };

async function fixture(t, depth = "structured") {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 5, databaseConnectionTimeoutMs: 2000 });
  const userId = `su_${randomUUID()}`;
  const documents = new ProductDocuments(database); const jobs = new ProductJobs(database); const sources = new SourceService(documents, jobs);
  t.after(async () => { await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]); await database.close(); });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Source understanding','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [userId]);
  let { source } = await sources.register(userId, { projectId: "default", connector: { type: "upload", id: "library" }, path: "knowledge-base/notes.txt",
    sha256: "b".repeat(64), size: 50, mimeType: "text/plain", mtime: "2026-09-07T00:00:00Z" });
  if (depth !== "structured") source = await sources.override(userId, source.id, { expectedRevision: source.revision, docType: "note-memo", depth, reason: "Test depth" });
  const calls = { parse: 0, dispatch: 0, materialize: 0, cancel: 0 };
  const state = { complete: false, captured: null, identity: null, dispatchIds: new Set(), cancelRequests: [] };
  const parser = { parse: async () => { calls.parse++; return { text: "Record the outcome.\r\nKeep the original notes.", summary: "Research notes",
    extractor: { name: "fixture", version: "1", parser: "fallback" }, units: [{ id: "page1", unitType: "page", status: "extracted", itemIds: [] }] }; } };
  const adapter = new SourceUnderstandingRuns({ dispatch: async request => {
    if (!state.dispatchIds.has(request.dispatchId)) { calls.dispatch++; state.dispatchIds.add(request.dispatchId); }
    state.captured = request.input;
    state.identity = { runId: `run_${calls.dispatch}`, sessionId: `session_${calls.dispatch}`, dispatchId: request.dispatchId,
      workspaceName: "", artifactDirectory: `knowledge-base/.evimed-derived/${request.input.sourceId}/generation-${request.input.generation}-fixture-${"a".repeat(24)}` };
    await sources.bindUnderstandingLaunch(request.job, state.identity);
    await sources.bindUnderstandingRun(request.job, state.identity);
    return state.identity;
  }, readResult: async () => {
    if (!state.complete) return { status: "running" };
    const input = state.captured; const unit = input.units[0];
    const evidence = [{ sourceId: input.sourceId, generation: input.generation, unitId: unit.id, start: 0, end: 19, quote: "Record the outcome." }];
    return { status: "succeeded", usage: { currency: "CNY", actualCost: 0.12, modelId: "actual-model", providerId: "deepseek", inputTokens: 10, outputTokens: 20 },
      output: { schemaVersion: 1, sourceId: input.sourceId, generation: input.generation, docType: input.docType, depth: input.depth, summary: "Record outcomes and retain notes.",
        slots: Object.fromEntries(sourceUnderstandingSchema(input.docType).slots.map((key, i) => [key, i === 0
          ? { state: "known", value: "Record the outcome.", evidence } : { state: "unknown", reason: "Not stated." }])),
        claims: [{ id: "claim1", statement: "The source asks to record the outcome.", evidence }],
        methods: input.depth === "deep" ? [{ id: "draft1", title: "Record outcomes", description: "Retain outcomes.", whenToUse: "For research notes.", steps: ["Record the outcome."], checks: [], pitfalls: [], evidence, status: "draft" }] : [],
        omissionAudit: { status: "not_run", reason: "Question audit not performed.", omissionRate: null } } };
  } });
  const worker = () => new SourceIngestionWorker({ jobs, sources, parser, understandingRuns: adapter,
    resolveSource: async () => "/immutable/source.txt", materialize: async () => { calls.materialize++; return "knowledge-base/derived/index.md"; },
    cancelUnderstanding: async run => { calls.cancel++; state.cancelRequests.push(run); }, cleanupSource: async () => {}, leaseMs: 1000, pollMs: 100 });
  const due = async () => database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND status='queued'", [userId]);
  return { database, documents, jobs, sources, source, userId, parser, calls, state, worker, due, adapter };
}

async function prepareLaunch(f) {
  const job = await f.jobs.claim(["ingest"], "launch-fixture", { leaseMs: 3000 });
  const source = await f.sources.beginIngestion(f.userId, f.source.id, { generation: f.source.payload.generation, job });
  await f.sources.freezeCapture(job, await f.parser.parse());
  const launch = { sessionId: "session_launch", dispatchId: `source-understanding-${createHash("sha256").update(`${source.id}\0${source.payload.generation}`).digest("hex").slice(0, 32)}`,
    workspaceName: "source-workspace", artifactDirectory: `knowledge-base/.evimed-derived/${source.id}/generation-${source.payload.generation}-${job.id}-${"b".repeat(24)}` };
  return { job, source, launch };
}

test("real PostgreSQL recovery freezes complete input, reuses one dispatch, publishes typed records atomically and preserves history", options, async t => {
  const f = await fixture(t, "deep"); await f.worker().tick(); // superseded original job
  await f.worker().tick();
  assert.equal(f.calls.parse, 1); assert.equal(f.calls.dispatch, 1);
  assert.equal((await f.sources.getUnderstanding(f.userId, f.source.id)).current, null);
  const jobs = await f.database.query("SELECT attempts FROM evimed_product.jobs WHERE user_id=$1 AND status='queued'", [f.userId]);
  assert.equal(jobs.rows[0].attempts, 0, "waiting does not exhaust job retries");
  f.parser.parse = async () => { throw new Error("Recovery must not parse again"); };
  f.state.complete = true; await f.due(); await f.worker().tick();
  const detail = await f.sources.getUnderstanding(f.userId, f.source.id);
  assert.equal(detail.current.claims.length, 1); assert.equal(detail.current.methods[0].status, "draft");
  assert.equal(detail.current.usage.modelId, "actual-model"); assert.equal(detail.current.omissionAudit.omissionRate, null);
  assert.equal(detail.current.units[0].text, "Record the outcome.\nKeep the original notes.");
  assert.equal(f.calls.dispatch, 1);
  assert.equal((await f.documents.list(f.userId, "method", { projectId: "default" })).items[0].payload.status, "draft");
  await f.worker().tick();
  assert.equal((await f.sources.understandingHistory(f.userId, f.source.id)).items.length, 1);
  const current = await f.sources.get(f.userId, f.source.id);
  await f.sources.retry(f.userId, current.id, { expectedRevision: current.revision });
  assert.equal((await f.sources.getUnderstanding(f.userId, f.source.id)).current, null);
  assert.equal((await f.sources.understandingHistory(f.userId, f.source.id)).items.length, 1);
});

test("skip and index_only perform genuinely different work without calling a model", options, async t => {
  for (const depth of ["skip", "index_only"]) {
    const f = await fixture(t, depth); await f.worker().tick(); await f.worker().tick();
    assert.equal(f.calls.parse, depth === "skip" ? 0 : 1); assert.equal(f.calls.dispatch, 0);
    assert.equal((await f.sources.get(f.userId, f.source.id)).payload.status, "complete");
    const units = await f.documents.list(f.userId, "source-unit", { projectId: "default" });
    assert.equal(units.items.length, depth === "skip" ? 0 : 1);
  }
});

test("cancellation after dispatch queues the exact owned run and rejects its late output", options, async t => {
  const f = await fixture(t); await f.worker().tick();
  const current = await f.sources.get(f.userId, f.source.id);
  await f.sources.cancel(f.userId, current.id, { expectedRevision: current.revision });
  f.state.complete = true; await f.due(); await f.worker().tick(); await f.worker().tick();
  assert.equal(f.calls.cancel, 1); assert.equal(f.state.cancelRequests[0].runId, "run_1");
  assert.equal((await f.sources.getUnderstanding(f.userId, f.source.id)).current, null);
  assert.equal((await f.sources.understandingHistory(f.userId, f.source.id)).items.length, 0);
});

test("expired lease, source override and deletion fence canonical publication", options, async t => {
  for (const action of ["lease", "override", "delete"]) {
    const f = await fixture(t); await f.worker().tick(); f.state.complete = true; await f.due();
    const job = await f.jobs.claim(["ingest"], "manual", { leaseMs: 1000 });
    const source = await f.sources.get(f.userId, f.source.id); const parsed = await f.sources.loadCapture(f.userId, source);
    if (action === "lease") await f.database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    else if (action === "override") await f.sources.override(f.userId, source.id, { expectedRevision: source.revision, docType: "note-memo", depth: "index_only", reason: "Changed" });
    else await f.sources.remove(f.userId, source.id, { expectedRevision: source.revision });
    await assert.rejects(f.sources.publishUnderstanding(job, parsed), error => ["product_job_lease_lost", "source_generation_stale"].includes(error.code));
    const records = await f.documents.list(f.userId, "knowledge", { projectId: "default", filter: { recordType: "source-understanding" } });
    assert.equal(records.items.length, 0);
  }
});

test("lease loss after inserts rolls back every output and duplicate completion cannot add revisions", options, async t => {
  const f = await fixture(t); await f.worker().tick(); f.state.complete = true; await f.due();
  const job = await f.jobs.claim(["ingest"], "manual", { leaseMs: 1000 });
  const source = await f.sources.get(f.userId, f.source.id); const parsed = await f.sources.loadCapture(f.userId, source);
  const completed = await f.adapter.execute({ job, source, parsed });
  const originalPut = f.documents.put.bind(f.documents);
  f.documents.put = async (...args) => {
    const result = await originalPut(...args);
    if (args[1] === "source" && args[3].status === "complete") {
      await args[4].transactionClient.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    }
    return result;
  };
  await assert.rejects(f.sources.publishUnderstanding(job, parsed, completed), { code: "product_job_lease_lost" });
  assert.equal((await f.documents.list(f.userId, "source-unit", { projectId: "default" })).items.length, 0);
  assert.equal((await f.sources.getUnderstanding(f.userId, f.source.id)).current, null);
  f.documents.put = originalPut;
  await f.sources.publishUnderstanding(job, parsed, completed);
  await assert.rejects(f.sources.publishUnderstanding(job, parsed, completed), { code: "product_job_lease_lost" });
  assert.equal((await f.sources.understandingHistory(f.userId, f.source.id)).items.length, 1);
});

test("busy runtime defers intact capture without consuming retry attempts", options, async t => {
  const f = await fixture(t); const worker = f.worker();
  worker.understandingRuns = { execute: async () => { throw Object.assign(new Error("Busy"), { code: "project_runtime_busy" }); } };
  await worker.tick(); await f.due(); await worker.tick();
  assert.equal(f.calls.parse, 1); assert.equal(f.calls.dispatch, 0);
  const result = await f.database.query("SELECT status,attempts FROM evimed_product.jobs WHERE user_id=$1", [f.userId]);
  assert.equal(result.rows[0].status, "queued"); assert.equal(result.rows[0].attempts, 0);
  assert.equal((await f.sources.get(f.userId, f.source.id)).payload.status, "parsing");
});

test("two overrides before cancellation keep one immutable cancellation job through reconciliation", options, async t => {
  const f = await fixture(t); await f.worker().tick();
  let source = await f.sources.get(f.userId, f.source.id);
  source = await f.sources.override(f.userId, source.id, { expectedRevision: source.revision,
    docType: "note-memo", depth: "deep", reason: "First correction" });
  const first = await f.database.query("SELECT id,payload FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action'='source-run-cancel'", [f.userId]);
  source = await f.sources.override(f.userId, source.id, { expectedRevision: source.revision,
    docType: "note-memo", depth: "index_only", reason: "Second correction" });
  await new SourceService(f.documents, f.jobs).reconcileJobs();
  const recovered = await f.database.query("SELECT id,payload FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action'='source-run-cancel'", [f.userId]);
  assert.deepEqual(recovered.rows, first.rows);
  assert.equal(source.payload.generation, 3);
  await f.due();
  for (let i = 0; i < 4; i++) await f.worker().tick();
  assert.equal(f.calls.cancel, 1);
  assert.equal(f.state.cancelRequests[0].runId, "run_1");
  assert.equal((await f.sources.get(f.userId, source.id)).payload.pendingRunCancellations.length, 0);
});

test("a lost cancellation enqueue response survives another override and service restart", options, async t => {
  const f = await fixture(t); await f.worker().tick();
  const source = await f.sources.get(f.userId, f.source.id);
  const enqueue = f.jobs.enqueue.bind(f.jobs);
  f.jobs.enqueue = async (...args) => {
    const job = await enqueue(...args);
    if (args[2]?.action === "source-run-cancel") throw Object.assign(new Error("Simulated response loss after durable enqueue"), { code: "test_response_lost" });
    return job;
  };
  await assert.rejects(f.sources.override(f.userId, source.id, { expectedRevision: source.revision,
    docType: "note-memo", depth: "deep", reason: "First correction" }), { code: "test_response_lost" });
  f.jobs.enqueue = enqueue;
  const restarted = new SourceService(f.documents, f.jobs);
  const afterCrash = await restarted.get(f.userId, source.id);
  await restarted.override(f.userId, source.id, { expectedRevision: afterCrash.revision,
    docType: "note-memo", depth: "index_only", reason: "Correction after restart" });
  await restarted.reconcileJobs();
  const rows = await f.database.query("SELECT payload,status FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action'='source-run-cancel'", [f.userId]);
  assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].status, "queued");
  assert.equal(rows.rows[0].payload.run.id, "run_1");
  assert.equal(rows.rows[0].payload.sourceGeneration, undefined);
});

test("supplementary characters at capture boundaries round-trip through real JSONB source units", options, async t => {
  for (const supplementary of ["😀", "𠀀"]) {
    const f = await fixture(t, "index_only");
    const parse = f.parser.parse;
    const original = "a".repeat(7999) + supplementary + "b";
    f.parser.parse = async () => ({ ...(await parse()), text: original });
    await f.worker().tick(); await f.worker().tick();
    const source = await f.sources.get(f.userId, f.source.id);
    assert.equal(source.payload.status, "complete");
    const capture = await f.sources.loadCapture(f.userId, source);
    assert.equal(capture.input.text, original);
    const rows = await f.database.query("SELECT payload->'unit' AS unit FROM evimed_product.documents WHERE user_id=$1 AND kind='source-unit' ORDER BY (payload->'unit'->>'start')::integer", [f.userId]);
    assert.equal(rows.rows[0].unit.end, 7999);
    assert.equal(rows.rows[1].unit.start, 7999);
    assert.equal(rows.rows.map(row => row.unit.text).join(""), original);
  }
});

test("the UTF-8 output boundary leaves room for the canonical knowledge record envelope", options, async t => {
  const f = await fixture(t); await f.worker().tick(); f.state.complete = true; await f.due();
  const job = await f.jobs.claim(["ingest"], "manual", { leaseMs: 1000 });
  const source = await f.sources.get(f.userId, f.source.id); const parsed = await f.sources.loadCapture(f.userId, source);
  const readResult = f.adapter.readResult;
  f.adapter.readResult = async identity => {
    const result = await readResult(identity);
    result.output.summary = "a".repeat(8000);
    result.output.slots = Object.fromEntries(sourceUnderstandingSchema(parsed.input.docType).slots.map(key => [key, { state: "unknown", reason: "b".repeat(2000) }]));
    const evidence = result.output.claims[0].evidence;
    result.output.claims = [];
    while (Buffer.byteLength(JSON.stringify(result.output)) <= 100000) {
      result.output.claims.push({ id: `c${result.output.claims.length}`, statement: "c".repeat(4000), evidence });
    }
    const excess = Buffer.byteLength(JSON.stringify(result.output)) - 100000;
    result.output.claims.at(-1).statement = "c".repeat(4000 - excess);
    assert.equal(Buffer.byteLength(JSON.stringify(result.output)), 100000);
    return result;
  };
  const completed = await f.adapter.execute({ job, source, parsed });
  await f.sources.publishUnderstanding(job, parsed, completed);
  const record = await f.database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='source-understanding'", [f.userId]);
  assert.equal(record.rows.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(record.rows[0].payload)) < 262144);
});

test("private run ownership remains available for cleanup while superseded runs are not recoverable", options, async t => {
  for (const action of ["cancel", "override", "delete"]) {
    const f = await fixture(t); await f.worker().tick();
    assert.equal((await f.sources.understandingRunForRun(f.userId, "default", "run_1")).recoverable, true);
    assert.equal(await f.sources.understandingRunForRun("another-account", "default", "run_1"), null);
    const source = await f.sources.get(f.userId, f.source.id);
    if (action === "cancel") await f.sources.cancel(f.userId, source.id, { expectedRevision: source.revision });
    else if (action === "delete") await f.sources.remove(f.userId, source.id, { expectedRevision: source.revision });
    else await f.sources.override(f.userId, source.id, { expectedRevision: source.revision, docType: "note-memo", depth: "index_only", reason: "Changed" });
    const bound = await f.sources.understandingRunForRun(f.userId, "default", "run_1");
    assert.equal(bound.id, "run_1"); assert.equal(bound.recoverable, false);
    assert.equal(bound.sourceDeleted, action === "delete");
    // Each loop is an independent account; its intentionally pending jobs must
    // not be claimed by the next loop's global worker fixture.
    await f.database.query("DELETE FROM evimed_control.users WHERE id=$1", [f.userId]);
  }
});

test("durable launch intent survives a pre-binding crash and only binds the matching run scope", options, async t => {
  const f = await fixture(t); const { job, source, launch } = await prepareLaunch(f);
  await assert.rejects(f.sources.bindUnderstandingLaunch(job, { ...launch, sessionId: undefined }), { code: "source_run_binding_invalid" });
  await assert.rejects(f.sources.bindUnderstandingRun(job, { ...launch, runId: "run_launch" }), { code: "source_run_binding_conflict" });
  const persisted = await f.sources.bindUnderstandingLaunch(job, launch);
  assert.deepEqual(persisted.payload.analysis.launch, launch);
  const restarted = new SourceService(f.documents, f.jobs);
  assert.equal((await restarted.bindUnderstandingLaunch(job, launch)).revision, persisted.revision);
  const owner = await restarted.understandingLaunchForDispatch(f.userId, "default", launch.dispatchId);
  assert.equal(owner.recoverable, true); assert.equal(owner.artifactDirectory, launch.artifactDirectory);
  assert.equal(await restarted.understandingLaunchForDispatch("other", "default", launch.dispatchId), null);
  assert.equal(projectSourceManifestRecord(persisted).payload.analysis.launch, undefined);
  assert.equal(JSON.stringify(projectSourceManifestRecord(persisted)).includes(launch.artifactDirectory), false);
  await assert.rejects(restarted.bindUnderstandingRun(job, { ...launch, runId: undefined }), { code: "source_run_binding_invalid" });
  for (const changed of [{ sessionId: "other_session" }, { workspaceName: "different" }, { artifactDirectory: "different/path" }]) {
    await assert.rejects(restarted.bindUnderstandingLaunch(job, { ...launch, ...changed }), { code: "source_run_binding_conflict" });
    await assert.rejects(restarted.bindUnderstandingRun(job, { ...launch, ...changed, runId: "run_launch" }), { code: "source_run_binding_conflict" });
  }
  await assert.rejects(restarted.bindUnderstandingLaunch({ ...job, leaseToken: "stale" }, launch), { code: "product_job_lease_lost" });
  const bound = await restarted.bindUnderstandingRun(job, { ...launch, runId: "run_launch" });
  assert.equal(bound.payload.analysis.run.id, "run_launch");
  assert.deepEqual(bound.payload.analysis.launch, launch);
  const canceled = await restarted.cancel(f.userId, source.id, { expectedRevision: bound.revision });
  await assert.rejects(restarted.bindUnderstandingLaunch(job, launch), { code: "source_generation_stale" });
  assert.equal(canceled.payload.pendingRunCancellations[0].id, "run_launch");
});

test("cancel override and deletion clean protected launch-only scopes without a run id", options, async t => {
  for (const action of ["cancel", "override", "delete"]) {
    const f = await fixture(t); const { job, launch } = await prepareLaunch(f);
    const source = await f.sources.bindUnderstandingLaunch(job, launch);
    if (action === "cancel") await f.sources.cancel(f.userId, source.id, { expectedRevision: source.revision });
    else if (action === "delete") await f.sources.remove(f.userId, source.id, { expectedRevision: source.revision });
    else await f.sources.override(f.userId, source.id, { expectedRevision: source.revision, docType: "note-memo", depth: "skip", reason: "Changed before dispatch" });
    const owner = await f.sources.understandingLaunchForDispatch(f.userId, "default", launch.dispatchId);
    assert.equal(owner.recoverable, false); assert.equal(owner.sourceDeleted, action === "delete");
    await f.due(); await f.worker().tick();
    if (action === "override") await f.worker().tick();
    assert.equal(f.calls.cancel, 1);
    assert.deepEqual(f.state.cancelRequests[0], { userId: f.userId, projectId: "default", runId: null, ...launch });
    assert.equal(f.calls.dispatch, 0);
    await f.database.query("DELETE FROM evimed_control.users WHERE id=$1", [f.userId]);
  }
});

test("terminal source failures remain stopped across reconciliation until an explicit new generation", options, async t => {
  const f = await fixture(t); const worker = f.worker();
  worker.understandingRuns = { execute: async () => { throw Object.assign(new Error("Terminal run failure"), { code: "source_understanding_run_failed" }); } };
  await worker.tick();
  const failed = await f.sources.get(f.userId, f.source.id);
  assert.equal(failed.payload.status, "failed");
  const duplicate = await f.sources.register(f.userId, { projectId: failed.projectId, connector: failed.payload.connector,
    path: failed.payload.paths[0], ...failed.payload.fingerprint });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.job, null);
  const originalJobs = await f.database.query("SELECT id,status,attempts FROM evimed_product.jobs WHERE user_id=$1 ORDER BY id", [f.userId]);
  for (let i = 0; i < 4; i++) { await f.sources.reconcileJobs(); await worker.tick(); }
  assert.deepEqual((await f.database.query("SELECT id,status,attempts FROM evimed_product.jobs WHERE user_id=$1 ORDER BY id", [f.userId])).rows, originalJobs.rows);
  assert.equal((await f.sources.get(f.userId, f.source.id)).revision, failed.revision);
  await f.sources.retry(f.userId, failed.id, { expectedRevision: failed.revision });
  for (let i = 0; i < 3; i++) await f.sources.reconcileJobs();
  const generations = await f.database.query("SELECT payload->>'sourceGeneration' AS generation,count(*)::int AS count FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action' IS NULL GROUP BY 1 ORDER BY 1", [f.userId]);
  assert.deepEqual(generations.rows, [{ generation: "1", count: 1 }, { generation: "2", count: 1 }]);
});

test("reconciliation preserves finite retries then settles a crashed exhausted source exactly once", options, async t => {
  const f = await fixture(t);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = await f.jobs.claim(["ingest"], "finite-attempts", { leaseMs: 1000 });
    await f.sources.beginIngestion(f.userId, f.source.id, { generation: 1, job });
    if (attempt < 3) {
      await f.jobs.fail(f.userId, job.id, job.leaseToken, { code: "source_parser_unavailable", message: "Temporary parser outage." }, { retry: true, delayMs: 0 });
      await f.sources.reconcileJobs();
      assert.equal((await f.jobs.get(f.userId, job.id)).status, "queued");
      assert.equal((await f.sources.get(f.userId, f.source.id)).payload.status, "parsing");
    } else {
      await f.database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
      assert.equal(await f.jobs.claim(["ingest"], "reap-exhausted", { leaseMs: 1000 }), null);
    }
  }
  assert.equal((await f.sources.get(f.userId, f.source.id)).payload.status, "parsing");
  await f.sources.reconcileJobs();
  const settled = await f.sources.get(f.userId, f.source.id);
  assert.equal(settled.payload.status, "failed");
  assert.equal(settled.payload.error.code, "product_job_attempts_exhausted");
  for (let i = 0; i < 4; i++) await f.sources.reconcileJobs();
  assert.equal((await f.sources.get(f.userId, f.source.id)).revision, settled.revision);
  assert.equal((await f.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1", [f.userId])).rowCount, 1);
});

test("missing initial enqueue is recovered once with the original generation key", options, async t => {
  const f = await fixture(t);
  // This is the durable state after source creation commits but enqueue never
  // reaches storage: a queued source with no generation job.
  await f.database.query("DELETE FROM evimed_product.jobs WHERE user_id=$1", [f.userId]);
  await f.sources.reconcileJobs(); await f.sources.reconcileJobs();
  const jobs = await f.database.query("SELECT idempotency_key,status FROM evimed_product.jobs WHERE user_id=$1", [f.userId]);
  assert.deepEqual(jobs.rows, [{ idempotency_key: `ingest:${f.source.id}:generation:1`, status: "queued" }]);
  assert.equal((await f.sources.get(f.userId, f.source.id)).payload.status, "queued");
});

test("queued exhausted sources settle by CAS without overwriting a concurrent correction", options, async t => {
  for (const correction of [false, true]) {
    const f = await fixture(t);
    const job = await f.jobs.claim(["ingest"], "queued-terminal", { leaseMs: 1000 });
    await f.jobs.fail(f.userId, job.id, job.leaseToken, { code: "source_parser_unavailable", message: "Stopped before parsing." }, { retry: false });
    const put = f.documents.put.bind(f.documents);
    let corrected = false;
    if (correction) f.documents.put = async (...args) => {
      if (!corrected && args[1] === "source" && args[3].status === "failed" && args[4].transactionClient) {
        corrected = true;
        await f.sources.override(f.userId, f.source.id, { expectedRevision: f.source.revision,
          docType: "note-memo", depth: "index_only", reason: "Concurrent user correction" });
      }
      return put(...args);
    };
    await f.sources.reconcileJobs();
    const current = await f.sources.get(f.userId, f.source.id);
    assert.equal(current.payload.status, correction ? "queued" : "failed");
    assert.equal(current.payload.generation, correction ? 2 : 1);
    assert.equal(corrected, correction);
    assert.equal((await f.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1", [f.userId])).rowCount, correction ? 2 : 1);
    await f.database.query("DELETE FROM evimed_control.users WHERE id=$1", [f.userId]);
  }
});
