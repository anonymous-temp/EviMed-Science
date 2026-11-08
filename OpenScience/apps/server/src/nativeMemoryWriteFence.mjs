import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
import { migrateNativeMemory } from './nativeMemoryPersistence.mjs';
import { migrateMemorySettings } from './memorySettingsPersistence.mjs';

/**
 * Normal native writes share an owner fence; source cleanup holds it exclusively and never waits on active owners.
 *
 * The fence is a lease row, never a held transaction or connection: production ends a session that idles in a transaction
 * after 120 s and its pool is about ten connections, while an engine call or a model call inside a write runs for minutes.
 * Admission and release are each one short transaction under a short advisory lock of the fence's own key
 * (`native-memory-lease:<user>`, never the plugin admission's `native-memory-writer` key, which a runtime start holds for a minute)
 * taken with a `lock_timeout`; a timeout answers the same 409 retry code. The operation runs with nothing held. A lease that was
 * never released (a crashed process) stops counting when it expires, which is two minutes after its last renewal.
 */
export const NATIVE_WRITER_LEASE_MS = 120_000;
const LOCK_TIMEOUT = '3s';
/** @typedef {{ id: string, userId: string, kind: 'shared'|'exclusive', released: boolean, lost: boolean }} Lease */
/** @type {AsyncLocalStorage<Map<string, Lease>>} */
const held = new AsyncLocalStorage();
const busy = () => new HttpError(409, 'memory_source_cleanup_busy', 'Native memory is being updated. Retry shortly.');

/** @param {any} database @param {string} userId @param {'shared'|'exclusive'} kind @param {string} leaseId @param {number} ttlMs */
async function admit(database, userId, kind, leaseId, ttlMs) {
  await migrateMemorySettings(database); await migrateNativeMemory(database);
  try {
    await database.withoutTransactionClient(() => database.transaction(async (/** @type {any} */ client) => {
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`native-memory-lease:${userId}`]);
      await client.query('DELETE FROM evimed_memory.native_writer_leases WHERE user_id=$1 AND expires_at<=clock_timestamp()', [userId]);
      const blocking = await client.query(
        `SELECT 1 FROM evimed_memory.native_writer_leases WHERE user_id=$1 AND ($2='exclusive' OR kind='exclusive') LIMIT 1`, [userId, kind]);
      if (blocking.rows.length) throw busy();
      // A shared writer inside a caller's transaction holds no lease row; it holds this key shared for the caller's whole transaction
      // instead. A cleanup tries it exclusively, in the same short transaction as its row, and is refused while any such writer runs.
      if (kind === 'exclusive') {
        const free = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok', [`native-memory-scoped:${userId}`]);
        if (!free.rows[0]?.ok) throw busy();
      }
      await client.query(
        `INSERT INTO evimed_memory.native_writer_leases (user_id, lease_id, kind, expires_at) VALUES ($1,$2,$3, clock_timestamp() + ($4 || ' milliseconds')::interval)`,
        [userId, leaseId, kind, String(ttlMs)]);
    }));
  } catch (error) {
    if (/** @type {any} */ (error)?.code === '55P03') throw busy();
    throw error;
  }
}

/** @param {any} database @param {string} userId @param {string} leaseId */
const release = (database, userId, leaseId) => database.withoutTransactionClient(() =>
  database.query('DELETE FROM evimed_memory.native_writer_leases WHERE user_id=$1 AND lease_id=$2', [userId, leaseId]));

/**
 * @template T
 * @param {any} database @param {string} userId @param {() => Promise<T>} operation
 * @param {{ exclusive?: boolean, leaseMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withNativeMemoryWrite(database, userId, operation, { exclusive = false, leaseMs = NATIVE_WRITER_LEASE_MS } = {}) {
  if (!database) return operation();
  const kind = exclusive ? 'exclusive' : 'shared';
  const current = held.getStore()?.get(userId);
  // A write inside a live write of the same account is one holder; a nested exclusive inside a shared one would silently run shared,
  // so it is refused. Work detached from a lease that has been released takes a fence of its own.
  if (current && !current.released) {
    if (exclusive && current.kind === 'shared') throw busy();
    // Every engine write goes through here (writeAdmission): a holder whose lease was lost stops before its next write.
    if (current.lost) throw busy();
    return operation();
  }
  // Inside a caller's transaction (a prompt admission or a runtime start holds one for its whole length, on one pooled connection) a lease
  // would need a second connection, and with the pool taken by such callers nothing could ever be admitted. A shared writer there holds
  // `native-memory-scoped:<user>` shared on the caller's own client and then looks for a live exclusive lease; a cleanup's admission tries
  // that key exclusively before it inserts its row, so the two never run together. An exclusive request always takes a real lease.
  let scoped = null;
  try { scoped = typeof database.transactionScope === 'function' ? database.transactionScope() : null; } catch { scoped = null; }
  if (scoped && !exclusive) {
    // Taken first and only tried, never waited on: it is shared, so writers never block one another, and a cleanup that holds it
    // exclusively (only inside its short admission) turns this writer away with the usual 409. Held until the caller's transaction ends.
    const got = await database.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS ok', [`native-memory-scoped:${userId}`]);
    if (!got.rows[0]?.ok) throw busy();
    const present = await database.query("SELECT to_regclass('evimed_memory.native_writer_leases') IS NOT NULL AS present");
    if (present.rows[0]?.present) {
      const cleaning = await database.query("SELECT 1 FROM evimed_memory.native_writer_leases WHERE user_id=$1 AND kind='exclusive' AND expires_at>clock_timestamp() LIMIT 1", [userId]);
      if (cleaning.rows.length) throw busy();
    }
    return operation();
  }
  const leaseId = randomUUID();
  await admit(database, userId, kind, leaseId, leaseMs);
  /** @type {Lease} */
  const lease = { id: leaseId, userId, kind, released: false, lost: false };
  // A long operation renews its lease so that it never reads as crashed. A renewal that finds the row missing or already expired means
  // the lease lapsed (this process could not reach the database in time): another writer, or a cleanup, may have been admitted beside it.
  // A shared lease is taken again under the same rules and is lost only when that is refused; an exclusive one is lost whatever
  // re-admission answers, because it can no longer say that no writer ran beside it.
  const renew = setInterval(() => {
    void database.withoutTransactionClient(() => database.query(
      `UPDATE evimed_memory.native_writer_leases SET expires_at=clock_timestamp() + ($3 || ' milliseconds')::interval WHERE user_id=$1 AND lease_id=$2 AND expires_at>clock_timestamp()`,
      [userId, leaseId, String(leaseMs)])).then(async (/** @type {any} */ result) => {
      if (result.rowCount !== 0 || lease.released) return;
      if (exclusive) lease.lost = true;
      await admit(database, userId, kind, leaseId, leaseMs).catch(() => { lease.lost = true; });
      // The operation ended while the lease was being taken again: nothing may be left behind.
      if (lease.released) await release(database, userId, leaseId).catch(() => {});
    }).catch(() => {});
  }, Math.max(1000, Math.floor(leaseMs / 4)));
  renew.unref?.();
  try {
    const scope = new Map(held.getStore() ?? []); scope.set(userId, lease);
    const value = await held.run(scope, operation);
    // An exclusive cleanup whose lease was swept and could not be re-taken cannot say that no writer ran beside it.
    if (lease.lost && exclusive) throw busy();
    return value;
  } finally {
    lease.released = true;
    clearInterval(renew);
    // A lease that cannot be deleted now expires on its own; the operation's own outcome stands.
    await release(database, userId, leaseId).catch(() => {});
  }
}
