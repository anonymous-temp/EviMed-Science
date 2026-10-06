import { verifyEvidenceCardClaims } from "@evimed/domain";

/**
 * Whether an author is established: the one rule for letting a researcher's card go where the platform speaks for
 * itself — the public feed, the public pages, a community card (evidence-flywheel review, 2026-10-06).
 *
 * Hidden knowledge: the feed used to admit a researcher's card when its zone was open to the internet and its
 * `originality` was `original_research`, which the author sets. A card is now trusted by what the platform could
 * check, never by what its author said of it, and so is its author: **at least three published, non-withdrawn cards,
 * each with at least one claim whose quotation the platform verified (✓)** — a quotation found in text the platform
 * itself read (`verifyEvidenceCardClaims`), not in an excerpt the author typed. A brand-new account, or one whose
 * cards the platform has never been able to check, is not established, however many cards it has written. Official
 * zones are the platform's own voice and are not asked.
 *
 * Computed, never stored: the verdict is a function of the cards as they stand, so a card withdrawn tomorrow takes
 * its author's standing with it and nothing has to remember to revoke it. One query to find the cards that could
 * count, then the domain's own comparison for each until the minimum is reached.
 *
 * @module evidenceAuthorStanding
 */

/** The published, verified cards an author needs. */
export const EVIDENCE_ESTABLISHED_AUTHOR_MIN_CARDS = 3;
/** Cards read at a time, and the most cards looked at for one author: an author who has none among their newest 150 is not established today. */
const BATCH = 25;
const MOST_CARDS_LOOKED_AT = 150;

/**
 * @param {{ query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }} database
 * @param {string} userId the author's account
 * @param {{ minCards?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function evidenceAuthorIsEstablished(database, userId, { minCards = EVIDENCE_ESTABLISHED_AUTHOR_MIN_CARDS } = {}) {
  if (typeof userId !== "string" || !userId) return false;
  let found = 0;
  for (let offset = 0; offset < MOST_CARDS_LOOKED_AT; offset += BATCH) {
    // Only a card with claims and at least one source the platform read can have a ✓: the rest are not read into memory.
    const rows = (await database.query(
      `SELECT c.claims,c.sources FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
        WHERE c.user_id=$1 AND c.state='published' AND z.state='published' AND c.withdrawn IS NULL
          AND jsonb_array_length(c.claims)>0
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.sources) s WHERE s ? 'fetchedSha256' OR s ? 'documentText')
        ORDER BY c.updated_at DESC,c.id LIMIT ${BATCH} OFFSET ${offset}`, [userId])).rows;
    for (const row of rows) {
      if ((verifyEvidenceCardClaims({ claims: row.claims, sources: row.sources }).counts.verified ?? 0) > 0) found += 1;
      if (found >= minCards) return true;
    }
    if (rows.length < BATCH) break;
  }
  return false;
}
