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
    sources: { list: async () => ({ items: [] }), get: async () => null }, subjectKnown: vcr.subjectKnown, isHumanMessage: async () => true,
    transcript: async () => ({ sessionId: "root", exhausted: true, messages: messages.map((m) => ({ role: "user", source: "user", seq: m.seq, parts: [{ type: "text", text: m.text }] })) }) });
  study = await vcr.store.createStudy({ userId: "owner", projectId: "project", name: "S", question: "q", dataTier: "T0" });
});
after(async () => {
  if (!url) return; await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
const conv = () => ({ ...study, cloudContext: { runId: "run", sessionId: "root" } });
let seq = 0; const say = (text) => { seq += 2; messages.push({ seq, text }); return seq; };
const viewer = { id: "owner" };


const reads = () => vcr.service.packages.matchJudgments;
const readOf = (subjectKey) => reads().forSubject(study, subjectKey, {});

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
  await vcr.candidateSearches.save(study, { subjectKey, request: { condition: "prostate cancer", terms: [] }, found: 12, items: [], rerank: null,
    registries: [{ registry: "clinicaltrials.gov", name: "ClinicalTrials.gov", state: "searched", failed: [] }] });
  assert.equal((await vcr.matchResults.forPatient(study, subjectKey, { viewer })).search, undefined, "every registry answered, nothing for the reader to do");
});


test("the conversation says the name the page shows, also when two people's short names would have met", options, async () => {
  const twin = "P4c1b0f11aaaaaaaa", twin2 = "P4c1b0f11bbbbbbbb";
  const { subjectKey } = await intake(conv(), { messageSeq: say("男性，61 岁。肺癌。") }, origin);
  const store = vcr.matchJudgments;
  await Promise.all([twin, twin2].map((key) => store.save({ studyId: study.id, userId: "owner", subjectKey: key, targetKind: "candidate_trial", targetId: "NCT00000051", targetHash: "t", documentHash: "d", mode: "fit", promptVersion: "p", model: "m",
    thinking: "", producer: "job", status: "done", fit: 70, confidence: 0.6, verdict: "eligible", answer: { reasons: {}, target: { id: "NCT00000051" } } })));
  const page = await vcr.matchResults.forPatient(study, twin, { viewer });
  const read = await readOf(twin);
  assert.equal(read.ranking[0].subjectLabel, page.label, "the same name on both");
  assert.notEqual(page.label, (await readOf(twin2)).ranking[0].subjectLabel, "and a different one for the other");
  assert.ok(subjectKey);
});

test("the clause funnel does not count a clause row that a newer score of other words has overtaken", options, async () => {
  const protocol = await vcr.matchStore.saveProtocolVersion({ studyId: study.id, userId: "owner", title: "F", criteria: [
    { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } } ] });
  const save = (subjectKey, mode, documentHash, answer = {}) => vcr.matchJudgments.save({ studyId: study.id, userId: "owner", subjectKey, targetKind: "protocol_version", targetId: protocol.id, targetHash: "t", documentHash, mode,
    promptVersion: "p", model: "m", thinking: "", producer: "job", status: "done", fit: 80, confidence: 0.7, verdict: "eligible", answer: { reasons: {}, ...answer } });
  const rows = [{ number: 1, kind: "inclusion", clause: "Age >= 18", label: "included", basis: "stated", reason: "r", evidence: [] }];
  await save("FUNNEL-A", "criteria", "d1", { rows }); await save("FUNNEL-A", "fit", "d1");
  await save("FUNNEL-B", "criteria", "d1", { rows }); await save("FUNNEL-B", "fit", "d2");
  const page = await vcr.matchResults.forProtocol(study, protocol.id, { viewer });
  assert.equal(page.clauses.judgedPeople, 1, "B's clause row read an older note than B's score: it is history");
});
