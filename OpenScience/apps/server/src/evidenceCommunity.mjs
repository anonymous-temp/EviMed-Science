/**
 * The community column of an official zone (evidence-flywheel plan §5.2, F07, 2026-10-06): the cards users published on the same subjects as
 * the platform's own zone, signed, read-only, and ordered only by what the card contract allows an ordering to read.
 *
 * Hidden knowledge:
 *
 * - **What "the same subject" means is entity keys, not words.** The official zone's keys are the drug, disease and trial keys its own
 *   published cards carry (organisations and identifiers are left out: `FDA` is on half of the feed, and a shared DOI means the same paper, which
 *   is a different statement from the same subject). A user card is a candidate when its keys share one with the zone's.
 * - **Whose cards are listed is a rule of the write side, enforced when the page is read.** Only a card in a user zone the author opened to the
 *   internet, published, not withdrawn; never a product zone's (a company's cards about its own product are not offered beside the platform's
 *   as if they were independent); never the platform's own. And only an *established* author's: three published cards that each carry a ✓
 *   (plan §7, "新作者的公开内容在被独立佐证之前不进官方专区的社区栏"). A new author's cards are not hidden from the author or from the
 *   author's page — they are simply not placed under the platform's name until the third ✓ card exists, at which point they appear by themselves.
 * - **The platform never edits them.** The column reads rows and returns them: no field is rewritten, summarised or softened, and the card
 *   keeps its own producer, disclosure and ✓/⚠ marks when the reader opens it.
 * - **Ordering reads `EVIDENCE_RANKING_INPUTS` and nothing else**: the share of the card's claims found in their sources first, then the readers'
 *   score of its current revision, then recency. A placement, a follower count of the author or a platform preference is not an input.
 * - **The author is named by the shape the rest of the product names authors by.** `publicAuthorId` is the one place an account id becomes the
 *   id the author page's address takes; when the public author id replaces the account id everywhere, it is changed here and nowhere else.
 * - **Off is nothing.** With `OPEN_SCIENCE_EVIDENCE_COMMUNITY_CARDS_ENABLED` unset the route answers 404 `evidence_community_not_enabled` and
 *   no table is read.
 *
 * Which model capability would make it deletable: none; it is a join and an order.
 *
 * @module evidenceCommunity
 */
import { evidenceRankingComparator } from "@evimed/domain";
import { ENTITY_TEXT_KINDS, keyKind, splitKeys } from "@evimed/domain/entity-keys";
import { HttpError, sendJson } from "./security.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";
import { establishedAuthors, verifiedClaimCounts } from "./evidenceVerifiedCards.mjs";

/** Candidates read before the established-author rule and the order are applied. */
export const COMMUNITY_CANDIDATES = 200;
/** The most cards one page of the column lists, whatever the lever says. */
export const COMMUNITY_MAX_CARDS_CEILING = 50;
export const COMMUNITY_DEFAULT_MAX_CARDS = 20;
const ZONE_ID = /^ez_[A-Za-z0-9]{8,64}$/;

/** The three keys' kinds a zone's subject is made of. */
const isSubjectKey = (/** @type {string} */ key) => ENTITY_TEXT_KINDS.includes(/** @type {any} */ (keyKind(key)));

/**
 * @param {{ database: any, maxCards?: number, publicAuthorId?: ((userId: string) => string) | null, platformPublisherUserId?: string | null }} options
 */
