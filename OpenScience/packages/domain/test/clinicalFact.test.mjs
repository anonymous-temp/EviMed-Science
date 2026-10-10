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

test('a fact the platform wrote after the view time is still in the view; only a correction is held to that clock', () => {
  // A replay of a past instant extracts everything after that instant: createdAt is when the row was written (system time),
  // visibleAt is what the platform could read by then (valid time), and the caller has already applied the second.
  const original = fact('f1', 2, { createdAt: '2026-10-05' });
  assert.deepEqual(clinicalFactView([original], '2026-09-15').facts.map(f => f.value), [2]);
  // A correction written after the instant is a later rewrite of that moment: it neither supersedes nor counts as a second reading.
  const corrected = fact('f2', 1, { createdAt: '2026-10-06', clinical: { correctionOf: 'f1', correctionReason: 'Source correction' } });
  const before = clinicalFactView([original, corrected], '2026-09-15');
  assert.deepEqual(before.facts.map(f => f.value), [2]);
  assert.deepEqual(before.superseded, []);
  assert.deepEqual(clinicalFactView([original, corrected], '2026-10-07').facts.map(f => f.value), [1]);
  // A fact with no createdAt (a legacy row, a table cell) is never cut.
  assert.deepEqual(clinicalFactView([fact('f3', 3)], '2020-01-01').facts.map(f => f.value), [3]);
});

