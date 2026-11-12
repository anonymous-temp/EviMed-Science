// A patient's record arriving in the conversation: PDF, Word and scans as records, the in-house parser and what happens when it is off, a knowledge-base document found through the read,
// and a later message that joins the same person and re-judges what they already have. PostgreSQL; the model, the registry and the parser are doubles.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { createVcrPatientContext } from "../src/vcrPatientContext.mjs";
import { createVcrUploadReceipts } from "../src/vcrUploadReceipts.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required", timeout: 60_000 };
let isolated, database, directory, documents, vcr, intake, receipts, project, parser, study, score;
const origin = { userId: "owner", projectId: "project", rootSessionId: "root", runId: "run", callId: "call" };
/** @type {Array<{ seq: number, text: string }>} */
const messages = [];
const library = { items: [] };

const CHAT = (content) => new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 40, completion_tokens: 10, prompt_cache_hit_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
const CTGOV = (id) => ({ protocolSection: { identificationModule: { nctId: id, briefTitle: `Trial ${id}` }, descriptionModule: { briefSummary: "Summary" }, statusModule: { overallStatus: "RECRUITING" }, conditionsModule: { conditions: ["NSCLC"] },
  armsInterventionsModule: { interventions: [{ type: "DRUG", name: "Osimertinib" }] }, eligibilityModule: { eligibilityCriteria: "Inclusion Criteria:\n* Age >= 18\nExclusion Criteria:\n* Pregnancy" } } });

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrfollowup");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner','project','Project',100000000)");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-followup-"));
  project = { userId: "owner", id: "project", baseDir: path.join(directory, "project") };
  await fs.mkdir(project.baseDir);
  score = 85;
  const fetchImpl = async (input, init) => {
    const address = String(input);
    if (address.includes("clinicaltrials.gov")) return new Response(JSON.stringify(CTGOV(/NCT\d{8}/.exec(address)[0])), { status: 200, headers: { "content-type": "application/json" } });
    const system = JSON.parse(init.body).messages[0].content;
    return CHAT(system.includes("criterion level") ? '{"1":["年龄",[0],"included"],"2":["未提及",[],"not excluded"]}' : JSON.stringify({ score, confidence: 0.7, eligible_reasons: "1. a", ineligible_reasons: "", missing_information: "" }));
  };
  parser = { configured: true, calls: [], fail: null, async parseBytes(input) {
    parser.calls.push({ filename: input.filename, textOnly: input.textOnly });
    if (parser.fail) throw Object.assign(new Error("no"), { code: parser.fail });
    return { text: "第一页：年龄 62 岁。\n第二页：肺腺癌 IV 期。", pageMap: [{ page: 1, start: 0, end: 12, status: "ok" }, { page: 2, start: 12, end: 26, status: "ok" }], extractor: { name: "evimed-extract", version: "t", endpoint: "parse" } };
  } };
  vcr = composeVcr({ productDatabase: database, fetchImpl, documentParser: parser, config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: path.join(directory, "plane"), deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrProviderAgreements: true } });
  await vcr.store.ready();
  documents = new ProductDocuments(database);
  receipts = createVcrUploadReceipts({ documents, sources: null, resolveProject: async () => project });
  vcr.recordsOriginals.receipts = receipts;
  intake = createVcrPatientContext({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, documents: vcr.documents, uploadReceipts: receipts, documentJobs: vcr.patientDocuments,
    sources: { list: async () => library, get: async () => null }, subjectKnown: vcr.subjectKnown, isHumanMessage: async () => true,
    transcript: async () => ({ sessionId: "root", exhausted: true, messages: messages.map((message) => ({ role: "user", source: "user", seq: message.seq, parts: [{ type: "text", text: message.text }] })) }) });
  study = await vcr.store.createStudy({ userId: "owner", projectId: "project", name: "Follow-up", question: "q", dataTier: "T0" });
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

const conversation = () => ({ ...study, cloudContext: { runId: "run", sessionId: "root" } });
const say = (seq, text) => { messages.push({ seq, text }); return seq; };
const runJobs = async () => {
  for (let turn = 0; turn < 50; turn += 1) {
    const claimed = await vcr.jobs.claim({ lane: "slow" });
    if (!claimed.length) return;
    for (const job of claimed) await vcr.jobs.advance(job, { mayYield: true });
  }
  assert.fail("the jobs did not finish");
};



