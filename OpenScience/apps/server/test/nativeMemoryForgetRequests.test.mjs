import assert from 'node:assert/strict';
import test from 'node:test';
import { parseForgetRequestJudgement, parseForgetTargetReview, createForgetRequestJudge } from '../src/nativeMemoryForgetRequests.mjs';
const candidates = [{ text: 'Project M-41633.' }];
const conversation = [{ role: 'user', text: 'Forget Project M-41633.' }, { role: 'assistant', text: 'Forgotten.' }];
const valid = { requests: [{ message: 0, quote: conversation[0].text, decision: 'remove', targets: [0], intents: [] }], claims: [{ message: 1, quote: 'Forgotten.' }] };
test('structured judgement requires exact own-message quotes and offered targets', () => {
  assert.deepEqual(parseForgetRequestJudgement(JSON.stringify(valid), candidates, conversation), valid);
  for (const mutate of [v => v.requests[0].targets.push(5), v => v.requests[0].message = 1, v => v.requests[0].quote = 'invented',
    v => v.requests[0].targets.push(0), v => v.requests[0].decision = 'yes', v => v.claims[0].message = 0,
    v => v.requests[0].intents.push({ message: 0, quote: 'invented' }), v => v.claims.push(null)]) {
    const changed = structuredClone(valid); mutate(changed);
    assert.equal(parseForgetRequestJudgement(JSON.stringify(changed), candidates, conversation), null);
  }
});
test('judge uses json_object and control-plane billing, and defaults off', async () => {
  let called = 0;
  const callModel = async (_deps, request) => {
    called++;
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    assert.deepEqual(request.body.thinking, { type: called === 1 ? 'disabled' : 'enabled' });
    assert.equal(request.purpose, 'memory-extraction');
    const value = called === 1 ? valid : { targets: [{ request: 0, candidate: 0, decision: 'remove' }] };
    return { choices: [{ message: { content: JSON.stringify(value) } }] };
  };
  const input = { userId: 'u', candidates, conversation };
  assert.equal(await createForgetRequestJudge({ config: {}, callModel }).check(input), null);
  assert.equal(called, 0);
  const config = { memoryForgetRequestCheckEnabled: true, deepseekApiKey: 'test-key', deepseekModel: 'test' };
  const result = await createForgetRequestJudge({ config, callModel }).check(input);
  assert.deepEqual(result.requests[0].targets, [0]);
  assert.deepEqual(result.requests[0].targetReview, [{ text: candidates[0].text, decision: 'remove' }]);
  assert.equal(called, 2);
});

test('invalid quotes get one structured repair with unchanged validation', async () => {
  const input = structuredClone(valid);
  input.requests[0].intents = [{ message: 0, quote: 'A different detail absent from this turn.' }];
  assert.equal(parseForgetRequestJudgement(JSON.stringify(input), candidates, conversation), null);
  const removed = [{ ...candidates[0], removed: true }];
  assert.equal(parseForgetRequestJudgement(JSON.stringify(input), removed, conversation), null);
  const config = { memoryForgetRequestCheckEnabled: true, deepseekModel: 'test', deepseekApiKey: 'test-key' };
  let calls = 0;
  const judge = createForgetRequestJudge({ config, callModel: async (_deps, request) => {
    calls++;
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    if (calls === 2) assert.match(request.body.messages.at(-1).content, /verbatim contiguous substring/);
    return { choices: [{ message: { content: JSON.stringify(calls === 1 ? input : calls === 2 ? valid : { targets: [{ request: 0, candidate: 0, decision: 'remove' }] }) } }] };
  } });
  const result = await judge.check({ userId: 'u', candidates: removed, conversation });
  assert.deepEqual(result.requests[0].targets, [0]);
  assert.equal(calls, 3);
  calls = 0;
  const invalid = createForgetRequestJudge({ config, callModel: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify(input) } }] };
  } });
  await assert.rejects(invalid.check({ userId: 'u', candidates: removed, conversation }), /forget_request_judge_invalid/);
  assert.equal(calls, 2, 'an invalid repair never becomes deletion authority');
});

