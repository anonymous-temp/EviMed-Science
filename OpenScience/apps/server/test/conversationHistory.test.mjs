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

test('an exact native run reads only its recorded request turns from a shared session capture', async () => {
  const runs = [{ id: 'first', sessionId: 'session-a', kernelRequestIds: ['request-first'] }, { id: 'second', sessionId: 'session-a', kernelRequestIds: ['request-second'] }];
  const messages = [[1, 'user', 'First question', 1, 'request-first'], [2, 'assistant', 'First answer', 1, null], [3, 'user', 'Second question', 3, 'request-second'], [4, 'assistant', 'Second answer', 3, null]].map(([seq, role, text, turnStartSeq, sourceRequestId]) => ({ sessionId: 'session-a', seq, role, source: 'user', turnStartSeq, sourceRequestId, parts: [{ type: 'text', text }] }));
  const reads = [];
  const read = async (_project, id) => { reads.push(id); return { header: { capturedAt: '2026-10-24', completeness: 'complete' }, messages }; };
  for (const id of ['first', 'second']) {
    const history = await preservedConversationHistory({}, 'session-a', runs, read, { runId: id });
    assert.deepEqual(history.messages.map(message => message.text), id === 'first' ? ['First question', 'First answer'] : ['Second question', 'Second answer']);
    assert.equal(history.partial, false);
  }
  assert.deepEqual(reads, ['first', 'second']);
  await assert.rejects(preservedConversationHistory({}, 'session-a', runs, read, { runId: 'foreign' }), { code: 'run_not_found', status: 404 });
});
test('missing native turn identity is partial rather than claiming another run in the same session', async () => {
  const snapshot = { header: { completeness: 'complete' }, messages: [{ sessionId: 'same', seq: 4, role: 'assistant', source: 'user', parts: [{ type: 'text', text: 'Unattributed answer' }] }] };
  const runs = [{ id: 'one', sessionId: 'same', kernelRequestIds: ['missing'] }, { id: 'two', sessionId: 'same' }];
  for (const id of ['one', 'two']) {
    const result = await preservedConversationHistory({}, 'same', runs, async () => snapshot, { runId: id });
    assert.equal(result.partial, true); assert.deepEqual(result.messages, []);
  }
});
