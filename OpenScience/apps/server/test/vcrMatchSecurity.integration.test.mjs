// What the security review of the patient matching branch ran, kept as tests. A real plane, queue, receipts and tables on PostgreSQL; the model, the parser and the registry are doubles. A run with a shell
// plants links beside the originals, a document or a person goes while a job holds their text, a withdrawn person is imported again, a table has no header row, a job meets its ceiling.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { VCR_MATCH_JUDGE_LIMITS } from "@evimed/domain";
import { strToU8, zipSync } from "fflate";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { vcrCloudDestinationNotes } from "../src/vcrCloudProjection.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { createVcrDataIntake } from "../src/vcrDataIntake.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { createMatchJudgeCounters, createMatchJudgeExecutor, planMatchJudge } from "../src/vcrMatchJudge.mjs";
import { createRecordsImportExecutor } from "../src/vcrRecordsImport.mjs";
import { createVcrUploadReceipts } from "../src/vcrUploadReceipts.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required", timeout: 120_000 };
const openpyxl = (() => { try { execFileSync("python3", ["-c", "import openpyxl"], { stdio: "ignore" }); return true; } catch { return false; } })();
let isolated, database, directory, documents, vcr, intake, receipts, project, parser, proposal, sequence = 0, parserCalls = 0;
let modelBodies = [];
const origin = { userId: "owner", projectId: "project", rootSessionId: "root", runId: "run", callId: "call" };
const ID_NUMBER = "110101199003078888";
const SECRET = `患者李四，身份证号 ${ID_NUMBER}。`;

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "s9sec");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development')");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-s9-"));
  const fetchImpl = async (_url, init) => {
    modelBodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  parser = { configured: true, async parseBytes({ filename }) { parserCalls += 1; return { text: `扫描件文字 ${filename}`, extractor: { name: "x", version: "t" } }; } };
  vcr = composeVcr({ productDatabase: database, fetchImpl, documentParser: parser, config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: path.join(directory, "plane"), deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrProviderAgreements: true, vcrRecordsImportSliceEntries: 2, vcrRecordsImportConcurrency: 1 } });
  await vcr.store.ready();
  documents = new ProductDocuments(database);
  receipts = createVcrUploadReceipts({ documents, sources: null, resolveProject: async () => project });
  vcr.recordsOriginals.receipts = receipts;
  intake = createVcrDataIntake({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, sources: receipts, resolveProject: async () => project, recordsImport: vcr.recordsImport });
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

const newStudy = async () => {
  const id = `project-${++sequence}`;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner',$1,'Project',1000000000)", [id]);
  project = { userId: "owner", id, baseDir: path.join(directory, id) };
  await fs.mkdir(project.baseDir);
  origin.projectId = id;
  return vcr.store.createStudy({ userId: "owner", projectId: id, name: `S9 ${sequence}`, question: "q", dataTier: "T0" });
};
const drain = async (each = async () => {}) => {
  for (let turn = 0; turn < 200; turn += 1) {
    const claimed = await vcr.jobs.claim({ lane: "slow" });
    if (!claimed.length) return turn;
    for (const job of claimed) await vcr.jobs.advance(job, { mayYield: true });
    await each(turn);
  }
  assert.fail("the job did not finish");
};
const resultOf = (jobId) => vcr.store.one("SELECT r.conclusion, r.diagnostics, r.measures FROM evimed_vcr.results r JOIN evimed_vcr.executions e ON e.id = r.execution_id WHERE e.job_id=$1 ORDER BY r.created_at DESC LIMIT 1", [jobId]);
const jobRow = (jobId) => vcr.store.one("SELECT state,error,checkpoint FROM evimed_vcr.jobs WHERE id=$1", [jobId]);
const importRows = async (study, name, csv) => {
  const handle = await receipts.record(project, { name, bytes: Buffer.from(csv, "utf8"), sessionId: "root" });
  return { handle, started: await intake(study, { action: "import_documents", ...handle }, origin) };
};
const NOTES = { tables: [{ input: 0, role: "notes", subject: "PID", text: ["NOTE"] }], files: null };
const originalOf = (handle, name) => path.join(project.baseDir, `.evimed-upload-originals/${handle.sha256}/${name}`);
const stored = async (study) => (await vcr.dataStore.listSourceFilesForStudy(study.id)).filter((row) => row.role === "document" && !row.erasedAt);

// ---------------------------------------------------------------------------- B1

test("B1: an original replaced by a link is not read: the import skips it and no document holds the file it pointed at", options, async () => {
  const study = await newStudy();
  const outside = path.join(directory, `other-tenant-${sequence}.txt`);
  await fs.writeFile(outside, "OTHER-TENANT-FILE key=not-a-real-key\n");
  const handle = await receipts.record(project, { name: "p1_note.txt", bytes: Buffer.from("a harmless note", "utf8"), sessionId: "root" });
  await fs.rm(originalOf(handle, "p1_note.txt"));
  await fs.symlink(outside, originalOf(handle, "p1_note.txt"));
  proposal = { tables: [], files: { subject: { from: "stem_part", separator: "_", index: 0 } } };
  const started = await intake(study, { action: "import_documents", ...handle }, origin);
  await drain();
  assert.deepEqual(await stored(study), [], "nothing was taken from behind the link");
  assert.equal((await jobRow(started.jobId)).error.code, "vcr_import_original_changed");
});

