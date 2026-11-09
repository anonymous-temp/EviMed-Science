import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, COUNTS, anchorWindows, batches, buildCorruptions, buildGold, renderProblems, schedule, skeletonProblems } from '../synthetic/spec.mjs';
import { personaBrief, renderPrompt, repairPrompt, skeletonPrompt } from '../synthetic/prompts.mjs';

/** A skeleton that meets every count, with anchors that cannot collide. */
function fixture(kind = 'general') {
  const plants = [];
  let n = 0;
  for (const [category, count] of Object.entries(COUNTS[kind])) {
    for (let i = 0; i < count; i++) {
      n++;
      const id = `x${String(n).padStart(2, '0')}`;
      const anchor = `A${n}#${100 + n}`;
      const x = { id, category, subject: ['third_party', 'family_medical'].includes(category) ? 'p1' : 'self', attribute: `属性${n}`, value: `事实${n}是${anchor}`, anchor, context: '自然提到', question: `问题${n}？` };
      if (CATEGORIES[category].needsLater) Object.assign(x, { laterValue: `后来是L${n}@${200 + n}`, laterAnchor: `L${n}@${200 + n}`, questionPrevious: `以前${n}？` });
      if (CATEGORIES[category].needsWrong) x.wrongValue = `W${n}!${300 + n}`;
      if (category.startsWith('preference')) x.applyTask = `任务${n}`;
      if (category === 'family_medical') x.selfQuestion = `我自己的${n}？`;
      if (CATEGORIES[category].project) x.projectId = 'j1';
      plants.push(x);
    }
  }
  return {
    persona: { name: '林某', gender: '女', age: 34, city: '杭州', occupation: '会计', bio: '性格温和。' },
    people: [{ id: 'p1', label: '老周（主管）', relation: '上司' }, { id: 'p2', label: '老邹（同事）', relation: '同事' }, { id: 'p3', label: '妈妈', relation: '母亲' }],
    projects: [{ id: 'j1', title: '年度预算', goal: '做完预算表', stageStart: '收集数据', stageLater: '提交审批', constraint: '月底前', stageQuestion: '预算到哪了？' }],
    plants,
    abstentionProbes: Array.from({ length: 4 }, (_, i) => ({ question: `没说过的${i}？` })),
    distractorTopics: Array.from({ length: 40 }, (_, i) => `话题${i}`),
  };
}

test('a complete skeleton has no problems; a broken one names each problem', () => {
  for (const kind of ['general', 'medical', 'medproject']) assert.deepEqual(skeletonProblems(fixture(kind), kind), []);
  const s = fixture();
  s.plants[0].anchor = 'not-in-value';
  s.plants.pop();
  s.persona.bio = `她的${s.plants[3].anchor}。`;
  const p = skeletonProblems(s, 'general');
  assert.ok(p.some((x) => x.includes('anchor is not a substring')));
  assert.ok(p.some((x) => x.includes('want')));
  assert.ok(p.some((x) => x.includes('appears in persona')));
});

test('a project user: every project item names its project, revised decisions are asked current and previous, classes rotate', async () => {
  const s = fixture('medproject');
  const broken = structuredClone(s);
  broken.plants.find((x) => x.category === 'project_decision').projectId = 'j9';
  assert.ok(skeletonProblems(broken, 'medproject').some((x) => x.includes('projectId must name a project')));
  assert.ok(skeletonProblems(s, 'general').some((x) => x.includes('project_decision not wanted')));
  const sched = schedule(s, { seed: 'p', sessions: 30, startDate: '2026-04-01', spanDays: 90 });
  const gold = buildGold('P01', s, sched);
  const revised = s.plants.find((x) => x.category === 'project_decision_changed');
  assert.ok(gold.questions.some((q) => q.plantId === revised.id && q.type === 'current-after-change' && q.projectId === 'j1' && q.expect.mustContain.includes(revised.laterAnchor)));
  assert.ok(gold.store.filter((x) => x.category?.startsWith('project_')).every((x) => x.projectId === 'j1'));
  const { personaSeed, MEDPROJECT_CLASSES } = await import('../synthetic/prompts.mjs');
  const { rng } = await import('../synthetic/spec.mjs');
  const classes = new Set(Array.from({ length: 8 }, (_, i) => personaSeed(rng(`s${i}`), 'medproject', i).projectClass));
  assert.equal(classes.size, MEDPROJECT_CLASSES.length);
  const sp = skeletonPrompt(personaSeed(rng('x'), 'medproject', 2));
  assert.ok(sp.includes('project_decision × 5') && sp.includes('"projectId": "j1"') && sp.includes(MEDPROJECT_CLASSES[2].name));
});

