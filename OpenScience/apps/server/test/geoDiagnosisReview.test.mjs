import assert from 'node:assert/strict';
import test from 'node:test';
import { errorFingerprint } from '../src/geoErrors.mjs';
import { geoErrorFilters, geoScopeFromQuery } from '../src/geoReadScope.mjs';

test('condition identity separates equal wording for different populations and formulations', () => {
  const statement = { claimKey: 'same', text: 'Use once daily.', claimVersion: 1, applicability: { population: 'Adults', elements: { form: 'tablet' } } };
  assert.notEqual(errorFingerprint(statement), errorFingerprint({ ...statement, applicability: { ...statement.applicability, population: 'Children' } }));
  assert.notEqual(errorFingerprint(statement), errorFingerprint({ ...statement, applicability: { ...statement.applicability, elements: { form: 'solution' } } }));
  assert.notEqual(errorFingerprint(statement), errorFingerprint({ ...statement, applicability: null }));
  assert.equal(errorFingerprint(statement), errorFingerprint({ ...statement, text: 'Another wording.' }));
});

test('diagnosis filters accept explicit source tracing and reject unsupported trace categories', () => {
  assert.equal(geoErrorFilters({ errorTrace: 'traced' }).trace, 'traced');
  assert.deepEqual(geoErrorFilters({ errorTypes: ['unknown'] }).types, ['unknown']);
  assert.equal(geoScopeFromQuery(new URLSearchParams('errorTrace=noRetrieval&errorOffset=40')).errorTrace, 'noRetrieval');
  assert.throws(() => geoErrorFilters({ errorTrace: 'invented' }), e => e.code === 'geo_read_filter_invalid');
});

test('the judge retains equal answer sentences judged against different applicable populations', async () => {
  const { buildJudgeInput, verifyJudgement } = await import('../src/geoJudge.mjs');
  const text = 'Use once daily.';
  const claims = ['Adults', 'Children'].map((population, index) => ({ id: `claim_${index}`, key: 'same_fact', population, elements: { form: index ? 'solution' : 'tablet' }, statement: 'Use weekly.', quote: 'Use once weekly.', inLabel: true }));
  const input = { owner: { userId: 'u', projectId: 'p' }, product: {}, competitors: [], careFlags: [], question: { text: 'How?' }, answer: text, claims };
  const built = buildJudgeInput(input);
  const result = verifyJudgement({ statements: claims.map((_, index) => ({ text, claim: `C${index + 1}`, verdict: 'wrong', evidence: 'Use once weekly.', errorType: 'dropped_condition', severity: 'S3' })) }, built, input);
  assert.equal(result.statements.length, 2);
  assert.deepEqual(result.statements.map(row => row.applicability.population), ['Adults', 'Children']);
});

test('same-word judgments retain distinct claim ids, versions and every applicability field', async () => {
  const { buildJudgeInput, verifyJudgement } = await import('../src/geoJudge.mjs');
  const base = { id: 'base', key: 'shared', version: 1, population: 'Adults', elements: { form: 'tablet' }, inLabel: true, validUntil: '2026-12-31', evidenceLevel: 'label', quote: 'Use only for adults.', statement: 'Adults only.' };
  const text = 'Everyone can use it.';
  const claims = [base, { ...base, id: 'other' }, { ...base, version: 2 }, { ...base, inLabel: false }, { ...base, validUntil: '2025-12-31' }, { ...base, evidenceLevel: 'trial' }];
  const input = { owner: { userId: 'u', projectId: 'p' }, product: {}, competitors: [], careFlags: [], question: { text: 'Who?' }, answer: text, claims };
  const result = verifyJudgement({ assessmentComplete: true, statements: claims.map((_, index) => ({ text, claim: `C${index + 1}`, verdict: 'wrong', evidence: base.quote, errorType: 'dropped_condition', severity: 'S3' })) }, buildJudgeInput(input), input);
  assert.equal(result.statements.length, claims.length);
  assert.equal(result.dropped.length, 0, 'distinct claims cannot disappear without a recorded reason');
  assert.equal(new Set(result.statements.map(errorFingerprint)).size, claims.length);
});

test('the same resolution proof rejects incomplete coverage and lost quote or answer anchors', async () => {
  const { geoErrorResolutionSatisfied } = await import('../src/geoErrors.mjs');
  const scope = { population: 'Adults', elements: { form: 'tablet' }, inLabel: true, validUntil: null, evidenceLevel: 'label' };
  const basis = { id: 'exact', key: 'fact', version: 1, ...scope, quote: 'Only adults may use the tablet.' };
  const original = { claimId: 'exact', claimKey: 'fact', claimVersion: 1, applicability: scope, verdict: 'wrong' };
  const correct = { ...original, text: basis.quote, verdict: 'correct', evidence: basis.quote };
  const answer = { status: 'valid', judgedAt: '2026-10-24T00:00:00Z', answerText: basis.quote, statements: [correct], checks: { judgementCoverage: { status: 'complete' } } };
  assert.equal(geoErrorResolutionSatisfied(original, answer, basis), true);
  for (const changed of [
    { ...answer, checks: { judgementCoverage: { status: 'partial' } } },
    { ...answer, checks: { judgementCoverage: { status: 'unknown' } } },
    { ...answer, statements: [{ ...correct, evidence: 'Unsupported evidence quote.' }] },
    { ...answer, answerText: 'The original sentence is no longer present.' },
    { ...answer, statements: [{ ...correct, claimVersion: 2 }] },
  ]) assert.equal(geoErrorResolutionSatisfied(original, changed, basis), false);
});