test('the whole-line reviewer must cover exactly the offered pairs and can only narrow the removal', async () => {
  const offered = [{ request: 0, candidate: 0 }];
  for (const value of [{ targets: [] }, { targets: [{ request: 0, candidate: 1, decision: 'remove' }] }, { targets: [null] }]) {
    assert.equal(parseForgetTargetReview(JSON.stringify(value), offered), null);
  }
  let called = 0;
  const judged = structuredClone(valid); judged.requests[0].intents = [{ message: 0, quote: 'Project M-41633.' }];
  const judge = createForgetRequestJudge({ config: { memoryForgetRequestCheckEnabled: true, deepseekApiKey: 'test-key', deepseekModel: 'test' },
    callModel: async () => ({ choices: [{ message: { content: JSON.stringify(++called === 1 ? judged : { targets: [
      { request: 0, candidate: 0, decision: 'keep' }, { request: 0, candidate: 1, decision: 'remove' },
    ] }) } }] }) });
  const result = await judge.check({ userId: 'u', candidates, conversation });
  assert.deepEqual(result.requests[0].targets, []);
  assert.equal(result.requests[0].targetReview[0].decision, 'keep');
  assert.equal(result.requests[0].decision, 'remove', 'an absent withdrawn fact still has an exact removal intent');
});

test('a prior rejection is still reviewed before it can authorize a new request fence', async () => {
  const proposal = { requests: [{ message: 0, quote: conversation[0].text, decision: 'remove', targets: [0], intents: [] }], claims: [] };
  let called = 0;
  const judge = createForgetRequestJudge({ config: { memoryForgetRequestCheckEnabled: true, deepseekApiKey: 'test-key', deepseekModel: 'test' },
    callModel: async () => ({ choices: [{ message: { content: JSON.stringify(++called === 1 ? proposal : { targets: [{ request: 0, candidate: 0, decision: 'keep' }] }) } }] }) });
  const result = await judge.check({ userId: 'u', candidates: [{ ...candidates[0], removed: true }], conversation });
  assert.equal(called, 2);
  assert.deepEqual(result.requests[0].targets, []);
  assert.equal(result.requests[0].decision, 'uncertain');
});

test('P31 literal matching ignores token spacing only when enabled and keeps numeric/unit boundaries', async () => {
  const { tokenPresent, sourceHasToken } = await import('../src/nativeMemoryHardTokens.mjs');
  assert.equal(sourceHasToken('2 次夜班', { text: '值了2次夜班' }, { ignoreWhitespace: true }), true);
  assert.equal(sourceHasToken('2 次夜班', { text: '值了2次夜班' }), false);
  assert.equal(tokenPresent('2 次夜班', '值了2次夜班'), false);
  assert.equal(tokenPresent('2 次夜班', '值了2次夜班', { ignoreWhitespace: true }), true);
  assert.equal(tokenPresent('12 mg', 'Dose 12mg.', { ignoreWhitespace: true }), true);
  for (const source of ['Dose 112mg.', 'Dose -12mg.', 'Dose 12mg/ml.', 'Dose 1 2mg.']) {
    assert.equal(tokenPresent('12 mg', source, { ignoreWhitespace: true }), false);
  }
});

test('settlement attributes a partial tool revision only to the lines it actually removed', async () => {
  const { checkForgetRequests } = await import('../src/nativeMemoryForgetRequests.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const archiveUri = 'viking://user/u1/sessions/dsh-session_a/history/archive_001';
  const overlay = {
    commit: async () => ({}), removalOrigins: async () => [{ archiveUri, engineSession: 'dsh-session_a' }],
    forgetToolRevisions: async () => [{ before: 'Removed fact.\nKept fact.', after: 'Kept fact.' }],
    removals: async () => ['Removed fact.', 'Kept fact.'].map(text => ({ text, fingerprint: lineFingerprint(text) })),
    forgetRequestKeys: async () => new Set(), setForgetRequests: async () => {},
  };
  await checkForgetRequests({ commit: { userId: 'u1', archiveUri },
    context: { userRoot: 'viking://user/u1', sessions: { read: async () => JSON.stringify({ role: 'user', content: 'Forget the removed fact.' }) } },
    overlay, store: { rawFiles: async () => [] }, judge: { check: async ({ candidates }) => {
      assert.equal(candidates.find(row => row.text === 'Removed fact.').toolRemoved, true);
      assert.equal(candidates.find(row => row.text === 'Kept fact.').toolRemoved, false);
      return { requests: [], claims: [] };
    } } });
});
