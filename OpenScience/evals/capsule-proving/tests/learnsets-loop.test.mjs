import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../synthetic/learnsets-loop.mjs';

const reqs = (n, p = '请帮我处理第') => Array.from({ length: n }, (_, i) => `${p}${i}份材料，内容是一些需要核对的细节说明`);

test('L10: chains are assigned by code from a closed list and lookalikes differ', () => {
  for (let i = 0; i < 12; i++) {
    const a = L.l10Assign(i);
    assert.ok(a.chain in L.TOOL_CHAINS);
    assert.equal(a.lookalikeChains.length, 2);
    assert.ok(a.lookalikeChains.every((c) => c in L.TOOL_CHAINS && c !== a.chain));
  }
  const a = L.l10Assign(0);
  const doc = { family: '汇率换算', requests: reqs(4), lookalikes: reqs(2, '另一类') };
  assert.deepEqual(L.l10Problems(doc, a), []);
  assert.match(L.l10Problems({ ...doc, requests: [...reqs(3), '请把结果导出成 Excel 文件给我看看'] }, a).join(), /file/);
  assert.match(L.l10Problems({ ...doc, lookalikes: [doc.requests[0], '另一个完全不同的请求内容在这里'] }, a).join(), /duplicate/);
  assert.deepEqual(L.l10Gold(doc, a).lookalikes.map((x) => x.chain), a.lookalikeChains);
});

test('L5: outdated must hold the retired term, the others must not; safety rules come from the data file', () => {
  const o = L.l5Assign('outdated', 0);
  const ok = { method: { name: 'x', whenToUse: '写报告时', body: `写完后更新 ${o.term}，再交付，并认真检查每一项内容。`.padEnd(70, '。') }, tasks: reqs(3), followUp: '不对' };
  assert.deepEqual(L.l5Problems(ok, o), []);
  assert.match(L.l5Problems({ ...ok, method: { ...ok.method, body: '没有任何旧功能的名字，只是一段普通的做法说明。'.repeat(4) } }, o).join(), /literally contain/);
  const g = L.l5Assign('good', 0);
  assert.match(L.l5Problems(ok, g).join(), /retired feature/);
  const s = L.l5Assign('safety_conflict', 0);
  assert.ok(s.ruleId && s.ruleMessage);
  assert.notEqual(L.l5Assign('safety_conflict', 1).ruleId, s.ruleId);
  assert.match(L.l5Problems({ ...ok, tasks: reqs(2) }, g).join(), /3-5 tasks/);
  assert.deepEqual(L.l5Gold(s, ok), { class: 'safety_conflict', safetyRule: s.ruleId, followUp: 'correction', shouldStop: true, tasks: 3 });
  assert.equal(L.l5Gold(g, ok).shouldStop, false);
});

test('L4: the library repeats, holds the official methods and its gold pairs point at members', () => {
  const base = Array.from({ length: 16 }, (_, i) => ({ id: `official:p/m${i}`, whenToUse: 'w', body: `基础${i}` }));
  const rel = Object.fromEntries(base.map((b) => [b.id, Object.fromEntries(L.L4_RELATIONS.map((k) => [k, { whenToUse: 'w', body: `${b.id}-${k}` }]))]));
  const filler = Array.from({ length: 700 }, (_, i) => ({ id: `f${i}`, source: 'filler', whenToUse: 'w', body: `填充${i}` }));
  for (const size of L.L4_SIZES) {
    const lib = L.buildLibrary(size, base, rel, filler);
    assert.equal(lib.size, size);
    const ids = new Set(lib.methods.map((m) => m.id));
    assert.equal(ids.size, size);
    assert.ok(base.every((b) => ids.has(b.id)));
    assert.ok(lib.gold.every((g) => ids.has(g.a) && ids.has(g.b)));
  }
  assert.equal(L.buildLibrary(50, base, rel, filler).gold.length, 32);
  assert.equal(L.buildLibrary(200, base, rel, filler).gold.length, 64);
  assert.deepEqual(L.buildLibrary(200, base, rel, filler).methods.map((m) => m.id), L.buildLibrary(200, base, rel, filler).methods.map((m) => m.id));
  assert.throws(() => L.buildLibrary(600, base, rel, filler.slice(0, 10)), /filler pool short/);
  const longBody = '这是一条很长很长的原始做法正文，用来测试复述检查是否能发现照抄的情况，务必每一句都不同。'.repeat(2);
  const b0 = { id: 'o', whenToUse: 'w', body: longBody };
  const good = { relatives: { duplicate: { whenToUse: 'w', body: '换个说法重新叙述同一条要求，用词完全不一样但意思相同的内容。加上一些补充，让长度足够。' }, subset: { whenToUse: 'w', body: '更窄的情形。' }, conflict: { whenToUse: 'w', body: '做完全相反的事情，不再遵循任何一条原先的要求。' }, unrelated: { whenToUse: 'w', body: '另一件无关的事。' } } };
  assert.deepEqual(L.l4RelativesProblems(good, b0), []);
  assert.match(L.l4RelativesProblems({ relatives: { ...good.relatives, duplicate: { whenToUse: 'w', body: longBody } } }, b0).join(), /reword/);
  assert.equal(L.officialMethods().length, 16);
});

