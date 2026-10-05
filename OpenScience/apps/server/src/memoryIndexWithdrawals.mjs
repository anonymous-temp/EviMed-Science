import { randomUUID } from "node:crypto";

/**
 * What a deletion owes the recall index, kept where the deletion is: in
 * PostgreSQL, in the transaction that removes the rows.
 *
 * The index (OpenViking) owns no record. It holds derived copies, every hit is
 * re-read from PostgreSQL before it is used, and a copy whose row is gone is
 * dropped there, so an index that has not yet been told about a deletion is
 * harmless to recall. Deleting a project used to ask the index to forget its
 * subtree first and fail the deletion when the index timed out (2026-10-05, live:
 * `DELETE /api/projects/<id>` answered 503 `memory_index_timeout`; the same
 * request succeeded two minutes later). Principle 18: an optional service being
 * slow is a status, and the work goes on. The authoritative rows go; the
 * withdrawal is a row here, retried with a backoff until the index answers.
 *
 * A table of its own rather than a job of the product queue, because the queue's
 * rows belong to an account (`ON DELETE CASCADE`) and one of these deletions is
 * the account's own: the row that must outlive the account is the whole point.
 * Nothing in it is personal data — a subtree address, which is a hash of an id,
 * and a count.
 */

const migrations = new WeakMap();

const SQL = `
CREATE SCHEMA IF NOT EXISTS evimed_memory;
CREATE TABLE IF NOT EXISTS evimed_memory.index_withdrawals (
  id text PRIMARY KEY,
  -- No foreign key, on purpose: see the module's comment.
  user_id text NOT NULL,
  uri text NOT NULL CHECK (uri LIKE 'viking://user/%/memories/evimed%' AND length(uri) <= 512),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz(3),
  UNIQUE (user_id, uri)
);
CREATE INDEX IF NOT EXISTS index_withdrawals_due_idx ON evimed_memory.index_withdrawals (next_attempt_at, created_at);
`;

/** A withdrawal that keeps failing is asked again after this long: thirty seconds, doubling to an hour. */
export function withdrawalBackoffMs(attempts) {
  return Math.min(3_600_000, 30_000 * 2 ** Math.min(Math.max(0, Number(attempts) || 0), 7));
}

export class MemoryIndexWithdrawals {
  /** @param {{ database: any, openViking: any }} dependencies */
  constructor({ database, openViking }) {
    this.database = database;
    this.openViking = openViking;
  }

  /** Before any transaction that will `enqueue`: DDL cannot run on a second connection from inside one. */
  async migrate() {
    if (migrations.has(this.database)) return migrations.get(this.database);
    const attempt = this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-memory-index-withdrawals-v1'))");
      await client.query(SQL);
    });
    migrations.set(this.database, attempt);
    try { await attempt; } catch (error) { migrations.delete(this.database); throw error; }
  }

  /**
   * Owe the index the removal of these subtrees, in the caller's transaction, so
   * that the withdrawal commits with the deletion it belongs to and rolls back
   * with it. Asked again for an address that is already waiting, it is due now.
   *
   * @param {{ query: Function }} client @param {string} userId @param {readonly string[]} uris
   */
  async enqueue(client, userId, uris) {
    if (!client || typeof client.query !== "function") throw new TypeError("A withdrawal is enqueued inside the deleting transaction.");
    const owner = String(userId ?? "");
    if (!owner) throw new TypeError("A withdrawal names the account whose copies it removes.");
    for (const uri of new Set(uris)) {
      if (typeof uri !== "string" || !uri.startsWith("viking://user/") || !uri.includes("/memories/evimed") || uri.length > 512) {
        throw new TypeError("A withdrawal names a subtree of the memory index.");
      }
      await client.query(`INSERT INTO evimed_memory.index_withdrawals(id,user_id,uri) VALUES ($1,$2,$3)
        ON CONFLICT (user_id,uri) DO UPDATE SET next_attempt_at=clock_timestamp(), lease_until=NULL`,
      [randomUUID(), owner, uri]);
    }
  }

  /**
   * Ask the index to remove what is owed, oldest first, until it fails.
   *
   * One failure ends the pass: an index that is down or slow answers the next
   * row the same way after the same wait, and the rows behind it are not worth
   * that. What failed is due again after a backoff; what was not reached is
   * released at once.
   *
   * @param {{ limit?: number, leaseMs?: number }} [options]
   * @returns {Promise<{ removed: number, failed: number, code?: string }>}
   */
  async drain({ limit = 25, leaseMs = 120_000 } = {}) {
    await this.migrate();
    const claimed = await this.database.query(`UPDATE evimed_memory.index_withdrawals
      SET lease_until = clock_timestamp() + ($2::int * interval '1 millisecond')
      WHERE id IN (
        SELECT id FROM evimed_memory.index_withdrawals
        WHERE next_attempt_at <= clock_timestamp() AND (lease_until IS NULL OR lease_until < clock_timestamp())
        ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id`, [Math.max(1, Math.min(100, Number(limit) || 25)), Math.max(1000, Number(leaseMs) || 120_000)]);
    // Oldest first, in the database's own order: an UPDATE ... RETURNING has none, and two rows written in
    // the same millisecond are ordered by id, which a string comparison here would order differently.
    const rows = claimed.rows.length === 0 ? [] : (await this.database.query(`SELECT id, user_id, uri, attempts
      FROM evimed_memory.index_withdrawals WHERE id = ANY($1::text[]) ORDER BY created_at, id`, [claimed.rows.map((row) => row.id)])).rows;
    let removed = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      try {
        // "Not found" is the index already agreeing: `remove` answers false for it.
        await this.openViking.remove(row.user_id, row.uri, { recursive: true });
        await this.database.query("DELETE FROM evimed_memory.index_withdrawals WHERE id=$1", [row.id]);
        removed += 1;
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : "memory_index_unavailable";
        await this.database.query(`UPDATE evimed_memory.index_withdrawals
          SET attempts=attempts+1, last_error=$2, lease_until=NULL,
              next_attempt_at=clock_timestamp() + ($3::int * interval '1 millisecond')
          WHERE id=$1`, [row.id, code, withdrawalBackoffMs(row.attempts + 1)]);
        const unreached = rows.slice(index + 1).map((other) => other.id);
        if (unreached.length) {
          await this.database.query("UPDATE evimed_memory.index_withdrawals SET lease_until=NULL WHERE id = ANY($1::text[])", [unreached]);
        }
        return { removed, failed: 1, code };
      }
    }
    return { removed, failed: 0 };
  }

  /** How many are owed and for how long the oldest has waited, for `/api/ops/metrics`. */
  async pending() {
    await this.migrate();
    const result = await this.database.query(`SELECT count(*)::int AS pending,
        COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at))), 0)::float AS oldest_seconds,
        COALESCE(max(attempts), 0)::int AS most_attempts
      FROM evimed_memory.index_withdrawals`);
    const row = result.rows[0] ?? {};
    return { pending: Number(row.pending) || 0, oldestSeconds: Number(row.oldest_seconds) || 0, mostAttempts: Number(row.most_attempts) || 0 };
  }
}
