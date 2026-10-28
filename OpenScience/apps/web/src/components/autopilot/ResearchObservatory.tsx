import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TURN_END_KINDS } from "@evimed/domain";
import { Activity, Clock3, FileText, GitBranch, Wrench } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { List } from "@/components/ui/ListRow";
import { EviMedMark } from "@/components/brand/EviMedMark";
import "./ResearchObservatory.css";
import { listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { safeWorkspacePath } from "@/lib/claimCitations";
import { useRunEvents, type RunStreamEvent } from "@/lib/runEvents";
import { currentPhaseLabel, DELIVERABLE_STATUS_LABEL, foldRunEvents } from "@/lib/runProgress";
import { formatClock, formatDay, formatDuration, formatLingdou } from "@/lib/format";

const stateLabel: Record<string, string> = { running: "进行中", succeeded: "已完成", failed: "未完成", canceled: "已取消", idle: "等待中", done: "已完成", completed: "已完成", error: "出错", interrupted: "已中断", aborted: "已中止", blocked: "受阻" };
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const status = (value: unknown) => { const kind = str(value) ?? ""; return stateLabel[kind] ?? (TURN_END_KINDS.includes(kind) && kind !== "unknown" ? "已结束" : "状态未知"); };
const dateTime = (value: string | null | undefined) => value ? [formatDay(value), formatClock(value)].filter(Boolean).join(" ") || "未知" : "未知";
const duration = (ms: number | null) => formatDuration(ms) || "未知";

type Child = { id: string; label?: string; state?: string; at?: string; parent?: string; observedAt?: string; ambiguous?: boolean; confirmedState?: string };
type ToolActivity = { id: string; name: string; description?: string; state: string; time: string; child?: string; input?: unknown; output?: unknown; seq: number };

function eventText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? null; } catch { return null; }
}

function EventContent({ title, value }: { title: string; value: unknown }) {
  const text = eventText(value);
  if (text === null) return <div><h5 className="text-caption font-semibold">{title}</h5><p className="mt-1 text-caption text-text-3">尚未收到</p></div>;
  const long = text.length > 600;
  return <div><h5 className="text-caption font-semibold">{title}</h5><pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-3 text-caption text-text-2">{long ? `${text.slice(0, 600)}…` : text || "（空）"}</pre>{long && <details className="mt-2 text-caption text-text-2"><summary className="cursor-pointer">展开完整内容</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-3">{text}</pre></details>}</div>;
}

