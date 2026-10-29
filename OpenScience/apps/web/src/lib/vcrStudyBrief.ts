import { normalizeVcrStudyName, VCR_STUDY_NAME_MAX } from "./vcrStudyName";
import type { VcrStartAnswer, VcrStartBody } from "./vcrClient";

export const VCR_BRIEF_LIMIT = 2_000;
export interface StudyBriefFields {
  question: string;
  population: string;
  intervention: string;
  endpoint: string;
  materials: string;
  output: string;
  name: string;
}
export interface StudyBriefRequest {
  payload: VcrStartBody;
  state: "confirming" | "rejected" | "accepted";
  answer?: VcrStartAnswer;
}
export interface StudyBriefRecovery { state: "confirming" | "accepted" | "unknown"; studyId?: string }
export interface StudyBriefDraft {
  fields: StudyBriefFields;
  action?: "definition" | "auto";
  dataIntent?: boolean;
  remote?: { id: string; projectId: string };
  attachments?: Array<{ name: string; state: "selected" | "uploaded" | "failed" }>;
  request?: StudyBriefRequest;
  recovery?: StudyBriefRecovery;
  missingRemote?: boolean;
  priorSubmission?: { studyId?: string; request?: StudyBriefRequest; recovery?: StudyBriefRecovery };
}
export const emptyStudyBrief = (): StudyBriefFields => ({ question: "", population: "", intervention: "", endpoint: "", materials: "", output: "", name: "" });
const OPTIONAL: Array<[keyof StudyBriefFields, string]> = [["population", "目标人群"], ["intervention", "干预与对照"], ["endpoint", "主要终点"], ["materials", "已有材料"], ["output", "希望得到"]];
/** Keep the question's exact bytes; append only optional information the researcher supplied. */
export function studyBriefText(fields: StudyBriefFields, attachments: StudyBriefDraft["attachments"] = []): string {
  return [fields.question, ...OPTIONAL.filter(([key]) => fields[key].trim()).map(([key, label]) => `${label}：${fields[key]}`), ...(attachments.length ? [`材料文件：${attachments.map(file => `${file.name}（${file.state === "uploaded" ? "已上传" : file.state === "failed" ? "上传未完成" : "待上传"}）`).join("、")}`] : [])].join("\n\n");
}
export function studyBriefName(fields: StudyBriefFields): string {
  return normalizeVcrStudyName(fields.name) || [...normalizeVcrStudyName(fields.question.trim().split(/\n/)[0])].slice(0, VCR_STUDY_NAME_MAX).join("") || "新研究";
}
export function studyBriefKey(userId: string, tenantId: string, studyId = "new"): string {
  return `evimed.study-brief.v1:${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}:${encodeURIComponent(studyId)}`;
}
/** The existing account/tenant scope, addressed to its saved study rather than the unsaved entry. */
export function savedStudyBriefKey(originKey: string, studyId: string): string {
  return `${originKey.slice(0, originKey.lastIndexOf(":") + 1)}${encodeURIComponent(studyId)}`;
}
const fallback = new Map<string, StudyBriefDraft>();
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown, max = 256): string | null => typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : null;
const REQUEST_ACTIONS = new Set(["definition", "auto", "cohort", "patients", "comparator", "trial"]);
function readRequest(value: unknown, studyId?: string): StudyBriefRequest | null {
  const raw = record(value), payload = record(raw.payload), answer = record(raw.answer);
  const brief = bounded(payload.brief, VCR_BRIEF_LIMIT), requestId = bounded(payload.requestId, 128);
  if (!brief || !requestId || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)
    || (payload.action !== undefined && !REQUEST_ACTIONS.has(String(payload.action)))
    || (payload.name !== undefined && !bounded(payload.name, 120))
    || !["confirming", "accepted", "rejected"].includes(String(raw.state))) return null;
  const clean: StudyBriefRequest = { state: raw.state as StudyBriefRequest["state"], payload: { brief, requestId,
    ...(payload.name === undefined ? {} : { name: String(payload.name) }),
    ...(payload.action === undefined ? {} : { action: payload.action as VcrStartBody["action"] }) } };
  if (raw.state === "accepted") {
    if (!bounded(answer.studyId) || (studyId && answer.studyId !== studyId) || !bounded(answer.sessionId) || !bounded(answer.runId)
      || !bounded(answer.status, 80) || !bounded(answer.dispatchStatus, 80)
      || !["accepted", "awaiting_input"].includes(String(answer.state))
      || (answer.errorCode != null && !bounded(answer.errorCode, 128))) return null;
    clean.answer = { studyId: String(answer.studyId), sessionId: String(answer.sessionId), runId: String(answer.runId), status: String(answer.status),
      dispatchStatus: String(answer.dispatchStatus), state: answer.state as VcrStartAnswer["state"], errorCode: answer.errorCode == null ? null : String(answer.errorCode) };
  }
  return clean;
}
function recoveryOf(value: unknown, studyId?: string): StudyBriefRecovery {
  const raw = record(value);
  return { state: raw.state === "accepted" || raw.state === "confirming" ? raw.state : "unknown",
    ...(bounded(raw.studyId) || studyId ? { studyId: bounded(raw.studyId) ?? studyId } : {}) };
}
/** Browser persistence is untrusted: rebuild every nested value and retain uncertainty instead of inventing a fresh submission. */
export function normalizeStudyBrief(value: unknown): StudyBriefDraft {
  const raw = record(value), fields = record(raw.fields), remote = record(raw.remote);
  const clean: StudyBriefDraft = { fields: emptyStudyBrief() };
  for (const field of Object.keys(clean.fields) as Array<keyof StudyBriefFields>) {
    if (typeof fields[field] === "string") clean.fields[field] = fields[field].slice(0, 20_000);
  }
  if (raw.action === "definition" || raw.action === "auto") clean.action = raw.action;
  if (raw.dataIntent === true) clean.dataIntent = true;
  if (bounded(remote.id) && bounded(remote.projectId)) clean.remote = { id: String(remote.id), projectId: String(remote.projectId) };
  if (Array.isArray(raw.attachments)) clean.attachments = raw.attachments.slice(0, 100).flatMap(value => {
    const file = record(value), name = bounded(file.name, 512);
    return name ? [{ name, state: file.state === "uploaded" && clean.remote ? "uploaded" as const : file.state === "failed" ? "failed" as const : "selected" as const }] : [];
  });
  if (raw.missingRemote === true) clean.missingRemote = true;
  if (raw.recovery) clean.recovery = recoveryOf(raw.recovery, clean.remote?.id ?? bounded(remote.id) ?? undefined);
  if (raw.request != null) {
    const request = readRequest(raw.request, clean.remote?.id);
    if (request && clean.remote) clean.request = request;
    else clean.recovery = recoveryOf(raw.request, clean.remote?.id ?? bounded(remote.id) ?? bounded(record(record(raw.request).answer).studyId) ?? undefined);
  }
  if (raw.priorSubmission) {
    const prior = record(raw.priorSubmission), studyId = bounded(prior.studyId) ?? undefined;
    const request = readRequest(prior.request, studyId);
    clean.priorSubmission = { ...(studyId ? { studyId } : {}), ...(request ? { request } : {}),
      ...(!request || prior.recovery ? { recovery: recoveryOf(prior.recovery ?? prior.request, studyId) } : {}) };
  }
  return clean;
}
export function readStudyBrief(key: string): StudyBriefDraft | null {
  let stored: string | null;
  try { stored = window.localStorage.getItem(key); }
  catch { return fallback.get(key) ?? null; }
  if (stored === null) return null;
  try { return normalizeStudyBrief(JSON.parse(stored)); }
  catch { return { ...(fallback.get(key) ?? { fields: emptyStudyBrief() }), recovery: { state: "unknown" } }; }
}
export function clearStudyBrief(key: string): void {
  fallback.delete(key);
  try { window.localStorage.removeItem(key); } catch { /* The current-tab copy was cleared. */ }
}
export function writeStudyBrief(key: string, draft: StudyBriefDraft): boolean {
  const clean = normalizeStudyBrief(draft);
  fallback.set(key, clean);
  try { window.localStorage.setItem(key, JSON.stringify(clean)); return true; }
  catch { return false; }
}
export const STUDY_BRIEF_EXAMPLES: ReadonlyArray<{ label: string; data?: boolean; fields: StudyBriefFields }> = [
  { label: "设计一项研究", fields: { question: "我想比较成人 2 型糖尿病患者加用 GLP-1 受体激动剂与维持现有治疗的效果，请先帮我明确研究问题和可行设计。", population: "二甲双胍治疗后 HbA1c 仍为 7.5%–10% 的成人", intervention: "加用 GLP-1 受体激动剂；对照为维持现有治疗", endpoint: "24 周 HbA1c 变化，并关注低血糖和停药", materials: "目前只有研究想法，尚无个体数据", output: "研究定义、设计选项和需要补充的资料", name: "2 型糖尿病加用治疗研究设计" } },
  { label: "从文献规划试验", fields: { question: "请根据已发表的二线晚期非小细胞肺癌研究，评估随机对照试验的设计和样本量所需参数。", population: "一线含铂治疗后进展的晚期 NSCLC 成人", intervention: "待研究方案与多西他赛对照", endpoint: "无进展生存期（PFS）", materials: "将上传参考文献；尚未确定效应值和脱落率", output: "参考试验、参数及出处、设计情景和缺失信息", name: "二线 NSCLC 文献与试验规划" } },
  { label: "分析已有数据", data: true, fields: { question: "我有一份随访数据，想比较两种治疗的结局，请先检查数据能支持什么研究，再制定分析计划。", population: "数据中符合入排条件的患者，规则待核对", intervention: "数据中的治疗 A 与治疗 B", endpoint: "12 个月内的结局，需核对事件定义和随访时间", materials: "将通过研究数据接入添加去标识化数据和数据字典", output: "数据检查、纳入/排除/未知人数及可行分析计划", name: "已有随访数据的比较研究" } },
];
