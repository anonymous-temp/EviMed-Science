import { productRequest, type ProductPage, type ProductRecord } from "./productClient";
import type { SourceUpdateStatus } from "./claimCitations";

export type ResultImpact = ProductRecord<{
  versionId: string;
  source: { id: string; doi?: string; digest?: string; versionId?: string };
  sourceStatus: SourceUpdateStatus;
  effect: "potentially_affected" | "source_gap";
  claimIds: string[];
  historicalResultPreserved: boolean;
  recomputed: boolean;
  continuation: { status: "awaiting_user" | "preparing" | "scheduled" | "unavailable"; agendaId?: string; episodeId?: string };
}>;

const impactPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/result-impacts`;
export function listResultImpacts(projectId: string, versionId: string, cursor?: string | null) {
  const query = new URLSearchParams({ versionId });
  if (cursor) query.set("cursor", cursor);
  return productRequest<ProductPage<ResultImpact>>(`${impactPath(projectId)}?${query}`);
}
export function continueResultImpact(projectId: string, impact: ResultImpact, agendaId: string) {
  return productRequest<ResultImpact>(`${impactPath(projectId)}/${encodeURIComponent(impact.id)}/continue`, "POST", {
    agendaId, expectedRevision: impact.revision,
  });
}
export interface ResultSourceCheck {
  versionId: string; digest: string;
  statuses: Array<{ source: { id: string; digest?: string; versionId?: string }; doi: string | null; updateStatus: SourceUpdateStatus }>;
  impacts: { items: ResultImpact[] };
}
export function checkResultSourceUpdates(projectId: string, versionId: string) {
  return productRequest<ResultSourceCheck>(`/results/${encodeURIComponent(versionId)}/source-updates`, "POST", { projectId });
}
