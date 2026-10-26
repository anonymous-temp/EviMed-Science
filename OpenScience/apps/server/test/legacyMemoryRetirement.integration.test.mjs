// What is left of the legacy memory engine, taken away once at start (`legacyMemoryRetirement.mjs`), against a real PostgreSQL.
//
// The step has two promises. It never takes away a memory somebody still has: the five record tables and the two engine columns go only
// when they hold nothing and no account says it is on the legacy engine, and otherwise stay, with one named reason and a counter. And it
// does the rest whatever became of the tables, once: the index's copies of the retired records are owed to the withdrawal ledger, and the
// queued jobs of the retired index kind are deleted. Each case here has a database of its own (the tables are the thing under test).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { loadConfig } from "../src/config.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { LEGACY_INDEX_WITHDRAWN, retireLegacyMemory } from "../src/legacyMemoryRetirement.mjs";
import { MemoryIndexWithdrawals } from "../src/memoryIndexWithdrawals.mjs";
import { memoryMetricFamilies, resetMemoryMetrics } from "../src/memoryMetrics.mjs";
import { MemorySettingsStore } from "../src/memorySettings.mjs";
import { migrateMemorySettings } from "../src/memorySettingsPersistence.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { createStore } from "../src/store.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60_000 };
const LEGACY_CHILDREN = ["record_reviews", "record_conflicts", "record_sources", "record_usage"];

/** @type {string} */ let dataDir;
before(async () => { dataDir = await mkdtemp(path.join(tmpdir(), "evimed-legacy-retire-")); });
after(async () => { await rm(dataDir, { recursive: true, force: true }); });

/**
 * A database as an old deployment left it: the control plane's schema, the memory schema the current migration makes, and the legacy
 * tables and columns the current migration no longer makes, with `accounts` accounts and whatever `seed` puts in them.
 * @param {import("node:test").TestContext} t
 * @param {{ accounts?: number, seed?: (database: any, users: string[]) => Promise<void> }} [how]
 */
async function oldDeployment(t, { accounts = 2, seed = async () => {} } = {}) {
  const isolated = await createGeoTestDatabase(url, "legacyret");
  const config = loadConfig({ dataDir, stateStore: "postgres", databaseUrl: isolated.url, runtimeMode: "mock", authMode: "local", devAuth: false });
  const store = createStore(config);
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  t.after(async () => {
    await database.close();
    await store.close();
    await isolated.drop();
  });
  const users = [];
  for (let index = 0; index < accounts; index += 1) {
    const id = `retire_${index}_${Math.random().toString(16).slice(2, 8)}`;
    await store.createUser(id, "test-only-retire-password", `Retire ${index}`);
    users.push(id);
  }
  await migrateMemorySettings(database);
  await migrateProductStore(database);
  await database.query(`ALTER TABLE evimed_memory.settings ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'native',
    ADD COLUMN IF NOT EXISTS engine_changed_at timestamptz`);
  // The columns the account export reads are the old release's own.
  await database.query(`CREATE TABLE evimed_memory.records (id text PRIMARY KEY, user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE, value text,
    scope text NOT NULL DEFAULT 'user', scope_id text NOT NULL DEFAULT '', kind text NOT NULL DEFAULT 'preference', key text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '', origin text NOT NULL DEFAULT 'stated', status text NOT NULL DEFAULT 'active', sensitive boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  for (const table of LEGACY_CHILDREN) await database.query(`CREATE TABLE evimed_memory.${table} (user_id text, record_id text)`);
  await seed(database, users);
  const withdrawals = new MemoryIndexWithdrawals({ database, openViking: null });
  return { database, users, withdrawals };
}

const tablesLeft = async (/** @type {any} */ database) => (await database.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='evimed_memory' AND table_name = ANY($1::text[]) ORDER BY table_name`,
  [["records", ...LEGACY_CHILDREN]])).rows.map((/** @type {any} */ row) => row.table_name);
