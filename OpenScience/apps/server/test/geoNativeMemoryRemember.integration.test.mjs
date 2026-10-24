import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { GeoNativeMemoryRemember } from '../src/geoNativeMemoryRemember.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
const messages = [{ role: 'user', content: 'Remember that this project uses millimetres.' }];
async function fixture(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'georemember');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-remember-'));
  const accounts = new PostgresStore(loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', databasePoolMax: 1 }));
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  await accounts.createUser('owner', 'fixture-password', 'Owner');
  const owner = await accounts.userById('owner'), project = await accounts.requireProject(owner, 'default');
  const geo = new GeoStore({ database: accounts.database }); await geo.ready();
  await geo.createProject({ userId: owner.id, projectId: project.id, engines: ['deepseek'], coverageDays: 30 });
  const documents = new ProductDocuments(accounts.database), policies = new GeoSharedContext({ database: accounts.database, documents });
  const sent = [], commits = [], sessionIds = new Map();
  let mode = 'completed', beforeMcp = async () => {}, ledgerFails = false;
  const sessions = new OpenVikingSessions({ configured: true, account: 'fixture', request: async input => {
    sent.push(input);
    const root = `viking://user/${input.openVikingUser}`;
    if (input.path === '/mcp') {
      const number = sent.filter(row => row.path === '/mcp').length;
      await beforeMcp();
      if (mode === 'lost') throw new Error('Response lost after engine accepted');
      const session = `mcp-store-fixture${number}`, task = `task-fixture-${number}`;
      sessionIds.set(task, session);
      const text = `Submitted 1 message(s) for memory extraction (session ${session}, task_id=${task}). Extraction runs in the background and decides which memories to create or update.`;
      const result = mode === 'error' ? { isError: true, content: [{ type: 'text', text: 'Refused' }] }
        : { isError: false, content: [{ type: 'text', text: mode === 'malformed' ? `${text} ${text}` : text }] };
      return { status: 200, contentType: 'text/event-stream', text: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: input.body.id, result })}\n\n` };
    }
    if (input.path.startsWith('/api/v1/sessions/')) {
      const session = input.path.split('/').at(-1);
      return { status: 'ok', result: { session_id: session, uri: `${root}/sessions/${session}`,
        user: { account_id: 'fixture', user_id: mode === 'foreign-session' ? 'foreign' : input.openVikingUser } } };
    }
    if (input.path.startsWith('/api/v1/tasks/')) {
      const task = input.path.split('/').at(-1), session = sessionIds.get(task);
      return { status: 'ok', result: { task_id: task, task_type: mode === 'wrong-type' ? 'resource_parse' : 'session_commit',
        resource_id: mode === 'wrong-resource' ? 'other-session' : session, status: mode === 'pending' ? 'pending' : 'completed',
        result: mode === 'pending' ? null : { session_id: session, archive_uri: `${mode === 'foreign-archive' ? 'viking://user/foreign' : root}/sessions/${session}/history/archive_7` } } };
    }
    throw new Error(`Unexpected fixture route: ${input.path}`);
  } });
  const contexts = new GeoNativeMemoryContext({ database: accounts.database, documents, policies, sessions });
  const context = await contexts.forProject(project);
  const journal = new GeoNativeMemoryRemember({ contexts,
    overlay: { recordCommit: async row => { if (ledgerFails) throw new Error('Ledger temporarily unavailable'); commits.push(row); } } });
  return { accounts, owner, project, documents, contexts, context, journal, sent, commits,
    mode: value => { mode = value; }, before: operation => { beforeMcp = operation; }, ledgerFails: value => { ledgerFails = value; },
    execute: (id = 5) => journal.execute(context, { messages, clientId: id, runtimeGeneration: 'generation-1' }),
    operations: () => documents.list(owner.id, 'geo-plan-context', { filter: { recordType: 'geo-native-memory-operation' } }) };
}

test('remember is journaled before forwarding, restores the client id and records the actual archive and verified session', options, async t => {
  const f = await fixture(t);
  f.before(async () => { const rows = (await f.operations()).items; assert.equal(rows.length, 1); assert.equal(rows[0].payload.state, 'pending'); });
  const result = await f.execute('client-id');
  assert.equal(result.reply.id, 'client-id'); assert.equal(result.state, 'accepted');
  const operation = (await f.operations()).items[0];
  assert.match(operation.id, /^gnmo_/); assert.notEqual(f.sent[0].body.id, 'client-id');
  assert.equal(operation.payload.archiveUri, `${f.context.userRoot}/sessions/mcp-store-fixture1/history/archive_7`);
  assert.equal(f.commits[0].archiveUri, operation.payload.archiveUri); assert.equal(f.commits[0].projectId, f.project.id);
  assert.equal(f.commits[0].origin, 'tool'); assert.equal('actorId' in f.commits[0], false);
  const binding = await f.contexts.session(f.context, 'mcp-store-fixture1');
  assert.deepEqual(binding.payload.source, { kind: 'tool', operationRef: operation.id, taskId: 'task-fixture-1' });
  assert.equal(f.sent.every(row => row.openVikingUser === f.context.namespaceId), true);
});

test('duplicate caller ids use independent server exchanges and pending tasks never invent an archive', options, async t => {
  const f = await fixture(t); f.mode('pending');
  const [one, two] = await Promise.all([f.execute(8), f.execute(8)]);
  assert.equal(one.reply.id, 8); assert.equal(two.reply.id, 8);
  const ids = f.sent.filter(row => row.path === '/mcp').map(row => row.body.id);
  assert.equal(new Set(ids).size, 2);
  const operations = (await f.operations()).items;
  assert.equal(operations.length, 2); assert.equal(operations.every(row => row.payload.state === 'accepted' && row.payload.archiveUri === null), true);
  assert.equal(f.commits.length, 0);
});

test('unverified response/session/task/archive keeps a durable unknown operation and never grants session association', options, async t => {
  const f = await fixture(t);
  for (const mode of ['malformed', 'foreign-session', 'wrong-type', 'wrong-resource', 'foreign-archive', 'lost']) {
    f.mode(mode);
    const before = f.sent.filter(row => row.path === '/mcp').length;
    await assert.rejects(f.execute());
    assert.equal(f.sent.filter(row => row.path === '/mcp').length, before + 1, 'an ambiguous write is never resent');
    assert.equal(await f.contexts.session(f.context, `mcp-store-fixture${before + 1}`), null);
  }
  assert.equal((await f.operations()).items.every(row => row.payload.state === 'unknown'), true);
  assert.equal(f.commits.length, 0);
});

test('definitive engine refusal is retained without a binding, and missing durable policy prevents forwarding', options, async t => {
  const f = await fixture(t); f.mode('error');
  const result = await f.execute(); assert.equal(result.state, 'failed'); assert.equal(result.reply.result.isError, true);
  assert.equal((await f.operations()).items[0].payload.state, 'failed');
  const policy = await f.documents.get(f.owner.id, 'geo-plan-context', f.context.policyRef);
  await f.documents.remove(f.owner.id, 'geo-plan-context', policy.id, policy.revision);
  const count = f.sent.length;
  await assert.rejects(f.execute(), error => error.code === 'memory_scope_denied'); assert.equal(f.sent.length, count);
});

test('a pending task reconciles in its original namespace and ledger failures remain retryable without resending memory', options, async t => {
  const f = await fixture(t); f.mode('pending');
  const result = await f.execute();
  await f.accounts.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id=$2", [f.owner.id, f.project.id]);
  const replacement = await f.contexts.forProject(f.project); assert.notEqual(replacement.namespaceId, f.context.namespaceId);
  f.mode('completed'); f.ledgerFails(true);
  const pending = await f.journal.reconcile(f.context, result.operationId);
  assert.equal(pending.payload.archiveUri, `${f.context.userRoot}/sessions/mcp-store-fixture1/history/archive_7`);
  assert.equal(pending.payload.ledgerState, 'pending'); assert.equal(f.commits.length, 0);
  f.ledgerFails(false);
  const settled = await f.journal.reconcile(f.context, result.operationId);
  assert.equal(settled.payload.ledgerState, 'recorded'); assert.equal(f.commits.length, 1);
  await f.journal.reconcile(f.context, result.operationId); assert.equal(f.commits.length, 1);
  assert.equal(f.sent.filter(row => row.path === '/mcp').length, 1);
  assert.equal(await f.contexts.session(replacement, 'mcp-store-fixture1'), null);
});

test('an accepted operation and its session binding commit together; an ambiguous write cannot forge a tool binding', options, async t => {
  const f = await fixture(t);
  await assert.rejects(f.contexts.saveSession(f.context, 'mcp-store-guessed', { kind: 'tool', operationRef: 'gnmo_11111111-1111-4111-8111-111111111111', taskId: 'task-fixture-guess' }, 'generation-1'), error => error.code === 'memory_scope_denied');
  const save = f.contexts.saveSession.bind(f.contexts);
  f.contexts.saveSession = async (...args) => { await save(...args); throw new Error('Failure after binding insert'); };
  await assert.rejects(f.execute(), /Failure after binding insert/);
  const operation = (await f.operations()).items[0]; assert.equal(operation.payload.state, 'unknown');
  assert.equal(await f.contexts.session(f.context, 'mcp-store-fixture1'), null, 'the uncommitted session receipt rolls back with acceptance');
  assert.equal(f.commits.length, 0);
  await f.journal.reconcile(f.context, operation.id);
  assert.equal(f.sent.filter(row => row.path === '/mcp').length, 1, 'unknown cannot trigger another remember');
});
