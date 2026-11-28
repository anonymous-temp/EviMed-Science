import { formatApproxCount, formatDuration } from "@/lib/format";
import { callStateWord, AGENT_WORD } from "../researchRing";
import { ROOT_AGENT, STAGES, type ObservedCall, type Observation, type StageKey } from "@/lib/researchObservation";
import type { WebRunDeliverable } from "@/lib/apiClient";

/**
 * What the HaloFlux console shows of one research round. HALOFLUX's lab console (lab.html) is a header of counters, the
 * light-ring stage with a callout and a status line, and eight instrument panels, all fed by simulated data. Here every one
 * of them reads the round: the counters are the observatory's, the feed and the workspace are its operations in the reader's
 * words, the task routes its plan, the dispatch panel its members, and the four drawn panels its operations over time.
 * Pure, so the mapping is tested without a canvas.
 */

export type FeedTone = "read" | "build" | "check" | "qa";
export interface HfFeedLine { id: string; n: string; verb: string; tone: FeedTone; text: string; failed: boolean }
export interface HfCodeLine { id: string; n: string; name: string; fn: string; arg: string; result: string; failed: boolean; running: boolean }
export type RouteCell = "" | "on" | "done" | "pk";
export interface HfRoute { id: string; name: string; cells: [RouteCell, RouteCell, RouteCell] }
export interface HfAgent { id: string; no: string; role: string; cells: string[]; state: string; working: boolean }
/** `sub` is the unit, or the whole the value is part of. */
export interface HfKpi { key: string; label: string; value: string; sub: string; ratio: number | null; accent?: boolean }
export interface HfOp { stage: number; state: ObservedCall["state"]; ms: number | null; at: number }
export interface HfCallout { id: string; kicker: string; value: string }
export type ReasoningMode = "think" | "call" | "idle";

export interface HfScene {
  preview: boolean;
  title: string;
  subtitle: string;
  kpis: HfKpi[];
  status: { big: string; small: string };
  /** The callout's turns: the pinned operation alone, else the newest few, newest first. */
  callouts: HfCallout[];
  feed: HfFeedLine[];
  code: HfCodeLine[];
  routes: { head: [string, string, string, string]; rows: HfRoute[]; caption: string };
  agents: HfAgent[];
  reasoning: { mode: ReasoningMode; thought: string };
  /** Oldest first: what the drawn panels plot. */
  ops: HfOp[];
  window: { from: number; to: number } | null;
  live: boolean;
  stageNow: number;
  stageCounts: number[];
  captions: { reasoning: string; results: string; signals: string; index: string; dispatch: string };
  /** ASCII words and numbers for the ring's micro panels (null: HALOFLUX's own). */
  words: { head: string[]; code: string[]; keys: string[]; numbers: string[] } | null;
  /** 0 calm (the wallpaper's tempo) … 1 the author's tempo. */
  energy: number;
  /** Changes when an operation starts or settles; the stage answers it with a beat. */
  pulse: { key: string; kind: "call" | "deliver" | "error" } | null;
}

export interface SceneInput {
  title: string;
  status: string;
  clock: string;
  live: boolean;
  /** Live, connected and not waiting on the model. */
  active: boolean;
  waiting: boolean;
  model: Observation;
  counts: Record<StageKey, number>;
  memberName: (id: string) => string;
  metrics: {
    requests: number | null; tokensIn: number | null; tokensOut: number | null; toolTotal: number;
    sources: { searched: number; fullText: number; included: number } | null;
    claims: { total: number; verified: number } | null;
    cost: number | null;
  };
  deliverables: WebRunDeliverable[];
  files: { written: string[]; presented: string[]; unverified: string[] };
  pinned: ObservedCall | null;
  startedMs: number | null;
  endedMs: number | null;
  now: number;
}

const STAGE_INDEX = new Map(STAGES.map((stage, index) => [stage.key, index]));
const TONE: Record<StageKey, FeedTone> = { plan: "qa", search: "read", read: "read", analyze: "build", verify: "check", write: "build", deliver: "qa" };
/** The workspace names each result by what its stage yields. */
const RESULT_NAME: Record<StageKey, string> = { plan: "计划", search: "命中", read: "原文", analyze: "结果", verify: "核对", write: "文件", deliver: "交付" };
/** HALOFLUX's dispatch colours, one per stage (lab.html ROLE_COL): teal reads, pink builds, white reviews. */
export const STAGE_COLOR: Record<StageKey, string> = {
  plan: "#d7dae0", search: "#98e0cf", read: "#98e0cf", analyze: "#f0a6c6", verify: "#d7dae0", write: "#f0a6c6", deliver: "#f4f5f7",
};
const CELL_RUNNING = "#5a5e66", CELL_EMPTY = "#1d1f24";
const FEED_LINES = 14, CODE_LINES = 12, ROUTE_ROWS = 6, AGENT_ROWS = 12, CALLOUTS = 5;

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + "…" : text);
const pad = (n: number) => String(Math.max(0, n)).padStart(3, "0");
const ascii = (text: string) => /^[\x20-\x7e]+$/.test(text);

