import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HARNESS_SCORERS, harnessScorer, judgedScore, mbcScore, mbcVerdict, scorerBenchmarks } from '../harness_scorers.mjs';
import { judgedVerdicts } from '../harness_campaign.mjs';
import { SKILL_SCORERS, skillScorer } from '../skill_scorers.mjs';

const vectors = JSON.parse(await readFile(new URL('./fixtures/scorer-vectors.json', import.meta.url), 'utf8'));

test('MedBrowseComp: the port gives score_shortanswer.py\'s verdict, extraction and extracted text on every vector', () => {
  assert.ok(vectors.mbc.length >= 45);
  for (const { name, text, gold, verdict, extraction, extracted, score } of vectors.mbc) {
    const got = mbcVerdict(text, gold);
    assert.equal(got.verdict, verdict, name);
    assert.equal(got.extraction, extraction, name);
    assert.equal(got.extracted, extracted, name);
    assert.equal(mbcScore(text, { gold }), score, name);
  }
  const seen = new Set(vectors.mbc.map((row) => row.verdict)), tasks = new Set(vectors.mbc.map((row) => row.gold.task_name));
  assert.deepEqual([...seen].sort(), ['correct', 'incorrect', 'needs_judge']);
  assert.equal(tasks.size, 5);
});

test('MedBrowseComp: a case only a judge could settle counts as not correct, so the score is a floor of the judged one', () => {
  const salt = { task_name: 'Ingredient', answer: 'GEMCITABINE HYDROCHLORIDE' };
  assert.equal(mbcVerdict('INGREDIENT: GEMCITABINE', salt).verdict, 'needs_judge');
  assert.equal(mbcScore('INGREDIENT: GEMCITABINE', { gold: salt }), 0);
  assert.equal(mbcScore('INGREDIENT: Gemcitabine hydrochloride', { gold: salt }), 1);
  assert.equal(mbcScore(null, { gold: salt }), 0);
  assert.equal(mbcScore('', { gold: salt }), 0);
  assert.equal(mbcVerdict('The patent expires in 2027.', { task_name: 'Patent_Expire_Date_Text', answer: 'Aug 13, 2027' }).verdict, 'needs_judge');
});

