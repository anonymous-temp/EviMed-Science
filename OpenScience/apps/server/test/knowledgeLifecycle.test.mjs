import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OpenVikingSourceSync, sourceRendition } from '../src/openVikingSourceSync.mjs';

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
  // A restored source is current once its own generation has been read: the analysis names that generation (as every analysis
  // has since 2026-09-07) and its capture is what the engine's copy is compared with. One whose text is still an earlier
  // generation's is not readable as this one, and its copy goes until the read lands.
  for (const [analysisGeneration, expected] of [[3, []], [1, ['deleted']]]) {
    const calls = [];
    const source = { id: 's', projectId: 'p', payload: { status: 'complete', generation: 3, paths: ['a.md'], analysis: { generation: analysisGeneration, textSha256: 'current' } } };
    const capture = { input: { text: 'restored text' }, extractor: {}, pageMap: null, metadata: null };
    const rendition = createHash('sha256').update(sourceRendition(source, capture)).digest('hex');
    const sync = new OpenVikingSourceSync({ config: { ovKnowledgeEnabled: true }, jobs: {},
      sources: { get: async () => source, loadCapture: async () => capture }, resources: { configured: true, sourceUri: () => 'uri', attrs: async () => ({ sha: 'current', rendition }),
        removeSource: async () => calls.push('deleted'), pushSource: async () => calls.push('pushed') }, lifecycle: async () => {} });
    sync.reconcileLibrary = async () => ({ failed: [] });
    await sync.runJob({ userId: 'u', payload: { action: 'lifecycle', scope: 'source', sourceId: 's', projectId: 'p', deleted: true, generation: 1 } });
    assert.deepEqual(calls, expected);
  }
});
