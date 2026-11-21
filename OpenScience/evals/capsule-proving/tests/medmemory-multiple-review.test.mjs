import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { exportMultipleChoiceReview, rescoreMultipleChoiceReview, parseCsv, csvText } from '../run/review-medmemory-multiple.mjs';
import { registerQuestionPools, sourceSetSha256 } from '../inputs.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value)}\n`;
const lines = values => values.map(json).join('');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capsule-mm-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run'), data = path.join(root, 'data'), publicDir = path.join(data, 'public', 'medmemorybench-hf');
  await mkdir(path.join(run, 'cases', 'mm-en-p1'), { recursive: true });
  await mkdir(path.join(publicDir, 'data', 'en'), { recursive: true });
  await mkdir(path.join(publicDir, 'derived'), { recursive: true });
  await mkdir(path.join(run, 'scores'), { recursive: true });
  await writeFile(path.join(run, 'run.json'), json({ runId: 'product-r3', set: 'medmemorybench', split: 'dev', arm: 'product', options: { language: 'en' } }));
  const queries = [0, 1, 2, 3].map(index => ({ persona_id: 1, query_id: `session_2_mq_${index}`, session_id: 2, query_type: 'multiple_choice',
    question: `Invented question ${index}, with comma?\nSecond line`, answers: [
      { content: `Fake A${index}`, is_correct: true, explanation: 'Invented' },
      { content: `Fake B${index}`, is_correct: index === 1, explanation: 'Invented' },
      { content: `Fake C${index}`, is_correct: false },
    ], source_key_points: [{ content: `Fake evidence ${index}` }], metadata: {} }));
  const parquet = 'invented parquet bytes', digest = sha256(parquet);
  await writeFile(path.join(publicDir, 'data', 'en', 'queries.parquet'), parquet);
  await writeFile(path.join(publicDir, 'derived', 'queries.en.jsonl'), lines([{ sha256: digest }, ...queries]));
  const pool = registerQuestionPools(queries.map(query => ({ question_id: `persona_1:${query.query_id}`, haystack_session_ids: [] })),
    { seed: 'invented-review', developmentCount: 3, sourceSha256: sourceSetSha256([{ path: 'data/en/queries.parquet', sha256: digest }]), benchmark: 'medmemorybench-hf' });
  const sources = { public: { 'medmemorybench-hf': { files: [{ path: 'data/en/queries.parquet', sha256: digest }] } } };
  const selected = pool.pools.development.map(id => `en:${id}`);
  await writeFile(path.join(run, 'cases', 'mm-en-p1', 'answers.jsonl'), lines(selected.map((qid, index) => ({ qid, answer: index === 0 ? 'Fake A and B' : 'Fake C', toolCalls: [] }))));
  await writeFile(path.join(run, 'scores', 'rows.jsonl'), lines(selected.map((id, index) => ({ runId: 'product-r3', set: 'medmemorybench', split: 'dev', caseId: 'mm-en-p1', kind: 'answer', id, verdict: ['pass', 'fail', 'unknown'][index] }))));
  return { root, run, data, sources, pools: { 'medmemorybench-hf': pool }, selected };
}

test('multiple-choice export includes all options, gold and each arm answer; labels recompute valid-only scores', async t => {
  const f = await fixture(t), reviewDir = path.join(f.root, 'review'), out = path.join(f.root, 'rescore');
  const exported = await exportMultipleChoiceReview({ runs: [f.run], data: f.data, out: reviewDir, sources: f.sources, pools: f.pools });
  assert.equal(exported.questions, 3);
  assert.equal(exported.runs, 1);
  const reviewText = await readFile(path.join(reviewDir, 'review.csv'), 'utf8');
  const rows = parseCsv(reviewText);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].review_status, '');
  assert.match(rows[0].question, /Second line/);
  assert.equal(JSON.parse(rows[0].options_json).length, 3);
  assert.equal(rows[0]['answer:product-r3'], 'Fake A and B');
  assert.match(await readFile(path.join(reviewDir, 'review.md'), 'utf8'), /Fake A0 \[correct\]/);
  rows.forEach((row, index) => { row.review_status = ['对', '错', '有歧义'][index]; row.review_note = `Review ${index}`; });
  const manifest = JSON.parse(await readFile(path.join(reviewDir, 'runs.json'), 'utf8'));
  await writeFile(path.join(reviewDir, 'review.csv'), csvText(manifest.columns, rows));
  const original = await readFile(path.join(f.run, 'scores', 'rows.jsonl'), 'utf8');
  const summary = await rescoreMultipleChoiceReview({ reviewDir, out });
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.arms, [{ arm: 'product', n: 3, originalPass: 1, nValid: 1, reviewedPass: 1, goldCorrect: 1,
    goldIncorrect: 1, goldAmbiguous: 1, reviewPending: 0, originalAccuracy: 1 / 3, accuracyValid: 1 }]);
  assert.equal(await readFile(path.join(f.run, 'scores', 'rows.jsonl'), 'utf8'), original);
  const reviewedRows = parseCsv(await readFile(path.join(out, 'scores.csv'), 'utf8'));
  assert.equal(reviewedRows[0].nValid, '1');
});

test('partial annotations never silently enter the valid denominator', async t => {
  const f = await fixture(t), reviewDir = path.join(f.root, 'review');
  await exportMultipleChoiceReview({ runs: [f.run], data: f.data, out: reviewDir, sources: f.sources, pools: f.pools });
  const manifest = JSON.parse(await readFile(path.join(reviewDir, 'runs.json'), 'utf8'));
  const rows = parseCsv(await readFile(path.join(reviewDir, 'review.csv'), 'utf8'));
  rows[0].review_status = '对';
  await writeFile(path.join(reviewDir, 'review.csv'), csvText(manifest.columns, rows));
  await assert.rejects(() => rescoreMultipleChoiceReview({ reviewDir, out: path.join(f.root, 'blocked') }), /review_pending/);
  const summary = await rescoreMultipleChoiceReview({ reviewDir, out: path.join(f.root, 'partial'), allowPartial: true });
  assert.equal(summary.complete, false);
  assert.equal(summary.runs[0].reviewPending, 2);
  assert.equal(summary.runs[0].nValid, 1);
  assert.throws(() => parseCsv('a,b\n"unterminated,b\n'), /review_csv_quote_invalid/);
});
