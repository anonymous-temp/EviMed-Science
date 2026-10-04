// A correction made through the anchored revision, recorded with the immutable pair of versions it produced (N12).
//
// What these tests are for: until now a correction left two linked versions and nothing else — no feedback event, nothing
// for distillation, nothing the result view could say about what it changed. They assert the properties that make the
// record worth having: the pair is the identity (a replayed capture writes nothing, an overwritten path changes nothing),
// what the correction changed is decided from the two versions' bytes and not from the researcher's words, the successor
// is never recorded as the researcher's adoption, one lesson is queued for the successor the run ended on and under the
// same switches as every other lesson, and nothing a ledger or a queue does can cost a version its capture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FeedbackEvents } from "../src/feedbackEvents.mjs";
import { LearningTriggers } from "../src/learningTriggers.mjs";
import { ResultCorrectionService } from "../src/resultCorrection.mjs";
import { ResultLineageService } from "../src/resultLineage.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultRevisionService } from "../src/resultRevision.mjs";
import { createResultProvenanceRoutes } from "../src/resultProvenanceRoutes.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

/** The statements `FeedbackEvents` issues for a correction, answered from a Map. The insert honours `ON CONFLICT(id) DO NOTHING`. */
class DatabaseDouble {
  constructor() { this.rows = new Map(); }
  async query(text, values = []) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    if (sql.startsWith("INSERT INTO evimed_product.feedback_events")) {
      const [id, userId, projectId, runId, trigger, subjectType, subjectId, detail, occurredAt] = values;
      if (this.rows.has(id)) return { rows: [], rowCount: 0 };
      const row = { id, user_id: userId, project_id: projectId, run_id: runId, trigger_kind: trigger, subject_type: subjectType, subject_id: subjectId,
        detail: JSON.parse(String(detail)), occurred_at: occurredAt, recorded_at: new Date().toISOString() };
      this.rows.set(id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM evimed_product.feedback_events WHERE id=$1 AND user_id=$2")) {
      const row = this.rows.get(values[0]);
      return { rows: row && row.user_id === values[1] ? [row] : [], rowCount: row && row.user_id === values[1] ? 1 : 0 };
    }
    if (sql.startsWith("SELECT * FROM evimed_product.feedback_events WHERE user_id=$1 AND id=$2")) {
      const row = this.rows.get(values[1]);
      return { rows: row && row.user_id === values[0] ? [row] : [], rowCount: row && row.user_id === values[0] ? 1 : 0 };
    }
    if (sql.includes("trigger_kind='result-corrected'") && sql.includes("detail->'successor'->>'versionId'=$2")) {
      const [userId, versionId, limit] = values;
      const rows = [...this.rows.values()].filter(row => row.user_id === userId && row.trigger_kind === "result-corrected"
        && ((row.subject_type === "result-version" && row.subject_id === versionId) || row.detail?.successor?.versionId === versionId))
        .sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at)) || right.id.localeCompare(left.id)).slice(0, limit);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
  async transaction(operation) { return operation(this); }
}

class JobsDouble {
  constructor() { this.jobs = []; }
  async enqueue(userId, kind, payload, { idempotencyKey, projectId = null }) {
    const existing = this.jobs.find(job => job.userId === userId && job.idempotencyKey === idempotencyKey);
    if (existing) return existing;
    const job = { id: `job_${this.jobs.length + 1}`, userId, kind, payload, projectId, idempotencyKey };
    this.jobs.push(job);
    return job;
  }
}

const ORIGINAL_REPORT = "合并 OR 为 0.71，I² 为 41.2%。\n\n## 参考文献\n[1] Smith 2020 doi:10.1000/alpha\n";
const REVISED_REPORT = "合并 OR 为 0.68，I² 为 41.2%。\n\n## 参考文献\n[1] Smith 2020 doi:10.1000/alpha\n[2] Lee 2021 doi:10.1000/beta\n";

