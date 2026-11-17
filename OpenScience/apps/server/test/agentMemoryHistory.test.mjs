import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { recallHistoryForAgent } from '../src/agentMemoryRecall.mjs';
import { MemoryHistory } from '../src/memoryHistory.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const state = { recalled: 0, searched: 0, recalledPaused: false, learningPaused: false, trial: false, reviewed: true, withdrawn: false,
    shared: false, deleted: false, changedDuringRead: false, versionReads: 0, scopes: ['memory.read', 'memory.history.read'], bound: null };
  const config = { agentMemoryApiEnabled: true, memoryHistorySearchEnabled: true, memoryHistorySecretRedactionEnabled: true };
  const user = { id: 'u' }, project = { id: 'default', userId: 'u', projectCreatedAt: '2026-01-01' };
  const settings = { configured: true, settings: async () => ({ recallPaused: state.recalledPaused, learningPaused: state.learningPaused, pausedProjects: [] }), sessionState: async () => ({ trialCapsuleId: state.trial ? 'received' : null }) };
  const context = { ownerId: 'u', ownerCreatedAt: '2026-01-01', namespaceId: 'personal', kind: 'owned', userRoot: `viking://user/u-${'a'.repeat(24)}` };
  const messages = [{ role: 'user', content: 'I use A17 sensors.', created_at: '2026-01-02T00:00:00Z' },
    { role: 'assistant', content: 'A17 is the sensor you mentioned.', created_at: '2026-01-02T00:01:00Z' }];
  const raw = messages.map(m => JSON.stringify(m)).join('\n');
  const body = JSON.stringify({ messages: messages.map((m, index) => ({ text: m.content, sourceRole: m.role, date: m.created_at, index })) });
  const root = `${context.userRoot}/resources/history/${hash(context.ownerCreatedAt).slice(0, 24)}`;
  const uri = `${root}/${hash(JSON.stringify(['default', '2026-01-01'])).slice(0, 24)}/chunk.md`;
  const meta = { project_id: 'default', project_created_at: '2026-01-01', session_id: 's1',
    archive_uri: `${context.userRoot}/sessions/dsh-s1/history/archive_001`, digest: hash(body) };
  context.sessions = { read: async () => raw };
  const history = new MemoryHistory({ config,
    contexts: { forProject: async () => ({ ...context, kind: state.shared ? 'geo-project' : 'owned' }) },
    ledger: { lookup: async () => state.deleted ? null : meta, secretReviewed: async () => state.reviewed,
      archiveSourceHash: async () => hash(raw), rejected: async () => state.withdrawn, hasWithdrawals: async () => state.withdrawn },
    resourcesFor: () => ({ searchHistory: async (_user, root) => { state.root = root; state.searched++; return [{ uri }]; }, readHistory: async () => body }),
    resolveSource: async () => ({ projectId: 'default', projectCreatedAt: '2026-01-01', sessionId: 's1', conversationTitle: 'Sensors', conversationUrl: '/app/chat/s1' }),
    eligible: async () => true,
  });
  history.secrets.filterFor = async () => text => text;
  const admission = createMemoryAdmission({ config, memorySettings: settings, conversations: { running: async () => [{ id: "run", sessionId: "s1" }], runsOf: async () => [] } });
  const routes = createAgentMemoryRoutes({ config,
    apiKeys: { resolve: async () => ({ userId: user.id, keyId: 'key', scopes: state.scopes, projectId: state.bound }) },
    store: { userById: async () => user, requireProject: async (_user, id) => {
      if (id !== 'default') throw Object.assign(new Error('Unknown project'), { status: 404 });
      return project;
    } },
    memorySettings: settings, capsules: { recall: async () => ({ items: [] }), active: async () => ({ items: [] }) },
    nativeMemory: { configured: true, search: async () => { state.recalled++; return { items: [{ id: 'memory', scope: 'user', status: 'active', kind: 'preference', value: 'Use A17.' }] }; } },
    historySearch: async input => {
      return recallHistoryForAgent({ config, history, admission,
        sourceDeletion: { version: async () => state.changedDuringRead ? state.versionReads++ : 0 } }, input);
    },
  });
  async function recall(body = {}) {
    const req = { url: '/api/agent-memory/v1/recall', method: 'POST', headers: { authorization: 'Bearer valid' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ query: 'A17', methods: 'none', ...body })); } };
    const res = { data: null, writeHead() {}, end(value) { this.data = JSON.parse(value).data; } };
    await routes(req, res); return res.data;
  }
  async function status() {
    const res = { data: null, writeHead() {}, end(value) { this.data = JSON.parse(value).data; } };
    await routes({ url: '/api/agent-memory/v1', method: 'GET', headers: { authorization: 'Bearer valid' } }, res);
    return res.data;
  }
  return { state, recall, history, user, project, status, config };
}

