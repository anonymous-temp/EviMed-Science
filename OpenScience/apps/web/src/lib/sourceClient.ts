import { productRequest, type ProductPage, type ProductRecord } from "./productClient";

export type SourceStatus = "queued" | "parsing" | "complete" | "needs_attention" | "failed" | "missing" | "canceled";
export type SourceDepth = "skip" | "index_only" | "structured" | "deep";
export interface SourceAnchor {
  sourceId: string;
  generation: number;
  unitId: string;
  start: number;
  end: number;
  quote: string;
}
export interface SourceUnderstanding {
  id: string;
  sourceId: string;
  generation: number;
  docType: string;
  depth: SourceDepth;
  schemaVersion: 1;
  createdAt: string;
  run: { id: string; sessionId: string; dispatchId: string } | null;
  usage: {
    currency: "CNY";
    modelId: string;
    providerId: string;
    actualCost: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  summary: string;
  slots: Record<string, { state: "known"; value: string; evidence: SourceAnchor[] } | { state: "unknown"; reason: string }>;
  claims: Array<{ id: string; statement: string; evidence: SourceAnchor[] }>;
  methods: Array<{
    id: string;
    title: string;
    description: string;
    whenToUse: string;
    steps: string[];
    checks: string[];
    pitfalls: string[];
    evidence: SourceAnchor[];
    status: "draft";
  }>;
  omissionAudit: { status: "not_run"; reason: string; omissionRate: null };
  units: Array<{ id: string; unitType: "chunk"; start: number; end: number; text: string; status: string }>;
}
export interface SourceUnderstandingResult {
  sourceId: string;
  generation: number;
  depth: SourceDepth;
  status: SourceStatus;
  current: SourceUnderstanding | null;
}
export interface SourcePayload {
  paths: string[];
  status: SourceStatus;
  docType: string;
  depth: SourceDepth;
  version: number;
  generation?: number;
  analysis?: { phase?: string };
  reasons: string[];
  valueVector: Record<string, number>;
  coverage: null | {
    total: number; accounted: number; accountedPercent?: number; extracted: number; indexedOnly: number; noContent: number;
    failed: number; percent: number; omissionRate: number | null; parserFailureRate?: number;
  };
  outputs: { summary?: string; facts?: number; methods?: number; artifactPath?: string };
  error?: { code: string; message: string } | null;
}

export function getSourceUnderstanding(id: string) {
  return productRequest<SourceUnderstandingResult>(`/sources/${encodeURIComponent(id)}/understanding`);
}
export function listSourceUnderstandingHistory(id: string, cursor?: string | null) {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return productRequest<ProductPage<SourceUnderstanding>>(`/sources/${encodeURIComponent(id)}/understanding/history?${query}`);
}
export type SourceRecord = ProductRecord<SourcePayload> & { projectId: string };
export interface OpenListEntry {
  path: string;
  name: string;
  size: number;
  mtime: string | null;
  entryType: "file" | "dir";
  providerHash: string | null;
}

export function listSources(projectId: string, { status = "" }: { status?: string } = {}) {
  const query = new URLSearchParams({ projectId });
  if (status) query.set("status", status);
  return productRequest<ProductPage<SourceRecord>>(`/sources?${query}`);
}
export function overrideSource(id: string, input: { expectedRevision: number; docType: string; depth: string; reason: string }) {
  return productRequest<SourceRecord>(`/sources/${encodeURIComponent(id)}`, "PATCH", input);
}
export function retrySource(id: string, expectedRevision: number) {
  return productRequest<SourceRecord>(`/sources/${encodeURIComponent(id)}/retry`, "POST", { expectedRevision });
}
export function cancelSource(id: string, expectedRevision: number) {
  return productRequest<SourceRecord>(`/sources/${encodeURIComponent(id)}/cancel`, "POST", { expectedRevision });
}
export function removeSource(id: string, expectedRevision: number) {
  return productRequest<SourceRecord>(`/sources/${encodeURIComponent(id)}`, "DELETE", { expectedRevision });
}
export function browseOpenList(projectId: string, path: string) {
  const query = new URLSearchParams({ projectId, path });
  return productRequest<{ entries: OpenListEntry[]; nextCursor: string | null }>(`/sources/openlist?${query}`);
}
export function importOpenListSource(projectId: string, path: string) {
  return productRequest<{ source: SourceRecord; duplicate: boolean }>("/sources/openlist/import", "POST", { projectId, path });
}
