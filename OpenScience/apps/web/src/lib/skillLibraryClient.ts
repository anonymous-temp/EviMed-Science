import { fetchWithWebAuth, webApiBase, WebApiError } from "./apiClient";
import { productRequest, type ProductPage, type ProductRecord } from "./productClient";
import type { WebAvailabilityState } from "./apiClient";

export interface PersonalSkillPayload {
  title: string; description: string; instructions: string; nativeName: string; digest: string;
  resources: Array<{ id: string; path: string; digest: string; size: number }>; prepared: boolean;
}

/** What a skill package is, as the server gives it to a reader: unknown stays named, never filled in. */
export interface SkillPackageView {
  id: string; name: string; origin: string; version: string | null;
  source: { kind: string; repository: string | null; commit: string | null; path: string | null; package: string | null; digest: string | null } | null;
  sourceText: string; licence: { id: string | null } | null; licenceText: string;
  digest: string | null; digestAlgorithm: string | null; scripts: number; references: number;
  dependencies: Array<{ kind: string; name: string; constraint: string | null; optional: boolean; supply: string; basis: "declared" | "observed" }>;
  operations: Array<{ name: string; kind: string }>;
  unknown: Array<{ field: string; reason: string }>;
}
/** Whether this runtime can supply what the package needs: a label beside the package, never a gate. */
export interface SkillAvailabilityView {
  state: WebAvailabilityState; label: string; text: string;
  reason: { code: string; detail?: string; source: string };
  also?: Array<{ code: string; detail?: string }>; notes: Array<{ code: string; detail?: string }>;
}
export interface SkillSupplyResult { revision: number; nativeName: string | null; baseKnown: boolean; package: SkillPackageView | null; availability: SkillAvailabilityView | null }
export type SkillUpdateDecision = "unchanged" | "same" | "keep-local" | "take-upstream" | "add" | "remove" | "conflict";
export interface SkillUpdatePlan {
  revision?: number; baseKnown: boolean; changes: number; conflicts: number; counts: Record<SkillUpdateDecision, number>;
  entries: Array<{ scope: "part" | "resource"; name: string; decision: SkillUpdateDecision; side: "local" | "upstream" | "removed" }>;
}
export interface SkillUpdateResult extends SkillUpdatePlan { skill: PersonalSkill; applied: boolean; taken: string[]; kept: string[]; pinnedRevision?: number }
export type PersonalSkill = ProductRecord<PersonalSkillPayload>;
export interface SkillSelection { skillId: string; revision: number; digest?: string; nativeName?: string }
export interface SkillSelectionRecord { revision: number; payload: { skills: SkillSelection[] } }
export interface SkillVersion { revision: number; payload: PersonalSkillPayload; deletedAt: string | null; recordedAt: string }
export interface SkillWrite { title: string; description: string; instructions: string; expectedRevision: number }
const skillPath = (id: string) => `/skills/${encodeURIComponent(id)}`;
export function personalSkillResourceUrl(id: string, revision: number, resourceId: string) {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  return `${root}${skillPath(id)}/resources/${encodeURIComponent(resourceId)}?revision=${revision}`;
}
export const listPersonalSkills = (cursor?: string | null) => productRequest<ProductPage<PersonalSkill>>(`/skills${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
export const getPersonalSkill = (id: string) => productRequest<PersonalSkill>(skillPath(id));
export const createPersonalSkill = (body: SkillWrite) => productRequest<PersonalSkill>("/skills", "POST", body);
export const updatePersonalSkill = (id: string, body: SkillWrite) => productRequest<PersonalSkill>(skillPath(id), "PUT", body);
export const removePersonalSkill = (id: string, expectedRevision: number) => productRequest<PersonalSkill>(skillPath(id), "DELETE", { expectedRevision });
export const personalSkillHistory = (id: string) => productRequest<SkillVersion[]>(`${skillPath(id)}/revisions`);
export const restorePersonalSkill = (id: string, expectedRevision: number, revision: number) => productRequest<PersonalSkill>(`${skillPath(id)}/restore`, "POST", { expectedRevision, revision });
export const personalSkillSupply = (id: string, revision?: number) => productRequest<SkillSupplyResult>(`${skillPath(id)}/supply${revision ? `?revision=${revision}` : ""}`);
export const previewSkillUpdate = (id: string, resourceId: string) => productRequest<SkillUpdatePlan & { revision: number }>(`${skillPath(id)}/update-preview`, "POST", { resourceId });
export const applySkillUpdate = (id: string, input: { resourceId: string; expectedRevision: number; resolutions: Record<string, "local" | "upstream"> }) => productRequest<SkillUpdateResult>(`${skillPath(id)}/update`, "POST", input);
export const personalSkillDefaults = () => productRequest<SkillSelectionRecord>("/skills/defaults");
export const savePersonalSkillDefaults = (expectedRevision: number, skills: SkillSelection[]) => productRequest<SkillSelectionRecord>("/skills/defaults", "PUT", { expectedRevision, skills: skills.map(({ skillId, revision }) => ({ skillId, revision })) });
export const projectSkills = (projectId: string) => productRequest<SkillSelectionRecord>(`/projects/${encodeURIComponent(projectId)}/skills`);
export const saveProjectSkills = (projectId: string, expectedRevision: number, skills: SkillSelection[]) => productRequest<SkillSelectionRecord>(`/projects/${encodeURIComponent(projectId)}/skills`, "PUT", { expectedRevision, skills: skills.map(({ skillId, revision }) => ({ skillId, revision })) });
export const importPersonalSkill = (resourceId: string, title: string) => productRequest<PersonalSkill>("/skills/import", "POST", { resourceId, title });
export interface SkillImportPreview {
  supply?: (SkillAvailabilityView & { package: SkillPackageView | null }) | null;
  description: string; instructions: string;
  invocation: { userInvocable: boolean; modelInvocable: boolean };
  resources: PersonalSkillPayload["resources"]; scripts: Array<{ path: string; size: number }>;
  metadata: Record<string, unknown>; whenToUse: string | null;
}
export const previewPersonalSkillImport = (resourceId: string) => productRequest<SkillImportPreview>("/skills/import-preview", "POST", { resourceId });

/** Raw bounded uploads use the existing cookie/CSRF transport, never a submitted host path. */
export async function uploadPersonalSkill(file: File) {
  const kind = file.name.toLowerCase().endsWith(".zip") ? "zip" : /\.(?:tar\.gz|tgz)$/i.test(file.name) ? "tar-gzip" : "skill";
  if (file.size > 4 * 1024 * 1024 || file.size === 0) throw new Error("请上传不超过 4 MB 的技能文件。");
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}/skills/uploads?kind=${kind}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
  const value = await response.json().catch(() => null) as { data?: { resourceId: string }; error?: string; code?: string } | null;
  if (!response.ok || !value?.data) throw new WebApiError(value?.error ?? "Skill upload failed.", { status: response.status, code: value?.code });
  return value.data;
}

/** One of the skills the platform ships, as the list gives it: Chinese words, never an identifier. */
export interface PlatformSkill {
  /** `<origin>:<name>`, one path segment. */
  id: string; name: string; title: string; use: string; group: string;
  source: "platform" | "community";
  /** Whether the control plane can copy this skill into the account's own skills. */
  canCopy: boolean;
}
/** `geoGroup` names the group the 循证 GEO method pack is listed under, so a page can mark it without spelling it. */
export interface PlatformSkillList { groups: string[]; geoGroup: string; items: PlatformSkill[] }
export interface PlatformSkillDetail extends PlatformSkill {
  /** The sentence that says when the skill is used; null where there is none. */
  when: string | null;
  /** The skill's full text, or null where the control plane does not carry the file. */
  instructions: string | null;
}
const platformPath = (id: string) => `/skills/platform/${encodeURIComponent(id)}`;
/** Answered from the control plane's own packages: needs no runtime and no session. */
export const listPlatformSkills = () => productRequest<PlatformSkillList>("/skills/platform");
export const readPlatformSkill = (id: string) => productRequest<PlatformSkillDetail>(platformPath(id));
/** The same request key returns the same copy: a retry after a lost answer does not make a second skill. */
export const copyPlatformSkill = (id: string, input: { title: string; idempotencyKey: string }) =>
  productRequest<PersonalSkill>(`${platformPath(id)}/copy`, "POST", { title: input.title, idempotencyKey: input.idempotencyKey });

export interface SkillRepositoryPreview {
  resourceId: string;
  immutableSource: { repository: string; commit: string; subdirectory?: string };
  preview: SkillImportPreview;
  findings: Array<{ code: string }>;
}
export const previewPersonalSkillRepository = (input: { repository: string; commit: string; subdirectory?: string }) => productRequest<SkillRepositoryPreview>("/skills/repository-preview", "POST", { repository: input.repository, commit: input.commit, ...(input.subdirectory ? { subdirectory: input.subdirectory } : {}) });

export type SkillTransferFormat = "portable" | "account";
export interface SkillTransferUpload {
  reference: string; sourceDigest: string; format: SkillTransferFormat;
  sourceSkills: Array<{ sourceId: string; title: string; revision: number }>;
}
export interface SkillTransferPreview {
  reference: string; sourceDigest: string; format: SkillTransferFormat; nativeValidation: "pending"; activation: false;
  skills: Array<{ sourceId: string; title: string; revisions: number;
    resources: Array<{ path: string; digest: string; size: number }>;
    invocation: { userInvocable: boolean; modelInvocable: boolean } }>;
}
export interface SkillTransferResult {
  status: "complete" | "in-progress"; reference: string; activation: false;
  mappings: Array<{ sourceId: string; targetId: string; imported: number; revisions: Array<{ sourceRevision: number; targetRevision: number }> }>;
}
export interface SkillTransferIntent { reference: string; sourceSkillIds?: string[] }
export async function uploadPersonalSkillTransfer(file: File, format: SkillTransferFormat): Promise<SkillTransferUpload> {
  if (file.size === 0 || file.size > 32 * 1024 * 1024) throw new Error("请上传不超过 32 MB 的迁移文件。");
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}/skills/transfers/uploads?format=${format}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
  const value = await response.json().catch(() => null) as { data?: SkillTransferUpload; error?: string; code?: string } | null;
  if (!response.ok || !value?.data) throw new WebApiError(value?.error ?? "Skill transfer upload failed.", { status: response.status, code: value?.code });
  return value.data;
}
const transferIntent = (input: SkillTransferIntent) => ({ reference: input.reference, ...(input.sourceSkillIds ? { sourceSkillIds: [...input.sourceSkillIds] } : {}) });
export const previewPersonalSkillTransfer = (input: SkillTransferIntent) => productRequest<SkillTransferPreview>("/skills/transfers/preview", "POST", transferIntent(input));
export const confirmPersonalSkillTransfer = (input: SkillTransferIntent & { idempotencyKey: string }) => productRequest<SkillTransferResult>("/skills/transfers/confirm", "POST", { ...transferIntent(input), idempotencyKey: input.idempotencyKey });
export function personalSkillPortableUrl(id: string) {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  return `${root}${skillPath(id)}/portable`;
}

export interface PendingSkillTransfer {
  reference: string; format: SkillTransferFormat; sourceSkillIds: string[]; idempotencyKey: string;
  status: "in-progress" | "complete";
  mappings: Array<{ sourceId: string; targetId: string; imported: number; total: number; revisions: Array<{ sourceRevision: number; targetRevision: number }> }>;
}
export const pendingPersonalSkillTransfers = (cursor?: string | null) => productRequest<{ items: PendingSkillTransfer[]; nextCursor: string | null }>(`/skills/transfers/pending${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