test('history is opt-in, scope-gated and preserves conversation, role and date attribution', async () => {
  const { state, recall } = fixture();
  const ordinary = await recall();
  assert.equal(ordinary.history, undefined); assert.equal(state.searched, 0); assert.equal(ordinary.items[0].id, 'memory');
  state.scopes = ['memory.read'];
  await assert.rejects(recall({ include: ['history'] }), error => error.code === 'agent_key_scope_denied');
  assert.equal(state.searched, 0);
  state.scopes.push('memory.history.read');
  const result = await recall({ include: ['history'] });
  assert.equal(result.items[0].id, 'memory');
  assert.equal(result.history[0].sessionId, 's1'); assert.equal(result.history[0].conversationTitle, 'Sensors');
  assert.deepEqual(result.history[0].messages.map(m => m.sourceRole), ['user', 'assistant']);
  assert.equal(result.history[0].messages[0].date, '2026-01-02T00:00:00.000Z');
  assert.equal(result.history[0].contextOnly, true); assert.equal(result.history[0].confirmed, false);
});

test('public history preserves withdrawal, deletion, review, shared namespace and pause fences without dropping safe records', async () => {
  for (const [field, value] of [['reviewed', false], ['withdrawn', true], ['shared', true], ['deleted', true], ['recalledPaused', true], ['trial', true]]) {
    const { state, recall } = fixture();
    state[field] = value;
    const result = await recall({ include: ['history'] });
    assert.ok(result.history.every(hit => hit.withdrawn === true), field);
    assert.doesNotMatch(JSON.stringify(result.history), /sensors|Sensors|s1/);
    // These fences are history-specific; an unrelated safe stored memory remains useful.
    if (field !== 'recalledPaused') assert.equal(result.items[0].id, 'memory', field);
    state[field] = !value;
    assert.equal((await recall({ include: ['history'] })).history[0].sessionId, 's1', field);
  }
  const { state, recall } = fixture(); state.learningPaused = true;
  assert.equal((await recall({ include: ['history'] })).history[0].sessionId, 's1', 'learning pause is not recall pause');
});

test('project scope is checked before any history read and cannot be widened by omitting the project', async () => {
  const { state, recall } = fixture();
  await assert.rejects(recall({ include: ['history'], projectId: 'foreign' }), error => error.status === 404);
  assert.equal(state.searched, 0);
  state.bound = 'default';
  await assert.rejects(recall({ include: ['history'], projectId: 'foreign' }), error => error.code === 'agent_key_project_denied');
  assert.equal(state.searched, 0);
  assert.equal((await recall({ include: ['history'] })).history[0].sessionId, 's1');
  assert.ok(state.root.endsWith(hash(JSON.stringify(['default', '2026-01-01'])).slice(0, 24)), 'a key bound to default searches only that project');
  state.bound = null;
  await recall({ include: ['history'] });
  assert.ok(state.root.endsWith(hash('2026-01-01').slice(0, 24)), 'unbound default recall can search the owned account namespace');
});


test('a source deletion racing public history assembly refuses the response rather than returning stale fragments', async () => {
  const { state, recall } = fixture();
  state.changedDuringRead = true;
  await assert.rejects(recall({ include: ['history'] }), error => error.code === 'memory_gateway_source_changed');
  state.changedDuringRead = false;
  assert.equal((await recall({ include: ['history'] })).history[0].sessionId, 's1');
});


test('history capability reflects the actual scope and switch, and an unavailable extension leaves ordinary recall intact', async () => {
  const { state, status, recall, config } = fixture();
  assert.equal((await status()).capabilities.rawConversationRecall.available, true);
  state.scopes = ['memory.read'];
  assert.equal((await status()).capabilities.rawConversationRecall.available, false);
  state.scopes.push('memory.history.read'); config.memoryHistorySearchEnabled = false;
  assert.equal((await status()).capabilities.rawConversationRecall.available, false);
  await assert.rejects(recall({ include: ['history'] }), error => error.code === 'memory_engine_unavailable');
  assert.equal((await recall()).items[0].id, 'memory');
  for (const include of ['history', ['history', 'history'], ['all'], [null]]) {
    await assert.rejects(recall({ include }), error => error.code === 'agent_memory_payload_invalid');
  }
});