test("B1: a link on the original's folder, and bytes rewritten in place, are refused the same way", options, async () => {
  const study = await newStudy();
  const elsewhere = path.join(directory, `elsewhere-${sequence}`);
  await fs.mkdir(elsewhere);
  await fs.writeFile(path.join(elsewhere, "p2_note.txt"), "same length note!");
  const linked = await receipts.record(project, { name: "p2_note.txt", bytes: Buffer.from("same length note.", "utf8"), sessionId: "root" });
  const folder = path.dirname(originalOf(linked, "p2_note.txt"));
  await fs.rm(folder, { recursive: true });
  await fs.symlink(elsewhere, folder);
  const rewritten = await receipts.record(project, { name: "p3_note.txt", bytes: Buffer.from("the bytes the receipt holds", "utf8"), sessionId: "root" });
  await fs.writeFile(originalOf(rewritten, "p3_note.txt"), "the bytes a run wrote later");
  proposal = { tables: [], files: { subject: { from: "stem_part", separator: "_", index: 0 } } };
  const started = await intake(study, { action: "import_documents", sources: [linked, rewritten] }, origin);
  await drain();
  assert.deepEqual(await stored(study), []);
  assert.equal((await jobRow(started.jobId)).error.code, "vcr_import_original_changed");
});

test("B1: a link planted beside a workbook is not written through, and the original is read from where a run cannot reach", { ...options, skip: options.skip || (!openpyxl && "openpyxl is not installed") }, async () => {
  const study = await newStudy();
  const book = path.join(directory, `book-${sequence}.xlsx`);
  execFileSync("python3", ["-c", "import openpyxl,sys\nb=openpyxl.Workbook();s=b.active;s.append(['PID','NOTE']);s.append(['P1','一份病历']);b.save(sys.argv[1])", book]);
  const handle = await receipts.record(project, { name: "notes.xlsx", bytes: await fs.readFile(book), sessionId: "root" });
  const victim = path.join(directory, `control-plane-${sequence}.conf`);
  await fs.writeFile(victim, "original contents\n");
  await fs.symlink(victim, `${originalOf(handle, "notes.xlsx")}.converted.csv`);
  proposal = NOTES;
  await intake(study, { action: "import_documents", ...handle }, origin);
  await drain();
  assert.equal(await fs.readFile(victim, "utf8"), "original contents\n");
  assert.equal((await stored(study)).length, 1, "the workbook itself was read");
  const stage = path.join(directory, "plane", "studies", study.id, "job-originals");
  assert.deepEqual(await fs.readdir(stage).catch(() => []), [], "the staged copy goes when the job ends");
});

test("B1: an archive behind a link, and a standard import's original behind a link, are refused", options, async () => {
  const study = await newStudy();
  const outsideZip = path.join(directory, `outside-${sequence}.zip`);
  await fs.writeFile(outsideZip, zipSync({ "P9_a.txt": strToU8("其他账户的病历文字") }));
  const zipped = await receipts.record(project, { name: "notes.zip", bytes: Buffer.from(zipSync({ "P1_a.txt": strToU8("收据里的文字") })), sessionId: "root" });
  await fs.rm(originalOf(zipped, "notes.zip"));
  await fs.symlink(outsideZip, originalOf(zipped, "notes.zip"));
  proposal = { tables: [], files: { subject: { from: "stem_part", separator: "_", index: 0 } } };
  await intake(study, { action: "import_documents", ...zipped }, origin);
  await drain();
  assert.deepEqual(await stored(study), []);

  const standardStudy = await newStudy();
  const outside = path.join(directory, `fhir-${sequence}.ndjson`);
  await fs.writeFile(outside, "OTHER-TENANT-BYTES");
  const standard = await receipts.record(project, { name: "export.ndjson", bytes: Buffer.from('{"resourceType":"Patient"}\n', "utf8"), sessionId: "root" });
  await fs.rm(originalOf(standard, "export.ndjson"));
  await fs.symlink(outside, originalOf(standard, "export.ndjson"));
  const real = vcr.dataPlane.importStandard;
  let handed = null;
  vcr.dataPlane.importStandard = async ({ stream }) => { const parts = []; for await (const chunk of stream) parts.push(Buffer.from(chunk)); handed = Buffer.concat(parts).toString(); throw Object.assign(new Error("stop here"), { code: "vcr_test_stop" }); };
  try {
    const started = await intake(standardStudy, { action: "import_standard", ...standard, format: "fhir" }, origin);
    await drain();
    assert.equal(handed, null, "the converter was never handed the bytes behind the link");
    assert.equal((await jobRow(started.jobId)).error.code, "vcr_import_original_changed");
  } finally { vcr.dataPlane.importStandard = real; }
});

// ---------------------------------------------------------------------------- B2

const fakeTargets = { trial: async ({ registryId }) => ({ kind: "candidate_trial", id: registryId, title: "T", summary: "", eligibility: "Inclusion Criteria:\n* 成年", conditions: [], interventions: [], clauses: [{ number: 1, kind: "inclusion", text: "成年", start: 0, end: 2 }], hash: `h${registryId}`, eligibilitySource: "registry",
  summaryOfTarget: { kind: "candidate_trial", id: registryId, registry: "clinicaltrials.gov", registryId, title: "T" } }) };
const TRIALS = ["NCT00000001", "NCT00000002", "NCT00000003", "NCT00000004", "NCT00000005"];
const answerFor = (said) => (said.includes("sentence_id") ? JSON.stringify({ 1: ["理由", [0], "included"] }) : JSON.stringify({ score: 90, confidence: 0.9, eligible_reasons: `1. ${said.includes(ID_NUMBER) ? ID_NUMBER : "成年"}`, ineligible_reasons: "", missing_information: "", rationale: "x" }));

