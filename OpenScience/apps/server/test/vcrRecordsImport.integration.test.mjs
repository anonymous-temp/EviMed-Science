// Many patients' records as a job, on the real queue, the real plane and PostgreSQL: a table with a note column of any length, a roster with a zip, a zip alone, several documents per person,
// a file that cannot be read, a model that does not answer, and a slot given back between batches. The model and the parser are doubles.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { createVcrDataIntake } from "../src/vcrDataIntake.mjs";
import { acceptProposal, chartDate, delimitedRows, fallbackFileRule } from "../src/vcrRecordsImport.mjs";
import { createVcrUploadReceipts } from "../src/vcrUploadReceipts.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required", timeout: 120_000 };
let isolated, database, directory, documents, vcr, intake, receipts, project, parser;
/** @type {any} */ let proposal;
let modelCalls = 0;
let sequence = 0;
const pythonCanOpenpyxl = () => { try { execFileSync("python3", ["-c", "import openpyxl"], { stdio: "ignore" }); return true; } catch { return false; } };
const origin = { userId: "owner", projectId: "project", rootSessionId: "root", runId: "run", callId: "call" };

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrrecords");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner','project','Project',1000000000)");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-records-"));
  project = { userId: "owner", id: "project", baseDir: path.join(directory, "project") };
  await fs.mkdir(project.baseDir);
  const fetchImpl = async () => {
    modelCalls += 1;
    if (proposal === null) return new Response("down", { status: 500 });
    return new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  parser = { configured: true, failNames: false, async parseBytes({ bytes }) {
    if (parser.failNames || bytes.toString().includes("UNREADABLE")) throw Object.assign(new Error("no"), { code: "source_parser_internal_error" });
    return { text: `扫描件文字 ${bytes.toString()}`, extractor: { name: "evimed-extract", version: "t" } };
  } };
  vcr = composeVcr({ productDatabase: database, fetchImpl, documentParser: parser, config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: path.join(directory, "plane"), deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrProviderAgreements: true, vcrRecordsImportSliceEntries: 50, vcrLocalConcurrency: 2 } });
  await vcr.store.ready();
  documents = new ProductDocuments(database);
  receipts = createVcrUploadReceipts({ documents, sources: null, resolveProject: async () => project });
  vcr.recordsOriginals.receipts = receipts;
  intake = createVcrDataIntake({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, sources: receipts, resolveProject: async () => project, recordsImport: vcr.recordsImport });
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

/** One study to a project, as the schema holds it: the receipts and the conversation follow the newest. */
const newStudy = async () => {
  const id = `project-${++sequence}`;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner',$1,'Project',1000000000)", [id]);
  project = { userId: "owner", id, baseDir: path.join(directory, id) };
  await fs.mkdir(project.baseDir);
  origin.projectId = id;
  return vcr.store.createStudy({ userId: "owner", projectId: id, name: `Import ${sequence}`, question: "q", dataTier: "T0" });
};
/** Claim and advance as the worker's slow lane does, until nothing is left. @param {number} [limit] */
const drain = async (limit = 400) => {
  let turns = 0;
  for (; turns < limit; turns += 1) {
    const claimed = await vcr.jobs.claim({ lane: "slow" });
    if (!claimed.length) return turns;
    for (const job of claimed) await vcr.jobs.advance(job, { mayYield: true });
  }
  assert.fail("the import did not finish");
};
const resultOf = (jobId) => vcr.store.one("SELECT r.conclusion, r.diagnostics, r.measures FROM evimed_vcr.results r JOIN evimed_vcr.executions e ON e.id = r.execution_id WHERE e.job_id=$1 ORDER BY r.created_at DESC LIMIT 1", [jobId]);
const peopleOf = async (study) => { const by = new Map(); for (const row of await vcr.documents.roster(study)) by.set(row.subjectKey, (by.get(row.subjectKey) ?? 0) + 1); return by; };

