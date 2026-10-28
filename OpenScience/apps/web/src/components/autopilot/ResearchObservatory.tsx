import { useEffect, useRef, useState } from "react";
import "./ResearchObservatory.css";
import { EVIMED_MARK_PATH } from "@/components/brand/EviMedMark";
import { listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { safeWorkspacePath } from "@/lib/claimCitations";
import { formatApproxCount, formatClock, formatDuration, formatLingdou } from "@/lib/format";
import { DELIVERABLE_STATUS_LABEL } from "@/lib/runProgress";
import { ROOT_AGENT, rootStage, STAGES, stageCounts, useResearchObservation, type ObservedAgent, type ObservedCall, type Observation, type StageKey } from "@/lib/researchObservation";

const RUN_WORD: Record<string, string> = { running: "进行中", succeeded: "已完成", failed: "未完成", canceled: "已停止", cancelled: "已停止" };
const AGENT_WORD: Record<ObservedAgent["state"], string> = { running: "工作中", idle: "待命", done: "已完成", failed: "未完成", canceled: "已停止", unknown: "待命" };
const SAFE_RUN = /^[A-Za-z0-9_-]{1,160}$/;
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);

/** 228:28:33 — hours keep counting past a day, the way a long study is read. */
export function elapsedClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "--:--:--";
  const total = Math.floor(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function payloadText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? null; } catch { return null; }
}

function useReducedMotion() {
  const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [reduced, setReduced] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return undefined;
    const change = () => setReduced(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, [query]);
  return reduced;
}

async function readRun(runId: string): Promise<WebAgentRun | null> {
  const runs = await listWebAgentRuns();
  return runs.find(item => item.id === runId) ?? (await listWebAgentRuns({ archived: true })).find(item => item.id === runId) ?? null;
}

/**
 * Anatomy: the research observatory — a status line, six live counters, the research line (seven stages, the
 * orchestrator above it and every delegated session below it, each standing at the stage of its last call), the
 * live operations feed with the selected operation's input and output, and what the run has handed over.
 * Variants: no selection; a run that is starting, running or ended.
 * States: connecting, live, reconnecting, ended; a count nothing has reported reads “—”, never 0.
 * Hit area: native buttons for the members, operations and files.
 * Keyboard: every member, operation and file is a button; the picture itself is described by its label.
 * Long content: inputs and outputs scroll inside their panel; titles truncate with the full text kept.
 * Theme: a fixed dark scene in both themes (the owner's observatory, 2026-10-28); the page around it follows the theme.
 * Motion: flows, pulses and rings stop under reduced motion; positions still change, without travel.
 * Responsive: the picture scales with its width; the feed and the inspector stack under 1024 px.
 * Verification: ResearchObservatory.test.tsx, researchObservation.test.ts.
 */
export function ResearchObservatory({ runId, title, onOpenFile }: { runId: string | null; title?: string; onOpenFile?: (path: string, runId: string) => void }) {
  if (!runId) return <section aria-label="研究观测" className="obs obs-empty" data-observatory="empty">
    <div className="obs-empty-body"><p className="obs-empty-title">等待研究启动</p><p className="obs-empty-text">选择一项研究，或立即执行一次，这里会实时显示研究过程。</p></div>
  </section>;
  return <ObservatoryRun key={runId} runId={runId} title={title} onOpenFile={onOpenFile} />;
}

