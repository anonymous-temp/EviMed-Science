#!/usr/bin/env node
/**
 * The one step that removes three VCR tables nothing reads or writes any more: the batch reading's ledger of records read (`matching_extractions`, a pseudonym, a document id and counts)
 * and the per-account cache of a registry trial's structuring (`parsed_trial_criteria`, `parsed_trial_criteria_versions`, a public record's parse). A fresh schema does not have them, and
 * the schema never drops a table on a start (`vcrPersistence.mjs`), so a database from before 2026-11-05 keeps them until an operator runs this.
 *
 *   OPEN_SCIENCE_DATABASE_URL=... node scripts/ops/vcr-retire-unread-tables.mjs            counts what is there
 *   OPEN_SCIENCE_DATABASE_URL=... node scripts/ops/vcr-retire-unread-tables.mjs --apply    and drops them, in one transaction
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const UNREAD_TABLES = Object.freeze(['matching_extractions', 'parsed_trial_criteria', 'parsed_trial_criteria_versions']);

/**
 * Count each table that exists and, with `apply`, drop it. Run it inside a transaction.
 * @param {{ query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }} client @param {{ apply: boolean }} options
 * @returns {Promise<Record<string, number>>} the rows each table held
 */
export async function retireUnreadTables(client, { apply }) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const table of UNREAD_TABLES) {
    const found = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`evimed_vcr.${table}`]);
    if (!found.rows[0].present) continue;
    counts[table] = Number((await client.query(`SELECT count(*)::bigint AS n FROM evimed_vcr.${table}`)).rows[0].n);
    if (apply) await client.query(`DROP TABLE evimed_vcr.${table}`);
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.OPEN_SCIENCE_DATABASE_URL;
  if (!url) throw new Error('OPEN_SCIENCE_DATABASE_URL names the database.');
  const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../apps/server/package.json'));
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const apply = process.argv.includes('--apply');
    await client.query('BEGIN');
    const counts = await retireUnreadTables(client, { apply });
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({ applied: apply, counts })}\n`);
  } finally {
    await client.end();
  }
}
