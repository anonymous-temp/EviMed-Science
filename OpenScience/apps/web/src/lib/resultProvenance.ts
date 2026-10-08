import type { ClaimVerification } from "./claimCitations";
import { knownErrorCodeMessage, resultMethodDifference } from "@evimed/domain";
import { WebApiError, fetchWithWebAuth, getWebProjectId, webApiBase, webErrorMessage } from "./apiClient";

/** A refusal in the registry's sentence for its code when there is one, else the failure's own words. */
export function resultActionFailure(error: unknown, fallback: (error: unknown) => string): string {
  return error instanceof WebApiError && error.code && knownErrorCodeMessage(error.code) ? webErrorMessage(error) : fallback(error);
}

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

/** What produced a version's bytes, and what the platform did not observe (`@evimed/domain` producerSnapshot). */
export interface ProducerSnapshot {
  kind: "engine_job" | "skill_script" | "authored" | "render" | "unobserved";
  origin: "platform_measured" | "receipt_declared" | "unknown";
  method: { id: string; version: string | null; engineVersion: string | null; executed: Record<string, string | number | boolean> | null; seed: number | null; parameters: Record<string, string | number | boolean> | null } | null;
  script: { path: string | null; digest: string | null; bytes: number | null; files: { path: string; sha256: string; bytes: number | null }[] | null; executed: boolean; verified: boolean } | null;
  inputs: ResultInput[];
  transformations: { datasetId: string; name: string; version: number; codeDigest: string | null }[];
  environment: { status: "reported" | "unknown"; digest: string | null; facts: { imageId?: string; interpreter?: string; implementation?: string; platform?: string; machine?: string; lockDigest?: string; packages?: Record<string, string> } | null; truncated?: boolean };
  process: { exitCode: number | null; startedAt: string | null; endedAt: string | null; sourcesUnchanged: boolean | null; observation: string | null } | null;
  reproduction: "observed_execution" | "declared_execution" | "generated_not_executed" | "not_applicable";
  unknown: string[];
  recorded: boolean;
}
/** Where a printed number stands in the file. */
export type BindingLocator = { kind: "text"; line: number; column: number } | { kind: "cell"; row: number; column: number } | { kind: "svg"; index: number };
export interface ValueBinding {
  basis: "rendered" | "matched"; locator: BindingLocator; printed: string;
  calculation: { versionId: string; digest: string | null; key: string; value: number; unit: string | null };
  format: { id: string; places?: number; scale?: number; grouped?: boolean; magnitude?: boolean };
}
export interface UnboundNumber { locator: BindingLocator; printed: string; reason: "no_matching_value" | "differs_from_value" | "ambiguous"; candidates: { versionId: string; key: string; value?: number }[] }
/** Each number a report, table or figure prints, tied to the calculation value it came from. */
export interface ValueBindings {
  status: "bound" | "partly_bound" | "unbound" | "no_numbers" | "no_calculation" | "not_checkable" | "not_checked";
  calculations: { versionId: string; digest: string | null; path: string | null; alias: string | null }[];
  items: ValueBinding[]; unbound: UnboundNumber[]; unresolved: { path: string; reason: string }[];
  counts: { bound: number; rendered: number; unbound: number; ambiguous: number; unresolved: number }; truncated: boolean;
}
export interface ResultVersion {
  artifactId: string; versionId: string; projectId: string; path: string; digest: string;
  size: number; mimeType: string; capturedAt: string;
  producer: { kind: string; sessionId?: string; runId?: string; callId?: string; branchId?: string };
  inputs: ResultInput[]; code: ResultInput | null; environment: ResultInput | null;
  /** The method record the calculation ran (id, version, digest, seeding); absent for a result with none. */
  method?: { id: string; version: string; digest: string | null; seeded: boolean | null; seed: number | null } | null;
  findings: ResultFinding[]; machineValues: ResultMachineValue[];
  coverage: { snapshot: string; producer: string; inputs: string; code: string; environment: string; gaps: string[] };
  supersedesVersionId: string | null;
  review?: { status: string; matrixText?: string; verification?: ClaimVerification; matrixVersionId?: string; matrixDigest?: string };
  reuseEligibility?: { replay: ResultEligibility; export: ResultEligibility };
  snapshot?: ProducerSnapshot; bindings?: ValueBindings;
}
/** A version in the numerical chain: a calculation, or a report whose numbers are bound to one. */
export interface LineageVersion { versionId: string; path: string; capturedAt: string; digest: string; runId: string | null; boundValues: number; keys: string[] }
export interface LineageChangeRow {
  versionId: string; path: string; bound: number; unchanged: number; needsSuccessor: boolean;
  affected: { locator: BindingLocator; printed: string; key: string; unit: string | null; before: number; after: number | null; printedNow: string | null; status: "changed" | "removed" | "unit_changed" }[];
}
export interface ResultLineage {
  versionId: string; role: "calculation" | "report" | "both" | "none";
  calculations: { versionId: string; path: string; digest: string; capturedAt: string; runId: string | null; method: string | null; producer: string | null }[];
  dependents: LineageVersion[];
  changes: { calculationVersionId: string; successorVersionId: string; successorCapturedAt: string; successorPath: string; successorRunId: string | null; dependents: LineageChangeRow[];
    summary: { dependents: number; affectedValues: number; unaffectedValues: number; needSuccessor: number } }[];
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
  // The code travels with the message, so a refusal can be read out of the
  // registry's sentence for it (`webErrorMessage`) instead of its English.
  if (!response.ok) throw new WebApiError(typeof body.error === "string" ? body.error : "无法读取结果，请重试", { status: response.status, code: typeof body.code === "string" ? body.code : null, requestId: typeof body.requestId === "string" ? body.requestId : null });
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
/** From a number to its calculation and from a calculation to the numbers printed from it. */
export function getResultLineage(versionId: string) {
  return resultJson<ResultLineage>(`/${encodeURIComponent(versionId)}/lineage`);
}
/** What a correction changed, decided from the bytes of its two versions; `unknown` is a value, never "unchanged". */
export type CorrectionKind = "analytic" | "evidence" | "presentation" | "unknown";
export type CorrectionState = "changed" | "identical" | "unknown";
export interface ResultCorrectionRecord {
  revisionId: string | null;
  original: { versionId: string; digest: string; path: string | null };
  successor: { versionId: string; digest: string; path: string | null };
  kind: CorrectionKind;
  effects: { bytes: CorrectionState; printedNumbers: CorrectionState; machineValues: "changed" | "identical" | "none" | "unknown"; evidence: CorrectionState;
    numbersAdded: string[]; numbersRemoved: string[]; identifiersAdded: string[]; identifiersRemoved: string[]; claimsAdded: string[]; claimsRemoved: string[] };
  anchor: { kind: string; selectedText: string };
  instruction: string | null;
}
/** What the run left beside the successor: a Word or PDF it wrote is a rendering, and nothing checked it against the successor. */
export interface ResultCorrectionOutcome {
  status: "settled" | "no_successor";
  successorVersionId: string | null;
  outputs: Array<{ versionId: string; path: string; role: "successor" | "rendering" | "other"; format: string | null; consistency: "not_checked" }>;
  calculations: Array<{ key: string; unit: string | null; before: { versionId: string; value: number }; after: { versionId: string; value: number } }>;
}
export interface ResultCorrectionEntry { id: string; occurredAt: string; role: "original" | "successor"; correction: ResultCorrectionRecord; outcome: ResultCorrectionOutcome | null }
/** The corrections a version was the original or the successor of. */
export function getResultCorrections(versionId: string) {
  return resultJson<{ versionId: string; items: ResultCorrectionEntry[] }>(`/${encodeURIComponent(versionId)}/corrections`);
}
const CORRECTION_KIND_LABELS: Record<CorrectionKind, string> = { analytic: "数值有变化", evidence: "依据有变化", presentation: "只改了呈现方式", unknown: "两个版本的内容无法逐项比较" };
export function correctionKindLabel(kind: CorrectionKind): string { return CORRECTION_KIND_LABELS[kind] ?? CORRECTION_KIND_LABELS.unknown; }
/** What moved between the two versions, in words; a part that could not be compared says so. */
export function correctionEffectLines(correction: ResultCorrectionRecord): string[] {
  const { effects } = correction;
  const lines: string[] = [];
  if (effects.printedNumbers === "changed") {
    if (effects.numbersRemoved.length) lines.push(`不再出现的数值：${effects.numbersRemoved.join("、")}`);
    if (effects.numbersAdded.length) lines.push(`新出现的数值：${effects.numbersAdded.join("、")}`);
  } else if (effects.printedNumbers === "unknown" && effects.machineValues !== "changed") lines.push("文中的数值无法比较");
  if (effects.identifiersAdded.length) lines.push(`新增来源：${effects.identifiersAdded.join("、")}`);
  if (effects.identifiersRemoved.length) lines.push(`不再引用的来源：${effects.identifiersRemoved.join("、")}`);
  if (effects.claimsAdded.length) lines.push(`新增结论：${effects.claimsAdded.join("、")}`);
  if (effects.claimsRemoved.length) lines.push(`不再保留的结论：${effects.claimsRemoved.join("、")}`);
  return lines;
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
/** What a recalculation ran on, against what the original recorded. `differs` names the parts that moved. */
export interface ReplayEnvironment { status: "same" | "differs"; changed: Array<"code" | "environment" | "method"> }
export interface ReplayComparison {
  bytes?: "identical" | "changed";
  numbers?: { status: "identical" | "within-tolerance" | "changed" | "not-assessed" };
  environment?: ReplayEnvironment | null;
}
export interface ResultReplay {
  id: string; state: string; versionId?: string | null; resultVersionId?: string | null;
  error?: string | { code?: string } | null; cleanup?: string | null;
  comparison?: ReplayComparison | null; environment?: ReplayEnvironment | null;
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
  if (!response.ok) {
    // The code travels with the refusal, so the reader gets the registry's sentence for it (an access change, the size
    // limit) instead of one line for every cause.
    const body = await response.json().catch(() => ({}));
    throw new WebApiError(typeof body?.error === "string" ? body.error : "无法导出此版本，请重试", { status: response.status, code: typeof body?.code === "string" ? body.code : null, requestId: typeof body?.requestId === "string" ? body.requestId : null });
  }
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
const ENVIRONMENT_PART_LABELS = { code: "代码", environment: "运行环境", method: "方法记录" } as const;
/**
 * The environment a recalculation ran on, in words: it says the numbers were
 * compared on the same engine only when the record says so, and otherwise which
 * part moved. Nothing is claimed when the record has nothing to say.
 */
export function replayEnvironmentLabel(environment: ReplayEnvironment | null | undefined, against = "原结果"): string | null {
  if (!environment) return null;
  if (environment.status === "same") return `运行环境与${against}相同`;
  return `运行环境与${against}不同（${environment.changed.map((part) => ENVIRONMENT_PART_LABELS[part]).join("、") || "未能确认差异所在"}已变化），数值比较不是在同一环境下得到的`;
}
/** A recalculation's failure in the registry's own sentence for its code. */
export function replayErrorText(error: ResultReplay["error"]): string {
  if (typeof error === "string") return error;
  return (error?.code ? knownErrorCodeMessage(error.code) : null) ?? "计算未完成，请查看进度后重试";
}
export function replayNumbersLabel(comparison: ReplayComparison | null | undefined): string | null {
  const status = comparison?.numbers?.status;
  if (!status) return null;
  return ({ identical: "数值与原结果完全一致", "within-tolerance": "数值与原结果在允许误差内一致", changed: "数值与原结果有变化", "not-assessed": "数值无法与原结果比较" } as const)[status] ?? null;
}
/** What two related versions say they ran on: the same, different in named parts, or nothing recorded. */
export function resultEnvironmentDifference(current: ResultVersion, prior: ResultVersion): ReplayEnvironment | null {
  const changed: Array<"code" | "environment" | "method"> = [];
  let known = false;
  for (const part of ["code", "environment"] as const) {
    const left = current[part]?.digest; const right = prior[part]?.digest;
    if (!left || !right) continue;
    known = true;
    if (left !== right) changed.push(part);
  }
  // A side with no method record is not a different record: only two that name one are compared.
  const method = resultMethodDifference(current.method, prior.method);
  if (method !== "unknown") { known = true; if (method === "changed") changed.push("method"); }
  return known ? { status: changed.length ? "differs" : "same", changed } : null;
}
export function resultGapLabel(reason: string): string {
  return ({ no_owned_deterministic_recipe: "未保存受支持的计算配方", engine_unavailable: "这个部署没有用于重算的计算引擎", unknown_inputs: "输入关系未记录", inputs_unknown: "输入关系未记录", code_unknown: "生成代码未记录", environment_unknown: "运行环境未记录", legacy_record: "仅有旧版记录", producer_unknown: "生成来源未确认", no_authoritative_inputs: "缺少已确认的输入", producer_bytes_not_bound: "文件内容未经核对", missing_inputs: "输入文件不可用", unsupported_method: "暂不支持该计算方法", incompatible_environment: "运行环境不兼容", restricted_input: "输入资料不能导出", unavailable_review: "核对意见不可用", unobserved_execution: "执行过程未记录", dependencies_not_observed: "运行中读取的其他文件和网络访问未被记录", code_not_executed: "代码是对话中生成的，没有它运行过的记录", values_unbound: "文中有数值没有对应的计算值", values_unresolved: "渲染时有引用没有找到对应的计算值", values_not_checkable: "此格式的数值无法核对" } as Record<string, string>)[reason] ?? (/^[a-z][a-z0-9_:-]*$/.test(reason) ? "部分来源、代码或环境未完整保存" : reason);
}

const SNAPSHOT_KIND_LABELS = { engine_job: "确定性计算引擎", skill_script: "技能脚本（含执行记录）", authored: "对话中直接写入", render: "平台按计算值渲染", unobserved: "生成过程未被观察" } as const;
/** How a version's bytes came about, in words. */
export function snapshotKindLabel(kind: ProducerSnapshot["kind"]): string { return SNAPSHOT_KIND_LABELS[kind] ?? "生成过程未被观察"; }
/** Whether code ran: said as a record, never implied. */
export function reproductionLabel(state: ProducerSnapshot["reproduction"]): string | null {
  return ({ observed_execution: "运行已记录，所用代码已核对", declared_execution: "这次运行由脚本自述，现存代码与自述不一致，未能核对", generated_not_executed: "这是对话中生成的代码，没有它运行过的记录", not_applicable: null } as const)[state] ?? null;
}
/** What the platform did not observe about how a version was made. */
export function snapshotUnknownLabel(code: string): string {
  return ({ script: "所用代码未记录", inputs: "读取了哪些输入未完整记录", environment: "运行环境未记录", undeclared_dependencies: "运行中读取的其他文件和网络访问未被记录" } as Record<string, string>)[code] ?? "部分生成过程未被记录";
}
/** The state of a report's numbers against its calculations. */
export function bindingStatusLabel(bindings: ValueBindings): string {
  const { counts } = bindings;
  switch (bindings.status) {
    case "bound": return "文中数值都已对应到计算值";
    case "partly_bound": return `${counts.bound} 个数值已对应到计算值，${counts.unbound} 个没有对应的计算值`;
    case "unbound": return `文中 ${counts.unbound} 个数值没有对应的计算值`;
    case "no_numbers": return "文中没有需要核对的数值";
    case "no_calculation": return "本次运行没有可对照的计算结果，数值未核对";
    case "not_checkable": return "此格式的数值无法核对，请查看同一次生成的文本或表格";
    default: return "数值尚未核对";
  }
}
/** Why a printed number is not tied to a calculation value. */
export function unboundReasonLabel(item: UnboundNumber): string {
  const near = item.candidates[0];
  if (item.reason === "differs_from_value") return near ? `与计算值 ${near.key}${near.value !== undefined ? `（${near.value}）` : ""}接近但不相等，可能已过时或录入有误` : "与某个计算值接近但不相等";
  if (item.reason === "ambiguous") return `有多个计算值与之吻合（${item.candidates.map(candidate => candidate.key).join("、")}），无法确定来源`;
  return "没有对应的计算值";
}
/** The formatting applied between the machine value and the printed words. */
export function bindingFormatLabel(format: ValueBinding["format"]): string {
  if (format.id === "round") {
    const parts = [`保留 ${format.places ?? 0} 位小数`];
    if (format.scale === 100) parts.unshift("小数乘 100 显示为百分数");
    if (format.grouped) parts.push("千分位");
    if (format.magnitude) parts.push("省略负号");
    return parts.join("，");
  }
  return ({ raw: "原值", int: "取整", f1: "保留 1 位小数", f2: "保留 2 位小数", f3: "保留 3 位小数", pct0: "百分数，不保留小数", pct1: "百分数，保留 1 位小数", pct2: "百分数，保留 2 位小数",
    thousands: "千分位取整", ci: "置信区间", pm: "含蒙特卡洛标准误", months: "月数", text: "原文" } as Record<string, string>)[format.id] ?? "已格式化";
}
/** Where in the file a number stands. */
export function bindingLocatorLabel(locator: BindingLocator): string {
  if (locator.kind === "cell") return `第 ${locator.row} 行第 ${locator.column} 列`;
  if (locator.kind === "svg") return `图中第 ${locator.index} 处文字`;
  return `第 ${locator.line} 行`;
}
/**
 * The bindings a selection could be: those whose printed words are the selection, or one of the numbers inside it ("OR 0.71"
 * selects the number 0.71). One calculation value is a definite answer; several are listed rather than guessed between. A
 * selection that holds no bound number answers none.
 */
export function bindingsForSelection(version: ResultVersion, selectedText: string): { bound: ValueBinding[]; unbound: UnboundNumber[] } {
  const wanted = selectedText.trim();
  if (!wanted || !version.bindings) return { bound: [], unbound: [] };
  const exact = { bound: version.bindings.items.filter(item => item.printed === wanted), unbound: version.bindings.unbound.filter(item => item.printed === wanted) };
  if (exact.bound.length || exact.unbound.length || wanted.length > 200) return exact;
  const tokens = new Set((wanted.match(/[-−]?\d[\d,]*(?:\.\d+)?%?/g) ?? []).map(token => token.replace("−", "-")).slice(0, 8));
  const known = (printed: string) => tokens.has(printed.replace("−", "-"));
  return { bound: version.bindings.items.filter(item => known(item.printed)), unbound: version.bindings.unbound.filter(item => known(item.printed)) };
}
/** The words a changed printed value would now read, for the dependents of a calculation that has a successor. */
export function lineageChangeLabel(row: LineageChangeRow["affected"][number]): string {
  if (row.status === "removed") return `${row.printed}：新版本的计算里没有这个值`;
  if (row.status === "unit_changed") return `${row.printed}：新版本的计算换了单位`;
  return `${row.printed} → ${row.printedNow ?? "无法按原格式显示"}`;
}

