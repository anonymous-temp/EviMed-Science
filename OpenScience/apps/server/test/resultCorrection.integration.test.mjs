// A correction on PostgreSQL: what only the real ledger and the real document store can answer.
//
// The unit file holds the properties against doubles. Here: a deployment whose feedback table predates the
// `result-corrected` trigger has its constraints rebuilt (the first write of the new trigger would otherwise be refused by
// the database, months after the code shipped), the pair is the event's identity under `ON CONFLICT`, the settled revision
// and the jsonb containment lookups it depends on work against the real store, and the lesson lands in the real job queue.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { loadConfig } from "../src/config.mjs";
import { PostgresStore } from "../src/store.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { FeedbackEvents } from "../src/feedbackEvents.mjs";
import { LearningTriggers } from "../src/learningTriggers.mjs";
import { ResultCorrectionService } from "../src/resultCorrection.mjs";
import { ResultLineageService } from "../src/resultLineage.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultRevisionService } from "../src/resultRevision.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60000 };
const sha = value => createHash("sha256").update(value).digest("hex");

const ORIGINAL = "合并 OR 为 0.71。\n";
const REVISED = "合并 OR 为 0.68，新增研究 doi:10.1000/beta。\n";

async function fixture(t) {
  const isolated = await createGeoTestDatabase(databaseUrl, "cor");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "result-correction-"));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: "postgres", devAuth: true, maxProjectBytes: 32 * 1024 * 1024 });
  const store = new PostgresStore(config);
  t.after(async () => { await store.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await store.devUser(); const project = await store.requireProject(user, "default");
  await mkdir(project.workspaceDir, { recursive: true });
  return { isolated, config, store, user, project, dataDir };
}

test("on PostgreSQL: a feedback table from before the trigger existed is rebuilt, and the pair is one event however often it is recorded", options, async t => {
  const f = await fixture(t);
  await migrateProductStore(f.store.database);
  // The vocabulary of a deployment that has run since 2026-09-07: no `result-corrected`, no `result-version`.
  await f.store.database.query(`ALTER TABLE evimed_product.feedback_events DROP CONSTRAINT feedback_events_trigger_check,
    DROP CONSTRAINT feedback_events_subject_check,
    ADD CONSTRAINT feedback_events_trigger_check CHECK (trigger_kind IN ('memory-inference-accepted','memory-value-edited','memory-rejected','deliverable-adopted','deliverable-edited')),
    ADD CONSTRAINT feedback_events_subject_check CHECK (subject_type IN ('memory-record','deliverable'))`);
  const old = new FeedbackEvents({ database: f.store.database });
  const correction = { revisionId: `rr_${"e".repeat(64)}`, original: { versionId: `rv_${"a".repeat(64)}`, digest: "1".repeat(64), path: "report.md" },
    successor: { versionId: `rv_${"b".repeat(64)}`, digest: "2".repeat(64), path: "o/report.md" }, kind: "analytic",
    effects: { bytes: "changed", printedNumbers: "changed", numbersAdded: ["0.68"], numbersRemoved: ["0.71"] }, instruction: "核对", instructionDigest: "3".repeat(64) };
  await assert.rejects(() => old.recordResultCorrection(f.user.id, { correction, projectId: "default" }), /feedback_events_trigger_check|violates check constraint/, "an unmigrated table refuses the new trigger");

  // A second connection to the same database runs the migration as a restarted process does.
  const { ControlPlaneDatabase } = await import("../src/controlPlaneDatabase.mjs");
  const database = new ControlPlaneDatabase({ databaseUrl: f.isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 2_000 });
  t.after(() => database.close());
  const feedback = new FeedbackEvents({ database });
  const first = await feedback.recordResultCorrection(f.user.id, { correction, projectId: "default", runId: "run_original" });
  assert.equal(first.created, true);
  const replay = await feedback.recordResultCorrection(f.user.id, { correction, projectId: "default", runId: "run_original" });
  assert.equal(replay.created, false, "the same pair is the same event");
  assert.equal(replay.event.id, first.event.id);
  const other = await feedback.recordResultCorrection(f.user.id, { correction: { ...correction, successor: { ...correction.successor, versionId: `rv_${"c".repeat(64)}`, digest: "4".repeat(64) } }, projectId: "default", runId: "run_original" });
  assert.equal(other.created, true, "another successor of the same original is another event");

  assert.equal(first.event.subject.type, "result-version");
  assert.equal(first.event.subject.id, correction.original.versionId);
  assert.equal(first.event.runId, "run_original");
  assert.equal(first.event.detail.adoption, "not_recorded");
  // Found from either side of the pair, and from nobody else.
  assert.equal((await feedback.listResultCorrections(f.user.id, correction.original.versionId)).length, 2);
  assert.deepEqual((await feedback.listResultCorrections(f.user.id, correction.successor.versionId)).map(event => event.id), [first.event.id]);
  assert.equal((await feedback.listResultCorrections(`${f.user.id}-other`, correction.original.versionId)).length, 0);
  assert.equal((await feedback.list(f.user.id, { subject: { type: "result-version", id: correction.original.versionId } })).items.length, 2);
  // The vocabulary is the database's too.
  await assert.rejects(() => database.query(`INSERT INTO evimed_product.feedback_events (id,user_id,trigger_kind,subject_type,subject_id,detail,occurred_at)
    VALUES ('feedback:x:1',$1,'result-corrected','result-fiction','x','{}'::jsonb,now())`, [f.user.id]));
  // The migration is idempotent: running it again changes nothing and refuses nothing.
  await migrateProductStore(new ControlPlaneDatabase({ databaseUrl: f.isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 }));
});

test("on PostgreSQL: a revision's successor is recorded, settled with what the run left, and learned from once, in the real stores", options, async t => {
  const f = await fixture(t);
  const documents = new ProductDocuments(f.store.database); const jobs = new ProductJobs(f.store.database);
  const feedback = new FeedbackEvents({ database: f.store.database });
  const originalRun = { id: "original-run", sessionId: "original-session", status: "succeeded", effectiveAgentId: "meta-analysis", transcript: { completeness: "complete" }, artifacts: ["report.md"] };
  const run = { id: "revision-run", sessionId: "revision-session", kernelRequestIds: ["submitted-request"], status: "succeeded", effectiveAgentId: "meta-analysis", transcript: { completeness: "complete" } };
  const triggers = new LearningTriggers({ jobs, agentRuns: { list: async () => [originalRun, run] } });
  const holder = {};
  const results = new ResultProvenanceService({ documents, config: f.config,
    authorizeProject: async (actor, id) => f.store.requireProject(await f.store.userById(actor), id),
    authorizeReference: async (_actor, _project, reference) => reference,
    resolveCaptureContext: (owned, input) => holder.revisions.captureContext(owned, input, run),
    afterCorrection: event => holder.corrections.capture(event) });
  holder.revisions = new ResultRevisionService({ results, documents, lineage: new ResultLineageService({ results, config: f.config }) });
  holder.corrections = new ResultCorrectionService({ results, documents, feedback, runs: { list: async () => [originalRun, run] }, learning: () => triggers,
    report: code => { throw new Error(`unexpected report: ${code}`); } });
  const write = async (relative, content) => { await mkdir(path.dirname(path.join(f.project.workspaceDir, relative)), { recursive: true }); await writeFile(path.join(f.project.workspaceDir, relative), content); };
  let call = 0;
  const capture = async (relative, content, owner) => {
    await write(relative, content); call += 1;
    return results.captureFile({ userId: f.user.id, project: f.project, relativePath: relative, expectedDigest: sha(content),
      producer: { kind: "tool", sessionId: owner.sessionId, runId: owner.id, callId: `call-${call}`, eventId: `call-${call}` } });
  };

  const original = await capture("report.md", ORIGINAL, originalRun);
  const stage = await holder.revisions.stage(f.user.id, original.versionId, { projectId: f.project.id, digest: original.digest, requestId: "selected", sessionId: run.sessionId,
    anchor: { kind: "text", elementId: "paragraph-1", selectedText: "合并 OR 为 0.71" } });
  await holder.revisions.bind(f.user.id, f.project, { sessionId: run.sessionId, requestId: "submitted-request", evimedResultRevision: { referenceId: stage.referenceId },
    content: [{ type: "text", text: `${stage.draft}把 OR 改成核对后的值，并加入新研究` }] });
  const directory = `artifacts/result-revisions/${stage.referenceId}/output`;
  const successor = await capture(`${directory}/report.md`, REVISED, run);
  const rendering = await capture(`${directory}/report.docx`, "PK binary", run);
  assert.equal(successor.supersedesVersionId, original.versionId);

  const events = await feedback.listResultCorrections(f.user.id, original.versionId);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.kind, "analytic");
  assert.deepEqual(events[0].detail.effects.identifiersAdded, ["doi:10.1000/beta"]);
  assert.equal(events[0].detail.successor.versionId, successor.versionId);

  // The run ends: the real store's containment lookups find the bound revision and the run's own versions.
  assert.deepEqual(await holder.corrections.settle(f.project, run), { settled: 1 });
  const settled = (await documents.get(f.user.id, "result-revision", stage.referenceId)).payload;
  assert.equal(settled.outcome.status, "settled");
  assert.equal(settled.outcome.successorVersionId, successor.versionId);
  assert.deepEqual(settled.outcome.outputs.map(item => [item.versionId, item.role]).sort(), [[rendering.versionId, "rendering"], [successor.versionId, "successor"]].sort());
  const queued = await f.store.database.query("SELECT kind,payload,idempotency_key FROM evimed_product.jobs WHERE user_id=$1 AND kind='distill'", [f.user.id]);
  assert.equal(queued.rowCount, 1, "one lesson, in the real queue");
  assert.equal(queued.rows[0].payload.runId, "original-run");
  assert.equal(queued.rows[0].payload.feedback[0].detail.successor.versionId, successor.versionId);
  assert.deepEqual(await holder.corrections.settle(f.project, run), { settled: 0 });
  assert.equal((await f.store.database.query("SELECT count(*)::integer AS n FROM evimed_product.jobs WHERE user_id=$1 AND kind='distill'", [f.user.id])).rows[0].n, 1);

  // What the result view reads.
  const read = await holder.corrections.read(f.user.id, f.project.id, original.versionId);
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0].outcome.status, "settled");
  assert.equal((await results.raw(f.user.id, f.project.id, original.versionId)).bytes.toString(), ORIGINAL);
});

