// What a person and a conversation read when a re-judgment failed, when a read comes before the first row, and what an export says of work that was not whole: real PostgreSQL,
// real jobs, doubles for the model and the registry.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
const R = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { ControlPlaneDatabase } = await import(`${R}/src/controlPlaneDatabase.mjs`);
const { ProductDocuments } = await import(`${R}/src/productStore.mjs`);
const { migrateProductStore } = await import(`${R}/src/productPersistence.mjs`);
const { composeVcr } = await import(`${R}/src/vcrComposition.mjs`);
const { createVcrPatientContext } = await import(`${R}/src/vcrPatientContext.mjs`);
const { createVcrUploadReceipts } = await import(`${R}/src/vcrUploadReceipts.mjs`);
const { createGeoTestDatabase } = await import(`${R}/test/helpers/geoTestDatabase.mjs`);
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
let isolated, database, directory, documents, vcr, intake, receipts, project, study;
const origin = { userId: "owner", projectId: "project", rootSessionId: "root", runId: "run", callId: "call" };
const messages = [];
const model = { fit: () => ({ score: 85, confidence: 0.7, eligible_reasons: "1. a", ineligible_reasons: "", missing_information: "", rationale: "r" }), criteria: () => ({ "1": ["年龄", [0], "included"], "2": ["未提及", [], "not excluded"] }), failFit: false, failCriteria: false, calls: 0 };
const CHAT = (content) => new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 40, completion_tokens: 10, prompt_cache_hit_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
const CTGOV = (id) => ({ protocolSection: { identificationModule: { nctId: id, briefTitle: `Trial ${id}` }, descriptionModule: { briefSummary: "Summary" }, statusModule: { overallStatus: "RECRUITING" }, conditionsModule: { conditions: ["Lung"] }, armsInterventionsModule: { interventions: [{ type: "DRUG", name: "Osimertinib" }] }, eligibilityModule: { eligibilityCriteria: "Inclusion Criteria:\n* Age >= 18\nExclusion Criteria:\n* Pregnancy" } } });
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "s15delivery");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner','project','Project',100000000)");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "rvf-"));
  project = { userId: "owner", id: "project", baseDir: path.join(directory, "project") };
  await fs.mkdir(project.baseDir);
  const fetchImpl = async (input, init) => {
    const address = String(input);
    if (address.includes("clinicaltrials.gov")) return new Response(JSON.stringify(CTGOV(/NCT\d{8}/.exec(address)[0])), { status: 200, headers: { "content-type": "application/json" } });
    const body = JSON.parse(init.body); const system = body.messages[0].content; model.calls += 1;
    const isCriteria = system.includes("criterion level");
    if (isCriteria ? model.failCriteria : model.failFit) return new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } });
    const answer = isCriteria ? model.criteria(body) : model.fit(body);
    return CHAT(typeof answer === "string" ? answer : JSON.stringify(answer));
  };
  vcr = composeVcr({ productDatabase: database, fetchImpl, config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: path.join(directory, "plane"), deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "k", deepseekModel: "deepseek-flash", vcrMatchJudgeTopK: 2, vcrMatchJudgeMaxUpstreamFailures: 1000, vcrProviderAgreements: true } });
  await vcr.store.ready();
  documents = new ProductDocuments(database);
  receipts = createVcrUploadReceipts({ documents, sources: null, resolveProject: async () => project });
  vcr.recordsOriginals.receipts = receipts;
  intake = createVcrPatientContext({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, documents: vcr.documents, uploadReceipts: receipts, documentJobs: vcr.patientDocuments,
    sources: { list: async () => ({ items: [] }), get: async () => null }, rejudge: (target, input) => vcr.matchJudge.rejudge(target, input), subjectKnown: vcr.subjectKnown, isHumanMessage: async () => true,
    transcript: async () => ({ sessionId: "root", exhausted: true, messages: messages.map((m) => ({ role: "user", source: "user", seq: m.seq, parts: [{ type: "text", text: m.text }] })) }) });
  study = await vcr.store.createStudy({ userId: "owner", projectId: "project", name: "S", question: "q", dataTier: "T0" });
});
after(async () => {
  if (!url) return; await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
const conv = () => ({ ...study, cloudContext: { runId: "run", sessionId: "root" } });
let seq = 0; const say = (text) => { seq += 2; messages.push({ seq, text }); return seq; };
const runJobs = async () => { for (let t = 0; t < 60; t += 1) { const c = await vcr.jobs.claim({ lane: "slow" }); if (!c.length) return; for (const j of c) await vcr.jobs.advance(j, { mayYield: true }); } assert.fail("no finish"); };
const brief = (p) => p && ({ verdict: p.verdict, fit: p.fit, why: p.why, mark: p.basisChanged?.label, gap: p.recordGap, clausesNote: p.clausesNote });
const viewer = { id: "owner" };
const csv = async (subjectKey, kind = "pairs") => { let out = ""; const f = await vcr.matchResults.exporter(study, { format: "csv", kind, direction: "patient_to_trial", subjectKey, viewer }); await f.run({ write: async (c) => { out += c; } }); return out; };


const reads = () => vcr.service.packages.matchJudgments;
const readOf = (subjectKey) => reads().forSubject(study, subjectKey, {});

test("a re-judgment that failed leaves the last verdict, marked, and the pair owed on the page, the conversation read and the resume", options, async () => {
  const { subjectKey } = await intake(conv(), { messageSeq: say("男性，62 岁。肺腺癌 IV 期。") }, origin);
  await vcr.matchJudge.start(conv(), { subjectKey, registryIds: ["NCT00000001", "NCT00000002"] });
  await runJobs();
  const before = await vcr.matchResults.forPatient(study, subjectKey, { viewer });
  assert.equal(before.progress.state, "done");
  model.failFit = true; model.failCriteria = true;
  await intake(conv(), { messageSeq: say("补充：已怀孕，脑转移。"), subjectKey }, origin);
  await runJobs();
  model.failFit = false; model.failCriteria = false;

  const page = await vcr.matchResults.forPatient(study, subjectKey, { viewer });
  assert.notEqual(page.progress.state, "done");
  assert.equal(page.progress.failed, 2);
  assert.equal(page.failed.count, 2);
  assert.ok(page.failed.listed.every((entry) => entry.reason.includes("重新判定没有完成")));
  assert.equal(page.trials.length, 2, "the last verdict stays on the list");
  assert.ok(page.trials.every((trial) => trial.verdictLabel && trial.clausesNote?.includes("上一次的结论")));

  const read = await readOf(subjectKey);
  assert.notEqual(read.state, "done");
  assert.equal(read.left, 2);
  assert.equal(read.clausesFailed.length, 2);
  assert.ok(read.ranking.every((row) => row.rejudgeFailed?.note && row.verdictLabel));

  assert.equal(page.selected.previous, undefined, "judged once: no reading before");
  const resume = await vcr.matchResults.resumeSelection(study, { direction: "patient_to_trial", subjectKey });
  assert.deepEqual([...resume.ids].sort(), ["NCT00000001", "NCT00000002"]);

  // The model answers again: the continuation clears every mark.
  await vcr.matchJudge.start(conv(), { subjectKey, registryIds: resume.ids, ...resume.settings });
  await runJobs();
  const after = await vcr.matchResults.forPatient(study, subjectKey, { viewer });
  assert.equal(after.progress.state, "done");
  assert.equal(after.failed.count, 0);
  assert.ok(after.trials.every((trial) => !trial.clausesNote));
  // The pair was judged twice, on two notes: the sheet says what the reading before was.
  assert.match(after.selected.previous.line, /^上一次判定（\d{4}-\d{2}-\d{2}）：.+，读的是更早的病历。$/u);
  assert.ok(after.selected.previous.verdictLabel);
});

test("a read right after a job started, before its first row, says it is running and not that nothing is there", options, async () => {
  const { subjectKey } = await intake(conv(), { messageSeq: say("男性，40 岁。胃癌。") }, origin);
  await vcr.matchJudge.start(conv(), { subjectKey, registryIds: ["NCT00000021", "NCT00000022"] });
  const answer = await vcr.service.runtimeRead(study, "candidate_trials", { subjectKey }, { ownerView: true });
  assert.equal(answer.total, 2);
  assert.ok(["running", "stopped"].includes(answer.state), String(answer.state));
  assert.equal(answer.left, 2);
  await runJobs();
});

const jsonExport = async (subjectKey, kind = "pairs") => { let out = ""; const f = await vcr.matchResults.exporter(study, { format: "json", kind, direction: "patient_to_trial", subjectKey, viewer }); await f.run({ write: async (c) => { out += c; } }); return JSON.parse(out); };

test("an export of work that was not whole says so: notes beside the verdict, the failed and unjudged pairs as rows, and how far the job got", options, async () => {
  const { subjectKey } = await intake(conv(), { messageSeq: say("女性，55 岁。乳腺癌。") }, origin);
  model.failCriteria = true;
  await vcr.matchJudge.start(conv(), { subjectKey, registryIds: ["NCT00000011", "NCT00000012"] });
  await runJobs();
  model.failCriteria = false; model.failFit = true;
  await vcr.matchJudge.start(conv(), { subjectKey, registryIds: ["NCT00000013"] });
  await runJobs();
  model.failFit = false;

  const lines = (await csv(subjectKey)).split("\r\n").filter(Boolean);
  assert.ok(lines[0].endsWith("备注"));
  const rows = lines.slice(1);
  assert.ok(rows.some((line) => line.includes("NCT00000011") && line.includes("逐条判定没有完成")), "the owed clause stage is in the row");
  const unjudged = rows.filter((line) => line.includes("未判定"));
  assert.equal(unjudged.length, 1);
  assert.ok(unjudged[0].includes("NCT00000013"));
  assert.ok(rows.some((line) => line.startsWith("判定没有做完")), "a closing line says the job is not whole");
  assert.ok(!rows.some((line) => line.includes("判定作业")), "no job word");

  const file = await jsonExport(subjectKey);
  assert.notEqual(file.progress.state, "done");
  assert.equal(file.progress.finished, 2);
  assert.ok(file.rows.every((row) => /^P-/.test(row.label)));
  assert.ok(file.rows.some((row) => row.verdictLabel === "未判定" && row.target.registryId === "NCT00000013"));
  assert.ok(file.rows.some((row) => row.clausesNote?.includes("逐条判定没有完成")));
  assert.ok(file.unfinishedNote);
});

test("every failure code a pair can carry has words that say what the person can do", async () => {
  const { vcrMatchFailureReason, VCR_MATCH_FAILURE_FALLBACK_ZH } = await import("@evimed/domain");
  for (const code of ["vcr_cloud_processing_not_authorized", "vcr_projection_permission_changed", "vcr_source_withdrawn", "vcr_match_record_changed", "vcr_match_judge_failed"]) {
    const words = vcrMatchFailureReason(code);
    assert.notEqual(words, VCR_MATCH_FAILURE_FALLBACK_ZH, code);
    assert.ok(!/vcr_|_/.test(words), `${code} reads as a code`);
  }
});

test("the patient page carries one line from the newest search for this person: what was searched and which registry did not answer", options, async () => {
  const { subjectKey } = await intake(conv(), { messageSeq: say("男性，70 岁。前列腺癌。") }, origin);
  assert.equal((await vcr.matchResults.forPatient(study, subjectKey, { viewer })).search, undefined, "no search, no line");
  await vcr.candidateSearches.save(study, { subjectKey, request: { condition: "prostate cancer", terms: [] }, found: 12, items: [], rerank: null,
    registries: [{ registry: "clinicaltrials.gov", name: "ClinicalTrials.gov", state: "searched", failed: [] }, { registry: "ctis", name: "CTIS", state: "failed", failed: [{ query: "q", reason: "registry_unavailable" }] }] });
  const page = await vcr.matchResults.forPatient(study, subjectKey, { viewer });
  assert.match(page.search, /共找到 12 个试验/u);
  assert.match(page.search, /ClinicalTrials\.gov 已查/u);
  assert.match(page.search, /CTIS 没查到（登记库暂时没有回答）/u);
  assert.ok(!/registry_|_/.test(page.search), "no code in the line");
});
