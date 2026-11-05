// Judging patients against trials on the real queue and the real table: one record per pair for given inputs, a resumed job finding them, the slow lane taking it, and what
// happens to the rows when a person withdraws, a document is erased or changes, and when a study, a project or an account is deleted. PostgreSQL; the model is a double.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { VCR_TABLES } from "../src/vcrPersistence.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { createMatchJudge, createMatchJudgeExecutor, createMatchJudgmentReads, createPairJudge, judgmentTargets } from "../src/vcrMatchJudge.mjs";
import { VcrMatchJudgmentStore } from "../src/vcrMatchJudgmentStore.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { deleteVcrProjectRows, deleteVcrUserRows } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { streamOf } from "./helpers/vcrIntakeData.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required" };
let database, isolated, directory, vcr, studies, judgments;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrjudge");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-judge-"));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: directory, deepseekBaseUrl: "https://api.example.org", vcrProviderAgreements: true }, productDatabase: database });
  await vcr.store.ready();
  studies = new VcrStore({ database }); judgments = new VcrMatchJudgmentStore({ database });
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

let sequence = 0;
const head = (studyId, extra = {}) => ({ studyId, userId: "owner", subjectKey: "P-1", targetKind: "candidate_trial", targetId: "NCT00000001", targetHash: "t1", documentHash: "d1", mode: "fit",
  promptVersion: "fit-3", model: "deepseek-flash", thinking: "high", producer: "job", status: "done", fit: 70, confidence: 0.5, verdict: "possible", answer: { reasons: { eligible: ["x"] } }, usage: { calls: 1 }, documentIds: ["doc_1"], ...extra });
const newStudy = (userId = "owner", projectId = `prj_${++sequence}`) => studies.createStudy({ userId, projectId, name: `Judge ${sequence}`, question: "q", dataTier: "T0" });
const count = async (studyId) => Number((await studies.one("SELECT count(*)::int AS n FROM evimed_vcr.match_judgments WHERE study_id=$1", [studyId])).n);

test("the table is declared, its vocabularies are held, and a pair is judged once for given inputs", options, async () => {
  assert.ok(VCR_TABLES.includes("match_judgments"));
  const study = await newStudy();
  const first = await judgments.save(head(study.id));
  assert.match(first.id, /^mjd_/);
  assert.deepEqual([first.subjectKey, first.fit, first.confidence, first.verdict, first.answer.reasons.eligible, first.documentIds], ["P-1", 70, 0.5, "possible", ["x"], ["doc_1"]]);
  // A job writing the same key again finds the first row: what was paid for is not overwritten.
  const again = await judgments.save(head(study.id, { fit: 10 }));
  assert.deepEqual([again.id, again.fit], [first.id, 70]);
  assert.equal(await count(study.id), 1);
  // Anything in the key that differs is another judgment: the text on either side, the mode, the prompt, the model, the thinking, the producer.
  for (const [index, extra] of [{ targetHash: "t2" }, { documentHash: "d2" }, { mode: "criteria" }, { promptVersion: "fit-other" }, { model: "other" }, { thinking: "off" }, { producer: "conversation" }].entries()) {
    await judgments.save(head(study.id, extra));
    assert.equal(await count(study.id), 2 + index);
  }
  await assert.rejects(() => judgments.save(head(study.id, { targetKind: "nonsense" })), { code: "23514" });
  await assert.rejects(() => judgments.save(head(study.id, { targetHash: "t9", fit: 101 })), { code: "23514" });
  await assert.rejects(() => judgments.save(head(study.id, { targetHash: "t9", verdict: "maybe" })), { code: "23514" });
});

test("a failed row is replaced by the next try, a conversation's later answer replaces its earlier one, and a job never overwrites a finished row", options, async () => {
  const study = await newStudy();
  const failed = await judgments.save(head(study.id, { status: "failed", errorCode: "model_gateway_upstream_error", fit: null, confidence: null, verdict: null }));
  assert.deepEqual([failed.status, failed.errorCode, failed.fit], ["failed", "model_gateway_upstream_error", null]);
  const done = await judgments.save(head(study.id));
  assert.deepEqual([done.id, done.status, done.errorCode, done.fit], [failed.id, "done", null, 70]);
  const spoken = await judgments.save(head(study.id, { producer: "conversation", promptVersion: "conversation", model: "", thinking: "", fit: 40 }));
  const changed = await judgments.save(head(study.id, { producer: "conversation", promptVersion: "conversation", model: "", thinking: "", fit: 20 }));
  assert.deepEqual([changed.id, changed.fit], [spoken.id, 20]);
  const found = await judgments.doneFor({ studyId: study.id, promptVersions: ["fit-3"], model: "deepseek-flash", thinking: "high" });
  assert.equal(found.size, 1, "the ledger a job resumes from is its own rows under these settings");
  assert.equal([...found.values()][0].fit, 70);
});

