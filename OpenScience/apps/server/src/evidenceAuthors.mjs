/**
 * The author page and the links between cards (evidence-flywheel plan §5.2, F07, 2026-10-05).
 *
 * Hidden knowledge:
 *
 * - **A reader sees what the reader may see.** An author's page lists their published zones and the published cards in
 *   them, and nothing else: a draft, an unpublished zone and a card in a withdrawn zone are not on it, whoever
 *   looks — the author included, because the page is the public face and not a workbench. An account with nothing
 *   published has no page: the answer is the same `evidence_author_not_found` as for an id that is not an account, so the
 *   page cannot be used to find out who has signed up.
 * - **The only citation signal that exists is runs started.** 「由这位作者的卡片发起的研究」 counts research runs another
 *   account started from one of the author's cards (`EvidenceOrigins`): not runs read, trusted or cited in a paper, and
 *   not the author's own. It is named for what it is.
 * - **No ranking.** Nothing here orders authors, scores them or compares one with another; the page is one author's
 *   own record, the most recently updated first.
 * - **The change log is another package's.** When a reader of an author's recent corrections and updates is given, the
 *   page carries it; when it is absent or cannot answer, the page leaves it out and is otherwise the same.
 * - **Links read lineage, and only published cards.** A card's `relatedCards` are the published cards whose lineage names
 *   it — as the earlier card they follow (`previousCardId`) or as the card their research began from (`originCardId`).
 *   What a card points back to is shown to the reader only when the reader may read it.
 *
 * @module evidenceAuthors
 */

import { HttpError } from "./security.mjs";
import { EVIDENCE_CARD_ID, migrateEvidenceOrigins } from "./evidenceOrigins.mjs";

/** How much of an author's record one page carries: the zones, the cards (newest first), the recent changes. */
export const EVIDENCE_AUTHOR_PAGE_LIMITS = Object.freeze({ zones: 50, cards: 30, changes: 10 });
/** The most related cards one card lists. */
export const EVIDENCE_RELATED_CARD_LIMIT = 20;
const USER_ID = /^[A-Za-z0-9._@:-]{1,200}$/;

const notFound = () => new HttpError(404, "evidence_author_not_found", "No evidence published by this author.");

/** A card another card points to, as a reader sees it in a list. @param {any} row */
const cardRef = (row) => ({
  id: String(row.id),
  zoneId: String(row.zone_id),
  title: String(row.title),
  creator: row.creator ?? null,
  producer: row.producer ? { kind: row.producer.kind, name: row.producer.name } : null,
});

export class EvidenceAuthors {
  /**
   * @param {{ database: any, platformPublisherUserId?: string | null,
   *   changeLog?: { recentForAuthor: (authorId: string, options: { limit: number }) => Promise<unknown[]> } | null }} options
   *   `changeLog` is the change log's reader (another package); absent, the page has no change section.
   */
  constructor({ database, platformPublisherUserId = null, changeLog = null }) {
    this.database = database;
    this.platformPublisherUserId = platformPublisherUserId;
    this.changeLog = changeLog;
  }

