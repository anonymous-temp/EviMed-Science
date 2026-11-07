import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateProductStore, PRODUCT_JOB_KINDS, PRODUCT_KINDS } from "../src/productPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PUBLISHER = "evimed-evidence-center";
const PROJECT = "evimed-evidence";
const MARKER = "2026-10-29-evidence-programme-retired-v1";
const list = (/** @type {readonly string[]} */ values) => values.map((value) => `'${value}'`).join(",");

// A database last migrated by a release between 2026-10-05 and 2026-10-24: the kind CHECKs name the programme's two kinds and lack
// geo-plan-context, and the publisher holds the programme's decisions, jobs, agendas and a queued episode. The upgrade must get through the
// CHECK rebuilds that re-add the constraint from the current lists, and must stop what the programme left running.
test("an upgrade from a database holding programme rows migrates, and the scheduler's agendas, episodes and queue are gone before the CHECKs are rebuilt", options, async () => {
  const isolated = await createGeoTestDatabase(databaseUrl, "retire");
  /** @type {ControlPlaneDatabase | null} */ let old = null;
  /** @type {ControlPlaneDatabase | null} */ let upgraded = null;
  try {
    old = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
    await migrateProductStore(old);
    const withoutNew = PRODUCT_KINDS.filter((kind) => kind !== "geo-plan-context");
    await old.query(`
      INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('${PUBLISHER}','EviMed 证据中心','platform') ON CONFLICT DO NOTHING;
      INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development') ON CONFLICT DO NOTHING;
      INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('${PUBLISHER}','${PROJECT}','Evidence',1048576),('alice','p1','P',1048576);
      ALTER TABLE evimed_product.documents DROP CONSTRAINT product_documents_kind_check;
      ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check CHECK (kind IN (${list([...withoutNew, "programme-decision", "agenda", "episode", "digest"])}));
      ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check;
      ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK (kind IN (${list([...PRODUCT_JOB_KINDS, "evidence-programme", "episode", "verify", "digest"])}));
      DELETE FROM evimed_product.schema_migrations WHERE name='${MARKER}';
      INSERT INTO evimed_product.documents(user_id,kind,id,project_id,payload) VALUES
        ('${PUBLISHER}','programme-decision','d1','${PROJECT}','{}'),
        ('${PUBLISHER}','agenda','a-programme','${PROJECT}','{"programme":{"zoneKey":"z"},"enabled":true,"status":"active"}'),
        ('${PUBLISHER}','agenda','a-topic','${PROJECT}','{"programme":{"zoneKey":"z","topicId":"t"},"enabled":true,"status":"active"}'),
        ('${PUBLISHER}','episode','e-queued','${PROJECT}','{"agendaId":"a-programme","status":"queued"}'),
        ('${PUBLISHER}','episode','e-running','${PROJECT}','{"agendaId":"a-programme","status":"running"}'),
        ('alice','agenda','a-own','p1','{"enabled":true,"status":"active"}'),
        ('alice','episode','e-own','p1','{"agendaId":"a-own","status":"queued"}');
      INSERT INTO evimed_product.jobs(id,user_id,project_id,kind,idempotency_key,payload) VALUES
        ('j-programme','${PUBLISHER}','${PROJECT}','evidence-programme','evidence-programme:2026-10-20','{}'),
        ('j-episode','${PUBLISHER}','${PROJECT}','episode','episode:e-queued','{}'),
        ('j-verify','${PUBLISHER}','${PROJECT}','verify','verify:e-queued','{}'),
        ('j-own','alice','p1','episode','episode:e-own','{}');`);
    assert.equal((await old.query("SELECT count(*)::integer AS n FROM evimed_product.documents WHERE kind='programme-decision'")).rows[0].n, 1);
    await old.close(); old = null;

    upgraded = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
    await migrateProductStore(upgraded);

    const count = async (/** @type {string} */ where) => (await /** @type {ControlPlaneDatabase} */ (upgraded).query(`SELECT count(*)::integer AS n FROM ${where}`)).rows[0].n;
    assert.equal(await count("evimed_product.documents WHERE kind='programme-decision'"), 0, "the programme's decisions are gone");
    assert.equal(await count("evimed_product.jobs WHERE kind='evidence-programme'"), 0, "the programme's jobs are gone");
    assert.equal(await count(`evimed_product.schema_migrations WHERE name='${MARKER}'`), 1);
    const check = (await upgraded.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='evimed_product.documents'::regclass AND conname='product_documents_kind_check'")).rows[0].def;
    assert.match(check, /geo-plan-context/);
    assert.doesNotMatch(check, /programme-decision|'agenda'/);

    // The scheduler's own kinds left the vocabulary on 2026-11-05: a database this old gets its agendas, episodes and their jobs deleted
    // before the first CHECK rebuild, the programme's and a researcher's alike, because the narrowed CHECK refuses a row of those kinds.
    assert.equal(await count("evimed_product.documents WHERE kind IN ('agenda','episode','digest')"), 0, "the scheduler's documents are gone");
    assert.equal(await count("evimed_product.jobs WHERE kind IN ('episode','verify','digest')"), 0, "the scheduler's jobs are gone");
    assert.equal(await count("evimed_product.jobs"), 0);

    // Idempotent: a second process migrating again changes nothing.
    const again = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
    try {
      await migrateProductStore(again);
      assert.equal((await again.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE kind='agenda'")).rows[0].n, 0);
    } finally { await again.close(); }
  } finally {
    await old?.close().catch(() => {});
    await upgraded?.close().catch(() => {});
    await isolated.drop();
  }
});
