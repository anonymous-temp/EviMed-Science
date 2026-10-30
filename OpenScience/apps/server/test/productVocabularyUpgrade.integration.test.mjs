// A word added to a product list reaches a database that already has the table (release 18 follow-up, 2026-10-13).
//
// `PRODUCT_JOB_KINDS` gained `wiki-compile` (2026-10-12) and `ov-resource-sync` (2026-10-13), and the jobs table's
// `product_jobs_kind_check` is written from that list only when the table is created. Every earlier kind came with its own
// migration block; these two had none, so on production the first compile answered 500 (violates check constraint) and no
// document reached the engine, until the constraint was corrected by hand. A fresh test database is created from today's list
// and never shows it. This builds the table the way release 17 wrote it (9083f6c27) and runs the migration on it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductJobs } from "../src/productStore.mjs";
import { FEEDBACK_EVENT_TRIGGERS, FEEDBACK_SUBJECT_TYPES, PRODUCT_JOB_KINDS, PRODUCT_KINDS, migrateProductStore } from "../src/productPersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = `product_vocab_${randomUUID().replaceAll("-", "")}`;
/** The two kinds release 17's list (9083f6c27) did not have. */
const ADDED_AFTER_RELEASE_17 = ["wiki-compile", "ov-resource-sync"];
const list = (/** @type {readonly string[]} */ words) => words.map((word) => `'${word}'`).join(",");
/** @type {any} */
let database;
/** @type {any} */
let jobs;
const freshMigration = () => migrateProductStore({ transaction: (/** @type {any} */ operation) => database.transaction(operation) });

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Product vocabulary','development')", [owner]);
  jobs = new ProductJobs(database);
});

after(async () => {
  if (!url) return;
  await database.query("DELETE FROM evimed_product.jobs WHERE user_id=$1", [owner]).catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]).catch(() => {});
  await database.close?.();
});

test("the migration admits every job kind of today's list on a table release 17 wrote, and again harmlessly", options, async () => {
  const release17 = PRODUCT_JOB_KINDS.filter((kind) => !ADDED_AFTER_RELEASE_17.includes(kind));
  assert.equal(release17.length, PRODUCT_JOB_KINDS.length - ADDED_AFTER_RELEASE_17.length, "release 17's list is today's less exactly the two kinds");
  await database.query(`ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK (kind IN (${list(release17)}))`);
  for (const kind of ADDED_AFTER_RELEASE_17) {
    await assert.rejects(jobs.enqueue(owner, kind, { fixture: true }, { idempotencyKey: `before-${kind}-${randomUUID()}` }),
      (error) => /product_jobs_kind_check/.test(String(error?.constraint ?? error?.message)), "the table as release 17 wrote it refuses the kind");
  }

  for (let run = 0; run < 2; run += 1) await freshMigration();

  for (const kind of PRODUCT_JOB_KINDS) {
    const saved = await jobs.enqueue(owner, kind, { fixture: kind }, { idempotencyKey: `after-${kind}-${randomUUID()}` });
    assert.equal(saved.kind, kind);
  }
  await assert.rejects(database.query("INSERT INTO evimed_product.jobs(id,user_id,kind,idempotency_key,payload) VALUES($1,$2,'not-a-kind',$1,'{}')", [`unknown-${randomUUID()}`, owner]),
    /product_jobs_kind_check/, "still a closed vocabulary");
});