test('the schedule is seeded, ordered and places every event after its introduction', () => {
  const s = fixture('medical');
  const a = schedule(s, { seed: 'x', sessions: 200, startDate: '2026-03-02', spanDays: 120 });
  const b = schedule(s, { seed: 'x', sessions: 200, startDate: '2026-03-02', spanDays: 120 });
  assert.deepEqual(a, b);
  assert.equal(a.sessions.length, 200);
  for (let i = 1; i < a.sessions.length; i++) assert.ok(a.sessions[i].at >= a.sessions[i - 1].at);
  const intro = new Map(a.events.filter((e) => e.kind === 'introduce').map((e) => [e.plantId, e.session]));
  for (const e of a.events) if (e.plantId && e.kind !== 'introduce') assert.ok(e.session > intro.get(e.plantId), `${e.plantId} ${e.kind}`);
  assert.equal(a.checkpoints.at(-1), 200);
});

test('gold comes from the skeleton: code checks carry anchors, judged checks carry a rubric, no answer leaks into input questions', () => {
  const s = fixture('medical');
  const sched = schedule(s, { seed: 'y', sessions: 120, startDate: '2026-04-01', spanDays: 100 });
  const gold = buildGold('U99', s, sched);
  assert.ok(gold.questions.length > 60);
  for (const q of gold.questions) {
    assert.ok(q.expect.mustContain || q.expect.mustNotContain || q.expect.judge, q.qid);
    assert.ok(sched.checkpoints.includes(q.checkpoint), q.qid);
  }
  const secret = s.plants.find((x) => x.category === 'secret');
  assert.ok(gold.questions.some((q) => q.plantId === secret.id && q.expect.mustNotContain?.includes(secret.anchor)));
  assert.ok(gold.store.some((x) => x.plantId === secret.id && x.expectStored === false));
  const changed = s.plants.find((x) => x.category === 'changed');
  assert.ok(gold.questions.some((q) => q.plantId === changed.id && q.type === 'previous' && q.expect.mustContain.includes(changed.anchor)));
  assert.ok(gold.questions.filter((q) => q.type === 'abstain').length === 4);
  const c = buildCorruptions('U99', s, sched, { seed: 'z' });
  assert.ok(c.length > 10 && c.every((x) => x.id.startsWith('U99-e')));
  assert.ok(c.some((x) => x.kind === 'number' && x.find !== x.replace));
});

test('render check: anchors by the right speaker, early leaks caught', () => {
  const s = fixture();
  const sched = schedule(s, { seed: 'w', sessions: 40, startDate: '2026-05-01', spanDays: 60 });
  const windows = anchorWindows(s, sched.events);
  const [group] = batches(sched.sessions, 8);
  const good = { sessions: group.map((p) => ({ id: p.id, messages: [
    { role: 'user', text: `开始 ${p.inserts.filter((i) => i.speaker !== 'assistant').flatMap((i) => i.mustContain.filter((a) => a !== i.wrongValue)).join(' ')}` },
    { role: 'assistant', text: `好的 ${p.inserts.filter((i) => i.speaker === 'assistant' || i.speaker === 'assistant+user').flatMap((i) => i.speaker === 'assistant' ? i.mustContain : [i.wrongValue]).join(' ')}` },
    { role: 'user', text: '嗯' }, { role: 'assistant', text: '好' }] })) };
  assert.deepEqual(renderProblems(group, good, { firstSessionOf: windows }), {});
  const later = [...windows].find(([, k]) => k > group.at(-1).index);
  const leaky = structuredClone(good);
  leaky.sessions[0].messages[2].text = `顺便 ${later[0]}`;
  const p = renderProblems(group, leaky, { firstSessionOf: windows });
  assert.ok(Object.values(p).flat().some((x) => x.startsWith('leak')));
});

