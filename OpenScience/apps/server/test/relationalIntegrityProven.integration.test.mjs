// A validated foreign key proves its relationship has no orphan; the audit counts only what no key proves (2026-11-12: /api/ready ran
// every count six times a minute, the usage ledger's 840k rows twice each time).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateMemorySettings } from "../src/memorySettingsPersistence.mjs";
import { migrateNotifications } from "../src/notificationPersistence.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { relationalIntegrity } from "../src/relationalIntegrity.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { timeout: 60_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** @type {any} */ let isolated = null;
/** @type {any} */ let database = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "integrity");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  for (const migrate of [migrateUsageLedger, migrateProductStore, migrateNotifications, migrateMemorySettings]) await migrate(database);
  await relationalIntegrity(database, { validate: true });
});
after(async () => { if (database) await database.close(); await isolated?.drop(); });

/** The database with every statement it is asked recorded. */
function recorded() {
  /** @type {string[]} */ const statements = [];
  return { statements, database: { query: (/** @type {string} */ sql, /** @type {any[]} */ values) => { statements.push(sql); return database.query(sql, values); },
    transaction: (/** @type {any} */ work) => database.transaction(work) } };
}

test("with every key validated the audit reads the catalogue only; a NOT VALID key is counted alone, then validated again", options, async () => {
  const all = recorded();
  const clean = await relationalIntegrity(all.database);
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.deepEqual(clean.proven.sort(), Object.keys(clean.counts).sort());
  assert.equal(all.statements.filter((sql) => /count\(\*\)/.test(sql)).length, 0);

  const key = (await database.query(`SELECT c.conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='evimed_product' AND t.relname='jobs' AND c.contype='f'
    AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'`)).rows[0];
  assert.ok(key, "the jobs table's user key exists");
  await database.query(`ALTER TABLE evimed_product.jobs DROP CONSTRAINT "${key.conname}"`);
  await database.query(`ALTER TABLE evimed_product.jobs ADD CONSTRAINT "${key.conname}" ${key.definition} NOT VALID`);

  const one = recorded();
  const unproven = await relationalIntegrity(one.database);
  assert.equal(unproven.ok, false);
  assert.deepEqual(unproven.unvalidated, ["product_jobs_user"]);
  const counted = one.statements.filter((sql) => /count\(\*\)/.test(sql));
  assert.equal(counted.length, 1);
  assert.match(counted[0], /FROM evimed_product\.jobs j LEFT JOIN evimed_control\.users/);
  assert.equal(unproven.counts.product_jobs_user, 0);

  const repaired = await relationalIntegrity(database, { validate: true });
  assert.equal(repaired.validated, true);
  assert.equal((await relationalIntegrity(database)).ok, true);
});