test("a person who is not in this study, or who withdrew, cannot be added to", options, async () => {
  await assert.rejects(() => intake(conversation(), { messageSeq: say(13, "ECOG 1。"), subjectKey: "NO-ONE" }, origin), { code: "vcr_subject_not_found" });
  const person = await intake(conversation(), { messageSeq: say(15, "男性，70 岁。") }, origin);
  await vcr.dataPlane.withdrawSubject({ actor: "owner", studyId: study.id, subjectKey: person.subjectKey, reason: "withdrawn" }).catch(async () => {
    await vcr.store.query("INSERT INTO evimed_vcr.subject_withdrawals(study_id,subject_key,user_id) VALUES ($1,$2,$3)", [study.id, person.subjectKey, "owner"]);
  });
  await assert.rejects(() => intake(conversation(), { messageSeq: say(17, "ECOG 1。"), subjectKey: person.subjectKey }, origin), { code: "vcr_subject_not_found" });
});

test("a scan goes to the parser under a neutral name for its text alone, as a job: the call answers at once, keeps its page numbers, and its handle is its identity", options, async () => {
  const handle = await receipts.record(project, { name: "张三-出院小结.pdf", bytes: Buffer.from("%PDF-1.4 scanned"), sessionId: "root" });
  assert.match(handle.sourceId, /^upl_/);
  const { uploads } = await intake.candidates(origin, {}, study);
  assert.deepEqual(uploads.map((row) => row.format), ["pdf"], "the read lists it");
  const calls = parser.calls.length;
  const started = await intake({ ...conversation(), completionOrigin: origin }, handle, origin);
  assert.deepEqual([started.ok, started.converting, started.state], [true, true, "queued"], JSON.stringify(started.issues));
  assert.equal(parser.calls.length, calls, "nothing is read while the call is open");
  assert.equal(started.documentId, undefined);
  assert.ok(started.subjectKey, "the person is named at once, for what is said next");
  assert.ok(started.subjectLabel);
  assert.match(started.statement, /转成文字/);
  const job = await vcr.jobs.get(study.id, started.jobId);
  assert.equal(job.kind, "records_import");
  assert.deepEqual(job.checkpoint.conversationOrigin, origin, "its finish comes back to this conversation by the path every job's does");
  const twice = await intake({ ...conversation(), completionOrigin: origin }, handle, origin);
  assert.deepEqual([twice.jobId, twice.alreadyRunning], [started.jobId, true], "asking again finds the same job");
  // While the parser reads, no connection sits in a transaction.
  const holding = parser.parseBytes;
  /** @type {number[]} */
  const open = [];
  parser.parseBytes = async (input) => {
    open.push(Number((await database.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'")).rows[0].n));
    return holding.call(parser, input);
  };
  await runJobs();
  parser.parseBytes = holding;
  assert.deepEqual(open, [0], "the conversion holds no transaction");
  assert.equal((await vcr.jobs.get(study.id, started.jobId)).state, "succeeded");
  // Now it is there, and the same call finds it without reading it again.
  const before = parser.calls.length;
  const saved = await intake(conversation(), handle, origin);
  assert.equal(saved.ok, true, JSON.stringify(saved.issues));
  assert.equal(saved.subjectKey, started.subjectKey);
  assert.equal(saved.readBy, "in_house_parser");
  assert.equal(parser.calls.length, before);
  assert.deepEqual(parser.calls.at(-1), { filename: "record.pdf", textOnly: true }, "the name does not travel and no model writes metadata");
  const file = await vcr.dataStore.getSourceFile(study.id, saved.documentId);
  assert.deepEqual(file.detail.extraction.pageMap.map((row) => row.page), [1, 2]);
  assert.equal(file.detail.original.format, "pdf");
  assert.equal(file.name.includes("张三"), false);
  assert.equal(JSON.stringify(file.detail).includes("张三"), false);
  const again = await intake(conversation(), handle, origin);
  assert.equal(again.documentId, saved.documentId, "the same original is the same document");
  const sentences = await vcr.service.runtimeRead(conversation(), "subject_document", { subjectKey: saved.subjectKey, kind: "sentences" });
  assert.deepEqual(sentences.sentences.map((row) => row.page), [1, 2], "evidence can say which page");
});

test("a parser that is off or fails ends the job with the file kept and the reason said, and the same call reads it later", options, async () => {
  const handle = await receipts.record(project, { name: "scan.png", bytes: Buffer.from("not really a picture"), sessionId: "root" });
  parser.configured = false;
  const off = await intake(conversation(), handle, origin);
  assert.equal(off.converting, true);
  await runJobs();
  const stopped = await vcr.jobs.get(study.id, off.jobId);
  assert.equal(stopped.state, "failed");
  assert.equal(stopped.error.code, "vcr_document_parser_unavailable");
  assert.match(stopped.error.message, /原件已保留/);
  parser.configured = true;
  parser.fail = "source_parser_internal_error";
  const failing = await intake(conversation(), handle, origin);
  assert.notEqual(failing.jobId, off.jobId, "an ended job is a new attempt");
  await runJobs();
  assert.equal((await vcr.jobs.get(study.id, failing.jobId)).error.code, "vcr_document_parser_failed");
  parser.fail = null;
  const third = await intake(conversation(), handle, origin);
  await runJobs();
  assert.equal((await vcr.jobs.get(study.id, third.jobId)).state, "succeeded");
  const read = await intake(conversation(), handle, origin);
  assert.equal(read.ok, true);
  assert.equal(read.subjectKey, off.subjectKey, "the same person all along");
  assert.deepEqual(parser.calls.at(-1), { filename: "record.png", textOnly: true });
});

test("a scan about someone the study has joins them when it is read, and what they have is judged again", options, async () => {
  const first = await intake(conversation(), { messageSeq: say(31, "男性，70 岁。") }, origin);
  assert.equal(first.ok, true);
  const handle = await receipts.record(project, { name: "follow-up.pdf", bytes: Buffer.from("%PDF-1.4 later"), sessionId: "root" });
  const asked = await intake(conversation(), { ...handle, subjectKey: first.subjectKey }, origin);
  assert.equal(asked.subjectKey, first.subjectKey);
  assert.equal(asked.converting, true);
  await runJobs();
  const read = await intake(conversation(), { ...handle, subjectKey: first.subjectKey }, origin);
  assert.equal(read.subjectKey, first.subjectKey);
  const mine = (await vcr.documents.roster(study)).filter((row) => row.subjectKey === first.subjectKey);
  assert.ok(mine.some((row) => row.id === read.documentId || row.documentId === read.documentId));
});

test("a text record longer than a document is several documents of one person, and a Word file with no converter reaches the parser", options, async () => {
  const long = Array.from({ length: 4000 }, (_, index) => `2024-01-${String(index % 28 + 1).padStart(2, "0")} 第 ${index} 次就诊：${"症状稳定，继续随访。".repeat(20)}`).join("\n");
  assert.ok(long.length > 700_000);
  const handle = await receipts.record(project, { name: "long.txt", bytes: Buffer.from(long), sessionId: "root" });
  const saved = await intake(conversation(), handle, origin);
  assert.ok(saved.documents >= 3, `${saved.documents} documents`);
  const mine = (await vcr.documents.roster(study)).filter((row) => row.subjectKey === saved.subjectKey);
  assert.equal(mine.length, saved.documents);
  const word = await receipts.record(project, { name: "note.docx", bytes: Buffer.from("PK\u0003\u0004 word"), sessionId: "root" });
  await intake(conversation(), word, origin);
  await runJobs();
  assert.equal((await intake(conversation(), word, origin)).readBy, "in_house_parser");
});

test("a knowledge-base document can be found through the read", options, async () => {
  library.items = [{ id: "src_abc", payload: { connector: { type: "upload" }, paths: ["knowledge/case-7.pdf"], analysis: { textSha256: "a".repeat(64) } } },
    { id: "src_noText", payload: { connector: { type: "upload" }, paths: ["knowledge/recording.mp3"] } }];
  const read = await intake.candidates(origin, {}, study);
  assert.deepEqual(read.knowledgeDocuments, [{ sourceId: "src_abc", name: "case-7.pdf" }]);
  assert.deepEqual(read.knowledgeWrite, { what: "patient_context", dataFields: ["sourceId"] });
  library.items = [];
});
