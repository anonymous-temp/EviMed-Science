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
  assert.equal(geoScopeFromQuery(new URLSearchParams('errorTrace=noRetrieval&errorOffset=40')).errorTrace, 'noRetrieval');
  assert.throws(() => geoErrorFilters({ errorTrace: 'invented' }), e => e.code === 'geo_read_filter_invalid');
});
