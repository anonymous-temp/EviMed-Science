/**
 * Which evidence cards 循证传播 articles cite (evidence-flywheel plan §11, 2026-10-06): one of the five signals of the flywheel's north star, read from the
 * module's own tables by the module's own file, because no module outside GEO reads them (`geoFirewall.test.mjs`).
 *
 * Hidden knowledge:
 *
 * - **The columns are another package's.** An article made from a card carries `card_id`, and an article's text may carry references to card claims
 *   (`claim_refs`, each `{ cardId, claimId, revision }`); a release-5 database has neither. Each is looked for in the catalogue first, and with neither the
 *   answer is "no input" with the reason, never an empty list — the figure that reads it says null, not 0.
 * - **An article counts when it was made in the window**, by `created_at`: it is the act of citing, not of the article still standing, that is the signal.
 *
 * @module geoCardCitations
 */

/** @param {any} database @param {string} column */
async function hasColumn(database, column) {
  const { rows } = await database.query("SELECT 1 FROM information_schema.columns WHERE table_schema='evimed_geo' AND table_name='articles' AND column_name=$1", [column]);
  return rows.length > 0;
}

/**
 * @param {{ database: any }} options
 * @returns {(window: { from: Date, to: Date }) => Promise<{ cards: string[] } | { cards: null, reason: string }>}
 */
export function createGeoCardCitationReader({ database }) {
  return async ({ from, to }) => {
    const direct = await hasColumn(database, "card_id");
    const referenced = await hasColumn(database, "claim_refs");
    if (!direct && !referenced) return { cards: null, reason: "The communication module records no card reference in this deployment (no card_id or claim_refs on its articles)." };
    const found = new Set();
    if (direct) for (const row of (await database.query("SELECT DISTINCT card_id FROM evimed_geo.articles WHERE card_id IS NOT NULL AND created_at>=$1 AND created_at<$2", [from, to])).rows) found.add(String(row.card_id));
    if (referenced) {
      for (const row of (await database.query(
        "SELECT DISTINCT ref->>'cardId' AS card_id FROM evimed_geo.articles a, jsonb_array_elements(a.claim_refs) ref WHERE a.created_at>=$1 AND a.created_at<$2 AND ref->>'cardId' IS NOT NULL", [from, to])).rows) found.add(String(row.card_id));
    }
    return { cards: [...found] };
  };
}