function ObservatoryRun({ runId, title, onOpenFile }: { runId: string; title?: string; onOpenFile?: (path: string, runId: string) => void }) {
  const [run, setRun] = useState<WebAgentRun | null>(null);
  const [recordRead, setRecordRead] = useState<"loading" | "loaded" | "unavailable">("loading");
  const { model, connected } = useResearchObservation(runId, run?.progress ?? null);
  const state = model.state ?? run?.status ?? null;
  const ended = !!state && state !== "running";
  // Only the latest read lands: an initial read that answers after the terminal refresh must not put back a running record.
  const reads = useRef(0);
  useEffect(() => {
    let active = true; const request = ++reads.current;
    void readRun(runId).then(record => { if (active && request === reads.current) { setRun(record); setRecordRead("loaded"); } }).catch(() => { if (active && request === reads.current) setRecordRead("unavailable"); });
    return () => { active = false; };
  }, [runId]);
  // The record carries the run's totals and files once it ends: read it again when the stream says so.
  useEffect(() => {
    if (!model.state || model.state === "running") return undefined;
    let active = true; const request = ++reads.current;
    void readRun(runId).then(record => { if (active && request === reads.current && record) { setRun(record); setRecordRead("loaded"); } }).catch(() => {});
    return () => { active = false; };
  }, [runId, model.state]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state !== "running") return undefined;
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [state]);

  const progress = model.progress;
  const started = progress?.startedAt ?? run?.startedAt ?? null;
  const startedMs = started ? Date.parse(started) : Number.NaN;
  const finishedMs = run?.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  const elapsed = number(run?.durationMs) ?? (Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? finishedMs - startedMs
    : Number.isFinite(startedMs) && state === "running" ? Math.max(0, now - startedMs) : null);
  // The raw aggregate, so an absent token count stays unknown rather than zero.
  const usage = obj((progress as { usage?: unknown } | null)?.usage) ?? obj(run?.usage) ?? obj(run?.progress?.usage);
  const tokensIn = number(usage?.inputTokens), tokensOut = number(usage?.outputTokens), requests = number(usage?.requests), cost = number(usage?.costCny);
  const files = SAFE_RUN.test(runId) ? [...new Set([...(run?.outputFiles ?? []), ...(run?.presentedFiles ?? []), ...(run?.artifacts ?? []), ...(run?.unverifiedArtifacts ?? [])])].filter(path => safeWorkspacePath(path)) : [];
  const counts = stageCounts(model);
  const toolTotal = Math.max(model.callCount, Object.values(progress?.phaseCounts ?? {}).reduce((sum, value) => sum + value, 0));
  const included = progress && (progress.sources.included > 0 || progress.sources.searched > 0) ? progress.sources : null;
  const claims = progress && progress.claims.total > 0 ? progress.claims : null;
  const live = state === "running";
  const status = live ? (connected ? "实时" : "重新连接") : state ? RUN_WORD[state] ?? "已结束" : recordRead === "loading" || !connected ? "连接中" : "等待开始";
  const heading = title || run?.title || run?.question || "研究进行中";

  return <section aria-label="研究观测" className="obs" data-observatory={live ? "live" : ended ? "ended" : "waiting"}>
    <div className="obs-frame" aria-hidden="true"><span /><span /><span /><span /></div>
    <header className="obs-head">
      <div className="obs-head-main">
        <span className={live ? "obs-live on" : "obs-live"}><i aria-hidden="true" />{live ? "LIVE" : ended ? "END" : "SYNC"}</span>
        <div className="min-w-0"><p className="obs-kicker">研究观测舱</p><h3 className="obs-title">{heading}</h3></div>
      </div>
      <div className="obs-head-side"><span className="obs-clock" aria-label={`运行时长 ${formatDuration(elapsed) || "未开始"}`}>{elapsedClock(elapsed)}</span><span className={`obs-status s-${live ? "live" : state ?? "wait"}`} role="status">{status}</span></div>
    </header>
    <dl className="obs-hud">
      <Metric label="模型调用" value={requests === null ? "—" : formatApproxCount(requests)} sub="次" />
      <Metric label="Token 吞吐" value={tokensIn === null && tokensOut === null ? "—" : formatApproxCount((tokensIn ?? 0) + (tokensOut ?? 0))} sub={tokensIn === null ? "" : `输入 ${formatApproxCount(tokensIn)} · 输出 ${formatApproxCount(tokensOut ?? 0)}`} />
      <Metric label="研究操作" value={toolTotal ? formatApproxCount(toolTotal) : "—"} sub="次" />
      <Metric label="文献纳入" value={included ? formatApproxCount(included.included) : "—"} sub={included ? `检索 ${formatApproxCount(included.searched)} · 全文 ${formatApproxCount(included.fullText)}` : ""} />
      <Metric label="结论核对" value={claims ? `${claims.verified}/${claims.total}` : "—"} sub={claims ? "条已核对" : ""} />
      <Metric label="消耗" value={cost === null ? "—" : (formatLingdou(cost) || "—").replace(" 灵豆", "")} sub={cost === null ? "" : "灵豆"} />
    </dl>
    <ResearchLine model={model} counts={counts} live={live} />
    {model.thought && live && <p className="obs-thought" aria-live="off"><span className="obs-thought-tag">思考</span><span className="obs-thought-text">{model.thought}</span><i aria-hidden="true" /></p>}
    {progress && progress.deliverables.length > 0 && <ul className="obs-tasks" aria-label="研究任务">{progress.deliverables.map(item => <li key={item.id} className={`t-${item.status}`}><span className="min-w-0 truncate">{item.title}</span><b>{DELIVERABLE_STATUS_LABEL[item.status]}</b></li>)}</ul>}
    <OperationsFeed model={model} live={live} />
    {files.length > 0 && <div className="obs-files"><p className="obs-section-label">产出 · {files.length}</p><ul aria-label="研究产出">{files.map(file => <li key={file}>
      {onOpenFile ? <button type="button" className="obs-file" onClick={() => onOpenFile(file, runId)}>{file.split("/").pop() || file}</button> : <span className="obs-file">{file.split("/").pop() || file}</span>}
    </li>)}</ul></div>}
  </section>;
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="obs-metric"><dt>{label}</dt><dd><span className="obs-metric-value">{value}</span>{sub && <span className="obs-metric-sub">{sub}</span>}</dd></div>;
}