test("a study's rows answer by person and by target, newest first, and leave out who withdrew", options, async () => {
  const study = await newStudy();
  await judgments.save(head(study.id));
  await judgments.save(head(study.id, { subjectKey: "P-2", targetKind: "protocol_version", targetId: "pv_1" }));
  assert.deepEqual((await judgments.list({ studyId: study.id, subjectKey: "P-1" })).map((row) => row.targetId), ["NCT00000001"]);
  assert.deepEqual((await judgments.list({ studyId: study.id, targetKind: "protocol_version", targetId: "pv_1" })).map((row) => row.subjectKey), ["P-2"]);
  assert.equal((await judgments.list({ studyId: study.id })).length, 2);
});

/** A study on the composed module with two people, and judgments of each. */
async function people() {
  const target = await vcr.store.createStudy({ userId: "owner", projectId: `prj_${++sequence}`, name: `Synthetic judgments ${sequence}`, question: "q", dataTier: "T0" });
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: target.id, name: "Synthetic notes" });
  const upload = async (text, subject) => (await vcr.dataPlane.storeUpload({ actor: "owner", studyId: target.id, sourceId: source.id, name: "note.txt", role: "document", subject, stream: streamOf(text) })).file;
  const one = await upload("年龄 62 岁。肌酐 1.2 mg/dL。", "WITHDRAWN-REAL-ID");
  const second = await upload("复查：肌酐 1.4 mg/dL。", "WITHDRAWN-REAL-ID");
  const other = await upload("年龄 44 岁。", "KEPT-REAL-ID");
  const s1 = one.detail.subjectKey, s2 = other.detail.subjectKey;
  const row = (subjectKey, documentId, extra = {}) => head(target.id, { subjectKey, documentIds: [documentId], answer: { rows: [{ evidence: [{ text: "年龄 62 岁。", documentId }] }] }, ...extra });
  await vcr.matchJudgments.save(row(s1, one.id, { targetId: "NCT00000001" }));
  await vcr.matchJudgments.save(row(s1, second.id, { targetId: "NCT00000002" }));
  await vcr.matchJudgments.save(row(s2, other.id, { targetId: "NCT00000001" }));
  return { target, source, one, second, other, s1, s2 };
}

test("a withdrawal takes every judgment of the person, keeps the others, and nothing in flight can put one back", options, async () => {
  const f = await people();
  assert.equal(await count(f.target.id), 3);
  await vcr.dataPlane.withdrawSubject({ studyId: f.target.id, actor: "owner", subjectKey: f.s1, reason: "consent withdrawn" });
  assert.deepEqual((await vcr.matchJudgments.list({ studyId: f.target.id })).map((row) => row.subjectKey), [f.s2]);
  const late = await vcr.matchJudgments.save(head(f.target.id, { subjectKey: f.s1, targetId: "NCT00000003" }));
  assert.equal(late, null, "a job that was already holding the text saves nothing");
  assert.equal(await count(f.target.id), 1);
});

test("a person known only by a judgment can withdraw", options, async () => {
  const study = await vcr.store.createStudy({ userId: "owner", projectId: `prj_${++sequence}`, name: `Judgment only ${sequence}`, question: "q", dataTier: "T0" });
  await vcr.matchJudgments.save(head(study.id, { subjectKey: "ONLY-JUDGED" }));
  const withdrawn = await vcr.erasure.withdrawSubject({ studyId: study.id, userId: "owner", actor: "owner", subjectKey: "ONLY-JUDGED" });
  assert.equal(withdrawn.counts.matchJudgmentsRemoved, 1);
  assert.equal(await count(study.id), 0);
});

test("a document's erasure takes the judgments that read it, and only those", options, async () => {
  const f = await people();
  await vcr.erasure.eraseDocuments({ studyId: f.target.id, userId: "owner", actor: "owner", fileIds: [f.one.id] });
  assert.deepEqual((await vcr.matchJudgments.list({ studyId: f.target.id })).map((row) => row.targetId).sort(), ["NCT00000001", "NCT00000002"].sort());
  assert.ok((await vcr.matchJudgments.list({ studyId: f.target.id })).every((row) => !row.documentIds.includes(f.one.id)));
});

