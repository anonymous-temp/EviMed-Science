import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPrompt, buildRepairPrompt, docSet, findDuplicate, overlap, runBatch, verifyQuestion } from '../synthetic/xdoc.mjs';

const text = (s) => s;
const A = 'Drug alpha reduced stroke by 20 percent compared with warfarin in 9000 patients over two years.';
const B = 'Drug beta raised major bleeding by 30 percent compared with placebo in 12000 patients over three years.';
const doc = (key, pmid, body) => ({ key, pmid, sourceId: `src_${createHash('sha256').update(`inv/${pmid}`).digest('hex').slice(0, 32)}`, title: `Trial ${key}`, journal: 'J', year: 2020, url: 'u', doi: null, text: text(body), textSha256: createHash('sha256').update(body).digest('hex') });
const topic = {
  id: 'inv', title: 'Invented topic',
  documents: [doc('d1', '1', A), doc('d2', '2', B)],
  questions: [{ id: 'inv-s1', kind: 'synthesis', question: 'How did alpha and beta differ on stroke and bleeding?', reference: { keyPoints: [{ id: 'kp1', text: 'x', support: [{ doc: 'd1', quote: 'reduced stroke by 20 percent' }, { doc: 'd2', quote: 'raised major bleeding by 30 percent' }] }] } }],
};
const good = (question = 'Which agent traded stroke protection against bleeding across the two trials?') => ({
  kind: 'synthesis', question,
  reference: { keyPoints: [
    { id: 'a', text: 'Alpha reduced stroke by about a fifth.', support: [{ doc: 'd1', quote: 'reduced stroke by 20 percent compared with warfarin' }] },
    { id: 'b', text: 'Beta raised major bleeding by about 30 percent.', support: [{ doc: 'd2', quote: 'raised major bleeding by 30 percent compared with placebo' }] },
  ] },
});

test('prompt shape: documents with keys, existing questions, schema, types', () => {
  const p = buildPrompt(topic, { count: 5, taken: ['already taken question'] });
  assert.match(p, /key=d1/); assert.match(p, /key=d2/);
  assert.ok(p.includes(A));
  assert.ok(p.includes('How did alpha and beta differ'));
  assert.ok(p.includes('already taken question'));
  assert.match(p, /verbatim|character for character/);
  assert.match(p, /"kind":"synthesis"/);
  assert.match(p, /Write 5 NEW/);
  const r = buildRepairPrompt(topic, [{ q: good(), problems: ['quote is not verbatim'] }]);
  assert.ok(r.includes('quote is not verbatim')); assert.ok(r.includes(B));
});

test('duplicate detection needs the same documents and high overlap', () => {
  const q1 = { question: 'Which agent traded stroke protection against bleeding across the trials?', reference: good().reference };
  const same = { question: 'Which agent traded stroke protection against bleeding across the two trials?', reference: good().reference };
  assert.ok(overlap(q1.question, same.question) > 0.55);
  assert.equal(findDuplicate(same, [q1]), q1);
  const otherDocs = { ...same, reference: { keyPoints: [good().reference.keyPoints[0], { ...good().reference.keyPoints[0], id: 'c' }] } };
  assert.deepEqual(docSet(otherDocs), ['d1']);
  assert.equal(findDuplicate(otherDocs, [q1]), null);
  const different = { question: 'Completely unrelated wording about renal outcomes and dialysis', reference: good().reference };
  assert.equal(findDuplicate(different, [q1]), null);
});

test('verification uses the instrument check', () => {
  assert.deepEqual(verifyQuestion(topic, good()).problems, []);
  const bad = good(); bad.reference.keyPoints[0].support[0].quote = 'reduced stroke by 25 percent compared with warfarin';
  assert.ok(verifyQuestion(topic, bad).problems.some((p) => /not verbatim/.test(p)));
  const one = good(); one.reference.keyPoints[1].support[0].doc = 'd1'; one.reference.keyPoints[1].support[0].quote = 'reduced stroke by 20 percent compared with warfarin';
  assert.ok(verifyQuestion(topic, one).problems.length);
  const unknown = good(); unknown.reference.keyPoints[0].support[0].doc = 'nope';
  assert.ok(verifyQuestion(topic, unknown).problems.some((p) => /unknown document/.test(p)));
  assert.ok(verifyQuestion(topic, { ...good(), kind: 'single' }).problems.length);
});

test('runBatch: repairs once, drops what still fails, rejects duplicates', async () => {
  const bad = good('Which trial showed benefit and harm together in these two studies?'); bad.reference.keyPoints[0].support[0].quote = 'invented words that are nowhere in it';
  const hopeless = good('A third question about both drugs and their relative trade offs overall'); hopeless.reference.keyPoints[0].support[0].quote = 'still invented words not in the document';
  const dup = good('How did alpha and beta differ on stroke and bleeding?');
  const calls = [];
  const fake = async (prompt) => {
    calls.push(prompt);
    if (calls.length === 1) return { ok: true, value: { questions: [good(), bad, hopeless, dup] } };
    const fixed = good('Which trial showed benefit and harm together in these two studies?');
    return { ok: true, value: { questions: [fixed, hopeless] } };
  };
  const r = await runBatch(topic, { count: 4, batch: 0 }, fake);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /Problems/);
  assert.equal(r.accepted.length, 2);
  assert.equal(r.repaired, 1);
  assert.equal(r.dropped.length, 2);
  assert.ok(r.dropped.some((d) => /near-duplicate/.test(d.reason)));
  assert.ok(r.dropped.some((d) => /still failing/.test(d.reason)));
});

test('runBatch reports an unusable generator', async () => {
  const r = await runBatch(topic, { count: 3 }, async () => ({ ok: false, error: 'boom' }));
  assert.equal(r.error, 'boom'); assert.equal(r.accepted.length, 0);
});
