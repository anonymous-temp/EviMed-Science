/**
 * The card port of a topic zone's page (owner, 2026-10-29): where the 「证据卡片」 of a zone come from.
 *
 * The platform writes no evidence cards of its own any more (the old zones and their cards were deleted by the topic-zone reset);
 * cards come only from a team interface that does not exist yet. A zone's page asks this port for them and renders what it returns,
 * so the day the interface exists is a change in this file and nowhere else: the page, the routes and `evidenceTopicClient.ts`
 * already speak the shape below.
 *
 * Hidden knowledge:
 *
 * - **Two providers, by `config.evidenceCardProvider`.** `none` (the default) answers an empty list. `external` is where the team's
 *   interface plugs in: `createEvidenceZoneCards({ config, external })` takes an adapter with one method,
 *   `list(zone, { limit }) → TopicCard[]` (a zone is `{ id, slug, title, definition }`), and calls it for a zone's page. Without an
 *   adapter `external` is still a stub — it answers `[]` and `status().configured` says `false`, which is what an operator reads to
 *   learn the interface is not connected. Nothing else in the control plane needs to change when the adapter is written.
 * - **A card is never evidence.** Whatever the interface returns, the research method cites the primary sources a card names and
 *   never the card (the `platform-card-citation` advice check); this port only places cards on a page.
 * - **A failing interface costs the cards and nothing else.** `list` never throws: an adapter that fails is counted and answers `[]`,
 *   so the page shows the cards it has already synced (none, today) without telling a reader about the fault (plan §4.3.7).
 * - **The shape is the page's.** A `TopicCard` is exactly `evidenceTopicClient.ts`'s `TopicCard`; a card the adapter returns that
 *   lacks an id or a title is dropped here, and a card's links are left as the adapter gave them (`detail.href` inside the app, or
 *   `detail.url` to the other party's page).
 *
 * Which capability would make it deletable: none — the port is the seam to a system that is not ours.
 *
 * @module evidenceZoneCards
 */

/**
 * One card as a zone's page shows it (the web's `TopicCard`).
 * @typedef {{
 *   provider: string, id: string, version: string, updatedAt: string | null,
 *   status: 'current' | 'updating' | 'superseded' | 'withdrawn',
 *   title: string, conclusion: string,
 *   certainty: { scheme: string, level: string, labelZh: string } | null,
 *   producer: { name: string, kind: string }, sourceCount: number,
 *   detail: { kind: 'inline', href: string } | { kind: 'link', url: string },
 * }} TopicCard
 */

/**
 * The adapter the team's interface will be.
 * @typedef {{ list: (zone: { id: string, slug: string | null, title: string, definition?: unknown }, options: { limit: number }) => Promise<TopicCard[]> }} ExternalCards
 */

/** The most cards one answer carries. */
export const EVIDENCE_ZONE_CARDS_MAX = 50;

/**
 * @param {{ config?: { evidenceCardProvider?: string } | null, external?: ExternalCards | null }} [options]
 */
export function createEvidenceZoneCards({ config = null, external = null } = {}) {
  const provider = config?.evidenceCardProvider === "external" ? "external" : "none";
  const adapter = provider === "external" ? external : null;
  const counters = { lists: 0, failures: 0 };
  return {
    provider,
    /**
     * The cards of a zone, newest first as the provider gave them; `[]` when there is no provider, no adapter, or the adapter failed.
     * @param {{ id: string, slug?: string | null, title: string, definition?: unknown }} zone @param {{ limit?: number }} [options]
     * @returns {Promise<TopicCard[]>}
     */
    async list(zone, { limit = 3 } = {}) {
      counters.lists += 1;
      if (!adapter) return [];
      const bound = Math.max(1, Math.min(EVIDENCE_ZONE_CARDS_MAX, Math.trunc(Number(limit)) || 3));
      try {
        const cards = await adapter.list({ id: zone.id, slug: zone.slug ?? null, title: zone.title, definition: zone.definition }, { limit: bound });
        return (Array.isArray(cards) ? cards : [])
          .filter((card) => card && typeof card.id === "string" && card.id && typeof card.title === "string" && card.title)
          .slice(0, bound);
      } catch {
        counters.failures += 1;
        return [];
      }
    },
    /** What the operator figures read: which provider, whether the interface is connected, and how it has been used. */
    status() {
      return { provider, configured: Boolean(adapter), lists: counters.lists, failures: counters.failures };
    },
  };
}
