// Conditions, labs and medications from a source imported in a standard format, started from the conversation and read by the judging job as dated lines beside a person's notes. The real
// converter on the real fixtures, the real plane and PostgreSQL; the model is a double. The rule for what a person with thousands of rows shows is pure and tested on its own.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { createVcrDataIntake } from "../src/vcrDataIntake.mjs";
import { LONG_LIMITS, acceptLongShapes, acceptRelevance, chooseLongRows, longRowLine, longShapeOf } from "../src/vcrLongTables.mjs";
import { readSubjectNote } from "../src/vcrMatchJudge.mjs";
import { createVcrUploadReceipts } from "../src/vcrUploadReceipts.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { MCP_DIR, localIntakeController, pythonCan } from "./helpers/vcrIntakeLocal.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { timeout: 240_000, skip: (!url && "An isolated PostgreSQL is required") || (!pythonCan("json", "zipfile") && "python3 is needed") };
let isolated, database, directory, vcr, intake, receipts, project, documents;
let sequence = 0;
/** @type {any[]} */ const asked = [];
/** @type {any} */ let relevance = { relevant: [] };
const shapes = { tables: [] };
const origin = { userId: "owner", projectId: "project", rootSessionId: "root", runId: "run", callId: "call" };

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(url, "vcrlong");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development')");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-long-"));
  await fs.mkdir(path.join(directory, "plane"));
  const plane = await fs.realpath(path.join(directory, "plane"));
  const config = { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: plane, vcrDataPlaneHostDir: plane, dataDir: path.join(directory, "data"), vcrDataMaxBytes: 50 * 1024 * 1024, vcrIntakeMaxBytes: 25 * 1024 * 1024, vcrIntakeTimeoutMs: 60_000, vcrIntakeMemory: "768m", runtimeContainerImage: "img", runtimeContainerUser: "1000:1000", runtimeDataVolume: "", deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrProviderAgreements: true };
  const fetchImpl = async (input, init) => {
    if (String(input).includes("clinicaltrials.gov")) {
      const id = /NCT\d{8}/.exec(String(input))[0];
      return new Response(JSON.stringify({ protocolSection: { identificationModule: { nctId: id, briefTitle: `Trial ${id}` }, descriptionModule: { briefSummary: "S" }, statusModule: { overallStatus: "RECRUITING" }, conditionsModule: { conditions: ["NSCLC"] }, armsInterventionsModule: { interventions: [{ type: "DRUG", name: "X" }] }, eligibilityModule: { eligibilityCriteria: "Inclusion Criteria:\n* Age >= 18" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    asked.push({ system, user: body.messages.at(-1).content });
    const content = system.includes("say which concepts") || system.includes("Say which concepts") ? JSON.stringify(relevance) : system.includes("what each column is") ? JSON.stringify(shapes)
      : system.includes("criterion level") ? JSON.stringify({ 1: ["年龄", [Number(/(\d+)\D{0,4}\d{4}-\d{2}-\d{2} (?:诊断|检验|用药|操作)/u.exec(body.messages.at(-1).content)?.[1] ?? 0)], "included"] }) : '{"score":70,"confidence":0.6,"eligible_reasons":"1. a","ineligible_reasons":"","missing_information":""}';
    return new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  vcr = composeVcr({ config, productDatabase: database, fetchImpl, intakeController: localIntakeController(config) });
  await vcr.store.ready();
  documents = new ProductDocuments(database);
  receipts = createVcrUploadReceipts({ documents, sources: null, resolveProject: async () => project });
  vcr.recordsOriginals.receipts = receipts;
  intake = createVcrDataIntake({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, sources: receipts, resolveProject: async () => project, recordsImport: vcr.recordsImport });
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

const fixture = (name) => fs.readFile(path.join(MCP_DIR, "test", "fixtures", "vcr_imports", name));
const newStudy = async () => {
  const id = `project-${++sequence}`;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner',$1,'Project',1000000000)", [id]);
  project = { userId: "owner", id, baseDir: path.join(directory, id) };
  await fs.mkdir(project.baseDir);
  origin.projectId = id;
  return vcr.store.createStudy({ userId: "owner", projectId: id, name: `Long ${sequence}`, question: "q", dataTier: "T0" });
};
const drain = async () => {
  for (let turn = 0; turn < 60; turn += 1) {
    const claimed = await vcr.jobs.claim({ lane: "slow" });
    if (!claimed.length) return;
    for (const job of claimed) await vcr.jobs.advance(job, { mayYield: true });
  }
  assert.fail("the jobs did not finish");
};
const resultOf = (jobId) => vcr.store.one("SELECT r.conclusion, r.diagnostics FROM evimed_vcr.results r JOIN evimed_vcr.executions e ON e.id = r.execution_id WHERE e.job_id=$1 ORDER BY r.created_at DESC LIMIT 1", [jobId]);
const importStandard = async (study, name, format) => {
  const handle = await receipts.record(project, { name, bytes: await fixture(name), sessionId: "root" });
  const started = await intake(study, { action: "import_standard", ...handle, format }, origin);
  assert.equal(started.ok, true);
  await drain();
  const result = await resultOf(started.jobId);
  assert.ok(result, `the job wrote a result: ${JSON.stringify((await vcr.store.one("SELECT state, error FROM evimed_vcr.jobs WHERE id=$1", [started.jobId])))}`);
  return result.diagnostics.standard;
};
const readerOf = (study) => vcr.documents.longTables({ ...study, cloudContext: { runId: "r", sessionId: "s" } });

test("a row is a dated line in the source's own words, and a closed list knows the converter's and CDISC's columns", () => {
  const cell = (values) => (name) => values[name] ?? "";
  const lab = longShapeOf(["USUBJID", "effective_date", "value_number", "display", "value_unit"]);
  assert.equal(lab.kind, "lab");
  assert.deepEqual(longRowLine(lab, cell({ effective_date: "2023-02-01", display: "HbA1c", value_number: "7.5", value_unit: "%", value_comparator: "<" })), { date: "2023-02-01", kind: "lab", concept: "HbA1c", line: "2023-02-01 检验 HbA1c < 7.5 %" });
  const condition = longShapeOf(["onset_date", "clinical_status", "display"]);
  assert.equal(longRowLine(condition, cell({ onset_date: "2019-05-03", display: "Type 2 diabetes", clinical_status: "active", abatement_date: "2021-01-01" })).line, "2019-05-03 诊断 Type 2 diabetes（active，至 2021-01-01）");
  assert.equal(longRowLine(condition, cell({ onset_date: "2019-05-03" })), null, "a row that names nothing says nothing");
  const omop = longShapeOf(["USUBJID", "drug_concept_id", "drug_exposure_start_date"]);
  assert.equal(longRowLine(omop, cell({ drug_concept_id: "1503297", drug_exposure_start_date: "2020-01-01" }), new Map([["1503297", "Metformin"]])).line, "2020-01-01 用药 Metformin");
  assert.equal(longShapeOf(["USUBJID", "PARAM", "AVAL", "ADT"]).kind, "lab");
  assert.equal(longShapeOf(["USUBJID", "TEST", "RESULT"]), null, "a long CSV is the model's to read");
});

test("a person with thousands of rows shows what bears on the question, its first appearance and that everything else exists, and says what is left out", () => {
  const rows = [];
  for (let day = 0; day < 5000; day += 1) rows.push({ date: new Date(Date.UTC(2010, 0, 1 + day)).toISOString().slice(0, 10), concept: day % 2 ? "Heart rate" : "Weight", line: `L${day}` });
  rows.push({ date: "2012-06-01", concept: "Pregnancy test", line: "preg" }, { date: "2011-01-01", concept: "EGFR", line: "egfr-old" }, { date: "2013-01-01", concept: "EGFR", line: "egfr-new" });
  const { chosen, leftOut } = chooseLongRows(rows, new Set(["EGFR"]), { lines: 20 });
  const lines = chosen.map((row) => row.line);
  assert.equal(chosen.length, 20);
  assert.ok(lines.includes("egfr-old") && lines.includes("egfr-new"), "the chosen concept, all of its few rows");
  assert.ok(lines.includes("preg"), "an old row of another concept: nothing vanishes just for being old");
  assert.ok(lines.includes("L4999"), "and the most recent");
  assert.deepEqual(chosen.map((row) => row.date), [...chosen.map((row) => row.date)].sort(), "in order of time");
  assert.equal(leftOut.rows, rows.length - 20);
  assert.equal(leftOut.earliest, "2010-01-01");
  const many = chooseLongRows(rows, new Set(), { chars: 50 });
  assert.ok(many.chosen.reduce((sum, row) => sum + row.line.length + 1, 0) <= 50, "the size is bounded in characters too");
  assert.equal(chooseLongRows([{ date: "2020-01-01", concept: "a", line: "only" }], new Set()).leftOut, null, "nothing left out says nothing");
  assert.ok(LONG_LIMITS.lines >= 100);
});

test("what the model says of a table or a concept is taken only where it exists", () => {
  const shapes_ = acceptLongShapes(JSON.stringify({ tables: [{ id: "t1", kind: "lab", concept: "TEST", value: "RESULT", unit: "NOPE", date: "WHEN" }, { id: "t2", kind: "lab", concept: "MADE_UP" }, { id: "gone", concept: "TEST" }] }), [{ id: "t1", header: ["USUBJID", "TEST", "RESULT", "WHEN"] }, { id: "t2", header: ["USUBJID", "A"] }]);
  assert.deepEqual(Object.keys(shapes_), ["t1"]);
  assert.deepEqual(shapes_.t1.concept, ["TEST"]);
  assert.equal(shapes_.t1.unit, undefined);
  assert.deepEqual(acceptRelevance('{"relevant":["A","Z"]}', ["A", "B"]), ["A"]);
  assert.deepEqual(acceptRelevance("nonsense", ["A"]), []);
});

test("a FHIR export started from the conversation: converted, mapped and frozen by the job, and its conditions, labs and medications are a person's dated lines", options, async () => {
  const study = await newStudy();
  const standard = await importStandard(study, "smart-10-patients.zip", "fhir");
  assert.match(standard.snapshotId, /./);
  assert.ok(standard.tables.some((table) => table.name === "fhir_condition" && table.stored));
  assert.ok(standard.coverage, "what was read and skipped comes back");
  const reader = await readerOf(study);
  assert.ok(reader, "the frozen source has long tables");
  assert.deepEqual(await reader.unknownTables(), [], "the converter's own tables need no one to read their columns");
  const concepts = await reader.concepts();
  assert.deepEqual((await reader.described()).filter((table) => table.kind).map((table) => table.kind).sort(), ["condition", "lab", "medication", "procedure"]);
  assert.ok(concepts.length > 20);
  const roster = (await vcr.store.rows("SELECT id FROM evimed_vcr.analysis_tables WHERE study_id=$1", [study.id])).length;
  assert.ok(roster >= 1);
  const table = await vcr.dataPlane.subjectTableForMatching({ studyId: study.id, principal: "owner", purpose: "vcr" });
  const at = table.header.indexOf("USUBJID");
  const keys = [...new Set(table.rows.map((row) => row[at]))];
  assert.ok(keys.length >= 5);
  reader.setRelevant([concepts[0]]);
  const held = await reader.linesFor(keys[0], keys.slice(1));
  assert.ok(held.lines.length > 0, "a person has lines");
  assert.ok(held.lines.length <= LONG_LIMITS.lines);
  const text = held.lines.map((line) => line.text).join("\n");
  assert.match(text, /\d{4}-\d{2}-\d{2} (诊断|检验|用药|操作) /, "dated, labelled and in the source's words");
  assert.match(text, /诊断 |用药 /);
  assert.equal(/\bpatient_id\b|USUBJID/.test(text), false);
  const note = await readSubjectNote({ study: { ...study, cloudContext: { runId: "r", sessionId: "s" } }, subjectKey: keys[0], documents: vcr.documents, roster: [], long: reader });
  assert.ok(note.sentences.length >= held.lines.length);
  assert.ok(note.sentences.every((sentence) => sentence.source?.long && sentence.source.snapshotId === standard.snapshotId));

  // The whole path: a judging job reads them, picks the relevant concepts once, and a reader gets the evidence back.
  asked.length = 0;
  relevance = { relevant: concepts.slice(0, 5) };
  const started = await vcr.matchJudge.start({ ...study, cloudContext: { runId: "r", sessionId: "s" } }, { subjectKey: keys[0], registryIds: ["NCT00000001"], topK: 1 });
  await drain();
  const askedRelevance = asked.filter((call) => call.system.includes("Say which concepts"));
  assert.equal(askedRelevance.length, 1, "the choice is asked once");
  assert.ok(JSON.parse(askedRelevance[0].user).concepts.includes(concepts[0]));
  const judged = asked.find((call) => call.system.includes("criterion level"));
  assert.match(judged.user, /\d{4}-\d{2}-\d{2} (诊断|检验|用药|操作) /, "the model reads the dated lines");
  const result = await resultOf(started.jobId);
  assert.deepEqual([result.diagnostics.finished, result.diagnostics.total], [1, 1]);
  const context = { ...study, cloudContext: { runId: "r", sessionId: "s" } };
  const ranking = await vcr.matchJudgmentReads.forSubject(context, keys[0]);
  assert.equal(ranking.ranking.length, 1);
  assert.ok(ranking.ranking[0].criteria[0].evidence.length >= 1, "evidence read from a long line comes back");
  assert.equal(ranking.ranking[0].criteria[0].evidenceWithheld, undefined);
  assert.ok(ranking.ranking[0].criteria[0].evidence[0].source.long);
  const sentences = await vcr.service.runtimeRead(context, "subject_document", { subjectKey: keys[0], kind: "sentences" });
  assert.ok(sentences.sentences.length > 0);
  assert.ok(sentences.sentences.every((row) => row.fromTable));
  // A second start of the same selection reads the same words and pays for nothing, and does not ask again.
  const calls = asked.length;
  await vcr.matchJudge.start(context, { subjectKey: keys[0], registryIds: ["NCT00000001"], topK: 1 });
  await drain();
  assert.equal(asked.length, calls, "the choice and the judgment are both on record");
});

test("an OMOP source reads its concept ids as names, and an ADaM source its PARAM rows", options, async () => {
  const study = await newStudy();
  const standard = await importStandard(study, "gibleed-5.3-first150.zip", "omop");
  const reader = await readerOf(study);
  const concepts = await reader.concepts();
  assert.ok(concepts.some((name) => /[A-Za-z]{3}/.test(name) && !/^\d+$/.test(name)), "names, not bare ids");
  assert.deepEqual(await reader.unknownTables(), [], JSON.stringify(standard.tables.map((table) => table.name)));
  const adam = await newStudy();
  await importStandard(adam, "adam-pharmaverse.zip", "adam");
  const adamReader = await readerOf(adam);
  assert.ok((await adamReader.concepts()).length > 0);
});

test("a long CSV: the model reads its columns once, a person gets their rows, and a read names no one else's", options, async () => {
  const study = await newStudy();
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "Labs", allowedUses: ["vcr", "matching"], actor: "owner" });
  const rows = ["PID,TEST,RESULT,UNIT,WHEN"];
  for (let person = 0; person < 12; person += 1) for (let visit = 0; visit < 6; visit += 1) rows.push(`LAB-${person},eGFR,${60 + person},mL/min,2024-0${visit + 1}-10`);
  rows.push("LAB-0,HbA1c,7.1,%,2024-03-01");
  await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "labs.csv", role: "data", stream: (async function* () { yield Buffer.from(rows.join("\n")); })() });
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: "owner", userId: "owner", studyId: study.id, sourceId: source.id, by: "run", columns: [{ table: "labs.csv", column: "PID", role: "subject_key", concept: "subject" }] });
  await vcr.dataPlane.confirmFieldMap({ actor: "owner", userId: "owner", studyId: study.id, sourceId: source.id, hash: proposed.hash, by: "run" });
  await vcr.dataPlane.freezeSnapshot({ actor: "owner", userId: "owner", studyId: study.id, sourceId: source.id, expectedFieldMapHash: proposed.hash });
  const reader = await readerOf(study);
  const unknown = await reader.unknownTables();
  assert.equal(unknown.length, 1);
  assert.ok(unknown[0].header.includes("USUBJID"), "pseudonymised before anyone reads it");
  assert.equal(JSON.stringify(unknown).includes("LAB-0"), false, "the sample holds no original identifier");
  await reader.setShapes(acceptLongShapes(JSON.stringify({ tables: [{ id: unknown[0].id, kind: "lab", concept: "TEST", value: "RESULT", unit: "UNIT", date: "WHEN" }] }), unknown));
  assert.deepEqual((await reader.concepts()).sort(), ["HbA1c", "eGFR"]);
});