/** Only facts published by the run are represented; a missing field stays unknown. */
export function observeResearch(events: readonly RunStreamEvent[], run: WebAgentRun | null) {
  const fold = foldRunEvents(events);
  const children = new Map<string, Child>();
  const tools = new Map<string, ToolActivity>();
  const mergeChild = (next: Child, fromProgress = false) => {
    const old = children.get(next.id);
    const before = old?.observedAt ? Date.parse(old.observedAt) : NaN;
    const after = next.observedAt ? Date.parse(next.observedAt) : NaN;
    const stale = !!old && (Number.isFinite(before) && Number.isFinite(after) ? after < before : ["done", "completed", "failed", "error", "canceled"].includes(old.state ?? "") && next.state === "running");
    // The pump republishes replayed lifecycle events with the replay time. Once an aggregate has confirmed a
    // state, a conflicting lifecycle event cannot safely override it until another aggregate settles the conflict.
    const category = (value?: string) => ["done", "completed", "succeeded"].includes(value ?? "") ? "completed" : ["failed", "error"].includes(value ?? "") ? "failed" : ["running", "idle", "canceled"].includes(value ?? "") || (TURN_END_KINDS.includes(value ?? "") && value !== "unknown") ? value : null;
    const conflict = !fromProgress && !stale && !!next.state && (!!old?.ambiguous || (!!old?.confirmedState && !!category(next.state) && category(next.state) !== category(old.confirmedState)));
    children.set(next.id, { ...old, ...next, label: next.label ?? old?.label, parent: next.parent ?? old?.parent,
      state: stale ? old?.state : conflict ? "unknown" : next.state ?? old?.state,
      confirmedState: stale ? old?.confirmedState : fromProgress ? next.state ?? old?.confirmedState : old?.confirmedState,
      ambiguous: stale ? old?.ambiguous : conflict || (!fromProgress && old?.ambiguous),
      at: stale ? old?.at : next.at ?? old?.at, observedAt: stale ? old?.observedAt : next.observedAt ?? old?.observedAt });
  };
  const addProgress = (progress: unknown, receivedAt?: string) => {
    const p = obj(progress);
    const deliverables = Array.isArray(p?.deliverables) ? p.deliverables.map(obj).filter(Boolean) : [];
    for (const value of Array.isArray(p?.children) ? p.children : []) {
      const child = obj(value); const id = str(child?.childSessionId);
      if (!id) continue;
      const item = deliverables.find((d) => str(d?.id) === str(child?.deliverableId));
      mergeChild({ id, label: str(item?.title), state: str(child?.state), at: str(child?.lastActivityAt), observedAt: str(p?.updatedAt) ?? receivedAt }, true);
    }
  };
  addProgress(run?.progress);
  for (const frame of events) {
    if (frame.type === "run/progress") addProgress(frame.progress ?? frame, frame.time);
    if (frame.type === "subagent/update") {
      const id = str(frame.childSessionId); if (!id) continue;
      mergeChild({ id, label: str(frame.label), state: str(frame.status), at: frame.time, observedAt: frame.time });
    }
    if (frame.type !== "run/event") continue;
    const event = obj(frame.event); if (!event) continue;
    if (event.type === "subagent/started") {
      const id = str(event.childSessionId); if (!id) continue;
      mergeChild({ id, label: str(event.label), state: "running", at: frame.time, parent: str(event.parentSessionId), observedAt: frame.time });
    }
    if (event.type !== "tool/call" && event.type !== "tool/result") continue;
    const call = str(event.callId); if (!call) continue;
    const session = str(frame.sessionId) ?? ""; const key = `${session}:${call}`; const old = tools.get(key);
    tools.set(key, { id: key, name: str(event.tool) ?? old?.name ?? "工具", description: str(event.narration) ?? old?.description,
      state: event.type === "tool/call" ? "已调用，结果未知" : event.status === "completed" ? "已完成" : event.status === "error" ? "出错" : "状态未知",
      time: frame.time, child: frame.child === true ? session : undefined, input: event.type === "tool/call" ? event.input : old?.input, output: event.type === "tool/result" ? event.output : old?.output, seq: frame.seq });
  }
  return { fold, children: [...children.values()], tools: [...tools.values()].sort((a, b) => b.seq - a.seq), gap: events.some((event) => event.type === "stream/gap") || (events.length > 0 && events[0].seq > 1) };
}

/**
 * Anatomy: observed delegation scene, activity, selected input/output and usage.
 * Variants: a selected run or an empty selection.
 * States: loading, connected, unavailable, partial event history and terminal runs.
 * Hit area: shared Button controls.
 * Keyboard: agent and activity choices use native buttons; long output uses disclosure.
 * Long content: input and output wrap and can be expanded.
 * Theme: fixed scientific canvas from design tokens; surrounding surfaces follow the theme.
 * Responsive: the canvas and details stack on narrow screens.
 * Verification: ResearchObservatory.test.tsx; live runtime and assistive-technology checks remain separate.
 */
export function ResearchObservatory({ runId, onOpenFile }: { runId: string | null; onOpenFile?: (path: string, runId: string) => void }) {
  if (!runId) return <section aria-label="研究执行" className="rounded-card bg-surface-2 p-5 text-ui text-text-2">选择一次研究执行，查看实时进展。</section>;
  return <ObservatoryRun key={runId} runId={runId} onOpenFile={onOpenFile} />;
}