const VIEW_W = 1200;
const LINE_Y = 196;
const stageX = (index: number) => 96 + index * ((VIEW_W - 192) / (STAGES.length - 1));
const clipLabel = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const HEX = (r: number) => Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 3) * i + Math.PI / 6; return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`; }).join(" ");

/**
 * The research line: seven stages on a track, the orchestrator above the stage of its last call and each delegated
 * session below its own. A stage that has been reached lights; the stage someone is working at turns.
 */
function ResearchLine({ model, counts, live }: { model: Observation; counts: Record<StageKey, number>; live: boolean }) {
  const reduced = useReducedMotion();
  const current = rootStage(model);
  const children = [...model.agents.values()].filter(agent => !agent.root);
  const busy = new Set<StageKey>();
  if (live && current) busy.add(current);
  for (const child of children) if (child.state === "running" && child.stage) busy.add(child.stage);
  const furthest = STAGES.reduce((last, stage, index) => (counts[stage.key] > 0 ? index : last), -1);
  const rootX = stageX(Math.max(0, STAGES.findIndex(stage => stage.key === current)));
  const recent = (agent: string) => model.calls.filter(call => call.agent === agent).slice(0, 4);
  // Members at one stage stand side by side under it.
  const slots = new Map<StageKey | "none", number>();
  const placed = children.slice(0, 12).map(child => {
    const key = child.stage ?? "none"; const slot = slots.get(key) ?? 0; slots.set(key, slot + 1);
    const index = child.stage ? STAGES.findIndex(stage => stage.key === child.stage) : 0;
    // Two rows under a stage: the first member straight below it, the next two on the second row either side, then
    // further out on the first row — a stage is 168 px wide, so members of neighbouring stages never touch.
    const [row, offset] = slot === 0 ? [0, 0] : slot <= 2 ? [1, slot === 1 ? 58 : -58] : [(slot - 3) % 2, (slot % 2 ? 1 : -1) * 116];
    return { child, x: Math.min(VIEW_W - 50, Math.max(50, stageX(index) + offset)), y: 300 + row * 54 };
  });
  const summary = [current && live ? `正在${STAGES.find(stage => stage.key === current)?.label}` : null,
    ...STAGES.filter(stage => counts[stage.key] > 0).map(stage => `${stage.label} ${counts[stage.key]} 次`),
    children.length ? `协作成员 ${children.length} 位` : null].filter(Boolean).join("，");
  const track = `M ${stageX(0)} ${LINE_Y} L ${stageX(STAGES.length - 1)} ${LINE_Y}`;
  return <div className="obs-scene">
    <div className="obs-floor" aria-hidden="true" />
    {live && <div className="obs-sweep" aria-hidden="true" />}
    <svg viewBox={`0 0 ${VIEW_W} 410`} className="obs-svg" role="img" aria-label={`研究流程：${summary || "等待第一个操作"}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <filter id="obs-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <linearGradient id="obs-track-lit" x1="0" x2="1"><stop offset="0" className="obs-stop-a" /><stop offset="1" className="obs-stop-b" /></linearGradient>
      </defs>
      <path d={track} className="obs-track" />
      {furthest >= 0 && <path d={`M ${stageX(0)} ${LINE_Y} L ${stageX(furthest)} ${LINE_Y}`} className={live ? "obs-track-lit flow" : "obs-track-lit"} />}
      {furthest > 0 && live && !reduced && [0, 1, 2, 3, 4].map(i => <circle key={i} r={i % 2 ? 2.4 : 3.4} className={i % 2 ? "obs-packet alt" : "obs-packet"}><animateMotion dur={`${2.4 + i * 0.55}s`} begin={`${i * 0.7}s`} repeatCount="indefinite" path={`M ${stageX(0)} ${LINE_Y} L ${stageX(furthest)} ${LINE_Y}`} /></circle>)}
      {STAGES.map((stage, index) => {
        const x = stageX(index); const count = counts[stage.key];
        const mode = busy.has(stage.key) ? "busy" : count > 0 ? "done" : "idle";
        return <g key={stage.key} className={`obs-stage m-${mode}`} transform={`translate(${x} ${LINE_Y})`}>
          {mode === "busy" && <circle r="50" className="obs-ring" />}
          {mode === "busy" && live && !reduced && <circle r="36" className="obs-ripple" />}
          <polygon points={HEX(36)} className="obs-hex" filter={mode === "busy" ? "url(#obs-glow)" : undefined} />
          <polygon points={HEX(28)} className="obs-hex-in" />
          <text y="7" className="obs-count">{count > 0 ? formatApproxCount(count) : "·"}</text>
          <text y="66" className="obs-stage-label">{stage.label}</text>
          <text y="84" className="obs-stage-code">{String(index + 1).padStart(2, "0")} {stage.code}</text>
        </g>;
      })}
      <g className={live ? "obs-agent obs-root on" : "obs-agent obs-root"} style={{ transform: `translate(${rootX}px, 64px)` }}>
        <line x1="0" y1="28" x2="0" y2={LINE_Y - 64 - 38} className={live && current ? "obs-beam flow" : "obs-beam"} />
        {!reduced && live && recent(ROOT_AGENT).map((call, i) => <circle key={call.id} r="3.5" className={`obs-pulse p-${call.state}`} style={{ animationDelay: `${i * 0.18}s`, ["--travel" as string]: `${LINE_Y - 64 - 66}px` }} cy="30" />)}
        {live && !reduced && <circle r="34" className="obs-ring obs-ring-root" />}
        <polygon points={HEX(26)} className="obs-core" filter="url(#obs-glow)" />
        <path d={EVIMED_MARK_PATH} transform="translate(-11 -11) scale(0.69)" className="obs-mark" />
        <text y="-36" className="obs-agent-label">主研究员</text>
      </g>
      {placed.map(({ child, x, y }) => <g key={child.id} className={`obs-agent obs-child s-${child.state}`} style={{ transform: `translate(${x}px, ${y}px)` }}>
        <line x1="0" y1="-18" x2="0" y2={-(y - LINE_Y - 38)} className={child.state === "running" ? "obs-beam child flow" : "obs-beam child"} />
        {!reduced && child.state === "running" && recent(child.id).map((call, i) => <circle key={call.id} r="3" className={`obs-pulse up p-${call.state}`} style={{ animationDelay: `${i * 0.2}s`, ["--travel" as string]: `${-(y - LINE_Y - 56)}px` }} cy="-20" />)}
        <polygon points={HEX(17)} className="obs-node" />
        <text y="5" className="obs-node-count">{child.calls || "·"}</text>
        <text y="38" className="obs-agent-label small">{clipLabel(child.label || "协作成员", 5)}</text>
      </g>)}
    </svg>
  </div>;
}

