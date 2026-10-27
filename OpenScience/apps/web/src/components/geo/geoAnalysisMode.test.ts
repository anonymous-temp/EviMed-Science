import { describe, expect, it } from 'vitest';
import type { GeoAnalysisDescriptor, GeoAnalysisId } from '@/lib/geoAnalysisClient';
import { normalizeGeoAnalysisView } from '../../../../server/src/geoAnalysisRegistry.mjs';
import { GEO_ANALYSIS_OPTIONS, GEO_ANALYSIS_VIEW_FIELDS, geoAnalysisChangeReplaces, geoAnalysisDescriptor, geoAnalysisDescriptorForView, geoAnalysisSearch } from './geoAnalysisMode';

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


/** One non-default, registry-valid value per descriptor field, so a descriptor "as the person left it" is as populated as a view allows. */
const FILLED: Record<string, string | number> = {
  metricId: 'M-03', timeGrain: 'round', categoryMode: 'client_tags', errorFacet: 'severity', errorView: 'all', evidenceKind: 'findings',
  publicationFacet: 'audience', financeFacet: 'group', strategyVersion: 7, targetVersion: 3, sourceType: 'official', sourceSearch: 'guideline',
  sourceRelationship: 'wrong', topN: 30, sourceLevel: 'page', sourceFacet: 'group', ownedMetricId: 'M-08S', entityKind: 'brand',
};
function filled(viewId: GeoAnalysisId): GeoAnalysisDescriptor {
  // The views that read a whole project only (their registry family) are refused any other dimension.
  const dimension = viewId === 'V05' ? 'group' : ['V01', 'V02', 'V03', 'V04', 'V06', 'V07', 'V08', 'V11', 'V12', 'V14'].includes(viewId) ? 'engine' : 'project';
  const descriptor: Record<string, string | number> = { viewId, dimension };
  for (const key of GEO_ANALYSIS_VIEW_FIELDS[viewId]) descriptor[key] = FILLED[key];
  if (viewId === 'V08') descriptor.metricId = 'M-17';
  if (viewId === 'V04' || viewId === 'V05') { descriptor.entityKind = 'generic'; descriptor.entityKey = 'aspirin'; delete descriptor.metricId; }
  if (viewId === 'V08') descriptor.entityKey = 'rival';
  return descriptor as unknown as GeoAnalysisDescriptor;
}
const VIEWS = GEO_ANALYSIS_OPTIONS.map(item => item.value);

describe('switching the analysis view builds a descriptor the server admits', () => {
  it('declares, for every view, exactly the fields its registry validation takes', () => {
    for (const viewId of VIEWS) expect(() => normalizeGeoAnalysisView(filled(viewId)), `${viewId} as filled`).not.toThrow();
    // A field the table does not give a view is refused by the registry, which is why it must not be carried there.
    for (const viewId of VIEWS) for (const [key, value] of Object.entries(FILLED)) {
      if (GEO_ANALYSIS_VIEW_FIELDS[viewId].includes(key as never)) continue;
      expect(() => normalizeGeoAnalysisView({ ...geoAnalysisDescriptorForView(viewId), [key]: value }), `${viewId} must refuse ${key}`).toThrow();
    }
  });

  it('is accepted for every view reached from every other view, however much the first one was filled in', () => {
    const refused: string[] = [];
    for (const from of VIEWS) for (const to of VIEWS) {
      const next = geoAnalysisDescriptorForView(to, filled(from));
      expect(next.viewId).toBe(to);
      try { normalizeGeoAnalysisView(next); } catch { refused.push(`${from}→${to}`); }
    }
    expect(refused).toEqual([]);
  });

  it('is exactly what spreading the open descriptor was not: V26→trend, dimension V05→V04, source type V17→V01 each fail that way', () => {
    for (const [from, to] of [['V26', 'V02'], ['V05', 'V04'], ['V17', 'V01'], ['V13', 'V10'], ['V21', 'V17']] as const) {
      expect(() => normalizeGeoAnalysisView({ ...filled(from), viewId: to }), `${from}→${to} spread`).toThrow();
      expect(() => normalizeGeoAnalysisView(geoAnalysisDescriptorForView(to, filled(from))), `${from}→${to} built`).not.toThrow();
    }
  });

  it('carries only what means the same in both views', () => {
    expect(geoAnalysisDescriptorForView('V03', { viewId: 'V02', metricId: 'M-05', dimension: 'group', timeGrain: 'round' })).toEqual({ viewId: 'V03', dimension: 'engine', metricId: 'M-05' });
    expect(geoAnalysisDescriptorForView('V08', { viewId: 'V02', metricId: 'M-05', timeGrain: 'round' })).toEqual({ viewId: 'V08', dimension: 'project', timeGrain: 'round' });
    expect(geoAnalysisDescriptorForView('V19', { viewId: 'V17', sourceType: 'official', sourceRelationship: 'wrong', topN: 5 })).toMatchObject({ viewId: 'V19', sourceType: 'official', sourceRelationship: 'wrong', topN: 5 });
    expect(geoAnalysisDescriptorForView('V26', { viewId: 'V26', strategyVersion: 7, targetVersion: 3 })).toMatchObject({ strategyVersion: 7, targetVersion: 3 });
    expect(geoAnalysisDescriptorForView('V10', { viewId: 'V26', strategyVersion: 7 })).toEqual({ viewId: 'V10', dimension: 'project' });
  });

  it('does not hand a frozen plan version from the business address to any view but V26', () => {
    const planAddress = '?step=sources&strategyVersion=7&targetVersion=4&selectionRef=gsel_exact';
    for (const to of VIEWS.filter(id => id !== 'V26')) {
      const entered = geoAnalysisDescriptor(geoAnalysisSearch(planAddress, geoAnalysisDescriptorForView(to)));
      expect(entered, to).not.toBeNull();
      expect(entered).not.toHaveProperty('strategyVersion');
      expect(() => normalizeGeoAnalysisView(entered), `${to} from the plan address`).not.toThrow();
    }
    expect(geoAnalysisDescriptor(geoAnalysisSearch(planAddress, geoAnalysisDescriptorForView('V26')))).toMatchObject({ viewId: 'V26', strategyVersion: 7, targetVersion: 4 });
  });

  it('leaves no analysis-only field in the business address when a direct analysis link is left', () => {
    const direct = '?view=journey&analysis=V26&strategyVersion=7&targetVersion=3&selectionRef=gsel_exact';
    const returned = new URLSearchParams(geoAnalysisSearch(direct, null));
    expect(returned.has('strategyVersion')).toBe(false);
    expect(returned.has('targetVersion')).toBe(false);
    expect(returned.get('selectionRef')).toBe('gsel_exact');
    // …so the next view opened from it is not refused a field it does not take.
    const next = geoAnalysisDescriptor(geoAnalysisSearch(returned.toString(), geoAnalysisDescriptorForView('V02')));
    expect(() => normalizeGeoAnalysisView(next)).not.toThrow();
  });

  it('replaces the history entry for a change inside the open view, and adds one for opening, switching and leaving', () => {
    const open = '?analysis=V17&topN=15';
    expect(geoAnalysisChangeReplaces(open, { viewId: 'V17', topN: 30 })).toBe(true);
    expect(geoAnalysisChangeReplaces(open, { viewId: 'V18' })).toBe(false);
    expect(geoAnalysisChangeReplaces(open, null)).toBe(false);
    expect(geoAnalysisChangeReplaces('?step=sources', { viewId: 'V17' })).toBe(false);
  });
});
