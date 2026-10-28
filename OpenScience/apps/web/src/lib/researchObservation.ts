import { useEffect, useRef, useState } from "react";
import { phaseOfToolCall, TURN_END_KINDS } from "@evimed/domain";
import { parseRunProgress } from "./runProgress";
import { subscribeRunEvents, type RunStreamEvent } from "./runEvents";
import type { WebRunProgress } from "./apiClient";

/**
 * What a research run is doing, folded from its event stream one frame at a time.
 *
 * The observatory draws a run as an assembly line — 规划 → 检索 → 阅读 → 分析 → 核对 → 撰写 → 交付 —
 * with the orchestrator and every delegated session standing at the stage of the call it made last. A stage
 * is a label on an observed call (closed vocabulary: the tool's name), never a stage the run was told to enter.
 * The fold is incremental so a long run's counts do not shrink when the event window moves on, and the run's
 * stored aggregate (`run/progress`) is the floor of every count it also carries.
 */

export type StageKey = "plan" | "search" | "read" | "analyze" | "verify" | "write" | "deliver";
export const STAGES: ReadonlyArray<{ key: StageKey; label: string; code: string }> = [
  { key: "plan", label: "规划", code: "PLAN" },
  { key: "search", label: "检索", code: "SEARCH" },
  { key: "read", label: "阅读", code: "READ" },
  { key: "analyze", label: "分析", code: "ANALYZE" },
  { key: "verify", label: "核对", code: "VERIFY" },
  { key: "write", label: "撰写", code: "WRITE" },
  { key: "deliver", label: "交付", code: "DELIVER" },
];

const PHASE_STAGE: Record<string, StageKey> = { search: "search", screen: "read", fulltext: "read", claims: "verify", write: "write", deliver: "deliver" };
const TOOL_STAGE: Record<string, StageKey> = {
  todo: "plan", todo_write: "plan", todowrite: "plan", update_plan: "plan", plan: "plan", skill: "plan", subagent: "plan", task: "plan",
  ask_user: "plan", schedule_task: "plan", update_task: "plan",
  web_search: "search", kb_search: "search", grep: "search", glob: "search", search: "search", frontier_search: "search", social_posts_search: "search",
  read: "read", view: "read", web_read: "read", kb_browse: "read", fetch: "read", trial_registry_record: "read",
  bash: "analyze", shell: "analyze", exec: "analyze", run: "analyze", python: "analyze", terminal: "analyze", research_calculate: "analyze",
  dataset_semantics: "analyze", vcr_simulate: "analyze", vcr_read: "analyze", vcr_write: "analyze", curve_digitize: "analyze", evidence_pool: "analyze",
  job_start: "analyze", job_wait: "analyze", job_output: "analyze", geo_read: "analyze",
  write: "write", edit: "write", fs_write: "write", fs_edit: "write", multi_edit: "write", apply_patch: "write", str_replace: "write", geo_write: "write",
  present: "deliver",
};
const TOOL_LABEL: Record<string, string> = {
  web_search: "网页搜索", web_read: "阅读网页", kb_search: "检索知识库", kb_browse: "浏览知识库", frontier_search: "检索前沿动态",
  literature_search: "文献检索", search_papers: "文献检索", open_access_full_text: "获取全文", guideline_search: "指南检索",
  clinical_trial_search: "试验检索", clinical_trial_snapshot: "读取试验登记", trial_registry_record: "读取试验登记", biomedical_source_search: "生物医学检索",
  search_biomedical_records: "生物医学检索", drug_label_search: "说明书检索", dailymed_label: "读取说明书", pharmacy_reference_search: "药学资料检索",
  drug_term_normalize: "规范药名", identifier_resolve: "解析文献标识", reference_list: "整理参考文献", gene_expression_series: "读取表达数据",
  research_calculate: "精确计算", dataset_semantics: "理解数据集", schedule_task: "安排任务", update_task: "更新任务",
  evimed_claim_upsert: "记录结论", evimed_package_check: "核对成果", locate_quote: "定位原文", evidence_deduplicate: "文献去重", evimed_screen_batch: "文献筛选",
  evimed_submit_deliverable: "提交成果", evimed_render_report: "生成报告", present: "交付文件",
  vcr_simulate: "模拟计算", vcr_read: "读取研究数据", vcr_write: "保存研究结果", curve_digitize: "读取生存曲线", evidence_pool: "汇总证据",
  bash: "运行代码", shell: "运行代码", exec: "运行代码", python: "运行代码", terminal: "运行代码", job_start: "启动计算", job_wait: "等待计算", job_output: "读取计算结果",
  read: "读取文件", view: "读取文件", write: "写入文件", edit: "修改文件", fs_write: "写入文件", fs_edit: "修改文件", multi_edit: "修改文件", apply_patch: "修改文件",
  grep: "搜索内容", glob: "查找文件", todo: "更新计划", todo_write: "更新计划", update_plan: "更新计划", skill: "调用方法", subagent: "分派协作", task: "分派协作",
  ask_user: "向你提问", geo_read: "读取传播数据", geo_write: "保存传播内容", social_posts_search: "检索社交内容",
};

