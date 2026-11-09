import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseSha, checkProblems, deriveGold, kindTrio, longestCommon, requestsProblems, ruleProblems, rulesProblems, runtimeInput, secretShaped, seedProblems, simulateUserTurn, simulateUserTurnDetailed } from '../synthetic/learnsets.mjs';

const rule = (id, check, pass, fail) => ({ id, description: `规则${id}`, check, passExample: pass, failExample: fail, correctionFirst: `${id}不对`, correctionClear: `${id}必须按规则来，请严格照做` });
const rules = () => [
  rule('r1', { kind: 'startsWith', value: '结论：' }, '结论：可以。', '可以的。'),
  rule('r2', { kind: 'maxChars', value: '30' }, '好的。', '这是一段很长的回复'.repeat(10)),
  rule('r3', { kind: 'pattern', value: '\\d{4}/\\d{2}/\\d{2}' }, '截止 2026/11/09', '截止 2026年11月9日'),
];
const base = () => ({
  persona: { name: '甲', occupation: '会计', city: '杭州', bio: '稳重。' }, projectA: { title: 'A', goal: 'a' }, projectB: { title: 'B', goal: 'b' },
  rules: rules(), combinedExample: '结论：2026/11/09 完成。',
});
const reqs = () => ({
  sessions: Array.from({ length: 12 }, (_, i) => ({ request: `请帮我整理第${i}份材料，内容如下一二三四五六七`, rules: [['r1', 'r2'], ['r2', 'r3'], ['r3', 'r1']][i % 3] })),
  frozen: Array.from({ length: 3 }, (_, i) => ({ request: `新任务第${i}个需要处理的事情内容详情，请按材料认真完成它` })),
  probes: Array.from({ length: 2 }, (_, i) => ({ request: `项目B里请帮我写第${i}首短诗送给远方的朋友好吗`, unnaturalFor: ['r1', 'r2'] })),
});
const person = () => ({ id: 'D01', ...base(), ...reqs() });

test('rules validate and each failure is caught', () => {
  assert.deepEqual(rulesProblems(base(), ['startsWith', 'maxChars', 'pattern']), []);
  const wrongPass = base(); wrongPass.rules[0].passExample = '可以的。';
  assert.match(rulesProblems(wrongPass).join(), /passExample does not pass/);
  const wrongFail = base(); wrongFail.rules[1].failExample = '短';
  assert.match(rulesProblems(wrongFail).join(), /failExample does not fail/);
  const clash = base(); clash.combinedExample = '可以的。';
  assert.match(rulesProblems(clash).join(), /combinedExample does not satisfy r1/);
  const kind = base();
  assert.match(rulesProblems(kind, ['table', 'maxChars', 'pattern']).join(), /must use check kind table/);
  const judge = base(); judge.rules[0].check = { kind: 'judge', rubric: 'x' };
  assert.match(rulesProblems(judge).join(), /check.kind must be one of/);
  assert.match(checkProblems({ kind: 'pattern', value: '(' }).join(), /valid regular/);
  assert.match(checkProblems({ kind: 'maxChars', value: '5' }).join(), /between 20 and 300/);
  const same = rule('r1', { kind: 'maxChars', value: '30' }, '好', '很长'.repeat(30)); same.correctionClear = '短';
  assert.match(ruleProblems(same).join(), /clearer, longer/);
});

test('requests: coverage, probes and rule text', () => {
  const r = rules();
  assert.deepEqual(requestsProblems(reqs(), r), []);
  const thin = reqs(); thin.sessions.forEach((s) => { s.rules = ['r1']; });
  assert.match(requestsProblems(thin, r).join(), /rule r2 applies in only 0/);
  const leak = reqs(); leak.probes[0].request = '请以结论：开头写一首诗给朋友吧';
  assert.match(requestsProblems(leak, r).join(), /contains the rule text/);
  const noUn = reqs(); noUn.probes[1].unnaturalFor = [];
  assert.match(requestsProblems(noUn, r).join(), /unnaturalFor/);
  const dup = reqs(); dup.frozen[1].request = dup.frozen[0].request;
  assert.match(requestsProblems(dup, r).join(), /duplicate/);
});

