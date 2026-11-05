import assert from 'node:assert/strict';
import test from 'node:test';
import { historyChunks, historySearchText } from '../src/memoryHistory.mjs';

test('history keeps only sanitized user and assistant text with source dates, roles and adjacent turns', () => {
  const chunks = historyChunks([
    { role: 'system', content: 'system instruction' },
    { role: 'user', content: 'Kidney project: reach Alice at alice@example.org, token sk-abcdefghijklmnopqrstuvwxyz123456', created_at: '2026-11-01T10:00:00Z' },
    { role: 'tool', content: 'secret tool result' },
    { role: 'assistant', parts: [{ type: 'text', text: 'I suggest checking the trial design.' }, { type: 'tool_call', text: 'do not keep' }] },
    { role: 'user', content: '<evimed-brief>injected context</evimed-brief>' },
  ]);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].messages.map(m => m.sourceRole), ['user', 'assistant']);
  assert.equal(chunks[0].messages[0].date, '2026-11-01T10:00:00.000Z');
  assert.equal(chunks[0].messages[1].date, null);
  assert.equal(chunks[0].messages[1].confirmed, false);
  assert.ok(chunks[0].text.includes('alice@example.org'));
  assert.doesNotMatch(chunks[0].text, /abcdefghijklmnopqrstuvwxyz|tool result|injected context|do not keep/);
});

test('exchange chunks are bounded and carry adjacent context without promoting it to confirmed fact', () => {
  const chunks = historyChunks(Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `topic ${i}: ${'x'.repeat(900)}` })));
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every(c => c.text.length <= 6000 && c.messages.length <= 6));
  assert.ok(chunks.every(c => c.messages.every(m => m.contextOnly === true && m.confirmed === false)));
  assert.ok(chunks.some((c, i) => i > 0 && c.messages.some(m => chunks[i - 1].messages.some(p => p.index === m.index))));
});

test('history prose names dates, speaker, link and historical context; unknown time stays unknown', () => {
  const text = historySearchText([{ conversationTitle: 'Kidney trial', conversationUrl: '/app/projects/p?session=session_a', messages: [{ sourceRole: 'assistant', date: null, text: 'Maybe use a crossover design.', contextOnly: true, confirmed: false }] }]);
  assert.match(text, /Kidney trial/); assert.match(text, /assistant/); assert.match(text, /unknown/); assert.match(text, /\/app\/projects/);
  assert.match(text, /context|历史/);
});