/** A real executor over a real plane and table; `onFirstCall` happens while the first model call is out. */
async function holdingJob({ text = SECRET, more = null, onFirstCall, selection = {}, config = {}, cost = 0.001, counters = createMatchJudgeCounters() }) {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "n" });
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "REAL-ID", stream: Readable.from([Buffer.from(text)]) });
  const other = more ? await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "m.txt", role: "document", subject: "REAL-ID", stream: Readable.from([Buffer.from(more)]) }) : null;
  const key = String(up.file.detail.subjectKey);
  const built = await planMatchJudge({ study, selection: { subjectKey: key, registryIds: TRIALS, fit: true, topK: 2, thinking: "off", thinkingCriteria: "off", ...selection }, matchStore: vcr.matchStore, documents: vcr.documents, config: {} });
  const calls = [];
  let first = true;
  const judge = { model: "deepseek-flash", maxTokens: 1000, timeoutMs: 1000, call: async ({ messages }) => {
    const said = messages.map((message) => message.content).join("\n");
    calls.push({ afterTheEvent: !first, carries: said.includes(ID_NUMBER) });
    if (first) { first = false; await onFirstCall?.({ study, key, file: up.file, other: other?.file, source }); }
    return { content: answerFor(said), usage: { inputTokens: 10, outputTokens: 10, cacheHitTokens: 0, reasoningTokens: 0 }, cost, currency: "CNY" };
  } };
  const executor = createMatchJudgeExecutor({ store: vcr.store, matchStore: vcr.matchStore, judgments: vcr.matchJudgments, documents: vcr.documents, targets: fakeTargets, judge, counters, config: { vcrMatchJudgeConcurrency: 1, ...config } });
  const jobId = `job_s9_${sequence}`;
  const result = await executor({ job: { studyId: study.id, id: jobId, jobId, scenario: built.scenario, scenarioHash: "" }, onProgress: async () => {} });
  const rows = (await database.query("SELECT mode, status, answer, usage FROM evimed_vcr.match_judgments WHERE study_id=$1 AND subject_key=$2", [study.id, key])).rows;
  const after = calls.filter((call) => call.afterTheEvent);
  return { study, key, file: up.file, other: other?.file, source, result, calls, after, rows, carrying: after.filter((call) => call.carries).length, quoting: rows.filter((row) => JSON.stringify(row.answer).includes(ID_NUMBER)).length, plan: built };
}

test("B2: a document deleted while a job holds the note: no later call carries it, and no row quotes it", options, async () => {
  const held = await holdingJob({ onFirstCall: ({ study, file }) => vcr.dataPlane.removeUpload({ actor: "owner", studyId: study.id, fileId: file.id }) });
  assert.equal(held.carrying, 0);
  assert.equal(held.quoting, 0);
  assert.equal(held.rows.filter((row) => row.status === "done").length, 0, "the person has nothing else on record");
  assert.equal(held.result.diagnostics.finished, 0);
});

test("B2: with a second document, the pairs go on with what is left, and the deleted text stays out", options, async () => {
  const held = await holdingJob({ more: "另一份病历：肌酐 1.0。", onFirstCall: ({ study, file }) => vcr.dataPlane.removeUpload({ actor: "owner", studyId: study.id, fileId: file.id }) });
  assert.equal(held.carrying, 0);
  assert.equal(held.quoting, 0);
  assert.ok(held.rows.some((row) => row.status === "done"), "the record that remains is judged");
});

test("B2: a person withdrawn while a job holds the note: no more calls carry their text and no row is kept", options, async () => {
  const held = await holdingJob({ onFirstCall: ({ study, key }) => vcr.dataPlane.withdrawSubject({ studyId: study.id, subjectKey: key, actor: "owner", reason: "t" }) });
  assert.equal(held.after.length, 0, "no further call for this person");
  assert.equal(held.rows.length, 0);
  assert.equal(held.result.status, "failed");
});

test("B2: a retired projection and a revoked source stop the calls the same way", options, async () => {
  const revoked = await holdingJob({ onFirstCall: ({ study, source }) => vcr.dataPlane.setCloudPermission({ studyId: study.id, sourceId: source.id, actor: "owner", permission: { status: "revoked" } }) });
  assert.equal(revoked.carrying, 0, "a revoked source's text does not leave again");
});

test("B2: a save between a withdrawal's delete and its commit does not survive it", options, async () => {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "n" });
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "RACE", stream: Readable.from([Buffer.from(SECRET)]) });
  const key = String(up.file.detail.subjectKey);
  const row = (extra = {}) => ({ studyId: study.id, userId: "owner", subjectKey: key, targetKind: "candidate_trial", targetId: "NCT09999999", targetHash: "t", documentHash: "d", mode: "criteria", promptVersion: "criteria-3", model: "m", thinking: "off", producer: "job", status: "done", verdict: "possible", answer: { rows: [{ number: 1, kind: "inclusion", clause: "c", label: "included", basis: "stated", reason: ID_NUMBER }] }, ...extra });
  await vcr.matchJudgments.save(row({ targetId: "NCT08888888" }));
  // A table lock that lets reads through and holds the withdrawal's own insert, which comes after its delete of the rows.
  const gate = new pg.Client({ connectionString: isolated.url });
  await gate.connect();
  await gate.query("BEGIN");
  await gate.query("LOCK TABLE evimed_vcr.subject_withdrawals IN SHARE ROW EXCLUSIVE MODE");
  const withdrawal = vcr.dataPlane.withdrawSubject({ studyId: study.id, subjectKey: key, actor: "owner", reason: "t" });
  for (let wait = 0; wait < 200; wait += 1) {
    // From the pool: inside the gate's own transaction this view is a snapshot that never moves.
    const left = await database.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%subject_withdrawals%' AND query LIKE 'INSERT%'");
    if (left.rows[0].n) break;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  const late = vcr.matchJudgments.save(row());
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  await gate.query("COMMIT");
  await gate.end();
  await withdrawal;
  await late;
  const after = await database.query("SELECT count(*)::int AS n FROM evimed_vcr.match_judgments WHERE study_id=$1 AND subject_key=$2", [study.id, key]);
  assert.equal(after.rows[0].n, 0, "the racing save left no row");
});

