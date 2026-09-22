#!/usr/bin/env node
/**
 * Rebuild the frontier feed's item vectors from the items they are derived from.
 *
 * `evimed_frontier.item_vectors` holds nothing of its own: each row is the
 * embedding of one published item's title and summary, and those live in
 * `evimed_frontier.items`. The PostgreSQL backup therefore leaves its rows out
 * (`scripts/ops/postgres-backup.py`, plan §10.4.6) — at about 13 KB a row they
 * would otherwise be most of every retained archive — so after a restore the
 * table is empty. The pipeline refills only what it published in the last 30
 * days (`FRONTIER_EMBED_WINDOW_MS`), so without this command every older item
 * stays out of the feed's vector search for good. It is also the command for a
 * change of embedding model or width: a vector stored under another model key
 * counts as missing, by the same test the pipeline uses.
 *
 *   node scripts/ops/rebuild-frontier-index.mjs          published items without a current vector
 *   node scripts/ops/rebuild-frontier-index.mjs --all    every published item, replacing what is there
 *
 * Hidden knowledge:
 *
 * - It converges and is safe to run again: items are walked in id order in
 *   batches of `REBUILD_BATCH`, each batch written in one transaction with the
 *   same upsert the pipeline uses, so a run that stops half way keeps what it
 *   wrote and the next run embeds only what is still missing.
 * - The text embedded is exactly the pipeline's (`frontierEmbeddingText`, a
 *   test holds the two equal): a vector made here and one made by the worker
 *   must be comparable, or search would rank rebuilt items by a different
 *   measure than fresh ones.
 * - It needs the configuration the server runs with — the database, the
 *   DashScope key, the embedding pin (`deps-version.json` → `openviking.embedding`)
 *   — and the module switched on, because an archive nobody reads needs no
 *   vectors.
 * - One run at a time (a session advisory lock): a second one started beside
 *   the first would pay for every embedding twice. Three failed batches in a
 *   row stop the run with the embedder's code — a key the provider refuses
 *   would otherwise be sent once per batch across the whole archive.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Items per embedding call and per transaction: the pipeline's own batch. */
export const REBUILD_BATCH = 16;
/** Batches that may fail in a row before the run stops. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** The session lock that keeps a second rebuild from running beside the first. */
const REBUILD_LOCK = "evimed-frontier-rebuild";

/** @param {string[]} argv */
export function parseArguments(argv) {
  let all = false;
  for (const argument of argv) {
    if (argument === "--all") all = true;
    else throw new Error(`unknown argument ${argument}; the only option is --all`);
  }
  return { all };
}

/**
 * The text an item's vector is the embedding of: its Chinese title (else the
 * original) and its Chinese summary, one per line — what a reader of the card
 * sees, and what `frontierPipeline.mjs` embeds when it publishes.
 * @param {{ title_raw: string, title_zh?: string | null, summary_zh?: string | null }} row
 */
export function frontierEmbeddingText(row) {
  return [row.title_zh ?? row.title_raw, row.summary_zh ?? ""].filter(Boolean).join("\n");
}

/** @param {unknown} error */
function codeOf(error) {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : "frontier_rebuild_failed";
}

/**
 * Embed the published items that lack a vector of the embedder's model (every
 * published item with `all`), in batches, and report what happened.
 * @param {{ database: any, embedder: { modelKey: string, embedDocuments: (texts: string[]) => Promise<number[][]> },
 *   all?: boolean, batchSize?: number }} options `database` a `ControlPlaneDatabase` whose frontier schema is migrated
 * @returns {Promise<{ locked: boolean, scope: "all" | "missing", modelKey: string, scanned: number, embedded: number,
 *   failed: number, batches: number, stopped: string | null, failures: Record<string, number>, remaining: number }>}
 */
