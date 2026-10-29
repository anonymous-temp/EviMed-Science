#!/usr/bin/env node
/**
 * Bring the last week's 精选 and near-line items to the reader of 2026-10-22, and take back what that day's rules no longer select.
 *
 *   node scripts/ops/frontier-reader-backfill.mjs              # report what would change
 *   node scripts/ops/frontier-reader-backfill.mjs --apply      # change it
 *   node scripts/ops/frontier-reader-backfill.mjs --days 3     # a shorter window (1-7)
 *
 * Two changes, both inside the window the pipeline's owed edits cover (`FRONTIER_DEFERRED_EDIT_WINDOW_MS`, seven days):
 *
 * - `reedit`: a published item that is selected, a safety alert, or within `FRONTIER_READER_MARGIN` of the selection line, edited
 *   by an earlier editor version, owes one edit again (its `editor_version` is cleared, as a late abstract clears it). The
 *   pipeline's owed-edit queue writes its 导读, 推荐理由 and tags with the shipped prompts within the day's budget — about ¥0.004
 *   an item — and its translation stage then writes the reader's Chinese full text. Nothing is unpublished or unselected by it.
 * - `unselect`: a journal's item still without its abstract (flag `no-abstract`) selected by the line or the lane floor is no
 *   longer selected (`frontierJournalWithoutAbstract`): 精选 carries a 导读. A safety alert and an operator's pin stay. One
 *   `item_changes` row each, and the content version moves once.
 *
 * Idempotent: an item already re-edited carries the shipped version and is not counted again; an item already unselected is not
 * selected. The output is one JSON object of counts and public ids. Run it after the release that carries the reader has started
 * (its server migrates the columns this reads).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { FRONTIER_EDITOR_VERSION } from "../../apps/server/src/frontierEditor.mjs";
import { bumpFrontierVersion } from "../../apps/server/src/frontierPersistence.mjs";
import { FRONTIER_READER_MARGIN, frontierSelectThreshold } from "../../apps/server/src/frontierPipeline.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DAY = 86_400_000;

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { apply: false, days: 7 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--days") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 7) throw new Error("--days takes 1 to 7");
      options.days = value;
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

/**
 * Report, and with `apply` make, the two changes over the last `days` days.
 * @param {{ database: any, threshold: number, days?: number, apply?: boolean, now?: Date }} input
 * @returns {Promise<{ applied: boolean, days: number, editorVersion: string, reedit: { count: number, ids: string[] }, unselect: { count: number, ids: string[] } }>}
 */
export async function frontierReaderBackfill({ database, threshold, days = 7, apply = false, now = new Date() }) {
  // No migration here: the release's server migrates the schema, with the deployment's own embedding width (a migration at
  // another width would empty the vector column).
  const since = new Date(now.getTime() - days * DAY);
  return database.transaction(async (/** @type {any} */ client) => {
    const reedit = (await client.query(`SELECT i.id, i.public_id FROM evimed_frontier.items i
      WHERE i.state = 'published' AND i.visible_at > $1 AND i.editor_version IS NOT NULL AND i.editor_version <> $2
        AND (i.selected OR i.safety_alert OR i.score_total >= $3)
      ORDER BY i.visible_at DESC, i.id DESC FOR UPDATE OF i`, [since, FRONTIER_EDITOR_VERSION, threshold - FRONTIER_READER_MARGIN])).rows;
    const unselect = (await client.query(`SELECT i.id, i.public_id FROM evimed_frontier.items i
      WHERE i.state = 'published' AND i.visible_at > $1 AND i.selected AND NOT i.safety_alert AND i.selected_rule IN ('threshold', 'lane-floor')
        AND i.source_type = 'journal' AND 'no-abstract' = ANY(i.flags)
      ORDER BY i.visible_at DESC, i.id DESC FOR UPDATE OF i`, [since])).rows;
    if (apply && reedit.length) {
      await client.query(`UPDATE evimed_frontier.items SET editor_version = NULL, editor_diagnostics = '{}'::jsonb, updated_at = clock_timestamp()
        WHERE id = ANY($1::bigint[])`, [reedit.map((/** @type {any} */ row) => row.id)]);
    }
    if (apply && unselect.length) {
      await client.query(`UPDATE evimed_frontier.items SET selected = false, selected_rule = NULL, selected_at = NULL, updated_at = clock_timestamp()
        WHERE id = ANY($1::bigint[])`, [unselect.map((/** @type {any} */ row) => row.id)]);
      for (const row of unselect) {
        await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'unselected-no-abstract')", [row.id]);
      }
      await bumpFrontierVersion(client);
    }
    const ids = (/** @type {any[]} */ rows) => rows.map((row) => String(row.public_id));
    return { applied: apply, days, editorVersion: FRONTIER_EDITOR_VERSION,
      reedit: { count: reedit.length, ids: ids(reedit) }, unselect: { count: unselect.length, ids: ids(unselect) } };
  });
}

/** The control-plane database, from the same sources the server reads it from. */
function databaseUrl() {
  const direct = process.env.OPEN_SCIENCE_DATABASE_URL;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  if (direct && fs.existsSync(file)) throw new Error("Database URL has conflicting direct and file sources.");
  if (direct) return direct;
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    const threshold = frontierSelectThreshold({ frontierSelectThreshold: process.env.OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD });
    const result = await frontierReaderBackfill({ database, threshold, days: options.days, apply: options.apply });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
