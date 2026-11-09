import assert from 'node:assert/strict';
import test from 'node:test';
import { runBatchEval, parseCsv } from '../../../evals/vcr-professional-plugins/hr_batch_eval.mjs';

// 40 stays with a known early and 24-hour heart rate; the engine regression is a known linear shrinkage of the early value
const pairs = Array.from({ length: 40 }, (_, i) => ({ USUBJID: `s${i}`, hr_early: String(70 + i), hr_24: String(72 + i * .8) }));

test('the batch path scores persistence on the whole supplied split and reports the denominator', async () => {
  const result = await runBatchEval({ pairs, dropped: { noEarlyOrNoTarget: 5 }, batchSize: 16 });
  assert.equal(result.denominator.submitted,40);
  assert.equal(result.denominator.completed,40);
  assert.equal(result.denominator.wholeSplit,45);
  assert.equal(result.evaluated,40);
  // persistence error is |(70+i)-(72+0.8i)| = |-2+0.2i|, mean over i=0..39
  const expected = pairs.reduce((n,_,i) => n+Math.abs(-2+.2*i),0)/40;
  assert.ok(Math.abs(result.metrics.mae.value-expected)<1e-9,`${result.metrics.mae.value} vs ${expected}`);
});

test('a regression arm is scored against the same stays and persistence is its baseline',async () => {
  const predictions = new Map(pairs.map((p,i) => [p.USUBJID,72+i*.8]));
  const result = await runBatchEval({ pairs, predictions });
  assert.equal(result.metrics.mae.value,0);
  assert.ok(result.persistenceBaseline?.mae);
  assert.equal(result.persistenceBaseline.mae.preferred,'model');
  assert.equal(parseCsv('A,B\n1,2')[0].B,'2');
});

test('stays the model declines are rejected in the ledger and still counted in the denominator',async () => {
  const predictions = new Map(pairs.slice(0,30).map((p,i) => [p.USUBJID,72+i*.8]));
  const result = await runBatchEval({ pairs, predictions });
  assert.equal(result.denominator.completed,30);
  assert.equal(result.denominator.rejected,10);
  assert.equal(result.denominator.submitted,40);
  assert.equal(result.missingForecasts,10);
});

test("the engine's own predictions file (quoted fields, a patientId column) is read as it is written", () => {
  // The first real-data run (2026-11-09) read every forecast as missing: the engine quotes its strings and names the id patientId.
  const rows = parseCsv('"patientId","score","prediction","reason","source"\n"b0001",94.5,94.5,"","predicted"\n"b0002",91,91,"a, b","predicted"\n');
  assert.deepEqual(rows.map(r => [r.patientId, Number(r.prediction), r.reason]), [['b0001', 94.5, ''], ['b0002', 91, 'a, b']]);
});