/** A tool's base name: `mcp__evimed__literature_search` and `literature_search` are one tool. */
export function toolBaseName(tool: string): string {
  return tool.replace(/^mcp__[A-Za-z0-9_-]+__/, "").replace(/-/g, "_").toLowerCase();
}

/** The stage a call stands in, or null for a call the vocabulary does not name. */
export function stageOfCall(tool: string, input: unknown = null, phase: unknown = undefined): StageKey | null {
  if (typeof phase === "string" && PHASE_STAGE[phase]) return PHASE_STAGE[phase];
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const labelled = phaseOfToolCall(tool, record);
  if (labelled && PHASE_STAGE[labelled]) return PHASE_STAGE[labelled];
  return TOOL_STAGE[toolBaseName(tool)] ?? null;
}

/** What a call does, in the reader's words. */
export function callLabel(tool: string, stage: StageKey | null): string {
  return TOOL_LABEL[toolBaseName(tool)] ?? (stage ? `${STAGES.find(item => item.key === stage)?.label}操作` : "执行操作");
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);

/** The one line under a call: its narration, else the argument that names what it touched. */
export function callDetail(input: unknown, narration?: unknown): string {
  const said = str(narration);
  if (said) return clip(said.replace(/\s+/g, " "), 120);
  const record = obj(input);
  if (!record) return "";
  for (const key of ["query", "q", "keywords", "term", "terms", "question", "topic"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return `“${clip(value.trim().replace(/\s+/g, " "), 80)}”`;
    if (Array.isArray(value) && value.length) return `“${clip(value.filter(item => typeof item === "string").join(" · "), 80)}”`;
  }
  const url = str(record.url);
  if (url) { try { const parsed = new URL(url); return clip(`${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`, 90); } catch { return clip(url, 90); } }
  for (const key of ["filePath", "file_path", "path", "target"]) {
    const value = str(record[key]);
    if (value) return clip(value.split("/").filter(Boolean).slice(-2).join("/"), 90);
  }
  const command = str(record.command) ?? str(record.cmd) ?? str(record.code);
  if (command) return clip(command.split("\n")[0], 90);
  const pmids = Array.isArray(record.pmids) ? record.pmids.length : 0;
  if (pmids) return `${pmids} 篇文献`;
  return "";
}

export type AgentState = "running" | "idle" | "done" | "failed" | "canceled" | "unknown";
export interface ObservedAgent {
  id: string;
  /** The orchestrator, or a delegated session. */
  root: boolean;
  label?: string;
  state: AgentState;
  stage: StageKey | null;
  calls: number;
  lastAt?: string;
  parent?: string;
}
export interface ObservedCall {
  id: string;
  agent: string;
  tool: string;
  label: string;
  detail: string;
  stage: StageKey | null;
  state: "running" | "done" | "error";
  at: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  seq: number;
}
export interface Observation {
  stageCounts: Record<StageKey, number>;
  agents: Map<string, ObservedAgent & { observedAt?: string; ambiguous?: boolean; confirmedState?: string }>;
  calls: ObservedCall[];
  callCount: number;
  rootStage: StageKey | null;
  thought: string;
  progress: WebRunProgress | null;
  progressAt: number;
  state: string | null;
  lastSeq: number;
  firstSeq: number | null;
  /** Bumped by every fold, so a consumer can tell an unchanged model from a new one. */
  version: number;
}

export const ROOT_AGENT = "root";
const CALL_LIMIT = 120;
const THOUGHT_LIMIT = 280;
const SETTLED = new Set(["done", "completed", "succeeded", "failed", "error", "canceled"]);

export function emptyObservation(): Observation {
  return { stageCounts: Object.fromEntries(STAGES.map(stage => [stage.key, 0])) as Record<StageKey, number>, agents: new Map(), calls: [], callCount: 0,
    rootStage: null, thought: "", progress: null, progressAt: Number.NaN, state: null, lastSeq: 0, firstSeq: null, version: 0 };
}

function agentState(value: string | undefined): AgentState {
  if (!value) return "unknown";
  if (value === "running") return "running";
  if (value === "idle") return "idle";
  if (["done", "completed", "succeeded"].includes(value)) return "done";
  if (["failed", "error", "aborted", "blocked", "max-tokens"].includes(value)) return "failed";
  if (["canceled", "cancelled", "interrupted"].includes(value)) return "canceled";
  return TURN_END_KINDS.includes(value) && value !== "unknown" ? "done" : "unknown";
}

type ChildFact = { id: string; label?: string; state?: string; at?: string; parent?: string; observedAt?: string };

/**
 * One delegated session's state, from the stream's lifecycle frames and the aggregate. The pump republishes replayed
 * lifecycle frames with the replay time, so an older frame never moves a settled session, and a lifecycle frame that
 * contradicts the aggregate's confirmed state leaves the session unknown until another aggregate settles it.
 */
function mergeChild(model: Observation, next: ChildFact, fromProgress = false) {
  const old = model.agents.get(next.id);
  const before = old?.observedAt ? Date.parse(old.observedAt) : Number.NaN;
  const after = next.observedAt ? Date.parse(next.observedAt) : Number.NaN;
  const stale = !!old && (Number.isFinite(before) && Number.isFinite(after) ? after < before : SETTLED.has(old.confirmedState ?? old.state) && next.state === "running");
  const category = (value?: string) => ["done", "completed", "succeeded"].includes(value ?? "") ? "completed" : ["failed", "error"].includes(value ?? "") ? "failed"
    : ["running", "idle", "canceled"].includes(value ?? "") || (TURN_END_KINDS.includes(value ?? "") && value !== "unknown") ? value : null;
  const conflict = !fromProgress && !stale && !!next.state && (!!old?.ambiguous || (!!old?.confirmedState && !!category(next.state) && category(next.state) !== category(old.confirmedState)));
  const state = stale ? old?.state : conflict ? "unknown" : next.state ? agentState(next.state) : old?.state;
  model.agents.set(next.id, {
    id: next.id, root: false, calls: old?.calls ?? 0, stage: old?.stage ?? null,
    label: next.label ?? old?.label, parent: next.parent ?? old?.parent,
    state: (state as AgentState | undefined) ?? "unknown",
    confirmedState: stale ? old?.confirmedState : fromProgress ? next.state ?? old?.confirmedState : old?.confirmedState,
    ambiguous: stale ? old?.ambiguous : conflict || (!fromProgress && old?.ambiguous),
    lastAt: stale ? old?.lastAt : next.at ?? old?.lastAt, observedAt: stale ? old?.observedAt : next.observedAt ?? old?.observedAt,
  });
}

function foldProgress(model: Observation, value: unknown, receivedAt?: string) {
  const raw = obj(value);
  const progress = parseRunProgress(raw);
  const at = Date.parse(str(raw?.updatedAt) ?? receivedAt ?? "");
  if (progress && (!Number.isFinite(model.progressAt) || !Number.isFinite(at) || at >= model.progressAt)) { model.progress = progress; model.progressAt = at; }
  const deliverables = Array.isArray(raw?.deliverables) ? raw.deliverables.map(obj).filter(Boolean) : [];
  for (const entry of Array.isArray(raw?.children) ? raw.children : []) {
    const child = obj(entry); const id = str(child?.childSessionId);
    if (!id) continue;
    const item = deliverables.find(deliverable => str(deliverable?.id) === str(child?.deliverableId));
    mergeChild(model, { id, label: str(item?.title), state: str(child?.state), at: str(child?.lastActivityAt), observedAt: str(raw?.updatedAt) ?? receivedAt }, true);
  }
}

/** Seeds the model with the run record's stored aggregate. */
export function seedObservation(model: Observation, storedProgress: unknown): Observation {
  if (storedProgress) foldProgress(model, storedProgress);
  model.version += 1;
  return model;
}

/** Folds one stream frame into the model, in place. */
export function foldObservation(model: Observation, frame: RunStreamEvent): Observation {
  model.version += 1;
  if (Number.isSafeInteger(frame.seq)) {
    if (model.firstSeq === null) model.firstSeq = frame.seq;
    model.lastSeq = Math.max(model.lastSeq, frame.seq);
  }
  if (frame.type === "run/progress") { foldProgress(model, frame.progress ?? frame, frame.time); return model; }
  if (frame.type === "run/state" && typeof frame.state === "string") { model.state = frame.state; return model; }
  if (frame.type === "subagent/update") {
    const id = str(frame.childSessionId);
    if (id) mergeChild(model, { id, label: str(frame.label), state: str(frame.status), at: frame.time, observedAt: frame.time });
    return model;
  }
  if (frame.type !== "run/event") return model;
  const event = obj(frame.event);
  if (!event) return model;
  const child = frame.child === true;
  const session = str(frame.sessionId) ?? "";
  const agent = child && session ? session : ROOT_AGENT;
  if (event.type === "subagent/started") {
    const id = str(event.childSessionId);
    if (id) mergeChild(model, { id, label: str(event.label), state: "running", at: frame.time, parent: str(event.parentSessionId), observedAt: frame.time });
    return model;
  }
  if (!child && (event.type === "assistant/delta" || event.type === "message/assistant")) {
    const text = event.type === "assistant/delta" ? str(event.text) && String(event.text) : str(event.text) ?? str(event.reasoning);
    if (text) {
      const joined = event.type === "assistant/delta" ? `${model.thought}${text}` : text;
      model.thought = joined.replace(/\s+/g, " ").slice(-THOUGHT_LIMIT);
    }
    return model;
  }
  if (event.type !== "tool/call" && event.type !== "tool/result") return model;
  const callId = str(event.callId);
  if (!callId) return model;
  const key = `${session}:${callId}`;
  const index = model.calls.findIndex(call => call.id === key);
  const old = index >= 0 ? model.calls[index] : undefined;
  const tool = str(event.tool) ?? old?.tool ?? "";
  const stage = event.type === "tool/call" ? stageOfCall(tool, event.input, event.phase) : old?.stage ?? stageOfCall(tool, null, event.phase);
  const next: ObservedCall = {
    id: key, agent, tool, stage, seq: frame.seq,
    label: callLabel(tool, stage),
    detail: event.type === "tool/call" ? callDetail(event.input, event.narration) : old?.detail || callDetail(null, event.narration),
    state: event.type === "tool/call" ? (old && old.state !== "running" ? old.state : "running") : event.status === "error" ? "error" : "done",
    at: old?.at ?? frame.time,
    durationMs: typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? event.durationMs : old?.durationMs,
    input: event.type === "tool/call" ? event.input : old?.input,
    output: event.type === "tool/result" ? event.output : old?.output,
  };
  if (old) model.calls[index] = next;
  else {
    model.calls.unshift(next);
    if (model.calls.length > CALL_LIMIT) model.calls.length = CALL_LIMIT;
    model.callCount += 1;
    if (stage) model.stageCounts[stage] += 1;
    if (agent === ROOT_AGENT) { if (stage) model.rootStage = stage; }
    else {
      const current = model.agents.get(agent);
      if (current) model.agents.set(agent, { ...current, calls: current.calls + 1, stage: stage ?? current.stage, lastAt: frame.time });
      else model.agents.set(agent, { id: agent, root: false, state: "unknown", calls: 1, stage, lastAt: frame.time });
    }
  }
  return model;
}

/** Counts per stage: what the stream showed, never less than the run's own aggregate. */
export function stageCounts(model: Observation): Record<StageKey, number> {
  const counts = { ...model.stageCounts };
  const phases = model.progress?.phaseCounts;
  if (phases) {
    counts.search = Math.max(counts.search, phases.search);
    counts.read = Math.max(counts.read, phases.screen + phases.fulltext);
    counts.verify = Math.max(counts.verify, phases.claims);
    counts.write = Math.max(counts.write, phases.write);
    counts.deliver = Math.max(counts.deliver, phases.deliver);
  }
  return counts;
}

/** The stage the orchestrator stands at: its last call's, else the furthest the aggregate reached. */
export function rootStage(model: Observation): StageKey | null {
  if (model.rootStage) return model.rootStage;
  const phase = model.progress?.currentPhase;
  return phase ? PHASE_STAGE[phase] ?? null : null;
}

/** True once a stream frame has been folded whose range does not start at the first event. */
export function partialStream(model: Observation): boolean {
  return model.firstSeq !== null && model.firstSeq > 1;
}

/**
 * Subscribes to one run and keeps its folded model. Frames arrive in bursts (a reasoning stream is a frame per few
 * characters), so the model is committed to React at most every `throttleMs`.
 */
export function useResearchObservation(runId: string | null, storedProgress: unknown, throttleMs = 160) {
  const model = useRef<Observation>(emptyObservation());
  const [snapshot, setSnapshot] = useState<{ model: Observation; version: number }>({ model: model.current, version: 0 });
  const [connected, setConnected] = useState(false);
  const seeded = useRef<unknown>(null);
  useEffect(() => {
    model.current = emptyObservation(); seeded.current = null;
    setSnapshot({ model: model.current, version: 0 }); setConnected(false);
    if (!runId) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const commit = () => { timer = null; setSnapshot({ model: model.current, version: model.current.version }); };
    const unsubscribe = subscribeRunEvents(runId, (frame) => {
      foldObservation(model.current, frame);
      if (!timer) timer = setTimeout(commit, throttleMs);
    }, { onConnection: setConnected });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [runId, throttleMs]);
  useEffect(() => {
    if (!storedProgress || seeded.current === storedProgress) return;
    seeded.current = storedProgress;
    seedObservation(model.current, storedProgress);
    setSnapshot({ model: model.current, version: model.current.version });
  }, [storedProgress, runId]);
  return { model: snapshot.model, version: snapshot.version, connected };
}
