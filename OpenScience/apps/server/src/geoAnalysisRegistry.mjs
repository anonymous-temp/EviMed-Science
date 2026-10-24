/** Only implemented selected-analysis descriptors are admitted. */
import { GEO_METRIC_IDS } from '@evimed/domain';
import { GEO_COVERAGE_VIEWS } from './geoAnalysisCoverage.mjs';
import { HttpError } from './security.mjs';
export const GEO_ANALYSIS_REGISTRY = Object.freeze(Object.fromEntries([
  [
    'V01', 'readings'
  ], [
    'V02', 'readings'
  ], [
    'V03', 'comparison'
  ], [
    'V08', 'rivals'
  ], [
    'V09', 'recommendations'
  ], [
    'V17', 'sources'
  ], [
    'V18', 'sources'
  ], [
    'V04', 'metrics'
  ], [
    'V05', 'metrics'
  ],
  ...GEO_COVERAGE_VIEWS.map(id => [
    id, 'coverage'
  ]),
].map(([id, family]) => [
  id, {
    id, family
  }
])));
export const GEO_ANALYSIS_DESCRIPTOR_FIELDS = Object.freeze([
  'viewId', 'metricId', 'dimension', 'categoryMode', 'timeGrain', 'entityKind', 'entityKey', 'sourceType', 'sourceSearch', 'sourceRelationship', 'sourceLevel', 'topN'
]);
const invalid = () => new HttpError(400, 'geo_read_filter_invalid', 'Choose a registered analysis view and its supported options.');
/** @param {any} [input] */
export function normalizeGeoAnalysisView(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !GEO_ANALYSIS_DESCRIPTOR_FIELDS.includes(key)))
    throw invalid();
  const viewId = input.viewId ?? 'V01', metricView = [
    'V02', 'V03', 'V04', 'V05'
  ].includes(viewId), family = GEO_ANALYSIS_REGISTRY[viewId]?.family;
  const metricId = input.metricId ?? (viewId === 'V08' ? 'M-16' : metricView ? 'M-01' : null), dimension = input.dimension ?? (viewId === 'V05' ? 'group' : metricView ? 'engine' : 'project');
  if (!family || (metricId !== null && !GEO_METRIC_IDS.includes(metricId)) || ![
    'project', 'engine', 'group'
  ].includes(dimension))
    throw invalid();
  if (family === 'metrics' && [
    'M-16', 'M-17', 'M-18', 'M-21'
  ].includes(metricId))
    throw invalid();
  if (input.categoryMode != null && (viewId !== 'V06' || ![
    'original_group', 'client_tags'
  ].includes(input.categoryMode)))
    throw invalid();
  if ((family === 'coverage' && viewId !== 'V06' || family === 'recommendations') && metricId != null)
    throw invalid();
  if (input.timeGrain != null && (!['V02', 'V08'].includes(viewId) || ![
    'day', 'round'
  ].includes(input.timeGrain)))
    throw invalid();
  if ((input.entityKind != null || input.entityKey != null) && !['metrics', 'rivals'].includes(family))
    throw invalid();
  if (input.entityKind != null && ![
    'brand', 'generic'
  ].includes(input.entityKind))
    throw invalid();
  if (input.entityKey != null && (viewId !== 'V08' && input.entityKind !== 'generic' || typeof input.entityKey !== 'string' || !input.entityKey.trim() || input.entityKey.length > 300))
    throw invalid();
  if (viewId === 'V08' && (input.entityKind === 'generic' || !['M-16','M-17'].includes(metricId))) throw invalid();
  if (viewId === 'V09' && dimension !== 'project') throw invalid();
  if (viewId === 'V04' && dimension !== 'engine' || viewId === 'V05' && dimension !== 'group')
    throw invalid();
  const sourceFields=['sourceType','sourceSearch','sourceRelationship','sourceLevel','topN'];
  if (family !== 'sources' && sourceFields.some(key=>input[key]!=null)) throw invalid();
  if (family === 'sources') {
    if (metricId!==null || dimension!=='project') throw invalid();
    for (const [key,max] of [['sourceType',100],['sourceSearch',300]]) if(input[key]!=null&&(typeof input[key]!=='string'||!input[key].trim()||input[key].length>Number(max))) throw invalid();
    if(input.sourceRelationship!=null&&!['all','wrong','mentions'].includes(input.sourceRelationship)) throw invalid();
    if(input.sourceLevel!=null&&(viewId!=='V18'||!['domain','page'].includes(input.sourceLevel))) throw invalid();
    if(input.topN!=null&&(!Number.isSafeInteger(input.topN)||input.topN<1||input.topN>50)) throw invalid();
  }
  return {
    ...(family==='sources'?{...(input.sourceType?{sourceType:input.sourceType.trim()}:{}),...(input.sourceSearch?{sourceSearch:input.sourceSearch.trim()}:{}),sourceRelationship:input.sourceRelationship??'all',...(viewId==='V18'?{sourceLevel:input.sourceLevel??'domain'}:{}),topN:input.topN??15}:{}),
    viewId, metricId: input.entityKind === 'generic' ? null : metricId, dimension,
    ...(viewId === 'V06' ? {
      categoryMode: input.categoryMode ?? 'original_group'
    } : {}),
    ...(['V02', 'V08'].includes(viewId) ? {
      timeGrain: input.timeGrain ?? 'day'
    } : {}),
    ...(['metrics', 'rivals'].includes(family) ? {
      entityKind: input.entityKind ?? 'brand', ...(input.entityKey != null ? {
        entityKey: input.entityKey
      } : {})
    } : {})
  };
}
