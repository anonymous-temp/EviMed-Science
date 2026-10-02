import type { ClaimVerification } from "./claimCitations";
import { fetchWithWebAuth, getWebProjectId, webApiBase } from "./apiClient";

export interface ResultInput {
  kind: string; id: string; digest?: string; versionId?: string; path?: string;
  availability: string;
}
export interface ResultFinding {
  id: string; kind: string; status: string; message: string; elementId?: string;
  sourceRefs?: ResultInput[];
}
export interface ResultMachineValue {
  name?: string; key?: string; value: unknown; unit?: string; absoluteTolerance?: number; relativeTolerance?: number;
}
export interface ResultEligibility { status: "available" | "partial" | "unavailable"; reasons: string[] }
export interface ResultVersion {
  artifactId: string; versionId: string; projectId: string; path: string; digest: string;
  size: number; mimeType: string; capturedAt: string;
  producer: { kind: string; sessionId?: string; runId?: string; callId?: string; branchId?: string };
  inputs: ResultInput[]; code: unknown; environment: unknown;
  findings: ResultFinding[]; machineValues: ResultMachineValue[];
  coverage: { snapshot: string; producer: string; inputs: string; code: string; environment: string; gaps: string[] };
  supersedesVersionId: string | null;
  review?: { status: string; matrixText?: string; verification?: ClaimVerification; matrixVersionId?: string; matrixDigest?: string };
  reuseEligibility?: { replay: ResultEligibility; export: ResultEligibility };
}
export interface ResultAnchor {
  kind: "text" | "table-cell" | "figure" | "claim" | "rendered-element";
  elementKind?: "text" | "table-cell" | "figure" | "claim";
  elementId: string; selectedText: string; row?: number; column?: number;
}
export interface ResultRevisionRequest {
  projectId: string; digest: string; anchor: ResultAnchor; instruction?: string; sessionId?: string; requestId: string;
}