test("on PostgreSQL: a revision whose run ended while nothing listened is settled and its lesson queued exactly once by the sweep, and a second pass does nothing", options, async t => {
  const f = await fixture(t);
  const documents = new ProductDocuments(f.store.database); const jobs = new ProductJobs(f.store.database);
  const feedback = new FeedbackEvents({ database: f.store.database });
  const originalRun = { id: "original-run", sessionId: "original-session", status: "succeeded", effectiveAgentId: "meta-analysis", transcript: { completeness: "complete" }, artifacts: ["report.md"] };
  // The revision's run has ended: the restart took the run-finished hook that would have settled it.
  const run = { id: "revision-run", sessionId: "revision-session", kernelRequestIds: ["submitted-request"], status: "succeeded", effectiveAgentId: "meta-analysis",
    transcript: { completeness: "complete" }, finishedAt: "2026-10-04T08:00:00.000Z" };
  const ledger = [originalRun, run];
  const triggers = new LearningTriggers({ jobs, agentRuns: { list: async () => ledger } });
  const holder = {};
  const results = new ResultProvenanceService({ documents, config: f.config,
    authorizeProject: async (actor, id) => f.store.requireProject(await f.store.userById(actor), id),
    authorizeReference: async (_actor, _project, reference) => reference,
    resolveCaptureContext: (owned, input) => holder.revisions.captureContext(owned, input, run),
    afterCorrection: event => holder.corrections.capture(event) });
  holder.revisions = new ResultRevisionService({ results, documents, lineage: new ResultLineageService({ results, config: f.config }) });
  const reported = [];
  let clock = new Date("2026-10-04T08:30:00.000Z");
  holder.corrections = new ResultCorrectionService({ results, documents, feedback, runs: { list: async () => ledger }, learning: () => triggers,
    report: code => reported.push(code), now: () => clock });
  const write = async (relative, content) => { await mkdir(path.dirname(path.join(f.project.workspaceDir, relative)), { recursive: true }); await writeFile(path.join(f.project.workspaceDir, relative), content); };
  let call = 0;
  const capture = async (relative, content, owner) => {
    await write(relative, content); call += 1;
    return results.captureFile({ userId: f.user.id, project: f.project, relativePath: relative, expectedDigest: sha(content),
      producer: { kind: "tool", sessionId: owner.sessionId, runId: owner.id, callId: `call-${call}`, eventId: `call-${call}` } });
  };
  const original = await capture("report.md", ORIGINAL, originalRun);
  const stage = await holder.revisions.stage(f.user.id, original.versionId, { projectId: f.project.id, digest: original.digest, requestId: "selected", sessionId: run.sessionId,
    anchor: { kind: "text", elementId: "paragraph-1", selectedText: "合并 OR 为 0.71" } });
  await holder.revisions.bind(f.user.id, f.project, { sessionId: run.sessionId, requestId: "submitted-request", evimedResultRevision: { referenceId: stage.referenceId },
    content: [{ type: "text", text: `${stage.draft}把 OR 改成核对后的值，并加入新研究` }] });
  const successor = await capture(`artifacts/result-revisions/${stage.referenceId}/output/report.md`, REVISED, run);
  const resolveProject = async (userId, projectId) => f.store.requireProject(await f.store.userById(userId), projectId);
  const distills = async () => (await f.store.database.query("SELECT payload,idempotency_key FROM evimed_product.jobs WHERE user_id=$1 AND kind='distill'", [f.user.id])).rows;

  // The hook never ran: the revision is bound, has no outcome, and no lesson was queued.
  assert.equal((await documents.get(f.user.id, "result-revision", stage.referenceId)).payload.outcome, undefined);
  assert.equal((await distills()).length, 0);

  // A run that ended a moment ago is left to the hook that is probably running now.
  clock = new Date("2026-10-04T08:05:00.000Z");
  assert.deepEqual(await holder.corrections.sweep({ resolveProject }), { found: 1, settled: 0 });
  assert.equal((await documents.get(f.user.id, "result-revision", stage.referenceId)).payload.outcome, undefined);

  // Later: settled once, with what the run left, and the lesson queued under the correction's dispatch key.
  clock = new Date("2026-10-04T08:30:00.000Z");
  assert.deepEqual(await holder.corrections.sweep({ resolveProject }), { found: 1, settled: 1 });
  const settled = (await documents.get(f.user.id, "result-revision", stage.referenceId)).payload;
  assert.equal(settled.outcome.status, "settled");
  assert.equal(settled.outcome.successorVersionId, successor.versionId);
  const [lesson, ...rest] = await distills();
  assert.equal(rest.length, 0, "one lesson");
  assert.equal(lesson.payload.runId, "original-run");
  assert.match(lesson.idempotency_key, /^distill:original-run:correction:/);

  // A second tick finds nothing unsettled and changes nothing; the hook arriving late finds the revision settled too.
  assert.deepEqual(await holder.corrections.sweep({ resolveProject }), { found: 0, settled: 0 });
  assert.deepEqual(await holder.corrections.settle(f.project, run), { settled: 0 });
  assert.equal((await distills()).length, 1);
  assert.deepEqual(reported, [], "nothing failed");
});