function OperationsFeed({ model, live }: { model: Observation; live: boolean }) {
  const [agent, setAgent] = useState<string>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const members = [...model.agents.values()].filter(item => !item.root);
  const visible = model.calls.filter(call => agent === "all" || call.agent === agent);
  const chosen = visible.find(call => call.id === selected) ?? visible[0] ?? null;
  const memberName = (id: string) => id === ROOT_AGENT ? "主研究员" : model.agents.get(id)?.label || "协作成员";
  return <div className="obs-feed-grid">
    <section aria-label="实时动态" className="obs-panel">
      <div className="obs-panel-head">
        <p className="obs-section-label">实时动态{live && <span className="obs-blink" aria-hidden="true">▍</span>}</p>
        <div className="obs-chips" role="group" aria-label="按成员查看">
          <button type="button" aria-pressed={agent === "all"} onClick={() => { setAgent("all"); setSelected(null); }}>全部</button>
          <button type="button" aria-pressed={agent === ROOT_AGENT} onClick={() => { setAgent(ROOT_AGENT); setSelected(null); }}>主研究员</button>
          {members.map(member => <button key={member.id} type="button" aria-pressed={agent === member.id} onClick={() => { setAgent(member.id); setSelected(null); }} aria-label={`${member.label || "协作成员"} · ${AGENT_WORD[member.state]}`}>
            <i className={`obs-dot s-${member.state}`} aria-hidden="true" />{(member.label || "协作成员").slice(0, 10)}
          </button>)}
        </div>
      </div>
      {visible.length ? <ol className="obs-log">{visible.slice(0, 40).map(call => <li key={call.id}>
        <button type="button" className={`obs-line c-${call.state}`} aria-pressed={chosen?.id === call.id} onClick={() => setSelected(call.id)}>
          <time className="obs-line-time">{formatClock(call.at) || "--:--"}</time>
          <span className={`obs-tag g-${call.stage ?? "none"}`}>{call.stage ? STAGES.find(stage => stage.key === call.stage)?.label : "操作"}</span>
          <span className="obs-line-text"><b>{call.label}</b>{call.detail && <span> {call.detail}</span>}</span>
          <span className="obs-line-who">{memberName(call.agent)}</span>
          <span className="obs-line-state">{call.state === "running" ? "…" : call.state === "error" ? "✕" : "✓"}{call.durationMs !== undefined && call.state !== "running" ? ` ${formatDuration(call.durationMs)}` : ""}</span>
        </button>
      </li>)}</ol> : <p className="obs-quiet">{live ? "等待第一个研究操作" : "这次执行没有研究操作"}</p>}
    </section>
    <Inspector call={chosen} who={chosen ? memberName(chosen.agent) : ""} />
  </div>;
}