test("B2: a save naming a document that has gone writes nothing", options, async () => {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "n" });
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "GONE", stream: Readable.from([Buffer.from(SECRET)]) });
  const key = String(up.file.detail.subjectKey);
  await vcr.dataPlane.removeUpload({ actor: "owner", studyId: study.id, fileId: up.file.id });
  const late = await vcr.matchJudgments.save({ studyId: study.id, userId: "owner", subjectKey: key, targetKind: "candidate_trial", targetId: "NCT08888888", targetHash: "t", documentHash: "d", mode: "criteria", promptVersion: "criteria-3", model: "m", thinking: "off", producer: "job", status: "done", verdict: "possible", documentIds: [up.file.id], liveDocuments: true, answer: { rows: [] } });
  assert.equal(late, null);
});

// ---------------------------------------------------------------------------- B3

test("B3: a person withdrawn while an import walks a table stays out, counted as skipped and said in the report", options, async () => {
  const study = await newStudy();
  proposal = NOTES;
  const { started } = await importRows(study, "notes.csv", ["PID,NOTE", "W1,第一份", "K1,别人的", "W1,第二份写在撤回之后", "K2,别人的二", "W1,第三份写在撤回之后", "K3,x"].join("\n"));
  let withdrew = false, key = null;
  await drain(async () => {
    if (withdrew) return;
    const file = (await stored(study))[0];
    if (!file) return;
    key = file.detail.subjectKey; withdrew = true;
    await vcr.dataPlane.withdrawSubject({ studyId: study.id, subjectKey: key, actor: "owner", reason: "t" });
  });
  assert.equal((await stored(study)).filter((row) => row.detail?.subjectKey === key).length, 0);
  const result = await resultOf(started.jobId);
  assert.equal(result.diagnostics.skippedBy.vcr_subject_withdrawn, 2);
  assert.match(result.diagnostics.statement, /已撤回同意 2 份/u);
  assert.ok(!(await vcr.documents.roster({ id: study.id, userId: "owner" })).some((row) => row.subjectKey === key));
});

test("B3: a later upload naming a withdrawn person is refused by name, before any parser sees it", options, async () => {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "n" });
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "SAME-ID", stream: Readable.from([Buffer.from("第一份")]) });
  await vcr.dataPlane.withdrawSubject({ studyId: study.id, subjectKey: up.file.detail.subjectKey, actor: "owner", reason: "t" });
  await assert.rejects(() => vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "again.txt", role: "document", subject: "SAME-ID", stream: Readable.from([Buffer.from("新的一份")]) }), { code: "vcr_subject_withdrawn" });
  const before = parserCalls;
  await assert.rejects(() => vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "scan.png", role: "document", subjectKey: up.file.detail.subjectKey, stream: Readable.from([Buffer.from("a picture")]) }), { code: "vcr_subject_withdrawn" });
  assert.equal(parserCalls, before, "the scan did not reach the parser");
  await assert.rejects(() => vcr.dataStore.addSourceFile({ sourceId: source.id, studyId: study.id, userId: "owner", role: "document", name: "x.txt", format: "txt", location: "x", sha256: "f".repeat(64), bytes: 1, detail: { subjectKey: up.file.detail.subjectKey } }), { code: "vcr_subject_withdrawn" });
  assert.deepEqual(await stored(study), []);
});

// ---------------------------------------------------------------------------- B4, through the job

/** The import's executor under the bounds a test names; what the queue runs for the rest of that test. */
async function withBounds(bounds, work) {
  const real = vcr.jobs.localExecutors["matching.import_records"];
  vcr.jobs.localExecutors["matching.import_records"] = createRecordsImportExecutor({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, config: { deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrRecordsImportSliceEntries: 50, ...bounds }, fetchImpl: async () => new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } }),
    locate: (owner, handle) => receipts.locate(owner, handle) });
  try { return await work(); } finally { vcr.jobs.localExecutors["matching.import_records"] = real; }
}

test("B4: an import past its limits takes what fits and says what it did not: rows, a person's documents, a person's text, an over-long cell", options, async () => {
  const study = await newStudy();
  proposal = NOTES;
  const rows = ["PID,NOTE", "A1,一", "A1,二", "A1,三", `B1,"${"长".repeat(50)}"`, "C1,短", `D1,"${"超".repeat(300)}"`, "E1,这行超过了份数上限", "E2,这行也是"];
  const { started } = await withBounds({ vcrRecordsImportMaxPersonDocuments: 2, vcrRecordsImportMaxPersonChars: 20, vcrRecordsImportMaxEntries: 6, vcrRecordsImportMaxCellChars: 200 }, async () => {
    const answer = await importRows(study, "limits.csv", rows.join("\n"));
    await drain();
    return answer;
  });
  const { diagnostics, conclusion } = await resultOf(started.jobId);
  assert.equal(conclusion, "limited");
  assert.deepEqual(diagnostics.skippedBy, { vcr_import_person_too_many_documents: 1, vcr_import_person_too_much_text: 1, vcr_import_cell_too_long: 1, vcr_import_too_many_entries: 2 });
  assert.equal(diagnostics.stored, 3, "what fits is stored");
  assert.match(diagnostics.statement, /文档数已到上限 1 份/u);
  assert.match(diagnostics.statement, /单元格太长 1 份/u);
  assert.match(diagnostics.statement, /超过一次导入的份数上限 2 份/u);
});

