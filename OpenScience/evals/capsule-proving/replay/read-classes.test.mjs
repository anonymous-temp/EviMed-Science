import test from 'node:test';
import assert from 'node:assert/strict';
import { lexicalAudit, serializeRecordedTool, requestFromPack } from './read-classes.mjs';

test('replay does not invent a successful absent source or expose withdrawn prose', () => {
  const call = serializeRecordedTool({ name: 'mcp__openviking__search', args: { query: 'past' }, blocks: [JSON.stringify({ memories: [] })] });
  assert.match(call.blocks.join('\n'), /completion_not_in_recorded_trace/);
  assert.ok(call.gaps.length);
  const withdrawn = serializeRecordedTool({ name: 'mcp__openviking__search', args: { query: 'past' }, blocks: [JSON.stringify({ memories: [], history: [{ withdrawn: true, messages: [{ text: 'DO-NOT-REVEAL' }], conversationTitle: 'DO-NOT-REVEAL' }] })] });
  assert.doesNotMatch(withdrawn.blocks.join('\n'), /DO-NOT-REVEAL/);
  assert.match(withdrawn.blocks.join('\n'), /withdrawn/);
  const ordinary = requestFromPack({ item: { qid: 'control' }, answer: { qid: 'control', question: 'What is 2 + 2?', asOf: '2026-11-17', toolCalls: [], opening: {}, model: {} }, gold: { question: { expect: { mustContain: ['4'] } } } }, 'fixture');
  assert.equal(ordinary.toolCalls.length, 0);
  assert.equal(ordinary.messages.length, 2, 'no forced memory lookup for an ordinary question');
  assert.doesNotMatch(JSON.stringify(ordinary.messages), /mustContain/);
});

test('lexical evidence proves only literal admission, never unknown vector rank', () => {
  const [audit] = lexicalAudit([{ sessionId: 's1', messages: [{ role: 'assistant', content: 'I suggested 2:3:3.' }] }], [{ kind: 'recorded_query', query: '方案比例（2:3:3）？' }]);
  assert.equal(audit.oldLiteralHits, 0);
  assert.equal(audit.newLiteralHits, 1);
  assert.equal(audit.fullCorpusRecall, 'requires_lab');
});
