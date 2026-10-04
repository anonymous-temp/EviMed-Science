import { productRequest, type ProductPage, type ProductRecord } from "./productClient";
import type { SourceUpdateStatus } from "./claimCitations";

/** One class of what depends on a changed source: how its lookup went, how many were found, and the first of them. A
 *  lookup that could not be made is "unknown", which is neither none nor clean. */
export interface AffectedClass<Item> { status: "found" | "none" | "unknown"; reason: string | null; total: number; items: Item[] }
type BoundVersion = { versionId: string; path: string | null; boundValues: number; keys: string[] };
/** What was found to rest on the changed source, by recorded links (calculations among the value bindings, the memories
 *  that name it, the learned methods linked to the result). Absent on an impact recorded before it was looked up. */
export interface ResultImpactAffected {
  schemaVersion: 1;
  via: "input" | "calculation";
  calculations: AffectedClass<BoundVersion>;
  dependents: AffectedClass<BoundVersion>;
  memories: AffectedClass<{ recordId: string; scope: string; kind: string; state: string }>;
  methods: AffectedClass<{ id: string; title: string | null; relation: "learnt_from" | "used_for"; versionId: string | null }>;
}

export type ResultImpact = ProductRecord<{
  versionId: string;
  /** `contentDigest` and `replacedBy` name a knowledge-base document that new bytes replaced. */
  source: { id: string; doi?: string; digest?: string; versionId?: string; contentDigest?: string; replacedBy?: string };
  sourceStatus: SourceUpdateStatus;
  effect: "potentially_affected" | "source_gap";
  claimIds: string[];
  affected?: ResultImpactAffected | null;
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
  /** `viaCalculation` names the calculation among the result's value bindings whose own recorded input this source is. */
  statuses: Array<{ source: { id: string; digest?: string; versionId?: string }; doi: string | null; updateStatus: SourceUpdateStatus; viaCalculation?: string }>;
  impacts: { items: ResultImpact[] };
}
export function checkResultSourceUpdates(projectId: string, versionId: string) {
  return productRequest<ResultSourceCheck>(`/results/${encodeURIComponent(versionId)}/source-updates`, "POST", { projectId });
}
