import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBenchmark, summarize, validateObservation } from '../scorer.mjs';
import benchmark from '../cases.json' with { type: 'json' };
test('frozen benchmark has 90 independent questions and separate strata', () => {
  assert.equal(validateBenchmark(benchmark), true);
  assert.throws(() => validateBenchmark({ ...benchmark, cases: [...benchmark.cases.slice(1), benchmark.cases[1]] }), /duplicate/);
});
test('identity, source freshness and exact user prompt are checked', () => {
  const c = benchmark.cases[0];
  const row = { caseId: c.id, prompt: c.prompt, actor: c.actor, project: c.project, citedSources: c.sources, staleSources: [], score: 1, arm: 'candidate', repetition: 1, evidence: { runId: 'real-run', transcript: 'saved.jsonl', provider: 'deepseek' } };
  assert.equal(validateObservation(c, row), true);
  for (const change of [{ prompt: c.prompt + ' hint' }, { actor: 'other' }, { staleSources: [c.sources[0]] }, { score: NaN }]) assert.throws(() => validateObservation(c, { ...row, ...change }));
});
test('missing data cannot pass and lifecycle has its own denominator', () => {
  const report = summarize(benchmark, []);
  assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.strata.general.expected, 30);
  assert.equal(report.strata.medical.expected, 30);
  assert.equal(report.lifecycle.expected, 30);
});
test('bootstrap uses independent question means, not repetitions', () => {
  const rows = benchmark.cases.flatMap(c => ['baseline', 'candidate'].flatMap(arm => [1, 2, 3].map(repetition => ({ caseId: c.id, arm, repetition, score: 1, violations: [], abstained: c.unanswerable }))));
  const report = summarize(benchmark, rows);
  assert.equal(report.strata.general.comparison.n, benchmark.cases.filter(c => c.stratum === 'general' && !c.unanswerable).length);
  assert.equal(report.verdict, 'pass');
  rows.push({ ...rows[0] });
  assert.throws(() => summarize(benchmark, rows), /duplicate/);
});
test('lifecycle violation always fails; insufficient CI evidence is inconclusive', () => {
  const rows = benchmark.cases.flatMap(c => ['baseline', 'candidate'].flatMap(arm => [1, 2, 3].map(repetition => ({ caseId: c.id, arm, repetition, score: 1, violations: c.stratum === 'lifecycle' && arm === 'candidate' ? ['cross-account'] : [], abstained: c.unanswerable }))));
  assert.equal(summarize(benchmark, rows).verdict, 'fail');
});
