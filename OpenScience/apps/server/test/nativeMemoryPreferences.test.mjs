import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreferenceJudge, markPreferenceOverlaps, parsePreferenceOverlaps } from '../src/nativeMemoryPreferences.mjs';

function fixture(profileAt, preferenceAt) {
  return [
    { id: 'profile-line', nativeType: 'profile', scope: 'user', document: { id: 'profile' }, value: '回答一律用中文。', updatedAt: profileAt },
    { id: 'preference-file', nativeType: 'preferences', scope: 'user', value: '- 回答一律用英文。\n- 表格不超过五列。', updatedAt: preferenceAt },
  ];
}

test('only a confident offered pair is accepted', () => {
  assert.deepEqual(parsePreferenceOverlaps('{"overlaps":[{"profile":0,"preference":0,"confidence":0.95}]}', 1, 1), [{ profile: 0, preference: 0 }]);
  for (const content of ['not json', '{}', '{"overlaps":[{"profile":0,"preference":0,"confidence":0.89}]}',
    '{"overlaps":[{"profile":2,"preference":0,"confidence":1}]}', '{"overlaps":[{"profile":0,"preference":0}]}']) {
    assert.deepEqual(parsePreferenceOverlaps(content, 1, 1), []);
  }
});

test('the newer revision is current and the exact older line is labelled without marking its neighbour', () => {
  const marked = markPreferenceOverlaps(fixture('2026-11-01', '2026-11-02'), [{ profile: 0, preference: 0 }]);
  assert.deepEqual(marked[0].earlierValues, ['回答一律用中文。']);
  assert.equal(marked[0].currentPreferenceId, 'preference-file');
  assert.equal(marked[1].earlierValues, undefined);
  const reverse = markPreferenceOverlaps(fixture('2026-11-03', '2026-11-02'), [{ profile: 0, preference: 0 }]);
  assert.equal(reverse[0].earlierValues, undefined);
  assert.deepEqual(reverse[1].earlierValues, ['回答一律用英文。']);
  assert.equal(reverse[1].earlierValues.includes('表格不超过五列。'), false);
  assert.equal(markPreferenceOverlaps(fixture('2026-11-01', '2026-11-01'), [{ profile: 0, preference: 0 }])[0].earlierValues, undefined);
});

test('the real judge adapter validates the response and spends at most its daily allowance', async () => {
  let calls = 0;
  const judge = createPreferenceJudge({ config: { memoryPreferenceReconcileEnabled: true, deepseekApiKey: 'fixture', deepseekModel: 'model', memoryPreferenceJudgeDailyCalls: 1 },
    callModel: async () => { calls++; return { choices: [{ message: { content: '{"overlaps":[{"profile":0,"preference":0,"confidence":0.95}]}' } }] }; } });
  const input = { userId: 'u', profile: ['回答用中文'], preferences: ['回答用英文'] };
  assert.deepEqual(await judge.overlaps(input), [{ profile: 0, preference: 0 }]);
  assert.deepEqual(await judge.overlaps(input), []);
  assert.equal(calls, 1);
});

test('invalid timestamps, equivalent instants, and ambiguous judgements leave values active', () => {
  for (const [a, b] of [['invalid', '2026-11-21'], ['2026-11-21T01:00:00+01:00', '2026-11-21T00:00:00Z']]) {
    assert.ok(markPreferenceOverlaps(fixture(a, b), [{ profile: 0, preference: 0 }]).every(row => !row.earlierValues));
  }
  const pairs = [{ profile: 0, preference: 0 }, { profile: 0, preference: 1 }];
  assert.ok(markPreferenceOverlaps(fixture('2026-11-20', '2026-11-21'), pairs).every(row => !row.earlierValues));
});

test('zero allowance and oversized requests spend no calls, including on the first request of the day', async () => {
  let calls = 0;
  for (const allowance of [0, 1]) {
    const judge = createPreferenceJudge({ config: { memoryPreferenceReconcileEnabled: true, deepseekApiKey: 'fixture', deepseekModel: 'model', memoryPreferenceJudgeDailyCalls: allowance },
      callModel: async () => { calls++; } });
    assert.deepEqual(await judge.overlaps({ userId: 'u', profile: [allowance ? 'a'.repeat(24_000) : 'a'], preferences: ['b'] }), []);
  }
  assert.equal(calls, 0);
});
