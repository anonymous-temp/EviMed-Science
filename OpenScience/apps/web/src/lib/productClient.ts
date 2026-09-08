import { describeWebUsageBudget, fetchWithWebAuth, getWebProjectId, WebApiError, webApiBase } from "./apiClient";

export interface ProductRecord<T> {
  id: string;
  revision: number;
  payload: T;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface ProductPage<T> { items: T[]; nextCursor: string | null }
export interface CapsulePayload { title: string; description: string }
export interface CapsuleEntryPayload {
  capsuleId: string;
  factKind: string;
  layer: string;
  content: string;
  status: string;
  origin: string;
  provenance: Array<{ type: string; id: string; excerpt?: string }>;
}
export type CapsuleRecord = ProductRecord<CapsulePayload>;
export type CapsuleEntry = ProductRecord<CapsuleEntryPayload>;

export async function productRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null) as { data?: T; error?: string; code?: string; requestId?: string; details?: unknown } | null;
  if (!response.ok || !value || !("data" in value)) {
    throw new WebApiError(value?.error ?? "The service response was unavailable.", { status: response.status, code: value?.code, requestId: value?.requestId, details: value?.details });
  }
  return value.data as T;
}

export function productErrorMessage(error: unknown): string {
  if (error instanceof WebApiError) {
    if (error.status === 401) return "登录已失效，请重新登录。";
    // A budget refusal already says which ceiling stopped it and by how much.
    // Answering "请重试" to a spent week is advice that cannot work.
    if (error.details) return describeWebUsageBudget(error.details);
    if (error.status === 409) return "内容已发生变化，请刷新后再保存。";
    if (error.code === "product_state_unavailable") return "科研记忆服务暂时不可用，请稍后重试。";
    if (error.code === "capsule_payload_invalid") return "请检查名称和条目内容是否填写完整。";
    if (error.status === 404) return "这条记录已不存在，请刷新列表。";
  }
  return "操作未完成，请重试。";
}

export function listCapsules({ deleted = false, cursor = null }: { deleted?: boolean; cursor?: string | null } = {}) {
  const query = new URLSearchParams({ deleted: String(deleted) });
  if (cursor) query.set("cursor", cursor);
  return productRequest<ProductPage<CapsuleRecord>>(`/capsules?${query}`);
}
export function createCapsule(input: CapsulePayload) { return productRequest<CapsuleRecord>("/capsules", "POST", input); }
export function listCapsuleEntries(id: string, cursor?: string | null) {
  return productRequest<ProductPage<CapsuleEntry>>(`/capsules/${encodeURIComponent(id)}/entries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
}
export function addCapsuleEntry(id: string, input: Pick<CapsuleEntryPayload, "factKind" | "layer" | "content">) {
  return productRequest<CapsuleEntry>(`/capsules/${encodeURIComponent(id)}/entries`, "POST", input);
}
export function updateCapsuleEntry(id: string, entryId: string, input: { expectedRevision: number; status?: string; content?: string }) {
  return productRequest<CapsuleEntry>(`/capsules/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}`, "PATCH", input);
}
export function activateCapsule(id: string, mode = "own") {
  return productRequest(`/capsules/${encodeURIComponent(id)}/activate`, "POST", { mode, projectId: getWebProjectId() });
}
export function trashCapsule(id: string, expectedRevision: number) {
  return productRequest<CapsuleRecord>(`/capsules/${encodeURIComponent(id)}`, "DELETE", { expectedRevision });
}
export function restoreCapsule(id: string, expectedRevision: number) {
  return productRequest<CapsuleRecord>(`/capsules/${encodeURIComponent(id)}/restore`, "POST", { expectedRevision });
}

export interface CapsuleExportSnapshot {
  id: string; revision: number; createdAt: string; status: string; scopes: string[];
  capsuleRevision: number; entryCount: number; archiveSha256: string; supersedes: string | null;
  entryVersions: Array<{version: number; sha256: string}>;
}
export interface CapsuleTransferPreview {
  archiveSha256: string; snapshotId: string; scopes: string[]; issuerTrust: string; issuerId: string;
  hostedStatus: string; canImport: boolean; offlineRevocable: boolean; newerSnapshotId: string | null;
  entries: Array<{ id: string; version: number; factKind: string; layer: string; content: string; path: string; sha256: string }>;
}
export function listCapsuleExports(id: string, cursor?: string | null) {
  return productRequest<ProductPage<CapsuleExportSnapshot>>(`/capsules/${encodeURIComponent(id)}/exports${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
}
export function exportCapsule(id: string, input: { password: string; scopes: string[]; supersedes?: string }) {
  return productRequest<{ archive: string; filename: string; snapshot: CapsuleExportSnapshot }>(`/capsules/${encodeURIComponent(id)}/exports`, "POST", input);
}
export function revokeCapsuleExport(id: string, snapshot: CapsuleExportSnapshot) {
  return productRequest<CapsuleExportSnapshot>(`/capsules/${encodeURIComponent(id)}/exports/${encodeURIComponent(snapshot.id)}`, "DELETE", { expectedRevision: snapshot.revision });
}
export function previewCapsuleImport(input: { archive: string; password: string }) {
  return productRequest<CapsuleTransferPreview>("/capsules/transfers/preview", "POST", input);
}
export function importCapsule(input: { archive: string; password: string; expectedDigest: string; confirmed: true; title?: string }) {
  return productRequest<CapsuleRecord>("/capsules/transfers/import", "POST", input);
}
export function saveCapsuleDownload(archive: string, filename: string) {
  const url = URL.createObjectURL(new Blob([archive], { type: "application/vnd.evimed.capsule+json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
  anchor.click(); URL.revokeObjectURL(url);
}
export async function downloadCapsuleExport(id: string, snapshotId: string) {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}/capsules/${encodeURIComponent(id)}/exports/${encodeURIComponent(snapshotId)}`);
  if (!response.ok) throw new WebApiError("Snapshot download failed.", { status: response.status });
  saveCapsuleDownload(await response.text(), `capsule-${snapshotId}.evimedcap`);
}