test('prompts name every category with its count and keep anchors out of the persona brief', () => {
  const s = fixture('medical');
  const sp = skeletonPrompt({ kind: 'medical', occupation: '药师', city: '成都', ageBand: '30-39', gender: '男', lifeStage: '已婚' });
  for (const [cat, n] of Object.entries(COUNTS.medical)) if (n) assert.ok(sp.includes(`${cat} × ${n}`), cat);
  s.persona.bio = `平时很忙。她记得${s.plants[0].anchor}。`;
  assert.ok(!personaBrief(s).includes(s.plants[0].anchor));
  const sched = schedule(s, { seed: 'v', sessions: 16, startDate: '2026-05-01', spanDays: 20 });
  assert.ok(renderPrompt(s, sched.sessions.slice(0, 8)).includes('只输出一个 JSON 对象'));
  const [one] = sched.sessions;
  const fix = repairPrompt(s, [one], [{ id: one.id, messages: [{ role: 'user', text: '上一版的话' }] }], { [one.id]: ['leak: 这一场不能出现「某词」'] });
  assert.ok(fix.includes('上一版的话') && fix.includes('某词') && fix.includes(one.id));
  assert.ok(!fix.includes(sched.sessions[1].id), 'only the sessions under repair');
});

test('repeated-task checks decide formats only', async () => {
  const { checkReply } = await import('../synthetic/taskChecks.mjs');
  assert.equal(checkReply({ kind: 'pattern', value: '\\d{4}-\\d{2}-\\d{2}' }, '会议定在 2026-11-09 上午'), true);
  assert.equal(checkReply({ kind: 'pattern', value: '\\d{4}-\\d{2}-\\d{2}' }, '会议定在11月9日'), false);
  assert.equal(checkReply({ kind: 'startsWith', value: '结论：' }, '## 结论：可以上线\n依据如下'), true);
  assert.equal(checkReply({ kind: 'maxChars', value: 5 }, '一 二 三 四 五'), true);
  assert.equal(checkReply({ kind: 'table' }, '| a | b |\n|---|---|\n| 1 | 2 |'), true);
  assert.equal(checkReply({ kind: 'table' }, 'a, b'), false);
  assert.equal(checkReply({ kind: 'judge', rubric: 'x' }, 'anything'), null);
});

test('carriers: one slot each, no other number; secrets are placed by type and never by the model', async () => {
  const { carrierProblems, composeSecretItems, SECRET_CARRIER_KINDS } = await import('../synthetic/carriers.mjs');
  const { luhnValid, cnIdChecksumValid } = await import('../synthetic/secrets.mjs');
  const list = (slot, n, tag) => Array.from({ length: n }, (_, i) => `我${tag}的那个是${slot}，第${'一二三四五六七八九十'[i % 10]}${'甲乙丙丁戊己庚辛壬癸'[Math.floor(i / 10) % 10]}句`);
  const good = { markers: list('{marker}', 60, '柜子'), secrets: Object.fromEntries(Object.keys(SECRET_CARRIER_KINDS).map((k) => [k, list('{secret}', 12, k)])) };
  assert.deepEqual(carrierProblems(good), []);
  const bad = structuredClone(good);
  bad.markers[0] = '柜子 {marker} 和 {marker}';
  bad.secrets.cnId[1] = '我的身份证 {secret}，2 张复印件';
  bad.secrets.mobile = bad.secrets.mobile.slice(0, 3);
  const p = carrierProblems(bad);
  assert.ok(p.some((x) => x.includes('exactly once')) && p.some((x) => x.includes('another number')) && p.some((x) => x.includes('want 12')));
  const items = composeSecretItems(good, { seed: 't', count: 90 });
  assert.equal(items.length, 90);
  for (const x of items) {
    assert.ok(x.text.includes(x.secret) && !x.text.includes('{secret}'));
    if (x.type === 'bankCard') assert.ok(luhnValid(x.secret));
    if (x.type === 'cnId') assert.ok(cnIdChecksumValid(x.secret));
  }
});

test('L3 split: exam and learning never share a case; the draw is seeded', async () => {
  const { splitL3 } = await import('../l3-split.mjs');
  const doc = { cases: [
    ...['G01', 'G17', 'G18', 'G19', 'G23'].map((id) => ({ id, kind: 'general', family: 'writing' })),
    ...['G05', 'G11', 'G12'].map((id) => ({ id, kind: 'general', family: 'data' })),
    { id: 'G20', kind: 'general', family: 'scheduled' },
    ...['M01', 'M02'].map((id) => ({ id, kind: 'medical', family: 'medical-qa' })),
  ] };
  const a = splitL3(doc);
  assert.deepEqual(a, splitL3(doc));
  assert.ok(a.exam.every((id) => !a.learning.includes(id)));
  assert.equal(a.exam.filter((id) => id.startsWith('M')).length, 2);
  assert.ok(a.exam.includes('G20'));
  assert.equal(a.exam.filter((id) => ['G01', 'G17', 'G18', 'G19', 'G23'].includes(id)).length, 2);
});