function resultText(call: ObservedCall): string {
  if (call.state === "running") return "";
  if (call.state === "error") return callStateWord("error");
  const value = call.output;
  if (typeof value === "string") return clip(value.replace(/\s+/g, " ").trim(), 60);
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value && typeof value === "object") {
    const text = Object.values(value as Record<string, unknown>).find(item => typeof item === "string" && item.trim());
    return typeof text === "string" ? clip(text.replace(/\s+/g, " ").trim(), 60) : callStateWord("done");
  }
  return callStateWord("done");
}

function routeCells(status: WebRunDeliverable["status"]): HfRoute["cells"] {
  if (status === "accepted" || status === "delivered") return ["done", "done", "done"];
  if (status === "rejected") return ["done", "pk", ""];
  if (status === "delegated" || status === "submitted") return ["done", "on", ""];
  return ["on", "", ""];
}

const name = (path: string) => path.split("/").pop() || path;

function routes(input: SceneInput): HfScene["routes"] {
  const { deliverables, files } = input;
  if (deliverables.length) {
    const done = deliverables.filter(item => item.status === "accepted" || item.status === "delivered").length;
    // Unfinished work first: the six rows are the ones still moving.
    const order = [...deliverables].sort((a, b) => Number(routeCells(a.status)[2] === "done") - Number(routeCells(b.status)[2] === "done"));
    return {
      head: ["任务", "规划", "进行", "完成"],
      rows: order.slice(0, ROUTE_ROWS).map(item => ({ id: item.id, name: item.title, cells: routeCells(item.status) })),
      caption: `${done} / ${deliverables.length} 项任务完成${deliverables.length > ROUTE_ROWS ? ` · 另有 ${deliverables.length - ROUTE_ROWS} 项` : ""}`,
    };
  }
  const all = [...new Set([...files.written, ...files.presented, ...files.unverified])];
  if (all.length) {
    const presented = new Set(files.presented), unverified = new Set(files.unverified);
    return {
      head: ["产出", "写入", "交付", "核对"],
      rows: all.slice(0, ROUTE_ROWS).map(path => ({
        id: path, name: name(path),
        cells: ["done", presented.has(path) ? "done" : "on", unverified.has(path) ? "pk" : presented.has(path) ? "done" : ""],
      })),
      caption: `${all.length} 份产出 · ${presented.size} 份已交付`,
    };
  }
  return { head: ["任务", "规划", "进行", "完成"], rows: [], caption: "这一轮还没有拆分任务" };
}

function agents(input: SceneInput): HfAgent[] {
  const { model } = input;
  const ids = [ROOT_AGENT, ...[...model.agents.keys()].filter(id => id !== ROOT_AGENT)];
  const live = input.live;
  return ids.slice(0, AGENT_ROWS).map((id, index) => {
    const agent = model.agents.get(id);
    const recent = model.calls.filter(call => call.agent === id).slice(0, 6).reverse();
    const cells = Array.from({ length: 6 }, (_, i) => {
      const call = recent[i];
      if (!call) return CELL_EMPTY;
      if (call.state === "running") return CELL_RUNNING;
      return call.state === "error" ? "#f0a6c6" : call.stage ? STAGE_COLOR[call.stage] : "#8a8e97";
    });
    const rootRunning = id === ROOT_AGENT && live && (model.calls.some(call => call.agent === ROOT_AGENT && call.state === "running") || input.active);
    const state = id === ROOT_AGENT ? (rootRunning ? "running" : live ? "idle" : "done") : agent?.state ?? "unknown";
    return { id, no: String(index + 1).padStart(2, "0"), role: input.memberName(id), cells, state: AGENT_WORD[state], working: state === "running" };
  });
}

