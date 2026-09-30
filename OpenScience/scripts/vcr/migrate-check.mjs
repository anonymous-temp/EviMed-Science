#!/usr/bin/env node
// Rehearse 「虚拟临研」's database migration on a copy of production.
//
//   node scripts/vcr/migrate-check.mjs <postgres url of a clone>
//   OPEN_SCIENCE_VCR_MIGRATE_CHECK_URL=<url> node scripts/vcr/migrate-check.mjs
//
// The module creates its own schema (`evimed_vcr`) when the control plane
// starts, so the first time it meets a production database is the release
// itself. This is the dress rehearsal: run it against a clone the backup drill
// made (`scripts/ops/postgres-backup.py restore-clone`, whose clones are named
// `evimed_restore_<stamp>_<id>`), read the answer, and only then release.
//
// Hidden knowledge:
//
// - **It refuses anything that is not a clone.** The database name must be a
//   restore clone or a test database. The module's migration is the same code
//   that runs on start-up, so pointing this at production would simply be a
//   release with extra steps and no rollback plan; the name check is the one
//   guard that cannot be forgotten, because it is the argument.
// - **What it proves is that the migration is additive and repeatable.** Row
//   counts of every table outside `evimed_vcr` are taken before and after, and
//   must not change; the migration runs twice on two connections (the second is
//   what a second web replica does at start-up) and must succeed both times;
//   every table the module declares must exist afterwards. How long the first
//   run took on a production-sized copy is the number a release needs.
// - **A constraint added `NOT VALID` is reported, not fixed.** The referral
//   contact-approval check is added `NOT VALID` so a database that predates it
//   migrates; whether to `VALIDATE` it is a decision about the rows the copy
//   holds, so the answer lists it and changes nothing.
//
// Exit status 0 when every check holds, 1 otherwise; the answer is JSON on
// stdout either way.
import process from "node:process";

import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { VCR_SCHEMA, VCR_TABLES, migrateVcr } from "../../apps/server/src/vcrPersistence.mjs";

const CLONE_NAME = /^evimed_(?:restore|test)[a-z0-9_]*$/;

/** @param {string} raw @returns {URL} */
function cloneUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Give the clone's PostgreSQL URL as the argument or in OPEN_SCIENCE_VCR_MIGRATE_CHECK_URL."); }
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) throw new Error("The URL must be a postgres:// URL.");
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!CLONE_NAME.test(name)) {
    throw new Error(`Refusing database "${name}": this rehearses the migration on a restore clone (evimed_restore_…) or a test database (evimed_test…), never on a database that serves traffic.`);
  }
  return url;
}

/** @param {ControlPlaneDatabase} database @returns {Promise<Record<string, number>>} */
async function countsOutsideModule(database) {
  const tables = (await database.query(
    `SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND schemaname <> $1
      ORDER BY 1, 2`, [VCR_SCHEMA])).rows;
  /** @type {Record<string, number>} */
  const counts = {};
  for (const table of tables) {
    // Identifiers come from the catalog, quoted; nothing here is caller text.
    const quoted = `"${String(table.schemaname).replaceAll('"', '""')}"."${String(table.tablename).replaceAll('"', '""')}"`;
    counts[`${table.schemaname}.${table.tablename}`] = Number((await database.query(`SELECT count(*)::bigint AS n FROM ${quoted}`)).rows[0].n);
  }
  return counts;
}

async function main() {
  const url = cloneUrl(process.argv[2] ?? process.env.OPEN_SCIENCE_VCR_MIGRATE_CHECK_URL ?? "");
  const open = () => new ControlPlaneDatabase({ databaseUrl: url.href, databasePoolMax: 2, databaseConnectionTimeoutMs: 10_000 });
  const first = open();
  const second = open();
  /** @type {string[]} */
  const problems = [];
  try {
    const before = await countsOutsideModule(first);
    const existed = (await first.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [VCR_SCHEMA])).rows.length > 0;

    const started = Date.now();
    await migrateVcr(first);
    const firstMs = Date.now() - started;
    const again = Date.now();
    await migrateVcr(second);
    const secondMs = Date.now() - again;

    const after = await countsOutsideModule(first);
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[name] !== after[name]) problems.push(`${name} had ${before[name] ?? "no such table"} rows and has ${after[name] ?? "no such table"} after the migration`);
    }
    const present = new Set((await first.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [VCR_SCHEMA])).rows.map((row) => String(row.tablename)));
    const missing = VCR_TABLES.filter((name) => !present.has(name));
    if (missing.length) problems.push(`the migration left these declared tables out: ${missing.join(", ")}`);
    const unvalidated = (await first.query(
      `SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = $1 AND NOT c.convalidated ORDER BY 1`, [VCR_SCHEMA])).rows.map((row) => String(row.conname));

    const answer = {
      ok: problems.length === 0, database: decodeURIComponent(url.pathname.slice(1)), moduleSchemaExisted: existed,
      firstRunMs: firstMs, secondRunMs: secondMs, tablesDeclared: VCR_TABLES.length, tablesPresent: present.size,
      tablesOutsideModule: Object.keys(after).length, rowsOutsideModule: Object.values(after).reduce((sum, n) => sum + n, 0),
      unvalidatedConstraints: unvalidated, problems,
    };
    process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
    process.exitCode = answer.ok ? 0 : 1;
  } finally {
    await first.close().catch(() => {});
    await second.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`migrate-check: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
