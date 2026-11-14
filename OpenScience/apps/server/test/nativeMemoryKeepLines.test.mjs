import assert from 'node:assert/strict';
import test from 'node:test';
import { carriesPlatformContext, identifierShapesIn, platformIdentifiersIn } from '@evimed/domain';
import { keepUnexplainedLines } from '../src/nativeMemoryKeepLines.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { removalRefusals } from '../src/nativeMemoryRejections.mjs';

const allergy = '- 对青霉素过敏（重要用药安全信息）(as of 2026-11-14)';
const swimming = '- 每周三晚上去游泳 (as of 2026-11-14)';
const coffee = '- 早上习惯喝黑咖啡 (as of 2026-11-14)';
const key = '- 家里备用钥匙放在蓝色鞋柜第二层 (as of 2026-11-14)';
const before = ['# 用户', allergy, swimming, coffee, key].join('\n');
const after = ['# 用户', allergy, coffee].join('\n');
const neverKept = text => identifierShapesIn(text).length > 0 || carriesPlatformContext(text) || platformIdentifiersIn(text).length > 0;
const classify = overrides => keepUnexplainedLines({ enabled: true, before, after, neverKept, ...overrides });
const user = text => ({ role: 'user', text });

test('FT13: only the swimming rejection explains a deletion; retain the original spare-key line', async () => {
  const rejected = await removalRefusals({ userId: 'u', overlay: { removals: async () => [{ text: swimming.slice(2), fingerprint: lineFingerprint(swimming.slice(2)) }] },
    candidates: [swimming, key].map(text => ({ text: text.slice(2) })) });
  assert.equal(rejected.has(lineFingerprint(key.slice(2))), false, 'the shared matcher does not confuse keys with swimming');
  const result = classify({ rejected: new Set(rejected.keys()), messages: [user('我每周三晚上去游泳这条，帮我从记忆里忘掉吧，别的都别动。')] });
  assert.equal(result.after, [after, key].join('\n'));
  assert.deepEqual(result.outcomes, ['kept_deleted_rejected', 'restored']);
});

test('restoration preserves raw text, stamps and position between surviving lines', () => {
  const prior = ['# 用户', allergy, key, coffee].join('\n');
  assert.equal(classify({ before: prior }).after, prior);
});

test('a legitimate move with an explicit earlier value remains replaced', () => {
  const old = '住在小店区';
  for (const marker of ['曾为：', 'earlier:']) {
    const next = `- 住在迎泽区（${marker}${old}）`;
    assert.equal(classify({ before: `- ${old}`, after: next, added: [next.slice(2)], messages: [user('我搬到迎泽区了')] }).after, next);
  }
});

test('added lines anywhere can explain replacement by hard tokens or Jaccard, unchanged neighbours cannot', () => {
  assert.deepEqual(classify({ before: '- Project M-41633: old value', after: null, added: ['Project M-41633: new value'] }).outcomes, ['kept_deleted_replaced']);
  assert.deepEqual(classify({ before: '- Prefers black coffee every morning.', after: null, added: ['Prefers black coffee every afternoon.'] }).outcomes, ['kept_deleted_replaced']);
  assert.deepEqual(classify({ before: '- Project M-41633: old value', after: '- Project M-41633: neighbour' }).outcomes, ['restored']);
});

test('the user can supply deletion grounds without a tool; assistant and tool messages cannot', () => {
  const text = '每周三晚上去游泳';
  const request = '每周三晚上去游泳这条请忘掉';
  assert.deepEqual(classify({ before: `- ${text}`, after: null, messages: [user(request)] }).outcomes, ['kept_deleted_grounded']);
  for (const role of ['assistant', 'tool']) assert.deepEqual(classify({ before: `- ${text}`, after: null, messages: [{ role, text: request }] }).outcomes, ['restored']);
});

test('never restore structural secrets, withdrawn sources or moved fingerprints', () => {
  assert.deepEqual(classify({ before: '- password: Sunset-1234', after: null }).outcomes, ['kept_deleted_never_kept']);
  assert.deepEqual(classify({ before: key, after: null, withdrawn: new Set([lineFingerprint(key.slice(2))]) }).outcomes, ['kept_deleted_rejected']);
  assert.deepEqual(classify({ before: key, after: null, elsewhere: new Set([lineFingerprint(key.slice(2))]) }).outcomes, ['kept_deleted_moved']);
});

test('whole-file deletion keeps required lines, including their heading and order', () => {
  const result = classify({ after: null, rejected: new Set([lineFingerprint(swimming.slice(2))]) });
  assert.equal(result.after, ['# 用户', allergy, coffee, key].join('\n'));
});

test('over 200 before-lines is skipped once; disabled is byte-for-byte unchanged', () => {
  const large = Array.from({ length: 201 }, (_, i) => `- fact ${i}`).join('\n');
  assert.deepEqual(classify({ before: large, after: null }), { after: null, outcomes: ['skipped_large'] });
  assert.deepEqual(classify({ enabled: false, after: '\n  original bytes \r\n' }), { after: '\n  original bytes \r\n', outcomes: [] });
  assert.deepEqual(classify({ enabled: false, after: null }), { after: null, outcomes: [] });
});


test('the metric exposes all outcomes at zero and counts each without persisting content', async () => {
  const { nativeMemoryMetricFamilies, recordUnexplainedDeletions, resetNativeMemoryMetrics } = await import('../src/nativeMemoryMetrics.mjs');
  resetNativeMemoryMetrics();
  const read = () => nativeMemoryMetricFamilies().find(family => family.name === 'open_science_native_memory_unexplained_deletions_total');
  assert.deepEqual(read().series.map(row => row.labels.outcome), ['restored', 'kept_deleted_rejected', 'kept_deleted_replaced', 'kept_deleted_grounded', 'kept_deleted_never_kept', 'kept_deleted_moved', 'skipped_large']);
  assert.ok(read().series.every(row => row.value === 0));
  recordUnexplainedDeletions('restored');
  assert.equal(read().series.find(row => row.labels.outcome === 'restored').value, 1);
});

test('as-of dates are not shared tokens and bare district changes do not fabricate lexical grounds', () => {
  assert.deepEqual(classify({ before: '- 住在小店区', after: '- 住在迎泽区', added: ['住在迎泽区'], messages: [user('我搬到迎泽区了')] }).outcomes, ['restored']);
  assert.deepEqual(classify({ before: key, after: coffee, added: [coffee.slice(2)] }).outcomes, ['restored']);
});
