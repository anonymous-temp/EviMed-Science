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
 * Admission and release are each one short transaction under a short advisory lock; the operation runs with nothing held.
 * A lease that was never released (a crashed process) stops counting when it expires.
 */
export const NATIVE_WRITER_LEASE_MS = 15 * 60_000;
const held = new AsyncLocalStorage();

/** @param {any} database @param {string} userId @param {'shared'|'exclusive'} kind @param {string} leaseId @param {number} ttlMs */
async function admit(database, userId, kind, leaseId, ttlMs) {
  await migrateMemorySettings(database); await migrateNativeMemory(database);
  await database.withoutTransactionClient(() => database.transaction(async (/** @type {any} */ client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`native-memory-writer:${userId}`]);
    await client.query('DELETE FROM evimed_memory.native_writer_leases WHERE user_id=$1 AND expires_at<=clock_timestamp()', [userId]);
    const blocking = await client.query(
      `SELECT 1 FROM evimed_memory.native_writer_leases WHERE user_id=$1 AND ($2='exclusive' OR kind='exclusive') LIMIT 1`, [userId, kind]);
    if (blocking.rows.length) throw new HttpError(409, 'memory_source_cleanup_busy', 'Native memory is being updated. Retry shortly.');
    await client.query(
      `INSERT INTO evimed_memory.native_writer_leases (user_id, lease_id, kind, expires_at) VALUES ($1,$2,$3, clock_timestamp() + ($4 || ' milliseconds')::interval)`,
      [userId, leaseId, kind, String(ttlMs)]);
  }));
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
  // A write inside a write of the same account (the gateway's commit calling the engine client) is one holder.
  if (held.getStore()?.get(userId)) return operation();
  const leaseId = randomUUID();
  await admit(database, userId, exclusive ? 'exclusive' : 'shared', leaseId, leaseMs);
  // A long operation renews its lease so that it never reads as crashed; a failed renewal only means the next one tries again.
  const renew = setInterval(() => {
    database.withoutTransactionClient(() => database.query(
      `UPDATE evimed_memory.native_writer_leases SET expires_at=clock_timestamp() + ($3 || ' milliseconds')::interval WHERE user_id=$1 AND lease_id=$2`,
      [userId, leaseId, String(leaseMs)])).catch(() => {});
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  renew.unref?.();
  try {
    const scope = new Map(held.getStore() ?? []); scope.set(userId, leaseId);
    return await held.run(scope, operation);
  } finally {
    clearInterval(renew);
    // A lease that cannot be deleted now expires on its own; the operation's own outcome stands.
    await release(database, userId, leaseId).catch(() => {});
  }
}
