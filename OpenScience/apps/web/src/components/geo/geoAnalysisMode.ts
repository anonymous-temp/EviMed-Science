import type { GeoAnalysisDescriptor, GeoAnalysisId } from "@/lib/geoAnalysisClient";

/** Component contract: GEO analysis mode; URL owns identity, scope and return context. */
export const GEO_ANALYSIS_OPTIONS: ReadonlyArray<{ value: GeoAnalysisId; label: string }> = [
              { value: "V01", label: "当前水平与目标" },
              { value: "V02", label: "指标趋势" },
              { value: "V03", label: "可比变化排序" },
              { value: "V10", label: "旅程与需求覆盖" },
              { value: "V16", label: "结论条件与来源依据" },
              { value: "V13", label: "讲错类型与严重程度" },
              { value: "V23", label: "内容与发布覆盖" },
              { value: "V24", label: "投放与发布状态" },
              { value: "V25", label: "预算、结算与退款" },
              { value: "V26", label: "方案冻结实测与规划目标" },
              { value: "V15", label: "错误观察与处理历史" },
              { value: "V27", label: "事件与采样观察" },
              { value: "V09", label: "推荐表达与条件" },
              { value: "V08", label: "已登记竞品与趋势" },
              { value: "V04", label: "平台指标比较" },
              { value: "V05", label: "问题群与平台" },
              { value: "V06", label: "原始分类与平台" },
              { value: "V07", label: "逐题采集与判定" },
              { value: "V11", label: "采集与判定覆盖" },
              { value: "V12", label: "回答与陈述正确性" },
              { value: "V14", label: "临床主题与条件" },
              { value: "V17", label: "来源类型覆盖" },
              { value: "V18", label: "域名与页面排名" },
              { value: "V19", label: "来源与平台或问题群" },
              { value: "V20", label: "已确认信源关系" },
              { value: "V21", label: "问题群提及与自有引用" },
              { value: "V22", label: "页面引用观察历史" },
            ];
const descriptorKeys = ['errorFacet','errorView','metricId','dimension','timeGrain','entityKind','entityKey','sourceType','sourceSearch','sourceRelationship','sourceLevel','sourceFacet','topN','ownedMetricId','categoryMode','financeFacet','strategyVersion','targetVersion','publicationFacet','evidenceKind'] as const;

type DescriptorKey = typeof descriptorKeys[number];
const SOURCE_FILTERS = ['sourceType', 'sourceSearch', 'sourceRelationship', 'topN'] as const;
/**
 * What each view declares besides `viewId` and `dimension`. The server (`geoAnalysisRegistry.mjs`) answers a field its view does not
 * declare with 400 `geo_read_filter_invalid`, so a descriptor is built from this table and never by spreading another view's.
 * `geoAnalysisMode.test.ts` holds the table against the registry's own validation.
 */
export const GEO_ANALYSIS_VIEW_FIELDS: Readonly<Record<GeoAnalysisId, readonly DescriptorKey[]>> = {
  V01: ['metricId'], V02: ['metricId', 'timeGrain'], V03: ['metricId'],
  V04: ['metricId', 'entityKind', 'entityKey'], V05: ['metricId', 'entityKind', 'entityKey'],
  V06: ['metricId', 'categoryMode'], V07: [], V11: [], V12: [], V14: [],
  V08: ['metricId', 'timeGrain', 'entityKind', 'entityKey'],
  V09: [], V10: [], V15: [], V24: [],
  V13: ['errorFacet', 'errorView'], V16: ['evidenceKind'], V23: ['publicationFacet'], V25: ['financeFacet'],
  V26: ['strategyVersion', 'targetVersion'], V27: ['metricId'],
  V17: [...SOURCE_FILTERS], V18: [...SOURCE_FILTERS, 'sourceLevel'], V19: [...SOURCE_FILTERS, 'sourceLevel', 'sourceFacet'],
  V20: [...SOURCE_FILTERS], V21: ['ownedMetricId'], V22: [...SOURCE_FILTERS, 'sourceLevel'],
};
/** The dimension a view opens on; the views that do not choose one are read as a whole project. */
function defaultDimension(viewId: GeoAnalysisId): NonNullable<GeoAnalysisDescriptor['dimension']> {
  return viewId === 'V05' ? 'group' : ['V02', 'V03', 'V04'].includes(viewId) ? 'engine' : 'project';
}
/** Metrics the view cannot read (the registry's own refusals): rivals read M-16/M-17 only, the platform views none of the rival and cost ones. */
function metricFits(viewId: GeoAnalysisId, metricId: string): boolean {
  if (viewId === 'V08') return ['M-16', 'M-17'].includes(metricId);
  if (['V04', 'V05', 'V27'].includes(viewId)) return !['M-16', 'M-17', 'M-18', 'M-21'].includes(metricId);
  return true;
}
/**
 * The descriptor for choosing `viewId` while `from` is open: the new view's own defaults, plus the choices that mean the same in both
 * views (metric, time grain, source filters, entity). A frozen plan version belongs to V26 alone and is never carried into another view.
 */
