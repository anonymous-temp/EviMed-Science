import { productRequest } from './productClient';
import type { VcrPremise } from './vcrClient';

export interface TrajectoryCounts { submitted: number; admitted: number; completed: number; rejected: number; failed: number; unprocessed: number; partial: number }
export interface TrajectoryUncertainty { available: boolean; rowsWithUncertainty: number; rows: number; kinds: Record<string, number>; drawsTotal: number; note: string }
export type TrajectoryStatus = 'completed' | 'rejected' | 'failed' | 'unprocessed';
export interface TrajectorySubjectLine {
  subjectKey: string; status: TrajectoryStatus; reason: string | null; horizonsRequested: number; horizonsAccepted: number;
  partial?: boolean; draws?: number; uncertainty?: TrajectoryUncertainty;
}
export interface TrajectoryPoint { horizonDays: number; point: number; sd: number | null; quantiles: Array<{ p: number; value: number }>; draws: number; uncertainty?: string }
export interface TrajectorySubjectPage {
  id: string; total: number; matching: number; offset: number; limit: number; more: boolean; lines: TrajectorySubjectLine[];
  trajectories: Record<string, TrajectoryPoint[]>; actionContext: { label: string; deployable: boolean } | null;
}

export interface ForecastPoint { day: number; subjects: number | null; mean: number | null; lower: number | null; upper: number | null }
export interface ForecastMetric { value: number | null; lower: number | null; upper: number | null }
export interface ForecastGroup {
  intervalMeaning?: string; modelUncertainty?: string;
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
    available?: boolean; mode?: string; causalEffectIdentified?: boolean; attribution?: string; predictionIds?: string[]; origins?: string[]; changedFactors?: string[];
    models?: Array<{ name?: string; version?: string } | null>;
    subjectsWithoutObservations?: number; modalities?: Array<{ modality: string; subjects: number | null; events: number | null }>;
    components?: Array<{ id: string; endpoint: { code: string; unit: string; type: string }; accepted: number; invalidRows: number }>;
    requestedComponents?: number; acceptedComponents?: number; invalidComponents?: number;
    subgroups?: Array<{ site: string; subjects: number | null; groups: ForecastGroup[] }>;
    subgroupCoverage?: { reported: number; available: number };
    /** A batch prediction's ledger: every submitted person is in exactly one of the four last counts. */
    accounting?: TrajectoryCounts;
    accountingReasons?: Record<string, number>;
    actionContext?: { mode: string; actionSource: string; deployable: boolean; label: string };
    versionNumber?: number; priorPredictionId?: string | null;
    uncertainty?: TrajectoryUncertainty;
    premises?: VcrPremise[];
    /** A comparison of two prediction versions with what was observed afterwards. */
    observed?: { available?: boolean; groups?: Array<{ horizonDays: number; targetAt?: string; observed: number; olderError: number | null; newerError: number | null;
      newerCloser: number; olderCloser: number; errorMetric: string }> };
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

/** One page of a prediction's per-person lines (a status filter, 50 to a page). A server without this route answers 404: the page then has only the counts. */
export const getVcrTrajectorySubjects = (studyId: string, predictionId: string, filter: { status?: string; reason?: string; offset?: number; limit?: number } = {}) => {
  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString();
  return productRequest<TrajectorySubjectPage>(`${route(studyId)}/${encodeURIComponent(predictionId)}/subjects${query ? `?${query}` : ''}`);
};