test('gold comes from structure and keeps runtime input clean', () => {
  const p = person();
  const g = deriveGold(p);
  assert.equal(g.sessions.length, 12);
  assert.deepEqual(g.sessions[0].checks.map((c) => c.ruleId), ['r1', 'r2']);
  assert.equal(g.frozen[0].checks.length, 3);
  assert.deepEqual(g.probes[0].leakChecks.map((c) => [c.ruleId, c.unnatural]), [['r1', true], ['r2', true], ['r3', false]]);
  const input = JSON.stringify(runtimeInput(p));
  for (const leaked of ['结论：', 'correction', 'unnaturalFor', '规则r1', 'passExample']) assert.ok(!input.includes(leaked));
});

test('simulated user: silent on pass, first then clear, only applicable rules', () => {
  const p = person();
  assert.equal(simulateUserTurn(p, 0, '结论：好。'), null);
  assert.equal(simulateUserTurn(p, 0, '结论：' + '长'.repeat(50)), 'r2不对');
  assert.equal(simulateUserTurn(p, 0, '没有开头。', []), 'r1不对');
  assert.match(simulateUserTurn(p, 0, '没有开头。', ['r1']), /严格照做/);
  // session 1 applies r2 and r3 only: a missing opening is not corrected
  assert.equal(simulateUserTurn(p, 1, '好的。 2026/11/09'), null);
  assert.deepEqual(simulateUserTurnDetailed(p, 1, '好的。', ['r3']), { line: 'r3必须按规则来，请严格照做', ruleId: 'r3', level: 'clear' });
  assert.equal(simulateUserTurn(p, 99, 'x'), null);
});

test('kindTrio gives distinct kinds and varies by person', () => {
  const seen = new Set();
  for (let i = 0; i < 12; i++) { const t = kindTrio(i); assert.equal(new Set(t).size, 3); seen.add(t.join()); }
  assert.ok(seen.size >= 6);
});

const kase = { id: 'G99', kind: 'general', turns: [{ text: '给客户写一封道歉邮件：交付延期两周，原因是供应商缺货。' }], pass_text: 'A ready-to-send email body.' };
const seeds = (n = 10, rel = 3) => ({ statements: Array.from({ length: n }, (_, i) => ({ text: `我偏好第${i}种做法`, relevant: i < rel })) });

test('seed validators', () => {
  assert.deepEqual(seedProblems(seeds(), kase), []);
  assert.match(seedProblems(seeds(5), kase).join(), /need 8-15/);
  assert.match(seedProblems(seeds(10, 1), kase).join(), /2-4 relevant/);
  const third = seeds(); third.statements[0].text = '他喜欢红色';
  assert.match(seedProblems(third, kase).join(), /not first person/);
  const long = seeds(); long.statements[0].text = `我${'很'.repeat(60)}`;
  assert.match(seedProblems(long, kase).join(), /must be under 60/);
  const copy = seeds(); copy.statements[0].text = '我要给客户写一封道歉邮件：交付延期';
  assert.match(seedProblems(copy, kase).join(), /shares/);
  const secret = seeds(); secret.statements[0].text = '我的手机号是13800138000';
  assert.match(seedProblems(secret, kase).join(), /secret-shaped/);
  const med = { ...kase, kind: 'medical' };
  assert.match(seedProblems(seeds(), med).join(), /medical background/);
  const ok = seeds(); ok.statements[0].medical = true;
  assert.deepEqual(seedProblems(ok, med), []);
});

test('helpers', () => {
  assert.equal(longestCommon('abcdef', 'xxcdeyy'), 3);
  assert.ok(secretShaped('邮箱 a@b.com') && secretShaped('密码是abc') && !secretShaped('我住在杭州'));
  assert.notEqual(caseSha(kase), caseSha({ ...kase, turns: [{ text: '改了' }] }));
});

test('requests that already contain a required format are refused', () => {
  const r = rules();
  const x = reqs(); x.sessions[0].request = '请整理 2026/11/09 的材料，内容如下一二三四五六七八';
  assert.match(requestsProblems(x, r).join(), /r3: a request already contains the required format/);
});
