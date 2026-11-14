import { containsRemoved, removalLines, removalText } from './nativeMemoryRejections.mjs';
import { lineFingerprint } from './nativeMemoryOverlay.mjs';
import { HttpError } from './security.mjs';
import { withNativeMemoryWrite } from './nativeMemoryWriteFence.mjs';

/** Engine-owned sidecars, never memory records or opening-profile material. */
export const MEMORY_SUMMARY_NAMES = Object.freeze(['.overview.md', '.abstract.md']);

/** @param {string} uri */
export function isMemorySummary(uri) {
  let name = uri.slice(uri.lastIndexOf('/') + 1);
  try { name = decodeURIComponent(name); } catch { /* Invalid URI handling belongs to the gateway's scope check. */ }
  return MEMORY_SUMMARY_NAMES.includes(name);
}

/** Bottom-up directory chain, bounded by this namespace's memory root.
 * @param {string} uri @param {string} root @returns {string[]} */
export function memorySummaryDirectories(uri, root) {
  if ((uri !== root && !uri.startsWith(`${root}/`)) || uri.split('/').some(part => part === '..' || part === '.')) {
    throw new HttpError(403, 'memory_scope_denied', 'The summary target is outside native memories.');
  }
  const directories = [];
  let directory = uri === root ? root : uri.slice(0, uri.lastIndexOf('/'));
  while (directory === root || directory.startsWith(`${root}/`)) {
    directories.push(directory);
    directory = directory.slice(0, directory.lastIndexOf('/'));
  }
  return directories;
}

/** Delete all old sidecars before rebuilding any parent from its remaining children.
 * A semantic reindex is native v0.5.3 maintenance; ensure_directory_index preserves stale text.
 * @param {any} sessions @param {string} userId @param {readonly string[]} directories */
async function rebuild(sessions, userId, directories) {
  for (const directory of directories) {
    for (const name of MEMORY_SUMMARY_NAMES) await sessions.remove(userId, `${directory}/${name}`, { wait: true });
  }
  for (const directory of directories) await sessions.rebuildMemoryDirectory(userId, directory);
}

/**
 * Every destructive memory mutation queues its ancestor chain BEFORE touching the engine.
 * The account worker retries that same ticket after a crash, under an exclusive writer lease.
 * Independent durable tickets survive a caller's rolled-back transaction; generation checks
 * prevent one concurrent writer from acknowledging another writer's cleanup.
 * @template T
 * @param {any} sessions @param {any} overlay @param {string} userId @param {string} uri
 * @param {() => Promise<T>} operation
 * @param {(() => Promise<void>) | null} [afterMutation]
 * @returns {Promise<T>}
 */
export async function withMemorySummaryInvalidation(sessions, overlay, userId, uri, operation, afterMutation = null) {
  return withNativeMemoryWrite(overlay.database, userId, async () => {
    const directories = memorySummaryDirectories(uri, sessions.memoryRoot(userId));
    const tickets = await overlay.queueSummaryInvalidation(userId, directories);
    const result = await operation();
    if (afterMutation) await afterMutation();
    if (overlay.deferredSummaryRebuildEnabled === true) {
      // Removal is durable; withdraw derived text now, keeping the existing
      // generation ticket for the exclusive worker's bottom-up rebuild.
      for (const directory of directories) {
        for (const name of MEMORY_SUMMARY_NAMES) await sessions.remove(userId, `${directory}/${name}`, { wait: true });
      }
      return result;
    }
    await rebuild(sessions, userId, directories);
    await overlay.completeSummaryInvalidation(userId, tickets);
    return result;
  });
}

/** Worker and source-deletion retries acquire the account's exclusive native writer lease.
 * @param {any} sessions @param {any} overlay @param {string} userId
 * @param {((uri: string) => Promise<any>) | null} [sessionsForUri] */
export async function drainMemorySummaryInvalidations(sessions, overlay, userId, sessionsForUri = null) {
  return withNativeMemoryWrite(overlay.database, userId, () => drain(sessions, overlay, userId, sessionsForUri), { exclusive: true });
}

/** @param {any} sessions @param {any} overlay @param {string} userId @param {any} sessionsForUri */
async function drain(sessions, overlay, userId, sessionsForUri) {
  const tickets = await overlay.pendingSummaryInvalidations(userId);
  const groups = new Map();
  for (const ticket of tickets) {
    const view = sessionsForUri ? await sessionsForUri(ticket.directory) : sessions;
    const root = view.memoryRoot(userId);
    memorySummaryDirectories(ticket.directory, root);
    if (!groups.has(root)) groups.set(root, { sessions: view, tickets: [] });
    groups.get(root).tickets.push(ticket);
  }
  for (const group of groups.values()) {
    const directories = group.tickets.map(ticket => ticket.directory).sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
    await rebuild(group.sessions, userId, directories);
    await overlay.completeSummaryInvalidation(userId, group.tickets);
  }
  return tickets.length;
}


/** An extraction accepted before a forget can still finish in the engine.
 * Only the settled overlay may reauthorize literal withdrawn text; new unrelated
 * lines remain visible. Cleanup uses raw reads and therefore still sees the work
 * it owes. This never calls a model or interprets a paraphrase.
 * @param {import('./nativeMemoryOverlay.mjs').NativeMemoryOverlay | null} overlay
 * @param {string} userId @param {string} uri @param {string|null} body
 * @param {string|null} [namespaceId] @returns {Promise<string|null>}
 */
export async function fenceWithdrawnMemoryBody(overlay, userId, uri, body, namespaceId = null) {
  if (overlay?.memoryForgetBody) return overlay.memoryForgetBody(userId, uri, body, namespaceId);
  if (overlay?.deferredSummaryRebuildEnabled !== true || body === null) return body;
  const removed = await overlay.removals(userId, namespaceId);
  if (!removed.length) return body;
  const known = await overlay.file(userId, uri);
  const admitted = new Set(removalLines(known?.body ?? '').map(lineFingerprint));
  let changed = false;
  const kept = body.split('\n').filter(line => {
    const text = removalText(line), fingerprint = lineFingerprint(text);
    if (admitted.has(fingerprint)) return true;
    const withdrawn = removed.some(row => row.fingerprint === fingerprint || row.text && containsRemoved(text, row.text));
    if (withdrawn) changed = true;
    return !withdrawn;
  }).join('\n');
  return changed && !removalLines(kept).length ? null : kept;
}
