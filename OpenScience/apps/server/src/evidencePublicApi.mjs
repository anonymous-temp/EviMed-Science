// The read-only JSON API of the public evidence pages (flywheel F27, plan §12 「两个专区长期并存」, 2026-10-06): what the team platform
// reads so that its zone page shows what the Science side holds, not a second copy of it.
//
// `GET /evidence/api/v1/…`, no session, no cookie read or set, and the same rule as the pages for what exists: a zone that is
// platform-visible, a draft, or a card of an account that is gone is the same 404 as an id that was never made.
//
//   zones                   ?kind=official|product|user   the public zones, ranked as the index ranks them, at most 50 per kind
//   zones/:id                                              one zone
//   zones/:id/cards         ?limit=&cursor=                its published cards, newest first (withdrawn ones are in the list, marked)
//   zones/:id/changes       ?limit=&before=                its change log, newest first
//   cards/:id               ?view=clinical|public          one card; a withdrawn card answers 410 with its reason and date
//   authors/:handle                                        an author's public record, by the author's public handle (`au_…`), never an account id
//   metrics                                                the monthly figures for the last twelve months that have data
//
// Every answer is `{ data, meta: { generatedAt, next? } }`: `next` is the cursor (or, for the change log, the `before`) of the page after
// this one. The shape is versioned by the path (`v1`): a change that is not additive is `v2`. `Cache-Control: public, max-age=300` and
// an `ETag` over `data` and `next` (so a re-read of unchanged content is a 304), and `Access-Control-Allow-Origin: *` on GET and HEAD.
// The router (`evidencePublicRoutes.mjs`) adds those headers; this module is the shapes.
//

import { EVIDENCE_ZONE_KINDS } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { evidenceAbsoluteUrl } from "./evidencePublicIndexing.mjs";
import { authorPath, cardPath, zonePath } from "./evidencePublicLayout.mjs";

/**
 * @typedef {{ id: string, title: string, description: string, kind: "official"|"product"|"user", kindLabel: string, producer: Producer | null, owner: { id: string | null, name: string }, follows: number, cards?: number, createdAt: string | null, updatedAt: string | null, path: string, url: string | null }} Zone
 * @typedef {{ kind: string, kindLabel: string | null, name: string, relation: string, relationLabel: string | null, products: string[] }} Producer
 * @typedef {{ id: string, zoneId: string, title: string, summary: string, revision: number, producer: Producer | null, originality: string | null, primary: boolean, aiGenerated: boolean, claims: { total: number, verified: number, warned: number, derived: number }, currency: string, currencyLabel: string | null, lastCheckedAt: string | null, withdrawn: { at: string | null, reason: string, changeLogId: string | null } | null, updatedAt: string | null, path: string, url: string | null }} CardSummary
 */

export const EVIDENCE_PUBLIC_API_PREFIX = "/evidence/api/v1";

const notFound = () => new HttpError(404, "evidence_public_not_found", "No such public evidence content.");
const invalid = (/** @type {string} */ message) => new HttpError(400, "evidence_public_query_invalid", message);

/**
 * @param {{ reads: ReturnType<typeof import("./evidencePublicQuery.mjs").createEvidencePublicReads>, metrics: ReturnType<typeof import("./evidencePublicMetrics.mjs").createEvidencePublicMetrics>, config: Record<string, any> }} options
 */
export function createEvidencePublicApi({ reads, metrics, config }) {
  /** A path and, when the deployment has a public address, the absolute URL. @param {string} path */
  const address = (path) => ({ path, url: evidenceAbsoluteUrl(config.publicUrl, path) });
  /** @param {any} zone */
  const zoneOut = (zone) => ({ ...zone, ...address(zonePath(zone.id)) });
  /** @param {any} card */
  const cardOut = (card) => ({ ...card, ...address(cardPath(card.id)) });

  /**
   * One request, as its path parts below `/evidence/api/v1/` and its query.
   * @param {string[]} parts @param {URLSearchParams} query
   * @returns {Promise<{ status?: number, data: any, next?: string | null, error?: { code: string, message: string } }>}
   */
  async function handle(parts, query) {
    const [resource, id, sub] = parts;
    if (resource === "metrics" && parts.length === 1) {
      return { data: { months: (await metrics.months()).map(({ month, data, figures }) => ({ month, hasData: data, figures })) } };
    }
    if (resource === "zones" && parts.length === 1) {
      const kind = query.get("kind");
      if (kind !== null && !EVIDENCE_ZONE_KINDS.includes(/** @type {any} */ (kind))) throw invalid(`kind is one of ${EVIDENCE_ZONE_KINDS.join(", ")}.`);
      const sections = await reads.indexZones();
      const kinds = kind ? [kind] : EVIDENCE_ZONE_KINDS;
      return { data: { zones: kinds.flatMap((entry) => /** @type {any[]} */ (/** @type {any} */ (sections)[entry]).map(zoneOut)) } };
    }
    if (resource === "zones" && id && parts.length === 2) {
      const zone = await reads.zone(id);
      if (!zone) throw notFound();
      return { data: { zone: zoneOut(zone) } };
    }
    if (resource === "zones" && id && sub === "cards" && parts.length === 3) {
      if (!(await reads.zone(id))) throw notFound();
      const page = await reads.zoneCards(id, { limit: query.get("limit"), cursor: query.get("cursor") });
      return { data: { cards: page.items.map(cardOut) }, next: page.next };
    }
    if (resource === "zones" && id && sub === "changes" && parts.length === 3) {
      if (!(await reads.zone(id))) throw notFound();
      const page = await reads.changeLog(id, { limit: query.get("limit"), before: query.get("before") });
      return { data: { changes: page.items }, next: page.nextBefore };
    }
    if (resource === "cards" && id && parts.length === 2) {
      const view = query.get("view") ?? "clinical";
      if (view !== "clinical" && view !== "public") throw invalid("view is clinical or public.");
      const card = await reads.card(id, view);
      if (!card) throw notFound();
      if (card.withdrawn) {
        return { status: 410, data: { card: cardOut(card) }, error: { code: "evidence_public_card_withdrawn", message: "This card was withdrawn; the reason and date are in `card.withdrawn`." } };
      }
      return { data: { card: { ...cardOut(card), links: await reads.cardLinks(card) } } };
    }
    if (resource === "authors" && id && parts.length === 2) {
      const author = await reads.author(id);
      if (!author) throw notFound();
      return { data: { author: { ...author, ...address(authorPath(author.author.id)), zones: author.zones.map(zoneOut), cards: author.cards.map(cardOut) } } };
    }
    throw notFound();
  }

  return { handle };
}
