import { randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";
/** Public discovery includes screened-out entries and never publishes them. @param {{database: any}} dependencies */
export function createFrontierEvolutionDiscovery({ database }) {
  return {
    /** @param {{since: string, limit?: number}} input */
    async discover({ since, limit = 25 }) {
      const result = await database.query(`SELECT e.*, min(v.published_at) AS earliest_public_at, array_remove(array_agg(DISTINCT v.doi), NULL) AS related_dois
        FROM evimed_frontier.entries e
        LEFT JOIN evimed_frontier.item_links l ON l.kind IN ('preprint-of', 'new-version')
          AND (lower(l.from_doi) = lower(e.doi) OR lower(l.to_doi) = lower(e.doi))
        LEFT JOIN evimed_frontier.entries v ON lower(v.doi) IN (lower(l.from_doi), lower(l.to_doi))
        WHERE e.received_at > $1::timestamptz
        GROUP BY e.id ORDER BY e.received_at, e.id LIMIT $2`, [since, Math.max(1, Math.min(100, limit))]);
      return result.rows.map((entry) => ({ id: String(entry.id), title: entry.title_raw, abstract: entry.summary_raw,
        sourceUrl: entry.canonical_url, sourceText: entry.summary_raw, sourceDigest: entry.content_sha256,
        publicationStatus: entry.facts?.publicationStatus ?? "unknown", doi: entry.doi,
        sourceRoot: entry.doi ? [...(entry.related_dois ?? []),entry.doi].map((doi)=>String(doi).toLowerCase()).sort()[0] : entry.identity_key,
        firstPublicEvidenceId: `frontier-entry:${entry.id}:${entry.revision}`,
        provenanceEvidence: {entryId:String(entry.id),revision:entry.revision,relatedDois:entry.related_dois ?? [],publishedAt:entry.published_at,datePrecision:entry.date_precision},
        earliestPublicAt: [entry.earliest_public_at, entry.published_at].filter(Boolean).map((date) => new Date(date).toISOString()).sort()[0] ?? null,
        provenanceResolved: Boolean(entry.earliest_public_at) && entry.date_precision !== "inferred", datePrecision: entry.date_precision }));
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
