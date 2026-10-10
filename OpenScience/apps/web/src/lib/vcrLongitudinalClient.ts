import { productRequest } from './productClient';

export interface ForecastPoint { day: number; subjects: number | null; mean: number | null; lower: number | null; upper: number | null }
export interface ForecastMetric { value: number | null; lower: number | null; upper: number | null }
export interface LongitudinalRecord {
  id: string; kind: string; createdAt: string; hash: string; parentId?: string | null;
  summary: {
    origin?: string; subjects?: number | null; events?: number | null; repeatedSubjects?: number | null; medianHistoryDays?: number | null;
    dataClass?: string; model?: { name?: string; version?: string }; historyId?: string;
    endpoint?: { code: string; unit: string; type: string }; horizonsDays?: number[];
    accepted?: number; invalidRows?: number; originKind?: string; trajectories?: ForecastPoint[];
    validationClass?: string; split?: unknown; trainingOverlap?: string;
    groups?: Array<{ horizonDays: number; subjects: number | null; observedMean: number | null; forecastMean: number | null; missingOutcomes: number | null; metrics: Record<string, ForecastMetric> }>;
    notes?: string[];
  };
}
export interface VcrLongitudinalData {
  available: boolean; records: LongitudinalRecord[]; providers: Array<{ id: string; name: string; version: string }>;
  templates: { events: { columns: string[]; example: string[] }; prediction: Record<string, unknown> };
}
const route = (studyId: string) => `/vcr/studies/${encodeURIComponent(studyId)}/longitudinal`;
export const getVcrLongitudinal = async (studyId: string) => {
  const data = await productRequest<VcrLongitudinalData>(route(studyId));
  if (!data || !Array.isArray(data.records) || !Array.isArray(data.templates?.events?.columns) || !data.templates?.prediction) {
    throw new Error('纵向研究的数据格式暂时无法读取，请重试。');
  }
  return data;
};
export const importVcrPrediction = (studyId: string, input: Record<string, unknown>) => productRequest<LongitudinalRecord>(`${route(studyId)}/predictions`, 'POST', input);
