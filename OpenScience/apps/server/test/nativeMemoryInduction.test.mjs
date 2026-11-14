import assert from 'node:assert/strict';
import test from 'node:test';
import { choiceRows, choiceKey, inferredChoiceMessage, closePersonNames, confirmedAliases, aliasVariants } from '../src/nativeMemoryInduction.mjs';

const row = { kind: 'format', scope: 'results tables', choice: 'Markdown', subject: 'work' };
test('choice identity ignores topic filenames and formatting, retaining numbers and names', () => {
  assert.equal(choiceKey(row), choiceKey({ ...row, choice: 'Ｍarkdown ' }));
  assert.notEqual(choiceKey({ ...row, choice: '140 characters' }), choiceKey({ ...row, choice: '150 characters' }));
  assert.notEqual(choiceKey({ ...row, choice: '1 40' }), choiceKey({ ...row, choice: '140' }));
  assert.deepEqual(choiceRows(`- Choice: ${JSON.stringify(row)}`), [row]);
  for (const subject of ['person', 'health', 'money', 'belief', 'unknown']) assert.deepEqual(choiceRows(`- Choice: ${JSON.stringify({ ...row, subject })}`), []);
  assert.deepEqual(choiceRows('- A person prefers Markdown'), []);
});
test('promotion is explicitly inferred, dated and lower priority than a stated preference', () => {
  const words = inferredChoiceMessage(row, ['2026-11-12', '2026-11-14'], 2);
  assert.match(words, /Inferred from behaviour/);
  assert.match(words, /2 conversations/);
  assert.match(words, /2026-11-12, 2026-11-14/);
  assert.match(words, /stated preference takes precedence/);
});
test('close names produce candidates, never confirmed identity', () => {
  for (const pair of [['王阿姨', '小王阿姨'], ['大王阿姨', '小王阿姨'], ['Alice', 'Alicia'], ['王阿姨', '敬老院王阿姨']]) assert.equal(closePersonNames(...pair), true);
  assert.equal(closePersonNames('王阿姨', '陈主任'), false);
  assert.deepEqual(confirmedAliases('# 王阿姨\nPossibly the same person: 小王阿姨'), []);
  assert.deepEqual(confirmedAliases('- Confirmed aliases: ["王阿姨","小王阿姨"]'), ['王阿姨', '小王阿姨']);
  assert.deepEqual(aliasVariants('王阿姨喜欢散步', ['王阿姨', '小王阿姨']), ['王阿姨喜欢散步', '小王阿姨喜欢散步']);
});

test('a merge requires an explicit extraction marker grounded in a user quote', async () => {
  const { confirmedAliasRequest } = await import('../src/nativeMemoryInduction.mjs');
  const body = '- Confirmed aliases: ["王阿姨","小王阿姨"]\n- Alias confirmation: "王阿姨和小王阿姨是同一个人"';
  assert.deepEqual(confirmedAliasRequest(body, [{ role: 'user', text: '王阿姨和小王阿姨是同一个人' }]), ['王阿姨', '小王阿姨']);
  assert.deepEqual(confirmedAliasRequest(body, [{ role: 'assistant', text: '王阿姨和小王阿姨是同一个人' }]), []);
  assert.deepEqual(confirmedAliasRequest(body, [{ role: 'user', text: '王阿姨喜欢散步，小王阿姨喜欢读书' }]), []);
  assert.deepEqual(confirmedAliasRequest('# 王阿姨', [{ role: 'user', text: '王阿姨和小王阿姨是同一个人' }]), []);
});
