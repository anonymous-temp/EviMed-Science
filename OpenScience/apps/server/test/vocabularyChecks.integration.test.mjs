// On a real PostgreSQL: a table created under an older vocabulary takes the new
// word after the migration's refresh, and a narrowed list that existing rows do
// not admit keeps the old constraint and says so (vocabularyChecks.mjs).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { refreshVocabularyChecks } from "../src/vocabularyChecks.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const schema = `vocab_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const ddl = (/** @type {string[]} */ words) => `CREATE SCHEMA IF NOT EXISTS ${schema};
CREATE TABLE IF NOT EXISTS ${schema}.jobs (
  id   text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN (${words.map((word) => `'${word}'`).join(", ")}))
);`;
/** @type {any} */
let database;
before(async () => { if (url) database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 1, databaseConnectionTimeoutMs: 2000 }); });
after(async () => { if (database) { await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await database.close(); } });

test("a word added after the table was created is admitted once the refresh has run", options, async () => {
  await database.transaction(async (/** @type {any} */ client) => { await client.query(ddl(["simulate", "profile"])); });
  await database.query(`INSERT INTO ${schema}.jobs VALUES ('j1', 'simulate')`);
  await assert.rejects(database.query(`INSERT INTO ${schema}.jobs VALUES ('j2', 'weighted_cox')`), /check constraint/,
    "the table as first created refuses the new word");
  const next = ddl(["simulate", "profile", "weighted_cox"]);
  const result = await database.transaction(async (/** @type {any} */ client) => { await client.query(next); return refreshVocabularyChecks(client, next, schema); });
  assert.deepEqual(result, { replaced: ["jobs.kind"], kept: [] });
  await database.query(`INSERT INTO ${schema}.jobs VALUES ('j2', 'weighted_cox')`);
  await assert.rejects(database.query(`INSERT INTO ${schema}.jobs VALUES ('j3', 'poem')`), /check constraint/, "still a closed vocabulary");
  const again = await database.transaction(async (/** @type {any} */ client) => refreshVocabularyChecks(client, next, schema));
  assert.deepEqual(again, { replaced: [], kept: [] }, "idempotent: nothing differs the second time");
});

test("a narrowed list the existing rows do not admit keeps the old constraint and is reported", options, async () => {
  const narrowed = ddl(["profile", "weighted_cox"]);
  const result = await database.transaction(async (/** @type {any} */ client) => refreshVocabularyChecks(client, narrowed, schema));
  assert.deepEqual(result, { replaced: [], kept: ["jobs.kind"] });
  await database.query(`INSERT INTO ${schema}.jobs VALUES ('j4', 'simulate')`);
});
