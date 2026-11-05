import assert from 'node:assert/strict';
import test from 'node:test';
const load = () => import('../src/runLearningScope.mjs');
const message = (seq, turnStartSeq, text, sourceRequestId = undefined) => ({ role: sourceRequestId ? 'user' : 'assistant', source: 'user', sourceRequestId, seq, turnStartSeq, parts: [{ type: 'text', text }] });
const fixture = () => ({ run: { id: 'run2', sessionId: 'root', kernelRequestIds: ['input2'] }, sessions: [
  { sessionId: 'root', parentSessionId: null, capability: null, transcript: { sessionId: 'root', messages: [message(1, 0, 'old request', 'input1'), message(11, 10, 'current request', 'input2')] } },
  { sessionId: 'child', parentSessionId: 'root', capability: null, transcript: { sessionId: 'child', seedEndSeq: 3, messages: [message(2, 0, 'copied seed'), message(12, 10, 'old activation'), message(22, 20, 'current activation')] } },
] });

test('live consumers share a current-run projection and immutable capture metadata', async () => {
  const { collectedRunScope } = await load(), input = fixture(), before = globalThis.structuredClone(input);
  const selected = collectedRunScope(input.run, input.sessions, { ownedChildSessionIds: ['child'], childTurnOwnership: [
    { schema: 'child-run-turns/1', rootSessionId: 'root', runId: 'run2', sessionId: 'child', turnStartSeqs: [20] },
  ] });
  assert.deepEqual(selected.sessions.flatMap(row => row.transcript.messages.map(m => m.parts[0].text)), ['current request', 'current activation']);
  assert.equal(selected.metadata.get('root').seedEndSeq, -1);
  assert.deepEqual(selected.metadata.get('child').runTurnOwnership.turnStartSeqs, [20]);
  assert.deepEqual(input, before);
});
test('a child id alone or an old receipt never admits a continued child history', async () => {
  const { collectedRunScope } = await load(), input = fixture();
  for (const receipts of [[], [{ schema: 'child-run-turns/1', rootSessionId: 'root', runId: 'run1', sessionId: 'child', turnStartSeqs: [10] }]]) {
    const selected = collectedRunScope(input.run, input.sessions, { ownedChildSessionIds: ['child'], childTurnOwnership: receipts });
    assert.deepEqual(selected.sessions.flatMap(row => row.transcript.messages.map(m => m.parts[0].text)), ['current request']);
    assert.ok(selected.scope.unverifiedChildSessionIds.includes('child'));
  }
});
test('a partial seed-unknown source or a mismatched live session stays unavailable', async () => {
  const { collectedRunScope } = await load(), input = fixture();
  input.sessions[0].transcript.truncated = true;
  assert.equal(collectedRunScope(input.run, input.sessions).scope.available, false);
  input.sessions[0].transcript.truncated = false; input.sessions[0].transcript.sessionId = 'foreign';
  assert.equal(collectedRunScope(input.run, input.sessions).scope.available, false);
});

test('a live message explicitly attributed to another session is not relabelled by collection', async () => {
  const { collectedRunScope } = await load(), input = fixture();
  input.sessions[0].transcript.messages[1].sessionId = 'foreign';
  assert.equal(collectedRunScope(input.run, input.sessions).scope.available, false);
});

test('explicit malformed seed metadata is not replaced with an unseeded assertion', async () => {
  const { collectedRunScope } = await load();
  for (const bad of [null, '3', -2, 1.5]) {
    const input = fixture(); input.sessions[0].transcript.seedEndSeq = bad;
    assert.equal(collectedRunScope(input.run, input.sessions).scope.available, false);
  }
});

test('a page-bounded native read cannot assert the absence of a fork seed', async () => {
  const { collectedRunScope } = await load(), input = fixture();
  input.sessions[0].transcript.exhausted = false;
  const unknown = collectedRunScope(input.run, input.sessions);
  assert.equal(unknown.scope.available, false);
  assert.equal(unknown.metadata.get('root').seedEndSeq, undefined);
  input.sessions[0].transcript.seedEndSeq = 3;
  const known = collectedRunScope(input.run, input.sessions);
  assert.equal(known.scope.available, true);
  assert.equal(known.scope.partial, true);
});
