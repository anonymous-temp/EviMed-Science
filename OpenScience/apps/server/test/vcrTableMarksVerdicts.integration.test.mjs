// New structured data for people who already hold a verdict: a snapshot frozen after they were judged labels their verdicts as resting on an older record, as a new document does,
// and touches nobody the table does not name. PostgreSQL and the real plane.
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
  isolated = await createGeoTestDatabase(url, "vcrtablemark");
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


test("a snapshot frozen after people were judged marks their verdicts and nobody else's", options, async () => {
  const study = await vcr.store.createStudy({ userId: "owner", projectId: "project", name: "Table", question: "q", dataTier: "T1" });
  const save = (/** @type {string} */ subjectKey, /** @type {string} */ status = "done") => vcr.matchJudgments.save({ studyId: study.id, userId: "owner", subjectKey, targetKind: "candidate_trial", targetId: "NCT00000001",
    targetHash: "t", documentHash: "d", mode: "fit", promptVersion: "p", model: "m", thinking: "", producer: "job", status, fit: 80, confidence: 0.7, verdict: "eligible", answer: { reasons: {} } });
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "基线表", ownerParty: "医院", allowedUses: ["vcr", "matching"] });
  await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "cohort.csv", stream: Readable.from([Buffer.from(COHORT)]) });
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: "owner", studyId: study.id, sourceId: source.id, columns: MAP });
  await vcr.dataPlane.confirmFieldMap({ actor: "owner", studyId: study.id, sourceId: source.id, hash: proposed.hash });
  await vcr.dataPlane.freezeSnapshot({ userId: "owner", studyId: study.id, sourceId: source.id });
  // The people the table names, as the study keeps them (pseudonyms).
  await vcr.matchStore.saveProtocolVersion({ studyId: study.id, userId: "owner", title: "P", criteria: [
    { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } } ] });
  await vcr.matching.enqueuePanel(study, { direction: "trial_to_patient" }, "page");
  for (let turn = 0; turn < 20; turn += 1) {
    const claimed = await vcr.jobs.claim({});
    if (!claimed.length) break;
    for (const job of claimed) await vcr.jobs.advance(job, { mayYield: true });
  }
  const keys = (await database.query("SELECT subject_key FROM evimed_vcr.matching_assessments WHERE study_id = $1 ORDER BY subject_key", [study.id])).rows.map((row) => String(row.subject_key));
  assert.ok(keys.length >= 2);
  await save(keys[0]); await save(keys[1], "failed"); await save("OUTSIDER");
  assert.ok((await vcr.matchJudgments.list({ studyId: study.id })).every((row) => row.basisChanged === null));
  await vcr.dataPlane.freezeSnapshot({ userId: "owner", studyId: study.id, sourceId: source.id });
  const after = await vcr.matchJudgments.list({ studyId: study.id });
  const mark = (/** @type {string} */ key) => after.find((row) => row.subjectKey === key).basisChanged;
  assert.equal(mark(keys[0]), "document", "judged, and now in a table that was not there when they were judged");
  assert.equal(mark(keys[1]), null, "a failed row has no verdict to label");
  assert.equal(mark("OUTSIDER"), null, "not in the table");
});