test("B4: an archive past its limit of files takes the first ones and counts the rest; one that inflates too far stops at the limit", options, async () => {
  const study = await newStudy();
  proposal = { tables: [], files: { subject: { from: "stem_part", separator: "_", index: 0 } } };
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, at) => [`P${at}_a.txt`, strToU8(`第 ${at} 份`)]));
  const handle = await receipts.record(project, { name: "many.zip", bytes: Buffer.from(zipSync(files)), sessionId: "root" });
  const started = await withBounds({ vcrRecordsImportMaxZipEntries: 3 }, async () => {
    const answer = await intake(study, { action: "import_documents", ...handle }, origin);
    await drain();
    return answer;
  });
  const { diagnostics } = await resultOf(started.jobId);
  assert.equal(diagnostics.stored, 3);
  assert.equal(diagnostics.skippedBy.vcr_import_zip_too_many_entries, 2);

  const bombStudy = await newStudy();
  const bomb = await receipts.record(project, { name: "bomb.zip", bytes: Buffer.from(zipSync({ "table.csv": strToU8(`PID,NOTE\n${"A,x\n".repeat(100_000)}`), "P_a.txt": strToU8("一份") })), sessionId: "root" });
  proposal = { tables: [{ input: 0, role: "notes", subject: "PID", text: ["NOTE"] }], files: { subject: { from: "stem_part", separator: "_", index: 0 } } };
  const bombed = await withBounds({ vcrRecordsImportMaxZipBytes: 1024, vcrRecordsImportSliceEntries: 5_000 }, async () => {
    const answer = await intake(bombStudy, { action: "import_documents", ...bomb }, origin);
    await drain();
    return answer;
  });
  const after = await resultOf(bombed.jobId);
  assert.equal(after.diagnostics.skippedBy.vcr_data_file_too_large, 1, "the table stops where the bound is, as one entry on the list");
});

test("B4: the real job under a 512 MB heap: one 20 MB unterminated quote, and a turn over an archive of 60,000 files", { ...options, timeout: 240_000 }, async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "vcrImportUnderHeap.mjs");
  const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=512", child], { env: { ...process.env, VCR_HEAP_DATABASE_URL: isolated.url, VCR_HEAP_DIRECTORY: directory }, maxBuffer: 1024 * 1024 });
  const answer = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(answer.quote.state, "failed", "a table that is one over-long row has nothing to take");
  assert.equal(answer.quote.documents, 0);
  assert.ok(answer.archive.documents > 0 && answer.archive.documents <= 40, `a turn took ${answer.archive.documents}`);
  assert.ok(answer.heapMB < 400, `heap ${answer.heapMB} MB`);
});

// ---------------------------------------------------------------------------- S2, S3, S4

test("S2: a scan from a source whose cloud permission is revoked does not reach the parser", options, async () => {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "受限来源" });
  await vcr.dataPlane.setCloudPermission({ studyId: study.id, sourceId: source.id, actor: "owner", permission: { status: "revoked" } });
  const before = parserCalls;
  await assert.rejects(() => vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "chart.png", role: "document", subject: "P1", stream: Readable.from([Buffer.from("not really a png")]) }), { code: "vcr_cloud_processing_not_authorized" });
  assert.equal(parserCalls, before);
  assert.ok(Object.keys(vcrCloudDestinationNotes({ documentParserUrl: "https://parser.example.org/v1" })).includes("https://parser.example.org"), "the permission page names where a scan goes");
});

test("S3: a table with no header row leaves no patient text in the job's ledger, its result or what the model reads of it", options, async () => {
  const study = await newStudy();
  proposal = { tables: [{ input: 0, role: "ignore" }], files: null };
  modelBodies = [];
  const longNote = `主诉胸痛三天 肌酐 3.1 ${"很长的病历文字".repeat(40)}`;
  const { started } = await importRows(study, "export.csv", `张三,${ID_NUMBER},${longNote}\n李四,110101199003079999,无特殊\n`);
  await drain();
  const job = await jobRow(started.jobId);
  const dump = JSON.stringify(job);
  assert.ok(!dump.includes(ID_NUMBER), "the ledger holds no identifier");
  assert.ok(!dump.includes("张三"), "the ledger holds no name");
  assert.ok(!dump.includes("肌酐"), "the ledger holds no note");
  assert.equal(job.state, "failed");
  assert.match(job.error.message, /3 列/u, "it says what it can in a count");
  assert.ok(!modelBodies.at(-1).includes(longNote.slice(0, 200)), "the model reads the first row cut, like every other row of a sample");
});

