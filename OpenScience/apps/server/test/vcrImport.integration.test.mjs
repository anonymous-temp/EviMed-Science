// A source held in a standard format, from the file to the tables the engine reads,
// on real parts: the composed module (`composeVcr`) on a scratch PostgreSQL, a
// scratch data-plane directory, the real profiler, and the real converter script
// run through the very launch plan the container gets (`helpers/vcrIntakeLocal.mjs`).
//
// Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { tableView } from "../src/vcrDataPlane.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { streamOf } from "./helpers/vcrIntakeData.mjs";
import { MCP_DIR, localIntakeController, pythonCan } from "./helpers/vcrIntakeLocal.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { timeout: 120_000, skip: (!databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured") || (!pythonCan("json", "zipfile") && "python3 is needed") };
const OWNER = "import-owner";

/** @type {any} */ let isolated = null;
/** @type {any} */ let database = null;
/** @type {any} */ let vcr = null;
/** @type {string} */ let plane;
let counter = 0;

before(async () => {
  if (!databaseUrl || !pythonCan("json", "zipfile")) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrimport");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 3_000 });
  plane = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vcr-import-")));
  const config = {
    vcrEnabled: true, vcrDataPlaneDir: plane, vcrDataPlaneHostDir: plane, vcrAudience: "all", dataDir: path.join(plane, "..", "vcr-import-data"),
    vcrDataMaxBytes: 50 * 1024 * 1024, vcrIntakeMaxBytes: 25 * 1024 * 1024, vcrIntakeTimeoutMs: 60_000, vcrIntakeMemory: "768m",
    runtimeContainerImage: "img", runtimeContainerUser: "1000:1000", runtimeDataVolume: "",
  };
  vcr = composeVcr({ config, productDatabase: database, intakeController: localIntakeController(config) });
  await vcr.store.ready();
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
  if (plane) await fs.rm(plane, { recursive: true, force: true });
});

const smart = () => fs.readFile(path.join(MCP_DIR, "test", "fixtures", "vcr_imports", "smart-10-patients.zip"));

async function seedStudy() {
  counter += 1;
  return vcr.store.createStudy({ userId: OWNER, projectId: `prj_import_${counter}_${Math.random().toString(36).slice(2, 8)}`, name: `导入 ${counter}`, dataTier: "T2", intendedUse: "exploratory" });
}

