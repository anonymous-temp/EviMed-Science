// A validated foreign key proves its relationship has no orphan; the audit counts only what no key proves (2026-11-12: /api/ready ran
// every count six times a minute, the usage ledger's 840k rows twice each time).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateMemorySettings } from "../src/memorySettingsPersistence.mjs";
import { migrateNotifications } from "../src/notificationPersistence.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { MemoryHistoryLedger } from "../src/memoryHistoryPersistence.mjs";
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
  await new MemoryHistoryLedger({ database, overlay: null }).migrate();
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

const historyTables = ['history_message_rejections', 'history_write_messages', 'history_secret_salts', 'history_secrets'];

/** @param {string} ownerId */
async function insertHistoryMetadata(ownerId) {
  await database.query(`INSERT INTO evimed_memory.history_message_rejections
    (owner_id,owner_created_at,namespace_id,memory_type,fingerprint,archive_uri,message_hash)
    VALUES($1,'stamp','namespace','notes','fingerprint','archive','message')`, [ownerId]);
  await database.query(`INSERT INTO evimed_memory.history_write_messages
    (owner_id,owner_created_at,namespace_id,archive_uri,message_hash) VALUES($1,'stamp','namespace','archive','message')`, [ownerId]);
  await database.query(`INSERT INTO evimed_memory.history_secret_salts(owner_id,owner_created_at,salt)
    VALUES($1,'stamp','synthetic-salt')`, [ownerId]);
  await database.query(`INSERT INTO evimed_memory.history_secrets(owner_id,owner_created_at,archive_uri,fingerprint,length)
    VALUES($1,'stamp','archive','fingerprint',10)`, [ownerId]);
}

async function dropHistoryOwnerKeys() {
  for (const table of historyTables) await database.query(`ALTER TABLE evimed_memory.${table} DROP CONSTRAINT ${table}_owner_fk`);
}

/** A new database instance exercises the actual migration rather than its process cache. */
async function migrateHistoryAgain() {
  const next = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  try { await new MemoryHistoryLedger({ database: next, overlay: null }).migrate(); }
  finally { await next.close(); }
}

test('history migration validates populated owner tables and upgrades existing NOT VALID keys without deleting rows', options, async () => {
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('history-valid','History owner','development')");
  await insertHistoryMetadata('history-valid');
  // The old schema had no owner keys; an intermediate capsule deployment added
  // them NOT VALID. Both upgrade paths must end with catalogue-proven keys.
  for (const existingKey of [false, true]) {
    await dropHistoryOwnerKeys();
    if (existingKey) for (const table of historyTables) await database.query(`ALTER TABLE evimed_memory.${table}
      ADD CONSTRAINT ${table}_owner_fk FOREIGN KEY(owner_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE NOT VALID`);
    await migrateHistoryAgain();
    const f = recorded();
    const status = await relationalIntegrity(f.database);
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(f.statements.filter(sql => /count\(\*\)/.test(sql)).length, 0);
    for (const table of historyTables) {
      assert.ok(status.proven.includes(`memory_${table}_owner`));
      assert.equal((await database.query(`SELECT count(*)::int AS n FROM evimed_memory.${table} WHERE owner_id='history-valid'`)).rows[0].n, 1);
    }
  }
  await database.query("DELETE FROM evimed_control.users WHERE id='history-valid'");
});

test('history migration preserves legacy orphans, enforces new writes and cascades, and the audit reports debt until explicit cleanup', options, async () => {
  await dropHistoryOwnerKeys();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('history-live','History owner','development')");
  await insertHistoryMetadata('history-live');
  await insertHistoryMetadata('history-orphan');
  await database.query(`INSERT INTO evimed_memory.history_write_session_deletes(owner_id,namespace_id,uri)
    VALUES('history-live','namespace','viking://user/namespace/sessions/cleanup-owed')`);
  await migrateHistoryAgain();
  const debt = await relationalIntegrity(database);
  assert.equal(debt.ok, false);
  assert.equal(debt.orphanTotal, 4);
  assert.deepEqual(debt.unvalidated.sort(), historyTables.map(table => `memory_${table}_owner`).sort());
  for (const table of historyTables) assert.equal(debt.counts[`memory_${table}_owner`], 1);
  // A failed validation must not roll back the ADD CONSTRAINT that preceded it.
  await assert.rejects(insertHistoryMetadata('history-late'), { code: '23503' });
  await database.query("DELETE FROM evimed_control.users WHERE id='history-live'");
  for (const table of historyTables) {
    assert.equal((await database.query(`SELECT count(*)::int AS n FROM evimed_memory.${table} WHERE owner_id='history-live'`)).rows[0].n, 0);
    assert.equal((await database.query(`SELECT count(*)::int AS n FROM evimed_memory.${table} WHERE owner_id='history-orphan'`)).rows[0].n, 1);
    // This is explicit fixture cleanup, never a production migration action.
    await database.query(`DELETE FROM evimed_memory.${table} WHERE owner_id='history-orphan'`);
  }
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_memory.history_write_session_deletes WHERE owner_id='history-live'")).rows[0].n, 1);
  assert.equal((await relationalIntegrity(database, { validate: true })).ok, true);
  const afterCleanup = recorded();
  assert.equal((await relationalIntegrity(afterCleanup.database)).ok, true);
  assert.equal(afterCleanup.statements.filter(sql => /count\(\*\)/.test(sql)).length, 0);
});
