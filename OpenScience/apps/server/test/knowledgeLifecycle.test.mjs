import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenVikingSourceSync } from '../src/openVikingSourceSync.mjs';

test('a partial library convergence remains retryable', async () => {
  const sync = new OpenVikingSourceSync({ config: { ovKnowledgeEnabled: true }, sources: {}, jobs: {}, resources: { configured: true } });
  sync.reconcileLibrary = async () => ({ failed: [{ sourceId: 's', code: 'offline' }] });
  await assert.rejects(sync.runJob({ userId: 'u', payload: { action: 'library' } }), { code: 'ov_resource_sync_partial' });
});

test('durable library event awaits dependent invalidation even when engine is disabled', async () => {
  const calls = [];
  const sync = new OpenVikingSourceSync({ config: {}, sources: {}, jobs: {}, resources: {},
    lifecycle: async event => calls.push(event) });
  await sync.runJob({ userId: 'u', payload: { action: 'lifecycle', scope: 'library', sourceId: 's', mutationRevision: 7 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.mutationRevision, 7);
});

test('an obsolete account event cannot touch a recreated account resource', async () => {
  const sync = new OpenVikingSourceSync({ config: { ovKnowledgeEnabled: true }, sources: {}, jobs: {},
    resources: { configured: true }, lifecycle: async () => false });
  sync.reconcileLibrary = async () => { throw new Error('obsolete event reached engine'); };
  assert.deepEqual(await sync.runJob({ userId: 'u', payload: { action: 'lifecycle', scope: 'library' } }), { skipped: 'obsolete-account' });
});

test('a delayed delete converges the restored current generation without deleting it', async () => {
  const calls = [];
  const source = { id: 's', projectId: 'p', payload: { status: 'complete', generation: 3, analysis: { textSha256: 'current' } } };
  const sync = new OpenVikingSourceSync({ config: { ovKnowledgeEnabled: true }, jobs: {},
    sources: { get: async () => source }, resources: { configured: true, sourceUri: () => 'uri', attrs: async () => ({ sha: 'current' }),
      removeSource: async () => calls.push('deleted') }, lifecycle: async () => {} });
  sync.reconcileLibrary = async () => ({ failed: [] });
  await sync.runJob({ userId: 'u', payload: { action: 'lifecycle', scope: 'source', sourceId: 's', projectId: 'p', deleted: true, generation: 1 } });
  assert.deepEqual(calls, []);
});