test("the documents kind and the feedback vocabularies are brought up to date the same way", options, async () => {
  const constraints = [
    ["documents", "product_documents_kind_check", "kind", PRODUCT_KINDS],
    ["feedback_events", "feedback_events_trigger_check", "trigger_kind", FEEDBACK_EVENT_TRIGGERS],
    ["feedback_events", "feedback_events_subject_check", "subject_type", FEEDBACK_SUBJECT_TYPES],
  ];
  // The first word of each list: the migration's older per-kind blocks each look for one later word of their own and would
  // not notice this one missing. NOT VALID because another test's rows may hold the word.
  for (const [table, name, column, words] of constraints) {
    await database.query(`ALTER TABLE evimed_product.${table} DROP CONSTRAINT ${name};
      ALTER TABLE evimed_product.${table} ADD CONSTRAINT ${name} CHECK (${column} IN (${list(words.slice(1))})) NOT VALID`);
  }
  await freshMigration();
  for (const [table, name, , words] of constraints) {
    const held = (await database.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2", [`evimed_product.${table}`, name])).rows[0].definition;
    for (const word of words) assert.ok(held.includes(`'${word}'`), `${name} holds ${word}`);
  }
});

const RSI_KINDS = ["rsi-incident-export", "rsi-bundle-poll"];
const kindCheckState = async () => (await database.query(`SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
  WHERE conrelid='evimed_product.jobs'::regclass AND conname='product_jobs_kind_check'`)).rows[0];
/** The table as it was before the two kinds: their rows (written by the tests above) are removed so the older list holds for every row. */
const withoutRsiKinds = async () => {
  await database.query("DELETE FROM evimed_product.jobs WHERE kind = ANY($1::text[])", [RSI_KINDS]);
  await database.query(`ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK (kind IN (${list(PRODUCT_JOB_KINDS.filter((kind) => !RSI_KINDS.includes(kind)))}))`);
};

test("the RSI job kinds rebuild the kind check NOT VALID in the migration and validate it after the commit, harmlessly twice", options, async () => {
  await withoutRsiKinds();
  assert.equal((await kindCheckState()).convalidated, true);
  // The migration is the wrapper's first transaction and the validation its second: what the table holds in between is the point.
  const between = [];
  let transactions = 0;
  const watched = { transaction: async (/** @type {any} */ operation) => {
    const result = await database.transaction(operation);
    transactions += 1;
    if (transactions === 1) between.push(await kindCheckState());
    return result;
  } };
  await migrateProductStore(watched);
  assert.equal(transactions, 2, "the migration, then the validation in a transaction of its own");
  assert.equal(between[0].convalidated, false, "the DDL adds the new check NOT VALID, so its exclusive lock lasts a moment");
  for (const kind of RSI_KINDS) assert.match(between[0].definition, new RegExp(`'${kind}'`), "and it already guards new rows with the full list");
  assert.equal((await kindCheckState()).convalidated, true, "the old rows are checked once the migration has committed");
  for (const kind of RSI_KINDS) assert.equal((await jobs.enqueue(owner, kind, { fixture: kind }, { idempotencyKey: `rsi-${kind}-${randomUUID()}` })).kind, kind);
  // Already current: nothing to rebuild and nothing to validate.
  transactions = 0;
  await migrateProductStore(watched);
  assert.equal((await kindCheckState()).convalidated, true);
  await assert.rejects(database.query("INSERT INTO evimed_product.jobs(id,user_id,kind,idempotency_key,payload) VALUES($1,$2,'not-a-kind',$1,'{}')", [`unknown-${randomUUID()}`, owner]),
    /product_jobs_kind_check/, "still a closed vocabulary");
});

test("the rebuild gives up on a locked jobs table after seconds instead of queueing every statement behind it", options, async () => {
  await withoutRsiKinds();
  const holder = await database.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE evimed_product.jobs IN ACCESS SHARE MODE");
    const started = Date.now();
    await assert.rejects(migrateProductStore({ transaction: (/** @type {any} */ operation) => database.transaction(operation) }), (error) => /** @type {any} */ (error)?.code === "55P03");
    assert.ok(Date.now() - started < 20_000, "bounded by the lock timeout");
    assert.equal((await kindCheckState()).definition.includes("rsi-bundle-poll"), false, "nothing was half-applied");
  } finally { await holder.query("ROLLBACK"); holder.release(); }
  await freshMigration();
  assert.equal((await kindCheckState()).convalidated, true);
  assert.match((await kindCheckState()).definition, /rsi-bundle-poll/);
});
