// Public key routes -> native store -> PostgreSQL withdrawal ledger -> stub engine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { AgentApiKeyStore } from '../src/agentApiKeys.mjs';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { recallHistoryForAgent } from '../src/agentMemoryRecall.mjs';
import { nativeFileId } from '../src/nativeMemoryStore.mjs';
const { options, fixture } = nativeIntegration();

async function setup(t) {
  const f = await fixture(t);
  const config = { ...f.config, agentMemoryApiEnabled: true, memoryEnabled: true, memoryForgetTargetsEnabled: true, memoryHistorySearchEnabled: true };
  const user = { id: f.userId }, project = { id: 'default', userId: f.userId };
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Test',1048576)", [user.id]);
  const contexts = new GeoNativeMemoryContext({ database: f.database, documents: null, sessions: f.sessions,
    policies: { forProject: async () => ({ kind: 'owned' }), policiesForOwner: async () => [] }, settingsForOwner: id => f.memorySettings.settings(id) });
  const context = await contexts.forProject(project);
  const ledger = new MemoryHistoryLedger({ database: f.database, overlay: f.overlay, client: f.sessions.client });
  const history = new MemoryHistory({ config, ledger, contexts,
    resolveSource: async commit => ({ projectId: project.id, projectCreatedAt: context.projectCreatedAt, sessionId: commit.engineSession?.slice(4), conversationTitle: 'External API fixture' }),
    eligible: async () => true, admitMessage: async () => true });
  f.store.memoryContexts = contexts; f.store.history = history; f.store.forgetTargetsEnabled = true;
  const admission = createMemoryAdmission({ config, memorySettings: f.memorySettings });
  const keys = new AgentApiKeyStore(f.database);
  const key = await keys.create(user.id, { name: 'Forget fixture', scopes: ['memory.read', 'memory.history.read', 'memory.manage'] });
  const routes = createAgentMemoryRoutes({ config, apiKeys: keys, nativeMemory: f.store, admission,
    memorySettings: f.memorySettings, capsules: { recall: async () => ({ items: [] }), active: async () => ({ items: [] }) },
    historySearch: input => recallHistoryForAgent({ config, history, admission }, input),
    store: { userById: async id => id === user.id ? user : null, requireProject: async (_user, id) => {
      if (id !== project.id) throw Object.assign(new Error('not found'), { status: 404 });
      return project;
    } } });
  const call = async (path, body, credential = key.key) => {
    const req = { url: `/api/agent-memory/v1${path}`, method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${credential}` },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    const res = { data: null, writeHead() {}, end(text) { this.data = JSON.parse(text).data; } };
    await routes(req, res); return res.data;
  };
  return { ...f, context, history, call, keys, user, project };
}

test('public statement withdrawal fences raw history and its listed restore action restores recall', options, async t => {
  const f = await setup(t), statement = 'My old project is M-41633.';
  const archive = await f.commitConversation('api_statement', [{ role: 'user', text: statement }, { role: 'user', text: 'I prefer short answers.' }], { projectId: 'default' });
  await f.history.ingestArchive({ userId: f.userId, projectId: 'default', engineSession: archive.session, archiveUri: archive.archive_uri }, f.context);
  const recall = () => f.call('/recall', { query: 'M-41633', include: ['history'], methods: 'none' });
  assert.match(JSON.stringify(await recall()), /M-41633/);
  const result = await f.call('/forget', { statement });
  assert.equal(result.historyRejected, true); assert.equal(result.removed, false);
  assert.doesNotMatch(JSON.stringify(await recall()), /M-41633/);
  const entries = (await f.call('/forgotten')).items;
  assert.equal(entries.length, 1); assert.equal(entries[0].text, statement);
  await assert.rejects(f.call(`/records/${entries[0].id}/restore`, { expectedVersion: 1 }), error => error.code === 'memory_conflict');
  assert.doesNotMatch(JSON.stringify(await recall()), /M-41633/);
  await f.call(`/records/${entries[0].id}/restore`, { expectedVersion: entries[0].restore.expectedVersion });
  assert.match(JSON.stringify(await recall()), /M-41633/);
  assert.match(await f.sessions.read(f.userId, `${archive.archive_uri}/messages.jsonl`), /short answers/);
});

test('public exact-line forget preserves neighbours, rejects limited keys, and restores through the page path', options, async t => {
  const f = await setup(t), body = '- Use metric units.\n- Keep answers short.';
  const uri = f.seed('preferences/format.md', body, { type: 'preferences' });
  const record = await f.store.getRecord(f.userId, nativeFileId(uri));
  await f.store.update(f.userId, record.id, { value: body, expectedVersion: record.version });
  const bound = await f.keys.create(f.userId, { name: 'Bound', scopes: ['memory.manage'], projectId: 'default' });
  const readonly = await f.keys.create(f.userId, { name: 'Read', scopes: ['memory.read'] });
  for (const key of [bound, readonly]) {
    await assert.rejects(f.call('/forget', { recordId: record.id, lines: ['Use metric units.'] }, key.key), error => error.status === 403);
    assert.equal(await f.sessions.read(f.userId, uri), body);
  }
  const outcome = await f.call('/forget', { recordId: record.id, lines: ['Use metric units.'] });
  assert.equal(outcome.removedLines, 1);
  assert.equal(await f.sessions.read(f.userId, uri), '- Keep answers short.');
  const entry = (await f.call('/forgotten')).items.find(item => item.text === 'Use metric units.');
  assert.ok(entry);
  await f.call(`/records/${entry.id}/restore`, { expectedVersion: entry.version });
  assert.match(await f.sessions.read(f.userId, uri), /Use metric units/);
  assert.match(await f.sessions.read(f.userId, uri), /Keep answers short/);
});
