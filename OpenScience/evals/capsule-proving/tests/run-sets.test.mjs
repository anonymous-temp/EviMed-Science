import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DEFAULT_DATA_DIR, SET_LOADERS, assertCase, makeCase, streamArrayElements, toIso } from '../run/sets.mjs';

const DATA = process.env.CAPSULE_PROVING_DATA ?? DEFAULT_DATA_DIR;
const HAVE_DATA = existsSync(DATA);
const SKIP = HAVE_DATA ? false : `data directory ${DATA} is absent (set CAPSULE_PROVING_DATA)`;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function stats(cases) {
  const sessions = sum(cases.map((c) => c.sessions.length));
  const questions = sum(cases.map((c) => c.questions.length));
  const chars = sum(cases.flatMap((c) => c.sessions.flatMap((s) => s.messages.map((m) => m.text.length))));
  const materialChars = sum(cases.flatMap((c) => c.sessions.flatMap((s) => (s.attachments ?? []).map((a) => a.text.length))));
  return { cases: cases.length, sessions, questions, chars, materialChars };
}
function report(set, cases) {
  const s = stats(cases);
  console.log(`# ${set}: cases=${s.cases} sessions=${s.sessions} questions=${s.questions} sessionChars=${s.chars} materialChars=${s.materialChars}`);
  return s;
}
async function load(set, options = {}) {
  const cases = await SET_LOADERS[set]({ split: 'dev', dataDir: DATA, ...options });
  for (const c of cases) assertCase(c);
  assert.equal(new Set(cases.map((c) => c.caseId)).size, cases.length, 'caseIds are unique');
  assert.ok(cases.every((c) => c.set === set && c.split === 'dev'));
  return cases;
}

test('assertCase accepts a well-formed case and rejects forbidden keys and bad shapes', () => {
  const good = makeCase({ caseId: 'x', set: 'm6', split: 'dev', userKey: 'x',
    rawSessions: [{ messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: '' }, { role: 'assistant', text: 'hello' }] }],
    rawQuestions: [{ qid: 'x-q', text: 'q?' }] });
  assert.equal(good.sessions[0].messages.length, 2, 'empty messages are dropped');
  assert.equal(good.sessions[0].sessionId, 's001');
  assert.equal(good.questions[0].afterSession, 1);
  assertCase(good);
  assert.throws(() => assertCase({ ...good, gold: 'x' }), /forbidden/);
  assert.throws(() => assertCase({ ...good, questions: [{ ...good.questions[0], mustContain: ['a'] }] }), /forbidden/);
  assert.throws(() => assertCase({ ...good, sessions: [{ ...good.sessions[0], attachments: [{ afterMessage: 0, kind: 'document', title: '', text: 't', secret: 's' }] }] }), /forbidden/);
  assert.throws(() => assertCase({ ...good, sessions: [{ ...good.sessions[0], at: '2026-03-07' }] }), /ISO/);
  assert.throws(() => assertCase({ ...good, questions: [{ ...good.questions[0], afterSession: 9 }] }), /afterSession/);
  assert.throws(() => assertCase({ ...good, questions: [] }), /question/);
});

test('attachment positions follow the kept messages when empty ones are dropped', () => {
  const c = makeCase({ caseId: 'x', set: 'g9', split: 'dev', userKey: 'x',
    rawSessions: [{ messages: [{ role: 'user', text: '' }, { role: 'user', text: 'look' }, { role: 'assistant', text: 'ok' }],
      attachments: [{ afterMessage: 2, kind: 'document', title: 't', text: 'body' }] }],
    rawQuestions: [{ qid: 'q', text: 'q?' }] });
  assert.equal(c.sessions[0].attachments[0].afterMessage, 1);
});

test('toIso reads the public date spellings', () => {
  assert.equal(toIso('2023/05/30 (Tue) 23:40'), '2023-05-30T23:40:00.000Z');
  assert.equal(toIso('2024-12-20'), '2024-12-20T00:00:00.000Z');
  assert.equal(toIso('2120-08-06 20:15:00'), '2120-08-06T20:15:00.000Z');
  assert.equal(toIso('2026-03-07T02:53:48.000Z'), '2026-03-07T02:53:48.000Z');
  assert.equal(toIso('no date'), null);
});

test('streamArrayElements picks wanted elements out of a big array without parsing the rest', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sets-stream-'));
  const file = join(dir, 'a.json');
  const rows = Array.from({ length: 40 }, (_, i) => ({ question_id: `q${i}`, text: `}{"\\" 中文 ${'x'.repeat(i * 300)}`, nested: [{ a: ['}', ']'] }] }));
  writeFileSync(file, JSON.stringify(rows, null, 4));
  const got = await streamArrayElements(file, new Set(['q3', 'q39']));
  assert.deepEqual([...got.keys()].sort(), ['q3', 'q39']);
  assert.deepEqual(got.get('q39'), rows[39]);
});

