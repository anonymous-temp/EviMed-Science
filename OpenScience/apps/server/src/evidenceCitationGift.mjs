/**
 * The citation gift (evidence-flywheel plan §5.2, F07, 2026-10-05): when other accounts' research has started from a
 * card a named number of times, its author may be thanked with a gifted lot of 灵豆.
 *
 * Interface only, and off. The owner has not chosen an amount: `OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_ENABLED` is false
 * and `OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_AMOUNT` is 0, and while either stands the hook returns before it reads a
 * table, asks the wallet or counts anything — turning it on is two values in `.env` and nothing else.
 *
 * Hidden knowledge:
 *
 * - **The gift is the wallet's own entry point.** It is an operator-style grant (`EvimedCreditsService.operatorGrant`):
 *   one gifted lot with a source, an expiry fixed now and a note, once per request id. The request id names the card
 *   and the milestone, so the hook being called twice for the same crossing — a restart, a replayed run record —
 *   is one lot; the wallet answers the repeat with `duplicate`.
 * - **A citation is a run another account started from the card.** The author's own runs are not counted, because an
 *   author who starts research from their own card ten times has been thanked by no one. The count is the only
 *   citation signal that exists today, and it counts runs started, not runs read or trusted.
 * - **Failure keeps the run.** The hook never throws into the run ledger that called it: a wallet that is down is a
 *   `failed` outcome and a line in the report, and the citation stays recorded.
 *
 * @module evidenceCitationGift
 */

import { createHash } from "node:crypto";
import { recordCitationGift } from "./evidencePublishMetrics.mjs";

/** The counts at which a card has been cited enough to be thanked. Named, so the owner's amount decision is the only one left. */
export const EVIDENCE_CITATION_MILESTONES = Object.freeze([10, 50, 200]);
/** How long a citation gift lasts; the wallet's own default for an operator grant. */
export const EVIDENCE_CITATION_GIFT_DAYS = 90;

const CARD_ID = /^ec_[A-Za-z0-9]{8,64}$/;

/**
 * @param {{ config: Record<string, any>,
 *   grant?: ((accountId: string, grant: { requestId: string, source: "campaign", amount: string, days: number, note: string }) => Promise<{ duplicate?: boolean }>) | null,
 *   report?: ((event: string, detail: Record<string, unknown>) => void) | null }} options
 *   `grant` is the credits service's `operatorGrant`; absent (billing off), an enabled hook has nothing to grant with.
 * @returns {(input: { cardId: string, authorId: string, count: number }) => Promise<{ status: "off" | "unavailable" | "ignored" | "granted" | "duplicate" | "failed" }>}
 */
export function createCitationGift({ config, grant = null, report = null }) {
  return async function cardCitedByResearch({ cardId, authorId, count }) {
    if (config.evidenceCitationGiftEnabled !== true || !(Number(config.evidenceCitationGiftAmount) > 0)) return { status: "off" };
    if (!grant) return { status: "unavailable" };
    if (typeof cardId !== "string" || !CARD_ID.test(cardId) || typeof authorId !== "string" || !authorId
      || !EVIDENCE_CITATION_MILESTONES.includes(count)) return { status: "ignored" };
    const requestId = `cg_${createHash("sha256").update(cardId).digest("hex").slice(0, 24)}_${count}`;
    try {
      const granted = await grant(authorId, {
        requestId, source: "campaign", amount: String(config.evidenceCitationGiftAmount), days: EVIDENCE_CITATION_GIFT_DAYS,
        note: `你的证据卡被其他研究者的研究引用 ${count} 次。`,
      });
      const outcome = granted?.duplicate === true ? "duplicate" : "granted";
      recordCitationGift(outcome);
      // Money moved by the platform for a person's work: who, which card and which milestone, never a note's text.
      report?.("evidence.citation_gift", { account: authorId, card: cardId, count, outcome });
      return { status: outcome };
    } catch (error) {
      recordCitationGift("failed");
      report?.("evidence.citation_gift", { account: authorId, card: cardId, count, outcome: "failed", code: /** @type {any} */ (error)?.code ?? "unknown" });
      return { status: "failed" };
    }
  };
}
