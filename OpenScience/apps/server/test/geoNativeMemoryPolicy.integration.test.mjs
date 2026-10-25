import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { NativeMemoryOverlay } from '../src/nativeMemoryOverlay.mjs';
import { NativeMemoryStore } from '../src/nativeMemoryStore.mjs';
import { ResearchMemoryStore } from '../src/researchMemory.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { OpenVikingClient } from '../src/openVikingClient.mjs';
import { createMemoryRoutes } from '../src/memoryRoutes.mjs';
import { sendJson } from '../src/security.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { startOpenVikingStub } from './helpers/openVikingStub.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'geomemorypolicy');
  let accounts, dataDir;
  t.after(async () => { await accounts?.database.close(); await isolated.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-memory-policy-'));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', databasePoolMax: 1 });
  accounts = new PostgresStore(config);
  await accounts.createUser('owner', 'fixture-password', 'Owner'); const owner = await accounts.userById('owner');
  await accounts.requireProject(owner, 'default');
  await accounts.createProject(owner, 'other', 'Other');
  const geo = new GeoStore({ database: accounts.database }); await geo.ready();
  for (const projectId of ['default', 'other']) await geo.createProject({ userId: owner.id, projectId, engines: ['deepseek'], coverageDays: 30 });
  const stub = await startOpenVikingStub(t);
  const sessions = new OpenVikingSessions(new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: 'evimed' }));
  const documents = new ProductDocuments(accounts.database), policies = new GeoSharedContext({ database: accounts.database, documents });
  const researchMemory = new ResearchMemoryStore({ ...config, ovNativeMemoryEnabled: true }, { database: accounts.database });
  await researchMemory.setMemoryEngine(owner.id, 'native');
  const contexts = new GeoNativeMemoryContext({ database: accounts.database, documents, policies, sessions,
    settingsForOwner: userId => researchMemory.settings(userId) });
  const a = await contexts.forProject({ userId: owner.id, id: 'default' }), b = await contexts.forProject({ userId: owner.id, id: 'other' });
  const overlay = new NativeMemoryOverlay({ database: accounts.database }); await overlay.migrate();
  const nativeMemory = new NativeMemoryStore({ sessions, overlay, memoryContexts: contexts });
  return { owner, accounts, config, contexts, a, b, stub, sessions, researchMemory, nativeMemory };
}

test('persisted account and project pause govern initialization and override stale resume or pause arguments', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  await f.researchMemory.updateSettings(user, { learningPaused: true });
  assert.equal((await f.contexts.configure(f.a)).learning, false, 'a new namespace must not start learning while paused');
  assert.equal((await f.contexts.configure(f.a, { learning: true })).learning, false, 'a delayed resume cannot override current state');
  await f.researchMemory.updateSettings(user, { learningPaused: false, pausedProjects: [f.a.projectId] });
  await f.nativeMemory.setLearning(user, true);
  assert.equal((await f.a.sessions.settings(user)).learning, false);
  assert.equal((await f.b.sessions.settings(user)).learning, true);
  await f.researchMemory.updateSettings(user, { pausedProjects: [] });
  assert.equal((await f.contexts.configure(f.a, { learning: false })).learning, true, 'persisted resume wins over a delayed pause');
  assert.equal((await f.a.sessions.settings(user)).memoryTypes.includes('profile'), false);
  await f.researchMemory.updateSettings(user, { learningPaused: true });
  const before = f.stub.requests.length;
  f.contexts.settingsForOwner = async () => { throw new Error('Settings unavailable'); };
  await assert.rejects(f.contexts.configure(f.b), /Settings unavailable/);
  assert.equal(f.stub.requests.length, before, 'an unavailable authority is not permission to change engine settings');
  f.contexts.settingsForOwner = async () => ({ learningPaused: false, pausedProjects: null });
  await assert.rejects(f.contexts.configure(f.b), error => error.code === 'memory_scope_denied');
  assert.equal(f.stub.requests.length, before);
});

test('changing only pausedProjects immediately reconciles every registered namespace through the existing settings route', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  await f.nativeMemory.setLearning(user, true);
  const audits = [];
  const routes = createMemoryRoutes({ config: { ...f.config, memoryEnabled: true, ovNativeMemoryEnabled: true }, researchMemory: f.researchMemory,
    nativeMemory: f.nativeMemory, store: f.accounts, context: async () => ({ user: f.owner, project: { id: 'default' } }),
    audit: async (...args) => { audits.push(args); }, recordFeedback: async () => {}, decodeRouteComponent: decodeURIComponent });
  const server = createServer((req, res) => { routes(req, res).catch(error => sendJson(res, error.status ?? 500, { error: error.code ?? error.message })); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const paused of [true, false]) {
    const response = await fetch(`${base}/api/memory/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pausedProjects: paused ? [f.a.projectId] : [] }) });
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.data.engine, 'native');
    assert.equal((await f.a.sessions.settings(user)).learning, !paused, JSON.stringify({ body, audits }));
    assert.equal((await f.b.sessions.settings(user)).learning, true);
    assert.equal((await f.sessions.settings(user)).learning, true);
  }
  assert.equal(audits.filter(row => row[1] === 'memory.settings.engine').length, 0);
});
