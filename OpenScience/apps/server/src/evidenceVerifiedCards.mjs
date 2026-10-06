/**
 * Which published cards carry a ✓, and which authors have earned the platform's trust by publishing three of them (evidence-flywheel
 * plan §5.2, §7, §11; 2026-10-06). The one place the learning loop's two rules — the community column of an official zone, and the
 * platform handbook's door — and the flywheel's own figures ask "is this card verified" and "is this author established".
 *
 * Hidden knowledge:
 *
 * - **A verified card is a card with at least one ✓ claim**, read the way the reader's ✓ is: `verifyEvidenceCardClaims` over the card as it
 *   stands now. The count is taken from the table each time — no stored total, no cache — because a claim's ✓ is a property of the card's
 *   sources, and a card revised since has a different answer.
 * - **An established author has three published cards that each carry a ✓**, in zones that are published, cards not withdrawn. This is the
 *   rule `evidencePublicQuery.authorQualifies` states for the public pages' indexing; it is written once more here, as one small function
 *   over a list of accounts, because the community column and the learning loop need it for many authors in one read and the public pages'
 *   copy answers one author at a time behind its own cache. The two must agree; the integrator folds this into the shared
 *   `evidenceAuthorIsEstablished` when that lands.
 * - **Calculated claims are left out of the counts**, as `evidenceFigures` leaves them: their ✓ needs an engine receipt this module does not
 *   read, and a card of calculations must not be scored as if its receipts were missing. A card is verified only by quotations found.
 *
 * @module evidenceVerifiedCards
 */
import { verifyEvidenceCardClaims } from "@evimed/domain";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

/** Cards verified in one read: each carries its sources' full text. */
export const VERIFIED_CARD_BATCH = 20;
/** The published ✓ cards that make an author established. */
export const ESTABLISHED_AUTHOR_CARDS = 3;
/** The newest cards of one author considered: three ✓ cards among the newest fifty is enough. */
const ESTABLISHED_WINDOW = 50;

/**
 * The quotation-checked claims of cards, as the table holds them now.
 * @param {any} database @param {readonly string[]} cardIds
 * @returns {Promise<Map<string, { claims: number, verified: number }>>} a card that does not exist is absent
 */
export async function verifiedClaimCounts(database, cardIds) {
  /** @type {Map<string, { claims: number, verified: number }>} */
  const counts = new Map();
  const ids = [...new Set(cardIds)];
  for (let from = 0; from < ids.length; from += VERIFIED_CARD_BATCH) {
    const rows = (await database.query("SELECT id,claims,sources FROM evimed_frontier.evidence_cards WHERE id=ANY($1::text[])", [ids.slice(from, from + VERIFIED_CARD_BATCH)])).rows;
    for (const row of rows) {
      const found = verifyEvidenceCardClaims({ claims: row.claims ?? [], sources: row.sources ?? [] }).counts;
      counts.set(String(row.id), { claims: found.total - (found.calculation_unverified ?? 0), verified: found.verified });
    }
  }
  return counts;
}

/**
 * The accounts, of those asked about, that are established authors. One read of each account's newest published cards and one
 * verification pass over them; an account with fewer than three ✓ cards is simply absent from the answer.
 * @param {any} database @param {readonly string[]} userIds
 * @returns {Promise<Set<string>>}
 */
export async function establishedAuthors(database, userIds) {
  await migrateEvidenceZones(database);
  const established = new Set();
  for (const userId of new Set(userIds)) {
    const cards = (await database.query(
      `SELECT c.id FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
       WHERE c.user_id=$1 AND c.state='published' AND z.state='published' AND c.withdrawn IS NULL AND jsonb_array_length(c.claims)>0
       ORDER BY c.updated_at DESC,c.id LIMIT $2`, [userId, ESTABLISHED_WINDOW])).rows;
    if (cards.length < ESTABLISHED_AUTHOR_CARDS) continue;
    const counts = await verifiedClaimCounts(database, cards.map((card) => String(card.id)));
    if ([...counts.values()].filter((entry) => entry.verified >= 1).length >= ESTABLISHED_AUTHOR_CARDS) established.add(userId);
  }
  return established;
}