async function fixture(t, { runOverrides = {}, jobsEnabled = true, memory = null } = {}) {
  const root = await mkdtemp("/tmp/evimed-correction-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p", userId: "owner", rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, "meta") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const documents = productDocumentsDouble();
  const database = new DatabaseDouble();
  const feedback = new FeedbackEvents({ database });
  const jobs = new JobsDouble();
  const f = { project, documents, database, feedback, jobs, audit: [],
    // The run whose work is corrected, and the run that revises it.
    originalRun: { id: "original-run", sessionId: "original-session", status: "succeeded", effectiveAgentId: "meta-analysis", transcript: { completeness: "complete" },
      artifacts: ["report.md"], ...runOverrides },
    run: { id: "revision-run", sessionId: "revision-session", kernelRequestIds: ["submitted-request"], status: "succeeded", effectiveAgentId: "meta-analysis", transcript: { completeness: "complete" } } };
  const agentRuns = { list: async () => [f.originalRun, f.run] };
  const triggers = jobsEnabled ? new LearningTriggers({ jobs, agentRuns, memory, audit: async (event, detail) => { f.audit.push([event, detail.code]); } }) : null;
  f.results = new ResultProvenanceService({ documents, authorizeProject: async () => project, authorizeReference: async (_actor, _project, reference) => reference,
    resolveCaptureContext: (owned, input) => f.revisions.captureContext(owned, input, f.run),
    afterCorrection: event => f.corrections.capture(event) });
  f.revisions = new ResultRevisionService({ results: f.results, documents, lineage: new ResultLineageService({ results: f.results }) });
  f.corrections = new ResultCorrectionService({ results: f.results, documents, feedback, runs: agentRuns, learning: () => triggers, report: code => f.audit.push(["report", code]) });
  f.write = async (relativePath, bytes) => {
    await mkdir(path.dirname(path.join(project.workspaceDir, relativePath)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relativePath), bytes);
  };
  let call = 0;
  /** What a run's tool wrote, captured with its receipt. */
  f.capture = async (relativePath, bytes, { run = f.run, extra = {} } = {}) => {
    await f.write(relativePath, bytes);
    call += 1;
    return f.results.captureFile({ userId: "owner", project, relativePath, expectedDigest: sha(bytes),
      producer: { kind: "tool", runId: run.id, sessionId: run.sessionId, callId: `call-${call}`, eventId: `call-${call}` }, ...extra });
  };
  f.original = null;
  /** The original result, delivered by its own run. */
  f.deliver = async (bytes = ORIGINAL_REPORT, extra = {}) => { f.original = await f.capture("report.md", bytes, { run: f.originalRun, extra }); return f.original; };
  /** The researcher's selection, bound to the revision run's request. */
  f.revise = async (instruction = "把合并 OR 改为核对后的值", selectedText = "合并 OR 为 0.71") => {
    const stage = await f.revisions.stage("owner", f.original.versionId, { projectId: "p", digest: f.original.digest, requestId: `selected-${instruction.length}`,
      sessionId: f.run.sessionId, anchor: { kind: "text", elementId: "paragraph-1", selectedText } });
    const request = { sessionId: f.run.sessionId, requestId: "submitted-request", evimedResultRevision: { referenceId: stage.referenceId },
      content: [{ type: "text", text: `${stage.draft}${instruction}` }] };
    await f.revisions.bind("owner", project, request);
    return { stage, directory: `artifacts/result-revisions/${stage.referenceId}/output` };
  };
  f.events = async () => [...database.rows.values()];
  return f;
}