test("what a format says is code's: rows with quotes and line breaks, dates a chart writes, and only columns that exist from the model", async () => {
  const rows = [];
  for await (const row of delimitedRows((async function* () { yield 'a,"b ""q"""\n1,"两行\n'; yield '第二行"\r\n\n2,x\n'; })())) rows.push(row);
  assert.deepEqual(rows, [["a", 'b "q"'], ["1", "两行\n第二行"], ["2", "x"]]);
  assert.equal(chartDate("2024年3月5日").slice(0, 10), "2024-03-05");
  assert.equal(chartDate("20240305").slice(0, 10), "2024-03-05");
  assert.equal(chartDate("2024/3/5 入院").slice(0, 10), "2024-03-05");
  assert.equal(chartDate("不详"), null);
  assert.equal(chartDate("2024-13-40"), null);
  const taken = acceptProposal(JSON.stringify({ tables: [{ input: 0, role: "notes", subject: "ID", text: ["NOTE", "MADE_UP"], date: "NOPE", context: ["AGE", "ID"] }], files: { subject: { from: "stem_part", separator: "_", index: 0 }, date: { from: "script", code: "x" } } }), [{ input: 0, header: ["ID", "NOTE", "AGE"], rows: [] }]);
  assert.deepEqual(taken.tables[0], { input: 0, role: "notes", subject: "ID", text: ["NOTE"], date: null, file: null, context: ["AGE"] });
  assert.deepEqual(taken.files, { subject: { from: "stem_part", separator: "_", index: 0 }, date: null });
  assert.deepEqual(acceptProposal("not json", []), { tables: [], files: null });
  assert.deepEqual(fallbackFileRule(["a/1.txt", "b/2.txt"]).subject, { from: "folder", depth: 0 });
  assert.deepEqual(fallbackFileRule(["p1_a.txt", "p1_b.txt", "p2_a.txt"]).subject, { from: "stem_part", separator: "_", index: 0 });
  assert.deepEqual(fallbackFileRule(["x.txt", "y.txt"]).subject, { from: "stem" });
});

