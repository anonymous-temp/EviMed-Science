/**
 * Whether what a document was understood to say is the kind of reading the platform would write for it today, and the pass that
 * asks for a new reading where it is not (`scripts/ops/reunderstand-sources.mjs`).
 *
 * Hidden knowledge: until 2026-10-07 every PDF was read as a paper, and until 2026-10-13 every paper into the clinical slots, so a
 * product test, a policy or a contract read before then carries 研究设计 / 研究人群 / 干预或暴露 on its record, and the reader drew them
 * under 「研究信息」 (production, 2026-10-14: a product-test PDF whose own summary says 「这是一份产品测评记录，不是研究论文」). The page no
 * longer draws a slot that does not belong to the document's type (`SourceKeyPoints.tsx`); this is the other half — the reading itself
 * is made again, through `SourceService.retry`, the path 「重新读取」 takes, so it is queued, run and charged exactly as one a person asks for.
 *
 * What is not stale: a reading whose slots are all slots its type has today — a clinical paper keeps its clinical slots, they are
 * its type's optional ones — and a reading with no record of the type it was made under is judged by its slots alone.
 *
 * @module sourceUnderstandingCurrency
 */

import { sourceOriginOf, sourceUnderstandingSchema } from "@evimed/domain";

/**
 * Whether a stored reading is of the kind its document's type is read as today.
 * @param {unknown} docType the document's type as the ledger holds it now
 * @param {{ docType?: unknown, slots?: unknown } | null | undefined} output the stored understanding's output
 * @returns {{ current: boolean, schema: boolean, extra: string[] }} `schema`: it was made under another schema than the type's;
 *   `extra`: the slot keys it carries that its type does not have
 */
export function understandingFit(docType, output) {
  const wanted = sourceUnderstandingSchema(String(docType ?? ""));
  const allowed = new Set([...wanted.slots, ...wanted.optionalSlots]);
  const slots = output?.slots && typeof output.slots === "object" && !Array.isArray(output.slots) ? Object.keys(output.slots) : [];
  const extra = slots.filter((key) => !allowed.has(key));
  const madeAs = typeof output?.docType === "string" && output.docType ? sourceUnderstandingSchema(output.docType).id : null;
  const schema = madeAs !== null && madeAs !== wanted.id;
  return { current: extra.length === 0 && !schema, schema, extra };
}

/** The sources a pass looks at: read, with an understanding, and not a page the platform compiled. */
const CANDIDATES = `SELECT user_id, id, project_id, revision, payload->>'docType' AS doc_type, payload->>'currentUnderstandingId' AS understanding_id,
    payload->'paths'->>0 AS path, payload->'connector'->>'type' AS connector
  FROM evimed_product.documents
  WHERE kind='source' AND deleted_at IS NULL AND payload->>'currentUnderstandingId' IS NOT NULL
    AND payload->>'status' IN ('complete','needs_attention') AND payload->'deletion' IS NULL
    AND ($1::text[] IS NULL OR user_id = ANY($1::text[]))
  ORDER BY user_id, project_id, id`;

/**
 * Read every candidate's stored understanding and say which are not current. Reads only; text is never returned, only ids.
 * @param {{ database: any, documents: any, userIds?: readonly string[] | null }} dependencies
 * @returns {Promise<{ scanned: number, outdated: Array<{ userId: string, projectId: string, sourceId: string, revision: number, docType: string | null, schema: boolean, extra: string[] }> }>}
 */
export async function outdatedUnderstandings({ database, documents, userIds = null }) {
  const found = await database.query(CANDIDATES, [userIds ? [...userIds] : null]);
  let scanned = 0;
  /** @type {Awaited<ReturnType<typeof outdatedUnderstandings>>["outdated"]} */
  const outdated = [];
  for (const row of found.rows) {
    if (sourceOriginOf({ connectorType: row.connector, path: row.path }) === "wiki") continue;
    scanned += 1;
    const stored = await documents.get(row.user_id, "knowledge", row.understanding_id);
    if (!stored || stored.payload?.recordType !== "source-understanding") continue;
    const fit = understandingFit(row.doc_type, stored.payload.output);
    if (!fit.current) outdated.push({ userId: row.user_id, projectId: row.project_id, sourceId: row.id, revision: row.revision, docType: row.doc_type ?? null, schema: fit.schema, extra: fit.extra });
  }
  return { scanned, outdated };
}

/**
 * Ask for a new reading of up to `limit` of them, oldest first, the way 「重新读取」 does. A source that moved since it was read (its
 * revision changed, or it is already being read) is left for the next pass, which finds it again or finds it current.
 * @param {{ sources: { retry: (userId: string, sourceId: string, input: { expectedRevision: number }) => Promise<any> } }} dependencies
 * @param {Awaited<ReturnType<typeof outdatedUnderstandings>>["outdated"]} outdated @param {{ limit?: number }} [options]
 */
export async function requeueOutdated({ sources }, outdated, { limit = 25 } = {}) {
  const result = { queued: /** @type {string[]} */ ([]), left: 0, failed: /** @type {Array<{ sourceId: string, code: string }>} */ ([]) };
  for (const item of outdated) {
    if (result.queued.length >= limit) { result.left += 1; continue; }
    try {
      await sources.retry(item.userId, item.sourceId, { expectedRevision: item.revision });
      result.queued.push(item.sourceId);
    } catch (error) {
      const code = typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : "source_retry_failed";
      result.failed.push({ sourceId: item.sourceId, code });
    }
  }
  return result;
}
