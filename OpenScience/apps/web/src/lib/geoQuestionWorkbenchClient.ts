import { productRequest } from './productClient';
import type { GeoQuestion, GeoQuestionGroup } from './geoClient';

export interface GeoMeasurementContract {
  samplingMode: 'one_shot' | 'recurring'; engines: string[]; repeats: number; metricIds: string[];
  reportPresentation: 'summary' | 'detailed'; sourceBasis: 'answers' | 'answers_and_project_sources';
}
export interface GeoQuestionImportRow {
  text: string; originalId?: string | null; originalGroup?: string | null; clientTags?: string[];
  kind?: GeoQuestion['kind']; sourceUrl?: string | null; collectedAt?: string | null;
  pool?: GeoQuestionGroup['pool']; journeyStage?: string | null; audience?: GeoQuestionGroup['audience'];
  isMeasured?: boolean; classificationStatus?: 'unclassified' | 'suggested' | 'confirmed';
}
export interface GeoImportInput { rows: GeoQuestionImportRow[]; contract: GeoMeasurementContract; requestKey?: string }
export interface GeoImportPreview extends GeoImportInput { actualRows: number; measuredRows: number; plannedCalls: number; duplicateCandidates: Array<{ rowIndexes: number[] }> }
export interface GeoDiagnosisStarted { roundId: string; planned: number; status: string; setVersion: number }
export interface GeoDiagnosisProgress {
  roundId: string; status: string; version: number; planned: number; contract: GeoMeasurementContract | null; recoveryOf: string | null; absentEngines: string[];
  counts: { total: number; queued: number; leased: number; done: number; failed: number; skipped: number; deliveryUnknown: number; recoverable: number };
  page: { offset: number; limit: number; total: number; shown: number; more: boolean; nextOffset: number | null };
  cells: Array<{ jobId: string; questionId: string; text: string; originalId: string | null; originalGroup: string | null; engine: string; status: string; answerStatus: string | null; attempts: number; errorCode: string | null; snapshotId: string | null; recoverable: boolean; deliveryUnknown: boolean }>;
}
const base = (id: string) => `/geo/projects/${encodeURIComponent(id)}`;
export const previewGeoQuestions = (id: string, input: GeoImportInput) => productRequest<GeoImportPreview>(`${base(id)}/questions/preview`, 'POST', input);
export const importGeoQuestions = (id: string, input: GeoImportInput) => productRequest<{ version: number }>(`${base(id)}/questions`, 'POST', input);
export const startGeoDiagnosis = (id: string, version: number, requestKey: string) => productRequest<GeoDiagnosisStarted>(`${base(id)}/diagnosis/start`, 'POST', { version, requestKey });
export const getGeoDiagnosisProgress = (id: string, round: string, offset = 0) => productRequest<GeoDiagnosisProgress>(`${base(id)}/diagnosis/${encodeURIComponent(round)}/progress?limit=100&offset=${offset}`);
export const recoverGeoDiagnosis = (id: string, round: string, input: { requestKey: string; jobIds: string[]; acknowledgeUnknown?: boolean }) => productRequest<GeoDiagnosisStarted>(`${base(id)}/diagnosis/${encodeURIComponent(round)}/recover`, 'POST', input);
