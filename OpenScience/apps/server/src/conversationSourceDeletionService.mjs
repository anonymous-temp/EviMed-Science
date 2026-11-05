import { randomUUID } from 'node:crypto';
import { HttpError, safeId } from './security.mjs';

const unavailable = () => new HttpError(404, 'runtime_session_not_found', 'Conversation not found.');
const sessionFields = new Set(['sessionId', 'rootSessionId', 'sourceSessionId', 'targetSessionId', 'parentSessionId', 'childSessionId', 'agentId']);

/** Native RPC identity fields, including a caller-selected id on create/fork. */
export function conversationIdsInRequest(method, payload) {
  const found = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if ((sessionFields.has(key) || key === 'id' && ['session/create', 'session/fork'].includes(method)) && typeof item === 'string') found.add(item);
      else if (key === 'sessionIds' && Array.isArray(item)) item.filter(id => typeof id === 'string').forEach(id => found.add(id));
      else if (typeof item === 'object') visit(item);
    }
  };
  visit(payload); return [...found];
}

/** Remove only deleted conversation identities. A fork's parent link does not make the fork a managed child. */
export function filterDeletedConversationValue(value, deleted) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => filterDeletedConversationValue(item, deleted)).filter(item => item !== null);
  if (value.origin === 'subagent' && deleted.has(value.parentSession)) return null;
  if ([value.sessionId, value.rootSessionId, value.agentId, value.id].some(id => typeof id === 'string' && deleted.has(id))) return null;
  if (typeof value.event === 'string' && value.event.startsWith('api-session/') && Array.isArray(value.args) && (deleted.has(value.args[0]) || deleted.has(value.args[0]?.sessionId))) return null;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (['sessionIds', 'pinned', 'archived', 'pinnedSessionIds', 'archivedSessionIds'].includes(key) && Array.isArray(item)) next[key] = item.filter(id => !deleted.has(id));
    else if (['projections', 'sessions'].includes(key) && item && typeof item === 'object' && !Array.isArray(item)) next[key] = Object.fromEntries(Object.entries(item).filter(([id]) => !deleted.has(id)).map(([id, data]) => [id, filterDeletedConversationValue(data, deleted)]));
    else next[key] = filterDeletedConversationValue(item, deleted);
  }
  return next;
}

/** Durable intent precedes source cleanup. Physical removal is an idle-only maintenance operation, never a kernel RPC. */
export class ConversationSourceDeletionService {
  constructor({ ledger, runtime, resolveProject, removeHistory, removeDerived, memoryRootFor = async (_project) => null }) {
    this.memoryRootFor = memoryRootFor;
    this.ledger = ledger; this.runtime = runtime; this.resolveProject = resolveProject;
    this.removeHistory = removeHistory; this.removeDerived = removeDerived;
    this.running = null; this.timer = null;
  }
  version(userId) { return this.ledger.version(userId); }
  hiddenMemoryUris(userId) { return this.ledger.hiddenMemoryUris(userId); }
  async assertAvailable(project, sessionId) { if (await this.ledger.get(project, sessionId)) throw unavailable(); }
  async authorize(project, method, payload) {
    for (const id of conversationIdsInRequest(method, payload)) await this.assertAvailable(project, id);
  }
  async projectValue(project, method, payload, value) {
    await this.authorize(project, method, payload);
    const deleted = new Set(await this.ledger.deletedIds(project));
    const filtered = filterDeletedConversationValue(value, deleted);
    return { forward: filtered !== null, value: filtered };
  }
  async request(project, rawSessionId) {
    const sessionId = safeId(rawSessionId, 'conversation id');
    const existing = await this.ledger.get(project, sessionId);
    if (existing) return this.publicStatus(existing);
    const identity = await this.ledger.scope(project);
    const frozen = await this.runtime.captureConversationSource({ ...project, sourceProjectCreatedAt: identity.projectCreatedAt, sourceOwnerCreatedAt: identity.accountCreatedAt }, sessionId);
    if (!frozen?.root || frozen.root.id !== sessionId || !Array.isArray(frozen.sessions) || !frozen.sessions.some(row => row.id === sessionId)) throw unavailable();
    const row = await this.ledger.put({ id: randomUUID(), userId: project.userId, projectId: project.id, ...identity,
      rootSessionId: sessionId, sessionIds: [...new Set(frozen.sessions.map(session => session.id))], frozen,
      memoryUserRoot: await this.memoryRootFor(project), cleanup: 'pending', sourceRemoved: false, createdAt: new Date().toISOString(), reason: null });
    // An index failure cannot erase the already durable source fence. The worker repeats it.
    try { await this.removeHistory(project, row); } catch { /* Cleanup remains owed. */ }
    return this.publicStatus(row);
  }
  publicStatus(row) { return { id: row.id, sessionId: row.rootSessionId, sourceRemoved: row.sourceRemoved === true, cleanup: row.cleanup, reason: row.reason ?? null }; }
  async status(project, sessionId) { const row = await this.ledger.get(project, sessionId); if (!row) throw unavailable(); return this.publicStatus(row); }
  async drain() {
    if (this.running) return this.running;
    this.running = this.drainOnce();
    try { return await this.running; } finally { this.running = null; }
  }
  async drainOnce() {
    for (const row of await this.ledger.pending()) {
      try {
        const resolved = await this.resolveProject(row);
        const project = { ...resolved, sourceProjectCreatedAt: row.projectCreatedAt, sourceOwnerCreatedAt: row.accountCreatedAt };
        await this.ledger.exclusive(project, async () => {
          const guard = () => this.ledger.assertIdentity(row);
          await guard(); await this.removeHistory(project, row);
          const result = row.sourceRemoved === true ? { sourceRemoved: true } : await this.runtime.purgeConversationSource(project, row.frozen, guard);
          if (result?.sourceRemoved !== true) { await this.ledger.update(row, { cleanup: 'pending', reason: result?.reason ?? 'runtime_busy' }); return; }
          if (Array.isArray(result.removedSessionIds) && this.ledger.extendSessions) {
            row.sessionIds = await this.ledger.extendSessions(row, result.removedSessionIds);
          }
          await guard(); await this.removeDerived(project, row);
          await this.ledger.update(row, { sourceRemoved: true, cleanup: 'complete', reason: null });
        });
      } catch { await this.ledger.update(row, { cleanup: 'pending', reason: 'cleanup_unavailable' }); }
    }
  }
  start() { if (this.timer) return; this.timer = setInterval(() => { void this.drain().catch(() => {}); }, 5000); this.timer.unref(); }
  async stop() { clearInterval(this.timer); this.timer = null; await this.running; }
}
