import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { redactedEvidence, redactedFactColumns } from '../src/vcrErasureStore.mjs';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

test('a fact without its words keeps the record it describes: numbers, units, times and its locator stay, the quotes and the text go', () => {
  const row = {
    value: 'Type 2 diabetes', surface: '2型糖尿病', date_surface: '2020年3月', clinical: { assertion: 'affirmed', correctionOf: 'fac_0', correctionReason: '原记录写错了名字',
      relations: [{ type: 'dose_of', state: 'supported', targetFactId: 'fac_2', quote: '二甲双胍 0.5 g bid，2型糖尿病' }, { type: 'route_of', state: 'unresolved', quote: '口服' }] },
    source: { documentId: 'sfl_1', start: 4, end: 20, quote: '诊断：2型糖尿病', vocabularyVersion: 'v1', sourceHash: 'a'.repeat(64) },
  };
  const words = redactedFactColumns(row);
  assert.equal(words.surface, '');
  assert.equal(words.dateSurface, null);
  assert.equal(words.value, null, 'a value that is text repeats the record');
  assert.deepEqual(words.source, { documentId: 'sfl_1', start: 4, end: 20, vocabularyVersion: 'v1', sourceHash: 'a'.repeat(64), quoteHash: sha('诊断：2型糖尿病') });
  assert.deepEqual(words.clinical.relations.map(relation => [relation.type, relation.targetFactId ?? null, relation.quote]), [['dose_of', 'fac_2', ''], ['route_of', null, '']]);
  assert.equal(words.clinical.correctionReason, '');
  assert.equal(words.clinical.correctionOf, 'fac_0', 'the link stays');
  assert.ok(!JSON.stringify(words).includes('糖尿病') && !JSON.stringify(words).includes('二甲双胍'));
  // A number is the record, not a repetition of it; a fact with no clinical block or source stays so.
  assert.equal(redactedFactColumns({ value: 62, source: null, clinical: null }).value, 62);
  assert.deepEqual([redactedFactColumns({ value: 62, source: null, clinical: null }).source, redactedFactColumns({ value: 62, source: null, clinical: null }).clinical], [null, null]);
});

test('the quotes of the evidence that came out of erased text become the hash of what they said; other evidence is untouched, and a second pass changes nothing', () => {
  const evidence = [
    { factId: 'fac_1', quote: '年龄 62 岁', quoteKind: 'verbatim', locator: { documentId: 'sfl_1', start: 0, end: 7 } },
    { factId: 'fac_2', quote: '肌酐 1.2', quoteKind: 'verbatim', locator: { documentId: 'sfl_2', start: 0, end: 5 } },
    { factId: 'fac_3', quote: 'age（数据表列 AGE）', quoteKind: 'snapshot_cell', locator: { snapshotId: 'snp_1', field: 'AGE' } },
  ];
  const once = redactedEvidence(evidence, item => item.locator?.documentId === 'sfl_1');
  assert.equal(once.changed, true);
  assert.deepEqual(once.evidence[0], { factId: 'fac_1', quote: '', quoteKind: 'verbatim', locator: { documentId: 'sfl_1', start: 0, end: 7 }, quoteHash: sha('年龄 62 岁'), withdrawn: true });
  assert.deepEqual(once.evidence.slice(1), evidence.slice(1));
  const twice = redactedEvidence(once.evidence, item => item.locator?.documentId === 'sfl_1');
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.evidence, once.evidence);
  assert.deepEqual(redactedEvidence(null, () => true), { evidence: [], changed: false });
});
