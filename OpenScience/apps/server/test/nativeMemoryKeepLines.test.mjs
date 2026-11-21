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

test('d1: same-hunk updates retain the earlier value instead of accepting a topical replacement', () => {
  for (const [old, next] of [['住在小店区', '住在迎泽区'], ['喜欢游泳', '早晨跑步']]) {
    const result = classify({ before: `- ${old}`, after: `- ${next}`, messages: [user('我搬到迎泽区了')] });
    assert.equal(result.after, `- ${next}\n- ${old}`);
    assert.deepEqual(result.outcomes, ['restored']);
  }
});

test('d2: additions in another hunk cannot erase a specific old value through a shared token', () => {
  for (const [old, next] of [['住在小店区', '住在迎泽区'], ['M-41633 已完成', 'M-41633 已归档'],
    ['Prefers black coffee every morning.', 'COFFEE is no longer wanted.']]) {
    const result = classify({ before: `- ${old}\n${allergy}`, after: `${allergy}\n- ${next}` });
    assert.equal(result.after, `- ${old}\n${allergy}\n- ${next}`);
    assert.deepEqual(result.outcomes, ['restored']);
  }
});

test('d3: an added earlier-value wrapper explains a deletion across hunks', () => {
  for (const marker of ['曾为：', 'earlier:']) {
    const next = `- 红（${marker}青）`;
    assert.deepEqual(classify({ before: `- 青\n${allergy}`, after: `${allergy}\n${next}` }).outcomes, ['kept_deleted_replaced']);
  }
});

test('an unrelated addition in a separate hunk does not explain a missing line', () => {
  const prior = [key, allergy, coffee].join('\n');
  const next = [allergy, coffee, '- 周末参加陶艺课程'].join('\n');
  const result = classify({ before: prior, after: next, messages: [user('你好。')] });
  assert.equal(result.after, [key, next].join('\n'));
  assert.deepEqual(result.outcomes, ['restored']);
});

test('unchanged neighbours cannot explain replacement even when they share tokens', () => {
  const neighbour = '- Project M-41633: neighbour';
  assert.deepEqual(classify({ before: `- Project M-41633: old value\n${neighbour}`, after: neighbour }).outcomes, ['restored']);
});

