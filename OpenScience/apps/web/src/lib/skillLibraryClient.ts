import { fetchWithWebAuth, webApiBase, WebApiError } from "./apiClient";
import { productRequest, type ProductPage, type ProductRecord } from "./productClient";

export interface PersonalSkillPayload {
  title: string; description: string; instructions: string; nativeName: string; digest: string;
  resources: Array<{ id: string; path: string; digest: string; size: number }>; prepared: boolean;
}
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
export const personalSkillDefaults = () => productRequest<SkillSelectionRecord>("/skills/defaults");
export const savePersonalSkillDefaults = (expectedRevision: number, skills: SkillSelection[]) => productRequest<SkillSelectionRecord>("/skills/defaults", "PUT", { expectedRevision, skills: skills.map(({ skillId, revision }) => ({ skillId, revision })) });
export const projectSkills = (projectId: string) => productRequest<SkillSelectionRecord>(`/projects/${encodeURIComponent(projectId)}/skills`);
export const saveProjectSkills = (projectId: string, expectedRevision: number, skills: SkillSelection[]) => productRequest<SkillSelectionRecord>(`/projects/${encodeURIComponent(projectId)}/skills`, "PUT", { expectedRevision, skills: skills.map(({ skillId, revision }) => ({ skillId, revision })) });
export const importPersonalSkill = (resourceId: string, title: string) => productRequest<PersonalSkill>("/skills/import", "POST", { resourceId, title });

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
