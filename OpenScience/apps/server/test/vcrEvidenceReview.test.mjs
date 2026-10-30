import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createVcrEvidenceSources, literatureUnitIsInQuote, verifyLiteratureBaseline } from '../src/vcrEvidenceSources.mjs';
import { bindEvidenceTrialIdentity, evidenceTrialIdentity } from '../src/vcrTrialIdentity.mjs';
import { poolEligibility, poolJob, verifyExtraction } from '../src/vcrEvidence.mjs';
import { numericLiteralInSpan, numericLiteralSpans } from '../src/vcrNumericLiterals.mjs';

test('compound units, symbol case and adjacent numeric values keep their literal meaning', () => {
  for (const [quote, unit] of [['BMI 27.1 kg/m2', 'kg'], ['BMI 27.1 kg/m²', 'm'], ['BMI 27.1 kg / m²', 'kg'], ['BMI 27.1 kg · m^-2', 'kg'], ['Mean 27.1 UNKNOWN', 'UNKNOWN'], ['Mean 27.1 Unknown', 'Unknown'], ['HbA1c 7.2 mmol/mol', 'mmol'], ['2.5 mM', 'mm']]) {
    assert.equal(literatureUnitIsInQuote(quote, unit), false, `${quote}: ${unit}`);
  }
  for (const [quote, unit] of [['BMI 27.1 kg/m²', 'kg/m2'], ['BMI 27.1 kg / m²', 'kg/m2'], ['Response 40%', '%'], ['Follow-up 12 MONTHS', 'month'], ['2.5 mM', 'mM']]) {
    assert.equal(literatureUnitIsInQuote(quote, unit), true, `${quote}: ${unit}`);
  }
});

test('typeset separated signs remain signed and cannot be omitted from a source span', () => {
  for (const sign of ['-', '−', '+']) {
    for (const space of [' ', '\u2009', '\n']) {
      const text = `Mean change ${sign}${space}12.4 points`;
      const number = text.indexOf('12.4'); const start = text.indexOf(sign);
      const value = sign === '+' ? 12.4 : -12.4;
      assert.equal(numericLiteralInSpan(text, number, number + 4, 12.4), false);
      assert.equal(numericLiteralInSpan(text, start, number + 4, value), true);
      assert.equal([...numericLiteralSpans(text)][0].value, value);
    }
  }
});

test('derived literature inputs need exact numeric spans, not a letter or a clipped number', async () => {
  const text = 'Trial NCT00000001: mean was 62.4 years; n = 100.';
  const hash = createHash('sha256').update(text).digest('hex');
  const source = { id: 'src_one', userId: 'u', projectId: 'p', payload: { generation: 1, analysis: { textSha256: hash } } };
  const resolver = createVcrEvidenceSources({ sources: { get: async () => source, loadCapture: async () => ({ input: { text } }) } });
  const base = { userId: 'u', projectId: 'p', source: { sourceId: source.id, generation: 1, textSha256: hash }, quote: text,
    locator: { start: 0, end: text.length }, unit: 'year' };
  await assert.rejects(resolver.resolve({ ...base, locator: { ...base.locator, inputs: ['n'] } }), { code: 'vcr_evidence_unverified' });
  const start = text.indexOf('62.4');
  for (const [quote, value, verified] of [['62', 62, false], ['62.4', 62.4, true]]) {
    const found = await resolver.resolve({ ...base, locator: { ...base.locator, inputs: [{ start, end: start + String(quote).length, quote, value }] } });
    const checked = verifyExtraction({ sourceText: text, extraction: { quote: text, value: 63, valueSource: 'calculated', locator: found.locator } });
    assert.equal(checked.verified, verified);
  }
});

test('registry and article reports of one trial never create two independent pooled observations', () => {
  const common = { value: .4, ci_low: .3, ci_high: .5, unit: 'proportion', endpoint_key: 'response', arm_role: 'control', historical_baseline: true, locator: { verification: 'verified' } };
  const rows = [
    { ...common, id: 'registry', source_ref: 'ctgov:NCT00000001' },
    { ...common, id: 'article', source_ref: 'source:article', detail: { trialIdentity: 'clinicaltrials.gov:NCT00000001' } },
    { ...common, id: 'second', source_ref: 'source:article', detail: { trialIdentity: 'clinicaltrials.gov:NCT00000002' } },
  ];
  assert.equal(evidenceTrialIdentity(rows[0]), evidenceTrialIdentity(rows[1]));
  const eligibility = poolEligibility({ items: rows, endpointKey: 'response', armRole: 'control' });
  assert.deepEqual(eligibility.eligible.map(row => row.id), ['registry', 'second']);
  assert.deepEqual(eligibility.refused.map(row => row.reasons), [['duplicate_trial']]);
  const built = poolJob({ studyId: 'study', parameter: 'control_event_rate', calibre: 'overall', items: rows });
  assert.equal(built.valid, true);
  assert.deepEqual(built.job.scenario.studies.map(row => row.studyId), ['registry', 'second']);
  assert.deepEqual(built.excluded, [{ id: 'article', reason: 'duplicate_trial' }]);
  assert.equal(poolJob({ studyId: 'study', parameter: 'control_event_rate', calibre: 'overall', items: [{ ...common, id: 'unknown' }] }).excluded[0].reason, 'trial_identity_missing');
});

test('one article can declare separate source-bound trial units without using its document id as a trial', () => {
  const literature = { locator: { parts: { trialIdentity: { quote: 'Trials NCT00000001 and NCT00000002.' } } } };
  const identity = registryId => bindEvidenceTrialIdentity({ asked: { registry: 'clinicaltrials.gov', registryId }, registry: '', registryId: '', literature });
  assert.notEqual(identity('NCT00000001'), identity('NCT00000002'));
  assert.throws(() => identity('NCT00000003'));
  assert.equal(bindEvidenceTrialIdentity({ asked: null, registry: '', registryId: '', literature }), null);
});

test('a cited correlation without independent bindings cannot inherit verified marginal standing', async () => {
  const input = { userId: 'u', studyId: 's', baselineTable: [{ variable: 'age', mean: 62 }], bindings: [{ variable: 'age', field: 'mean', unit: 'year', evidenceId: 'e' }],
    store: { verifiedItemsById: async () => [{ id: 'e', parameter: 'age.mean', value: 62, unit: 'year', value_source: 'extracted', locator: { verification: 'verified' }, detail: { evidenceKind: 'baseline' } }] } };
  assert.equal((await verifyLiteratureBaseline({ ...input, correlationSource: 'assumed' })).ok, true);
  const rejected = await verifyLiteratureBaseline({ ...input, correlationSource: 'cited' });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.issues.some(issue => issue.code === 'correlation_source_unverified'));
});