function ObservatoryRun({ runId, onOpenFile }: { runId: string; onOpenFile?: (path: string, runId: string) => void }) {
  const stream = useRunEvents(runId);
  const [run, setRun] = useState<WebAgentRun | null>(null);
  const [recordState, setRecordState] = useState<"loading" | "loaded" | "unavailable">("loading");
  const [now, setNow] = useState(Date.now());
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const scene = useRef<HTMLDivElement>(null);
  const recordGeneration = useRef(0);
  const [edges, setEdges] = useState<Array<{ id: string; path: string; active: boolean }>>([]);
  useEffect(() => {
    let active = true; const request = ++recordGeneration.current;
    const read = async () => {
      const runs = await listWebAgentRuns();
      return runs.find(item => item.id === runId) ?? (await listWebAgentRuns({ archived: true })).find(item => item.id === runId) ?? null;
    };
    void read().then((record) => { if (active && request === recordGeneration.current) { setRun(record); setRecordState("loaded"); } }).catch(() => { if (active && request === recordGeneration.current) setRecordState("unavailable"); });
    return () => { active = false; };
  }, [runId]);
  const observed = useMemo(() => observeResearch(stream.events, run), [stream.events, run]);
  const currentState = observed.fold.state ?? run?.status;
  useEffect(() => {
    if (currentState !== "running") return undefined;
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [currentState]);
  useEffect(() => {
    if (!observed.fold.state || observed.fold.state === "running") return undefined;
    let active = true; const request = ++recordGeneration.current;
    const read = async () => {
      const runs = await listWebAgentRuns();
      return runs.find(item => item.id === runId) ?? (await listWebAgentRuns({ archived: true })).find(item => item.id === runId) ?? null;
    };
    void read().then((record) => { if (active && request === recordGeneration.current) { setRun(record); setRecordState("loaded"); } }).catch(() => { if (active && request === recordGeneration.current) setRecordState("unavailable"); });
    return () => { active = false; };
  }, [runId, observed.fold.state]);
  const rawProgress = [...stream.events].reverse().find((event) => event.type === "run/progress");
  const liveRaw = obj(rawProgress?.progress ?? rawProgress);
  const liveAt = Date.parse(str(liveRaw?.updatedAt) ?? rawProgress?.time ?? "");
  const savedAt = Date.parse(run?.progress?.updatedAt ?? "");
  const savedIsNewer = Number.isFinite(savedAt) && (!Number.isFinite(liveAt) || savedAt > liveAt);
  const progress = savedIsNewer ? run?.progress ?? null : observed.fold.progress ?? run?.progress ?? null;
  const runState = observed.fold.state ?? run?.status;
  const started = progress?.startedAt ?? run?.startedAt;
  const startedMs = started ? Date.parse(started) : NaN;
  const elapsed = run?.durationMs != null ? number(run.durationMs) : Number.isFinite(startedMs) && run?.finishedAt && Number.isFinite(Date.parse(run.finishedAt)) ? Date.parse(run.finishedAt) - startedMs : Number.isFinite(startedMs) && runState === "running" ? now - startedMs : null;
  // Read the raw aggregate to avoid turning absent token fields into zero.
  const rawUsage = (savedIsNewer ? obj(run?.progress?.usage) : obj(liveRaw?.usage)) ?? obj(run?.usage) ?? obj(run?.progress?.usage);
  const input = number(rawUsage?.inputTokens); const output = number(rawUsage?.outputTokens); const cached = number(rawUsage?.cachedInputTokens); const requests = number(rawUsage?.requests); const cost = number(rawUsage?.costCny);
  const files = [...new Set([...(run?.outputFiles ?? []), ...(run?.presentedFiles ?? []), ...(run?.artifacts ?? []), ...(run?.unverifiedArtifacts ?? [])])].filter(path => safeWorkspacePath(path) && /^[A-Za-z0-9_-]{1,160}$/.test(runId));
  const phase = currentPhaseLabel(progress);
  useLayoutEffect(() => {
    const element = scene.current;
    if (!element) return undefined;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const nodes = new Map(Array.from(element.querySelectorAll<HTMLElement>("[data-research-agent]"), node => [node.dataset.researchAgent, node]));
      const next = observed.children.flatMap(child => {
        if (!child.parent) return [];
        const parent = nodes.get(child.parent), target = nodes.get(child.id);
        if (!parent || !target) return [];
        const a = parent.getBoundingClientRect(), b = target.getBoundingClientRect();
        const x1 = a.left - bounds.left + a.width / 2, y1 = a.bottom - bounds.top;
        const x2 = b.left - bounds.left + b.width / 2, y2 = b.top - bounds.top;
        const middle = (y1 + y2) / 2;
        return [{ id: child.id, path: `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`, active: child.state === "running" }];
      });
      setEdges(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    for (const node of element.querySelectorAll("[data-research-agent]")) observer.observe(node);
    return () => observer.disconnect();
  }, [observed.children, run?.sessionId]);
  const visibleTools = observed.tools.filter((tool) => selectedAgent === "all" || (selectedAgent === "root" ? !tool.child : tool.child === selectedAgent));
  const selectedActivity = visibleTools.find((tool) => tool.id === selectedTool) ?? visibleTools[0];
  const selectAgent = (id: string) => { setSelectedAgent(id); setSelectedTool(null); };
  const agentName = (id: string) => id === run?.sessionId ? "EviMed 主理" : observed.children.find((child) => child.id === id)?.label ?? "上游任务";
  return <section aria-label="研究执行" className="overflow-hidden rounded-card bg-surface-2 text-text">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-5">
      <div><div className="flex items-center gap-2 text-caption text-text-3"><Activity size={16} aria-hidden="true" />研究执行</div><h3 className="mt-2 text-heading font-semibold">{run?.title || run?.question || "研究进行情况"}</h3><p className="mt-1 text-ui text-text-2">{phase ?? (runState ? status(runState) : "等待执行信息")}</p></div>
      <div className="text-right text-caption text-text-3"><p>{stream.connected ? "实时连接中" : recordState === "loading" && stream.events.length === 0 ? "正在连接" : runState && ["succeeded", "failed", "canceled"].includes(runState) ? "执行已结束" : "连接中断或暂不可用"}</p><p className="mt-1">{runState ? status(runState) : "状态未知"}</p></div>
    </div>
    {observed.gap && <p role="status" className="border-b border-border px-5 py-3 text-ui text-text">部分早期事件已不可用，以下仅展示收到的记录。</p>}
    {recordState === "unavailable" && <p role="status" className="border-b border-border px-5 py-3 text-ui text-text">执行记录暂不可用，仍可查看已收到的实时事件。</p>}
    <div className="grid gap-5 p-5 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-ui font-semibold">协作执行</h4><Button variant="text" size="sm" aria-pressed={selectedAgent === "all"} onClick={() => selectAgent("all")}>全部动态</Button></div><div ref={scene} className="research-scene mt-3 rounded-card" aria-label="协作关系">
          <div className="research-scene-label">EviMed · 研究执行现场</div>
          <svg className="research-wires" aria-hidden="true">{edges.map(edge => <path key={edge.id} d={edge.path} className={edge.active ? "research-wire active" : "research-wire"} />)}</svg>
          <div className="research-director"><Button variant="secondary" data-research-agent={run?.sessionId ?? "root"} aria-label="查看 EviMed 总指挥" aria-pressed={selectedAgent === "root"} className="research-node research-root h-auto min-w-0 flex-col items-start whitespace-normal text-left" onClick={() => selectAgent("root")}><span className="flex items-center gap-2 text-ui font-semibold"><EviMedMark className="research-mark h-6 w-6" />EviMed 主理</span><span className="research-node-meta mt-2 text-caption">{runState ? status(runState) : "状态未知"}{phase ? ` · ${phase}` : ""}</span></Button></div>
          <div className="research-children grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{observed.children.map((child, index) => <Button key={child.id} variant="secondary" data-research-agent={child.id} aria-label={`查看 ${child.label || `协作任务 ${index + 1}`}`} aria-pressed={selectedAgent === child.id} className="research-node h-auto w-full min-w-0 flex-col items-start whitespace-normal text-left" onClick={() => selectAgent(child.id)}><span className="flex items-center gap-2 text-ui font-semibold"><GitBranch size={16} aria-hidden="true" />{child.label || `协作任务 ${index + 1}`}{child.state === "running" && <span className="research-live" aria-hidden="true" />}</span><span className="research-node-meta mt-2 text-caption">{status(child.state)}{child.at ? ` · ${dateTime(child.at)}` : ""}</span>{child.parent && <span className="research-node-meta mt-1 text-caption">由 {agentName(child.parent)} 发起</span>}</Button>)}</div>
        </div>{observed.children.length === 0 && <p className="mt-3 text-caption text-text-3">尚未收到协作任务记录</p>}</div>
        {progress && progress.deliverables.length > 0 && <div><h4 className="text-ui font-semibold">研究任务</h4><List divided className="mt-2">{progress.deliverables.map(item => <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-ui"><span className="min-w-0 break-words">{item.title}</span><span className="shrink-0 text-caption text-text-3">{DELIVERABLE_STATUS_LABEL[item.status]}</span></li>)}</List></div>}
        <div><h4 className="text-ui font-semibold">执行动态</h4><p className="mt-1 text-caption text-text">仅显示当前可获取的近期事件，较早记录可能不可用。</p>{visibleTools.length ? <List divided className="mt-3">{visibleTools.slice(0, 12).map((tool) => <li key={tool.id} className="flex items-start gap-3 py-3 text-ui"><Wrench size={16} className="mt-0.5 shrink-0 text-text-3" aria-hidden="true" /><div className="min-w-0 flex-1"><Button variant="text" size="sm" aria-pressed={selectedActivity?.id === tool.id} className="h-auto max-w-full justify-start whitespace-normal px-0 text-left" onClick={() => setSelectedTool(tool.id)}><span className="break-words">{tool.description || tool.name}</span></Button><p className="mt-1 text-caption text-text-3">{tool.child ? observed.children.find((child) => child.id === tool.child)?.label || "协作任务" : "EviMed 主理"} · {tool.state}</p></div><time className="shrink-0 text-caption text-text-3">{dateTime(tool.time)}</time></li>)}</List> : <p className="mt-3 text-caption text-text-3">尚未收到工具活动记录</p>}
          {selectedActivity && <section aria-label="工具过程与结果" className="mt-3 space-y-4 rounded-card bg-surface p-4"><div><h5 className="text-ui font-semibold">{selectedActivity.name}</h5><p className="mt-1 text-caption text-text-3">{selectedActivity.state} · {dateTime(selectedActivity.time)}</p></div><EventContent title="输入" value={selectedActivity.input} /><EventContent title="输出" value={selectedActivity.output} /></section>}
        </div>
      </div>
      <aside className="space-y-5 rounded-card bg-surface p-4"><div><h4 className="flex items-center gap-2 text-ui font-semibold"><Clock3 size={16} aria-hidden="true" />执行详情</h4><dl className="mt-3 space-y-2 text-caption"><div className="flex justify-between gap-3"><dt className="text-text-3">开始时间</dt><dd>{dateTime(started)}</dd></div><div className="flex justify-between gap-3"><dt className="text-text-3">已用时间</dt><dd>{duration(elapsed)}</dd></div><div className="flex justify-between gap-3"><dt className="text-text-3">输入 / 输出 token</dt><dd>{input === null ? "未知" : input.toLocaleString()} / {output === null ? "未知" : output.toLocaleString()}</dd></div><div className="flex justify-between gap-3"><dt className="text-text-3">缓存输入 token</dt><dd>{cached === null ? "未知" : cached.toLocaleString()}</dd></div><div className="flex justify-between gap-3"><dt className="text-text-3">模型调用</dt><dd>{requests === null ? "未知" : requests.toLocaleString()}</dd></div><div className="flex justify-between gap-3"><dt className="text-text-3">已记录消耗</dt><dd>{cost === null ? "未知" : formatLingdou(cost)}</dd></div></dl></div>
        <div><h4 className="flex items-center gap-2 text-ui font-semibold"><FileText size={16} aria-hidden="true" />研究文件</h4>{files.length ? <ul className="mt-2 space-y-1">{files.map((file) => <li key={file}>{onOpenFile ? <Button variant="text" size="sm" className="max-w-full justify-start" onClick={() => onOpenFile(file, runId)}><span className="truncate">{file.split("/").pop() || file}</span></Button> : <span className="block break-all text-caption text-text-2">{file.split("/").pop() || file}</span>}</li>)}</ul> : <p className="mt-2 text-caption text-text-3">暂无可展示的文件记录</p>}</div>
      </aside>
    </div>
  </section>;
}
