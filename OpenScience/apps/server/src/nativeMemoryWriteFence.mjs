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
    return operation();
  }
  const leaseId = randomUUID();
  await admit(database, userId, kind, leaseId, leaseMs);
  /** @type {Lease} */
  const lease = { id: leaseId, userId, kind, released: false, lost: false };
  // A long operation renews its lease so that it never reads as crashed. A renewal that finds no row was swept (it expired while this
  // process could not reach the database): the lease is re-admitted under the same rules, and flagged lost when that is refused.
  const renew = setInterval(() => {
    void database.withoutTransactionClient(() => database.query(
      `UPDATE evimed_memory.native_writer_leases SET expires_at=clock_timestamp() + ($3 || ' milliseconds')::interval WHERE user_id=$1 AND lease_id=$2`,
      [userId, leaseId, String(leaseMs)])).then(async (/** @type {any} */ result) => {
      if (result.rowCount === 0 && !lease.released) await admit(database, userId, kind, leaseId, leaseMs).catch(() => { lease.lost = true; });
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
