import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePeopleText, personDecisionRefusal, personPairId } from '../src/nativeMemoryPeople.mjs';
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