test("a successor captured for a revision is recorded once as a correction of the immutable pair, from the bytes and not the instruction", async t => {
  const f = await fixture(t);
  const original = await f.deliver();
  const { stage, directory } = await f.revise();
  const successor = await f.capture(`${directory}/report.md`, REVISED_REPORT);
  assert.equal(successor.supersedesVersionId, original.versionId);

  const [event, ...rest] = await f.events();
  assert.deepEqual(rest, [], "one pair is one event");
  assert.equal(event.trigger_kind, "result-corrected");
  assert.deepEqual([event.subject_type, event.subject_id], ["result-version", original.versionId], "the subject is the original version, not a path");
  assert.equal(event.user_id, "owner");
  assert.equal(event.run_id, "original-run", "the event is about the run whose work was corrected");
  const detail = event.detail;
  assert.deepEqual([detail.original.versionId, detail.original.digest, detail.successor.versionId, detail.successor.digest],
    [original.versionId, original.digest, successor.versionId, successor.digest]);
  assert.equal(detail.revisionId, stage.referenceId);
  assert.equal(detail.kind, "analytic");
  assert.deepEqual([detail.effects.numbersRemoved, detail.effects.numbersAdded], [["0.71"], ["0.68"]]);
  assert.deepEqual(detail.effects.identifiersAdded, ["doi:10.1000/beta"], "a study added shows as the source it names");
  assert.deepEqual(detail.effects.identifiersRemoved, []);
  assert.equal(detail.anchor.kind, "text");
  assert.equal(detail.instruction, "把合并 OR 改为核对后的值", "the researcher's own words");
  assert.equal(detail.instructionDigest, (await f.documents.get("owner", "result-revision", stage.referenceId)).payload.instructionDigest, "the digest of what was submitted, as the revision record holds it");
  assert.match(detail.instructionDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual([detail.instructionOrigin, detail.successorOrigin, detail.adoption], ["researcher", "system_generated", "not_recorded"]);
  assert.equal(detail.capabilityId, "meta-analysis");
  assert.deepEqual([detail.originalRunId, detail.revisionRunId], ["original-run", "revision-run"]);

  // Replaying the capture (a reconnect, a crash between the capture and the end of the run) writes nothing more.
  await f.write(`${directory}/report.md`, REVISED_REPORT);
  const replayed = await f.results.captureFile({ userId: "owner", project: f.project, relativePath: `${directory}/report.md`, expectedDigest: sha(REVISED_REPORT),
    producer: { kind: "tool", runId: f.run.id, sessionId: f.run.sessionId, callId: "call-2", eventId: "call-2" } });
  assert.equal(replayed.versionId, successor.versionId);
  assert.equal((await f.events()).length, 1);
  // Nothing was recorded as the researcher's adoption of the successor, and no job was queued by the capture itself.
  assert.equal((await f.events()).some(row => row.trigger_kind === "deliverable-adopted"), false);
  assert.deepEqual(f.jobs.jobs, []);
});

test("the original is preserved, and a path overwritten afterwards changes neither version nor the event", async t => {
  const f = await fixture(t);
  const original = await f.deliver();
  const { directory } = await f.revise();
  const successor = await f.capture(`${directory}/report.md`, REVISED_REPORT);
  // The researcher's workspace file is rewritten later: the pair named by the event is immutable.
  await f.write("report.md", "something else entirely 9.99\n");
  assert.equal((await f.results.raw("owner", "p", original.versionId)).bytes.toString(), ORIGINAL_REPORT);
  const read = await f.corrections.read("owner", "p", original.versionId);
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0].correction.original.digest, original.digest);
  assert.equal(read.items[0].role, "original");
  assert.deepEqual((await f.corrections.read("owner", "p", successor.versionId)).items.map(item => item.role), ["successor"], "the same event is found from either side of the pair");
});

test("a correction names what it changed in a closed vocabulary: evidence, presentation, and a version that cannot be compared", async t => {
  const f = await fixture(t);
  await f.deliver("疗效见研究 [1]。\n");
  const { directory } = await f.revise("再补一项依据", "疗效见研究");
  await f.capture(`${directory}/report.md`, "疗效见研究 [1]，另见 NCT01234567。[claim:CLM-002]\n");
  const [evidence] = await f.events();
  assert.equal(evidence.detail.kind, "evidence", "sources and claims moved and no number did");
  assert.deepEqual(evidence.detail.effects.identifiersAdded, ["nct:NCT01234567"]);
  assert.deepEqual(evidence.detail.effects.claimsAdded, ["CLM-002"]);

  const g = await fixture(t);
  g.original = await g.capture("forest.svg", '<svg><text font-size="9">OR 0.71</text></svg>', { run: g.originalRun });
  const picked = await g.revisions.stage("owner", g.original.versionId, { projectId: "p", digest: g.original.digest, requestId: "svg", sessionId: g.run.sessionId,
    anchor: { kind: "figure", elementId: "figure-1", selectedText: "forest.svg" } });
  await g.revisions.bind("owner", g.project, { sessionId: g.run.sessionId, requestId: "submitted-request", evimedResultRevision: { referenceId: picked.referenceId },
    content: [{ type: "text", text: `${picked.draft}字再大一些` }] });
  await g.capture(`artifacts/result-revisions/${picked.referenceId}/output/forest.svg`, '<svg><text font-size="14" fill="#000">OR 0.71</text></svg>');
  const [restyle] = await g.events();
  assert.equal(restyle.detail.kind, "presentation", "the bytes changed and neither the printed numbers nor the sources did");
  assert.equal(restyle.detail.anchor.kind, "figure");

  const h = await fixture(t);
  await h.deliver();
  const staged = await h.revise("改一下措辞");
  await h.capture(`${staged.directory}/report.md`, "合并 OR 为 0.71，I² 为 41.2%，措辞已改。\n\n## 参考文献\n[1] Smith 2020 doi:10.1000/alpha\n");
  assert.equal((await h.events())[0].detail.kind, "presentation");

  const pdf = await fixture(t);
  pdf.original = await pdf.capture("report.pdf", "%PDF-1.4 original", { run: pdf.originalRun });
  assert.equal(pdf.original.mimeType, "application/pdf");
  await pdf.corrections.capture({ userId: "owner", project: pdf.project,
    successor: { ...pdf.original, versionId: `rv_${"b".repeat(64)}`, digest: "b".repeat(64), supersedesVersionId: pdf.original.versionId },
    correction: { revisionId: `rr_${"c".repeat(64)}`, anchor: { kind: "text", elementId: "x", selectedText: "x" }, instruction: "改", instructionDigest: sha("改"), runId: "revision-run" } });
  const [unreadable] = await pdf.events();
  assert.equal(unreadable.detail.kind, "unknown", "a PDF cannot be compared by its bytes, and that is said rather than called identical");
  assert.equal(unreadable.detail.effects.printedNumbers, "unknown");
});

