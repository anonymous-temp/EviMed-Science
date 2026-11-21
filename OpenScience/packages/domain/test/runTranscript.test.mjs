import assert from 'node:assert/strict'
import test from 'node:test'
import { finalAssistantText, isRawToolCallText } from '../index.mjs'

test('whole-message XML and JSON tool-call payloads are not answers', () => {
  const raw = [
    '<tool_call>{"name":"search","arguments":{"q":"x"}}</tool_call>',
    '<tool_call>{"name":"search","arguments":',
    JSON.stringify({ name: 'search', arguments: { q: 'x' } }),
    JSON.stringify({ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }),
    JSON.stringify({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }] }),
    '{"name":"search","arguments":',
    '{"name":"search","arguments":{"q":"x"}',
    '{"tool_calls":[{"function":{"name":"search","arguments":"unfinished',
  ]
  for (const text of raw) assert.equal(isRawToolCallText(text), true, text)
});

test('ordinary prose, code examples and unrelated JSON are left alone', () => {
  const answers = [
    'I will call the search tool next.',
    '<tool_call> is the opening tag used in this example.',
    '<tool_call>说明文字</tool_call>',
    '{"name":"search","arguments":{}} is only an example.',
    JSON.stringify({ answer: 'Example', tool_calls: [{ name: 'search', arguments: {} }] }),
    JSON.stringify({ function: { name: 'log', description: 'Document this function' } }),
    'Example: <tool_call>{"name":"search"}</tool_call>',
    '```json\n{"name":"search","arguments":{}}\n```',
    JSON.stringify({ type: 'example', name: 'claim', arguments: {} }),
    JSON.stringify({ name: 'report', title: 'A report' }),
    JSON.stringify({ name: 'search' }),
    '',
  ]
  for (const text of answers) assert.equal(isRawToolCallText(text), false, text)
});

test('a raw final payload has no final assistant answer and never falls back to progress text', () => {
  /** @param {string} text @returns {import('../index.mjs').RunTranscript} */
  const transcript = (text) => ({
    sessionId: 's-1', turnEnd: { kind: 'completed' }, subagents: [], lastSeq: 3,
    messages: ['Working through the sources.', text].map((part, i) => ({
      role: 'assistant', source: 'user', seq: i + 1, time: i + 1, turn: 1, step: i + 1,
      parts: [{ type: 'text', text: part }], usage: null, interrupted: false,
    })),
  })
  assert.equal(finalAssistantText(transcript('<tool_call>{"name":"search","arguments":{}}</tool_call>')), '')
  assert.equal(finalAssistantText(transcript('The answer is 42.')), 'The answer is 42.')
});
