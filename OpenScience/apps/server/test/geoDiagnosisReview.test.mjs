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