test("the researcher's words are kept bounded and never when they carry what the sensitive-text rule names; the digest stays", async t => {
  const f = await fixture(t);
  await f.deliver();
  const { directory } = await f.revise("患者姓名是某某，请把这里改掉");
  await f.capture(`${directory}/report.md`, REVISED_REPORT);
  const [event] = await f.events();
  assert.equal(event.detail.instruction, null);
  assert.match(event.detail.instructionDigest, /^[a-f0-9]{64}$/);
  assert.equal(event.detail.kind, "analytic", "the kind never depended on the words");
  assert.ok(Buffer.byteLength(JSON.stringify(event.detail)) <= 4096);
});

test("settling a revision records what the run left, labels renderings unchecked, and queues one lesson for the successor the run ended on", async t => {
  const f = await fixture(t);
  const original = await f.deliver();
  const { stage, directory } = await f.revise();
  await f.capture(`${directory}/report.md`, "合并 OR 为 0.69。\n");
  await new Promise(resolve => setTimeout(resolve, 5));
  const final = await f.capture(`${directory}/report.md`, REVISED_REPORT);
  const docx = await f.capture(`${directory}/report.docx`, "PK-binary");
  await f.capture("notes.md", "unrelated file of the run");
  assert.equal((await f.events()).length, 2, "each version pair is its own immutable event");

  assert.deepEqual(await f.corrections.settle(f.project, f.run), { settled: 1 });
  const row = await f.documents.get("owner", "result-revision", stage.referenceId);
  const outcome = row.payload.outcome;
  assert.equal(outcome.status, "settled");
  assert.equal(outcome.successorVersionId, final.versionId, "the successor the run ended on");
  const byVersion = new Map(outcome.outputs.map(item => [item.versionId, item]));
  assert.equal(outcome.outputs.length, 3, "the draft, the final successor and the rendering");
  assert.equal(byVersion.get(final.versionId).role, "successor");
  assert.deepEqual([byVersion.get(docx.versionId).role, byVersion.get(docx.versionId).format, byVersion.get(docx.versionId).consistency], ["rendering", "docx", "not_checked"]);
  assert.equal(outcome.outputs.filter(item => item.role === "other").length, 1, "the earlier draft");
  assert.ok(outcome.outputs.every(item => item.path.startsWith(directory)), "a file outside the revision's directory is not an output of the correction");
  assert.ok(outcome.settledAt);
  // The original is untouched by any of it.
  assert.equal((await f.results.raw("owner", "p", original.versionId)).bytes.toString(), ORIGINAL_REPORT);

  // One lesson, for the final pair, about the run whose work was corrected, each correction its own dispatch.
  assert.equal(f.jobs.jobs.length, 1);
  const [job] = f.jobs.jobs;
  assert.equal(job.kind, "distill");
  assert.equal(job.payload.runId, "original-run");
  assert.equal(job.payload.trigger, "correction");
  assert.equal(job.payload.feedback.length, 1);
  assert.equal(job.payload.feedback[0].detail.successor.versionId, final.versionId);
  assert.equal(job.payload.dispatchKey, job.payload.feedback[0].id);
  assert.match(job.idempotencyKey, /^distill:original-run:correction:feedback:result-corrected:/);

  // Settling again is a no-op: the record says it is settled and the queue holds the one job.
  assert.deepEqual(await f.corrections.settle(f.project, f.run), { settled: 0 });
  assert.equal(f.jobs.jobs.length, 1);
});

