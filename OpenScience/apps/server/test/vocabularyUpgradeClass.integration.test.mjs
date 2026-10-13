// The class behind the 2026-10-13 jobs-kind defect, closed for every schema whose CHECKs are written from a JavaScript list.
//
// A module's DDL is `CREATE TABLE IF NOT EXISTS`: the `CHECK (kind IN (...))` it splices from a list exists in the database
// as of the day the table was created, and a word added to the list later is refused by every existing database and by none
// of the fresh ones a test builds. `refreshVocabularyChecks` (vocabularyChecks.mjs) is the one mechanism that closes it, but
// only for the DDL a module hands it. So this test does not ask whether each module remembered: it builds every schema,
// takes one word out of each single-column list CHECK the database holds (the state of a table created before the word was
// added), runs each migration again, and requires the constraint back exactly as the DDL declares it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateChannels } from "../src/channels/store.mjs";
import { EVIDENCE_ZONE_SQL, migrateEvidenceZones } from "../src/evidenceZonePersistence.mjs";
import { migrateEvimedCredits } from "../src/evimedCreditsPersistence.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { migrateGeo } from "../src/geoPersistence.mjs";
import { migrateNativeMemory } from "../src/nativeMemoryPersistence.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";
import { migrateVcr } from "../src/vcrPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** @type {any} */
let database;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;

/** A different object each time, so the per-database memo of a migration does not stand in for running it. */
const restart = () => /** @type {any} */ (Object.create(database));
/** Every module in the order a fresh deployment applies them, by the schema whose CHECKs it owns. */
const modules = [
  ["evimed_product", (/** @type {any} */ db) => migrateProductStore(db)],
  ["evimed_memory", async (/** @type {any} */ db) => { await migrateResearchMemory(db); await migrateNativeMemory(db); }],
  ["evimed_credits", (/** @type {any} */ db) => migrateEvimedCredits(db)],
  ["evimed_channels", (/** @type {any} */ db) => migrateChannels(db)],
  ["evimed_frontier", async (/** @type {any} */ db) => { await migrateEvidenceZones(db); }],
  ["evimed_geo", (/** @type {any} */ db) => migrateGeo(db)],
  ["evimed_vcr", (/** @type {any} */ db) => migrateVcr(db)],
];

/**
 * List CHECKs that are written as literals in a migration of their own and not spliced from a list the code holds: a change to
 * one is an edit of that SQL, which carries its own block. The refresh is not wired to these modules (a literal that a later
 * block widens beyond the table's first definition would be narrowed again at every start), so the test leaves them out and
 * says why, by constraint. (The inbox's two, `notice_type` and `severity`, are literals of the same kind, the second with its own
 * widening block in `notificationPersistence.mjs`; that schema holds no list CHECK, so it is not in the table below.)
 */
const LITERAL_CHECKS = new Map([
  ["evimed_memory.settings.settings_engine_check", "a two-word literal added with its column inside a DO block"],
  ["evimed_credits.research_tasks.research_tasks_status_check", "a literal in the credits DDL, outside the lists the module splices"],
  ["evimed_credits.settlements.settlements_charge_basis_check", "a literal in a multi-line ALTER"],
  ["evimed_credits.settlements.settlements_wallet_contract_check", "the two contract constants, in a multi-line ALTER"],
]);
/** The evidence zones share `evimed_frontier` with the feed's own tables, whose CHECKs are literals; only the zones' tables are theirs. */
const zoneTables = new Set([...EVIDENCE_ZONE_SQL.matchAll(/CREATE TABLE IF NOT EXISTS evimed_frontier\.(\w+)/g)].map((match) => match[1]));

/** The single-column CHECKs of a schema that list at least two quoted words, by constraint. */
async function listChecks(/** @type {string} */ schema) {
  const { rows } = await database.query(
    `SELECT r.relname AS table_name, c.conname AS name, a.attname AS column_name, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = c.conkey[1]
      WHERE n.nspname = $1 AND c.contype = 'c' AND array_length(c.conkey, 1) = 1
      ORDER BY r.relname, c.conname`, [schema]);
  return rows.map((/** @type {any} */ row) => ({ ...row, words: [...new Set([...String(row.definition).matchAll(/'([^']*)'::text/g)].map((match) => match[1]))] }))
    .filter((/** @type {any} */ row) => /= ANY \(ARRAY\[/.test(row.definition) && row.words.length >= 2)
    .filter((/** @type {any} */ row) => !LITERAL_CHECKS.has(`${schema}.${row.table_name}.${row.name}`) && (schema !== "evimed_frontier" || zoneTables.has(row.table_name)));
}

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vocab");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await database.migrate();
  await migrateFrontier(database, { dimension: 1024 });
  for (const [, migrate] of modules) await migrate(database);
});

after(async () => {
  if (database) await database.close?.();
  if (isolated) await isolated.drop();
});

for (const [schema, migrate] of modules) {
  test(`${schema}: a word added to a list after the table was created reaches the existing constraint`, options, async () => {
    const checks = await listChecks(schema);
    assert.ok(checks.length >= 1, `${schema} holds at least one list CHECK`);
    for (const check of checks) {
      // NOT VALID: another suite's rows may hold the word taken out; the refresh is what puts it back, and it validates.
      await database.query(`ALTER TABLE ${schema}.${check.table_name} DROP CONSTRAINT "${check.name}";
        ALTER TABLE ${schema}.${check.table_name} ADD CONSTRAINT "${check.name}"
          CHECK (${check.column_name} IN (${check.words.slice(1).map((/** @type {string} */ word) => `'${word}'`).join(",")})) NOT VALID`);
    }
    await migrate(restart());
    const held = new Map((await database.query(
      `SELECT r.relname || '.' || c.conname AS key, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = $1 AND c.contype = 'c'`, [schema])).rows
      .map((/** @type {any} */ row) => [row.key, row.definition]));
    const notRestored = checks.filter((/** @type {any} */ check) => held.get(`${check.table_name}.${check.name}`) !== check.definition)
      .map((/** @type {any} */ check) => `${check.table_name}.${check.column_name} (${check.name})`);
    assert.deepEqual(notRestored, [], `${schema}: constraints still holding the older list`);
  });
}

test("a database that is already up to date is not touched: no constraint is replaced by a second migration", options, async () => {
  const oids = async () => (await database.query(
    `SELECT c.oid::text FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'c' AND n.nspname = ANY($1) ORDER BY 1`,
    [modules.map(([schema]) => schema)])).rows.map((/** @type {any} */ row) => row.oid);
  for (const [, migrate] of modules) await migrate(restart());
  const first = await oids();
  for (const [, migrate] of modules) await migrate(restart());
  assert.deepEqual(await oids(), first, "a constraint that already holds the declared words is left as it is");
});
