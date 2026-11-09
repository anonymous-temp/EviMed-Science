import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeControllerClient, RUNTIME_CONTROLLER_PROTOCOL_VERSION } from '../src/runtimeControllerClient.mjs';

const project = { userId: 'owner', id: 'project', activeWorkspace: '', rootDir: '/never-forward/project',
  runtimeDir: '/never-forward/runtime', sourceOwnerCreatedAt: '2026-11-05 00:00:00.123456+00',
  sourceProjectCreatedAt: '2026-11-05 00:00:01.654321+00' };

test('source capture sends only a project reference, exact incarnations and an opaque generation reference', async () => {
  const client = new RuntimeControllerClient({});
  const calls = [];
  client.request = async (...args) => { calls.push(args); return { schema: 'native-source-storage/1' }; };
  assert.equal(typeof client.captureConversationSource, 'function');
  const context = { digest: 'a'.repeat(64), policyDigest: 'b'.repeat(64) };
  await client.captureConversationSource(project, 'source_a', context);
  assert.deepEqual(calls[0].slice(0, 3), ['POST', '/v1/runtime/source-storage/capture', {
    userId: 'owner', projectId: 'project', activeWorkspace: '', sessionId: 'source_a', contextReference: context,
    incarnation: { ownerCreatedAt: project.sourceOwnerCreatedAt, projectCreatedAt: project.sourceProjectCreatedAt },
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /never-forward|rootDir|runtimeDir/);
});

test('source purge transports the frozen proof rather than accepting caller filesystem roots', async () => {
  const client = new RuntimeControllerClient({}); const calls = [];
  client.request = async (...args) => { calls.push(args); return { sourceRemoved: true, removedSessionIds: ['source_a'] }; };
  assert.equal(typeof client.purgeConversationSource, 'function');
  const frozen = { schema: 'native-source-storage/1', storageIdentity: 'c'.repeat(64), contextReference: null,
    root: { id: 'source_a', createdAt: 1, cwd: '/workspace', isSeeded: false }, sessions: [{ id: 'source_a' }], generation: 'g1' };
  const result = await client.purgeConversationSource(project, frozen);
  assert.deepEqual(calls[0].slice(0, 3), ['POST', '/v1/runtime/source-storage/purge', {
    userId: 'owner', projectId: 'project', activeWorkspace: '', frozen,
  }]);
  assert.deepEqual(result.removedSessionIds, ['source_a']);
  assert.doesNotMatch(JSON.stringify(calls), /never-forward|rootDir|runtimeDir/);
});

test('the controller handshake distinguishes a source-purge capable controller from older deployments', () => {
  assert.ok(RUNTIME_CONTROLLER_PROTOCOL_VERSION >= 18);
});