test('public texts: only user-spoken turns, whatever the benchmark calls its fields', async () => {
  const { userTurns } = await import('../synthetic/publicTexts.mjs');
  const got = [...userTurns({ sessions: [
    { dialogue: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'no' }] },
    { dialogue_turns: [{ speaker: 'User', content: 'b' }, { speaker: 'Assistant', content: 'no' }] },
    { conversation: [{ speaker: 'Caroline', text: 'c', dia_id: 'D1:1' }] },
    { toxic: true, turns: [{ role: 'user', text: 'no' }] },
    { toxic: false, turns: [{ role: 'user', text: 'd' }] },
  ] })];
  assert.deepEqual(got, ['a', 'b', 'c', 'd']);
});

test('L6 candidates: a follow-up is a Chinese user turn right after an assistant reply; the sample is seeded', async () => {
  const { followUps, reservoir } = await import('../l6-candidates.mjs');
  const turns = [{ role: 'user', text: '写个标题' }, { role: 'assistant', text: '标题A' }, { role: 'user', text: '太长了，短一点' }, { role: 'assistant', text: 'B' }, { role: 'user', text: 'ok' }];
  const f = followUps(turns);
  assert.equal(f.length, 1);
  assert.equal(f[0].followUp, '太长了，短一点');
  assert.equal(f[0].reply, '标题A');
  async function* gen() { for (let i = 0; i < 5000; i++) yield i; }
  const a = await reservoir(gen(), 50, 's');
  const b = await reservoir(gen(), 50, 's');
  assert.deepEqual(a.kept, b.kept);
  assert.equal(a.seen, 5000);
  assert.ok(Math.max(...a.kept) > 2500, 'late items are drawn too');
});

test('public texts: a line separator inside a turn never splits its JSONL line', async () => {
  const { jsonLine } = await import('../synthetic/publicTexts.mjs');
  const [ls, ps] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
  const line = jsonLine({ source: 'x', text: `a${ls}b${ps}c` });
  assert.ok(!line.includes(ls) && !line.includes(ps));
  assert.equal(JSON.parse(line).text, `a${ls}b${ps}c`);
});

test('verify-data: finds the hash map wherever a manifest keeps it, and a question that already holds its answer', async () => {
  const { hashMap, leaks } = await import('../verify-data.mjs');
  const h = 'a'.repeat(64);
  assert.deepEqual(hashMap({ sha256: { 'input.json': h } }), { 'input.json': h });
  assert.equal(hashMap({ sha256: h }), null);
  const input = { questions: [{ qid: 'q1', text: '我住在哪个区？' }, { qid: 'q2', text: '我住在滨湖区吗？' }] };
  const gold = { questions: [{ qid: 'q1', expect: { mustContain: ['滨湖区'] } }, { qid: 'q2', expect: { mustContain: ['滨湖区'] } }] };
  assert.deepEqual(leaks(input, gold), ['q2']);
});

test('an anchor the question names leaves the substring check for the judge; the skeleton check refuses it', () => {
  const s = fixture();
  const op = s.plants.find((x) => x.category === 'opinion');
  op.question = `我怎么看${op.anchor}？`;
  assert.ok(skeletonProblems(s, 'general').some((x) => x.includes('already contains its answer')));
  const sched = schedule(s, { seed: 'e', sessions: 40, startDate: '2026-05-01', spanDays: 60 });
  const gold = buildGold('U98', s, sched);
  const q = gold.questions.find((x) => x.plantId === op.id && x.type === 'attribution');
  assert.equal(q.expect.mustContain, undefined);
  assert.deepEqual(q.expect.anchorInQuestion, [op.anchor]);
  assert.ok(q.expect.judge.includes(op.value));
  const other = gold.questions.find((x) => x.type === 'recall');
  assert.ok(other.expect.mustContain?.length && !other.expect.anchorInQuestion);
});

test('a spent Kimi usage window is recognised from the CLI error, not counted as a bad answer', async () => {
  const { QUOTA_EXHAUSTED } = await import('../synthetic/kimi.mjs');
  assert.ok(QUOTA_EXHAUSTED.test("no assistant reply (exit 1): d to run prompt: provider.api_error: You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends."));
  assert.ok(!QUOTA_EXHAUSTED.test('JSON parse: Unexpected token'));
});
