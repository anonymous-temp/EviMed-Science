import { productRequest } from './productClient';
import type { GEO_SIGNAL_STEPS, GEO_SIGNAL_STATE_LABELS_ZH } from '@evimed/domain';
import { fetchWithWebAuth, webApiBase, WebApiError, type PreservedConversationHistory } from './apiClient';
import type { ResultVersion } from './resultProvenance';

export type GeoSignalKind = keyof typeof GEO_SIGNAL_STEPS;
export type GeoSignalState = keyof typeof GEO_SIGNAL_STATE_LABELS_ZH;
export interface GeoSourceReviewRecord {
  targetKey: string; outcome: 'unhandled' | 'no_change_needed' | 'update_proposed' | 'updated' | 'uncertain'; reason: string | null;
  warning?: string | null; runId?: string; sessionId?: string;
  availability?: 'available' | 'unknown'; reportedOutcome?: string | null;
  after: { type: 'article' | 'finding' | 'claim'; id: string; version: string | number; digest?: string; path?: string; runId: string; sessionId: string } | null;
  artifact?: { versionId: string; path: string; digest: string; runId: string; sessionId: string };
}
export interface GeoSourceReviewSummary {
  state: string; total: number; handled: number; remaining: number; updated: number; unchanged: number; proposed: number; uncertain: number; unhandled: number;
  verification: 'reported_review'; records: GeoSourceReviewRecord[]; issues: string[];
}
export interface GeoSignalAttempt {
  contextRef: string; sessionId: string; requestId: string | null; runId: string | null; submitted: boolean;
  createdAt: string; startedAt: string | null; finishedAt: string | null; status: string | null;
  state: GeoSignalState; executionState: GeoSignalState; availability: 'available' | 'unknown'; reason: string | null;
  result: { present: boolean; artifacts?: Array<{ id: string; path: string; runId: string; sessionId: string }>; answer?: { available: boolean } } | null;
}
export interface GeoSignal {
  id: string; revision: number; kind: GeoSignalKind; step: string; affectedSteps: string[]; title: string;
  createdAt: string; observedAt: string | null; detectedAt: string; disposition: 'active' | 'ignored';
  state: GeoSignalState; executionState: GeoSignalState; availability: 'available' | 'unknown'; reason: string | null;
  businessOutcome: { state: string; observation?: string }; actionable: boolean;
  sourceReview?: GeoSourceReviewSummary | null;
  currentAttempt: GeoSignalAttempt | null; attempts: GeoSignalAttempt[];
}
export interface GeoSignalTarget { key: string; type: 'finding' | 'claim' | 'article'; id: string; label?: string | null; version: string | number | null; digest: string | null; relationship: string }
export interface GeoSignalDetail extends GeoSignal {
  basisDigest: string; dispositionReason: string | null;
  targets?: GeoSignalTarget[];
  basis: { errorId?: string; snapshotId?: string | null; questionId?: string | null; groupId?: string | null; questionVersion?: number | null;
    engine?: string; statement?: string; assessedStatement?: { text?: string; evidence?: string; applicability?: { population?: string; inLabel?: boolean; elements?: Record<string, unknown> } } | null;
    evidenceAvailability?: string; url?: string; orderId?: string; articleId?: string | null; articleResultVersionId?: string | null;
    targets?: GeoSignalTarget[]; mappingState?: string; dependencyObservation?: string; notice?: Record<string, string | null> };
}
export interface GeoSignalPage { items: GeoSignal[]; total: number; counts: Record<GeoSignalState, number>; actionable: number; nextCursor: string | null }
const root = (geoId: string) => `/geo/projects/${encodeURIComponent(geoId)}/signals`;
export function listGeoSignals(geoId: string, input: { limit?: number; cursor?: string | null; kind?: GeoSignalKind; state?: GeoSignalState; step?: string; actionable?: boolean } = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value != null) query.set(key, String(value));
  return productRequest<GeoSignalPage>(`${root(geoId)}${query.size ? `?${query}` : ''}`);
}
export const getGeoSignal = (geoId: string, signalId: string) => productRequest<GeoSignalDetail>(`${root(geoId)}/${encodeURIComponent(signalId)}`);
export const setGeoSignalDisposition = (geoId: string, signalId: string, input: { expectedRevision: number; requestKey: string; disposition: 'active' | 'ignored'; reason?: string }) =>
  productRequest<GeoSignalDetail>(`${root(geoId)}/${encodeURIComponent(signalId)}/disposition`, 'POST', input);

const runPath = (geoId: string, signalId: string | null, runId: string) => signalId ? `${root(geoId)}/${encodeURIComponent(signalId)}/runs/${encodeURIComponent(runId)}` : `/geo/projects/${encodeURIComponent(geoId)}/runs/${encodeURIComponent(runId)}`;
export interface GeoSignalRunRecord { runId: string; sessionId: string; history: PreservedConversationHistory; files: Array<{ versionId: string; path: string; runId: string; sessionId: string }> }
export const getGeoSignalRunRecord = (geoId: string, signalId: string | null, runId: string) => productRequest<GeoSignalRunRecord>(runPath(geoId, signalId, runId));
export const getGeoSignalResult = (geoId: string, signalId: string | null, runId: string, versionId: string) => productRequest<ResultVersion>(`${runPath(geoId, signalId, runId)}/results/${encodeURIComponent(versionId)}`);
export async function readGeoSignalResultBytes(geoId: string, signalId: string | null, runId: string, versionId: string): Promise<Blob> {
  const base = webApiBase.endsWith('/api') ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${base}${runPath(geoId, signalId, runId)}/results/${encodeURIComponent(versionId)}/raw`);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new WebApiError(body.error ?? 'Result unavailable', { status: response.status, code: body.code ?? 'geo_signal_not_found' }); }
  return response.blob();
}
export const geoSignalResultHref = (geoId: string, signalId: string | null, file: { runId: string; path: string; versionId: string }) =>
  `/app/runs/${encodeURIComponent(file.runId)}/files/${file.path.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({ version: file.versionId, geoProject: geoId, ...(signalId ? { signal: signalId } : { geoRun: '1' }) })}`;