export async function rebuildFrontierIndex({ database, embedder, all = false, batchSize = REBUILD_BATCH }) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new TypeError("The rebuild batch size is invalid.");
  const modelKey = String(embedder.modelKey);
  const totals = { locked: false, scope: /** @type {"all" | "missing"} */ (all ? "all" : "missing"), modelKey,
    scanned: 0, embedded: 0, failed: 0, batches: 0, stopped: /** @type {string | null} */ (null),
    failures: /** @type {Record<string, number>} */ ({}), remaining: 0 };
  return database.withClient(async (/** @type {any} */ lock) => {
    const acquired = await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [REBUILD_LOCK]);
    if (!acquired.rows[0]?.acquired) return { ...totals, locked: true };
    try {
      let cursor = "0";
      let consecutive = 0;
      for (;;) {
        const rows = (await database.query(`SELECT i.id::text AS id, i.title_raw, i.title_zh, i.summary_zh
            FROM evimed_frontier.items i
            WHERE i.state = 'published' AND i.id > $1::bigint
              AND ($2::boolean OR NOT EXISTS (SELECT 1 FROM evimed_frontier.item_vectors v
                WHERE v.item_id = i.id AND v.model_key = $3))
            ORDER BY i.id LIMIT $4`, [cursor, all, modelKey, batchSize])).rows;
        if (!rows.length) break;
        cursor = rows[rows.length - 1].id;
        totals.scanned += rows.length;
        totals.batches += 1;
        try {
          const vectors = await embedder.embedDocuments(rows.map(frontierEmbeddingText));
          if (!Array.isArray(vectors) || vectors.length !== rows.length || !vectors.every((vector) => Array.isArray(vector) && vector.length > 0)) {
            throw Object.assign(new Error("The embedder answered with the wrong number of vectors."), { code: "frontier_rebuild_response_invalid" });
          }
          await database.transaction(async (/** @type {any} */ client) => {
            for (const [index, row] of rows.entries()) {
              await client.query(`INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding, embedded_at)
                VALUES ($1, $2, $3, clock_timestamp())
                ON CONFLICT (item_id) DO UPDATE SET model_key = excluded.model_key, embedding = excluded.embedding,
                  embedded_at = excluded.embedded_at`, [row.id, modelKey, `[${vectors[index].join(",")}]`]);
            }
          });
          totals.embedded += rows.length;
          consecutive = 0;
        } catch (error) {
          const code = codeOf(error);
          totals.failed += rows.length;
          totals.failures[code] = (totals.failures[code] ?? 0) + rows.length;
          consecutive += 1;
          if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
            totals.stopped = code;
            break;
          }
        }
      }
      totals.remaining = Number((await database.query(`SELECT count(*)::bigint AS remaining FROM evimed_frontier.items i
        WHERE i.state = 'published' AND NOT EXISTS (SELECT 1 FROM evimed_frontier.item_vectors v
          WHERE v.item_id = i.id AND v.model_key = $1)`, [modelKey])).rows[0].remaining);
      return totals;
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [REBUILD_LOCK]);
    }
  });
}

/** @param {Record<string, unknown>} summary */
function report(summary) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exitCode = 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { migrateFrontier }, { KbEmbedder }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/frontierPersistence.mjs"),
    import("../../apps/server/src/kbEmbedding.mjs"),
  ]);
  const config = loadConfig();
  if (!config.frontierEnabled) {
    report({ ok: false, reason: "OPEN_SCIENCE_FRONTIER_ENABLED is false; nothing reads these vectors" });
    return;
  }
  // The server's own embedder: the knowledge base's model, width and key.
  const embedder = new KbEmbedder({ apiKey: config.dashscopeApiKey, model: config.kbEmbeddingModel,
    dimension: config.kbEmbeddingDimension, apiBase: config.kbEmbeddingApiBase, timeoutMs: config.kbEmbeddingTimeoutMs });
  if (!embedder.configured) {
    report({ ok: false, reason: "no DashScope key (OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE); nothing can be embedded" });
    return;
  }
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) {
      report({ ok: false, reason: "no control-plane database" });
      return;
    }
    // The width the server migrates with: a column of another width is
    // replaced here exactly as the server would replace it.
    const capabilities = await migrateFrontier(database, { dimension: config.kbEmbeddingDimension });
    if (!capabilities.vector) {
      report({ ok: false, reason: "pgvector is not installed; the frontier search runs without its vector leg" });
      return;
    }
    const started = Date.now();
    const totals = await rebuildFrontierIndex({ database, embedder, all: options.all });
    if (totals.locked) {
      report({ ok: false, reason: "another rebuild of the frontier index is running" });
      return;
    }
    const { locked: _locked, ...rest } = totals;
    report({ ok: totals.failed === 0 && totals.stopped === null, ...rest, ms: Date.now() - started });
  } finally {
    await store.close?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${/** @type {any} */ (error)?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