test('assertiveOnly: a correction that re-labels a fact still supersedes it, and the facts that may not be reasoned from are set aside', () => {
  const original = fact('f1', 1, { createdAt: '2026-01-01' });
  const relabelled = fact('f2', 1, { createdAt: '2026-03-01', clinical: { experiencer: 'family', correctionOf: 'f1', correctionReason: 'It is the father' } });
  const all = clinicalFactView([original, relabelled], '2026-04-01');
  assert.deepEqual(all.superseded, ['f1'], 'a correction supersedes whatever polarity it carries');
  assert.deepEqual(all.facts.map(f => f.id), ['f2'], 'without the option the page-style view lists the re-labelled fact');
  assert.deepEqual(all.setAside, []);
  const reasoned = clinicalFactView([original, relabelled], '2026-04-01', { assertiveOnly: true });
  assert.deepEqual(reasoned.superseded, ['f1']);
  assert.deepEqual(reasoned.facts, []);
  assert.deepEqual(reasoned.setAside, [relabelled], 'the fact as given, so a caller can match it by identity even without an id');
  // A fact nothing corrected and that is not assertive is set aside too; an assertive one is kept.
  const plan = fact('f3', 4, { clinical: { temporality: 'planned' } });
  const view = clinicalFactView([fact('f4', 5), plan], '2026-04-01', { assertiveOnly: true });
  assert.deepEqual(view.facts.map(f => f.id), ['f4']);
  assert.deepEqual(view.setAside, [plan]);
  // A fact set aside is not a party to a conflict, by relation or by episode.
  const kept = fact('k', 1, { clinical: { eventId: 'visit1' } });
  const hypothesis = fact('h', 2, { clinical: { eventId: 'visit1', assertion: 'possible', relations: [{ type: 'contradicts', state: 'supported', targetFactId: 'k', quote: 'q' }] } });
  assert.equal(clinicalFactView([kept, hypothesis], '2026-04-01').conflicts.length, 2, 'the page view still shows the relation');
  const settled = clinicalFactView([kept, hypothesis], '2026-04-01', { assertiveOnly: true });
  assert.deepEqual(settled.conflicts, []);
  assert.equal(settled.facts[0].conflicts, undefined);
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

test('units that differ only in case are one unit where the table lists them; a symbol whose case changes its magnitude is never folded (E-09)', () => {
  for (const [a, b] of [['ng/mL', 'ng/ml'], ['U/L', 'u/l'], ['10^9/L', '10^9/l'], ['mg/dL', 'MG/DL'], ['mmol/L', 'MMOL/L'], ['IU/mL', 'iu/ml'], ['µg/L', 'UG/L'], ['mL/min', 'ML/MIN']]) {
    assert.equal(clinicalUnitToken(a), clinicalUnitToken(b), `${a} and ${b} are one unit`);
  }
  assert.equal(clinicalUnitToken('ng/ml'), 'ng/mL', 'the token is the table\'s canonical spelling');
  // The upper-case rendering of these is another unit, or could be: they stay apart from their lower-case neighbours.
  for (const [a, b] of [['mmol/L', 'Mmol/L'], ['mU/L', 'MU/L'], ['g/L', 'G/L'], ['mg/dL', 'Mg/dL'], ['U/L', 'IU/L'], ['ng/mL', 'ug/mL']]) {
    assert.notEqual(clinicalUnitToken(a), clinicalUnitToken(b), `${a} and ${b} are not one unit`);
  }
  assert.equal(clinicalUnitToken(' custom-Unit '), 'custom-Unit', 'a unit the table does not know is the unit as typed');
  // The conversion still keys on the canonical spelling.
  assert.ok(convertClinicalUnit(1.2, 'MG/DL', 'µmol/L', 'creatinine'));
  assert.equal(convertClinicalUnit(1.2, 'mg/dl', 'UMOL/L', 'creatinine')?.value, 1.2 * 88.4);
  // A unit the quote must state may be stated in any listed spelling; a unit that was not required to be found still is not.
  assert.equal(clinicalUnitInQuote('mg/dL', '肌酐 1.2 MG/DL'), true);
  assert.equal(clinicalUnitInQuote('ng/mL', '肌钙蛋白 0.02 NG/ML', true), true);
  assert.equal(clinicalUnitInQuote('ng/mL', '肌钙蛋白 0.02 ug/mL', true), false);
  assert.equal(clinicalUnitInQuote('ng/mL', '肌钙蛋白 0.02，单位未记载'), false, 'a unit of the table is held to the quote whether or not the fact says it is a laboratory value (E-10)');
  assert.equal(clinicalUnitInQuote('ng/mL', '肌钙蛋白 0.02 NG/ML'), true);
  assert.equal(clinicalUnitInQuote('mU/L', '促甲状腺素 3 MU/L', true), false, 'an unlisted unit is still found exactly');
});

test('a unit supports a value only where it is printed beside that value, for any fact whose unit can be checked (E-10)', () => {
  // The quote prints two units; the fact's own number carries only one of them. "Somewhere in the quote" passed both.
  const two = '血糖 6.1 mmol/L（110 mg/dL）';
  assert.equal(clinicalUnitInQuote('mmol/L', two, false, 6.1), true);
  assert.equal(clinicalUnitInQuote('mg/dL', two, false, 110), true);
  assert.equal(clinicalUnitInQuote('mg/dL', two, false, 6.1), false, 'mg/dL is in the quote, beside 110 and not beside 6.1');
  assert.equal(clinicalUnitInQuote('mmol/L', two, false, 110), false);
  assert.equal(clinicalUnitInQuote('mg/dL', two), true, 'asked without a value it is the old question: is the unit anywhere in the quote');
  // A few characters of flag or punctuation between the number and its unit, a thousands separator, a header unit before the number.
  assert.equal(clinicalUnitInQuote('umol/L', '肌酐 98 ↑ μmol/L 参考 44-133', false, 98), true);
  assert.equal(clinicalUnitInQuote('mg/dL', '肌酐 1.2（偏高）mg/dL', false, 1.2), true);
  assert.equal(clinicalUnitInQuote('U/L', 'ALT 1,200 U/L', false, 1200), true);
  assert.equal(clinicalUnitInQuote('umol/L', '肌酐(μmol/L)：98', false, 98), true, 'a unit named in brackets before its number');
  assert.equal(clinicalUnitInQuote('10^9/L', '白细胞 4.5×10^9/L', false, 4.5), true);
  assert.equal(clinicalUnitInQuote('mg/dL', '肌酐 1.2 和 1.5 mg/dL', false, 1.2), false, 'another number stands between 1.2 and the unit');
  assert.equal(clinicalUnitInQuote('mg/dL', '血清 mg/dL 法测得肌酐为 1.2，单位未记载', false, 1.2), false, 'a unit elsewhere in the sentence is not beside it');
  assert.equal(clinicalUnitInQuote('g/L', '血红蛋白 11.5 mg/L', false, 11.5), false, 'g/L is not the tail of mg/L');
  // A number is the number printed, not a digit run inside a longer one.
  assert.equal(clinicalUnitInQuote('mg/dL', '肌酐 11.2 mg/dL', false, 1.2), false);
  // Unlisted units still need literal support, beside the value, with the case they were written in.
  assert.equal(clinicalUnitInQuote('mmol/mol', 'HbA1c 48 mmol/mol', true, 48), true);
  assert.equal(clinicalUnitInQuote('mmol/mol', 'HbA1c 48，单位未记载', true, 48), false);
  assert.equal(clinicalUnitInQuote('mL/min/1.73m2', 'eGFR 85 mL/min/1.73 m2', true, 85), true, 'spacing inside the unit is not part of the unit');
  assert.equal(clinicalUnitInQuote('mU/L', '促甲状腺素 3 MU/L', true, 3), false);
  // The fact need not carry a laboratory block: a unit in the table, or one written as a ratio or a percentage, is held to the quote too.
  assert.equal(clinicalUnitInQuote('ng/mL', '肌钙蛋白 0.02，单位未记载', false, 0.02), false);
  assert.equal(clinicalUnitInQuote('mmol/mol', 'HbA1c 48，单位未记载', false, 48), false);
  assert.equal(clinicalUnitInQuote('%', '血氧饱和度 97%', false, 97), true);
  assert.equal(clinicalUnitInQuote('%', '血氧饱和度 97，单位未记载', false, 97), false);
  // A unit spelled as a word or a bare symbol is not chased: the same chart writes 岁, 公斤, 厘米.
  for (const [unit, quote, value] of /** @type {[string, string, number][]} */ ([['year', '年龄44岁', 44], ['kg', '体重 70 公斤', 70], ['score', 'ECOG 评分 1 分', 1]])) {
    assert.equal(clinicalUnitInQuote(unit, quote, false, value), null, unit);
  }
  assert.equal(clinicalUnitInQuote('kg', '体重 70 公斤', true, 70), false, 'but a fact that says it is a laboratory value is held to what it says');
  assert.equal(clinicalUnitInQuote('kg', '体重 70kg', true, 70), true);
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