function Inspector({ call, who }: { call: ObservedCall | null; who: string }) {
  if (!call) return <section aria-label="操作详情" className="obs-panel obs-inspector"><p className="obs-section-label">操作详情</p><p className="obs-quiet">选择一条动态查看输入与结果</p></section>;
  const input = payloadText(call.input); const output = payloadText(call.output);
  return <section aria-label="操作详情" className="obs-panel obs-inspector">
    <p className="obs-section-label">操作详情</p>
    <p className="obs-inspect-title">{call.label}</p>
    <p className="obs-inspect-meta">{who} · {call.state === "running" ? "进行中" : call.state === "error" ? "未成功" : "已完成"}{call.durationMs !== undefined ? ` · ${formatDuration(call.durationMs)}` : ""}</p>
    <Payload title="输入" text={input} pending="—" />
    <Payload title="结果" text={output} pending={call.state === "running" ? "等待结果" : "—"} />
  </section>;
}

function Payload({ title, text, pending }: { title: string; text: string | null; pending: string }) {
  const long = text !== null && text.length > 1200;
  return <div className="obs-payload"><p className="obs-payload-title">{title}</p>
    {text === null ? <p className="obs-quiet">{pending}</p> : <pre>{long ? `${text.slice(0, 1200)}…` : text || "（空）"}</pre>}
    {long && <details><summary>展开全部</summary><pre>{text}</pre></details>}
  </div>;
}