test("S3: a job that names its columns by position: the checkpoint holds no header word", options, async () => {
  const study = await newStudy();
  proposal = { tables: [{ input: 0, role: "notes", subject: "张三", text: [ID_NUMBER] }], files: null };
  const { started } = await importRows(study, "headerless.csv", `张三,${ID_NUMBER}\nA1,第一份\nA2,第二份\nA3,第三份\nA4,第四份\n`);
  let seen = null;
  await drain(async () => { seen = seen ?? (await vcr.store.one("SELECT checkpoint FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]))?.checkpoint; });
  assert.ok(seen?.records, "the job gave its turn back at least once");
  const dump = JSON.stringify(seen);
  assert.ok(!dump.includes(ID_NUMBER) && !dump.includes("张三"), dump.slice(0, 300));
  assert.equal(seen.records.people, undefined, "no list of people grows in a checkpoint");
  assert.equal((await stored(study)).length, 4);
});

test("S4: a withdrawal takes the upload original and its receipt, the names in a job's report, the saved searches and the key in a job's scenario", options, async () => {
  const study = await newStudy();
  const bytes = `张三 身份证 ${ID_NUMBER} 肌酐 3.1`;
  const handle = await receipts.record(project, { name: "张三_病历.txt", bytes: Buffer.from(bytes, "utf8"), sessionId: "root" });
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "x" });
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "ZS", stream: Readable.from([Buffer.from(bytes)]) });
  const key = up.file.detail.subjectKey;
  await vcr.dataPlane.appendJobReport(study.id, "job_x", [{ name: "张三_坏文件.pdf", code: "vcr_document_unreadable", subjectKey: key }, { name: "王五_坏文件.pdf", code: "vcr_document_unreadable", subjectKey: "someone-else" }], 100);
  await vcr.candidateSearches.save({ id: study.id, userId: "owner" }, { subjectKey: key, request: { condition: "肺腺癌", terms: ["EGFR 19del"], age: 62, sex: "male", region: "China" }, registries: [], rerank: null, found: 1, items: [{ registryId: "NCT05000001", title: "t" }] });
  const started = await vcr.matchJudge.start(study, { subjectKey: key, registryIds: ["NCT05000001"] });

  await vcr.dataPlane.withdrawSubject({ studyId: study.id, subjectKey: key, actor: "owner", reason: "t" });

  assert.equal(await receipts.readPatientOriginal(origin, handle), null, "the original is gone");
  const listing = await fs.readdir(path.join(project.baseDir, ".evimed-upload-originals"), { recursive: true }).catch(() => []);
  assert.ok(!listing.some((name) => String(name).includes("张三")), "and so is its name");
  assert.deepEqual((await receipts.noteCandidates(origin)).uploads, [], "and its receipt");
  const report = await fs.readFile(path.join(directory, "plane", "studies", study.id, "job-reports", "job_x.jsonl"), "utf8");
  assert.ok(!report.includes("张三"), "the name left the report's file, not only its read");
  assert.ok(report.includes("王五"));
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_vcr.candidate_searches WHERE study_id=$1 AND subject_key=$2", [study.id, key])).rows[0].n, 0);
  const job = await vcr.store.one("SELECT scenario FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]);
  assert.ok(!JSON.stringify(job.scenario.subjects).includes(key), "the job's scenario no longer names them");
  assert.equal((await vcr.matchResults.latest(study.id)), null, "the page does not open on them");
  await vcr.store.query("UPDATE evimed_vcr.jobs SET state='canceled', lease_owner=NULL, lease_until=NULL WHERE id=$1", [started.jobId]);
});

test("S4: a link planted where an original's folder was is removed by name, and what it points at stays", options, async () => {
  const study = await newStudy();
  const bytes = "一份只有这位患者的病历";
  const handle = await receipts.record(project, { name: "note.txt", bytes: Buffer.from(bytes, "utf8"), sessionId: "root" });
  const elsewhere = path.join(directory, `kept-${sequence}`);
  await fs.mkdir(elsewhere);
  await fs.writeFile(path.join(elsewhere, "note.txt"), "另一个账户的文件");
  const folder = path.dirname(originalOf(handle, "note.txt"));
  await fs.rm(folder, { recursive: true });
  await fs.symlink(elsewhere, folder);
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "x" });
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "LINK", stream: Readable.from([Buffer.from(bytes)]) });
  await vcr.dataPlane.withdrawSubject({ studyId: study.id, subjectKey: up.file.detail.subjectKey, actor: "owner", reason: "t" });
  assert.equal(await fs.readFile(path.join(elsewhere, "note.txt"), "utf8"), "另一个账户的文件");
  assert.deepEqual((await receipts.noteCandidates(origin)).uploads, []);
});

test("S4: a skipped entry's report row names its person, so the filter and the withdrawal find it", options, async () => {
  const study = await newStudy();
  proposal = { tables: [], files: { subject: { from: "stem_part", separator: "_", index: 0 } } };
  const zip = zipSync({ "P1_a.txt": strToU8("第一份"), "P1_bad.xyz": strToU8("读不了"), "P2_a.txt": strToU8("别人的") });
  const handle = await receipts.record(project, { name: "notes.zip", bytes: Buffer.from(zip), sessionId: "root" });
  const started = await intake(study, { action: "import_documents", ...handle }, origin);
  await drain();
  const key = (await stored(study)).find((row) => row.detail?.import)?.detail.subjectKey;
  const rows = await vcr.dataPlane.readJobReport(study.id, started.jobId);
  assert.ok(rows.some((row) => row.name === "P1_bad.xyz" && row.subjectKey), JSON.stringify(rows));
  const named = rows.find((row) => row.name === "P1_bad.xyz");
  await vcr.dataPlane.withdrawSubject({ studyId: study.id, subjectKey: named.subjectKey, actor: "owner", reason: "t" });
  assert.ok(!(await vcr.dataPlane.readJobReport(study.id, started.jobId)).some((row) => row.name === "P1_bad.xyz"));
  assert.ok(key);
});

test("S4: the long tables' sample leaves out a person who has withdrawn", options, async () => {
  const { createLongTableReader } = await import("../src/vcrLongTables.mjs");
  const file = path.join(directory, `long-${++sequence}.csv`);
  await fs.writeFile(file, ["USUBJID,thing,when", "W1,取走的值,2026-01-01", "K1,留下的值,2026-01-02", "W1,取走的值,2026-01-03", "K1,留下的值,2026-01-04"].join("\n"));
  const reader = createLongTableReader({ tables: [{ id: "t1", snapshotId: "s1", file, name: "custom" }], withdrawn: new Set(["W1"]) });
  const [table] = await reader.unknownTables();
  assert.ok(table, "the table is offered");
  assert.ok(!JSON.stringify(table.rows).includes("取走的值"));
  assert.ok(JSON.stringify(table.rows).includes("留下的值"));
});

// ---------------------------------------------------------------------------- S7

