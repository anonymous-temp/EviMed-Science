// The `evimed_vcr` schema against a real PostgreSQL: it creates, it creates
// again without complaint, its CHECKs refuse a word that is not in the
// vocabulary, and deleting a study takes its rows with it while the audit trail
// stays. Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VCR_TABLES, migrateVcr } from "../src/vcrPersistence.mjs";
import { VcrStoreBase, deleteVcrStudyRows, deleteVcrUserRows, vcrId } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */
let database = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {VcrStoreBase | null} */
let store = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcr");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new VcrStoreBase({ database });
  await store.ready();
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;

const USER = "vcr-tester";

/** One study, so the foreign keys have a parent. */
async function seedStudy(id = vcrId("study")) {
  await q(`INSERT INTO evimed_vcr.studies (id, user_id, project_id, name, question, data_tier, intended_use)
    VALUES ($1, $2, $3, 'EV-201 二线 NSCLC', '单臂能否用外部对照', 'T0', 'exploratory')`, [id, USER, `prj_${id}`]);
  return id;
}

test("the migration creates every declared table and runs twice without complaint", options, async () => {
  const first = await migrateVcr(database);
  assert.equal(first.tables.length, VCR_TABLES.length);
  const rows = await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'evimed_vcr' ORDER BY table_name");
  assert.deepEqual(rows.map((row) => row.table_name).sort(), [...VCR_TABLES].sort());
  // A second migration is a no-op: the cache is per database object, so this
  // proves the SQL itself is idempotent, not that it was skipped.
  await database.transaction(async (client) => {
    const { vcrSchemaSql } = await import("../src/vcrPersistence.mjs");
    await client.query(vcrSchemaSql());
  });
  const after = await q("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'evimed_vcr'");
  assert.equal(after[0].n, VCR_TABLES.length);
});

test("a study is one project per account, and a second one is refused", options, async () => {
  const id = await seedStudy();
  const row = (await q("SELECT project_id FROM evimed_vcr.studies WHERE id = $1", [id]))[0];
  await assert.rejects(
    q(`INSERT INTO evimed_vcr.studies (id, user_id, project_id, name) VALUES ($1, $2, $3, 'again')`,
      [vcrId("study"), USER, row.project_id]),
    /duplicate key|unique/i);
});

test("a word outside the vocabulary is refused by the schema, not by a comment", options, async () => {
  const id = await seedStudy();
  await assert.rejects(
    q(`UPDATE evimed_vcr.studies SET data_tier = 'T9' WHERE id = $1`, [id]), /check constraint/i);
  await assert.rejects(
    q(`INSERT INTO evimed_vcr.members (study_id, user_id, role) VALUES ($1, 'x', 'archivist')`, [id]), /check constraint/i);
  await assert.rejects(
    q(`INSERT INTO evimed_vcr.results (id, study_id, user_id, kind, conclusion) VALUES ($1, $2, $3, 'trial', 'probably')`,
      [vcrId("result"), id, USER]), /check constraint/i);
});

test("versions are allocated under the row lock, so two writers cannot both take v1", options, async () => {
  const id = await seedStudy();
  const write = async () => store.transaction(async (client) => {
    const version = await store.nextVersion(client, "assumptions", "study_id = $1 AND key = $2", [id, "control_orr"]);
    await client.query(`INSERT INTO evimed_vcr.assumptions (id, study_id, user_id, key, version, name, source_kind)
      VALUES ($1, $2, $3, 'control_orr', $4, '对照组 ORR', 'external_evidence')`, [vcrId("assumption"), id, USER, version]);
    return version;
  });
  const versions = [];
  for (let index = 0; index < 3; index += 1) versions.push(await write());
  assert.deepEqual(versions, [1, 2, 3]);
  await assert.rejects(
    q(`INSERT INTO evimed_vcr.assumptions (id, study_id, user_id, key, version, name, source_kind)
       VALUES ($1, $2, $3, 'control_orr', 2, '对照组 ORR', 'external_evidence')`, [vcrId("assumption"), id, USER]),
    /duplicate key|unique/i);
});

test("every write can be audited, and the audit outlives the study it describes", options, async () => {
  const id = await seedStudy();
  await store.audit({ studyId: id, userId: USER, actor: USER, action: "study.create", object: id, detail: { tier: "T0" } });
  await store.transaction((client) => deleteVcrStudyRows(client, id));
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.studies WHERE id = $1", [id]))[0].n, 0);
  const audit = await q("SELECT action, detail FROM evimed_vcr.audit WHERE study_id = $1", [id]);
  assert.equal(audit.length, 1, "the record that a study existed is not deleted with it");
  assert.equal(audit[0].detail.tier, "T0");
});

test("deleting a study cascades to its rows, but not to another study's", options, async () => {
  const kept = await seedStudy();
  const gone = await seedStudy();
  for (const study of [kept, gone]) {
    await q(`INSERT INTO evimed_vcr.protocol_versions (id, study_id, user_id, version, title) VALUES ($1, $2, $3, 1, 'p')`,
      [vcrId("protocol"), study, USER]);
    await q(`INSERT INTO evimed_vcr.jobs (id, study_id, user_id, kind, method) VALUES ($1, $2, $3, 'design_analytic', 'design.analytic')`,
      [vcrId("job"), study, USER]);
  }
  await store.transaction((client) => deleteVcrStudyRows(client, gone));
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.jobs WHERE study_id = $1", [gone]))[0].n, 0);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.jobs WHERE study_id = $1", [kept]))[0].n, 1);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.protocol_versions WHERE study_id = $1", [kept]))[0].n, 1);
});

test("an account's rows go with the account", options, async () => {
  const id = await seedStudy();
  await q(`INSERT INTO evimed_vcr.sources (id, user_id, study_id, name) VALUES ($1, $2, $3, '合作方样例')`,
    [vcrId("source"), USER, id]);
  await store.transaction((client) => deleteVcrUserRows(client, USER));
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.studies WHERE user_id = $1", [USER]))[0].n, 0);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.sources WHERE user_id = $1", [USER]))[0].n, 0);
});

test("a job is claimed once: the index the worker leases on exists and is partial", options, async () => {
  const rows = await q(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'evimed_vcr' AND indexname = 'vcr_jobs_claim_idx'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].indexdef, /WHERE \(state = ANY/);
});
