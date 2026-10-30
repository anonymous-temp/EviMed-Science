import { HttpError } from './security.mjs';
import { RESEARCH_DB_LIMIT_DEFAULTS } from './researchDbConfig.mjs';

/**
 * Admission to the remote database, in this process: at most `slots` connections open at once
 * (`OPEN_SCIENCE_RESEARCH_DB_MAX_CONCURRENT`) and at most `perUser` of them one person's
 * (`OPEN_SCIENCE_RESEARCH_DB_MAX_PER_USER`). A refused request answers `research_db_busy` at once; nothing waits in a queue.
 *
 * The caps are per control-plane process. They were advisory locks in the control-plane database (so they held across
 * replicas), but a lock is held by a transaction, and a transaction pinned one pool connection idle for the whole of a
 * remote read (up to 30 s) -- the pool is the control plane's resource for every other request, and a remote database's
 * slowness must not be able to starve it. Two replicas therefore admit up to twice the slots; the remote database sees
 * at most `slots` x replicas readers, and each reads one short read-only transaction.
 *
 * @param {{slots?: number, perUser?: number, onRefusal?: (reason: 'busy') => void}} [limits]
 */
export function createResearchDbCapacity({ slots = RESEARCH_DB_LIMIT_DEFAULTS.slots, perUser = RESEARCH_DB_LIMIT_DEFAULTS.perUser, onRefusal = () => {} } = {}) {
  /** @type {Map<string, number>} */ const held = new Map();
  let open = 0;
  return {
    /** The connections open now, for a gauge or a test. */
    get open() { return open; },
    /** Run `operation` holding one slot, released when it ends however it ends.
     * @template T @param {string} userId @param {() => Promise<T>} operation @returns {Promise<T>} */
    async run(userId, operation) {
      if ((held.get(userId) ?? 0) >= perUser) { onRefusal('busy'); throw new HttpError(429, 'research_db_busy', 'A database snapshot is already running.'); }
      if (open >= slots) { onRefusal('busy'); throw new HttpError(429, 'research_db_busy', 'Database snapshot capacity is currently in use.'); }
      open += 1; held.set(userId, (held.get(userId) ?? 0) + 1);
      try { return await operation(); }
      finally {
        open -= 1;
        const left = (held.get(userId) ?? 1) - 1;
        if (left > 0) held.set(userId, left); else held.delete(userId);
      }
    },
  };
}
