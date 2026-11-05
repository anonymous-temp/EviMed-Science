import assert from 'node:assert/strict';
import test from 'node:test';
import { summarise } from './zh_usability.mjs';

test('the aggregates count and keep no words', () => {
  const report = summarise([
    { status: 'complete', usage: { costCny: 0.1 }, ranking: [
      { fit: 80, verdict: 'eligible', criteria: [{ label: 'included', basis: 'stated', sentenceIds: [1], reason: '记录写明' }, { label: 'not_excluded', basis: 'silent', sentenceIds: [], reason: 'no record' }] },
      { fit: null, verdict: 'insufficient' }] },
    { status: 'failed', failed: [{ code: 'x' }], ranking: [] },
  ], 3);
  assert.deepEqual([report.notes, report.records, report.complete, report.pairs, report.withFit], [3, 2, 1, 2, 1]);
  assert.deepEqual(report.verdicts, { eligible: 1, insufficient: 1 });
  assert.deepEqual([report.clauses, report.stated, report.statedWithEvidence, report.reasons, report.reasonsInChinese], [2, 1, 1, 2, 1]);
  assert.deepEqual(report.failed, { x: 1 });
  assert.equal(report.costCny, 0.1);
  assert.ok(!JSON.stringify(report).includes('记录写明'));
});
