import assert from 'node:assert/strict';
import test from 'node:test';
const load = () => import('../src/runTurnScope.mjs');
/** @param {number} seq @param {number} turnStartSeq @param {string} sourceRequestId @param {string} [sessionId] */
const user = (seq, turnStartSeq, sourceRequestId, sessionId = 'root') => ({ role: 'user', source: 'user', seq, turnStartSeq, sourceRequestId, sessionId, parts: [{ type: 'text', text: sourceRequestId }] });
/** @param {number} seq @param {number} turnStartSeq @param {string} tool @param {string} [sessionId] */
const call = (seq, turnStartSeq, tool, sessionId = 'root') => ({ role: 'assistant', seq, turnStartSeq, sessionId, parts: [{ type: 'tool', tool, status: 'completed', input: {}, output: {} }] });

test('the current request scopes messages without editing preserved history or guessing by time', async () => {
  const { scopeRunTranscript } = await load();
  const original = { header: { sessions: [{ sessionId: 'root', parentSessionId: null, seedEndSeq: -1 }] },
    messages: [user(1, 0, 'old'), call(2, 0, 'old_tool'), user(11, 10, 'current'), call(12, 10, 'current_tool')] };
  const before = globalThis.structuredClone(original);
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
    { sessionId: 'child', parentSessionId: 'root', seedEndSeq: 3,
      runTurnOwnership: { schema: 'child-run-turns/1', runId: 'run', turnStartSeqs: [4] } },
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

test('a live fork seed and a legacy saved root with no seed proof remain unavailable to learning', async () => {
  const { scopeRunTranscript } = await load();
  const run = { id: 'run', sessionId: 'root', kernelRequestIds: ['copied'] };
  const messages = [user(1, 0, 'copied'), call(2, 0, 'copied_tool')];
  assert.equal(scopeRunTranscript({ seedEndSeq: 3, messages }, run).runScope.available, false);
  const oldCapture = { header: { sessions: [{ sessionId: 'root', parentSessionId: null }] }, messages };
  assert.equal(scopeRunTranscript(oldCapture, run).runScope.reason, 'root_seed_scope_unavailable');
});

test('a continued child needs exact owned turns and a live transcript cannot be relabelled as another root', async () => {
  const { scopeRunTranscript } = await load();
  const run = { id: 'run', sessionId: 'root', kernelRequestIds: ['current'] };
  const saved = { header: { runChildSessionIds: ['child'], sessions: [
    { sessionId: 'root', parentSessionId: null, seedEndSeq: -1 },
    { sessionId: 'child', parentSessionId: 'root', seedEndSeq: -1 },
  ] }, messages: [user(11, 10, 'current'), call(2, 0, 'earlier_child_tool', 'child'), call(12, 10, 'current_child_tool', 'child')] };
  assert.deepEqual(scopeRunTranscript(saved, run).messages.map(row => row.sessionId), ['root']);
  const bounded = { ...saved, header: { ...saved.header, sessions: [saved.header.sessions[0],
    { ...saved.header.sessions[1], runTurnOwnership: { schema: 'child-run-turns/1', runId: 'run', turnStartSeqs: [10] } }] } };
  assert.deepEqual(scopeRunTranscript(bounded, run).messages.map(row => row.parts[0].tool ?? row.sourceRequestId), ['current', 'current_child_tool']);
  const { sessionId: _sourceSession, ...unqualified } = user(1, 0, 'current');
  assert.equal(scopeRunTranscript({ sessionId: 'foreign', messages: [unqualified] }, run).runScope.available, false);
});

test('live page bounds never establish an unseeded source', async () => {
  const { scopeRunTranscript } = await import('../src/runTurnScope.mjs');
  const run = { id: 'run', sessionId: 'root', kernelRequestIds: ['current'] };
  const live = { sessionId: 'root', exhausted: false, messages: [{ role: 'user', source: 'user', sourceRequestId: 'current', seq: 11, turnStartSeq: 10, parts: [] }] };
  assert.equal(scopeRunTranscript(live, run).runScope.available, false);
  assert.equal(scopeRunTranscript({ ...live, seedEndSeq: 3 }, run).runScope.partial, true);
});