function resultUrl(path: string, query: Record<string, string> = {}): string {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  return `${root}/results${path}?${new URLSearchParams({ projectId: getWebProjectId(), ...query })}`;
}
async function resultJson<T>(path: string, init?: RequestInit, query?: Record<string, string>): Promise<T> {
  const response = await fetchWithWebAuth(resultUrl(path, query), init);
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "无法读取结果，请重试");
  return body.data ?? body;
}
export async function listResultVersions(path: string, runId?: string, cursor?: string) {
  return resultJson<{ items: ResultVersion[]; nextCursor: string | null }>("", undefined,
    { path, ...(runId ? { runId } : {}), ...(cursor ? { cursor } : {}) });
}
export function listRelatedResultVersions(versionId: string, cursor?: string | null) {
  return resultJson<{ items: ResultVersion[]; nextCursor: string | null }>("", undefined,
    { relatedTo: versionId, ...(cursor ? { cursor } : {}) });
}
export function directlyRelatedResults(left: ResultVersion, right: ResultVersion): boolean {
  return left.projectId === right.projectId && (left.supersedesVersionId === right.versionId || right.supersedesVersionId === left.versionId);
}
export function getResultVersion(versionId: string) {
  return resultJson<ResultVersion>(`/${encodeURIComponent(versionId)}`);
}
export async function readResultBytes(version: ResultVersion): Promise<Blob> {
  const response = await fetchWithWebAuth(resultUrl(`/${encodeURIComponent(version.versionId)}/raw`));
  if (!response.ok) throw new Error("此版本的文件无法读取，请重试");
  const etag = response.headers.get("ETag")?.replace(/^W\//, "").replaceAll('"', "");
  if (!etag) throw new Error("无法确认此文件的版本，请重试");
  if (etag !== version.digest && etag !== `sha256:${version.digest}`) throw new Error("文件版本发生冲突，请重新打开此版本");
  const blob = await response.blob();
  if (blob.size !== version.size) throw new Error("此版本文件不完整，请重试");
  return blob;
}
export function requestResultRevision(version: ResultVersion, anchor: ResultAnchor, sessionId: string) {
  const request: ResultRevisionRequest = { projectId: version.projectId, digest: version.digest,
    anchor: { ...anchor }, sessionId, requestId: crypto.randomUUID() };
  return resultJson<{ sessionId?: string; draft: string; referenceId: string }>(`/${encodeURIComponent(version.versionId)}/revisions`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
}
export interface ResultReplay {
  id: string; state: string; versionId?: string | null; resultVersionId?: string | null;
  error?: string | { code?: string } | null; cleanup?: string | null;
}
export function replayResult(version: ResultVersion) {
  return resultJson<ResultReplay>(`/${encodeURIComponent(version.versionId)}/replays`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: version.projectId, digest: version.digest, requestId: crypto.randomUUID() }) });
}
export function getResultReplay(id: string) {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  return fetchWithWebAuth(`${root}/result-replays/${encodeURIComponent(id)}?${new URLSearchParams({ projectId: getWebProjectId() })}`)
    .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error("无法读取重算进度，请重试"); return (body.data ?? body) as ResultReplay; });
}
export async function cancelResultReplay(id: string): Promise<ResultReplay> {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}/result-replays/${encodeURIComponent(id)}/cancel`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: getWebProjectId() }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 409 ? "重算进程尚未确认停止，请稍后刷新进度" : "无法取消重算，请重试");
  return body.data ?? body;
}
export async function exportResult(version: ResultVersion): Promise<Blob> {
  const response = await fetchWithWebAuth(resultUrl(`/${encodeURIComponent(version.versionId)}/export`));
  if (!response.ok) throw new Error("无法导出此版本，请重试");
  return response.blob();
}
export function saveResultBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Stable DOM anchors identify positions only within the selected immutable bytes. */
export function selectionResultAnchor(container: HTMLElement, selection: Selection | null): ResultAnchor | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
  const end = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement;
  const element = start?.closest<HTMLElement>("[data-result-element]");
  if (!element || !end || !container.contains(element) || !element.contains(end)) return null;
  const selectedText = selection.toString().trim();
  if (!selectedText || selectedText.length > 12000) return null;
  const elementKind = (element.dataset.resultKind ?? "text") as "text" | "table-cell" | "figure" | "claim";
  const rendered = Boolean(element.closest("[data-result-rendered]"));
  return { kind: rendered ? "rendered-element" : elementKind, ...(rendered ? { elementKind } : {}),
    elementId: element.dataset.resultElement!, selectedText,
    ...(element.dataset.resultRow ? { row: Number(element.dataset.resultRow) } : {}),
    ...(element.dataset.resultColumn ? { column: Number(element.dataset.resultColumn) } : {}) };
}
export function assignResultAnchors(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>("p, pre, tr, td, th, figure, img").forEach((element, index) => {
    element.dataset.resultElement = `${element.tagName.toLowerCase()}-${index + 1}`;
    element.dataset.resultKind = ["TD", "TH"].includes(element.tagName) ? "table-cell" : ["IMG", "FIGURE"].includes(element.tagName) ? "figure" : "text";
    if (element instanceof HTMLTableCellElement) { element.dataset.resultColumn = String(element.cellIndex); element.dataset.resultRow = String((element.parentElement as HTMLTableRowElement).rowIndex); }
  });
}

export function resultTextDifference(before: string, after: string) {
  if (before === after) return [];
  const prior = before.split("\n"), next = after.split("\n");
  let prefix = 0;
  while (prefix < prior.length && prefix < next.length && prior[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < prior.length - prefix && suffix < next.length - prefix && prior[prior.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  return [
    ...prior.slice(prefix, prior.length - suffix).map((text, index) => ({ kind: "removed" as const, line: prefix + index + 1, text })),
    ...next.slice(prefix, next.length - suffix).map((text, index) => ({ kind: "added" as const, line: prefix + index + 1, text })),
  ];
}

export function resultValueDifference(before: ResultMachineValue | undefined, after: ResultMachineValue | undefined): string {
  if (!before || !after) return "缺少旧值或新值";
  if (before.unit !== after.unit) return "无法比较单位";
  if (typeof before.value !== "number" || typeof after.value !== "number" || !Number.isFinite(before.value) || !Number.isFinite(after.value)) return "无法比较数值";
  if (before.value === after.value) return "完全一致";
  const absolute = after.absoluteTolerance ?? before.absoluteTolerance ?? 0;
  const relative = after.relativeTolerance ?? before.relativeTolerance ?? 0;
  const threshold = Math.max(absolute, Math.abs(before.value) * relative);
  if (!Number.isFinite(threshold) || absolute < 0 || relative < 0) return "无法比较数值";
  return threshold >= 0 && Math.abs(after.value - before.value) <= threshold ? "在允许误差内" : "有变化";
}
export function resultGapLabel(reason: string): string {
  return ({ no_owned_deterministic_recipe: "未保存受支持的计算配方", unknown_inputs: "输入关系未记录", inputs_unknown: "输入关系未记录", code_unknown: "生成代码未记录", environment_unknown: "运行环境未记录", legacy_record: "仅有旧版记录", producer_unknown: "生成来源未确认", no_authoritative_inputs: "缺少已确认的输入", missing_inputs: "输入文件不可用", unsupported_method: "暂不支持该计算方法", incompatible_environment: "运行环境不兼容", restricted_input: "输入资料不能导出", unavailable_review: "核对意见不可用", unobserved_execution: "执行过程未记录" } as Record<string, string>)[reason] ?? (/^[a-z][a-z0-9_:-]*$/.test(reason) ? "部分来源、代码或环境未完整保存" : reason);
}