export function createEvidenceCommunity({ database, maxCards = COMMUNITY_DEFAULT_MAX_CARDS, publicAuthorId = null, platformPublisherUserId = null }) {
  const counters = { requests: 0, empty: 0, listed: 0, heldBackNewAuthors: 0, failures: 0 };
  const limit = Math.max(1, Math.min(COMMUNITY_MAX_CARDS_CEILING, Math.floor(maxCards)));
  const rank = evidenceRankingComparator(["verified_share", "review_score", "recency"]);

  /**
   * The community's cards for one official zone. Null when the zone is not a published official zone.
   * @param {string} zoneId
   */
  async function forZone(zoneId) {
    if (typeof zoneId !== "string" || !ZONE_ID.test(zoneId)) return null;
    await migrateEvidenceZones(database);
    counters.requests += 1;
    try {
      const zone = (await database.query("SELECT id,title,kind FROM evimed_frontier.evidence_zones WHERE id=$1 AND state='published' AND kind='official'", [zoneId])).rows[0];
      if (!zone) return null;
      const own = (await database.query(
        "SELECT DISTINCT unnest(entity_keys) AS key FROM evimed_frontier.evidence_cards WHERE zone_id=$1 AND state='published' AND withdrawn IS NULL", [zoneId])).rows;
      const keys = splitKeys(own.map((row) => row.key)).entityKeys.filter(isSubjectKey);
      if (!keys.length) { counters.empty += 1; return { zoneId, entityKeys: [], items: [], limit }; }
      const candidates = (await database.query(
        `SELECT c.id,c.zone_id,c.user_id,c.title,c.summary,c.producer,c.originality,c.entity_keys,c.updated_at,c.revision,
           z.title AS zone_title,u.name AS author_name,
           (SELECT avg(r.score)::float8 FROM evimed_frontier.evidence_reviews r WHERE r.card_id=c.id AND r.card_revision=c.revision) AS review_score,
           (SELECT count(*)::integer FROM evimed_frontier.evidence_reviews r WHERE r.card_id=c.id AND r.card_revision=c.revision) AS reviews
         FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id JOIN evimed_control.users u ON u.id=c.user_id
         WHERE c.entity_keys && $1::text[] AND c.zone_id<>$2 AND z.kind='user' AND z.visibility='internet' AND z.state='published'
           AND c.state='published' AND c.withdrawn IS NULL AND c.user_id<>COALESCE($3::text,'')
         ORDER BY c.updated_at DESC,c.id LIMIT $4`, [keys, zoneId, platformPublisherUserId, COMMUNITY_CANDIDATES])).rows;
      const established = await establishedAuthors(database, [...new Set(candidates.map((row) => String(row.user_id)))]);
      const listed = candidates.filter((row) => established.has(String(row.user_id)));
      counters.heldBackNewAuthors += candidates.length - listed.length;
      const counts = await verifiedClaimCounts(database, listed.map((row) => String(row.id)));
      const items = listed.map((row) => {
        const found = counts.get(String(row.id)) ?? { claims: 0, verified: 0 };
        const share = found.claims ? found.verified / found.claims : null;
        return {
          id: String(row.id), zoneId: String(row.zone_id), zoneTitle: String(row.zone_title), title: String(row.title), summary: String(row.summary ?? ""),
          author: { id: publicAuthorId ? publicAuthorId(String(row.user_id)) : String(row.user_id), name: String(row.author_name ?? "") },
          producer: row.producer ? { kind: row.producer.kind, name: row.producer.name } : null,
          originality: row.originality ?? null,
          claims: { total: found.claims, verified: found.verified }, verifiedShare: share === null ? null : Math.round(share * 10_000) / 10_000,
          reviewScore: row.review_score === null ? null : Math.round(Number(row.review_score) * 100) / 100, reviews: Number(row.reviews),
          sharedKeys: splitKeys(row.entity_keys).entityKeys.filter((key) => keys.includes(key)),
          updatedAt: new Date(row.updated_at).toISOString(),
          ranking: { verified_share: share, review_score: row.review_score === null ? null : Number(row.review_score), recency: Math.floor(new Date(row.updated_at).getTime() / 86_400_000) },
        };
      }).sort(rank).slice(0, limit).map(({ ranking: _ranking, ...item }) => item);
      counters.listed += items.length;
      if (!items.length) counters.empty += 1;
      return { zoneId, entityKeys: keys, items, limit };
    } catch (error) {
      counters.failures += 1;
      throw error;
    }
  }

  return { forZone, stats: () => ({ ...counters, limit }) };
}

/**
 * @param {ReturnType<typeof createEvidenceCommunity> | null | undefined} community
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function evidenceCommunityMetricFamilies(community) {
  if (!community) return [];
  const stats = community.stats();
  return [
    { name: "open_science_evidence_community_requests_total", help: "Reads of an official zone's community column, by what they found: cards listed, nothing listed, or a failure.", type: "counter",
      series: [{ value: stats.listed, labels: { outcome: "cards_listed" } }, { value: stats.empty, labels: { outcome: "empty" } }, { value: stats.failures, labels: { outcome: "failed" } }] },
    { name: "open_science_evidence_community_held_back_total", help: "Candidate cards left out of a community column because their author is new: fewer than three published cards that each carry a ✓ claim.", type: "counter",
      series: [{ value: stats.heldBackNewAuthors, labels: { reason: "new_author" } }] },
    { name: "open_science_evidence_community_max_cards", help: "The most cards one community column lists (OPEN_SCIENCE_EVIDENCE_COMMUNITY_MAX_CARDS).", type: "gauge", series: [{ value: stats.limit }] },
  ];
}

/**
 * `GET /api/frontier/zones/:id/community`: the community column of an official zone the reader can read. Same door as the zone routes (the
 * frontier on, a signed-in account in its audience); with the column switched off it answers 404 `evidence_community_not_enabled`. Registered
 * before the zone routes, which would otherwise answer the path with their own 404.
 *
 * @param {{ store: any, service: any, frontier: any, config: any, community: ReturnType<typeof createEvidenceCommunity> | null }} options
 */
export function createEvidenceCommunityRoutes({ store, service, frontier, config, community }) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (!url.pathname.startsWith("/api/frontier/zones/") || !url.pathname.endsWith("/community")) return false;
    const parts = url.pathname.slice("/api/frontier/".length).split("/");
    if (parts.length !== 3 || parts[0] !== "zones" || parts[2] !== "community" || (req.method ?? "GET") !== "GET") return false;
    if (!config.frontierEnabled || !service || !frontier || !config.evidenceCommunityCardsEnabled || !community)
      throw new HttpError(404, "evidence_community_not_enabled", "The community cards of an official zone are not enabled.");
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    if (!frontier.allows(user)) throw new HttpError(404, "frontier_not_enabled", "The frontier feed is not enabled.");
    let id;
    try { id = decodeURIComponent(parts[1]); } catch { throw new HttpError(404, "evidence_community_not_found", "No such official zone."); }
    // A published official zone is readable by every account the frontier admits, so its column is too; a zone that is a draft, someone's own
    // or not official answers exactly as an id that does not exist.
    const column = await community.forZone(id);
    if (!column) throw new HttpError(404, "evidence_community_not_found", "No such official zone.");
    sendJson(res, 200, { data: column }, { "Cache-Control": "private, no-store" });
    return true;
  };
}
