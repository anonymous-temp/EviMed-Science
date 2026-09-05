import { productRequest, type ProductPage, type ProductRecord } from "./productClient";

export type SourceStatus = "queued" | "parsing" | "complete" | "needs_attention" | "failed" | "missing" | "canceled";
export interface SourcePayload {
  paths: string[];
  status: SourceStatus;
  docType: string;
  depth: "skip" | "index_only" | "structured" | "deep";
  version: number;
  reasons: string[];
  valueVector: Record<string, number>;
  coverage: null | {
    total: number; accounted: number; accountedPercent?: number; extracted: number; indexedOnly: number; noContent: number;
    failed: number; percent: number; omissionRate: number;
  };
  outputs: { summary?: string; facts?: number; methods?: number; artifactPath?: string };
  error?: { code: string; message: string } | null;
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
