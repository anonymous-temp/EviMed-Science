import { productRequest } from './productClient';

export interface ForecastPoint { day: number; subjects: number | null; mean: number | null; lower: number | null; upper: number | null }
export interface ForecastMetric { value: number | null; lower: number | null; upper: number | null }
export interface ForecastGroup {
  horizonDays: number; subjects?: number | null; events?: number | null; observedMean?: number | null; forecastMean?: number | null;
  requested?: number | null; evaluated?: number | null; missingOutcomes?: number | null; missingForecasts?: number | null; invalidForecasts?: number | null;
  candidates?: number | null; prevalentExcluded?: number | null; riskSet?: string;
  targetAt?: string; secondHorizonDays?: number; firstMean?: number | null; secondMean?: number | null;
  meanDifference?: number | null; lower?: number | null; upper?: number | null; firstOnly?: number | null; secondOnly?: number | null;
  metrics?: Record<string, ForecastMetric>; displayReason?: string;
  distributionAvailability?: { sampleRows?: number | null; intervalRows?: number | null; sdRows?: number | null };
  baselines?: Record<string, { subjects?: number | null; comparisons?: Record<string, { model: number; baseline: number; modelMinusBaseline: number; preferred: string }> }>;
  endpoint?: string; scale?: string; unit?: string;
  baseline?: { metrics?: Record<string, ForecastMetric> };
}
export interface LongitudinalRecord {
  id: string; kind: string; createdAt: string; hash: string; parentId?: string | null;
  summary: {
    origin?: string; subjects?: number | null; events?: number | null; repeatedSubjects?: number | null; medianHistoryDays?: number | null;
    dataClass?: string; model?: { name?: string; version?: string }; historyId?: string;
    endpoint?: { code: string; unit: string; type: string }; horizonsDays?: number[];
    accepted?: number; invalidRows?: number; originKind?: string; trajectories?: ForecastPoint[];
    validationClass?: string; split?: unknown; trainingOverlap?: string;
    groups?: ForecastGroup[];
    failures?: Array<{ code: string; rows?: number }>; code?: string; predictionId?: string;
    comparisons?: number; matched?: number; excluded?: number; issues?: Array<{ code?: string; codes?: string[] }>;
    notes?: string[];
    available?: boolean; mode?: string; predictionIds?: string[]; origins?: string[]; changedFactors?: string[];
    models?: Array<{ name?: string; version?: string } | null>;
    subjectsWithoutObservations?: number; modalities?: Array<{ modality: string; subjects: number | null; events: number | null }>;
    components?: Array<{ id: string; endpoint: { code: string; unit: string; type: string }; accepted: number; invalidRows: number }>;
    requestedComponents?: number; acceptedComponents?: number; invalidComponents?: number;
    subgroups?: Array<{ site: string; subjects: number | null; groups: ForecastGroup[] }>;
    subgroupCoverage?: { reported: number; available: number };
  };
}
export interface VcrLongitudinalData {
  available: boolean; records: LongitudinalRecord[]; related?: LongitudinalRecord[]; more?: boolean; nextOffset?: number | null;
  providers: Array<{ id: string; name: string; version: string }>;
  templates: { events: { columns: string[]; example: string[] }; prediction: Record<string, unknown>; predictionSet?: Record<string, unknown>; benchmark?: Record<string, unknown> };
}
const route = (studyId: string) => `/vcr/studies/${encodeURIComponent(studyId)}/longitudinal`;
export const getVcrLongitudinal = async (studyId: string, filter: { id?: string; kind?: string; offset?: number } = {}) => {
  const query = new URLSearchParams(Object.entries(filter).map(([key, value]) => [key, String(value)])).toString();
  const data = await productRequest<VcrLongitudinalData>(`${route(studyId)}${query ? `?${query}` : ''}`);
  if (!data || !Array.isArray(data.records) || !Array.isArray(data.templates?.events?.columns) || !data.templates?.prediction) {
    throw new Error('纵向研究的数据格式暂时无法读取，请重试。');
  }
  return data;
};
export const importVcrPrediction = (studyId: string, input: Record<string, unknown>) => productRequest<LongitudinalRecord>(`${route(studyId)}/predictions`, 'POST', input);
export const importVcrBenchmark = (studyId: string, input: Record<string, unknown>) => productRequest<LongitudinalRecord>(`${route(studyId)}/benchmarks`, 'POST', input);
