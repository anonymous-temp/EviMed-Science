import { productRequest, type ProductPage } from "./productClient";

export type ExtensionCoordinate = { kind: "npm"; name: string; version: string } | { kind: "github"; repository: string; commit: string; subdirectory?: string };
export interface ExtensionSetting { type: "integer" | "number" | "boolean" | "string"; min?: number; max?: number; maxLength?: number; enum?: string[]; default?: string | number | boolean }
export interface CatalogueExtension {
  id: string; title: string; coordinate: ExtensionCoordinate; executionClass: string; integrity: string;
  settingsSchema: Record<string, ExtensionSetting>; evidenceState: string; qualification: { receiptDigest: string } | null;
}
export interface ExtensionInstallation { id: string; revision: number; coordinate: ExtensionCoordinate; integrity?: string; qualification?: { receiptDigest: string } | null; catalogueId: string; phase: string; effective: boolean; evidenceState: string; prepareJobId?: string | null }
export interface ExtensionJob { id: string; status: string; attempts: number; createdAt: string; finishedAt: string | null }
export interface ExtensionSelection { installationId: string; enabled: boolean; settings: Record<string, string | number | boolean>; connectionRefs: string[]; catalogueId?: string; coordinate?: ExtensionCoordinate; integrity?: string; effective?: boolean; phase?: string }
export interface ProjectExtensions { revision: number; selections: ExtensionSelection[]; effectiveGeneration: string | null }
export const extensionCatalogue = () => productRequest<{ items: CatalogueExtension[]; generatedAt: string }>("/extensions/catalogue");
export const extensionInstallations = (cursor?: string | null) => productRequest<ProductPage<ExtensionInstallation>>(`/extensions/installations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
export const extensionInstallation = (id: string) => productRequest<ExtensionInstallation>(`/extensions/installations/${encodeURIComponent(id)}`);
export const installExtension = (coordinate: ExtensionCoordinate, idempotencyKey: string) => productRequest<{ installation: ExtensionInstallation; job: ExtensionJob | null }>("/extensions/installations", "POST", { coordinate, scope: "library", idempotencyKey });
export const updateExtension = (id: string, expectedRevision: number, coordinate: ExtensionCoordinate) => productRequest<{ installation: ExtensionInstallation; job: ExtensionJob | null }>(`/extensions/installations/${encodeURIComponent(id)}/update`, "POST", { expectedRevision, coordinate });
export const removeExtension = (id: string, expectedRevision: number) => productRequest<ExtensionInstallation>(`/extensions/installations/${encodeURIComponent(id)}`, "DELETE", { expectedRevision });
export const retryExtension = (id: string, expectedRevision: number) => productRequest<{ installation: ExtensionInstallation; job: ExtensionJob | null }>(`/extensions/installations/${encodeURIComponent(id)}/retry`, "POST", { expectedRevision });
export const getExtensionJob = (id: string) => productRequest<ExtensionJob>(`/extensions/jobs/${encodeURIComponent(id)}`);
export const cancelExtensionJob = (id: string) => productRequest<ExtensionJob>(`/extensions/jobs/${encodeURIComponent(id)}/cancel`, "POST", {});
export const projectExtensions = (projectId: string) => productRequest<ProjectExtensions>(`/projects/${encodeURIComponent(projectId)}/extensions`);
export const saveProjectExtensions = (projectId: string, expectedRevision: number, selections: ExtensionSelection[]) => productRequest<ProjectExtensions>(`/projects/${encodeURIComponent(projectId)}/extensions`, "PUT", { expectedRevision, selections: selections.map(({ installationId, enabled, settings, connectionRefs }) => ({ installationId, enabled, settings, connectionRefs })) });
export interface ExtensionRevision { revision: number; phase: string; coordinate: ExtensionCoordinate; recordedAt: string; removed: boolean }
export interface ExtensionHistoryPage { items: ExtensionRevision[]; nextBeforeRevision: number | null }
export const extensionHistory = (id: string, beforeRevision?: number | null, limit = 50) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeRevision != null) query.set("beforeRevision", String(beforeRevision));
  return productRequest<ExtensionHistoryPage>(`/extensions/installations/${encodeURIComponent(id)}/revisions?${query}`);
};
export interface ExtensionConnection { id: string; title: string; kind: string; operations: string[]; revision: string }
export interface ExtensionConnections { items: ExtensionConnection[]; supportedKinds: string[] }
export const extensionConnections = (catalogueId: string, projectId: string) => productRequest<ExtensionConnections>(`/extensions/connections?${new URLSearchParams({ catalogueId, projectId })}`);
export function sameExtensionCoordinate(first: ExtensionCoordinate, second: ExtensionCoordinate) {
  if (first.kind === "npm" && second.kind === "npm") return first.name === second.name && first.version === second.version;
  return first.kind === "github" && second.kind === "github" && first.repository === second.repository && first.commit === second.commit && (first.subdirectory ?? "") === (second.subdirectory ?? "");
}
export function extensionSourceUrl(coordinate: ExtensionCoordinate) {
  return coordinate.kind === "npm"
    ? `https://www.npmjs.com/package/${coordinate.name}/v/${encodeURIComponent(coordinate.version)}`
    : `https://github.com/${coordinate.repository}/tree/${coordinate.commit}${coordinate.subdirectory ? `/${coordinate.subdirectory.split("/").map(encodeURIComponent).join("/")}` : ""}`;
}
export const extensionVersion = (coordinate: ExtensionCoordinate) => coordinate.kind === "npm" ? coordinate.version : coordinate.commit.slice(0, 12);
export function extensionStatus(item: Pick<ExtensionInstallation, "effective" | "phase">) {
  if (item.effective) return "可使用";
  return ({ preparing: "准备中", waiting: "待启用", saved: "已保存", failed: "需要重试", unsupported: "此环境不支持", removed: "已移除", "connection-needed": "需要连接账户", applying: "正在启用", "rolled-back": "已恢复上一版" } as Record<string, string>)[item.phase] ?? "尚未启用";
}