test("on PostgreSQL: the sweep leaves a run still working to its hook, and a revision whose run is gone from the ledger does not hold the others back", options, async t => {
  const f = await fixture(t);
  const documents = new ProductDocuments(f.store.database);
  const bound = (id, sessionId, requestId) => documents.put(f.user.id, "result-revision", id, { recordType: "result-revision", id, projectId: f.project.id,
    requestedBy: f.user.id, state: "bound", sessionId, promptRequestId: requestId }, { projectId: f.project.id, expectedRevision: 0 });
  await bound("rr_gone", "session-gone", "request-gone");
  await bound("rr_working", "session-working", "request-working");
  await bound("rr_ended", "session-ended", "request-ended");
  const ledger = [{ id: "run-working", sessionId: "session-working", kernelRequestIds: ["request-working"], status: "running" },
    { id: "run-ended", sessionId: "session-ended", kernelRequestIds: ["request-ended"], status: "failed", finishedAt: "2026-10-04T01:00:00.000Z" }];
  const corrections = new ResultCorrectionService({ results: { get: async () => { throw Object.assign(new Error("gone"), { code: "result_version_not_found" }); }, list: async () => ({ items: [] }) },
    documents, runs: { list: async () => ledger }, now: () => new Date("2026-10-04T12:00:00.000Z") });
  const resolveProject = async (userId, projectId) => f.store.requireProject(await f.store.userById(userId), projectId);
  // One row at a time, to see the pass move on: oldest first, then past it, then round to the start.
  const first = await corrections.sweep({ resolveProject, limit: 1 });
  const second = await corrections.sweep({ resolveProject, limit: 1 });
  const third = await corrections.sweep({ resolveProject, limit: 1 });
  assert.deepEqual([first.found, second.found, third.found], [1, 1, 1], "each pass takes the next one, and none is the same twice in a row");
  const fourth = await corrections.sweep({ resolveProject, limit: 1 });
  assert.equal(fourth.found, 1, "past the end it starts over, in the same pass");
  assert.equal((await documents.get(f.user.id, "result-revision", "rr_working")).payload.outcome, undefined, "a run still working is left to its hook");
  assert.equal((await documents.get(f.user.id, "result-revision", "rr_gone")).payload.outcome, undefined, "a run the ledger no longer has is left as it was");
});
