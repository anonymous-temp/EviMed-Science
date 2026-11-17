import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { createAgentKeyRoutes } from '../src/agentKeyRoutes.mjs';

const path = '/api/agent-memory/v1';
function request(url = path, token = 'valid', method = 'GET') {
  return { url, method, headers: { authorization: `Bearer ${token}` } };
}
function response() {
  return { data: null, writeHead() {}, end(body) { this.data = JSON.parse(body); } };
}
function fixture(config, userId = 'internal') {
  const calls = [];
  const apiKeys = {
    async resolve(token) {
      calls.push('resolve');
      if (token !== 'valid') throw Object.assign(new Error('Invalid key'), { status: 401, code: 'agent_key_invalid' });
      return { userId, keyId: 'key', scopes: ['memory.read'], projectId: null };
    },
    async list() { calls.push('list'); return []; },
    async create(_owner, input) { calls.push('create'); return { id: 'key', scopes: input.scopes }; },
    async revoke() { calls.push('revoke'); return {}; },
  };
  const routes = createAgentMemoryRoutes({ config, apiKeys, store: { async userById(id) { return id === 'missing' ? null : { id }; } } });
  const keys = createAgentKeyRoutes({ config, apiKeys, context: async () => ({ user: { id: userId } }), audit: async () => {} });
  return { routes, keys, calls };
}
const disabled = error => error.status === 503 && error.code === 'agent_memory_disabled';

test('default-off does not authenticate keys or advertise OpenAPI, including operator accounts', async () => {
  const { routes, calls } = fixture({ operatorUsers: ['internal'] });
  for (const url of [path, `${path}/openapi.json`, `${path}/recall`]) await assert.rejects(routes(request(url), response()), disabled);
  assert.deepEqual(calls, []);
});

test('internal allowlist admits its account to status and OpenAPI while refusing every outsider identically', async () => {
  const config = { agentMemoryApiInternalUsers: ['internal'] };
  const { routes } = fixture(config);
  for (const url of [path, `${path}/openapi.json`]) {
    const res = response();
    await routes(request(url), res);
    assert.ok(res.data);
    for (const userId of ['outside', 'missing']) await assert.rejects(fixture(config, userId).routes(request(url), response()), disabled);
    await assert.rejects(routes(request(url, 'invalid'), response()), disabled);
  }
});

test('operator opt-in reuses operatorUsers and revocation is checked on each request', async () => {
  const config = { agentMemoryApiInternalEnabled: true, operatorUsers: ['internal'] };
  const { routes } = fixture(config);
  await routes(request(), response());
  config.operatorUsers = [];
  await assert.rejects(routes(request(), response()), disabled);
  config.agentMemoryApiInternalUsers = ['internal'];
  await routes(request(), response());
  config.agentMemoryApiInternalUsers = [];
  await assert.rejects(routes(request(), response()), disabled);
});

test('key management refuses before reading key existence but remains usable by an allowed account', async () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const { keys, calls } = fixture({}, 'outside');
    await assert.rejects(keys(request(`/api/agent-keys${method === 'DELETE' ? '/unknown' : ''}`, 'valid', method), response()), disabled);
    assert.deepEqual(calls, []);
  }
  const { keys, calls } = fixture({ agentMemoryApiInternalUsers: ['internal'] });
  await keys(request('/api/agent-keys'), response());
  assert.deepEqual(calls, ['list']);
});

test('public enable preserves unauthenticated OpenAPI and ordinary key access', async () => {
  const { routes } = fixture({ agentMemoryApiEnabled: true }, 'outside');
  await routes(request(`${path}/openapi.json`, 'invalid'), response());
  await routes(request(), response());
});

test('status declares unavailable parity operations explicitly and keys without history scope cannot claim it', async () => {
  const { routes } = fixture({ agentMemoryApiInternalUsers: ['internal'], memoryHistorySearchEnabled: true });
  const res = response();
  await routes(request(), res);
  assert.equal(res.data.data.capabilities.rawConversationRecall.available, false);
  assert.deepEqual(res.data.data.capabilities.rawConversationRecall.requiredScopes, ['memory.read', 'memory.history.read']);
  for (const name of ['openingContext', 'explicitRemember', 'statementForget', 'conversationIngest', 'workSignals', 'capsuleSharing', 'selectedCapsuleOnly']) {
    assert.equal(res.data.data.capabilities[name].available, false, name);
  }
});

test('cookie key routes enforce the account audience while internal access is enabled', async () => {
  const config = { agentMemoryApiInternalUsers: ['internal'] };
  for (const method of ['GET', 'POST', 'DELETE']) {
    const { keys, calls } = fixture(config, 'outside');
    await assert.rejects(keys(request(`/api/agent-keys${method === 'DELETE' ? '/known-or-unknown' : ''}`, 'valid', method), response()), disabled);
    assert.deepEqual(calls, []);
  }
  const { keys, calls } = fixture(config);
  await keys({ ...request('/api/agent-keys', 'valid', 'POST'),
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ name: 'Internal', scopes: ['memory.read'] })); } }, response());
  await keys(request('/api/agent-keys/key', 'valid', 'DELETE'), response());
  assert.deepEqual(calls, ['create', 'revoke']);
});

test('keys stay manageable for the data-analysis API when the memory API is closed or internal-only, and open no memory route', async () => {
  // The key store serves every API a key can call. CI caught the memory audience gate closing analysis keys with it:
  // dataAnalysisApp.integration minted a key with `dataAnalysisApiEnabled` alone and got 503.
  for (const config of [{ dataAnalysisApiEnabled: true }, { dataAnalysisApiEnabled: true, agentMemoryApiInternalUsers: ['internal'] }]) {
    const { keys, routes, calls } = fixture(config, 'outside');
    await keys(request('/api/agent-keys'), response());
    await keys({ ...request('/api/agent-keys', 'valid', 'POST'),
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ name: 'Analysis', scopes: ['analysis.read', 'analysis.write'] })); } }, response());
    await keys(request('/api/agent-keys/key', 'valid', 'DELETE'), response());
    assert.deepEqual(calls, ['list', 'create', 'revoke']);
    // The same outside account's key is still refused by the memory routes.
    for (const url of [path, `${path}/openapi.json`, `${path}/recall`]) await assert.rejects(routes(request(url), response()), disabled);
  }
  // With no key-bearing API offered at all, key management stays closed as before.
  const { keys, calls } = fixture({ dataAnalysisApiEnabled: false }, 'outside');
  await assert.rejects(keys(request('/api/agent-keys'), response()), disabled);
  assert.deepEqual(calls, []);
});

test('the me feature uses the same audience decision as the key and bearer routes', async () => {
  const { agentMemoryAvailable } = await import('../src/agentMemoryAvailability.mjs');
  const { readFile } = await import('node:fs/promises');
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /agentMemoryApi: agentMemoryAvailable\(config, user\)/);
  const config = { agentMemoryApiInternalUsers: ['internal'], operatorUsers: ['operator'] };
  assert.equal(agentMemoryAvailable(config, { id: 'internal' }), true);
  assert.equal(agentMemoryAvailable(config, { id: 'outside' }), false);
  assert.equal(agentMemoryAvailable(config, { id: 'operator' }), false);
  config.agentMemoryApiInternalEnabled = true;
  assert.equal(agentMemoryAvailable(config, { id: 'operator' }), true);
  assert.equal(agentMemoryAvailable(config, { id: 'outside' }), false);
});
