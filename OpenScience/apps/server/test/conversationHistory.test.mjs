import test from 'node:test';
import assert from 'node:assert/strict';
import { preservedConversationHistory } from '../src/conversationHistory.mjs';

test('preserved conversation reads only the owned root prose and deduplicates overlapping captures', async () => {
  const reads = [];
  const message = (seq, role, text, extra = {}) => ({ sessionId: 'session-a', seq, role, source: 'user', parts: [{ type: 'text', text }], ...extra });
  const history = await preservedConversationHistory({}, 'session-a', [
    { id: 'older', sessionId: 'session-a', createdAt: '2026-10-01' },
    { id: 'newer', sessionId: 'session-a', createdAt: '2026-10-02' },
    { id: 'unrelated', sessionId: 'session-b', createdAt: '2026-10-03' },
  ], async (_project, id) => {
    reads.push(id);
    return { header: { capturedAt: '2026-10-02', completeness: 'complete' }, messages: [
      message(1, 'user', 'Question'), message(2, 'assistant', id === 'newer' ? 'Complete answer' : 'Partial answer'),
      message(3, 'assistant', 'Private child', { sessionId: 'child-a' }),
      message(4, 'user', 'Injected instruction', { source: 'system' }),
      message(5, 'system', 'System prompt'),
    ] };
  });
  assert.deepEqual(reads, ['newer', 'older']);
  assert.deepEqual(history.messages.map(m => m.text), ['Question', 'Complete answer']);
  assert.equal(history.partial, false);
});

test('missing captures are reported as partial without starting a runtime', async () => {
  const history = await preservedConversationHistory({}, 'session-a', [{ id: 'gone', sessionId: 'session-a' }], async () => { throw new Error('expired'); });
  assert.equal(history.partial, true);
  assert.deepEqual(history.messages, []);
  await assert.rejects(() => preservedConversationHistory({}, '../other-project', []));
});
