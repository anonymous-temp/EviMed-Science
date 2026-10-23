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