  /**
   * One author's page, as a reader sees it.
   * @param {{ id: string }} _reader @param {string} authorId
   */
  async page(_reader, authorId) {
    if (typeof authorId !== "string" || !USER_ID.test(authorId)) throw notFound();
    await migrateEvidenceOrigins(this.database);
    const author = (await this.database.query("SELECT id,name FROM evimed_control.users WHERE id=$1", [authorId])).rows[0];
    if (!author) throw notFound();
    const zones = (await this.database.query(
      `SELECT z.id,z.title,z.description,z.kind,z.visibility,z.updated_at,
         (SELECT count(*)::integer FROM evimed_frontier.evidence_cards c WHERE c.zone_id=z.id AND c.state='published') AS evidence_count,
         (SELECT count(*)::integer FROM evimed_frontier.evidence_zone_follows f WHERE f.zone_id=z.id) AS follows
       FROM evimed_frontier.evidence_zones z WHERE z.user_id=$1 AND z.state='published' ORDER BY z.updated_at DESC, z.id LIMIT $2`,
      [authorId, EVIDENCE_AUTHOR_PAGE_LIMITS.zones],
    )).rows;
    if (!zones.length) throw notFound();
    const cards = (await this.database.query(
      `SELECT c.id,c.zone_id,c.title,c.summary,c.producer,c.originality,c.updated_at,jsonb_array_length(c.claims) AS claim_count,u.name AS creator
         FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id JOIN evimed_control.users u ON u.id=c.user_id
        WHERE z.user_id=$1 AND z.state='published' AND c.state='published' AND c.user_id=$1
        ORDER BY c.updated_at DESC, c.id LIMIT $2`,
      [authorId, EVIDENCE_AUTHOR_PAGE_LIMITS.cards],
    )).rows;
    const totals = (await this.database.query(
      `SELECT
         (SELECT count(DISTINCT f.user_id)::integer FROM evimed_frontier.evidence_zone_follows f JOIN evimed_frontier.evidence_zones z ON z.id=f.zone_id
           WHERE z.user_id=$1 AND z.state='published') AS followers,
         (SELECT count(*)::integer FROM evimed_frontier.evidence_card_runs r JOIN evimed_frontier.evidence_cards c ON c.id=r.card_id
           JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
           WHERE c.user_id=$1 AND z.user_id=$1 AND z.state='published' AND c.state='published' AND r.user_id<>$1) AS runs_from_cards,
         (SELECT count(*)::integer FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
           WHERE c.user_id=$1 AND z.user_id=$1 AND z.state='published' AND c.state='published') AS cards`,
      [authorId],
    )).rows[0];
    /** @type {unknown[] | null} */
    let changes = null;
    if (this.changeLog) {
      try { changes = await this.changeLog.recentForAuthor(authorId, { limit: EVIDENCE_AUTHOR_PAGE_LIMITS.changes }); } catch { changes = null; }
    }
    return {
      author: { id: String(author.id), name: String(author.name), platform: this.platformPublisherUserId != null && author.id === this.platformPublisherUserId },
      zones: zones.map((/** @type {any} */ zone) => ({
        id: String(zone.id), title: String(zone.title), description: String(zone.description ?? ""), kind: zone.kind, visibility: zone.visibility,
        evidenceCount: zone.evidence_count, follows: zone.follows, updatedAt: zone.updated_at,
      })),
      cards: cards.map((/** @type {any} */ card) => ({
        ...cardRef(card), summary: String(card.summary ?? ""), originality: card.originality ?? null, claimCount: card.claim_count, updatedAt: card.updated_at,
      })),
      totals: { cards: totals.cards, followers: totals.followers, runsFromCards: totals.runs_from_cards },
      ...(Array.isArray(changes) ? { changes } : {}),
    };
  }

  /**
   * What a card points to and what points to it, for the reading page: its author, the card its research began from, the
   * card it follows (each only when the reader may read it) and the published cards that follow it or began from it.
   * @param {{ id: string }} user @param {string} cardId
   */
  async links(user, cardId) {
    if (typeof cardId !== "string" || !EVIDENCE_CARD_ID.test(cardId)) throw new HttpError(404, "evidence_not_found", "No such visible evidence content.");
    await migrateEvidenceOrigins(this.database);
    const readable = `((c.state='published' AND z.state='published') OR (c.user_id=$2 AND z.user_id=$2))`;
    const card = (await this.database.query(
      `SELECT c.id,c.user_id,c.lineage,u.name AS author FROM evimed_frontier.evidence_cards c
         JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id JOIN evimed_control.users u ON u.id=c.user_id
        WHERE c.id=$1 AND ${readable}`,
      [cardId, user.id],
    )).rows[0];
    if (!card) throw new HttpError(404, "evidence_not_found", "No such visible evidence content.");
    /** @param {unknown} id */
    const pointed = async (id) => {
      if (typeof id !== "string" || !EVIDENCE_CARD_ID.test(id)) return null;
      const row = (await this.database.query(
        `SELECT c.id,c.zone_id,c.title,c.producer,u.name AS creator FROM evimed_frontier.evidence_cards c
           JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id JOIN evimed_control.users u ON u.id=c.user_id
          WHERE c.id=$1 AND ${readable}`,
        [id, user.id],
      )).rows[0];
      return row ? cardRef(row) : null;
    };
    const related = (await this.database.query(
      `SELECT c.id,c.zone_id,c.title,c.producer,u.name AS creator,
              CASE WHEN c.lineage->>'previousCardId'=$1 THEN 'next_version' ELSE 'research_from_card' END AS relation
         FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id JOIN evimed_control.users u ON u.id=c.user_id
        WHERE c.state='published' AND z.state='published' AND c.id<>$1 AND (c.lineage->>'originCardId'=$1 OR c.lineage->>'previousCardId'=$1)
        ORDER BY c.updated_at DESC, c.id LIMIT $2`,
      [cardId, EVIDENCE_RELATED_CARD_LIMIT],
    )).rows;
    return {
      author: { id: String(card.user_id), name: String(card.author) },
      origin: await pointed(card.lineage?.originCardId),
      previous: await pointed(card.lineage?.previousCardId),
      related: related.map((/** @type {any} */ row) => ({ ...cardRef(row), relation: row.relation })),
    };
  }
}