const candidateItem = { registry: "clinicaltrials.gov", registryId: "NCT05000001", title: "EGFR 肺腺癌", overallStatus: "RECRUITING", phases: ["PHASE3"], conditions: ["肺腺癌"], interventions: ["Drug A"], url: "https://clinicaltrials.gov/study/NCT05000001", sex: "ALL", minimumAge: "18 Years", maximumAge: "N/A", secondaryIds: [], countries: ["China"] };
/** A search over a registry and a reranker that write down what they were sent. */
function searching(summaryCloudAllowed) {
  const asked = [], summaries = [];
  const registry = {
    search: async (query) => { asked.push(JSON.stringify(query)); return { status: "ok", items: [candidateItem, { ...candidateItem, registryId: "NCT05000002", url: "https://clinicaltrials.gov/study/NCT05000002" }], total: 2, retrievedAt: new Date().toISOString() }; },
    searchCtis: async (query) => { asked.push(JSON.stringify(query)); return { status: "ok", items: [], total: 0 }; },
    searchChictr: async (query) => { asked.push(JSON.stringify(query)); return { status: "ok", items: [], total: 0 }; },
  };
  const reranker = { configured: true, model: "m", score: async (query, documents) => { summaries.push(query); return { scores: documents.map(() => 0.5), state: "ranked", batches: 1, failedBatches: 0, reasons: [], model: "m" }; } };
  return { asked, summaries, pipeline: createVcrEvidencePipeline({ store: {}, registry, reranker, summaryCloudAllowed }) };
}

test("S7: a summary goes to the reranker only where the person's records may go to the cloud; a search's terms and condition have identifier shapes masked", options, async () => {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "n" });
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "S7", stream: Readable.from([Buffer.from("一份病历。")]) });
  const key = String(up.file.detail.subjectKey);
  const allowed = (entry) => vcr.dataPlane.subjectCloudAllowed(entry);
  const filter = { condition: `肺腺癌 ${ID_NUMBER}`, terms: [`EGFR 19del 13800138000`], summary: "男，62 岁，肺腺癌", subjectKey: key };
  const open = searching(allowed);
  const first = await open.pipeline.patientCandidates({ userId: "owner", study, filter });
  assert.equal(open.summaries.length, 1, "while the source allows it, the reranker reads the summary");
  assert.ok(!open.asked.join("").includes(ID_NUMBER) && !open.asked.join("").includes("13800138000"), "no identifier went to a registry");
  assert.ok(!JSON.stringify(first.request).includes(ID_NUMBER), "or into the receipt");
  await vcr.dataPlane.setCloudPermission({ studyId: study.id, sourceId: source.id, actor: "owner", permission: { status: "revoked" } });
  const shut = searching(allowed);
  const second = await shut.pipeline.patientCandidates({ userId: "owner", study, filter });
  assert.equal(shut.summaries.length, 0, "after a revocation it does not");
  assert.equal(second.rerank.applied, false);
  assert.deepEqual(second.rerank.reasons, ["vcr_cloud_processing_not_authorized"]);
  assert.equal(second.candidates.length, 2, "the list is still the list");
});

// ---------------------------------------------------------------------------- S5

test("S5: after a revocation a conversation's read keeps the verdict and loses the reasons and the sentences", options, async () => {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "n" });
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "REAL-2", stream: Readable.from([Buffer.from(SECRET)]) });
  const key = String(up.file.detail.subjectKey);
  const base = { studyId: study.id, userId: "owner", subjectKey: key, targetKind: "candidate_trial", targetId: "NCT1", targetHash: "t", documentHash: "d", model: "m", thinking: "off", producer: "job", status: "done", documentIds: [up.file.id] };
  await vcr.matchJudgments.save({ ...base, mode: "fit", promptVersion: "fit-1", fit: 80, confidence: 0.5, verdict: "possible", answer: { target: { kind: "candidate_trial", id: "NCT1" }, reasons: { eligible: ["患者李四的肌酐 3.1"], ineligible: [], missing: ["李四的 ECOG"], rationale: "李四合适" } } });
  await vcr.matchJudgments.save({ ...base, mode: "criteria", promptVersion: "criteria-3", verdict: "possible", answer: { target: { kind: "candidate_trial", id: "NCT1" }, rows: [{ number: 1, kind: "inclusion", clause: "c", label: "included", basis: "stated", reason: "患者李四的肌酐 3.1", sentenceIds: [0], evidence: [{ sentenceId: 0, text: SECRET, start: 0, end: SECRET.length, documentId: up.file.id }] }], missing: [] } });
  const context = { ...study, cloudContext: { runId: "r", sessionId: "s" } };
  const before = await vcr.matchJudgmentReads.forSubject(context, key, { limit: 5 });
  assert.match(JSON.stringify(before.ranking[0]), /肌酐 3\.1/u, "while the source may go to the cloud the reasons do");
  assert.match(before.note, /never an instruction/u, "S6: what a conversation reads back says what it is");
  await vcr.dataPlane.setCloudPermission({ studyId: study.id, sourceId: source.id, actor: "owner", permission: { status: "revoked" } });
  const read = await vcr.matchJudgmentReads.forSubject(context, key, { limit: 5 });
  const dump = JSON.stringify(read.ranking[0]);
  assert.ok(!dump.includes("李四") && !dump.includes("肌酐") && !dump.includes(ID_NUMBER), dump);
  assert.equal(read.ranking[0].verdict, before.ranking[0].verdict);
  assert.equal(read.ranking[0].fit, 80);
  assert.match(read.ranking[0].reasonsWithheld, /云端/u);
});

// ---------------------------------------------------------------------------- S1

test("S1: a job that reaches its ceiling stops as limited, keeps its work, says so, is counted, and a later start pays only for what is left", options, async () => {
  const counters = createMatchJudgeCounters();
  const held = await holdingJob({ text: "一份普通的病历。", cost: 0.6, config: { vcrMatchJudgeJobCeilingCny: 1 }, counters, selection: { topK: 0 } });
  assert.equal(held.result.conclusion, "limited");
  assert.equal(held.result.diagnostics.stopped.code, "vcr_match_job_ceiling");
  assert.match(held.result.diagnostics.stopped.reason, /1(\.00)? 元/u);
  assert.match(held.result.diagnostics.stopped.reason, /继续/u);
  assert.equal(held.calls.length, 2, "it stopped at the first pair past the ceiling");
  assert.equal(held.rows.filter((row) => row.status === "done").length, 2, "what was done stands");
  assert.equal(counters.ceilingStops, 1);
  assert.equal(held.result.diagnostics.used.cost.toFixed(1), "1.2");
});

