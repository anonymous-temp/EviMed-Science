import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { rejudgeHistory, boundedJudgeFetch, comparisonMarkdown, parseArgs } from '../run/rejudge-history.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;

async function archivedRun(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capsule-history-rejudge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'archive'), run = path.join(input, 'nested', 'run-a'), data = path.join(root, 'data');
  await mkdir(path.join(run, 'cases', 'case-a'), { recursive: true });
  await mkdir(path.join(data, 'scenarios-dev'), { recursive: true });
  await writeFile(path.join(run, 'run.json'), json({ runId: 'run-a', set: 'scenarios', split: 'dev', arm: 'product' }));
  await writeFile(path.join(run, 'cases', 'case-a', 'answers.jsonl'), `${JSON.stringify({ qid: 'q1', answer: 'wrong', toolCalls: [] })}\n`);
  await writeFile(path.join(data, 'scenarios-dev', 'manifest.json'), json({ generator: 'fixture' }));
  await writeFile(path.join(data, 'scenarios-dev', 'gold.json'), json({ scenarios: [{ scenarioId: 'case-a', questions: [{ qid: 'q1', question: 'Invented question?', expect: { mustContain: ['right'] } }] }] }));
  await writeFile(path.join(data, 'scenarios-dev', 'input.json'), json([]));
  await mkdir(path.join(run, 'scores'));
  await writeFile(path.join(run, 'scores', 'summary.json'), json({ answers: { n: 1, pass: 1, fail: 0, unknown: 0, accuracy: 1 } }));
  return { root, input, run, data };
}

test('history rescoring reads an archive and writes old/new arm comparisons elsewhere', async t => {
  const f = await archivedRun(t), out = path.join(f.root, 'new-scores');
  const before = createHash('sha256').update(await readFile(path.join(f.run, 'cases', 'case-a', 'answers.jsonl'))).digest('hex');
  const summary = await rejudgeHistory({ input: f.input, data: f.data, out });
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.judgeCalls, 0);
  assert.equal(summary.runs[0].set, 'scenarios');
  assert.equal(summary.runs[0].arm, 'product');
  assert.equal(summary.runs[0].oldAccuracy, 1);
  assert.equal(summary.runs[0].newAccuracy, 0);
  assert.equal(summary.runs[0].accuracyDelta, -1);
  assert.equal(summary.runs[0].newFail, 0, JSON.stringify(summary.runs[0]));
  assert.equal(summary.runs[0].newUnknown, 1);
  const after = createHash('sha256').update(await readFile(path.join(f.run, 'cases', 'case-a', 'answers.jsonl'))).digest('hex');
  assert.equal(after, before);
  assert.match(await readFile(path.join(out, 'comparison.csv'), 'utf8'), /scenarios,dev,product,run-a,1,1,0,0,1,1,0,0/);
  assert.match(await readFile(path.join(out, 'comparison.md'), 'utf8'), /\| run-a \| 1 \/ 1 \| 1 \/ 0 \| -1 \| 0 \|/);
  await assert.rejects(() => rejudgeHistory({ input: f.input, data: f.data, out }), /EEXIST/);
});

test('judge budget counts attempted requests including retries and never exceeds its limit', async () => {
  let calls = 0;
  const fetch = boundedJudgeFetch(async () => { calls += 1; return { ok: true }; }, { used: 0, limit: 2 });
  await fetch('judge-only'); await fetch('judge-only');
  await assert.rejects(() => fetch('judge-only'), /judge_call_limit_exceeded/);
  assert.equal(calls, 2);
  assert.equal(parseArgs(['--input', 'archive', '--data', 'data', '--out', 'new']).maxJudgeCalls, 0);
  assert.throws(() => parseArgs(['--input', 'archive', '--data', 'data', '--out', 'new', '--max-judge-calls', '-1']));
});

test('comparison output remains tabular when old scores are missing', () => {
  assert.equal(comparisonMarkdown([]), '| Dataset | Split | Arm | Run | Old n / accuracy | New n / accuracy | Delta | Judge calls |\n|---|---|---|---|---:|---:|---:|---:|\n');
});