test("a FHIR export is imported, confirmed, frozen and derived into the subject and events tables the engine reads", options, async () => {
  const study = await seedStudy();
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "医院 FHIR 导出", ownerParty: "合作医院", allowedUses: ["vcr"], valueSource: "observed" });
  const bytes = await smart();
  const imported = await vcr.dataPlane.importStandard({ actor: OWNER, studyId: study.id, sourceId: source.id, name: "export.zip", format: "fhir", stream: streamOf(bytes), declaredLength: bytes.length });
  assert.deepEqual(imported.tables.map((table) => [table.name, table.rows, table.stored]), [
    ["fhir_patient", 11, true], ["fhir_condition", 298, true], ["fhir_observation", 4188, true], ["fhir_medication", 172, true], ["fhir_procedure", 1341, true], ["fhir_encounter", 413, true],
  ]);
  assert.deepEqual(imported.fieldMap.entryIssues, []);
  assert.deepEqual(imported.fieldMap.mapIssues, []);

  // The proposal is a person's to confirm; then the snapshot freezes and the three analysis tables are derived.
  const confirmed = await vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, hash: imported.fieldMap.hash });
  assert.equal(confirmed.source.fieldMapState, "confirmed");
  const frozen = await vcr.dataPlane.freezeSnapshot({ userId: OWNER, studyId: study.id, sourceId: source.id });
  assert.deepEqual(frozen.tables.refused, []);
  const shapes = Object.fromEntries(frozen.tables.registered.map((table) => [table.shape, tableView(table)]));
  assert.deepEqual(Object.keys(shapes).sort(), ["events", "subject"]);
  assert.equal(shapes.subject.rowCount, 11);
  assert.equal(shapes.events.rowCount, 11);
  assert.equal(frozen.tables.subjects, 11);
  // Each column's source travels with the table: the follow-up is computed, the death flag is a fact, and the table is labelled with the weakest.
  assert.equal(shapes.events.valueSource, "calculated");
  assert.deepEqual(shapes.events.columnSources, { AVAL: "calculated", CNSR: "calculated", STARTDT: "calculated" });
  assert.deepEqual(shapes.subject.columnSources, { SEX: "observed", BRTHYR: "calculated", RACE: "observed", ETHNIC: "observed", AGE: "calculated", DTHFL: "observed" });
  assert.equal(shapes.subject.outcomeBearing, true, "the death flag is an outcome and is sealed with the pair");
  assert.deepEqual(frozen.tables.excluded, [], "no column of the import is one the profiler had to take out of the analysis tables");

  // The control plane holds counts and structure, never a row: no text or jsonb column of the schema carries a patient's id as the source system issued it.
  const ids = ["da73946b-70a8-ae1a-ca15-b83201e441dd", "0bee1bc6-1a91-bcd5-7bc0-02fadc5217d6", "f2d47e71-b5ce-4223-79a6-6c9761313213"];
  const columns = (await database.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'evimed_vcr' AND data_type IN ('text', 'jsonb', 'character varying')`)).rows;
  assert.ok(columns.length > 20, "the scan read the schema");
  for (const { table_name: table, column_name: column } of columns) {
    for (const id of ids) {
      const found = (await database.query(`SELECT count(*)::int AS n FROM evimed_vcr."${table}" WHERE "${column}"::text LIKE $1`, [`%${id}%`])).rows[0].n;
      assert.equal(found, 0, `${id} is in evimed_vcr.${table}.${column}`);
    }
  }
  // What the model may read of the source says no row either.
  const forModel = JSON.stringify(await vcr.dataPlane.snapshotProfileForModel({ studyId: study.id, snapshotId: frozen.snapshot.id, principal: OWNER }))
    + JSON.stringify(await vcr.dataPlane.sourceProfileForModel({ studyId: study.id, sourceId: source.id, principal: OWNER }));
  for (const id of ids) assert.ok(!forModel.includes(id), `${id} reached what the runtime can read`);
  // The dictionary the import generated is part of that: it describes columns and carries the value source of each.
  assert.match(forModel, /fhir_patient\.os_days/);
  assert.match(forModel, /calculated/);

  // Nothing of the staging is left in the plane; the original upload was never kept.
  const scratch = await fs.readdir(path.join(plane, "studies", study.id, ".intake")).catch(() => []);
  assert.deepEqual(scratch, []);
});

test("a person's edit of the imported map keeps every column's source, and a re-import replaces its own tables only", options, async () => {
  const study = await seedStudy();
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "医院 FHIR 导出", allowedUses: ["vcr"], valueSource: "observed" });
  const bytes = await smart();
  await vcr.dataPlane.importStandard({ actor: OWNER, studyId: study.id, sourceId: source.id, name: "export.zip", format: "fhir", stream: streamOf(bytes) });
  // The person's own file lands in the same source, then the same export is imported again.
  await vcr.dataPlane.storeUpload({ actor: OWNER, studyId: study.id, sourceId: source.id, name: "cohort.csv", stream: streamOf("ID,AGE\nA,40\nB,50\nC,60\n") });
  await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, columns: [
    ...(await vcr.dataStore.sourceInStudy(study.id, source.id)).fieldMap.columns,
    { table: "cohort.csv", column: "ID", role: "subject_key" }, { table: "cohort.csv", column: "AGE", role: "covariate", alias: "AGE" },
  ] });
  const patientEntries = (await vcr.dataStore.sourceInStudy(study.id, source.id)).fieldMap.columns.filter((entry) => entry.table === "fhir_patient.csv");
  assert.equal(patientEntries.length, 10, "the import's own entries for the patient table");
  const again = await vcr.dataPlane.importStandard({ actor: OWNER, studyId: study.id, sourceId: source.id, name: "export.zip", format: "fhir", stream: streamOf(bytes) });
  assert.equal(again.created, 0, "the same bytes are the same files");
  const held = (await vcr.dataStore.sourceInStudy(study.id, source.id)).fieldMap.columns;
  assert.equal(held.filter((entry) => entry.table === "cohort.csv").length, 2, "another file's entries are kept");
  assert.equal(held.filter((entry) => entry.table === "fhir_patient.csv").length, 10, "the re-import replaced its own entries, it did not add to them");
  // The person's own covariate and the import's AGE no longer collide: the import renamed its own, and the map is valid as a whole.
  assert.equal(held.find((entry) => entry.table === "cohort.csv" && entry.column === "AGE").alias, "AGE");
  assert.equal(held.find((entry) => entry.table === "fhir_patient.csv" && entry.column === "age_at_index").alias, "AGE_2");
  assert.equal(again.fieldMap.entries, held.length);
  assert.deepEqual(again.fieldMap.entryIssues, []);
  assert.deepEqual(again.fieldMap.mapIssues, []);
  const ages = held.filter((entry) => entry.role === "covariate").map((entry) => entry.alias ?? entry.column);
  assert.equal(new Set(ages).size, ages.length, "no analysis name twice");
  assert.ok(held.every((entry) => entry.table === "cohort.csv" || entry.valueSource), "every imported column still carries its source");
  // A person's edit saved through the route's own normalisation keeps the sources too: they are one of the keys an entry may have.
  const resaved = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, columns: held });
  assert.equal(resaved.hash, again.fieldMap.hash, "saving the same map again is the same map");
});
