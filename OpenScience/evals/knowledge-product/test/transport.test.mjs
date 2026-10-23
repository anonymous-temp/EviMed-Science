import test from 'node:test';
import assert from 'node:assert/strict';
import benchmark from '../cases.json' with { type: 'json' };
import { verifyCorpus, preflight } from '../run.mjs';
test('all frozen source bytes match recorded SHA256', async () => {
  await verifyCorpus(benchmark);
  await assert.rejects(() => verifyCorpus({ ...benchmark, sources: [{ ...benchmark.sources[0], sha256: '0'.repeat(64) }] }), /Frozen corpus changed/);
});
test('unconfigured product arms stop before model spend', async () => {
  const missing=await preflight({});
  assert.ok(missing.includes('baseline: product base URL and fixture bindings missing'));
  assert.ok(missing.includes('candidate: product base URL and fixture bindings missing'));
  assert.ok(missing.some(s=>s.includes('budget wiring')));
});