test('every harness scorer that reads an answer returns a number in [0, 1] whatever it is given', () => {
  const rows = {
    medcalc: { id: '1', calculatorId: 2, gold: { answer: '10.0', lower: '9.5', upper: '10.5' } },
    'bixbench-deterministic': { id: '1', topic: 'x', gold: { questions: vectors.bixbench[0].gold.questions } },
    'arb-deep': { id: '1', category: 'x', gold: vectors.arbDeep[0].gold },
    'arb-wide': { id: '1', category: 'x', gold: vectors.arbWide[0].gold },
    'mbc-normalized': { id: '1', task: 'Open_on_Approval', gold: { task_name: 'Open_on_Approval', answer: '15.99' } },
  };
  for (const [id, row] of Object.entries(rows)) {
    const scorer = HARNESS_SCORERS[id];
    assert.ok(Object.isFrozen(scorer) && Object.isFrozen(scorer.slice), id);
    assert.ok(scorer.validRow(row), `${id}: its sample row is valid`);
    for (const answer of [null, '', '   ', 'Final answer:', 'Final answers:\n1.', 'x'.repeat(50_000), '1. 2. 3.\n'.repeat(500), '```\n```', 'INGREDIENT:', 'DATE: 12/31/2026\n$15.99', ' \r\n']) {
      const value = scorer.score(answer, row);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${id} on ${JSON.stringify(answer).slice(0, 30)}: ${value}`);
    }
  }
});

test('the harness table is closed: the skill table\'s four, by reference, and two more; nothing else names a scorer', () => {
  assert.deepEqual(Object.keys(HARNESS_SCORERS), ['medcalc', 'bixbench-deterministic', 'arb-deep', 'arb-wide', 'mbc-normalized', 'judged-verdicts']);
  assert.ok(Object.isFrozen(HARNESS_SCORERS));
  assert.throws(() => { HARNESS_SCORERS.extra = HARNESS_SCORERS.medcalc; }, TypeError);
  for (const id of Object.keys(SKILL_SCORERS)) assert.equal(HARNESS_SCORERS[id], SKILL_SCORERS[id], `${id} is the skill table's own entry`);
  // The personal-skill surface keeps its four.
  assert.deepEqual(Object.keys(SKILL_SCORERS), ['medcalc', 'bixbench-deterministic', 'arb-deep', 'arb-wide']);
  assert.equal(skillScorer({ scorer: 'mbc-normalized' }), null);
  assert.equal(skillScorer({ scorer: 'judged-verdicts' }), null);
  assert.equal(harnessScorer({ scorer: 'mbc-normalized' }).id, 'mbc-normalized');
  assert.equal(harnessScorer({}), null, 'a harness registration names its scorer');
  assert.equal(harnessScorer(undefined), null);
  for (const hostile of ['judge', 'MBC-NORMALIZED', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, 7, ['mbc-normalized'], { id: 'mbc-normalized' }, '../harness_scorers.mjs']) {
    assert.equal(harnessScorer({ scorer: hostile }), null, JSON.stringify(hostile));
  }
  let called = false;
  assert.equal(harnessScorer({ scorer: { toString: () => { called = true; return 'mbc-normalized'; } } }), null);
  assert.equal(called, false, 'a registration cannot hand in a function');
  assert.deepEqual(scorerBenchmarks(HARNESS_SCORERS.medcalc), ['medcalc-bench']);
  assert.deepEqual(scorerBenchmarks(HARNESS_SCORERS['mbc-normalized']), ['medbrowsecomp']);
  assert.deepEqual([...scorerBenchmarks(HARNESS_SCORERS['judged-verdicts'])], ['deepresearchbench', 'researchclawbench']);
});

test('a medbrowsecomp row needs a task the scorer knows, the same task in the stratum, and an answer it can read', () => {
  const valid = HARNESS_SCORERS['mbc-normalized'].validRow;
  const row = (task, answer, key = task) => ({ id: '1', task: key, gold: { task_name: task, answer } });
  assert.ok(valid(row('Ingredient', 'ZORVALINIB')) && valid(row('Exclusivity_Date', '')) && valid(row('Open_on_Approval', 'Not_Listed')) && valid(row('Open_on_Approval', '157.02')));
  assert.ok(!valid(row('Unknown_Task', 'x')) && !valid(row('Ingredient', 'x', 'Applicant_Full_Name')) && !valid(row('Open_on_Approval', 'about fifteen')) && !valid({ id: '1', task: 'Ingredient' }) && !valid(null));
});

test('a judged run\'s score is the mean of its verdicts; an undelivered run is 0; a delivered run without a verdict is an error, never 0', () => {
  const source = { judged: { judge: { form: 'absolute' }, records: [
    { row: '1', arm: 'baseline', repeat: 0, pass: 1, score: 0.2 }, { row: '1', arm: 'baseline', repeat: 0, pass: 2, score: 0.4 }, { row: '1', arm: 'baseline', repeat: 0, pass: 3, score: 0.9 }] } };
  const verdicts = judgedVerdicts(source);
  const run = (status, row = '1') => ({ row, arm: 'baseline', repeat: 0, status });
  assert.ok(Math.abs(judgedScore(null, {}, run('succeeded'), verdicts) - 0.5) < 1e-12);
  assert.equal(judgedScore(null, {}, run('timeout'), verdicts), 0);
  assert.equal(judgedScore(null, {}, run('failed', '2'), verdicts), 0);
  assert.throws(() => judgedScore(null, {}, run('succeeded', '2'), verdicts), { message: 'harness_verdict_missing' });
  const pairwise = judgedVerdicts({ judged: { judge: { form: 'pairwise' }, records: [{ row: '1', arm: 'cand-aaaaaaaaaaaa', repeat: 0, pass: 1, score: 0.75 }] } });
  assert.equal(judgedScore(null, {}, run('succeeded'), pairwise), 0.5, 'the baseline of a pairwise comparison is parity');
  assert.equal(judgedScore(null, {}, run('timeout'), pairwise), 0.5);
  assert.equal(judgedScore(null, {}, { row: '1', arm: 'cand-aaaaaaaaaaaa', repeat: 0, status: 'succeeded' }, pairwise), 0.75);
  assert.equal(judgedScore(null, {}, { row: '1', arm: 'cand-aaaaaaaaaaaa', repeat: 0, status: 'timeout' }, pairwise), 0);
  // The scorer reads nothing from the answer: the same score whatever it says.
  assert.equal(judgedScore('Final answer: 10.1', {}, { row: '1', arm: 'cand-aaaaaaaaaaaa', repeat: 0, status: 'succeeded' }, pairwise), 0.75);
});