test("a successor the system made on its own is no correction: a recalculation, a file of another request, a copy of the selected bytes", async t => {
  const f = await fixture(t);
  const original = await f.deliver();
  // A recalculation links its successor itself (`resultReplayService.mjs`); nobody asked for it in the composer.
  await f.capture("result-replays/job-1/report.md", REVISED_REPORT, { extra: { supersedesVersionId: original.versionId } });
  // A revision's directory, written by a request that is not the one the selection was bound to.
  const { directory } = await f.revise();
  f.run = { ...f.run, id: "later-run", kernelRequestIds: ["unrelated-request"] };
  await f.capture(`${directory}/report.md`, "A later request has no relationship to the selection.\n");
  f.run = { ...f.run, id: "revision-run", kernelRequestIds: ["submitted-request"] };
  // Bytes identical to the selected version are a copy, not a revision of it.
  await f.capture(`${directory}/report.md`, ORIGINAL_REPORT);
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(f.jobs.jobs, []);
});

test("a revision that left no successor settles as no_successor and learns nothing", async t => {
  const f = await fixture(t);
  await f.deliver();
  const { stage, directory } = await f.revise();
  await f.capture(`${directory}/figure.svg`, "<svg/>");
  await f.corrections.settle(f.project, f.run);
  const row = await f.documents.get("owner", "result-revision", stage.referenceId);
  assert.equal(row.payload.outcome.status, "no_successor");
  assert.equal(row.payload.outcome.successorVersionId, null);
  assert.deepEqual(f.jobs.jobs, []);
  assert.deepEqual(await f.events(), []);
});

test("the lesson passes the same switches as every other: paused learning, the platform's own work, a transcript that cannot be read", async t => {
  for (const [name, options, memory] of [
    ["paused", {}, { settings: async () => ({ pausedProjects: ["p"], learningPaused: false, recallPaused: false }) }],
    ["automated", { runOverrides: { automated: true } }, null],
    ["incomplete transcript", { runOverrides: { transcript: { completeness: "partial" } } }, null],
    ["no queue", { jobsEnabled: false }, null],
  ]) {
    const f = await fixture(t, { ...options, memory });
    await f.deliver();
    const { directory } = await f.revise();
    await f.capture(`${directory}/report.md`, REVISED_REPORT);
    await f.corrections.settle(f.project, f.run);
    assert.deepEqual(f.jobs.jobs, [], name);
    assert.equal((await f.events()).length, 1, `${name}: the fact of the correction is recorded either way`);
  }
  const canceled = await fixture(t);
  canceled.run.status = "canceled";
  await canceled.deliver();
  const { directory } = await canceled.revise();
  await canceled.capture(`${directory}/report.md`, REVISED_REPORT);
  await canceled.corrections.settle(canceled.project, canceled.run);
  assert.deepEqual(canceled.jobs.jobs, [], "a revision the researcher canceled is not a lesson");
});

test("a ledger that cannot be written costs the version nothing, and the failure is reported by code", async t => {
  const f = await fixture(t);
  f.feedback.recordResultCorrection = async () => { throw Object.assign(new Error("ledger down"), { code: "feedback_unavailable" }); };
  const original = await f.deliver();
  const { directory } = await f.revise();
  const successor = await f.capture(`${directory}/report.md`, REVISED_REPORT);
  assert.equal(successor.supersedesVersionId, original.versionId);
  assert.equal((await f.results.raw("owner", "p", successor.versionId)).bytes.toString(), REVISED_REPORT);
  assert.deepEqual(f.audit, [["report", "feedback_unavailable"]]);
});

