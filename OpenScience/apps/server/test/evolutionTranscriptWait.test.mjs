import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForEvolutionTranscript } from '../../../scripts/ops/evolution-transcript-wait.mjs';
test('null and incomplete transcripts wait for the exact complete durable object', async () => {
  const complete = { header: { completeness: 'complete', sha256: 'actual-hash' }, messages: [{ actual: true }] };
  const states = [null, { header: { completeness: 'partial' } }, complete];
  let reads = 0;
  assert.equal(await waitForEvolutionTranscript({}, 'run', { timeoutMs: 100, pollMs: 1, read: async () => states[reads++] }), complete);
  assert.equal(reads, 3);
});
test('deadline and cancellation never fabricate complete evidence', async () => {
  await assert.rejects(waitForEvolutionTranscript({}, 'run', { timeoutMs: 5, pollMs: 1, read: async () => null }), /deadline/);
  const abort = new AbortController(); abort.abort();
  let reads = 0;
  await assert.rejects(waitForEvolutionTranscript({}, 'run', { signal: abort.signal, read: async () => { reads++; return null; } }), error => error.name === 'AbortError');
  assert.equal(reads, 0);
});

test('real complete transcript without header hash yields actual non-null deterministic digest', async () => {
  const { evolutionTranscriptHash } = await import('../../../scripts/ops/evolution-transcript-wait.mjs');
  const transcript = { header: { completeness: 'complete', runId: 'real' }, messages: [{ parts: [{ type: 'text', text: 'Actual output' }] }] };
  const hash = evolutionTranscriptHash(transcript);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(evolutionTranscriptHash(structuredClone(transcript)), hash);
  assert.notEqual(evolutionTranscriptHash({ ...transcript, messages: [] }), hash);
  assert.throws(() => evolutionTranscriptHash({ header: { completeness: 'partial' } }));
});
