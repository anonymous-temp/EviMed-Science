import { verifyEvidenceCardClaims } from "@evimed/domain";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

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
 * **This is the only statement of the rule.** The feed, the public pages' indexing (`evidencePublicQuery.authorQualifies`) and the
 * community column (`evidenceCommunity`, through `evidenceEstablishedAuthors`) each used to hold a copy, and the copies looked at
 * different numbers of cards (50, 50 and 150). Each caller now asks this one, and keeps its own extra condition beside the call: an
 * official zone is exempt on the pages and in the feed (the platform is not a new author); the community column may list a card
 * whose author is not established when something independent corroborates it (plan §7). The ✓ counted is the platform-read ✓ —
 * `verified` in `verifyEvidenceCardClaims`, never `author_excerpt_only`.
 *
 * @module evidenceAuthorStanding
 */

/** The published, verified cards an author needs. */
export const EVIDENCE_ESTABLISHED_AUTHOR_MIN_CARDS = 3;
/** Cards read at a time, and the most cards looked at for one author: an author who has none among their newest 150 is not established today. */
const BATCH = 25;
const MOST_CARDS_LOOKED_AT = 150;
/** Verdicts a caller's cache keeps: one small entry per author. */
const CACHE_ENTRIES = 500;

/** The cards that could count, newest first: published, in a published zone, not withdrawn, with a claim and a source the platform read. */
const CANDIDATES_SQL = `FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
        WHERE c.user_id=$1 AND c.state='published' AND z.state='published' AND c.withdrawn IS NULL
          AND jsonb_array_length(c.claims)>0
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.sources) s WHERE s ? 'fetchedSha256' OR s ? 'documentText')
        ORDER BY c.updated_at DESC,c.id`;

/**
 * @typedef {Map<string, { key: string, established: boolean }>} EvidenceStandingCache a caller's own memory of verdicts, kept by the author's
 *   candidate cards and their revisions, so a verdict changes the moment a card is published, revised or withdrawn and not before
 */

/**
 * @param {{ query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }} database
 * @param {string} userId the author's account
 * @param {{ minCards?: number, cache?: EvidenceStandingCache | null }} [options] `cache`: a caller that asks about the same authors again and again (the public
 *   pages, one question per page view) hands in a Map of its own; the verdict is then re-made only when the author's candidate cards or their revisions changed
 * @returns {Promise<boolean>}
 */
export async function evidenceAuthorIsEstablished(database, userId, { minCards = EVIDENCE_ESTABLISHED_AUTHOR_MIN_CARDS, cache = null } = {}) {
  if (typeof userId !== "string" || !userId) return false;
  /** @type {string | null} */
  let key = null;
  if (cache) {
    const light = (await database.query(`SELECT c.id,c.revision ${CANDIDATES_SQL} LIMIT ${MOST_CARDS_LOOKED_AT}`, [userId])).rows;
    key = `${minCards}|${light.map((row) => `${row.id}:${row.revision}`).join(",")}`;
    const known = cache.get(userId);
    if (known && known.key === key) return known.established;
  }
  let found = 0;
  let established = false;
  for (let offset = 0; offset < MOST_CARDS_LOOKED_AT && !established; offset += BATCH) {
    // Only a card with claims and at least one source the platform read can have a ✓: the rest are not read into memory.
    const rows = (await database.query(`SELECT c.claims,c.sources ${CANDIDATES_SQL} LIMIT ${BATCH} OFFSET ${offset}`, [userId])).rows;
    for (const row of rows) {
      if ((verifyEvidenceCardClaims({ claims: row.claims, sources: row.sources }).counts.verified ?? 0) > 0) found += 1;
      if (found >= minCards) { established = true; break; }
    }
    if (rows.length < BATCH) break;
  }
  if (cache && key !== null) {
    cache.delete(userId);
    cache.set(userId, { key, established });
    if (cache.size > CACHE_ENTRIES) cache.delete(/** @type {string} */ (cache.keys().next().value));
  }
  return established;
}

/**
 * The accounts, of those asked about, that are established authors: the one rule above, asked once for each. An account that is not established is
 * simply absent from the answer. This is the form a caller that sees many authors at a time uses (the community column, the learning loop).
 * @param {{ query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }} database @param {Iterable<string>} userIds
 * @param {{ minCards?: number, cache?: EvidenceStandingCache | null }} [options]
 * @returns {Promise<Set<string>>}
 */
export async function evidenceEstablishedAuthors(database, userIds, options = {}) {
  await migrateEvidenceZones(database);
  /** @type {Set<string>} */
  const established = new Set();
  for (const userId of new Set(userIds)) if (await evidenceAuthorIsEstablished(database, userId, options)) established.add(userId);
  return established;
}
