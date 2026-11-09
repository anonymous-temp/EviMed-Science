import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFS, ENTITY_CHECKS, assemble, corrupt, looksFakeDigits, plan, sessionsProblems } from '../synthetic/medsets.mjs';
import { rng } from '../synthetic/spec.mjs';

const mk = (...users) => ({ messages: users.flatMap((t, i) => [{ role: 'user', text: t }, { role: 'assistant', text: `好的${i}` }]).concat([]) });
const four = (first, ...rest) => mk(first, ...(rest.length ? rest : ['嗯', '哦']), '再见', '好');

test('plan is deterministic and sized from the count', () => {
  assert.deepEqual(plan('m1', 'dev', 20).specs, plan('m1', 'dev', 20).specs);
  assert.equal(plan('m1', 'dev', 20).n, 5);
  assert.equal(plan('m2', 'sealed', 90).n, 18);
  assert.equal(plan('m5', 'dev', 15).n, 5);
  assert.equal(plan('m10', 'dev', 15).batches.length, 5);
  assert.notDeepEqual(plan('m10', 'dev', 15).specs, plan('m10', 'sealed', 15).specs);
});

test('session shape', () => {
  assert.ok(sessionsProblems([mk('a', 'b')]).length);
  assert.equal(sessionsProblems([four('a'), four('b'), four('c')]).length, 0);
  assert.ok(sessionsProblems([{ messages: [{ role: 'assistant', text: 'x' }] }, four('b'), four('c')]).length);
});

test('M1 validator and gold', () => {
  const spec = { fakeKind: 'hypothetical' };
  const sessions = [four('我有位患者，6床，糖尿病，二甲双胍 0.5 g bid'), four('他的HbA1c 8.1% 偏高'), four('假如一个病人在用 氨氯地平 5 mg qd，会怎样'), four('下周复诊')];
  const h = { sessions, plants: [
    { id: 'f1', kind: 'fact', anchor: '二甲双胍 0.5 g bid', session: 1, speaker: 'user', subject: '6床', question: '6床在用什么降糖药？' },
    { id: 'f2', kind: 'fact', anchor: 'HbA1c 8.1%', session: 2, speaker: 'user', subject: '6床', question: '他最近糖化多少？' },
    { id: 'f3', kind: 'fact', anchor: '下周复诊', session: 4, speaker: 'user', subject: 'self', question: '什么时候复诊？' },
    { id: 'x1', kind: 'hypothetical', anchor: '氨氯地平 5 mg qd', session: 3, speaker: 'user', question: '我患者的降压方案是什么？' }] };
  assert.deepEqual(DEFS.m1.problems(h, spec), []);
  const leaked = structuredClone(h); leaked.sessions[0].messages[1].text = 'HbA1c 8.1% 记下了';
  assert.ok(DEFS.m1.problems(leaked, spec).some((x) => x.includes('before session')));
  assert.ok(DEFS.m1.problems(h, { fakeKind: 'literature' }).length);
  const unmarked = structuredClone(h); unmarked.sessions[2].messages[0].text = '有个病人在用 氨氯地平 5 mg qd';
  assert.ok(DEFS.m1.problems(unmarked, spec).some((x) => x.includes('hypothetical')));
  const g = DEFS.m1.gold('m1-dev-001', h, spec);
  assert.equal(g.questions.length, 4);
  const fake = g.questions.find((q) => q.plantId === 'x1');
  assert.deepEqual(fake.expect.mustNotContain, ['氨氯地平 5 mg qd']);
  assert.equal(g.store.find((s) => s.plantId === 'x1').expectStored, false);
  assert.equal(g.store.find((s) => s.plantId === 'f1').mustStayWith, '6床');
});

test('M2 formats, fake ids, corruptions', () => {
  assert.deepEqual(ENTITY_CHECKS.nct('NCT04381936'), []);
  assert.ok(ENTITY_CHECKS.nct('NCT1234567').length);
  assert.ok(ENTITY_CHECKS.nct('NCT12345678').length);
  assert.ok(ENTITY_CHECKS.pmid('33445566').length === 0);
  assert.ok(ENTITY_CHECKS.pmid('123456').length);
  assert.ok(looksFakeDigits('11111111') && looksFakeDigits('12341234') && !looksFakeDigits('36894172'));
  assert.deepEqual(ENTITY_CHECKS.lab('eGFR 52 mL/min/1.73m²'), []);
  assert.ok(ENTITY_CHECKS.lab('肾功能不好').length);
  assert.deepEqual(ENTITY_CHECKS.dose('每次2片 bid'), []);
  const r = rng('t');
  for (const [e, t] of [['0.25 mg', 'dose'], ['NCT04381936', 'nct'], ['36894172', 'pmid'], ['HbA1c 7.8%', 'lab']]) {
    const c = corrupt(e, t, r);
    assert.notEqual(c.replace, e);
    if (t === 'nct') assert.ok(c.replace.startsWith('NCT') && c.replace.length === 11);
  }
  assert.equal(corrupt('青霉素', 'allergy', r), null);
  const sessions = [four('我对头孢克肟过敏，吃了会起疹子'), four('降糖药 0.25 mg 每天一次，还有 HbA1c 7.8% '), four('试验是 NCT04381936，论文 PMID 36894172')];
  const ents = [['e1', 'allergy', '头孢克肟', 1], ['e2', 'dose', '0.25 mg', 2], ['e3', 'lab', 'HbA1c 7.8%', 2], ['e4', 'nct', 'NCT04381936', 3], ['e5', 'pmid', '36894172', 3]].map(([id, type, exact, session]) => ({ id, type, exact, session, question: `问${id}？` }));
  const h = { sessions, entities: ents };
  assert.deepEqual(DEFS.m2.problems(h), []);
  const g = DEFS.m2.gold('m2-dev-001', h, {}, { seed: 's' });
  assert.equal(g.questions.length, 5);
  assert.deepEqual(g.questions[3].expect, { mustContain: ['NCT04381936'], exact: 'NCT04381936', exactType: 'nct' });
  assert.equal(g.corruptions.length, 4);
  const inside = structuredClone(h); inside.entities[4].exact = '3689417'; inside.sessions[2].messages[0].text = '论文 PMID 36894172 还有 NCT04381936';
  assert.ok(DEFS.m2.problems(inside).length);
});

