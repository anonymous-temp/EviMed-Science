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
  const inheritedVersions = !wasAnalysis ? ['strategyVersion', 'targetVersion'].map(key => [key, params.get(key)] as const) : [];
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
    // Direct analysis links have no originating snapshot; retain only their frozen plan identity.
    else if (wasAnalysis) for (const key of ['strategyVersion', 'targetVersion']) {
      const value = new URLSearchParams(search).get(key); if (value) params.set(key, value);
    }
    params.delete(RETURN_PARAM);
  }
  return params.toString();
}
