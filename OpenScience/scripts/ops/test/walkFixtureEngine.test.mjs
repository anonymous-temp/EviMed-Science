import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOpenVikingStub } from '../../../apps/server/test/helpers/openVikingResourcesStub.mjs';
import { restoreFixtureEngine, saveFixtureEngine, warmFixtureConversations } from '../seed-walk-fixture.mjs';
const url = 'postgresql://fixture@127.0.0.1/evimed_test_engine_restart';

test('a synthetic engine restart preserves exact bytes, tags and times without reseeding its database', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'walk-engine-restart-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'engine.json'), original = createOpenVikingStub();
  original.put('viking://user/walk-fixture/memories/profile.md', 'Synthetic memory: 记忆', ['memory_type=profile']);
  original.put('viking://resources/source/contents.md', '# Synthetic preserved source', ['source=fixture']);
  await saveFixtureEngine(original, file, url, 'walk-fixture');
  const restored = createOpenVikingStub(), database = { query: async () => { throw new Error('An existing snapshot must not reseed the database'); } };
  assert.equal(await restoreFixtureEngine(restored, database, file, url, 'walk-fixture'), 2);
  assert.deepEqual([...restored.files], [...original.files]);
  assert.equal(await restoreFixtureEngine(restored, database, file, url, 'walk-fixture'), 2);
  assert.deepEqual([...restored.files], [...original.files]);
  await assert.rejects(restoreFixtureEngine(createOpenVikingStub(), database, file, url, 'another-fixture'), /different fixture/);
  await assert.rejects(restoreFixtureEngine(createOpenVikingStub(), database, file, 'postgresql://fixture@prod.example/evimed_test_engine_restart', 'walk-fixture'), /only furnished/);
});

test('an older fixture replays only its synthetic account preserved native files once and saves its snapshot', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'walk-engine-legacy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'engine.json'), engine = createOpenVikingStub(), calls = [];
  const database = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ uri: 'viking://user/walk-fixture/memories/project.md', body: 'Synthetic project memory', memory_type: 'project', project_id: 'default', updated_at: new Date('2026-10-01T00:00:00Z') }] }; } };
  assert.equal(await restoreFixtureEngine(engine, database, file, url, 'walk-fixture'), 1);
  assert.deepEqual(calls[0].params, ['walk-fixture']);
  assert.match(calls[0].sql, /WHERE user_id=\$1 AND body IS NOT NULL/u);
  assert.equal(engine.text('viking://user/walk-fixture/memories/project.md'), 'Synthetic project memory');
  assert.ok(JSON.parse(await readFile(file, 'utf8')).files.length === 1);
  await restoreFixtureEngine(createOpenVikingStub(), database, file, url, 'walk-fixture');
  assert.equal(calls.length, 1);
  await assert.rejects(restoreFixtureEngine(createOpenVikingStub(), { query: async () => ({ rows: [] }) }, path.join(root, 'missing.json'), url, 'walk-fixture'), /no preserved engine files/);
});


test('a fixture restart restores the existing owned mock conversation identity without a prompt or database mutation', async () => {
  const calls = [], project = { id: 'synthetic-project', userId: 'walk-fixture', workspaceDir: '/synthetic/workspace' };
  const app = { config: { runtimeMode: 'mock' }, agentRuns: { list: async () => [{ sessionId: 'web_mock_2' }, { sessionId: 'web_mock_2' }] }, store: { database: { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{ project_id: project.id, conversation_session_id: 'web_mock_2' }] }; } }, requireProject: async (user, id) => { assert.equal(user.id, project.userId); assert.equal(id, project.id); return project; } },
    runtimeManager: { start: async value => { assert.equal(value, project); return { kind: 'mock' }; }, callKernel: async (_runtime, value, method, payload) => { assert.equal(value, project); assert.equal(method, 'session/create'); assert.equal(payload.request.sessionId, 'web_mock_2'); assert.equal(payload.request.cwd, project.workspaceDir); } } };
  assert.equal(await warmFixtureConversations(app, { id: 'walk-fixture' }), 1);
  assert.deepEqual(calls[0][1], ['walk-fixture']);
  assert.match(calls[0][0], /^SELECT /u);
  await assert.rejects(warmFixtureConversations({ ...app, config: { runtimeMode: 'kernel' } }, { id: 'walk-fixture' }), /requires the mock runtime/);
  await assert.rejects(warmFixtureConversations({ ...app, store: { ...app.store, requireProject: async () => ({ ...project, userId: 'another-owner' }) } }, { id: 'walk-fixture' }), /project identity changed/);
  await assert.rejects(warmFixtureConversations({ ...app, runtimeManager: { ...app.runtimeManager, start: async () => ({ kind: 'kernel' }) } }, { id: 'walk-fixture' }), /cannot alter a real runtime/);
});

test('a new mock process epoch cannot reuse the previous context generation proof', async () => {
  const { RuntimeManager } = await import('../../../apps/server/src/runtimeManager.mjs');
  const { contextPolicyIdentity } = await import('../../../apps/server/src/geoContextItems.mjs');
  const project = { id: 'synthetic-project', userId: 'walk-fixture', workspaceDir: '/synthetic/workspace' };
  const manager = Object.create(RuntimeManager.prototype); manager.runtimes = new Map(); manager.key = value => `${value.userId}/${value.id}`;
  manager.start = async value => { const key = manager.key(value); if (!manager.runtimes.has(key)) manager.runtimes.set(key, { kind: 'mock' }); return manager.runtimes.get(key); };
  manager.callKernel = async () => ({});
  const app = { config: { runtimeMode: 'mock' }, runtimeManager: manager, agentRuns: { list: async () => [{ sessionId: 'web_mock_2' }] }, store: { database: { query: async () => ({ rows: [{ project_id: project.id, conversation_session_id: null }] }) }, requireProject: async () => project } };
  await warmFixtureConversations(app, { id: 'walk-fixture' });
  const first = manager.runtimeGeneration(project);
  assert.match(first, /^walk-fixture-generation-/u);
  const policy = { kind: 'geo-project', referenceId: 'synthetic-policy', ownerId: project.userId, controlProjectId: project.id };
  const receipt = { generation: first, digest: 'a'.repeat(64), policy: contextPolicyIdentity(policy), referenceId: 'synthetic-receipt' };
  const runtime = manager.runtimes.get(manager.key(project)); runtime.contextGeneration = { digest: receipt.digest }; runtime.contextLaunchReceipt = receipt;
  manager.contextPolicyFor = async () => policy; manager.historicalContextReceipt = async () => receipt; manager.assertSharedDesired = async () => {};
  assert.deepEqual(await manager.assertContextPolicyGeneration(project), receipt);
  manager.runtimes.clear();
  await warmFixtureConversations(app, { id: 'walk-fixture' });
  assert.notEqual(manager.runtimeGeneration(project), first);
  const restarted = manager.runtimes.get(manager.key(project)); restarted.contextGeneration = { digest: receipt.digest }; restarted.contextLaunchReceipt = receipt;
  await assert.rejects(manager.assertContextPolicyGeneration(project), error => error.code === 'runtime_context_unverified' && error.definitivelyRejected === true);
  await assert.rejects(warmFixtureConversations(app, { id: 'another-account' }), /exact synthetic account/);
});