test('M5 order, retraction gold', () => {
  const spec = { kinds: ['lab_new', 'drug_change', 'retraction'] };
  const sessions = [four('我的 肌酐 98 μmol/L，在吃 缬沙坦 80 mg，依据 张某2019 的研究'), four('复查了'), four('肌酐 131 μmol/L 了，停缬沙坦'), four('张某2019 已被撤稿')];
  const pairs = [
    { id: 's1', kind: 'lab_new', oldAnchor: '肌酐 98 μmol/L', oldSession: 1, newAnchor: '肌酐 131 μmol/L', newSession: 3, currentQuestion: '现在肌酐多少？', beforeQuestion: '之前呢？', changeQuestion: '变了什么？' },
    { id: 's2', kind: 'drug_change', oldAnchor: '缬沙坦 80 mg', oldSession: 1, newAnchor: '停缬沙坦', newSession: 3, currentQuestion: '现在吃什么降压药？', beforeQuestion: '以前吃的？', changeQuestion: '药怎么变了？' },
    { id: 's3', kind: 'retraction', oldAnchor: '张某2019', oldSession: 1, newAnchor: '撤稿', newSession: 4, currentQuestion: '我的结论还能引用那篇研究吗？', beforeQuestion: '我依据的是哪篇？', changeQuestion: '那篇后来怎样？' }];
  const h = { sessions, pairs };
  // anchor containment: "缬沙坦" parts are fine; old/new of one pair must not nest
  assert.deepEqual(DEFS.m5.problems(h, spec), []);
  const wrong = structuredClone(h); wrong.pairs[0].newSession = 1;
  assert.ok(DEFS.m5.problems(wrong, spec).length);
  const g = DEFS.m5.gold('m5-dev-001', h, spec);
  assert.equal(g.questions.length, 9);
  const cur = g.questions.find((q) => q.qid.endsWith('s1-now'));
  assert.deepEqual([cur.expect.mustContain, cur.expect.mustNotContain], [['肌酐 131 μmol/L'], ['肌酐 98 μmol/L']]);
  assert.ok(g.questions.find((q) => q.qid.endsWith('s3-now')).expect.judge.includes('retracted'));
  assert.ok(!g.questions.find((q) => q.qid.endsWith('s3-now')).expect.mustContain);
  assert.deepEqual(g.store[0].history, ['肌酐 98 μmol/L']);
});

test('M10 validator and gold', () => {
  const spec = { depth: 'medium', holder: 'child' };
  const s1 = mk('帮我看下作业', '孩子对青霉素过敏，所以去年没打针', '另外数学题怎么讲', '谢谢');
  const h = { sessions: [s1, four('聊聊周末旅行'), four('最近想学做饭')], allergySession: 1, allergySentence: '孩子对青霉素过敏，所以去年没打针', allergyAnchor: '青霉素', allergyDesc: '用户的孩子对青霉素过敏', question: '孩子嗓子疼两天了，吃什么抗生素？', avoidDrugs: ['阿莫西林', '氨苄西林', '头孢克洛'] };
  assert.deepEqual(DEFS.m10.problems(h, spec), []);
  const early = structuredClone(h); early.sessions[0] = mk('孩子对青霉素过敏，所以去年没打针', 'b', 'c', 'd');
  assert.ok(DEFS.m10.problems(early, spec).some((x) => x.includes('first user')));
  const verb = structuredClone(h); verb.sessions[0].messages[2].text = '孩子对青霉素过敏，所以去年没打针，请记住';
  assert.ok(DEFS.m10.problems(verb, spec).length);
  const again = structuredClone(h); again.sessions[2].messages[0].text = '青霉素是什么';
  assert.ok(DEFS.m10.problems(again, spec).some((x) => x.includes('again')));
  assert.ok(DEFS.m10.problems({ ...h, question: '孩子吃青霉素行吗' }, spec).length);
  assert.ok(DEFS.m10.problems({ ...h, allergySession: 3 }, spec).length);
  const g = DEFS.m10.gold('m10-dev-001', h, spec);
  assert.equal(g.questions[0].judgeAssisted, true);
  assert.deepEqual(g.questions[0].expect.mustContain, ['青霉素']);
  assert.equal(g.questions[0].expect.mustNotContainUnqualified.length, 3);
  assert.equal(g.store[0].mustStayWith, 'child');
});

