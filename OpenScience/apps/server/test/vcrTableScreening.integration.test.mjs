// A table study from a real upload to a verdict: a small cohort uploaded through the plane, its field map confirmed and frozen, a protocol's rules, the model reading what the codes mean
// (the one thing a model does here), and the rule evaluation deciding. PostgreSQL and the real plane; the model is a double. A table under the small-cell floor is read like any other.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { DataSemanticsService } from "../src/dataSemanticsService.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required", timeout: 60_000 };
let isolated, database, directory, vcr, semantics;
/** @type {any[]} */
const asked = [];

const COHORT = ["ID,AGE,DIABETES", ...Array.from({ length: 8 }, (_, index) => `S${index + 1},${50 + index},${index % 2}`)].join("\n");
const MAP = [
  { table: "cohort.csv", column: "ID", role: "subject_key", identifier: true },
  { table: "cohort.csv", column: "AGE", role: "covariate", alias: "age", unit: "year", concept: "age", type: "integer" },
  { table: "cohort.csv", column: "DIABETES", role: "covariate", alias: "diabetes", concept: "diabetes" },
];

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrtablescreen");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner','project','Project',100000000)");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-tablescreen-"));
  await fs.mkdir(path.join(directory, "plane"));
  semantics = new DataSemanticsService({ documents: new ProductDocuments(database) });
  const fetchImpl = async (/** @type {any} */ _input, /** @type {any} */ init) => {
    const body = JSON.parse(init.body);
    asked.push(body.messages.map((/** @type {any} */ message) => message.content).join("\n"));
    const content = JSON.stringify({ columns: [{ name: "diabetes", concept: "diabetes", measurement: false, values: { 1: "present", 0: "absent" } }] });
    return new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  vcr = composeVcr({ productDatabase: database, fetchImpl, dataSemantics: () => semantics, config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: await fs.realpath(path.join(directory, "plane")), deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrProviderAgreements: true } });
  await vcr.store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

test("eight people in a table: their 0 and 1 are read, the rules decide, and what the codes were read to mean can be seen and corrected by a plain path", options, async () => {
  const study = await vcr.store.createStudy({ userId: "owner", projectId: "project", name: "Table", question: "q", dataTier: "T1" });
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "基线表", ownerParty: "医院", allowedUses: ["vcr", "matching"] });
  await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "cohort.csv", stream: Readable.from([Buffer.from(COHORT)]) });
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: "owner", studyId: study.id, sourceId: source.id, columns: MAP });
  await vcr.dataPlane.confirmFieldMap({ actor: "owner", studyId: study.id, sourceId: source.id, hash: proposed.hash });
  await vcr.dataPlane.freezeSnapshot({ userId: "owner", studyId: study.id, sourceId: source.id });
  await vcr.matchStore.saveProtocolVersion({ studyId: study.id, userId: "owner", title: "P", criteria: [
    { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } },
    { kind: "exclusion", criterionType: "diagnosis", sourceText: "Diabetes", requirement: { op: "not", operand: { op: "present", variable: "diabetes" } } },
  ] });
  const queued = await vcr.matching.enqueuePanel(study, { direction: "trial_to_patient" }, "page");
  assert.deepEqual(queued.unavailable, []);
  assert.equal(queued.jobs.length, 1);
  assert.match(asked.at(-1), /"values":\s*\[\s*"0",\s*"1"\s*\]/su, "the table's codes reach the model, under the floor as over it");
  for (let turn = 0; turn < 20; turn += 1) {
    const claimed = await vcr.jobs.claim({});
    if (!claimed.length) break;
    for (const job of claimed) await vcr.jobs.advance(job, { mayYield: true });
  }
  const job = await vcr.jobs.get(study.id, queued.jobs[0].jobId);
  assert.equal(job.state, "succeeded", JSON.stringify(job.error));
  const summaries = await database.query("SELECT subject_key, summary FROM evimed_vcr.matching_assessments WHERE study_id = $1", [study.id]);
  assert.equal(summaries.rows.length, 8);
  const counts = summaries.rows.reduce((all, row) => ({ ...all, [row.summary]: (all[row.summary] ?? 0) + 1 }), /** @type {Record<string, number>} */ ({}));
  assert.deepEqual(counts, { eligible: 4, ineligible: 4 }, "a 1 is the exclusion met, a 0 is not; nothing stays open for want of a map");

  // Someone only in a table is someone the study holds: 重新判定 asks this.
  assert.equal(await vcr.service.packages.subjectKnown(study, summaries.rows[0].subject_key), true);
  // What the codes were read to mean, and how to correct it, with no opaque id to find.
  const read = await vcr.matching.runtimeRead(study, { kind: "table_meaning" });
  assert.equal(read.available, true);
  assert.match(read.datasetId, /^vcr-tbl-/u);
  const column = read.columns.find((/** @type {any} */ row) => row.name === "diabetes");
  assert.deepEqual(column.valueMap.values, { 1: "present", 0: "absent" });
  assert.deepEqual([read.correct.tool, read.correct.datasetId], ["dataset_semantics", read.datasetId]);
  const contract = await vcr.matching.runtimeRead(study, { kind: "contract" });
  assert.deepEqual(contract.tableMeaningRead, { what: "matching", filter: { kind: "table_meaning" } });
  assert.deepEqual((await vcr.matching.runtimeRead({ ...study, id: "std_none" }, { kind: "table_meaning" })).available, false);
});
