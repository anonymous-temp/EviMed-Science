import assert from 'node:assert/strict';
import test from 'node:test';
import { clinicalFactIssues, clinicalFactPolarity, clinicalFactView, clinicalSemanticFields, clinicalTerminologyContext, clinicalUnitToken, clinicalUnitInQuote, convertClinicalUnit } from '../index.mjs';
const clinical = { schema: 1, assertion: 'affirmed', experiencer: 'patient' };
/** @param {string} id @param {number} value @param {any} extra */
const fact = (id, value, extra = {}) => ({ id, subjectKey: 'p1', variable: 'ecog', value, ...extra,
  clinical: { ...clinical, ...(extra.clinical ?? {}) } });

test('certainty and experiencer are independent, absent context remains invalid', () => {
  assert.deepEqual(clinicalFactIssues(clinical), []);
  assert.ok(clinicalFactIssues({ schema: 1 }).includes('clinical_assertion'));
  assert.equal(clinicalFactPolarity(fact('f1', 1, { clinical: { experiencer: 'family' } })), 'family');
  assert.equal(clinicalFactPolarity(fact('f1', 1, { clinical: { assertion: 'possible' } })), 'hypothetical');
  assert.equal(clinicalFactPolarity(fact('f1', 1, { clinical: { temporality: 'planned' } })), 'hypothetical');
  assert.ok(clinicalFactIssues({ ...clinical, medication: { state: 'administered', dose: -2 } }).length);
  assert.ok(clinicalFactIssues({ ...clinical, locator: { kind: 'pdf', page: 0 } }).length);
  assert.ok(clinicalFactIssues({ ...clinical, relations: [{ type: 'dose_of', state: 'supported', quote: '5 mg' }] }).length);
});

test('a correction changes the current view without erasing the original or rewriting historical replay', () => {
  const original = fact('f1', 2, { createdAt: '2026-01-01' });
  const corrected = fact('f2', 1, { createdAt: '2026-03-01', clinical: { correctionOf: 'f1', correctionReason: 'Source correction' } });
  const rows = [original, corrected];
  assert.deepEqual(clinicalFactView(rows, '2026-02-01').facts.map(f => f.value), [2]);
  assert.deepEqual(clinicalFactView(rows, '2026-04-01').facts.map(f => f.value), [1]);
  assert.deepEqual(clinicalFactView(rows, '2026-04-01').superseded, ['f1']);
  assert.equal(rows[0].value, 2);
  const competing = fact('f3', 3, { clinical: { correctionOf: 'f1', correctionReason: 'Second review' } });
  assert.equal(clinicalFactView([...rows, competing], '2026-04-01').conflicts.length, 2);
});

test('conflicts are explicit within an episode, never resolved by recency or across subjects', () => {
  const a = fact('a', 1, { clinical: { eventId: 'visit1' } });
  const b = fact('b', 2, { clinical: { eventId: 'visit1' } });
  assert.equal(clinicalFactView([a, b], '2026-01-01').conflicts.length, 2);
  assert.equal(clinicalFactView([a, { ...b, subjectKey: 'p2' }], '2026-01-01').conflicts.length, 0);
  assert.equal(clinicalFactView([a, { ...b, clinical: { ...clinical, eventId: 'visit2' } }], '2026-01-01').conflicts.length, 0);
  assert.ok(!JSON.stringify(clinicalSemanticFields([a, b])).includes('p1'));
});

test('selected conversions round trip, retain analyte identity and do not case-fold arbitrary units', () => {
  const cases = /** @type {[string,string,string,number][]} */ ([[ 'creatinine', 'mg/dL', 'µmol/L', 1.2], ['bilirubin', 'mg/dL', 'umol/L', 2], ['glucose', 'mmol/L', 'mg/dL', 5], ['hemoglobin', 'g/dL', 'g/L', 12]]);
  for (const [analyte, from, to, value] of cases) {
    const converted = convertClinicalUnit(value, from, to, analyte);
    assert.ok(converted);
    const restored = convertClinicalUnit(converted.value, to, from, analyte);
    assert.ok(restored);
    assert.ok(Math.abs(restored.value - value) < 1e-10);
  }
  assert.equal(convertClinicalUnit(1, 'mg/dL', 'umol/L', 'unknown'), null);
  assert.equal(convertClinicalUnit(1, 'mg/dL', 'g/L', 'creatinine'), null);
  assert.notEqual(clinicalUnitToken('Mmol/L'), clinicalUnitToken('mmol/L'));
  assert.equal(clinicalUnitToken('μmol/L'), 'umol/L');
  assert.equal(clinicalUnitInQuote('umol/L','肌酐 98 μmol / L'),true);
  assert.equal(clinicalUnitInQuote('g/L','1 mg/L'),false);
  assert.equal(clinicalUnitInQuote('mg/dL','1.0，单位未记载'),false);
  assert.equal(clinicalUnitInQuote('custom-unit','not supplied'),null);
});

test('pack grounding follows exact nested criteria and exposes only versioned definitions with their sources',()=>{
  const pack={id:'nsclc',version:3,terms:[{concept:'egfr',label:'EGFR',sources:['r1']}],
    mappings:[{concept:'egfr',source:'Chinese source edition',sources:['r2']},{concept:'ecog',sources:['r3']}],
    sources:[{id:'r1'},{id:'r2'},{id:'r3'}]};
  const context=clinicalTerminologyContext(pack,[{requirement:{op:'and',items:[{variable:'egfr'},{variable:'unknown_lab'}]}}]);
  assert.ok(context);
  assert.equal(context.version,3);assert.deepEqual(context.sources,[{id:'r1'},{id:'r2'}]);
  assert.deepEqual(context.unmappedVariables,['unknown_lab']);assert.equal(context.mappings.length,1);
  const metadata=clinicalSemanticFields([fact('f1',7,{source:{sourceHash:'a'.repeat(64)},unit:'score'})]);
  assert.deepEqual(metadata[0].sourceVersions,['a'.repeat(64)]);
  assert.equal(metadata[0].basis,'model_inferred');assert.equal('value' in metadata[0],false);
});
