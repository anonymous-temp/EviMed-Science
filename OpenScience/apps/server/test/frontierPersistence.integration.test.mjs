// The frontier schema against a real PostgreSQL: created once, created again as
// a no-op, and falling back from `halfvec` to `vector` where pgvector is older
// than 0.7 (this box's development server runs 0.6.2 and has no pg_trgm).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_META_KEYS, bumpFrontierVersion, metaNumber, migrateFrontier } from "../src/frontierPersistence.mjs";
import { PRODUCT_JOB_KINDS, migrateProductStore } from "../src/productPersistence.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase[]} */
const opened = [];
const open = () => {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  opened.push(database);
  return database;
};

/** Every table and index of the schema, with the definitions PostgreSQL holds. */
async function inventory(database) {
  const tables = await database.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='evimed_frontier' ORDER BY 1`);
  const indexes = await database.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='evimed_frontier' ORDER BY 1`);
  const constraints = await database.query(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='evimed_frontier' ORDER BY 1`);
  return { tables: tables.rows.map((row) => row.table_name), indexes: indexes.rows, constraints: constraints.rows.map((row) => row.conname) };
}

let extensions = { vector: null, trigram: null };
before(async () => {
  if (!databaseUrl) return;
  const database = open();
  const found = await database.query(`SELECT name, default_version FROM pg_available_extensions WHERE name IN ('vector','pg_trgm')`);
  extensions = {
    vector: found.rows.find((row) => row.name === "vector")?.default_version ?? null,
    trigram: found.rows.find((row) => row.name === "pg_trgm")?.default_version ?? null,
  };
});

after(async () => {
  for (const database of opened) await database.close();
});

test("the migration creates the whole schema and a second run changes nothing", options, async () => {
  const first = open();
  const capabilities = await migrateFrontier(first, { dimension: 1024 });
  const created = await inventory(first);
  // 21 tables every deployment has, and the vector table where pgvector exists.
  assert.equal(created.tables.length, capabilities.vector ? 22 : 21, created.tables.join());
  for (const table of ["sources", "entries", "items", "item_keys", "item_texts", "item_mentions", "item_links", "glossary",
    "events", "event_aliases", "event_links", "event_items", "event_revisions", "hot_snapshots", "dailies", "item_changes",
    "meta", "user_state", "user_follows", "user_profiles", "user_prefs"]) {
    assert.ok(created.tables.includes(table), `${table} was not created`);
  }
  for (const index of ["frontier_items_timeline_idx", "frontier_items_selected_idx", "frontier_items_lane_idx",
    "frontier_items_published_idx", "frontier_items_lexemes_idx", "frontier_entries_queue_idx", "frontier_items_doi_key"]) {
    assert.ok(created.indexes.some((row) => row.indexname === index), `${index} was not created`);
  }

  // A second process — a new database object, so no cache answers for it —
  // runs the same migration and finds nothing to do.
  const second = open();
  const again = await migrateFrontier(second, { dimension: 1024 });
  assert.deepEqual(again, capabilities);
  assert.deepEqual(await inventory(second), created);

  // And the same object asked twice answers from its cache.
  assert.equal(await migrateFrontier(first, { dimension: 1024 }), capabilities);
});

test("pgvector below 0.7 gets vector(1024) and cosine HNSW; no pg_trgm means no trigram leg", options, async (t) => {
  const database = open();
  const capabilities = await migrateFrontier(database, { dimension: 1024 });
  assert.equal(capabilities.trigram, Boolean(extensions.trigram));
  if (!capabilities.trigram) {
    const trigram = await database.query(`SELECT 1 FROM pg_indexes WHERE schemaname='evimed_frontier' AND indexname='frontier_items_title_trgm_idx'`);
    assert.equal(trigram.rowCount, 0, "a trigram index was created without the extension");
  }
  if (!capabilities.vector) {
    t.skip("this database has no pgvector; the vector table is exercised where the extension exists");
    return;
  }
  const column = await database.query(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid='evimed_frontier.item_vectors'::regclass AND attname='embedding' AND NOT attisdropped`);
  const index = await database.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='evimed_frontier' AND indexname='frontier_item_vectors_hnsw_idx'`);
  if (capabilities.halfvec) {
    assert.equal(column.rows[0].type, "halfvec(1024)");
    assert.match(index.rows[0].indexdef, /halfvec_cosine_ops/);
  } else {
    // The path this box takes: pgvector 0.6.2.
    assert.match(String(capabilities.vectorVersion), /^0\.[0-6]\./);
    assert.equal(column.rows[0].type, "vector(1024)");
    assert.match(index.rows[0].indexdef, /USING hnsw \(embedding vector_cosine_ops\)/);
    assert.equal(capabilities.iterativeScan, false);
  }
});

test("a new embedding width empties and re-creates the vector column, and the pin's width comes back the same way", options, async (t) => {
  const probe = open();
  if (!(await migrateFrontier(probe, { dimension: 1024 })).vector) {
    t.skip("this database has no pgvector");
    return;
  }
  const narrow = open();
  await migrateFrontier(narrow, { dimension: 8 });
  const type = async (database) => (await database.query(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid='evimed_frontier.item_vectors'::regclass AND attname='embedding' AND NOT attisdropped`)).rows[0].type;
  assert.match(await type(narrow), /\(8\)$/);
  const restored = open();
  await migrateFrontier(restored, { dimension: 1024 });
  assert.match(await type(restored), /\(1024\)$/);
});