test("a document nobody froze, deleted, takes its judgments with it", options, async () => {
  const f = await people();
  const removed = await vcr.dataStore.deleteSourceFile({ studyId: f.target.id, fileId: f.second.id, actor: "owner" });
  assert.equal(removed.frozen, false);
  assert.deepEqual((await vcr.matchJudgments.list({ studyId: f.target.id, subjectKey: f.s1 })).map((row) => row.targetId), ["NCT00000001"]);
});

test("a changed document or permission labels the judgments that read it, and blocks nothing", options, async () => {
  const f = await people();
  await vcr.erasure.markBasisChanged({ studyId: f.target.id, cause: "permission", causeId: f.source.id, documentIds: [f.one.id] });
  const rows = await vcr.matchJudgments.list({ studyId: f.target.id, subjectKey: f.s1 });
  assert.equal(rows.find((row) => row.targetId === "NCT00000001").basisChanged, "permission");
  assert.equal(rows.find((row) => row.targetId === "NCT00000002").basisChanged, null);
  await vcr.erasure.markSubjectChanged({ studyId: f.target.id, subjectKey: f.s2, cause: "document", causeId: "doc_new" });
  assert.equal((await vcr.matchJudgments.list({ studyId: f.target.id, subjectKey: f.s2 }))[0].basisChanged, "document");
  // A new judgment of the same text clears nothing it did not replace; a finished row's label stays until it is judged again.
  const relabelled = await vcr.matchJudgmentReads.forSubject(f.target, f.s2);
  assert.match(relabelled.ranking[0].restsOnOlder, /病历在判定之后有更新/u);
  assert.equal(relabelled.ranking[0].basisChanged, undefined, "the stored cause word is not what a conversation reads");
});

test("a study's deletion hides its judgments from every reader, as it hides its facts; the rows stay with the soft-deleted study", options, async () => {
  const f = await people();
  await vcr.store.softDeleteStudy(f.target.id, "owner");
  assert.equal(await count(f.target.id), 3);
  assert.equal(await vcr.store.studyById(f.target.id), null);
});

test("a project's deletion takes its judgments in the same transaction", options, async () => {
  const study = await newStudy("owner_p");
  await judgments.save(head(study.id, { userId: "owner_p" }));
  assert.equal(await count(study.id), 1);
  const { deleted } = await database.transaction((client) => deleteVcrProjectRows(client, "owner_p", study.projectId));
  assert.equal(deleted, true);
  assert.equal(await count(study.id), 0);
});

test("an account's deletion takes its judgments in the same transaction", options, async () => {
  const study = await newStudy("owner_a");
  await judgments.save(head(study.id, { userId: "owner_a" }));
  const { deleted } = await database.transaction((client) => deleteVcrUserRows(client, "owner_a"));
  assert.equal(deleted, true);
  assert.equal(await count(study.id), 0);
});

test("a study that holds only judgments reads as a matching study", options, async () => {
  const study = await vcr.store.createStudy({ userId: "owner", projectId: `prj_${++sequence}`, name: `Held ${sequence}`, question: "q", dataTier: "T0" });
  await vcr.matchJudgments.save(head(study.id));
  assert.deepEqual(await vcr.store.heldTabs(study.id), ["matching"]);
});

test("the model reads through the service: a person's ranking, a protocol's people, numbered sentences and clauses, and today's answer where nothing was judged", options, async () => {
  const f = await people();
  const context = { ...f.target, cloudContext: { runId: "run_judge", sessionId: "session_judge" } };
  const sentences = await vcr.service.runtimeRead(context, "subject_document", { subjectKey: f.s2, kind: "sentences" });
  assert.deepEqual(sentences.sentences.map((row) => row.text), ["年龄 44 岁。"]);
  assert.match(sentences.documentHash, /^[a-f0-9]{64}$/);
  const read = await vcr.service.runtimeRead(context, "candidate_trials", { subjectKey: f.s2 });
  assert.deepEqual(read.ranking.map((row) => row.target.id), ["NCT00000001"]);
  assert.deepEqual([read.ranking[0].verdict, read.ranking[0].verdictLabel, read.ranking[0].fit], ["possible", "可能符合", 70]);
  const nobody = await vcr.service.runtimeRead(context, "candidate_trials", { subjectKey: "NO-ONE" });
  assert.deepEqual(nobody.ranking, [], "a person with no judgment reads today's answer");
  assert.equal("requests" in nobody, false, "no write can answer a language request, so none is offered");
  await vcr.matchJudgments.save(head(f.target.id, { subjectKey: f.s1, targetKind: "protocol_version", targetId: "prt_x", documentIds: [f.one.id] }));
  const protocol = await vcr.service.runtimeRead(context, "matching", { protocolVersionId: "prt_x" });
  assert.deepEqual(protocol.ranking.map((row) => [row.subjectKey, row.target.kind]), [[f.s1, "protocol_version"]]);
  assert.deepEqual(protocol.clauses, []);
});