const EXPECT = [
  ['scenarios', { cases: 20, questions: 80 }],
  ['med-m1', { cases: 5 }], ['med-m2', { cases: 6 }], ['med-m3', { cases: 30 }], ['med-m5', { cases: 5 }], ['med-m10', { cases: 15 }],
  ['g9', { cases: 25, questions: 25 }],
  ['m7', { cases: 8, questions: 16 }],
  ['brand-generic', { cases: 111, questions: 111 }],
  ['medmemorybench', { questions: 120 }],
  ['medlocomo', { questions: 120 }],
];
for (const [set, want] of EXPECT) {
  test(`${set}: dev split loads, matches the inventory and passes assertCase`, { skip: SKIP }, async () => {
    const cases = await load(set);
    const s = report(set, cases);
    for (const [k, v] of Object.entries(want)) assert.equal(s[k], v, `${set} ${k}`);
  });
}

test('m6: every item has a with-memory and a without-memory case', { skip: SKIP }, async () => {
  const cases = await load('m6');
  const s = report('m6', cases);
  assert.equal(s.cases, 20);
  const arms = cases.map((c) => c.arm).sort();
  assert.deepEqual([...new Set(arms)], ['with-memory', 'without-memory']);
  assert.equal(new Set(cases.map((c) => c.itemId)).size, 10);
  assert.ok(cases.filter((c) => c.arm === 'without-memory').every((c) => c.sessions.length === 0));
  assert.ok(cases.filter((c) => c.arm === 'with-memory').every((c) => c.sessions.length > 0));
  assert.equal(new Set(cases.map((c) => c.userKey)).size, 20);
});

test('m11: each item has a control case with no sessions and the same question', { skip: SKIP }, async () => {
  const cases = await load('m11');
  const s = report('m11', cases);
  assert.equal(s.cases, 20);
  const controls = cases.filter((c) => c.control);
  assert.equal(controls.length, 10);
  for (const control of controls) {
    assert.equal(control.sessions.length, 0);
    const main = cases.find((c) => c.caseId === control.itemId);
    assert.equal(main.control, false);
    assert.equal(control.questions[0].text, main.questions[0].text);
    assert.notEqual(control.userKey, main.userKey);
  }
});

test('g9: poison material stays an attachment, never a user message', { skip: SKIP }, async () => {
  const cases = await load('g9');
  const withMaterial = cases.filter((c) => c.sessions.some((s) => s.attachments?.length));
  assert.equal(withMaterial.length, 15);
  for (const c of withMaterial) {
    const attachments = c.sessions.flatMap((s) => s.attachments ?? []);
    assert.equal(attachments.length, 1);
    assert.ok(['document', 'web', 'tool', 'paste'].includes(attachments[0].kind));
    const s = c.sessions.find((x) => x.attachments?.length);
    assert.ok(s.attachments[0].afterMessage >= 1 && s.messages[s.attachments[0].afterMessage - 1].role === 'user');
    for (const x of c.sessions) for (const m of x.messages) assert.ok(!m.text.includes(attachments[0].text.slice(0, 60)));
    // the final user message that repeated the question is not part of the history
    assert.notEqual(c.sessions.at(-1).messages.at(-1).text, c.questions[0].text);
  }
});

test('m7: memory seeded as sessions, two requests, no scorer fields', { skip: SKIP }, async () => {
  const cases = await load('m7');
  report('m7', cases);
  for (const c of cases) {
    assert.deepEqual(c.questions.map((q) => q.qid.split('-').pop()), ['full', 'partial']);
    assert.ok(c.sessions.length >= 1);
    assert.ok(c.questions.every((q) => q.afterSession === c.sessions.length));
  }
});

test('g6: 450 items in 30 groups with probe questions that never hold the secret', { skip: SKIP }, async () => {
  const cases = await load('g6');
  const s = report('g6', cases);
  assert.equal(s.cases, 30);
  assert.equal(s.sessions, 450);
  assert.equal(s.questions, 450);
  const items = JSON.parse((await import('node:fs')).readFileSync(`${DATA}/g6/items.json`, 'utf8')).items;
  const secrets = new Map(items.map((it) => [`${it.id}-probe`, it.secret]));
  for (const c of cases) {
    assert.equal(c.sessions.length, 15);
    for (const q of c.questions) {
      assert.equal(q.text, '');
      assert.equal(q.probe[0].name, 'search');
      assert.equal(q.probe[0].args.limit, 5);
      assert.ok(!JSON.stringify(q).includes(secrets.get(q.qid)));
      assert.equal(q.afterSession, 15);
    }
  }
  assert.equal(cases[0].userKey, 'g6-u01');
  assert.equal(cases.at(-1).userKey, 'g6-u30');
});

test('longmemeval-s: dev questions with dated sessions in order', { skip: SKIP }, async () => {
  const cases = await load('longmemeval-s');
  const s = report('longmemeval-s', cases);
  assert.equal(s.cases, 120);
  assert.equal(s.questions, 120);
  for (const c of cases) {
    assert.equal(c.questions[0].afterSession, c.sessions.length);
    assert.ok(c.sessions.length > 1);
  }
});

test('medmemorybench: the en variant needs dialogues that are not derived locally and says so', { skip: SKIP }, async () => {
  await assert.rejects(SET_LOADERS.medmemorybench({ split: 'dev', dataDir: DATA, variant: 'en' }), /not derived locally|does not exist/);
});

test('only filters by case id or item id', { skip: SKIP }, async () => {
  const cases = await SET_LOADERS.m11({ split: 'dev', dataDir: DATA, only: ['m11-dev-001'] });
  assert.deepEqual(cases.map((c) => c.caseId).sort(), ['m11-dev-001', 'm11-dev-001:control']);
});
