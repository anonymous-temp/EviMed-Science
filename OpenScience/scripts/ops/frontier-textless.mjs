/**
 * Take back the published items a reader has nothing to read in (2026-10-22, owner: 「除非是真的全部信息都没有，那么就先不展示出来」).
 *
 *   node scripts/ops/frontier-textless.mjs              # report what would change
 *   node scripts/ops/frontier-textless.mjs --apply      # change it
 *
 * An item is taken back when `frontierItemReadable` says no: no reader text (no full text, abstract or page excerpt), no summary
 * on its first entry a reader could use, not a record whose fields are its text (a registry or openFDA entry), not a safety feed's
 * notice — and it is not a safety alert. Before 2026-10-22 such items were published on their titles (a journal's paper after 48
 * hours, a top journal's at once); 3,531 of them stood published that evening. Run it after the knowledge plugin has read their
 * texts again (`python -m knowledge_plugin retext --kinds journal,page --apply`) and the platform has taken those in, so only
 * what is still empty is taken back.
 *
 * Taken back means: state `scored` (published no more; every list, the daily, search and the public pages read `published`
 * only), one `item_changes` row `remove` (`textless`), the content version moved once. Nothing is deleted: the pipeline asks for
 * its text again (`#processItems`, every twelve hours), and when a text arrives the item is edited and published through the
 * ordinary path. Idempotent: an item taken back is not published, and is not counted again.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { bumpFrontierVersion } from "../../apps/server/src/frontierPersistence.mjs";
import { frontierItemReadable } from "../../apps/server/src/frontierPipeline.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { apply: false };
  for (const argument of argv) {
    if (argument === "--apply") options.apply = true;
    else throw new Error(`Unknown argument ${argument}; use --apply or nothing.`);
  }
  return options;
}

/**
 * Report, and with `apply` make, the change: the published items with nothing to read, by source type, and their public ids.
 * @param {{ database: any, apply?: boolean }} input
 * @returns {Promise<{ applied: boolean, count: number, bySourceType: Record<string, number>, ids: string[] }>}
 */
export async function frontierTextless({ database, apply = false }) {
  return database.transaction(async (/** @type {any} */ client) => {
    // The candidates SQL can see (no text in any column, not a safety alert); each is then judged by the pipeline's own rule.
    const rows = (await client.query(`SELECT i.id, i.public_id, i.source_type, to_jsonb(t) AS texts, to_jsonb(s) AS source,
        (SELECT to_jsonb(e) FROM evimed_frontier.entries e WHERE e.item_id = i.id ORDER BY e.first_seen_at, e.id LIMIT 1) AS entry
      FROM evimed_frontier.items i
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      WHERE i.state = 'published' AND NOT i.safety_alert
        AND btrim(coalesce(t.body_text, '')) = '' AND btrim(coalesce(t.abstract_raw, '')) = '' AND btrim(coalesce(t.body_excerpt, '')) = ''
      ORDER BY i.visible_at DESC, i.id DESC
      FOR UPDATE OF i`)).rows;
    const empty = rows.filter((/** @type {any} */ row) => !frontierItemReadable({ texts: row.texts, entry: row.entry, source: row.source }));
    if (apply && empty.length) {
      const ids = empty.map((/** @type {any} */ row) => row.id);
      await client.query(`UPDATE evimed_frontier.items SET state = 'scored', selected = false, selected_rule = NULL, selected_at = NULL,
          lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp() WHERE id = ANY($1::bigint[])`, [ids]);
      await client.query(`INSERT INTO evimed_frontier.item_changes (item_id, op, reason) SELECT id, 'remove', 'textless' FROM unnest($1::bigint[]) AS id`, [ids]);
      await bumpFrontierVersion(client);
    }
    /** @type {Record<string, number>} */
    const bySourceType = {};
    for (const row of empty) bySourceType[row.source_type] = (bySourceType[row.source_type] ?? 0) + 1;
    return { applied: apply, count: empty.length, bySourceType, ids: empty.map((/** @type {any} */ row) => String(row.public_id)) };
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
    const result = await frontierTextless({ database, apply: options.apply });
    process.stdout.write(`${JSON.stringify({ ...result, ids: result.ids.slice(0, 50) }, null, 2)}\n`);
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
