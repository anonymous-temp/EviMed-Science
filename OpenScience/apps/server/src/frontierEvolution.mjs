import { randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";
import { AI_DISCOVERY_PREFIX, AI_LAB_FEED_SOURCE_IDS, LEGACY_DISCOVERY_SOURCE_ID } from "./evolutionDiscoverySources.mjs";
/** Public discovery includes screened-out entries and never publishes them. @param {{database: any}} dependencies */
export function createFrontierEvolutionDiscovery({ database }) {
  return {
    /** Entries received after `since` (or after the `since`/`afterId` cursor a previous read returned), in arrival order.
     * `discovery` picks the AI discovery channel the medical feed drops (`only`), that channel and the lab feeds the medical
     * feed also reads (`self-research`, what the weekly self-research reads), everything else (`exclude`, for medical
     * confirmation tasks) or both (`any`). The channel is the plugin's `ai-discovery-` rows (`evolutionDiscoverySources.mjs`).
     * `publishedAfter` leaves out entries whose feed date is not after it: a paper's earliest public date is never later
     * than a date it was published under, so such an entry cannot be fresh and is not worth a provenance lookup.
     * @param {{since: string, afterId?: string|null, limit?: number, discovery?: "only"|"self-research"|"exclude"|"any", publishedAfter?: string|null}} input */
    async discover({ since, afterId = null, limit = 25, discovery = "any", publishedAfter = null }) {
      /** @type {(string|number|string[])[]} */
      const params = [since, Math.max(1, Math.min(100, limit))];
      const after = afterId == null ? "e.received_at > $1::timestamptz" : `(e.received_at, e.id) > ($1::timestamptz, $${params.push(String(afterId))}::bigint)`;
      const fresh = publishedAfter == null ? "true" : `(e.published_at IS NULL OR e.published_at > $${params.push(publishedAfter)}::timestamptz)`;
      let channel = "true";
      if (discovery === "only" || discovery === "exclude" || discovery === "self-research") {
        const discoveryOnly = `(starts_with(e.source_id, $${params.push(AI_DISCOVERY_PREFIX)}::text) OR e.source_id = $${params.push(LEGACY_DISCOVERY_SOURCE_ID)}::text OR coalesce(e.facts->>'discovery_only', '') = 'true')`;
        channel = discovery === "only" ? discoveryOnly : discovery === "exclude" ? `NOT ${discoveryOnly}`
          : `(${discoveryOnly} OR e.source_id = ANY($${params.push([...AI_LAB_FEED_SOURCE_IDS])}::text[]))`;
      }
      const result = await database.query(`SELECT e.*, e.received_at::text AS received_at_exact, min(v.published_at) AS earliest_public_at, array_remove(array_agg(DISTINCT v.doi), NULL) AS related_dois
        FROM evimed_frontier.entries e
        LEFT JOIN evimed_frontier.item_links l ON l.kind IN ('preprint-of', 'new-version')
          AND (lower(l.from_doi) = lower(e.doi) OR lower(l.to_doi) = lower(e.doi))
        LEFT JOIN evimed_frontier.entries v ON lower(v.doi) IN (lower(l.from_doi), lower(l.to_doi))
        WHERE ${after} AND ${channel} AND ${fresh}
        GROUP BY e.id ORDER BY e.received_at, e.id LIMIT $2`, params);
      return result.rows.map((entry) => ({ id: String(entry.id), title: entry.title_raw, abstract: entry.summary_raw,
        sourceId: entry.source_id, identityKey: entry.identity_key, publishedAt: entry.published_at ? new Date(entry.published_at).toISOString() : null,
        receivedAt: new Date(entry.received_at).toISOString(),
        // The exact database timestamp (microseconds) and id: a cursor rounded to milliseconds would read its own row again.
        cursor: { receivedAt: entry.received_at_exact ?? new Date(entry.received_at).toISOString(), at: new Date(entry.received_at).toISOString(), id: String(entry.id) },
        sourceUrl: entry.canonical_url, sourceText: entry.summary_raw, sourceDigest: entry.content_sha256,
        publicationStatus: entry.facts?.publicationStatus ?? "unknown", doi: entry.doi,
        sourceRoot: entry.doi ? [...(entry.related_dois ?? []),entry.doi].map((doi)=>String(doi).toLowerCase()).sort()[0] : entry.identity_key,
        firstPublicEvidenceId: `frontier-entry:${entry.id}:${entry.revision}`,
        provenanceEvidence: {entryId:String(entry.id),revision:entry.revision,relatedDois:entry.related_dois ?? [],publishedAt:entry.published_at,datePrecision:entry.date_precision},
        earliestPublicAt: [entry.earliest_public_at, entry.published_at].filter(Boolean).map((date) => new Date(date).toISOString()).sort()[0] ?? null,
        provenanceResolved: Boolean(entry.earliest_public_at) && entry.date_precision !== "inferred", datePrecision: entry.date_precision }));
    },
    /** The plugin's rows the self-research reads, as the platform mirrored them: whether each is on and how the plugin finds it.
     * @returns {Promise<{id: string, name: string, enabled: boolean, health: string, lastOkAt: string|null, lastNewEntryAt: string|null}[]>} */
    async sources() {
      const result = await database.query(`SELECT id, name, enabled, plugin_health, last_ok_at, last_new_entry_at FROM evimed_frontier.sources
        WHERE retired_at IS NULL AND (starts_with(id, $1::text) OR id = $2::text OR id = ANY($3::text[])) ORDER BY id`,
      [AI_DISCOVERY_PREFIX, LEGACY_DISCOVERY_SOURCE_ID, [...AI_LAB_FEED_SOURCE_IDS]]);
      const iso = (/** @type {any} */ value) => (value ? new Date(value).toISOString() : null);
      return result.rows.map((/** @type {any} */ row) => ({ id: row.id, name: row.name, enabled: row.enabled === true, health: row.plugin_health,
        lastOkAt: iso(row.last_ok_at), lastNewEntryAt: iso(row.last_new_entry_at) }));
    },
  };
}
/** Issue the candidate identity on the server; the browser can only report visibility within it.
 * @param {any} database @param {string} userId @param {any} input */
export async function issueFrontierExposure(database, userId, input) {
  await database.query("DELETE FROM evimed_frontier.exposure_snapshots WHERE created_at < clock_timestamp() - interval '24 hours'");
  const token = randomUUID();
  await database.query(`INSERT INTO evimed_frontier.exposure_snapshots (token, user_id, surface, policy_revision_id, candidate_ids)
    VALUES ($1,$2,$3,$4,$5::jsonb)`, [token,userId,input.surface,input.policyRevisionId,JSON.stringify(input.candidateIds)]);
  return { token, ...input };
}
/** @param {any} database @param {string} userId @param {any} input */
export async function recordFrontierExposure(database, userId, input) {
  if (!input || typeof input.token !== "string" || input.token.length > 100
    || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100
    || input.items.some((item) => !/^[a-zA-Z0-9_-]{1,100}$/.test(String(item.id)) || !Number.isInteger(item.position) || item.position < 0 || item.position > 500))
    throw new HttpError(400, "frontier_payload_invalid", "Invalid frontier exposure.");
  const snapshot = (await database.query(`SELECT * FROM evimed_frontier.exposure_snapshots
    WHERE token=$1 AND user_id=$2 AND created_at > clock_timestamp() - interval '24 hours'`, [input.token,userId])).rows[0];
  if (!snapshot || input.items.some((item) => !snapshot.candidate_ids.includes(String(item.id))))
    throw new HttpError(400, "frontier_payload_invalid", "Exposure does not match the serving snapshot.");
  await database.query(`INSERT INTO evimed_frontier.exposures (user_id, surface, policy_revision_id, items, candidate_ids)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`, [userId, snapshot.surface, snapshot.policy_revision_id, JSON.stringify(input.items), JSON.stringify(snapshot.candidate_ids)]);
  return { recorded: true };
}
