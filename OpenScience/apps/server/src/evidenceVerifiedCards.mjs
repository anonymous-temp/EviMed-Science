/**
 * Which published cards carry a ✓ (evidence-flywheel plan §5.2, §7, §11; 2026-10-06). The one place the community column of an official zone, the
 * learning loop and the flywheel's own figures ask "is this card verified". Whether an *author* is established is not asked here: that is
 * `evidenceAuthorStanding.mjs`, the only statement of the rule.
 *
 * Hidden knowledge:
 *
 * - **A verified card is a card with at least one ✓ claim**, read the way the reader's ✓ is: `verifyEvidenceCardClaims` over the card as it
 *   stands now. The count is taken from the table each time — no stored total, no cache — because a claim's ✓ is a property of the card's
 *   sources, and a card revised since has a different answer.
 * - **Calculated claims are left out of the counts**, as `evidenceFigures` leaves them: their ✓ needs an engine receipt this module does not
 *   read, and a card of calculations must not be scored as if its receipts were missing. A card is verified only by quotations found.
 *
 * @module evidenceVerifiedCards
 */
import { verifyEvidenceCardClaims } from "@evimed/domain";

/** Cards verified in one read: each carries its sources' full text. */
export const VERIFIED_CARD_BATCH = 20;

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
