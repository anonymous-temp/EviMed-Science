import assert from 'node:assert/strict';
import test from 'node:test';
import { personConsentRefusal, mergePeopleText, personDecisionRefusal, personPairId } from '../src/nativeMemoryPeople.mjs';
const root = 'viking://user/u-123456789012345678901234';
const a = `${root}/memories/people/王阿姨.md`, b = `${root}/memories/people/小王阿姨.md`;
const confirmation = '王阿姨和小王阿姨是同一个人。';
const request = { root, a, b, confirmation, messages: [{ role: 'user', text: confirmation }] };
test('identity decisions require literal first-party conversation evidence and two own people URIs', () => {
  assert.equal(personDecisionRefusal(request), null);
  for (const patch of [
    { confirmation: '' }, { confirmation: '模型认为是同一个人' }, { messages: [{ role: 'assistant', text: confirmation }] },
    { messages: [] }, { a: b }, { a: a.replace('/people/', '/notes/') },
    { a: a.replace('u-123456789012345678901234', 'u-999999999999999999999999') },
    { a: `${root}/memories/people/../王阿姨.md` }, { a: `${root}/memories/people/%2e%2e.md` },
  ]) assert.ok(personDecisionRefusal({ ...request, ...patch }), JSON.stringify(patch));
});
test('merge preserves dated conflicting values, collapses exact lines, and writes one alias', () => {
  const keep = '# 王阿姨\n## 2026-10-01\n- Weight: 50 kg\n- Likes tea.';
  const other = '# 小王阿姨\n## 2026-11-01\n- Weight: 55 kg\n- Likes tea.';
  const body = mergePeopleText(keep, other, '小王阿姨');
  assert.match(body, /2026-10-01\n- Weight: 50 kg/);
  assert.match(body, /2026-11-01\n- Weight: 55 kg/);
  assert.equal(body.split('- Likes tea.').length, 2);
  assert.equal(body.split('又称：小王阿姨').length, 2);
  assert.equal(mergePeopleText(body, other, '小王阿姨'), body);
});
test('distinct pair identity is symmetric and scoped by full URI', () => {
  assert.equal(personPairId(a, b), personPairId(b, a));
  assert.notEqual(personPairId(a, b), personPairId(a.replace(root, root + 'x'), b));
});

test('a repeated date heading stays attached to new facts instead of inheriting the keeper’s last date', () => {
  const keep = '# 王阿姨\n## 2026-10-01\n- Weight: 50 kg\n## 2026-11-01\n- Weight: 55 kg';
  const other = '# 小王阿姨\n## 2026-10-01\n- Height: 160 cm';
  assert.match(mergePeopleText(keep, other, '小王阿姨'), /## 2026-10-01\n- Height: 160 cm/);
});

test('short consent belongs to the named pair and polarity of the preceding question', () => {
  const question = '“王阿姨”和“小王阿姨”是同一个人吗？';
  assert.equal(personConsentRefusal('王阿姨', '小王阿姨', false, '是', question), null);
  assert.equal(personConsentRefusal('王阿姨', '小王阿姨', true, '不是', question), null);
  for (const [confirmation, prompt] of [['不是', question], ['是', ''], ['是', '“王阿姨”和“陈主任”是同一个人吗？']]) {
    assert.ok(personConsentRefusal('王阿姨', '小王阿姨', false, confirmation, prompt));
  }
});

test('a delivered hint permits single-pair questions and exact affirmative replies in several forms', () => {
  const decide = (answer, question, hinted = true, distinct = false) => personConsentRefusal('小明', '王小明', distinct, answer, question, hinted);
  const example = '「小明」和「王小明」是同一个人吗？回复是/不是';
  for (const answer of ['是', '对。', '是的', '没错']) assert.equal(decide(answer, example), null);
  assert.equal(decide('是', '请确认一下：『王小明』与『小明』指的是同一人吗？'), null);
  assert.equal(decide('yes', 'Are "小明" and "王小明" the same person? Reply yes/no.'), null);
  for (const answer of ['可能是', '应该对', '不是', '是吗？', '是，但我不确定', '「是」']) assert.ok(decide(answer, example));
  for (const question of [
    '「小明」和「王小明」是同一个人吗？「林舟」和「林洲」也是同一个人吗？',
    '「小明」和「王小明」是同一个人吗？还有另一对也一起合并吗？',
    '「小明」和「王小明」不是同一个人吗？',
    '「小明」和「陈明」是同一个人吗？',
    '> 「小明」和「王小明」是同一个人吗？',
  ]) assert.ok(decide('是', question));
  assert.ok(decide('是', example, false));
  assert.ok(decide('是', example, true, true));
});

test('a natural reply that shows both cards and ends with one same-person question takes a bare yes; two questions do not', () => {
  const decide = (answer, question) => personConsentRefusal('小明', '王小明医生', false, answer, question, true);
  const natural = '我查了一下两张卡片：\n- 「小明」：骨干，负责门诊排班。\n- 「王小明医生」：全名王小明，心内科。\n请问「小明」和「王小明医生」是同一个人吗？';
  for (const answer of ['是', '对', '没错']) assert.equal(decide(answer, natural), null);
  const twoPairs = natural + '\n另外，「林舟」和「林洲」是同一个人吗？';
  assert.ok(decide('是', twoPairs));
  assert.ok(decide('可能是吧', natural));
  assert.ok(personConsentRefusal('小明', '王小明医生', false, '是', natural, false));
});

test('a natural reply with one same-person question and another question keeps asking for the full decision', () => {
  const natural = '两张卡片如下：\n- 「小明」：骨干。\n- 「王小明医生」：心内科。\n请问「小明」和「王小明医生」是同一个人吗？要不要顺便把别的也合并？';
  assert.ok(personConsentRefusal('小明', '王小明医生', false, '是', natural, true));
});
