import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenVikingClient } from '../src/openVikingClient.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { OPENVIKING_MEMORY_TYPES, OPENVIKING_PROJECT_MEMORY_TYPES, projectNativeMemoryNamespace } from '../src/openVikingLayout.mjs';
import { OpenVikingStub } from './helpers/openVikingStub.mjs';

const basis = { ownerId: 'owner', ownerCreatedAt: '2026-01-01 00:00:00+00', projectId: 'project', projectCreatedAt: '2026-01-02 00:00:00+00' };
test('project memory identity is stable through members and runtime changes but not account or project reincarnation', () => {
  const namespace = projectNativeMemoryNamespace(basis);
  assert.deepEqual(projectNativeMemoryNamespace({ ...basis }), namespace);
  assert.match(namespace.engineUser, /^gp-[a-f0-9]{24}$/);
  for (const key of Object.keys(basis)) assert.notEqual(projectNativeMemoryNamespace({ ...basis, [key]: `${basis[key]}-new` }).engineUser, namespace.engineUser);
  for (const key of Object.keys(basis)) assert.throws(() => projectNativeMemoryNamespace({ ...basis, [key]: '' }));
});

test('namespace-bound sessions use one native engine identity for data, admin policy, MCP, exports and deletion', async t => {
  const stub = await new OpenVikingStub().start(); t.after(() => stub.close());
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: 'evimed' });
  const personal = new OpenVikingSessions(client);
  const namespace = projectNativeMemoryNamespace(basis), scoped = personal.forNamespace(namespace);
  assert.equal(scoped.engineUser('owner'), namespace.engineUser);
  assert.equal(scoped.userRoot('owner'), `viking://user/${namespace.engineUser}`);
  assert.equal(scoped.memoryRoot('owner'), `${scoped.userRoot('owner')}/memories`);
  assert.equal(scoped.sessionUri('owner', 'dsh-root'), `${scoped.userRoot('owner')}/sessions/dsh-root`);
  assert.notEqual(scoped.userRoot('owner'), personal.userRoot('owner'));
  await personal.setLearning('owner', true);
  assert.deepEqual((await personal.settings('owner')).memoryTypes, [...OPENVIKING_MEMORY_TYPES].sort());
  const start = stub.requests.length;
  for (const learning of [true, false, true]) {
    const saved = await scoped.setLearning('owner', learning);
    assert.equal(saved.learning, learning);
    assert.deepEqual(saved.memoryTypes, [...OPENVIKING_PROJECT_MEMORY_TYPES].sort());
  }
  await scoped.createSession('owner', 'dsh-root');
  await scoped.addMessage('owner', 'dsh-root', { role: 'user', content: 'Only this project fact.' });
  const read = await scoped.readSession('owner', 'dsh-root'); assert.ok(read);
  await scoped.commit('owner', 'dsh-root');
  await scoped.tree('owner', scoped.memoryRoot('owner'));
  await scoped.read('owner', `${scoped.memoryRoot('owner')}/profile.md`);
  await scoped.find('owner', 'project fact', { target: scoped.memoryRoot('owner') });
  await scoped.client.request({ path: '/api/v1/fs/ls', userId: 'owner', query: { uri: scoped.userRoot('owner') } });
  await scoped.mcp('owner', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await scoped.exportPack('owner');
  await scoped.remove('owner', `${scoped.memoryRoot('owner')}/project_facts/absent.md`);
  await scoped.deleteSession('owner', 'dsh-root');
  await scoped.eraseUser('owner', { waitMs: 0 });
  for (const request of stub.requests.slice(start)) {
    assert.equal(request.headers['x-openviking-user'], namespace.engineUser, request.path);
    if (request.path.includes('/admin/accounts/')) assert.ok(request.path.endsWith('/users') || request.path.includes(`/users/${namespace.engineUser}`));
  }
  assert.deepEqual((await personal.settings('owner')).memoryTypes, [...OPENVIKING_MEMORY_TYPES].sort(), 'project deletion and pause never rewrite personal policy');
  assert.equal(stub.sessions.has(`${personal.engineUser('owner')}/dsh-root`), false);
});

test('a bound facade refuses other owners or forged namespace identities before sending', async () => {
  const calls = [];
  const client = { configured: true, account: 'evimed', request: async input => { calls.push(input); return {}; } };
  const personal = new OpenVikingSessions(client), namespace = projectNativeMemoryNamespace(basis), scoped = personal.forNamespace(namespace);
  assert.throws(() => personal.forNamespace({ ...namespace, engineUser: personal.engineUser('owner') }));
  assert.throws(() => personal.forNamespace(null));
  assert.throws(() => scoped.forNamespace(null));
  assert.throws(() => scoped.forNamespace(projectNativeMemoryNamespace({ ...basis, projectId: 'another' })));
  await assert.rejects(scoped.readSession('other', 'session'));
  await assert.rejects(scoped.client.request({ path: '/api/v1/fs/ls', userId: 'other' }));
  await assert.rejects(scoped.client.request({ path: '/api/v1/fs/ls', userId: 'owner', openVikingUser: personal.engineUser('owner') }));
  assert.throws(() => scoped.userRoot('other'));
  assert.deepEqual(calls, []);
});

test('bound client identity conflicts and non-boolean authentication never reach HTTP', async () => {
  const calls = [];
  const client = { configured: true, account: 'evimed', request: async input => { calls.push(input); return {}; }, remove: async (...input) => { calls.push(input); return true; } };
  const scoped = new OpenVikingSessions(client).forNamespace(projectNativeMemoryNamespace(basis));
  await assert.rejects(scoped.client.remove('owner', `${scoped.memoryRoot('owner')}/x.md`, { openVikingUser: 'foreign' }), error => error.code === 'memory_scope_denied');
  for (const authenticated of [null, 0, '', 'true', {}, []]) {
    await assert.rejects(scoped.client.request({ path: '/api/v1/fs/ls', userId: 'owner', authenticated }), error => error.code === 'memory_scope_denied');
  }
  assert.deepEqual(calls, []);
  await scoped.health();
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/health'); assert.equal(calls[0].authenticated, false);
});
test('an unavailable deletion probe is not proof that namespace erasure completed', async () => {
  for (const code of ['memory_index_upstream_error', 'memory_index_timeout', 'memory_index_auth_failed']) {
    const sessions = new OpenVikingSessions({ configured: true, account: 'fixture', request: async input => {
      if (input.path === '/api/v1/fs/ls') throw Object.assign(new Error('Deletion probe unavailable'), { code });
      return { status: 'ok' };
    } });
    await assert.rejects(sessions.eraseUser('owner', { waitMs: 0 }), error => error.code === code);
  }
  const absent = new OpenVikingSessions({ configured: true, account: 'fixture', request: async input => {
    if (input.path === '/api/v1/fs/ls') throw Object.assign(new Error('Absent'), { code: 'memory_index_not_found' });
    return { status: 'ok' };
  } });
  assert.deepEqual(await absent.eraseUser('owner', { waitMs: 0 }), { deleted: true, pending: false });
});