test("S1: a job stopped at its ceiling is continued by the page's one action, and the continuation pays only for what is left", options, async () => {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "n" });
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "CEILING", stream: Readable.from([Buffer.from("一份普通的病历。")]) });
  const key = String(up.file.detail.subjectKey);
  let calls = 0;
  const judge = { model: "deepseek-flash", maxTokens: 1000, timeoutMs: 1000, call: async ({ messages }) => { calls += 1; return { content: answerFor(messages.map((message) => message.content).join("\n")), usage: { inputTokens: 10, outputTokens: 10, cacheHitTokens: 0, reasoningTokens: 0 }, cost: 0.6, currency: "CNY" }; } };
  const executorWith = (config) => createMatchJudgeExecutor({ store: vcr.store, matchStore: vcr.matchStore, judgments: vcr.matchJudgments, documents: vcr.documents, targets: fakeTargets, judge, config: { vcrMatchJudgeConcurrency: 1, ...config } });
  const start = (selection) => vcr.matchJudge.start(study, { subjectKey: key, topK: 0, thinking: "off", ...selection }, { actor: "test" });
  const real = vcr.jobs.localExecutors["matching.judge"];
  try {
    vcr.jobs.localExecutors["matching.judge"] = executorWith({ vcrMatchJudgeJobCeilingCny: 1 });
    await start({ registryIds: TRIALS });
    await drain();
    assert.equal(calls, 2);
    const stopped = await vcr.matchResults.forPatient(study, key, { viewer: { id: "owner" } });
    assert.equal(stopped.progress.state, "stopped");
    const left = await vcr.matchResults.resumeSelection(study, { direction: "patient_to_trial", subjectKey: key });
    assert.deepEqual(left.ids.sort(), TRIALS.slice(2).sort());
    calls = 0;
    vcr.jobs.localExecutors["matching.judge"] = executorWith({});
    await start({ registryIds: left.ids });
    await drain();
    assert.equal(calls, 3, "the two already judged cost nothing");
    const done = await vcr.matchResults.forPatient(study, key, { viewer: { id: "owner" } });
    assert.equal(done.progress.state, "done");
    assert.equal(done.trials.length, 5);
  } finally { vcr.jobs.localExecutors["matching.judge"] = real; }
});

test("S1: 最多约 counts the re-asks and the retries and never promises more than the ceiling", options, async () => {
  const study = { id: "s", userId: "u" };
  const roster = [{ id: "d", subjectKey: "P1", chars: 2_000 }];
  const plan = (config) => planMatchJudge({ study, selection: { subjectKey: "P1", registryIds: ["NCT00000001", "NCT00000002"], topK: 0, thinking: "off" }, matchStore: { withdrawnSubjects: async () => new Set() }, documents: { roster: async () => roster }, config: { deepseekModel: "deepseek-flash", ...config }, peak: false });
  const { scenario, statement } = await plan({});
  const once = scenario.estimate.costOnce;
  assert.ok(once > 0);
  assert.ok(scenario.estimate.cost >= once * 2, "a call may be asked again and a pair tried again at the end of its stage");
  assert.match(statement, /含重试/u);
  const capped = await plan({ vcrMatchJudgeJobCeilingCny: 0.0001 });
  assert.equal(capped.scenario.estimate.cost, 0.0001);
  assert.match(capped.statement, /上限/u);
});

test("S1: spent counts every call: the parts a failed try paid for, under the row that replaced it", options, async () => {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "n" });
  // Two parts: the first is paid for, the second times out, and the end of the stage tries the pair again.
  const up = await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "SPENT", stream: Readable.from([Buffer.from("一份普通的病历。\n\n".repeat(Math.ceil(VCR_MATCH_JUDGE_LIMITS.noteChars / 5)))]) });
  const key = String(up.file.detail.subjectKey);
  const built = await planMatchJudge({ study, selection: { subjectKey: key, registryIds: ["NCT00000001"], topK: 0, thinking: "off" }, matchStore: vcr.matchStore, documents: vcr.documents, config: {} });
  const started = await vcr.jobs.enqueue({ studyId: study.id, userId: "owner", kind: "match_judge", scenario: built.scenario, inputs: [], internal: true, cpuSecondsLimit: 60, maxAttempts: 5, idempotencyKey: `s9-spent-${sequence}`, detail: { principal: "owner" } });
  let call = 0;
  const judge = { model: "deepseek-flash", maxTokens: 1000, timeoutMs: 1000, call: async ({ messages }) => {
    call += 1;
    if (call === 2) throw Object.assign(new Error("timed out"), { code: "vcr_match_judge_timeout" });
    return { content: answerFor(messages.map((message) => message.content).join("\n")), usage: { inputTokens: 10, outputTokens: 10, cacheHitTokens: 0, reasoningTokens: 0 }, cost: 0.25, currency: "CNY" };
  } };
  const real = vcr.jobs.localExecutors["matching.judge"];
  vcr.jobs.localExecutors["matching.judge"] = createMatchJudgeExecutor({ store: vcr.store, matchStore: vcr.matchStore, judgments: vcr.matchJudgments, documents: vcr.documents, targets: fakeTargets, judge, config: { vcrMatchJudgeConcurrency: 1 } });
  try { await drain(); } finally { vcr.jobs.localExecutors["matching.judge"] = real; }
  const page = await vcr.matchResults.forPatient(study, key, { viewer: { id: "owner" } });
  assert.equal(page.progress.jobId, started.job.id);
  assert.ok(call > 3, "the pair was tried again");
  assert.equal(page.progress.cost.spent, 0.25 * (call - 1), "every call that answered, the replaced try's too");
});
