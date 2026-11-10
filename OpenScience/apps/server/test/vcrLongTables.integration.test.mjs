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
import { LONG_LIMITS, chooseLongRows, longRowLine, longShapeOf } from "../src/vcrLongTables.mjs";
import { createVcrUploadReceipts } from "../src/vcrUploadReceipts.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { MCP_DIR, localIntakeController, pythonCan } from "./helpers/vcrIntakeLocal.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { timeout: 240_000, skip: (!url && "An isolated PostgreSQL is required") || (!pythonCan("json", "zipfile") && "python3 is needed") };
let isolated, database, directory, vcr, intake, receipts, project, documents;
let sequence = 0;
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
  const fetchImpl = async (input) => {
    if (String(input).includes("clinicaltrials.gov")) {
      const id = /NCT\d{8}/.exec(String(input))[0];
      return new Response(JSON.stringify({ protocolSection: { identificationModule: { nctId: id, briefTitle: `Trial ${id}` }, descriptionModule: { briefSummary: "S" }, statusModule: { overallStatus: "RECRUITING" }, conditionsModule: { conditions: ["NSCLC"] }, armsInterventionsModule: { interventions: [{ type: "DRUG", name: "X" }] }, eligibilityModule: { eligibilityCriteria: "Inclusion Criteria:\n* Age >= 18" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
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

