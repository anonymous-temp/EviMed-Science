import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { loadConfig } from '../src/config.mjs';
import { PostgresStore } from '../src/store.mjs';
import { AgentRunStore } from '../src/agentRuns.mjs';
import { normalizeTranscript } from '../src/dshRuntimeAdapter.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { createMemoryGatewayHandler } from '../src/memoryGateway.mjs';
import { createMemoryHistorySources } from '../src/memoryHistorySources.mjs';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { ConversationSourceDeletionLedger } from '../src/conversationSourceDeletionPersistence.mjs';

const isolated = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL
  ? await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'historysources') : null;
const { options, fixture } = nativeIntegration({ databaseUrl: isolated?.url ?? '' });
after(async () => { await isolated?.drop(); });
const nativeFrames = JSON.parse(await readFile(new URL('./fixtures/dsh/native-turn-frames.json', import.meta.url), 'utf8'));

async function setup(t) {
  const f = await fixture(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'history-sources-'));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, databasePoolMax: 2,
    memoryEngineEnabled: true, memoryEnabled: true, memoryHistorySearchEnabled: true });
  const accounts = new PostgresStore(config);
  t.after(async () => { await accounts.database.close(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await accounts.userById(f.userId);
  await accounts.defaultProject(user);
  await accounts.createProject(user, 'named', 'Named project');
  const documents = new ProductDocuments(f.database);
  const policies = new GeoSharedContext({ database: f.database, documents });
  const contexts = new GeoNativeMemoryContext({ database: f.database, documents, policies, sessions: f.sessions });
  const agentRuns = new AgentRunStore({ get: async () => null }, { model: 'deepseek/deepseek-v4-pro' });
  agentRuns.scheduleMonitor = () => {};
  const deletion = new ConversationSourceDeletionLedger(f.database);
  const admission = createMemoryAdmission({ config, memorySettings: f.memorySettings,
    conversations: { running: p => agentRuns.activeRuns(p), runsOf: (p, id) => agentRuns.conversationRuns(p, id) },
    sourceDeleted: async (p, id) => Boolean(id && await deletion.get(p, id)),
  });
  const sources = createMemoryHistorySources({ config, store: accounts, productDatabase: f.database,
    nativeMemoryContexts: contexts, nativeMemoryOverlay: f.overlay, agentRuns, memorySettings: f.memorySettings,
    agentRegistry: Promise.resolve(new Map()), vcrPrivacyStore: null, memoryAdmission: admission });
  const ledger = new MemoryHistoryLedger({ database: f.database, overlay: f.overlay });
  const files = new Map();
  const resources = {
    async writeHistory(_owner, uri, text) { files.set(uri, text); },
    async readHistory(_owner, uri) { return files.get(uri) ?? null; },
    async searchHistory(_owner, root) { return [...files.keys()].filter(uri => uri.startsWith(`${root}/`)).map(uri => ({ uri })); },
    async removeSource(_owner, uri) { files.delete(uri); },
  };
  ledger.removeResource = row => resources.removeSource(row.owner_id, row.uri);
  const history = new MemoryHistory({ config, ledger, contexts, ...sources, resourcesFor: () => resources });
  f.worker.history = history;
  f.worker.memoryContexts = contexts;
  const projects = [];
  t.after(async () => { for (const project of projects) await agentRuns.closeProject(project); });

  async function conversation(projectId, name, { gateway = true, automated = false } = {}) {
    const project = await accounts.requireProject(user, projectId);
    projects.push(project);
    const sessionId = `session_${name}`, engineSession = `dsh-${sessionId}`;
    // Exercise the composer's native adoption, rather than seeding an invented run row.
    const events = structuredClone(nativeFrames.events);
    const now = Date.now();
    for (const event of events) event.time = now + event.seq;
    if (automated) events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user').data.source = { kind: 'schedule' };
    await agentRuns.adoptRuntimeTurns(project, sessionId, normalizeTranscript(sessionId, events));
    const runs = await agentRuns.conversationRuns(project, sessionId);
    assert.ok(runs.length);
    if (!automated) assert.ok(runs.every(run => run.automated !== true));
    else assert.ok(runs.some(run => run.automated === true));
    const excerpt = `Original retained history for ${name}.`;
    let archiveUri;
    if (gateway) {
      // The real gateway writes native_sessions and the commit's source project stamp.
      const handler = createMemoryGatewayHandler({ config, sessions: f.sessions, overlay: f.overlay,
        store: accounts, memoryContexts: contexts, admission,
        runtimeManager: { assertActiveEviMedWorkloadToken: async () => ({ userId: f.userId, projectId }) } });
      const server = createServer((req, res) => { void handler(req, res); });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      try {
        const post = async (endpoint, body) => {
          const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/memory/v1/api/v1/${endpoint}`, {
            method: 'POST', headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          const answer = await response.json(); assert.equal(response.status, 200, JSON.stringify(answer)); return answer;
        };
        await post('sessions', { session_id: engineSession });
        await post(`sessions/${engineSession}/messages`, { role: 'user', content: excerpt, created_at: new Date(now).toISOString() });
        archiveUri = (await post(`sessions/${engineSession}/commit`, {})).result.archive_uri;
        assert.ok(archiveUri);
        assert.equal((await f.database.query('SELECT project_id FROM evimed_memory.native_sessions WHERE user_id=$1 AND engine_session=$2', [f.userId, engineSession])).rows[0]?.project_id, projectId);
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    } else {
      const archive = await f.commitConversation(name, [{ role: 'user', text: excerpt, at: new Date(now).toISOString() }], { projectId });
      archiveUri = archive.archive_uri;
    }
    return { project, sessionId, engineSession, archiveUri, excerpt };
  }
  const rows = async () => (await f.database.query('SELECT * FROM evimed_memory.history_archives WHERE owner_id=$1 ORDER BY commit_created_at,archive_uri', [f.userId])).rows;
  const search = async projectId => history.search({ user, project: await accounts.requireProject(user, projectId), query: 'retained' });
  return { ...f, accounts, user, contexts, history, sources, ledger, files, conversation, rows, search, deletion, admission };
}

test('server history wiring indexes attended composer conversations in default and named projects', options, async t => {
  const f = await setup(t);
  const a = await f.conversation('default', 'ordinary');
  const b = await f.conversation('named', 'named');
  const workerContext = await f.contexts.forUri(f.userId, a.archiveUri);
  assert.equal(workerContext.projectCreatedAt, null, 'the real worker starts with an account context');
  await assert.rejects(f.contexts.assertLive({ ...workerContext, projectId: 'default' }), { code: 'memory_scope_denied' });
  assert.equal(await f.worker.processCommits({ userId: f.userId }), 2);
  assert.deepEqual((await f.rows()).map(row => row.state), ['complete', 'complete']);
  assert.ok(f.files.size >= 2);
  const chunks = await f.database.query('SELECT uri FROM evimed_memory.history_chunks WHERE owner_id=$1 AND state=\'ready\'', [f.userId]);
  assert.ok(chunks.rows.length >= 2);
  const global = await f.search('default');
  for (const c of [a, b]) assert.ok(global.some(hit => hit.sessionId === c.sessionId && hit.messages.some(m => m.text === c.excerpt)));
  assert.deepEqual([...new Set((await f.search('named')).map(hit => hit.sessionId))], [b.sessionId]);
});

test('a worker pass recovers index-unavailable archives without rerunning native extraction', options, async t => {
  const f = await setup(t);
  const c = await f.conversation('default', 'recovery');
  const lookup = f.accounts.userById.bind(f.accounts);
  f.accounts.userById = async () => { throw new Error('temporary source lookup outage'); };
  await f.worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.commit(f.userId, c.archiveUri)).state, 'completed');
  assert.equal((await f.rows())[0].state, 'unavailable');
  assert.equal((await f.rows())[0].reason, 'memory_history_index_unavailable');
  f.accounts.userById = lookup;
  await f.worker.pass();
  assert.equal((await f.rows())[0].state, 'unavailable', 'backoff is respected');
  await f.database.query("UPDATE evimed_memory.history_archives SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1", [f.userId]);
  await f.worker.pass();
  assert.equal((await f.rows())[0].state, 'complete');
  assert.equal((await f.rows())[0].attempts, 1);
  assert.ok((await f.search('default')).some(hit => hit.messages.some(m => m.text === c.excerpt)));
});

test('recovery is bounded to four due archives, oldest first, and stops after eight failed retries', options, async t => {
  const f = await setup(t);
  const conversations = [];
  for (let i = 0; i < 6; i++) conversations.push(await f.conversation('default', `ordered${i}`, { gateway: false }));
  const lookup = f.accounts.userById.bind(f.accounts);
  f.accounts.userById = async () => { throw new Error('source unavailable'); };
  await f.worker.processCommits({ userId: f.userId });
  for (const [i, c] of conversations.entries()) {
    await f.database.query(`UPDATE evimed_memory.history_archives SET next_attempt_at=clock_timestamp()-($3::int*interval '1 minute')
      WHERE owner_id=$1 AND archive_uri=$2`, [f.userId, c.archiveUri, i + 1]);
  }
  f.accounts.userById = lookup;
  await f.worker.pass();
  assert.deepEqual((await f.rows()).map(row => row.state), ['complete', 'complete', 'complete', 'complete', 'unavailable', 'unavailable']);
  // Reaching the last allowed attempt retains the unavailable row and its reason,
  // but neither a later clock nor another worker pass restarts it indefinitely.
  await f.database.query("UPDATE evimed_memory.history_archives SET attempts=7 WHERE owner_id=$1 AND state='unavailable'", [f.userId]);
  f.accounts.userById = async () => { throw new Error('still unavailable'); };
  await f.worker.pass();
  const exhausted = (await f.rows()).filter(row => row.state === 'unavailable');
  assert.deepEqual(exhausted.map(row => row.attempts), [8, 8]);
  assert.ok(exhausted.every(row => row.reason === 'memory_history_index_unavailable'));
  assert.ok(exhausted.every(row => new Date(row.next_attempt_at).getTime() > Date.now() + 6 * 86400_000));
  f.accounts.userById = lookup;
  await f.database.query("UPDATE evimed_memory.history_archives SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1", [f.userId]);
  await f.worker.pass();
  assert.deepEqual((await f.rows()).filter(row => row.state === 'unavailable').map(row => row.attempts), [8, 8]);
});

test('pre-fix index-unavailable rows recover even if the broken lookup exhausted their old attempts', options, async t => {
  const f = await setup(t);
  const c = await f.conversation('default', 'pre_release', { gateway: false });
  const lookup = f.accounts.userById.bind(f.accounts);
  f.accounts.userById = async () => { throw new Error('old broken lookup'); };
  await f.worker.processCommits({ userId: f.userId });
  await f.database.query(`UPDATE evimed_memory.history_archives SET source_lookup_version=0,attempts=20,
    next_attempt_at=clock_timestamp()+interval '7 days' WHERE owner_id=$1`, [f.userId]);
  f.accounts.userById = lookup;
  await f.worker.pass();
  const row = (await f.rows())[0];
  assert.equal(row.state, 'complete');
  assert.equal(row.attempts, 1);
  assert.equal(row.source_lookup_version, 1);
  assert.ok((await f.search('default')).some(hit => hit.messages.some(m => m.text === c.excerpt)));
});

test('real source wiring keeps automated, internal, deleted and pre-reset history refused during recovery', options, async t => {
  for (const boundary of ['automated', 'internal', 'deleted-project', 'before-reset', 'deleted-source']) {
    await t.test(boundary, async t => {
      const f = await setup(t);
      const projectId = boundary === 'internal' ? 'evimed-learning' : 'named';
      if (boundary === 'internal') await f.accounts.createProject(f.user, projectId);
      const c = await f.conversation(projectId, 'boundary', { gateway: false, automated: boundary === 'automated' });
      f.history.config.memoryHistorySearchEnabled = false;
      await f.worker.processCommits({ userId: f.userId });
      assert.equal((await f.overlay.commit(f.userId, c.archiveUri)).state, 'completed');
      if (boundary === 'deleted-project') await f.accounts.deleteProject(f.user, projectId);
      if (boundary === 'before-reset') await f.memorySettings.noteReset(f.userId);
      if (boundary === 'deleted-source') {
        const context = await f.contexts.forProject(c.project);
        await f.deletion.put({ id: crypto.randomUUID(), userId: f.userId, accountCreatedAt: context.ownerCreatedAt,
          projectId, projectCreatedAt: context.projectCreatedAt, rootSessionId: c.sessionId, sessionIds: [c.sessionId],
          frozen: { root: { id: c.sessionId } }, memoryUserRoot: context.userRoot });
      }
      if (['before-reset', 'deleted-source'].includes(boundary)) {
        const admitted = await f.admission.admit({ user: f.user, project: c.project, engineSessionId: c.engineSession,
          at: boundary === 'before-reset' ? Date.parse(await f.memorySettings.resetInstant(f.userId)) - 1 : null });
        assert.equal(admitted.learnReason, boundary === 'before-reset' ? 'before_reset' : 'source_deleted');
      }
      f.history.config.memoryHistorySearchEnabled = true;
      await f.worker.pass();
      assert.equal(f.files.size, 0);
      assert.equal((await f.database.query("SELECT count(*)::int AS n FROM evimed_memory.history_chunks WHERE owner_id=$1 AND state='ready'", [f.userId])).rows[0].n, 0);
      assert.notEqual((await f.rows())[0]?.state, 'complete');
      assert.deepEqual(await f.search('default'), []);
    });
  }
});

test('a stale project context and an archive from a replaced project keep their original incarnation boundary', options, async t => {
  const f = await setup(t);
  const c = await f.conversation('named', 'old', { gateway: false });
  const context = await f.contexts.forProject(c.project);
  await f.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id='named'", [f.userId]);
  await assert.rejects(f.sources.resolveSource({ projectId: 'named', engineSession: c.engineSession }, context), { code: 'memory_scope_denied' });
  await f.worker.processCommits({ userId: f.userId });
  assert.deepEqual((await f.rows()).map(row => [row.state, row.reason]), [['withdrawn', 'project_incarnation_changed']]);
  assert.equal(f.files.size, 0);
});

test('legacy commits can prove their project without native_sessions, but missing run provenance stays excluded', options, async t => {
  const f = await setup(t);
  const c = await f.conversation('default', 'legacy', { gateway: false });
  await f.commitConversation('unproven', [{ role: 'user', text: 'No first-party conversation ledger.' }], { projectId: 'default' });
  await f.worker.processCommits({ userId: f.userId });
  assert.deepEqual((await f.rows()).map(row => [row.state, row.reason]), [['complete', ''], ['excluded', 'memory_history_source_unproven']]);
  assert.ok((await f.search('default')).some(hit => hit.messages.some(m => m.text === c.excerpt)));
});
