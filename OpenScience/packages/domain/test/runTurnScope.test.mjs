import assert from 'node:assert/strict';
import test from 'node:test';
const load = () => import('../src/runTurnScope.mjs');
const user = (seq, turnStartSeq, sourceRequestId, sessionId = 'root') => ({ role: 'user', source: 'user', seq, turnStartSeq, sourceRequestId, sessionId, parts: [{ type: 'text', text: sourceRequestId }] });
const call = (seq, turnStartSeq, tool, sessionId = 'root') => ({ role: 'assistant', seq, turnStartSeq, sessionId, parts: [{ type: 'tool', tool, status: 'completed', input: {}, output: {} }] });

test('the current request scopes messages without editing preserved history or guessing by time', async () => {
  const { scopeRunTranscript } = await load();
  const original = { header: { sessions: [{ sessionId: 'root', parentSessionId: null, seedEndSeq: -1 }] },
    messages: [user(1, 0, 'old'), call(2, 0, 'old_tool'), user(11, 10, 'current'), call(12, 10, 'current_tool')] };
  const before = structuredClone(original);
  const view = scopeRunTranscript(original, { id: 'run', sessionId: 'root', kernelRequestIds: ['current'], startedAt: '1900-01-01' });
  assert.deepEqual(view.messages.map(row => row.seq), [11, 12]);
  assert.equal(view.runScope.available, true); assert.deepEqual(original, before);
});

test('unknown identity and an unmatched declared request never select a legacy whole session', async () => {
  const { scopeRunTranscript } = await load();
  const original = { messages: [user(1, 0, 'old'), call(2, 0, 'old_tool')] };
  for (const run of [{ id: 'run', sessionId: 'root' }, { id: 'run', sessionId: 'root', kernelRequestIds: ['not_captured'] }]) {
    const view = scopeRunTranscript(original, run); assert.deepEqual(view.messages, []); assert.equal(view.runScope.available, false);
  }
  assert.deepEqual(scopeRunTranscript(original, { id: 'run', sessionId: 'root', nativeTurn: { startSeq: 0 } }).messages.map(row => row.seq), [1, 2]);
});

test('only receipt-owned descendants are selected and copied seed history never teaches the new run', async () => {
  const { scopeRunTranscript } = await load();
  const original = { header: { runChildSessionIds: ['child', 'old-child', 'foreign'], sessions: [
    { sessionId: 'root', parentSessionId: null, seedEndSeq: -1 },
    { sessionId: 'child', parentSessionId: 'root', seedEndSeq: 3 },
    { sessionId: 'old-child', parentSessionId: 'root' },
    { sessionId: 'foreign', parentSessionId: 'different-root', seedEndSeq: -1 },
    { sessionId: 'unowned', parentSessionId: 'root', seedEndSeq: -1 },
  ] }, messages: [user(11, 10, 'current'), call(12, 10, 'root_tool'), call(1, 0, 'copied_old_tool', 'child'), call(5, 4, 'child_tool', 'child'),
    call(1, 0, 'unproved_seed', 'old-child'), call(1, 0, 'foreign_tool', 'foreign'), call(1, 0, 'unowned_tool', 'unowned')] };
  const view = scopeRunTranscript(original, { id: 'run', sessionId: 'root', kernelRequestIds: ['current'] });
  assert.deepEqual(view.messages.map(row => row.parts[0].tool ?? row.sourceRequestId), ['current', 'root_tool', 'child_tool']);
  assert.deepEqual(view.runScope.childSessionIds, ['child']);
  assert.ok(view.runScope.unverifiedChildSessionIds.includes('old-child'));
});

test('a mismatched captured root is refused and seed copies cannot satisfy a current input identity', async () => {
  const { scopeRunTranscript } = await load();
  const original = { header: { sessions: [{ sessionId: 'different-root', parentSessionId: null, seedEndSeq: -1 }] }, messages: [user(1, 0, 'current')] };
  assert.equal(scopeRunTranscript(original, { id: 'run', sessionId: 'root', kernelRequestIds: ['current'] }).runScope.available, false);
  original.header.sessions[0] = { sessionId: 'root', parentSessionId: null, seedEndSeq: 3 };
  assert.deepEqual(scopeRunTranscript(original, { id: 'run', sessionId: 'root', kernelRequestIds: ['current'] }).messages, []);
});
