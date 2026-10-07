import { DOCUMENT_MEMORY_LAYER } from "./derivedMemory.mjs";
import { CAPABILITY_HANDBOOK_RECORD_TYPE } from "./handbookLibrary.mjs";
import { HANDBOOK_CANDIDATE_RECORD_TYPE, LEARNED_METHOD_RECORD_TYPE } from "./learningService.mjs";
import { migrateProductStore } from "./productPersistence.mjs";

/**
 * 「重置记忆」, the half that is not a memory record.
 *
 * Hidden knowledge: the memory page shows four kinds of thing, kept in two
 * stores — the structured memories (`evimed_memory.records`, which
 * `ResearchMemoryStore.purgeUserMemory` deletes) and, in the product ledger,
 * the learned methods, the capability handbooks and the notes of the
 * researcher's own capsules. The reset used to clear only the first and say it
 * had cleared everything; the page then still showed every method and handbook
 * (2026-10-07 walk). This is the rest of it, so the dialog's sentence is true.
 *
 * What goes, because the page shows it or would show it again: the account's
 * learned methods, its handbooks and the lessons still waiting to become one
 * (a waiting lesson applied after the reset would put a handbook back), and the
 * notes in its own capsules outside the document layer. What stays, because it
 * is not about the researcher: the capsules other people shared, and the facts a
 * knowledge-base document yielded, which belong to the document (`mine`).
 *
 * Deleted outright, with their history, inside one transaction — the memory
 * records are hard-deleted and a reset that left recoverable copies of the rest
 * would not be the clean slate its confirmation promises. Idempotent: a second
 * reset finds nothing. The recall index holds derived copies of the notes; every
 * hit is re-read from the ledger and dropped when its row is gone, so a stale
 * copy is harmless and the next index sweep removes it.
 *
 * @param {any} database the product database
 * @param {string} userId
 * @returns {Promise<{ methods: number, handbooks: number, entries: number }>}
 */
export async function resetLearnedMemory(database, userId) {
  await migrateProductStore(database);
  return database.transaction(async (/** @type {any} */ client) => {
    const removed = await client.query(`WITH doomed AS (
        SELECT kind, id, payload->>'recordType' AS record_type FROM evimed_product.documents
        WHERE user_id=$1 AND (
          (kind='method' AND payload->>'recordType' = ANY($2::text[]))
          OR (kind='fact' AND coalesce(payload->>'layer','') <> $3
            AND payload->>'capsuleId' IN (
              SELECT id FROM evimed_product.documents
              WHERE user_id=$1 AND kind='capsule' AND coalesce(payload->>'imported','false') <> 'true')))
      ) DELETE FROM evimed_product.documents d USING doomed
        WHERE d.user_id=$1 AND d.kind=doomed.kind AND d.id=doomed.id
        RETURNING doomed.kind AS kind, doomed.record_type AS record_type`,
    [userId, [LEARNED_METHOD_RECORD_TYPE, CAPABILITY_HANDBOOK_RECORD_TYPE, HANDBOOK_CANDIDATE_RECORD_TYPE], DOCUMENT_MEMORY_LAYER]);
    const count = (/** @type {(row: any) => boolean} */ match) => removed.rows.filter(match).length;
    return {
      methods: count((row) => row.record_type === LEARNED_METHOD_RECORD_TYPE),
      handbooks: count((row) => row.record_type === CAPABILITY_HANDBOOK_RECORD_TYPE),
      entries: count((row) => row.kind === "fact"),
    };
  });
}