function words(input: SceneInput): HfScene["words"] {
  const { model, metrics } = input;
  if (!model.calls.length) return null;
  const head = new Set<string>(), code = new Set<string>(), numbers = new Set<string>();
  for (const call of model.calls.slice(0, 40)) {
    const stage = call.stage ? STAGES[STAGE_INDEX.get(call.stage) ?? 0] : null;
    if (stage) { head.add(stage.code); code.add(`${call.stage}()`); }
    head.add(`OP ${String(call.seq % 10000).padStart(4, "0")}`);
    if (call.durationMs !== undefined) numbers.add((call.durationMs / 1000).toFixed(1));
    if (call.detail && ascii(call.detail)) code.add(clip(call.detail, 14));
  }
  [...model.agents.keys()].forEach((_, index) => head.add(`AGENT ${String(index + 1).padStart(2, "0")}`));
  for (const value of [metrics.toolTotal, metrics.requests, metrics.sources?.searched, metrics.sources?.included, metrics.claims?.verified]) {
    if (typeof value === "number" && value > 0) numbers.add(String(value));
  }
  if (metrics.tokensIn !== null) numbers.add(formatApproxCount(metrics.tokensIn).replace("万", "w"));
  code.add("ok"); code.add("->");
  return { head: [...head], code: [...code].filter(ascii), keys: ["calls", "tokens", "src", "incl", "claims", "sec", "agents", "files"], numbers: [...numbers].filter(ascii) };
}

/** The empty console: an instrument switched on with no signal. */
export function previewScene(): HfScene {
  const dash = (key: string, label: string): HfKpi => ({ key, label, value: "—", sub: "", ratio: null });
  return {
    preview: true, title: "等待研究启动", subtitle: "研究观测舱 · STANDBY",
    kpis: [dash("requests", "模型调用"), dash("tokens", "Token 吞吐"), dash("ops", "研究操作"), dash("sources", "文献纳入"), dash("claims", "结论核对"), dash("cost", "消耗")],
    status: { big: "等待研究启动", small: "研究开始后实时显示每一步" },
    callouts: [], feed: [], code: [], routes: { head: ["任务", "规划", "进行", "完成"], rows: [], caption: "研究开始后显示任务" }, agents: [],
    reasoning: { mode: "idle", thought: "" }, ops: [], window: null, live: false, stageNow: -1, stageCounts: STAGES.map(() => 0),
    captions: { reasoning: "等待研究启动", results: "还没有研究操作", signals: "等待研究启动", index: "7 个阶段", dispatch: "等待研究启动" },
    words: null, energy: 0, pulse: null,
  };
}