test("the meta versions are seeded as numbers and move by one inside the caller's transaction", options, async () => {
  const database = open();
  await migrateFrontier(database, { dimension: 1024 });
  const seeded = await database.query(`SELECT key, value FROM evimed_frontier.meta WHERE key = ANY($1::text[]) ORDER BY key`,
    [[FRONTIER_META_KEYS.contentVersion, FRONTIER_META_KEYS.hotVersion, FRONTIER_META_KEYS.dailyVersion, FRONTIER_META_KEYS.pluginCursor]]);
  assert.equal(seeded.rowCount, 4);
  for (const row of seeded.rows) assert.equal(typeof row.value, "number", row.key);

  const before = metaNumber((await database.query(`SELECT value FROM evimed_frontier.meta WHERE key='content_version'`)).rows[0].value);
  const bumped = await database.transaction((client) => bumpFrontierVersion(client));
  assert.equal(bumped, before + 1);
  // A rolled-back change leaves the version where it was.
  await assert.rejects(database.transaction(async (client) => {
    await bumpFrontierVersion(client);
    throw new Error("rolled back");
  }), /rolled back/);
  const after = metaNumber((await database.query(`SELECT value FROM evimed_frontier.meta WHERE key='content_version'`)).rows[0].value);
  assert.equal(after, before + 1);
  await assert.rejects(database.transaction((client) => bumpFrontierVersion(client, "plugin_cursor")), /Unknown frontier version key/);
});

test("metaNumber reads what a writer may have left and never throws", () => {
  assert.equal(metaNumber(7), 7);
  assert.equal(metaNumber("12"), 12);
  assert.equal(metaNumber(null), 0);
  assert.equal(metaNumber({ version: 3 }), 0);
  assert.equal(metaNumber(-1), 0);
  assert.equal(metaNumber(1.5), 0);
});

test("a ledger migrated before the frontier existed accepts its two job kinds after the next migration", options, async () => {
  const first = open();
  await migrateProductStore(first);
  // The constraint as a deployment that ran every earlier block holds it.
  const older = PRODUCT_JOB_KINDS.filter((kind) => !kind.startsWith("frontier-"));
  await first.query("ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check");
  await first.query(`ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK (kind IN (${older.map((kind) => `'${kind}'`).join(",")}))`);
  const user = `frontier_jobs_${Date.now()}`;
  await first.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Jobs','development')", [user]);
  try {
    const insert = (database, kind) => database.query(`INSERT INTO evimed_product.jobs(id,user_id,kind,idempotency_key,payload)
      VALUES ($1,$2,$3,$4,'{}'::jsonb)`, [`${kind}-${user}`, user, kind, `${kind}:${user}`]);
    await assert.rejects(insert(first, "frontier-daily"), /product_jobs_kind_check/);
    const next = open();
    await migrateProductStore(next);
    await insert(next, "frontier-daily");
    await insert(next, "frontier-rebuild");
    const kinds = (await next.query("SELECT kind FROM evimed_product.jobs WHERE user_id=$1 ORDER BY kind", [user])).rows.map((row) => row.kind);
    assert.deepEqual(kinds, ["frontier-daily", "frontier-rebuild"]);
  } finally {
    await first.query("DELETE FROM evimed_control.users WHERE id=$1", [user]);
  }
});