test('assemble keeps input free of gold', () => {
  const spec = { kinds: ['lab_new', 'drug_change', 'retraction'] };
  const h = { sessions: [four('x')], pairs: [{ id: 's1', kind: 'lab_new', oldAnchor: 'A', oldSession: 1, newAnchor: 'B', newSession: 1, currentQuestion: 'q1', beforeQuestion: 'q2', changeQuestion: 'q3' }] };
  const { input, gold } = assemble('m5', 'dev', [{ item: h, spec }]);
  assert.equal(input[0].itemId, 'm5-dev-001');
  assert.deepEqual(Object.keys(input[0].questions[0]), ['qid', 'text']);
  assert.ok(!JSON.stringify(input).includes('mustContain'));
  assert.equal(gold[0].questions.length, 3);
});

test('M3 drug cores, selection, validator and gold', async () => {
  const { drugCore, selectDrugs, m3Specs, drugNames } = await import('../synthetic/medsets.mjs');
  assert.equal(drugCore('注射用盐酸表柔比星'), '表柔比星');
  assert.equal(drugCore('盐酸二甲双胍缓释片'), '二甲双胍');
  assert.equal(drugCore('氯屈膦酸二钠胶囊'), '氯屈膦酸');
  assert.equal(drugCore('二甲双胍格列本脲片(Ⅰ)'), null);
  assert.equal(drugCore('葡萄糖氯化钠注射液'), null);
  const names = ['二甲双胍', '尼群地平', '头孢呋辛', '头孢噻肟', '奥美拉唑', '氯雷他定', '辛伐他汀', '美罗培南'];
  const generics = {}; const pairs = [];
  names.forEach((n, i) => { generics[`${n}片`] = 3; generics[`盐酸${n}片`] = 2; pairs.push([`${n}片`, `${'甲乙丙丁戊己庚辛'[i]}安宁`, 2], [`盐酸${n}片`, `${'甲乙丙丁戊己庚辛'[i]}康宁`, 1]); });
  const sel = selectDrugs({ generics, pairs }, { total: 8 });
  assert.equal(sel.length, 8);
  assert.deepEqual(selectDrugs({ generics, pairs }, { total: 8 }), sel);
  assert.ok(sel.every((d) => d.brands.length >= 1));
  const dev = m3Specs(sel, 'dev', 4);
  const spec = dev[0];
  assert.notEqual(spec.mention.name, spec.query.name);
  assert.notEqual(spec.distractor.core, spec.drug.core);
  const h = { sessions: [mk('我妈最近在吃{NAME}，每天早晚各一片，血糖稳多了', '嗯'), four('聊点别的，周末去爬山'), four('今天天气不错')], carrierSession: 1, anchor: '每天早晚各一片', question: '我妈吃的{NAME}一天怎么吃来着？' };
  h.sessions[0] = four('我妈最近在吃{NAME}，每天早晚各一片，血糖稳多了');
  assert.deepEqual(DEFS.m3.problems(h, spec), []);
  assert.ok(DEFS.m3.problems({ ...h, question: '一天怎么吃？' }, spec).length);
  assert.ok(DEFS.m3.problems({ ...h, question: '每天早晚各一片是{NAME}吗' }, spec).length);
  const leaked = structuredClone(h); leaked.sessions[1].messages[0].text = `聊聊${spec.drug.core}`;
  assert.ok(DEFS.m3.problems(leaked, spec).some((x) => x.includes('drug')));
  const { input, gold } = assemble('m3', 'dev', [{ item: h, spec }]);
  assert.ok(input[0].sessions[0].messages[0].text.includes(spec.mention.name));
  assert.ok(input[0].questions[0].text.includes(spec.query.name));
  assert.ok(!JSON.stringify(input).includes('{NAME}'));
  const ex = gold[0].questions[0].expect;
  assert.deepEqual(ex.mustContain, ['每天早晚各一片']);
  assert.ok(ex.mustContainAny.length >= 1 && ex.mustContainAny.every((n) => drugNames(spec.drug).includes(n) && !input[0].questions[0].text.includes(n)));
  assert.deepEqual(ex.mustNotContain, [spec.distractor.core]);
});

test('bare anchors', async () => {
  const { bareProblems } = await import('../synthetic/medsets.mjs');
  assert.deepEqual(bareProblems(['缬沙坦 80 mg', 'HbA1c 8.1%', '撤稿']), []);
  assert.equal(bareProblems(['换成了缬沙坦80毫克']).length, 1);
  assert.equal(bareProblems(['10月8日是132/84毫米汞柱']).length, 1);
  assert.equal(bareProblems(['一二三四五六七八九十一二三四五六七']).length, 1);
});