test("the calculations a correction recomputed are read from the value bindings of the two versions, and the revision's reach is kept", async t => {
  const f = await fixture(t);
  const calcA = await f.capture("calc/original.json", JSON.stringify({ values: { pooled_effect: 0.7134 } }), { run: f.originalRun,
    extra: { machineValues: [{ key: "values.pooled_effect", value: 0.7134, unit: "odds_ratio" }] } });
  await f.deliver(ORIGINAL_REPORT);
  const reportBindings = await f.results.get("owner", "p", f.original.versionId);
  assert.equal(reportBindings.bindings.items[0].calculation.versionId, calcA.versionId);
  const { stage, directory } = await f.revise();
  const staged = await f.documents.get("owner", "result-revision", stage.referenceId);
  assert.deepEqual(staged.payload.reach.calculations, [calcA.versionId], "what the run was told the change could reach");

  const calcB = await f.capture("calc/revised.json", JSON.stringify({ values: { pooled_effect: 0.6812 } }),
    { extra: { machineValues: [{ key: "values.pooled_effect", value: 0.6812, unit: "odds_ratio" }] } });
  await f.capture(`${directory}/report.md`, "合并 OR 为 0.68。\n");
  await f.corrections.settle(f.project, f.run);
  const { outcome } = (await f.documents.get("owner", "result-revision", stage.referenceId)).payload;
  assert.deepEqual(outcome.calculations, [{ key: "values.pooled_effect", unit: "odds_ratio", before: { versionId: calcA.versionId, value: 0.7134 }, after: { versionId: calcB.versionId, value: 0.6812 } }]);
  assert.deepEqual(outcome.reach.calculations, [calcA.versionId]);
});

test("the corrections route answers for a version the caller may read, and for nothing else", async t => {
  const f = await fixture(t);
  const original = await f.deliver();
  const { directory } = await f.revise();
  await f.capture(`${directory}/report.md`, REVISED_REPORT);
  const route = createResultProvenanceRoutes({ service: f.results, corrections: f.corrections,
    store: { ensureSessionUser: async () => ({ user: { id: "owner" } }), requireProject: async () => f.project } });
  const ask = async url => {
    let payload;
    const handled = await route({ method: "GET", url }, { writeHead() {}, end(bytes) { payload = JSON.parse(bytes); } });
    return { handled, payload };
  };
  const answered = await ask(`/api/results/${original.versionId}/corrections?projectId=p`);
  assert.equal(answered.handled, true);
  assert.equal(answered.payload.data.items.length, 1);
  assert.equal(answered.payload.data.items[0].correction.kind, "analytic");
  assert.equal(answered.payload.data.items[0].outcome, null, "not settled until the run ends");
  await assert.rejects(ask(`/api/results/rv_${"9".repeat(64)}/corrections?projectId=p`), { status: 404 });
  await assert.rejects(ask(`/api/results/not-a-version/corrections?projectId=p`), { code: "result_identifier_invalid" });
});

test("a correction is carried to the methods the corrected result's run read once its event is written, and a join that fails costs the event nothing (N14)", async t => {
  const f = await fixture(t);
  const told = [];
  f.corrections.methods = () => ({ fromCorrection: async (project, event) => { told.push([project.id, event.trigger, event.subject.id, event.detail.successor.versionId, event.runId]); } });
  const original = await f.deliver();
  const { directory } = await f.revise();
  const successor = await f.capture(`${directory}/report.md`, REVISED_REPORT);
  assert.deepEqual(told, [["p", "result-corrected", original.versionId, successor.versionId, "original-run"]], "the event, whole, with the run whose work was corrected");

  const g = await fixture(t);
  g.corrections.methods = () => ({ fromCorrection: async () => { throw Object.assign(new Error("the method ledger is down"), { code: "method_ledger_down" }); } });
  await g.deliver();
  const staged = await g.revise();
  const kept = await g.capture(`${staged.directory}/report.md`, REVISED_REPORT);
  assert.equal(kept.supersedesVersionId, g.original.versionId, "the version is captured");
  assert.equal((await g.events()).length, 1, "the event is written");
  assert.deepEqual(g.audit.filter(([kind]) => kind === "report"), [["report", "method_ledger_down"]], "and the failure is said, not swallowed");

  // A deployment with no join is a deployment whose corrections are recorded as they were.
  const h = await fixture(t);
  h.corrections.methods = () => null;
  await h.deliver();
  const unjoined = await h.revise();
  await h.capture(`${unjoined.directory}/report.md`, REVISED_REPORT);
  assert.equal((await h.events()).length, 1);
});
