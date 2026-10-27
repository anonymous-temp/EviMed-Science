import { describe, expect, it } from 'vitest';
import { GEO_ANALYSIS_OPTIONS, geoAnalysisDescriptor, geoAnalysisSearch } from './geoAnalysisMode';

describe('GEO main area analysis address', () => {
  it('names all 27 views separately from the business view', () => {
    expect(new Set(GEO_ANALYSIS_OPTIONS.map(item => item.value)).size).toBe(27);
    expect(geoAnalysisDescriptor('?view=journey&analysis=V10')?.viewId).toBe('V10');
    expect(geoAnalysisDescriptor('?analysis=V99')).toBeNull();
  });
  it('preserves exact scope and frozen versions through analysis and return', () => {
    const original = '?view=journey&session=s&rounds=r&questionVersion=3&selectionRef=sel&strategyVersion=7&targetVersion=4&from=2026-01-01';
    const query = geoAnalysisSearch(original, { viewId: 'V26', strategyVersion: 7, targetVersion: 4 });
    expect(geoAnalysisDescriptor(query)).toMatchObject({ viewId: 'V26', strategyVersion: 7, targetVersion: 4 });
    const returned = new URLSearchParams(geoAnalysisSearch(query, null));
    for (const [key, value] of new URLSearchParams(original)) expect(returned.get(key)).toBe(value);
    expect(returned.has('analysis')).toBe(false);
  });
});

it('clears frozen versions explicitly while preserving the originating business query on return', () => {
  const origin = '?view=cited&sourceSearch=Business+query&strategyVersion=7&targetVersion=3&session=s1&selectionRef=exact';
  const analysis = geoAnalysisSearch(origin, {viewId:'V26',strategyVersion:7,targetVersion:3,sourceSearch:'Analysis query'});
  const latest = geoAnalysisSearch(analysis, {viewId:'V26',strategyVersion:undefined,targetVersion:undefined});
  expect(new URLSearchParams(latest).has('strategyVersion')).toBe(false);
  expect(new URLSearchParams(latest).has('targetVersion')).toBe(false);
  const returned = new URLSearchParams(geoAnalysisSearch(latest, null));
  expect(returned.get('sourceSearch')).toBe('Business query');
  expect(returned.get('strategyVersion')).toBe('7');
  expect(returned.get('targetVersion')).toBe('3');
  expect(returned.get('selectionRef')).toBe('exact');
  expect(geoAnalysisSearch(origin, null)).toBe(new URLSearchParams(origin).toString());
});


it('inherits omitted frozen identity on entry while respecting an explicit clear', () => {
 const origin='?strategyVersion=7&targetVersion=3&selectionRef=exact';
 expect(geoAnalysisDescriptor(geoAnalysisSearch(origin,{viewId:'V26'}))).toMatchObject({strategyVersion:7,targetVersion:3});
 const cleared=new URLSearchParams(geoAnalysisSearch(origin,{viewId:'V26',strategyVersion:undefined,targetVersion:undefined}));
 expect(cleared.has('strategyVersion')).toBe(false);expect(cleared.has('targetVersion')).toBe(false);
});