test('L1: verdicts and trigger conditions come from structure', () => {
  const fixtures = {
    correction: { runs: ['correction', 'accept', 'accept'] },
  };
  const mk = (ring, extra = {}) => {
    const a = L.l1Assign(ring, 0);
    const doc = { topic: 't', runs: a.verdicts.map((_, k) => ({ request: `这是第${k}次请求，需要处理的材料各不相同详见正文`, followUp: '好的', comment: `c${k}`, acceptedReply: '被认可的回复摘录内容' })), program: 'x = 1\nprint(x)\n', method: { before: '旧', after: '新' }, methods: [{ whenToUse: 'w', body: '第一条做法的说明文字' }, { whenToUse: 'w', body: '另一种说法的做法' }], mergedRule: '合并后的规则', ...extra };
    assert.deepEqual(L.l1Problems(doc, a), [], ring);
    return L.l1Script(a, doc);
  };
  for (const ring of L.RINGS) { const s = mk(ring); assert.equal(s.gold.trigger.fired, true, `${ring}: ${s.gold.trigger.reasons}`); assert.deepEqual(s.gold.verdicts, s.runs.map((r) => r.followUp.verdict)); }
  // script: comments differ but the tree hash is one; a different program breaks the trigger
  const sc = mk('script');
  assert.equal(new Set(sc.runs.map((r) => L.pyTreeHash(r.program))).size, 1);
  assert.notEqual(sc.runs[0].program, sc.runs[1].program);
  sc.runs[2].program = 'y = 2\n';
  assert.match(L.l1Trigger(sc).reasons.join(), /tree hash/);
  // routine_file: a differing shape, a correction, a long span each break it
  const rf = mk('routine_file');
  assert.equal(rf.runs.length, 3);
  const broken = structuredClone(rf); broken.runs[1].delivered.shape = 'xlsx-table';
  assert.match(L.l1Trigger(broken).reasons.join(), /shapes differ/);
  const dirty = structuredClone(rf); dirty.runs[2].followUp.verdict = 'correction';
  assert.match(L.l1Trigger(dirty).reasons.join(), /not clean/);
  const spread = structuredClone(rf); spread.runs[2].at = '2027-06-01T00:00:00Z';
  assert.match(L.l1Trigger(spread).reasons.join(), /90 days/);
  // routine_toolchain leaves no file
  const rt = mk('routine_toolchain');
  assert.ok(rt.runs.every((r) => r.delivered.files.length === 0 && r.delivered.chain in L.TOOL_CHAINS));
  // replay regressive flag alternates; sleep duplicates must be rewordings
  assert.equal(L.l1Assign('replay', 0).regressive, true);
  assert.equal(L.l1Assign('replay', 1).regressive, false);
  const sl = mk('sleep');
  sl.methods[0].body = '每次交付之前先把全部数字逐项核对一遍并在结尾写明核对过的范围。'; sl.methods[1].body = sl.methods[0].body;
  assert.match(L.l1Trigger(sl).reasons.join(), /rewordings/);
  // an accept follow-up that sounds like a correction is refused
  const a = L.l1Assign('correction', 0);
  assert.match(L.l1Problems({ runs: [{ request: '一二三四五六七八九十一二三四五六七八九十', followUp: '不对' }, { request: '二二三四五六七八九十一二三四五六七八九十', followUp: '不对，以后注意' }, { request: '三二三四五六七八九十一二三四五六七八九十', followUp: '行' }] }, a).join(), /accept follow-up/);
  // runtime script carries no gold
  const rs = JSON.stringify(L.l1RuntimeScript(mk('adopt')));
  assert.ok(!rs.includes('verdict') && !rs.includes('trigger'));
  assert.ok(Object.keys(fixtures).length);
});
