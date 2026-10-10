import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runMatchingEvaluation } from '../../apps/server/src/vcrMatching.mjs';
import { evaluateDataset } from './run_matching_evaluation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'run_matching_evaluation.mjs');
const sample = path.join(here, 'matching-eval-sample.json');

test('a labelled set is evaluated by the production evaluator and carries the digest that freezes it', async () => {
  const bytes = await readFile(sample);
  const { report, dataset } = evaluateDataset(bytes);
  // Exactly the library's numbers - the runner scores no code path of its own.
  assert.deepEqual({ ...report, dataset: undefined }, { ...runMatchingEvaluation(JSON.parse(bytes.toString('utf8'))), dataset: undefined });
  assert.equal(report.criterion.counted, 42);
  assert.equal(report.ceiling.pairs, 42);
  assert.equal(report.subject.subjects, 7);
  assert.equal(report.threshold, null);
  assert.equal(Object.hasOwn(report, 'passed'), false);
  assert.equal(dataset.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(dataset.cases, 7);
});

test('another set has another digest: a run on a changed holdout is visible', async () => {
  const bytes = await readFile(sample);
  const changed = JSON.parse(bytes.toString('utf8'));
  changed.synthetic = false;
  const { report, dataset } = evaluateDataset(Buffer.from(JSON.stringify(changed)));
  assert.equal(report.synthetic, false, 'an independently labelled set says it is not synthetic and the report keeps that');
  assert.notEqual(dataset.sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('a file that is not a labelled set is refused by name, never scored as an empty report', () => {
  for (const body of ['{}', '{"cases": []}', '[]', '"cases"', 'not json']) {
    assert.throws(() => evaluateDataset(Buffer.from(body)), /labelled matching set|not valid JSON/, body);
  }
  assert.throws(() => evaluateDataset(Buffer.from('{"cases": [{"goldSummary": "eligible"}]}')), /subjectKey/);
});

test('the command writes the report, and names a missing flag instead of guessing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'matching-eval-'));
  try {
    const out = path.join(directory, 'report.json');
    const ran = spawnSync(process.execPath, [runner, '--dataset', sample, '--out', out], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    const written = JSON.parse(await readFile(out, 'utf8'));
    const expected = evaluateDataset(await readFile(sample));
    assert.deepEqual(written, { ...expected.report, dataset: expected.dataset });

    const bare = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /--dataset/);

    await writeFile(path.join(directory, 'empty.json'), '{"cases": []}');
    const refused = spawnSync(process.execPath, [runner, '--dataset', path.join(directory, 'empty.json')], { encoding: 'utf8' });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /labelled matching set/);
    assert.equal(refused.stdout, '', 'nothing that looks like a result was printed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
