// Public key routes -> native store -> PostgreSQL withdrawal ledger -> stub engine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { AgentApiKeyStore } from '../src/agentApiKeys.mjs';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { createMemoryGatewayHandler } from '../src/memoryGateway.mjs';
import { ResidentProfiles } from '../src/residentProfile.mjs';
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
  f.overlay.memoryForgetBody = async (id, uri, body) => history.fenceNativeBody(await contexts.forUri(id, uri), uri, body);
  history.sweepMemory = scan => f.store.sweepForgottenMemory(scan);
  const admission = createMemoryAdmission({ config, memorySettings: f.memorySettings });
  const store = { userById: async id => id === user.id ? user : null, requireProject: async (_user, id) => {
    if (id !== project.id) throw Object.assign(new Error('not found'), { status: 404 });
    return project;
  } };
  const gateway = createMemoryGatewayHandler({ config, store, sessions: f.sessions, overlay: f.overlay, admission, memoryContexts: contexts, runtimeManager: {} });
  const keys = new AgentApiKeyStore(f.database);
  const key = await keys.create(user.id, { name: 'Forget fixture', scopes: ['memory.read', 'memory.history.read', 'memory.manage'] });
  const routes = createAgentMemoryRoutes({ config, apiKeys: keys, nativeMemory: f.store, admission,
    memorySettings: f.memorySettings, capsules: { recall: async () => ({ items: [] }), active: async () => ({ items: [] }) },
    historySearch: input => recallHistoryForAgent({ config, history, admission }, input), store,
    openingContext: { resident: new ResidentProfiles({ config, store: f.memorySettings }), opening: gateway.opening } });
  const call = async (path, body, credential = key.key) => {
    const req = { url: `/api/agent-memory/v1${path}`, method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${credential}` },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    const res = { data: null, writeHead() {}, end(text) { this.data = JSON.parse(text).data; } };
    await routes(req, res); return res.data;
  };
  const status = async requestId => (await call(`/forgotten?requestId=${requestId}`)).request;
  return { ...f, context, history, call, keys, user, project, status };
}

test('public statement withdrawal fences raw history and its listed restore action restores recall', options, async t => {
  const f = await setup(t), statement = 'My old project is M-41633.';
  const archive = await f.commitConversation('api_statement', [{ role: 'user', text: statement }, { role: 'user', text: 'I prefer short answers.' }], { projectId: 'default' });
  await f.history.ingestArchive({ userId: f.userId, projectId: 'default', engineSession: archive.session, archiveUri: archive.archive_uri }, f.context);
  const recall = () => f.call('/recall', { query: 'M-41633', include: ['history'], methods: 'none' });
  assert.match(JSON.stringify(await recall()), /M-41633/);
  const result = await f.call('/forget', { statement });
  assert.equal(result.historyRejected, true); assert.equal(result.removed, false);
  assert.equal(result.historyScanPending, true); assert.equal(result.forgetStatus, 'requested');
  assert.doesNotMatch(JSON.stringify(await recall()), /M-41633/);
  await f.history.drainStatementForgets(f.store);
  assert.equal((await f.status(result.requestId)).forgetStatus, 'executed');
  const entries = (await f.call('/forgotten')).items;
  assert.equal(entries.length, 1); assert.equal(entries[0].text, statement);
  await assert.rejects(f.call(`/records/${entries[0].id}/restore`, { expectedVersion: 1 }), error => error.code === 'memory_conflict');
  assert.doesNotMatch(JSON.stringify(await recall()), /M-41633/);
  await f.call(`/records/${entries[0].id}/restore`, { expectedVersion: entries[0].restore.expectedVersion });
  assert.match(JSON.stringify(await recall()), /M-41633/);
  assert.match(await f.sessions.read(f.userId, `${archive.archive_uri}/messages.jsonl`), /short answers/);
});

const STATEMENT = '我每周五下午去打羽毛球。';
const STORED = '- 每周五下午去打羽毛球。 （用户 2026-11-21 说明）';
const NEIGHBOUR = '- 每周五下午去游泳。 （用户 2026-11-21 说明）';
const TARGET = /每周五下午去打羽毛球/;
const OTHER = /每周五下午去游泳/;

async function seedStatements(f) {
  const uri = f.seed('preferences/routine.md', '# Routine', { type: 'preferences' });
  const id = nativeFileId(uri);
  const initial = await f.store.getRecord(f.userId, id);
  const edited = await f.store.update(f.userId, id, { value: `${STORED}\n${NEIGHBOUR}`, expectedVersion: initial.version });
  const body = `${STORED}\n${NEIGHBOUR}\n- Keep the spare key in the shoe cabinet.`;
  await f.store.update(f.userId, id, { value: body, expectedVersion: edited.version });
  f.seed('profile.md', `${STORED}\n${NEIGHBOUR}`, { type: 'profile' });
  return { uri, body };
}

async function assertReads(f, targetVisible) {
  const board = await f.call('/dashboard');
  for (const value of [
    await f.call('/recall', { query: '每周五下午', methods: 'none' }),
    await f.call('/context'),
    await f.call('/records'),
    board.records,
  ]) {
    const response = JSON.stringify(value);
    assert.match(response, OTHER);
    if (targetVisible) assert.match(response, TARGET);
    else assert.doesNotMatch(response, TARGET);
  }
  if (!targetVisible) assert.doesNotMatch(JSON.stringify(board.recentChanges), TARGET);
}

test('accepted statement immediately fences all ordinary reads and only sweeps frozen copies', options, async t => {
  const f = await setup(t);
  const { uri, body } = await seedStatements(f);
  f.overlay.deferredSummaryRebuildEnabled = true;
  f.store.rejectionJudge = { same: async () => ({ same: new Map() }) };
  await assertReads(f, true);
  const accepted = await f.call('/forget', { statement: STATEMENT });
  assert.deepEqual(accepted, { removed: false, historyRejected: true, historyScanPending: true, forgetStatus: 'requested', requestId: accepted.requestId });
  assert.match(accepted.requestId, /^[a-f0-9]{32}$/);
  assert.equal((await f.call('/forget', { statement: STATEMENT })).requestId, accepted.requestId);
  assert.equal((await f.status(accepted.requestId)).forgetStatus, 'requested');
  await assertReads(f, false);
  assert.equal(await f.sessions.read(f.userId, uri), body, 'acceptance is read-only');
  const later = f.seed('preferences/late.md', STORED, { type: 'preferences' });
  await f.history.drainStatementForgets(f.store);
  assert.equal((await f.status(accepted.requestId)).forgetStatus, 'pending_verification');
  await assertReads(f, false);
  await f.history.drainForgetScans();
  assert.equal((await f.status(accepted.requestId)).forgetStatus, 'executed');
  assert.equal(await f.sessions.read(f.userId, uri), body.split('\n').slice(1).join('\n'));
  assert.equal(await f.sessions.read(f.userId, later), STORED, 'cleanup may not erase a new file outside the frozen inventory');
  await assertReads(f, false);
});

test('failed application rolls back the permanent fence and restores visibility after three attempts', options, async t => {
  const f = await setup(t);
  const { uri, body } = await seedStatements(f);
  const accepted = await f.call('/forget', { statement: STATEMENT });
  await assertReads(f, false);
  f.overlay.claimForgetIntent = async () => { throw new Error('injected permanent rejection write failure'); };
  for (const expected of ['pending_verification', 'pending_verification', 'not_executed']) {
    await f.database.query('UPDATE evimed_memory.api_statement_forgets SET next_attempt_at=clock_timestamp() WHERE id=$1', [accepted.requestId]);
    await f.history.drainStatementForgets(f.store);
    const status = await f.status(accepted.requestId);
    assert.equal(status.forgetStatus, expected);
    if (expected === 'not_executed') assert.equal(status.reason, 'statement_forget_failed');
    assert.equal(await f.sessions.read(f.userId, uri), body);
    await assertReads(f, expected === 'not_executed');
  }
  assert.deepEqual((await f.call('/forgotten')).items, []);
  await f.database.query('DELETE FROM evimed_control.users WHERE id=$1', [f.userId]);
  assert.equal((await f.database.query('SELECT id FROM evimed_memory.api_statement_forgets WHERE id=$1', [accepted.requestId])).rowCount, 0);
});

test('public exact-line forget preserves neighbours, rejects limited keys, and restores through the page path', options, async t => {
  const f = await setup(t), body = '- Use metric units.\n- Keep answers short.';
  // Seeded bytes have no producer receipt. Only newly written statements gain
  // the page edit's ordinary source scope; rewriting identical bytes cannot attest them.
  const uri = f.seed('preferences/format.md', '# Formatting', { type: 'preferences' });
  const record = await f.store.getRecord(f.userId, nativeFileId(uri));
  assert.equal(record.sourcePrivacy.classification, 'unclassified');
  await assert.rejects(f.call('/forget', { recordId: record.id }), error => error.code === 'memory_not_found');
  const edited = await f.store.update(f.userId, record.id, { value: body, expectedVersion: record.version });
  assert.equal(edited.origin, 'manual');
  assert.equal(edited.sourcePrivacy.classification, 'ordinary');
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