export function geoAnalysisDescriptorForView(viewId: GeoAnalysisId, from?: GeoAnalysisDescriptor | null): GeoAnalysisDescriptor {
  const next: Record<string, string | number> = { viewId, dimension: defaultDimension(viewId) };
  if (!from || from.viewId === viewId) return from ? { ...from } : next as unknown as GeoAnalysisDescriptor;
  const declared = GEO_ANALYSIS_VIEW_FIELDS[viewId];
  const was = GEO_ANALYSIS_VIEW_FIELDS[from.viewId];
  const carry = (key: DescriptorKey) => {
    const value = from[key];
    if (value != null && declared.includes(key) && was.includes(key)) next[key] = value as string | number;
  };
  if (typeof from.metricId === 'string' && declared.includes('metricId') && was.includes('metricId') && metricFits(viewId, from.metricId)) next.metricId = from.metricId;
  carry('timeGrain');
  // The platform views share one entity choice; a rival view reads brands only and a generic name needs a metric-free read.
  if (['V04', 'V05'].includes(viewId) && ['V04', 'V05'].includes(from.viewId)) for (const key of ['entityKind', 'entityKey'] as const) carry(key);
  if (viewId !== 'V21' && from.viewId !== 'V21') for (const key of SOURCE_FILTERS) carry(key);
  return next as unknown as GeoAnalysisDescriptor;
}
/** A change inside the open view (a filter, a search) replaces the history entry; opening, switching and leaving a view add one. */
export function geoAnalysisChangeReplaces(search: string, descriptor: GeoAnalysisDescriptor | null): boolean {
  const open = geoAnalysisDescriptor(search);
  return !!descriptor && !!open && open.viewId === descriptor.viewId;
}
export function geoAnalysisDescriptor(search: string): GeoAnalysisDescriptor | null {
  const params = new URLSearchParams(search);
  const viewId = params.get('analysis');
  if (!GEO_ANALYSIS_OPTIONS.some(item => item.value === viewId)) return null;
  const descriptor: Record<string, string | number> = { viewId: viewId! };
  for (const key of descriptorKeys) {
    const value = params.get(key);
    if (value != null && value !== '') {
      if (['topN','strategyVersion','targetVersion'].includes(key)) { const number = Number(value); if (Number.isSafeInteger(number) && number > 0) descriptor[key] = number; }
      else descriptor[key] = value;
    }
  }
  return descriptor as unknown as GeoAnalysisDescriptor;
}
/** The return snapshot covers only colliding descriptor keys; business view/scope/session stay native URL fields. */
const RETURN_PARAM = 'analysisReturn';
export function geoAnalysisSearch(search: string, descriptor: GeoAnalysisDescriptor | null): string {
  const params = new URLSearchParams(search);
  const wasAnalysis = GEO_ANALYSIS_OPTIONS.some(item => item.value === params.get('analysis'));
  if (!descriptor && !wasAnalysis) return params.toString();
  if (descriptor && !wasAnalysis) {
    const original = Object.fromEntries(descriptorKeys.filter(key => params.has(key)).map(key => [key, params.getAll(key)]));
    params.set(RETURN_PARAM, JSON.stringify(original));
  }
  // A frozen plan version is V26's alone: any other view is refused the field, so it is inherited only into V26.
  const inheritedVersions = !wasAnalysis && descriptor?.viewId === 'V26' ? ['strategyVersion', 'targetVersion'].map(key => [key, params.get(key)] as const) : [];
  const held = params.get(RETURN_PARAM);
  params.delete('analysis');
  for (const key of descriptorKeys) params.delete(key);
  if (descriptor) {
    params.set('analysis', descriptor.viewId);
    for (const key of descriptorKeys) if (descriptor[key] != null) params.set(key, String(descriptor[key]));
    for (const [key, value] of inheritedVersions) if (value && !Object.prototype.hasOwnProperty.call(descriptor, key)) params.set(key, value);
  } else {
    // Never interpret the snapshot as navigation or scope: restore only allow-listed descriptor keys.
    if (held) try {
      const original: unknown = JSON.parse(held);
      if (original && typeof original === 'object') for (const key of descriptorKeys) {
        const values = (original as Record<string, unknown>)[key];
        if (Array.isArray(values) && values.every(value => typeof value === 'string')) for (const value of values) params.append(key, value);
      }
    } catch { /* A malformed optional return snapshot cannot change the current business scope. */ }
    // A direct analysis link has no originating snapshot, and its descriptor fields are the analysis's, not the business view's: they are
    // not left behind in the address, where the next view opened from it would inherit them.
    params.delete(RETURN_PARAM);
  }
  return params.toString();
}
