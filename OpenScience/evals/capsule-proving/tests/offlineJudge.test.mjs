import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeBatch, semanticPackets } from '../offlineJudge.mjs';

test('offline judging only receives undecidable development cases and retains extraction errors', () => {
  const cases = new Map([['c', { id: 'c', replay: { messages: [{ role: 'user', text: 'Source statement' }] } }]]);
  const packets = semanticPackets({ rows: [{ id: 'c#1', case: 'c', decidable: false, expected: 'Keep attribution', judge: 'Was it attributed?', files: {}, taskStatus: 'completed' }, { id: 'mechanical', decidable: true }] }, cases);
  assert.equal(packets.length, 1); assert.equal(packets[0].source.replay.messages[0].text, 'Source statement');
  assert.throws(() => semanticPackets({ rows: [{ id: 'unknown', case: 'absent', decidable: false }] }, cases), /case_missing/);
});

test('the requested and returned judge identity are Qwen 3.8 Max, with structured verdicts and usage', async () => {
  let sent;
  const result = await judgeBatch([{ id: 'a' }], { key: 'test-only', fetchImpl: async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, headers: new Headers({ 'x-request-id': 'request' }), json: async () => ({ model: 'qwen3.8-max', usage: { prompt_tokens: 10, completion_tokens: 4 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ judgements: [{ id: 'a', verdict: 'pass', reason: 'Source retained.' }] }) } }] }) };
  } });
  assert.equal(sent.model, 'qwen3.8-max'); assert.equal(sent.enable_thinking, false);
  assert.equal(result.model, 'qwen3.8-max'); assert.equal(result.judgements[0].verdict, 'pass'); assert.equal(result.usage.prompt_tokens, 10);
});

test('missing, duplicate, malformed, truncated or substituted judgements cannot become scores', async () => {
  for (const patch of [{ model: 'other' }, { content: '{bad' }, { content: '{"judgements":[]}' }, { finish_reason: 'length' }, { content: '{"judgements":[{"id":"a","verdict":"pass","reason":"ok"},{"id":"a","verdict":"pass","reason":"again"}]}' }]) {
    await assert.rejects(() => judgeBatch([{ id: 'a' }], { key: 'test-only', fetchImpl: async () => ({ ok: true, headers: new Headers(), json: async () => ({ model: patch.model ?? 'qwen3.8-max', choices: [{ finish_reason: patch.finish_reason ?? 'stop', message: { content: patch.content ?? '{"judgements":[{"id":"a","verdict":"pass","reason":"ok"}]}' } }] }) }) }));
  }
});

test('an unmet seed prerequisite is unknown even when extraction completes', async () => {
  const { incompletePacket } = await import('../offlineJudge.mjs');
  const base = { taskStatus: 'completed', expected: 'Keep the update', question: 'Correct?', source: { replay: { seed: [{ role: 'user', text: 'Old choice' }] } }, seedFiles: { 'profile.md': 'old' }, failures: [] };
  assert.equal(incompletePacket(base), false);
  assert.equal(incompletePacket({ ...base, failures: ['the seed did not store "Vancouver", so the replay starts from nothing'] }), true);
  assert.equal(incompletePacket({ ...base, seedFiles: {} }), true);
});