const columnsLeft = async (/** @type {any} */ database) => (await database.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='evimed_memory' AND table_name='settings' AND column_name = ANY($1::text[]) ORDER BY column_name`,
  [["engine", "engine_changed_at"]])).rows.map((/** @type {any} */ row) => row.column_name);
/** Every account of the database, the fixture's and any the store made for itself. */
const everyone = async (/** @type {any} */ database) => (await database.query("SELECT id FROM evimed_control.users ORDER BY id")).rows.map((/** @type {any} */ row) => row.id);
const owedTo = async (/** @type {any} */ database) => (await database.query("SELECT user_id, uri FROM evimed_memory.index_withdrawals ORDER BY user_id, uri")).rows;
const counted = (/** @type {string} */ outcome) => memoryMetricFamilies().find((family) => family.name === "open_science_legacy_memory_retirement_total")
  ?.series.find((entry) => entry.labels?.outcome === outcome)?.value ?? 0;

test("empty tables and no legacy account: the tables and the engine columns are dropped, the retired jobs deleted, the index's copies owed once", options, async (t) => {
  resetMemoryMetrics();
  const { database, users, withdrawals } = await oldDeployment(t, { seed: async (db, owners) => {
    const jobs = new ProductJobs(db);
    for (const owner of owners) await jobs.enqueue(owner, "memory-record-index", { recordId: "rec_gone" }, { idempotencyKey: `retired:${owner}` });
  } });
  const lines = [];
  const first = await retireLegacyMemory({ database, withdrawals, report: (line) => lines.push(line) });
  const accounts = await everyone(database);
  assert.deepEqual([first.tables, first.jobs, first.withdrawn, first.accounts, first.failed], ["dropped", 2, "queued", accounts.length, undefined]);
  assert.equal(first.ledger, "absent", "a database that never had the retired usememos erasure ledger finds nothing to drop");
  assert.deepEqual(await tablesLeft(database), []);
  assert.deepEqual(await columnsLeft(database), []);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE kind='memory-record-index'")).rows[0].n, 0, "nothing claims them any more");
  const owed = await owedTo(database);
  assert.equal(owed.length, accounts.length * 3, "three subtrees of every account");
  for (const owner of users) assert.deepEqual(owed.filter((row) => row.user_id === owner).map((row) => row.uri.split("/memories/evimed/")[1]).sort(), ["project", "session", "user"]);
  assert.ok(owed.every((row) => !row.uri.endsWith("/capsule") && !row.uri.includes("/capsule/")), "the capsule's own tree is never named");
  assert.equal((await database.query("SELECT 1 FROM evimed_product.schema_migrations WHERE name=$1", [LEGACY_INDEX_WITHDRAWN])).rowCount, 1, "the marker is written with the work it marks");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `legacy memory: tables dropped; 2 retired index job(s) deleted; index copies of the records queued for ${accounts.length} account(s)`);
  assert.deepEqual([counted("dropped"), counted("index_withdrawals_queued"), counted("jobs_deleted"), counted("failed")], [1, 1, 1, 0]);

  // Idempotent: a second start finds nothing, owes nothing again and says nothing.
  const quiet = [];
  const second = await retireLegacyMemory({ database, withdrawals, report: (line) => quiet.push(line) });
  assert.deepEqual([second.tables, second.jobs, second.withdrawn], ["absent", 0, "done_before"]);
  assert.equal((await owedTo(database)).length, accounts.length * 3);
  assert.deepEqual(quiet, []);
  assert.equal(counted("absent"), 1);
});

test("a table that still holds a record is kept with its columns, one line names why, and the rest is still done", options, async (t) => {
  resetMemoryMetrics();
  const { database, users, withdrawals } = await oldDeployment(t, { accounts: 1, seed: async (db, [owner]) => {
    await db.query("INSERT INTO evimed_memory.records (id, user_id, value) VALUES ('rec_held', $1, '一条还在的记忆')", [owner]);
    await new ProductJobs(db).enqueue(owner, "memory-record-index", { recordId: "rec_held" }, { idempotencyKey: "retired:held" });
  } });
  const lines = [];
  const result = await retireLegacyMemory({ database, withdrawals, report: (line) => lines.push(line) });
  assert.deepEqual([result.tables, result.jobs, result.withdrawn], ["kept_records", 1, "queued"]);
  assert.deepEqual(await tablesLeft(database), ["record_conflicts", "record_reviews", "record_sources", "record_usage", "records"].sort());
  assert.deepEqual(await columnsLeft(database), ["engine", "engine_changed_at"], "kept, they are how the next start tells that an account still says legacy");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_memory.records")).rows[0].n, 1, "a record is never deleted by it");
  assert.match(lines[0], /1 structured record\(s\) are still held in evimed_memory\.records; the tables are kept/);
  const everyAccount = (await everyone(database)).length;
  assert.equal((await owedTo(database)).filter((row) => row.user_id === users[0]).length, 3);
  assert.equal((await owedTo(database)).length, everyAccount * 3);
  assert.equal(counted("kept_records"), 1);
  // The next start asks again, finds the record still there, and says so again, but owes nothing twice.
  const again = await retireLegacyMemory({ database, withdrawals, report: () => {} });
  assert.deepEqual([again.tables, again.jobs, again.withdrawn], ["kept_records", 0, "done_before"]);
  assert.equal((await owedTo(database)).length, everyAccount * 3);
});

test("the retired usememos erasure ledger is dropped whatever became of the legacy tables, and no migration makes it again", options, async (t) => {
  resetMemoryMetrics();
  const { database, withdrawals } = await oldDeployment(t, { accounts: 1, seed: async (db, [owner]) => {
    // The legacy tables are kept (a record is held), so the ledger's drop does not ride on theirs.
    await db.query("INSERT INTO evimed_memory.records (id, user_id, value) VALUES ('rec_held', $1, '一条还在的记忆')", [owner]);
    await db.query(`CREATE TABLE evimed_memory.retired_erasures (namespace text PRIMARY KEY, tag text NOT NULL, erased_at timestamptz(3) NOT NULL DEFAULT now())`);
    await db.query("INSERT INTO evimed_memory.retired_erasures (namespace, tag) VALUES ('evimed-science-' || repeat('a', 24), repeat('b', 24))");
  } });
  const ledger = async () => (await database.query("SELECT to_regclass('evimed_memory.retired_erasures') AS found")).rows[0].found;
  assert.notEqual(await ledger(), null, "the fixture is a database that still holds the ledger");
  const lines = [];
  const first = await retireLegacyMemory({ database, withdrawals, report: (line) => lines.push(line) });
  assert.deepEqual([first.tables, first.ledger, first.failed], ["kept_records", "dropped", undefined]);
  assert.equal(await ledger(), null);
  assert.match(lines.at(-1), /; the retired usememos erasure ledger dropped$/);
  assert.equal(counted("erasure_ledger_dropped"), 1);

  // The next start finds nothing, and the memory migration the retirement runs first does not make it again.
  await migrateMemorySettings(database);
  const quiet = [];
  const second = await retireLegacyMemory({ database, withdrawals, report: (line) => quiet.push(line) });
  assert.equal(second.ledger, "absent");
  assert.equal(await ledger(), null);
  assert.equal(counted("erasure_ledger_dropped"), 1);
  assert.deepEqual(quiet.filter((line) => /erasure ledger/.test(line)), []);
});

test("a database that kept its records hands them over in the person's own export, and one that dropped them hands over only the switches", options, async (t) => {
  const { database, users } = await oldDeployment(t, { accounts: 2, seed: async (db, [owner]) => {
    await db.query("INSERT INTO evimed_memory.records (id, user_id, value) VALUES ('rec_held', $1, '一条还在的记忆')", [owner]);
  } });
  const memorySettings = new MemorySettingsStore({}, { database });
  const held = await memorySettings.exportUserMemory(users[0]);
  assert.equal(held.version, 2);
  assert.deepEqual(held.legacyRecords.map((/** @type {any} */ row) => [row.id, row.value]), [["rec_held", "一条还在的记忆"]]);
  assert.equal("legacyRecords" in await memorySettings.exportUserMemory(users[1]), false, "only the person's own rows");
  // Dropped (nothing was held), the archive carries the switches alone, and says nothing about a table that is not there.
  await database.query("DROP TABLE evimed_memory.record_reviews, evimed_memory.record_conflicts, evimed_memory.record_sources, evimed_memory.record_usage, evimed_memory.records");
  const gone = await memorySettings.exportUserMemory(users[0]);
  assert.deepEqual(Object.keys(gone).sort(), ["settings", "version"]);
});

test("an account that still says it is on the legacy engine keeps the tables, even empty", options, async (t) => {
  resetMemoryMetrics();
  const { database, withdrawals } = await oldDeployment(t, { accounts: 2, seed: async (db, [first]) => {
    await db.query("INSERT INTO evimed_memory.settings (user_id, engine) VALUES ($1, 'legacy')", [first]);
  } });
  const lines = [];
  const result = await retireLegacyMemory({ database, withdrawals, report: (line) => lines.push(line) });
  assert.equal(result.tables, "kept_legacy_accounts");
  assert.deepEqual(await tablesLeft(database), ["record_conflicts", "record_reviews", "record_sources", "record_usage", "records"].sort());
  assert.deepEqual(await columnsLeft(database), ["engine", "engine_changed_at"]);
  assert.match(lines[0], /1 account\(s\) still say they are on the legacy engine/);
  assert.equal(counted("kept_legacy_accounts"), 1);
});

test("without a withdrawal ledger nothing is owed and nothing is marked; a later start that has one does it", options, async (t) => {
  resetMemoryMetrics();
  const { database, withdrawals } = await oldDeployment(t, { accounts: 1 });
  const bare = await retireLegacyMemory({ database, withdrawals: null, report: () => {} });
  assert.deepEqual([bare.tables, bare.withdrawn], ["dropped", "not_composed"]);
  assert.equal((await database.query("SELECT 1 FROM evimed_product.schema_migrations WHERE name=$1", [LEGACY_INDEX_WITHDRAWN])).rowCount, 0, "not marked: a deployment with the engine does it later");
  const later = await retireLegacyMemory({ database, withdrawals, report: () => {} });
  assert.deepEqual([later.tables, later.withdrawn], ["absent", "queued"]);
  assert.equal((await owedTo(database)).length, (await everyone(database)).length * 3);
});

test("a failure is counted and reported, never thrown into the start, and the next start asks again", options, async (t) => {
  resetMemoryMetrics();
  const { database } = await oldDeployment(t, { accounts: 1 });
  const lines = [];
  const broken = { migrate: async () => { throw Object.assign(new Error("ledger down"), { code: "ledger_down" }); }, enqueue: async () => {} };
  const result = await retireLegacyMemory({ database, withdrawals: /** @type {any} */ (broken), report: (line) => lines.push(line) });
  assert.equal(result.failed, "ledger_down");
  assert.match(lines[0], /the retirement could not run \(ledger_down\); the next start asks again/);
  assert.equal(counted("failed"), 1);
  assert.deepEqual(await tablesLeft(database), ["record_conflicts", "record_reviews", "record_sources", "record_usage", "records"].sort(), "nothing was half done");
  const ok = await retireLegacyMemory({ database, withdrawals: new MemoryIndexWithdrawals({ database, openViking: null }), report: () => {} });
  assert.equal(ok.tables, "dropped");
});

test("a started app takes the legacy tables away by itself, with no one asking", options, async (t) => {
  const { createWebApiApp } = await import("../src/server.mjs");
  const isolated = await createGeoTestDatabase(url, "legacyapp");
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  // The tables as an old deployment left them, before the app's own migrations have run.
  await database.query("CREATE SCHEMA IF NOT EXISTS evimed_memory");
  await database.query("CREATE TABLE evimed_memory.records (id text PRIMARY KEY, user_id text, value text)");
  for (const table of LEGACY_CHILDREN) await database.query(`CREATE TABLE evimed_memory.${table} (user_id text, record_id text)`);
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url });
  t.after(async () => {
    await app.close();
    await database.close();
    await isolated.drop();
  });
  await app.listen(0, "127.0.0.1");
  let left = await tablesLeft(database);
  for (const started = Date.now(); left.length && Date.now() - started < 15_000;) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = await tablesLeft(database);
  }
  assert.deepEqual(left, [], "the start dropped what was empty");
});
