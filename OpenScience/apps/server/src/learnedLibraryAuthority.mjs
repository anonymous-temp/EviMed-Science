/** Serialize a library's conflict reads and visibility writes, across service
 * instances and processes. No model call belongs inside this authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from './security.mjs';

const owners = new AsyncLocalStorage(), frames = new AsyncLocalStorage();
const memoryQueues = new WeakMap();
const conflict = () => new HttpError(409, 'product_revision_conflict', 'The learned library changed; retry this operation.');
const ownerOf = documents => documents.database ?? documents;

async function runFrame(operation) {
  const frame = { open: true, serial: Promise.resolve() };
  try { return await frames.run(frame, operation); }
  finally { frame.open = false; await frame.serial; }
}
function nested(scope, operation) {
  const holder = frames.getStore() ?? scope;
  if (!holder.open) throw conflict();
  const pending = holder.serial.catch(() => {}).then(() => runFrame(operation));
  holder.serial = pending.then(() => undefined, () => undefined);
  return pending;
}

/** @param {any} documents @param {string} userId @param {()=>Promise<any>} operation
 * @param {{transactionClient?:any}} [options] */
export async function withLearnedLibrary(documents, userId, operation, { transactionClient = null } = {}) {
  const key = ownerOf(documents), database = documents.database;
  if (transactionClient) {
    if (!database?.withTransactionClient) throw conflict();
    return database.withTransactionClient(transactionClient, () => withLearnedLibrary(documents, userId, operation));
  }
  const inherited = owners.getStore();
  if (inherited?.key === key && inherited.userId === userId) {
    if (!inherited.open) throw conflict();
    return nested(inherited, operation);
  }
  // Crossing to another owner/client while holding this library can invert
  // lock order. Admit that work independently after the current operation.
  if (inherited) throw conflict();
  const scope = { key, userId, open: true, serial: Promise.resolve(), observers: [] };
  if (database?.query) {
    if (!database.transaction || !database.withTransactionClient || !database.afterCommit) throw conflict();
    // Standalone admission waits before touching rows. An enclosing operation
    // may already hold rows in another order: try rather than wait in that case.
    const borrowed = Boolean(database.transactionScope?.());
    try {
      return await database.transaction(client => database.withTransactionClient(client, async () => {
        const name = `evimed-learned-library:${userId}`;
        if (borrowed) {
          const result = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [name]);
          if (result.rows[0]?.locked !== true) throw conflict();
        } else await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [name]);
        return owners.run(scope, () => runFrame(operation));
      }));
    } finally { scope.open = false; }
  }
  // In-memory document stores have the same per-owner serialization, shared
  // across LearningService instances. They never represent durable SaaS state.
  let queue = memoryQueues.get(key); if (!queue) { queue = new Map(); memoryQueues.set(key, queue); }
  const previous = queue.get(userId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const result = await owners.run(scope, () => runFrame(operation));
    scope.open = false;
    for (const observer of scope.observers) try { await owners.run(undefined, () => frames.run(undefined, observer)); } catch { /* observers own their failure */ }
    return result;
  });
  queue.set(userId, current);
  try { return await current; }
  finally { scope.open = false; if (queue.get(userId) === current) queue.delete(userId); }
}

/** @param {any} documents @param {string} userId @param {()=>unknown} observer */
export function deferLearnedLibraryObserver(documents, userId, observer) {
  const frame = frames.getStore();
  if (frame && !frame.open) throw conflict();
  if (documents.database?.afterCommit?.(observer)) return true;
  const scope = owners.getStore();
  if (!scope?.open || scope.key !== ownerOf(documents) || scope.userId !== userId) return false;
  scope.observers.push(observer); return true;
}
