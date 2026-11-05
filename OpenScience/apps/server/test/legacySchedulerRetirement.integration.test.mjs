// What is left of the platform's own scheduler in the product ledger, taken away once at start (`legacySchedulerRetirement.mjs`), against a
// real PostgreSQL. The promises: the rows of the three retired document kinds and the three retired job kinds go, nothing else goes, the kind
// CHECKs are narrowed only after, a second start finds nothing, and the step touches no conversation or run.
import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { retireLegacyScheduler } from "../src/legacySchedulerRetirement.mjs";
import { migrateProductStore, PRODUCT_JOB_KINDS, PRODUCT_KINDS } from "../src/productPersistence.mjs";
import { resetSchedulerRetirementMetrics, schedulerRetirementMetricFamilies } from "../src/schedulerRetirementMetrics.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60_000 };
const list = (/** @type {readonly string[]} */ values) => values.map((value) => `'${value}'`).join(",");
const outcome = (/** @type {string} */ name) => schedulerRetirementMetricFamilies()[0].series.find((series) => series.labels.outcome === name)?.value;

test("the retired scheduler's rows go, the kind CHECKs are narrowed after, and a second start finds nothing", options, async () => {
  resetSchedulerRetirementMetrics();
  const isolated = await createGeoTestDatabase(databaseUrl, "schedret");
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  try {
    await migrateProductStore(database);
    // A database as the previous release left it: the CHECKs still name the scheduler's kinds and its rows exist.
    await database.query(`
      INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development') ON CONFLICT DO NOTHING;
      INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('alice','p1','P',1048576);
      ALTER TABLE evimed_product.documents DROP CONSTRAINT product_documents_kind_check;
      ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check CHECK (kind IN (${list([...PRODUCT_KINDS, "agenda", "episode", "digest"])}));
      ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check;
      ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK (kind IN (${list([...PRODUCT_JOB_KINDS, "episode", "verify", "digest"])}));
      INSERT INTO evimed_product.documents(user_id,kind,id,project_id,payload) VALUES
        ('alice','agenda','a1','p1','{"enabled":true}'), ('alice','episode','e1','p1','{"agendaId":"a1"}'),
        ('alice','digest','d1','p1','{}'), ('alice','notification','n1','p1','{}'), ('alice','method','m1','p1','{}');
      UPDATE evimed_product.documents SET revision = 2, payload = '{"enabled":false}' WHERE id='a1';
      INSERT INTO evimed_product.jobs(id,user_id,project_id,kind,idempotency_key,payload) VALUES
        ('j-episode','alice','p1','episode','episode:e1','{}'), ('j-verify','alice','p1','verify','verify:e1','{}'),
        ('j-digest','alice','p1','digest','digest:d1','{}'), ('j-notify','alice','p1','notify','notify:n1','{}');`);
    const revisionsBefore = (await database.query("SELECT count(*)::int AS n FROM evimed_product.revisions WHERE kind='agenda'")).rows[0].n;

    const lines = /** @type {string[]} */ ([]);
    const first = await retireLegacyScheduler({ database, report: (line) => lines.push(line) });
    assert.equal(first.failed, undefined);
    assert.deepEqual({ documents: first.documents, jobs: first.jobs, narrowed: first.narrowed }, { documents: 3, jobs: 3, narrowed: true });
    assert.ok(first.revisions >= revisionsBefore);
    assert.equal(lines.length, 1);

    const kinds = (await database.query("SELECT kind FROM evimed_product.documents ORDER BY kind")).rows.map((/** @type {any} */ row) => row.kind);
    assert.deepEqual(kinds, ["method", "notification"], "only the retired kinds are deleted");
    assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.revisions WHERE kind IN ('agenda','episode','digest')")).rows[0].n, 0);
    assert.deepEqual((await database.query("SELECT id FROM evimed_product.jobs ORDER BY id")).rows.map((/** @type {any} */ row) => row.id), ["j-notify"]);
    for (const [table, constraint] of [["documents", "product_documents_kind_check"], ["jobs", "product_jobs_kind_check"]]) {
      const definition = (await database.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2", [`evimed_product.${table}`, constraint])).rows[0].def;
      assert.doesNotMatch(definition, /'(agenda|episode|digest|verify)'/, `${constraint} no longer names the retired kinds`);
    }
    await assert.rejects(database.query("INSERT INTO evimed_product.documents(user_id,kind,id,project_id,payload) VALUES ('alice','agenda','a2','p1','{}')"), /check/i);

    // Idempotent, and the migration after it rebuilds nothing it would refuse.
    const second = await retireLegacyScheduler({ database, report: (line) => lines.push(line) });
    assert.deepEqual({ documents: second.documents, jobs: second.jobs, narrowed: second.narrowed, failed: second.failed }, { documents: 0, jobs: 0, narrowed: false, failed: undefined });
    assert.equal(lines.length, 1, "a second start says nothing");
    await migrateProductStore(database);

    assert.equal(outcome("documents_deleted"), 3);
    assert.equal(outcome("jobs_deleted"), 3);
    assert.equal(outcome("checks_narrowed"), 1);
    assert.equal(outcome("nothing_left"), 1);
    assert.equal(outcome("failed"), 0);
  } finally {
    await database.close();
    await isolated.drop();
  }
});

test("a database that never held the scheduler finds nothing to do", options, async () => {
  resetSchedulerRetirementMetrics();
  const isolated = await createGeoTestDatabase(databaseUrl, "schedret2");
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  try {
    const result = await retireLegacyScheduler({ database });
    assert.deepEqual({ documents: result.documents, jobs: result.jobs, narrowed: result.narrowed, failed: result.failed }, { documents: 0, jobs: 0, narrowed: false, failed: undefined });
    assert.equal(outcome("nothing_left"), 1);
  } finally {
    await database.close();
    await isolated.drop();
  }
});
