// The eight 「循证进化」 job kinds reach a database that already exists (review of the module,
// 2026-10-05, F5). `evimed_product.jobs.kind` is held by a named CHECK that every feature's
// migration block rebuilds only when it lacks *that feature's* kind. A fresh database builds the
// constraint from the full list in CREATE TABLE and so never shows a missing block: CI and the
// acceptance runs were green while the first enqueue on a deployed database would be refused.
// This test builds the database the way production has it — every earlier kind present, none of
// the evolution ones — and runs the migration on it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { EVOLUTION_JOB_KINDS } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductJobs } from "../src/productStore.mjs";
import { PRODUCT_JOB_KINDS, migrateProductStore } from "../src/productPersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = `evolution_kinds_${randomUUID().replaceAll("-", "")}`;
/** @type {any} */
let database;
/** @type {any} */
let jobs;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Evolution kinds','development')", [owner]);
  jobs = new ProductJobs(database);
});

after(async () => {
  if (!url) return;
  await database.query("DELETE FROM evimed_product.jobs WHERE user_id=$1", [owner]).catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]).catch(() => {});
  await database.close?.();
});

test("the migration admits the evolution job kinds on a database whose constraint predates them, and again harmlessly", options, async () => {
  const before = PRODUCT_JOB_KINDS.filter((kind) => !EVOLUTION_JOB_KINDS.includes(kind));
  assert.equal(before.length, PRODUCT_JOB_KINDS.length - EVOLUTION_JOB_KINDS.length, "the old list is the new one less exactly the evolution kinds");
  await database.query(`ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK (kind IN (${before.map((kind) => `'${kind}'`).join(",")}))`);
  await database.query("DELETE FROM evimed_product.schema_migrations WHERE name='2026-10-05-evolution-job-kinds-v1'");

  // The state production is in: every earlier marker is recorded and every earlier kind admitted.
  await assert.rejects(jobs.enqueue(owner, "evolution-event", { fixture: true }, { idempotencyKey: `before-${randomUUID()}` }),
    (error) => /product_jobs_kind_check/.test(String(error?.constraint ?? error?.message)), "without the block the database refuses the kind");

  // A different wrapper each time runs the DDL itself rather than the per-instance memo.
  for (let run = 0; run < 2; run += 1) await migrateProductStore({ transaction: (operation) => database.transaction(operation) });

  for (const kind of EVOLUTION_JOB_KINDS) {
    const saved = await jobs.enqueue(owner, kind, { fixture: kind }, { idempotencyKey: `after-${kind}-${randomUUID()}` });
    assert.equal(saved.kind, kind);
  }
  // Nothing else was lost: an earlier kind is still admitted and a made-up one still is not.
  await jobs.enqueue(owner, "availability-collect", { fixture: true }, { idempotencyKey: `older-${randomUUID()}` });
  await assert.rejects(jobs.enqueue(owner, "evolution-unknown", {}, { idempotencyKey: `unknown-${randomUUID()}` }));
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_product.schema_migrations WHERE name='2026-10-05-evolution-job-kinds-v1'")).rows[0].n, 1);
});