/** A judging job on the real queue and the real table, with the model and the registry as doubles. */
async function queued({ script = null, concurrency = 2 } = {}) {
  const study = await newStudy("owner_q", `prj_q${++sequence}`);
  const records = { async roster() { return [{ id: "d1", subjectKey: "P-1", chars: 9 }]; }, async runtimeRead(_s, { documentId }) { return { id: documentId, text: "男性，70 岁。肺腺癌。", sourceHash: "h1" }; }, async runtimeEvidence(_s, entries) { return entries; } };
  const calls = [];
  const callModel = async (_d, call) => {
    calls.push(call);
    const scripted = script?.(call, calls.length);
    if (scripted) throw scripted;
    const criterion = call.body.messages[0].content.includes("criterion level");
    return { choices: [{ finish_reason: "stop", message: { content: criterion ? '{"1":["理由",[0],"included"]}' : '{"score":80,"confidence":0.7,"eligible_reasons":"1. a","missing_information":"","ineligible_reasons":""}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const config = { vcrJobCpuSeconds: 60, vcrStudyCpuBudget: 1000, vcrMaxConcurrentJobs: 1, vcrLocalConcurrency: 2, vcrMatchJudgeConcurrency: concurrency, deepseekModel: "deepseek-flash" };
  const matching = { async withdrawnSubjects() { return new Set(); }, listCriteria: async () => [], latestProtocol: async () => null };
  const jobs = new VcrJobs({ store: studies, config });
  const targets = judgmentTargets({ matchStore: matching, evidence: { async judgmentRecord({ registryId }) { return { status: "ok", trial: { registry: "clinicaltrials.gov", registryId, title: "T", summary: "S", eligibility: "Inclusion Criteria:\n* Age >= 18", conditions: [], interventions: [] } }; } } });
  jobs.localExecutors["matching.judge"] = createMatchJudgeExecutor({ store: studies, matchStore: matching, judgments, documents: records, targets, judge: createPairJudge({ config, callModel, sleep: async () => {} }), config });
  const start = createMatchJudge({ jobs, matchStore: matching, documents: records, config });
  return { study, jobs, start, calls, targets, reads: createMatchJudgmentReads({ judgments, documents: records, targets, matchStore: matching }) };
}

const SELECTION = { subjectKey: "P-1", registryIds: ["NCT00000001", "NCT00000002"], topK: 1 };

test("a judging job is queued by the platform alone, held to its frozen shape, and taken by the slow lane and no other", options, async () => {
  const f = await queued();
  await assert.rejects(() => f.jobs.enqueue({ studyId: f.study.id, userId: f.study.userId, kind: "match_judge", scenario: {}, cpuSecondsLimit: 60 }), { code: "vcr_job_scenario_invalid" });
  const started = await f.start.start(f.study, SELECTION);
  assert.equal(started.state, "queued");
  const row = await studies.one("SELECT method, method_version, state, max_attempts FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]);
  assert.deepEqual([row.method, row.method_version, row.state, row.max_attempts], ["matching.judge", "1.0.0", "queued", 5]);
  assert.deepEqual(await f.jobs.claim({ lane: "local" }), []);
  assert.deepEqual(await f.jobs.claim({ lane: "engine" }), []);
  assert.deepEqual((await f.jobs.claim({ lane: "slow" })).map((job) => job.id), [started.jobId]);
  await studies.query("UPDATE evimed_vcr.jobs SET state='canceled', lease_owner=NULL, lease_until=NULL WHERE id=$1", [started.jobId]);
});

test("a job runs on the queue, writes the rows and a result that says what it did, and a second start pays for nothing", options, async () => {
  const f = await queued();
  const started = await f.start.start(f.study, SELECTION);
  const [claimed] = await f.jobs.claim({ lane: "slow" });
  assert.equal((await f.jobs.advance(claimed)).action, "finished");
  const job = await studies.one("SELECT state FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]);
  assert.equal(job.state, "succeeded");
  assert.equal(f.calls.length, 3, "two trial-level calls and one clause-level");
  const result = await studies.one("SELECT kind, conclusion, diagnostics, measures FROM evimed_vcr.results WHERE study_id=$1", [f.study.id]);
  assert.deepEqual([result.kind, result.conclusion], ["match_judge", "estimable"]);
  assert.deepEqual([result.diagnostics.finished, result.diagnostics.total, result.diagnostics.used.calls], [2, 2, 3]);
  const stored = await judgments.list({ studyId: f.study.id });
  assert.equal(stored.length, 3);
  assert.ok(stored.every((row) => row.producer === "job" && row.jobId === started.jobId && row.model === "deepseek-flash" && row.thinking === (row.mode === "fit" ? "off" : "high") && row.status === "done"));
  const read = await f.reads.forSubject(f.study, "P-1");
  assert.deepEqual(read.ranking.map((row) => row.verdict).sort(), ["eligible", "eligible"]);
  const next = await f.start.start(f.study, SELECTION);
  assert.notEqual(next.jobId, started.jobId, "a new attempt after the first has ended");
  const [again] = await f.jobs.claim({ lane: "slow" });
  await f.jobs.advance(again);
  assert.equal(f.calls.length, 3, "and the ledger pays for nothing twice");
});

test("a re-claimed job after a worker dies does the rest and nothing twice", options, async () => {
  let dead = true;
  const f = await queued({ concurrency: 1, script: (_call, index) => (dead && index === 2 ? Object.assign(new Error("gone"), { code: "worker_died" }) : null) });
  await f.start.start(f.study, { ...SELECTION, topK: 0 });
  const [claimed] = await f.jobs.claim({ lane: "slow" });
  await f.jobs.advance(claimed);
  assert.equal(f.calls.length, 2);
  dead = false;
  await f.start.start(f.study, { ...SELECTION, topK: 0 });
  const [resumed] = await f.jobs.claim({ lane: "slow" });
  await f.jobs.advance(resumed);
  assert.equal(f.calls.length, 3, "only the pair with no finished row");
  const rows = await judgments.list({ studyId: f.study.id });
  assert.ok(rows.every((row) => row.status === "done"), "the failed row was replaced");
});

test("nothing finished is a failed job with its reason on the row, never a success", options, async () => {
  const quota = Object.assign(new Error("over"), { code: "insufficient_quota" });
  const f = await queued({ script: () => quota });
  const started = await f.start.start(f.study, SELECTION);
  const [claimed] = await f.jobs.claim({ lane: "slow" });
  await f.jobs.advance(claimed);
  const job = await studies.one("SELECT state, error FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]);
  assert.equal(job.state, "failed");
  assert.equal(job.error.code, "insufficient_quota");
  assert.equal((await studies.rows("SELECT 1 FROM evimed_vcr.results WHERE study_id=$1", [f.study.id])).length, 0);
});

const CHAT = (content) => new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 40, completion_tokens: 10, prompt_cache_hit_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
const CTGOV = (id) => ({ protocolSection: { identificationModule: { nctId: id, briefTitle: `Trial ${id}` }, descriptionModule: { briefSummary: "Summary" }, statusModule: { overallStatus: "RECRUITING" }, conditionsModule: { conditions: ["NSCLC"] }, designModule: { phases: ["PHASE2"] },
  armsInterventionsModule: { interventions: [{ type: "DRUG", name: "Osimertinib" }] }, eligibilityModule: { eligibilityCriteria: "Inclusion Criteria:\n* Age >= 18\nExclusion Criteria:\n* Pregnancy" } } });

test("the whole path on the composed module: a record read through the plane, a live registry, a model double, the saved ranking and a conversation's write", options, async () => {
  /** @type {string[]} */ const asked = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.includes("clinicaltrials.gov")) { asked.push(url); return new Response(JSON.stringify(CTGOV(/NCT\d{8}/.exec(url)[0])), { status: 200, headers: { "content-type": "application/json" } }); }
    const body = JSON.parse(init.body);
    assert.equal(body.model, "deepseek-flash");
    const system = body.messages[0].content;
    asked.push(system.includes("criterion level") ? "criteria" : "fit");
    return CHAT(system.includes("criterion level") ? '{"1":["年龄 62 岁",[0],"included"],"2":["未提及妊娠",[],"not excluded"]}' : '{"score":85,"confidence":0.7,"eligible_reasons":"1. 年龄符合","missing_information":"","ineligible_reasons":"","rationale":"1. 符合"}');
  };
  const config = { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: directory, deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrProviderAgreements: true, vcrMatchJudgeTopK: 1, vcrMatchJudgeConcurrency: 2, vcrLocalConcurrency: 2 };
  const composed = composeVcr({ config, productDatabase: database, fetchImpl });
  await composed.store.ready();
  const target = await composed.store.createStudy({ userId: "owner", projectId: `prj_${++sequence}`, name: `Whole path ${sequence}`, question: "q", dataTier: "T0" });
  const source = await composed.dataPlane.registerSource({ userId: "owner", studyId: target.id, name: "Synthetic notes" });
  const upload = async (text, subject) => (await composed.dataPlane.storeUpload({ actor: "owner", studyId: target.id, sourceId: source.id, name: "note.txt", role: "document", subject, stream: streamOf(text) })).file;
  const file = await upload("年龄 62 岁。肺腺癌 IV 期。", "A-REAL-ID");
  const subjectKey = file.detail.subjectKey;

  const started = await composed.matchJudge.start(target, { subjectKey, registryIds: ["NCT00000001", "NCT00000002"] });
  assert.equal(started.state, "queued", JSON.stringify(started));
  assert.match(started.statement, /判定 2 对/);
  const [claimed] = await composed.jobs.claim({ lane: "slow" });
  const ended = await composed.jobs.advance(claimed);
  assert.equal(ended.action, "finished");
  assert.deepEqual(asked.filter((entry) => entry === "fit" || entry === "criteria").sort(), ["criteria", "fit", "fit"]);
  assert.equal(asked.filter((entry) => entry.includes("clinicaltrials.gov")).length, 2, "a registry record is read once for the job");

  const row = await composed.store.one("SELECT conclusion, diagnostics FROM evimed_vcr.results WHERE study_id=$1", [target.id]);
  assert.deepEqual([row.conclusion, row.diagnostics.finished, row.diagnostics.total, row.diagnostics.used.calls], ["estimable", 2, 2, 3]);
  assert.equal(row.diagnostics.used.currency, "CNY");
  assert.ok(row.diagnostics.used.cost > 0);

  const context = { ...target, cloudContext: { runId: "run_whole", sessionId: "session_whole" } };
  const read = await composed.service.runtimeRead(context, "candidate_trials", { subjectKey });
  assert.equal(read.ranking.length, 2);
  const first = read.ranking[0];
  assert.deepEqual([first.target.registry, first.verdict, first.verdictLabel, first.fit, first.eligibilitySource], ["clinicaltrials.gov", "eligible", "符合", 85, "registry"]);
  assert.deepEqual(first.criteria.map((entry) => [entry.number, entry.display]), [[1, "符合"], [2, "未见记载，按未排除"]]);
  assert.deepEqual(first.criteria[0].evidence.map((item) => [item.text, item.documentId]), [["年龄 62 岁。", file.id]], "evidence read back from the record, under the cloud path");

  const { documentHash, sentences } = await composed.service.runtimeRead(context, "subject_document", { subjectKey, kind: "sentences" });
  assert.deepEqual(sentences.map((entry) => entry.id), [0, 1]);
  const written = await composed.matchJudgmentReads.writeConversation(context, { subjectKey, registryId: "NCT00000003", fit: 12, confidence: 0.9, reasons: { ineligible: ["诊断不符"] },
    criteria: [{ number: 1, reason: "62 岁", sentenceIds: [0], label: "included" }, { number: 2, reason: "妊娠", sentenceIds: [1], label: "excluded" }], documentHash });
  assert.deepEqual([written.verdict, written.notices], ["ineligible", []]);
  const after = await composed.service.runtimeRead(context, "candidate_trials", { subjectKey });
  assert.deepEqual(after.ranking.map((entry) => entry.target.id), ["NCT00000001", "NCT00000002", "NCT00000003"], "a stated disqualifier sorts last");
  assert.equal(after.ranking[2].producer, "conversation");

  // A withdrawal takes all of it, and the read says the person is gone.
  await composed.dataPlane.withdrawSubject({ studyId: target.id, actor: "owner", subjectKey, reason: "consent withdrawn" });
  assert.equal(await count(target.id), 0);
  assert.equal((await composed.service.runtimeRead(context, "candidate_trials", { subjectKey })).withdrawn, true);
  assert.equal((await composed.service.runtimeRead(context, "subject_document", { subjectKey, kind: "sentences" })).code, "vcr_document_withdrawn");
});
