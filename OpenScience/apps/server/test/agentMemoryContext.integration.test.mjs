import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { AgentApiKeyStore } from '../src/agentApiKeys.mjs';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { createMemoryGatewayHandler } from '../src/memoryGateway.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { ResidentProfiles } from '../src/residentProfile.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
const { options, fixture } = nativeIntegration();

test('key opening uses persisted privacy and never acknowledges or counts a session delivery', options, async t => {
  const f = await fixture(t), user = { id: f.userId }, project = { id: 'default', userId: f.userId };
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Test',1048576)", [user.id]);
  const config = { ...f.config, agentMemoryApiEnabled: true, memoryEnabled: true, memoryOpeningByUseEnabled: true };
  const contexts = new GeoNativeMemoryContext({ database: f.database, documents: null, sessions: f.sessions,
    policies: { forProject: async () => ({ kind: 'owned' }), policiesForOwner: async () => [] }, settingsForOwner: id => f.memorySettings.settings(id) });
  f.store.memoryContexts = contexts;
  const store = { userById: async () => user, requireProject: async () => project };
  const admission = createMemoryAdmission({ config, memorySettings: f.memorySettings });
  const gateway = createMemoryGatewayHandler({ config, store, sessions: f.sessions, overlay: f.overlay, admission, memoryContexts: contexts, runtimeManager: {} });
  const resident = new ResidentProfiles({ config, store: f.memorySettings });
  const keys = new AgentApiKeyStore(f.database), key = await keys.create(user.id, { name: 'Context fixture', scopes: ['memory.read'] });
  f.seed('profile.md', '- Keep green folders.', { type: 'profile' });
  const routes = createAgentMemoryRoutes({ config, store, apiKeys: keys, capsules: {}, nativeMemory: f.store,
    memorySettings: f.memorySettings, admission, openingContext: { resident, opening: gateway.opening } });
  const res = { data: null, writeHead() {}, end(text) { this.data = JSON.parse(text).data; } };
  await routes({ method: 'GET', url: '/api/agent-memory/v1/context', headers: { authorization: `Bearer ${key.key}` } }, res);
  assert.match(res.data.layers.find(layer => layer.name === 'profile').text, /green folders/);
  const rows = await f.database.query('SELECT * FROM evimed_memory.sessions WHERE user_id=$1', [user.id]);
  assert.equal(rows.rows.length, 0);
  assert.ok([...await f.overlay.files(user.id)].every(([, file]) => !file.usedCount));
});
