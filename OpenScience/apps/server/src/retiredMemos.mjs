import { createHash } from "node:crypto";
import { recordRetiredTableRows } from "./memoryMetrics.mjs";

/**
 * What an erased account still has in the retired usememos store (review M-11, 2026-10-10).
 *
 * Hidden knowledge: research memory moved out of usememos into `evimed_memory` on 2026-09-11, and the service's tables stayed
 * in the `public` schema of the platform database (`scripts/ops/retire-usememos-tables.py` archives and drops them once the
 * import is accepted). They key ownership by that service's own ids and reference nothing in `evimed_control`, so the foreign
 * key that makes "delete my account" true for every other memory table never reached them: an account's records and notes
 * lived on there, in every nightly backup, after the account was gone.
 *
 * The retired service identified an EviMed account by two digests of its id (`scripts/ops/migrate-research-memory.mjs` is where
 * they were last read): the `namespace` of a `memory_record` row, and the trailing `#evimed-user-<tag>` line of a `memo`. This
 * removes the rows those two digests name, inside the account's own deletion, and tolerates a store that is no longer there —
 * on a deployment that ran the retirement the tables are dropped and there is nothing to remove.
 *
 * It also writes the two digests to `evimed_memory.retired_erasures`, which has no foreign key to the account: the archive
 * the retirement leaves (an encrypted dump, outside the thirty-day backup rotation) cannot have a row cut out of it in place,
 * and this ledger is what `retire-usememos-tables.py --forget-erased` re-seals the archive against. A digest names no
 * one to a reader who does not already hold the account's id.
 *
 * @module retiredMemos
 */

/** The retired tables an account's rows are in, with what ties a row to an account. */
const RETIRED_TABLES = Object.freeze({
  memory_record: { condition: "namespace = $1", identifier: (/** @type {{ namespace: string, tag: string }} */ owner) => owner.namespace },
  // The note's owner is the trailing tag line the retired client appended, and only that: a tag sitting inline is a tag anybody
  // could have typed (the import's own rule). The digest is hex, so it is safe in a pattern.
  memo: {
    condition: String.raw`content ~ ('(^|\n)#evimed-user-' || $1 || '[[:space:]]*$')`,
    identifier: (/** @type {{ namespace: string, tag: string }} */ owner) => owner.tag,
  },
});

/**
 * The two identifiers the retired service knew an account by.
 * @param {string} userId @returns {{ namespace: string, tag: string }}
 */
export function retiredMemosOwner(userId) {
  const digest = (/** @type {string} */ domain) => createHash("sha256").update(`${domain}:${userId}`).digest("hex").slice(0, 24);
  return {
    namespace: `evimed-science-${digest("evimed/memory-record/user/v1")}`,
    tag: digest("evimed/memos/user/v1"),
  };
}

/**
 * Remove an account's rows from the retired tables that are still there, and record the erasure for the archive. Inside the
 * deletion's own transaction (`client`).
 *
 * @param {any} client @param {string} userId @param {{ schema?: string }} [options]
 * @returns {Promise<{ tables: Record<string, number>, ledgered: boolean }>} rows removed per table that exists; absent for one that does not
 */
export async function eraseRetiredMemos(client, userId, { schema = "public" } = {}) {
  const owner = retiredMemosOwner(userId);
  /** @type {Record<string, number>} */
  const tables = {};
  for (const [name, { condition, identifier }] of Object.entries(RETIRED_TABLES)) {
    const present = await client.query("SELECT to_regclass($1) AS found", [`${schema}.${name}`]);
    if (!present.rows[0]?.found) continue;
    // A savepoint, so a retired table that is not the shape this was written for costs this table and not the account's deletion.
    await client.query("SAVEPOINT retired_memos_erasure");
    try {
      const result = await client.query(`DELETE FROM "${schema}"."${name}" WHERE ${condition}`, [identifier(owner)]);
      await client.query("RELEASE SAVEPOINT retired_memos_erasure");
      tables[name] = Number(result.rowCount ?? 0);
      recordRetiredTableRows(name, tables[name]);
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT retired_memos_erasure");
      await client.query("RELEASE SAVEPOINT retired_memos_erasure");
      // A column the table does not have, or a pattern it cannot run: the table is skipped, never the deletion.
      if (!["42703", "2201B", "42883"].includes(String(error?.code ?? ""))) throw error;
    }
  }
  await client.query(`INSERT INTO evimed_memory.retired_erasures (namespace, tag) VALUES ($1, $2) ON CONFLICT (namespace) DO NOTHING`,
    [owner.namespace, owner.tag]);
  return { tables, ledgered: true };
}