test('a forget request needs the existing withdrawal authority, never just topic overlap', () => {
  const text = '每周三晚上去游泳';
  const request = '每周三晚上去游泳这条请忘掉';
  assert.deepEqual(classify({ before: `- ${text}`, after: null, rejected: new Set([lineFingerprint(text)]), messages: [user(request)] }).outcomes, ['kept_deleted_rejected']);
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

test('over 200 before-lines is guarded; disabled is byte-for-byte unchanged', () => {
  const large = Array.from({ length: 201 }, (_, i) => `- fact ${i}`).join('\n');
  assert.deepEqual(classify({ before: large, after: null }), { after: large, outcomes: Array(201).fill('restored') });
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

test('e: a current-state statement does not erase history through topic overlap', () => {
  assert.deepEqual(classify({ before: coffee, after: null, messages: [user('我已经不喝咖啡了')] }).outcomes, ['restored']);
  assert.deepEqual(classify({ before: '- Enjoys gardening outdoors.', after: null, messages: [user('GARDENING has ended.')] }).outcomes, ['restored']);
  assert.deepEqual(classify({ before: '- Assigned M-41633', after: null, messages: [user('Close M-41633')] }).outcomes, ['restored']);
  for (const role of ['assistant', 'tool']) {
    assert.deepEqual(classify({ before: coffee, after: null, messages: [{ role, text: '我已经不喝咖啡了' }] }).outcomes, ['restored']);
  }
});

test('stop-set-only overlap is neither grounds nor an append-style replacement', () => {
  for (const text of ['我的', '了的', 'This is that with your', 'cat']) {
    assert.deepEqual(classify({ before: `- ${text}`, after: null, messages: [user(text)] }).outcomes, ['restored']);
    assert.deepEqual(classify({ before: `- ${text}\n${allergy}`, after: `${allergy}\n- ${text}要` }).outcomes, ['restored']);
  }
});

test('as-of dates are not shared tokens and CJK pairs cannot span punctuation', () => {
  assert.deepEqual(classify({ before: `${key}\n${allergy}`, after: `${allergy}\n${coffee}` }).outcomes, ['restored']);
  assert.deepEqual(classify({ before: coffee, after: null, messages: [user('咖，啡')] }).outcomes, ['restored']);
});


test('P08 summary cannot replace dated specific details just because it shares a project name', () => {
  const old = '- 检索 PubMed 和 Embase，使用双变量模型，盲态核查；补充材料保留；正文 4000 词；成年女性。 (as of 2026-04-23)';
  const summary = '- 检索 PubMed，开展诊断准确性研究。';
  const result = classify({ before: old, after: summary });
  assert.ok(result.after.includes(old));
  assert.ok(result.after.includes(summary));
  assert.deepEqual(result.outcomes, ['restored']);
});

test('long-file per-hunk guard retains specifics without restoring withdrawn content', () => {
  const lines = Array.from({ length: 501 }, (_, index) => `- Study ABC${index}: count ${index + 1}`);
  const print = lineFingerprint(lines[250].slice(2));
  const after = lines.filter((_, index) => index !== 250 && index !== 400).join('\n');
  const result = classify({ before: lines.join('\n'), after, withdrawn: new Set([print]) });
  assert.equal(result.after.includes(lines[250]), false);
  assert.ok(result.after.includes(lines[400]));
  assert.deepEqual(result.outcomes, ['kept_deleted_rejected', 'restored']);
});

test('recorded r2 P08 88-to-67-line rewrite retains the 44 missing specifics and accepts the contained line', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/memory-write-p08.json', import.meta.url), 'utf8'));
  const result = classify({ before: fixture.before, after: fixture.after });
  assert.equal(fixture.before.split('\n').length, 88);
  assert.equal(fixture.after.split('\n').length, 67);
  assert.equal(result.outcomes.filter(outcome => outcome === 'restored').length, 44);
  for (const token of ['Embase', '双变量', '盲态数据核查', '补充材料', '成年女性']) assert.ok(result.after.includes(token), token);
  assert.ok(result.outcomes.includes('kept_deleted_replaced'));
});

test('a containing prefix cannot erase a dose, unit, identifier or name boundary', () => {
  for (const [before, after] of [['Dose 12 mg', 'Dose 12 mg/dL'], ['Study ABC123', 'Study ABC123-4'], ['Owner Ann', 'Owner Anna']]) {
    const result = classify({ before: `- ${before}`, after: `- ${after}` });
    assert.ok(result.after.includes(`- ${before}`));
    assert.deepEqual(result.outcomes, ['restored']);
  }
});

test('stable headings isolate long sections even when another section contains a near copy', () => {
  const many = Array.from({ length: 245 }, (_, i) => '- Archive point ' + i);
  const old = ['## North', ...many, '- Preserve specimen 17.', '## South', '- Withdraw specimen 99.'].join('\n');
  const next = '## North\n- Short summary.\n## South\n- Preserve specimen 17. Different owner.';
  const result = classify({ before: old, after: next, withdrawn: new Set([lineFingerprint('Withdraw specimen 99.')]) });
  const [north, south] = result.after.split('## South');
  for (const point of [...many, '- Preserve specimen 17.']) assert.ok(north.includes(point + '\n'));
  assert.ok(!south.includes('Withdraw specimen'));
  assert.equal(result.outcomes.filter(x => x === 'restored').length, 246);
});

test('a restored region keeps its facts without resurrecting a withdrawn heading', () => {
  const original = '## Withdrawn project title\n- Retained detail.';
  const result = classify({ before: original, after: null, rejected: new Set([lineFingerprint('Withdrawn project title')]) });
  assert.equal(result.after, '- Retained detail.');
});