test("a table of 300 rows goes in through the job in batches: the model names the columns, several notes per person, and the same words for two people stay two documents", options, async () => {
  const study = await newStudy();
  const rows = ["PID,AGE,VISIT,NARRATIVE"];
  for (let index = 0; index < 300; index += 1) rows.push(`P${String(index % 120).padStart(3, "0")},${40 + (index % 30)},2024-01-${String((index % 28) + 1).padStart(2, "0")},"第 ${index} 份记录，含逗号, 和换行\n结束"`);
  rows.push("P500,50,2024-02-01,无特殊", "P501,51,2024-02-01,无特殊", ",52,2024-02-01,没有人名的一行", "P502,53,2024-02-01,", "P503,54,不详,日期读不出");
  const handle = await receipts.record(project, { name: "notes.csv", bytes: Buffer.from(rows.join("\n"), "utf8"), sessionId: "root" });
  proposal = { tables: [{ input: 0, role: "notes", subject: "PID", text: ["NARRATIVE"], date: "VISIT", context: ["AGE"] }], files: null };
  const calls = modelCalls;
  const started = await intake(study, { action: "import_documents", ...handle }, origin);
  assert.equal(started.ok, true);
  assert.match(started.jobId, /./);
  assert.equal((await intake(study, { action: "import_documents", ...handle }, origin)).alreadyRunning, true, "the same import asked twice is one job");
  const turns = await drain();
  assert.ok(turns >= 6, `${turns} turns: it came back in batches`);
  assert.equal(modelCalls, calls + 1, "the meaning is asked once for the job");
  const job = await vcr.store.one("SELECT state, attempts FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]);
  assert.equal(job.state, "succeeded");
  assert.ok(job.attempts <= 1, "finished batches do not use up its tries");
  const { diagnostics, conclusion } = await resultOf(started.jobId);
  assert.equal(conclusion, "limited");
  assert.deepEqual([diagnostics.read, diagnostics.stored, diagnostics.skipped], [305, 303, 2]);
  assert.deepEqual(diagnostics.skippedBy, { no_subject: 1, empty_note: 1 });
  assert.equal(diagnostics.undated, 1, "a date nobody could read is counted, and the note is kept");
  assert.equal(diagnostics.people, 123);
  assert.equal(diagnostics.meaning.basis, "model_inferred");
  assert.match(diagnostics.statement, /读了 305 份，收下 303 份（123 位患者），跳过 2 份/);
  const people = await peopleOf(study);
  assert.equal(people.size, 123);
  assert.ok([...people.values()].filter((count) => count > 1).length >= 60, "several documents per person");
  const reader = { ...study, cloudContext: { runId: "r", sessionId: "s" } };
  const files = (await vcr.dataStore.listSourceFilesForStudy(study.id)).filter((file) => file.role === "document");
  const same = files.filter((file) => file.bytes === Buffer.byteLength("AGE：50\n无特殊") || file.bytes === Buffer.byteLength("AGE：51\n无特殊"));
  assert.equal(same.length, 2);
  const text = await vcr.documents.runtimeRead(reader, { subjectKey: files[0].detail.subjectKey, documentId: files[0].id });
  assert.match(text.text, /AGE：\d+\n第 \d+ 份记录，含逗号, 和换行\n结束/, "the kept column beside the note");
  assert.ok(files.every((file) => /^document-/.test(file.name)), "a file's name is not kept");
  assert.ok(files.some((file) => file.detail.visibleAt?.startsWith("2024-01-")), "dates reach the record");
  // Started again it finds what it took and does nothing twice.
  const again = await intake(study, { action: "import_documents", ...handle }, origin);
  assert.notEqual(again.jobId, started.jobId);
  await drain();
  const second = await resultOf(again.jobId);
  assert.deepEqual([second.diagnostics.stored, second.diagnostics.repeated], [0, 303]);
  assert.equal((await vcr.dataStore.listSourceFilesForStudy(study.id)).filter((file) => file.role === "document").length, files.length);
});

test("a workbook of notes reads like a table", { ...options, skip: options.skip || (!pythonCanOpenpyxl() && "openpyxl is needed") }, async () => {
  const study = await newStudy();
  const file = path.join(directory, "notes.xlsx");
  execFileSync("python3", ["-c", "import openpyxl,sys;w=openpyxl.Workbook();s=w.active;s.append(['ID','NOTE']);s.append(['X1','记录一']);s.append(['X2','记录二']);w.save(sys.argv[1])", file]);
  const handle = await receipts.record(project, { name: "notes.xlsx", bytes: await fs.readFile(file), sessionId: "root" });
  const started = await intake(study, { action: "import_documents", ...handle, subjectColumn: "ID", textColumn: "NOTE" }, origin);
  await drain();
  assert.deepEqual([(await resultOf(started.jobId)).diagnostics.stored, (await peopleOf(study)).size], [2, 2]);
});

test("two people with the same words in one source each keep a document", options, async () => {
  const study = await newStudy();
  const handle = await receipts.record(project, { name: "same.csv", bytes: Buffer.from("ID,NOTE\nA1,无特殊\nA2,无特殊\nA1,无特殊\n"), sessionId: "root" });
  proposal = null;
  const started = await intake(study, { action: "import_documents", ...handle, subjectColumn: "ID", textColumn: "NOTE" }, origin);
  await drain();
  const { diagnostics } = await resultOf(started.jobId);
  assert.equal(diagnostics.people, 2);
  assert.equal(diagnostics.meaning.basis, "given");
  assert.equal((await peopleOf(study)).size, 2);
  assert.equal((await vcr.documents.roster(study)).length, 2, "the same words for the same person are one document");
});

test("a table saved by Excel in a Chinese locale reads as its characters", options, async () => {
  const study = await newStudy();
  const bytes = Buffer.from(new TextDecoder("utf-8").decode(Buffer.from("ID,NOTE\nA1,x\n")));
  const gb = Buffer.concat([bytes, Buffer.from([0x41, 0x32, 0x2c, 0xd6, 0xd0, 0xce, 0xc4, 0x0a])]);
  const handle = await receipts.record(project, { name: "gb.csv", bytes: gb, sessionId: "root" });
  const started = await intake(study, { action: "import_documents", ...handle, subjectColumn: "ID", textColumn: "NOTE" }, origin);
  await drain();
  assert.equal((await resultOf(started.jobId)).diagnostics.stored, 2);
  const files = (await vcr.dataStore.listSourceFilesForStudy(study.id)).filter((file) => file.role === "document");
  const texts = await Promise.all(files.map(async (file) => (await vcr.documents.runtimeRead({ ...study, cloudContext: { runId: "r", sessionId: "s" } }, { subjectKey: file.detail.subjectKey, documentId: file.id })).text));
  assert.ok(texts.includes("中文"));
});

test("a zip alone: the model says how a path names its person, and a file that cannot be read is listed, kept for retry, and read when the parser is back", options, async () => {
  const study = await newStudy();
  const archive = zipSync({
    "P001/2024-01-05_note.txt": strToU8("第一次就诊。"), "P001/2024-02-05_note.md": strToU8("第二次就诊。"), "P002/discharge.pdf": strToU8("%PDF-1.4 UNREADABLE"), "P002/scan.png": strToU8("IMG"),
    "P003/old.doc": strToU8("doc"), "P003/empty.txt": strToU8("   "), "__MACOSX/P001/x.txt": strToU8("skip"), ".hidden": strToU8("skip"),
  });
  const handle = await receipts.record(project, { name: "notes.zip", bytes: Buffer.from(archive), sessionId: "root" });
  const read = await intake.read(study, {}, origin);
  assert.deepEqual(read.noteUploads.map((row) => row.format), ["zip"]);
  proposal = { tables: [], files: { subject: { from: "folder", depth: 0 }, date: { from: "stem_part", separator: "_", index: 0 } } };
  const started = await intake(study, { action: "import_documents", ...handle }, origin);
  await drain();
  const { diagnostics, conclusion } = await resultOf(started.jobId);
  assert.equal(conclusion, "limited");
  assert.deepEqual([diagnostics.read, diagnostics.stored], [6, 3]);
  assert.deepEqual(diagnostics.skippedBy, { vcr_document_parser_failed: 1, format_unsupported: 1, empty_note: 1 });
  assert.equal(JSON.stringify(diagnostics).includes("discharge"), false, "a file's name stays out of the ledger");
  const report = await intake.read(study, { id: started.jobId }, origin);
  assert.deepEqual(report.importReport.rows.map((row) => [row.name, row.code, row.retry ?? false]).sort(), [["P002/discharge.pdf", "vcr_document_parser_failed", true], ["P003/empty.txt", "empty_note", false], ["P003/old.doc", "format_unsupported", false]]);
  const people = await peopleOf(study);
  assert.deepEqual([...people.values()].sort(), [1, 2]);
  const dated = (await vcr.dataStore.listSourceFilesForStudy(study.id)).filter((file) => file.detail.visibleAt);
  assert.deepEqual(dated.map((file) => file.detail.visibleAt.slice(0, 10)).sort(), ["2024-01-05", "2024-02-05"]);
  // The parser back: the same import takes only what is missing.
  parser.parseBytes = async ({ bytes }) => ({ text: `读出 ${bytes.length} 字节`, extractor: {} });
  const retry = await intake(study, { action: "import_documents", ...handle }, origin);
  await drain();
  const second = await resultOf(retry.jobId);
  assert.deepEqual([second.diagnostics.stored, second.diagnostics.repeated], [1, 3]);
  assert.equal((await peopleOf(study)).get([...people.keys()][0]) >= 1, true);
});

test("a roster file with a zip of notes: the roster says whose file is whose, and a file of nobody on it is left out and listed", options, async () => {
  const study = await newStudy();
  const roster = await receipts.record(project, { name: "roster.csv", bytes: Buffer.from("MRN,FILE,DATE\nM1,a.txt,2023-05-01\nM2,b.txt,2023-06-01\n"), sessionId: "root" });
  const notes = await receipts.record(project, { name: "folder.zip", bytes: Buffer.from(zipSync({ "a.txt": strToU8("甲的记录"), "b.txt": strToU8("乙的记录"), "c.txt": strToU8("没人的记录") })), sessionId: "root" });
  proposal = { tables: [{ input: 0, role: "roster", subject: "MRN", file: "FILE", date: "DATE" }], files: { subject: { from: "roster" } } };
  const started = await intake(study, { action: "import_documents", sources: [roster, notes] }, origin);
  await drain();
  const { diagnostics } = await resultOf(started.jobId);
  assert.deepEqual([diagnostics.stored, diagnostics.people, diagnostics.skippedBy.not_in_roster], [2, 2, 1]);
  const files = (await vcr.dataStore.listSourceFilesForStudy(study.id)).filter((file) => file.role === "document");
  assert.deepEqual(files.map((file) => file.detail.visibleAt.slice(0, 10)).sort(), ["2023-05-01", "2023-06-01"]);
  // Files uploaded one at a time are a folder too.
  const folder = await newStudy();
  const one = await receipts.record(project, { name: "Z1_a.txt", bytes: Buffer.from("一"), sessionId: "root" });
  const two = await receipts.record(project, { name: "Z1_b.txt", bytes: Buffer.from("二"), sessionId: "root" });
  const three = await receipts.record(project, { name: "Z2_a.txt", bytes: Buffer.from("三"), sessionId: "root" });
  proposal = null;
  const byFile = await intake(folder, { action: "import_documents", sources: [one, two, three] }, origin);
  await drain();
  const result = await resultOf(byFile.jobId);
  assert.equal(result.diagnostics.meaning.files, "shape_of_paths", "no model: the shape of the names, and it says so");
  assert.deepEqual([...(await peopleOf(folder)).values()].sort(), [1, 2]);
});

test("a model that cannot answer leaves a table waiting for its columns, says which there are, and asks nothing of a person's file", options, async () => {
  const study = await newStudy();
  const handle = await receipts.record(project, { name: "noanswer.csv", bytes: Buffer.from("WHO,WHAT\nA,x\n"), sessionId: "root" });
  proposal = null;
  const started = await intake(study, { action: "import_documents", ...handle }, origin);
  await drain();
  const failed = await vcr.store.one("SELECT state, error FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]);
  assert.deepEqual([failed.state, failed.error.code], ["failed", "vcr_import_columns_unknown"]);
  assert.match(failed.error.message, /2 列/u, "the ledger holds a count: in a table with no header row, a header is a patient");
  const listed = await vcr.dataPlane.readJobReport(study.id, started.jobId);
  assert.deepEqual(listed.find((row) => row.columns)?.columns, [["WHO", "WHAT"]], "the owner's conversation reads which columns there are, so the next start can name them");
  const wrong = await intake(study, { action: "import_documents", ...handle, subjectColumn: "NOPE", textColumn: "WHAT" }, origin);
  await drain();
  assert.equal((await vcr.store.one("SELECT error FROM evimed_vcr.jobs WHERE id=$1", [wrong.jobId])).error.code, "vcr_import_columns_unknown");
  const named = await intake(study, { action: "import_documents", ...handle, subjectColumn: "WHO", textColumn: "WHAT" }, origin);
  await drain();
  assert.equal((await resultOf(named.jobId)).diagnostics.stored, 1);
});

test("a cloud permission revoked on the source stops the sample, and a shape that is not a handle is refused", options, async () => {
  const study = await newStudy();
  await assert.rejects(() => intake(study, { action: "import_documents", sourceId: "upl_" + "0".repeat(40), generation: 1, sha256: "a".repeat(64) }, origin), { code: "vcr_intake_source_changed" });
  await assert.rejects(() => intake(study, { action: "import_standard", sourceId: "x", generation: 1, sha256: "a".repeat(64), format: "nope" }, origin), { code: "vcr_intake_payload_invalid" });
  await assert.rejects(() => intake(study, { action: "import_documents", made_up: 1 }, origin), { code: "vcr_intake_payload_invalid" });
});

test("while a long import takes turns, what else the account asked for runs between its batches", options, async () => {
  const study = await newStudy();
  const long = await receipts.record(project, { name: "long.csv", bytes: Buffer.from(["ID,NOTE", ...Array.from({ length: 400 }, (_, index) => `L${index},记录 ${index}`)].join("\n")), sessionId: "root" });
  const short = await receipts.record(project, { name: "short.csv", bytes: Buffer.from("ID,NOTE\nS1,短\n"), sessionId: "root" });
  const first = await intake(study, { action: "import_documents", ...long, subjectColumn: "ID", textColumn: "NOTE" }, origin);
  const [claimed] = await vcr.jobs.claim({ lane: "slow" });
  assert.equal(claimed.id, first.jobId);
  assert.deepEqual(await vcr.jobs.claim({ lane: "slow" }), [], "one running slow job per account");
  const second = await intake(study, { action: "import_documents", ...short, subjectColumn: "ID", textColumn: "NOTE" }, origin);
  assert.equal((await vcr.jobs.advance(claimed, { mayYield: true })).action, "yielded");
  const [next] = await vcr.jobs.claim({ lane: "slow" });
  assert.equal(next.id, second.jobId, "what was waiting goes before the long job's next batch");
  assert.equal((await vcr.jobs.advance(next, { mayYield: true })).action, "finished");
  await drain();
  assert.equal((await resultOf(first.jobId)).diagnostics.stored, 400);
});