export function researchScene(input: SceneInput): HfScene {
  const { model, metrics, live } = input;
  const calls = model.calls;
  const newestFirst = calls;
  const oldestFirst = [...calls].reverse();
  const total = Math.max(model.callCount, calls.length);
  const position = (index: number) => total - index;
  const stageNowKey = live ? (calls.find(call => call.state === "running")?.stage ?? calls[0]?.stage ?? null) : null;
  const stageNow = stageNowKey ? STAGE_INDEX.get(stageNowKey) ?? -1 : -1;
  const stageLabel = stageNowKey ? STAGES[stageNow].label : "";
  const deliverables = input.deliverables;
  const done = deliverables.filter(item => item.status === "accepted" || item.status === "delivered").length;
  const members = Math.max(0, [...model.agents.keys()].filter(id => id !== ROOT_AGENT).length);
  const running = calls.filter(call => call.state === "running").length;
  const failed = calls.filter(call => call.state === "error").length;
  const settled = calls.filter(call => call.state !== "running").length;
  const times = calls.map(call => Date.parse(call.at)).filter(Number.isFinite);
  const from = input.startedMs ?? (times.length ? Math.min(...times) : null);
  const to = live ? input.now : input.endedMs ?? (times.length ? Math.max(...times) : null);
  const span = from !== null && to !== null ? Math.max(0, to - from) : null;
  const ratio = (part: number | undefined, whole: number | undefined) => (whole && whole > 0 && part !== undefined ? Math.min(1, part / whole) : null);
  const { requests, tokensIn, tokensOut, sources, claims, cost, toolTotal } = metrics;

  const kpis: HfKpi[] = [
    { key: "requests", label: "模型调用", value: requests === null ? "—" : formatApproxCount(requests), sub: requests === null ? "" : "次", ratio: null },
    { key: "tokens", label: "Token 吞吐", value: tokensIn === null && tokensOut === null ? "—" : formatApproxCount((tokensIn ?? 0) + (tokensOut ?? 0)),
      sub: "", ratio: null },
    { key: "ops", label: "研究操作", value: toolTotal ? formatApproxCount(toolTotal) : "—", sub: toolTotal ? "次" : "", ratio: calls.length ? settled / calls.length : null, accent: true },
    { key: "sources", label: "文献纳入", value: sources ? formatApproxCount(sources.included) : "—",
      sub: sources ? `/ ${formatApproxCount(sources.searched)}` : "",
      ratio: ratio(sources?.included, sources?.searched) },
    { key: "claims", label: "结论核对", value: claims ? `${claims.verified}/${claims.total}` : "—", sub: claims ? "条" : "", ratio: ratio(claims?.verified, claims?.total) },
    { key: "cost", label: "消耗", value: cost === null ? "—" : String(Math.round(cost * 100) / 100), sub: cost === null ? "" : "灵豆", ratio: null },
  ];

  const pinned = input.pinned;
  const callout = (call: ObservedCall): HfCallout => {
    const stage = call.stage ? STAGES[STAGE_INDEX.get(call.stage) ?? 0] : null;
    return { id: call.id, kicker: `${stage?.code ?? "ACTIVITY"} · ${call.label}`, value: clip(call.detail || call.label, 40) };
  };
  const newest = newestFirst[0];
  const pulse = newest ? {
    key: `${newest.id}:${newest.state}`,
    kind: newest.state === "error" ? "error" as const : newest.stage === "deliver" && newest.state === "done" ? "deliver" as const : "call" as const,
  } : null;

  return {
    preview: false,
    title: input.title,
    subtitle: `研究观测舱 · ${input.status} · ${input.clock}`,
    kpis,
    status: {
      big: deliverables.length ? (done === deliverables.length ? `${done} / ${done} 项任务完成` : `${done} / ${deliverables.length} 项任务 · ${deliverables.length - done} 待完成`)
        : total ? `${formatApproxCount(total)} 项研究操作${stageLabel ? ` · ${stageLabel}` : ""}` : live ? "等待第一个研究操作" : "这一轮没有研究操作",
      small: `主研究员${members ? ` · ${members} 位协作成员` : ""} · ${input.status}`,
    },
    callouts: pinned ? [callout(pinned)] : newestFirst.slice(0, CALLOUTS).map(callout),
    feed: newestFirst.slice(0, FEED_LINES).map((call, index) => {
      const stage = call.stage ? STAGES[STAGE_INDEX.get(call.stage) ?? 0] : null;
      return {
        id: call.id, n: pad(position(index)), verb: stage ? stage.code.toLowerCase() : "op", tone: call.stage ? TONE[call.stage] : "qa",
        text: `${call.label}${call.detail ? ` ${call.detail}` : ""} · ${input.memberName(call.agent)}`, failed: call.state === "error",
      };
    }).reverse(),
    code: newestFirst.slice(0, CODE_LINES).map((call, index) => ({
      id: call.id, n: pad(position(index)), name: call.stage ? RESULT_NAME[call.stage] : "结果", fn: call.label,
      arg: call.detail ? clip(call.detail, 48) : "", result: resultText(call), failed: call.state === "error", running: call.state === "running",
    })).reverse(),
    routes: routes(input),
    agents: agents(input),
    reasoning: { mode: !live ? "idle" : running ? "call" : input.waiting ? "idle" : "think", thought: live ? model.thought : "" },
    ops: oldestFirst.map(call => ({ stage: call.stage ? STAGE_INDEX.get(call.stage) ?? -1 : -1, state: call.state, ms: call.durationMs ?? null, at: Date.parse(call.at) }))
      .filter(op => Number.isFinite(op.at)),
    window: from !== null && to !== null ? { from, to: Math.max(to, from + 1) } : null,
    live,
    stageNow,
    stageCounts: STAGES.map(stage => input.counts[stage.key] ?? 0),
    captions: {
      reasoning: live ? (running ? "正在执行研究操作" : input.waiting ? "等待模型响应" : "模型正在推理") : "本轮已结束",
      results: [`${formatApproxCount(total)} 项操作`, failed ? `${failed} 项出错` : "", running ? `${running} 项进行中` : ""].filter(Boolean).join(" · "),
      signals: live ? "最近 10 分钟" : span !== null ? `全程 ${formatDuration(span) || "不到 1 秒"}` : "全程",
      index: `7 个阶段${stageLabel ? ` · 当前 ${stageLabel}` : ""}`,
      dispatch: `${members + 1} 位成员 · ${running} 项操作进行中`,
    },
    words: words(input),
    energy: input.active ? 1 : live ? 0.35 : 0,
    pulse,
  };
}
