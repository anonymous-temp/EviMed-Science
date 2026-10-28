import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { FlaskConical } from "lucide-react";
import { getWebProjectId, listWebAgentRuns, steerWebAgentRun, WebApiError, type WebAgentRun } from "@/lib/apiClient";
import { addAgendaMaterials, cancelEpisode, followUpAgenda, getResearchState, listAgendas, listEpisodes, removeAgendaMaterial, runAgendaNow, type AgendaRecord, type EpisodeRecord, type ResearchState } from "@/lib/autopilotClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { safeWorkspacePath } from "@/lib/claimCitations";
import { sha256Hex } from "@/lib/fileDigest";
import { formatDay, formatClock } from "@/lib/format";
import { KNOWLEDGE_BASE_ACCEPT, partitionKnowledgeBaseFiles } from "@/lib/knowledgeBaseFiles";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { goalTitle, observedResearchGoals, type ObservedResearchGoal } from "@/lib/observedResearchGoals";
import { chatPath } from "@/lib/runLocation";
import { newRuntimeUiIntent, scopedConversationPath } from "@/lib/runtimeUiNavigation";
import { registerTaskPane } from "@/lib/taskPane";
import { snapshotHref } from "@/lib/readPages";
import { researchDatabaseStatus } from "@/lib/researchDatabaseClient";
import { listPlatformSkills } from "@/lib/skillLibraryClient";
import { taskPath } from "@/lib/taskLocation";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import type { PageActionPlan } from "@/components/layout/HeaderActions";
import { List, ListRow } from "@/components/ui/ListRow";
import { MaterialPicker } from "@/components/autopilot/MaterialPicker";
import { ResearchDatabaseDialog } from "@/components/autopilot/ResearchDatabaseDialog";
import { ResearchDataPanel } from "@/components/autopilot/ResearchDataPanel";
import { ResearchObservatory } from "@/components/autopilot/ResearchObservatory";
import { ResearchQueue, type QueueEntry, type QueueMode } from "@/components/autopilot/ResearchQueue";
import { TaskForm } from "@/components/autopilot/TaskForm";
import { activeAgenda, inFlight, latestRun, repeatLine, runState, scheduleOf } from "@/components/autopilot/taskPresentation";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Textarea } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";

class MaterialInputError extends Error {}

const at = (value: string | null | undefined) => [formatDay(value), formatClock(value)].filter(Boolean).join(" ");
const SAFE_RUN = /^[A-Za-z0-9_-]{1,160}$/;
const FOUND_TAG: Record<ResearchState["found"][number]["check"], { label: string; tone: "neutral" | "accent" | "warn" }> = {
  reproduced: { label: "已复现", tone: "accent" }, stands: { label: "复核成立", tone: "neutral" }, refuted: { label: "已推翻", tone: "warn" },
};

function agendaMode(agenda: AgendaRecord, episodes: readonly EpisodeRecord[]): QueueMode {
  const live = episodes.find(item => item.payload.agendaId === agenda.id && inFlight(item));
  if (live) return live.payload.status === "queued" ? "queued" : "running";
  if (!activeAgenda(agenda)) return "paused";
  const last = latestRun(agenda.id, episodes)?.payload.status;
  return last === "merged" ? "done" : last === "failed" ? "failed" : "waiting";
}

/** A project's active research — long goals and scheduled studies — with the live observatory of the one selected. */
export function ActiveResearchPage() {
  useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  return <ResearchWorkspace key={projectId} projectId={projectId} />;
}

function ResearchWorkspace({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location); locationRef.current = location;
  const pendingNativeIntent = useRef<string | null>(null);
  const acknowledgedNativeIntent = useRef<string | null>(null);
  const [agendas, setAgendas] = useState<AgendaRecord[] | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [goalRuns, setGoalRuns] = useState<WebAgentRun[] | null>(null);
  const [goalError, setGoalError] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
  const [selectedRound, setSelectedRound] = useState<string | null>(null);
  const [nativeSession, setNativeSession] = useState<string | null>(null);
  const [nativePending, setNativePending] = useState(false);
  const [nativeUncertain, setNativeUncertain] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [history, setHistory] = useState<{ agendaId: string; items: EpisodeRecord[]; nextCursor: string | null; paged: boolean } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [progress, setProgress] = useState<ResearchState | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [longFeature, setLongFeature] = useState<"loading" | "enabled" | "disabled" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editor, setEditor] = useState(false);
  const [picking, setPicking] = useState(false);
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const [databaseAvailable, setDatabaseAvailable] = useState(false);
  const [steering, setSteering] = useState(false);
  const [direction, setDirection] = useState("");
  const generation = useRef(0);
  const progressGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const operating = useRef(false);
  const pendingRuns = useRef(new Map<string, string>());
  const optimisticEpisodes = useRef(new Map<string, EpisodeRecord>());
  const pendingStops = useRef(new Map<string, string>());
  const pendingDirections = useRef(new Map<string, { note: string; episodeId: string | null; requestId: string }>());
  const loadingTasks = useRef(false);
  const loadingGoals = useRef(false);
  const loadingHistory = useRef<string | null>(null);
  const loadingProgress = useRef<string | null>(null);
  const mounted = useRef(true);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;

  const load = useCallback(async (force = false) => {
    if (loadingTasks.current && !force) return;
    loadingTasks.current = true;
    const request = ++generation.current;
    try {
      const [tasks, firstPage] = await Promise.all([listAgendas(projectId), listEpisodes(projectId)]);
      const runs = [...firstPage.items];
      const seenCursors = new Set<string>();
      let cursor = firstPage.nextCursor;
      while (cursor) {
        if (seenCursors.has(cursor)) throw new Error("执行记录分页重复，请重试。");
        seenCursors.add(cursor);
        const page = await listEpisodes(projectId, undefined, cursor);
        if (!mounted.current || request !== generation.current) return;
        runs.push(...page.items); cursor = page.nextCursor;
      }
      if (!mounted.current || request !== generation.current) return;
      const items = tasks.items.filter(item => item.projectId === projectId && !item.payload.archivedAt);
      const ownRuns = runs.filter(item => item.projectId === projectId);
      for (const [id, optimistic] of optimisticEpisodes.current) {
        const index = ownRuns.findIndex(item => item.id === id);
        if (index < 0) ownRuns.push(optimistic);
        else if (ownRuns[index].revision < optimistic.revision) ownRuns[index] = optimistic;
        else optimisticEpisodes.current.delete(id);
      }
      setAgendas(items); setEpisodes(ownRuns); setAvailable(tasks.available !== false); setError(null);
      setSelectedId(old => {
        if (old && items.some(item => item.id === old)) return old;
        const active = ownRuns.find(item => inFlight(item) && items.some(task => task.id === item.payload.agendaId));
        return active?.payload.agendaId ?? items[0]?.id ?? null;
      });
    } catch (caught) {
      if (mounted.current && request === generation.current) setError(`研究暂时无法载入：${productErrorMessage(caught)}`);
    } finally { if (request === generation.current) loadingTasks.current = false; }
  }, [projectId]);
  const loadLongFeature = useCallback(async () => {
    setLongFeature("loading");
    try { const catalogue = await listPlatformSkills(); if (mounted.current) setLongFeature(catalogue.items.some(item => item.id === "loopx:loopx") ? "enabled" : "disabled"); }
    catch { if (mounted.current) setLongFeature("error"); }
  }, []);
  const loadGoals = useCallback(async () => {
    if (loadingGoals.current) return;
    loadingGoals.current = true;
    try { const runs = await listWebAgentRuns({ projectId }); if (mounted.current) { setGoalRuns(runs); setGoalError(false); } }
    catch { if (mounted.current) setGoalError(true); }
    finally { loadingGoals.current = false; }
  }, [projectId]);
  const loadProgress = useCallback(async (force = false) => {
    if (!selectedId || (loadingProgress.current === selectedId && !force)) return;
    loadingProgress.current = selectedId;
    const request = ++progressGeneration.current;
    try {
      const value = await getResearchState(selectedId);
      if (mounted.current && request === progressGeneration.current && selectedRef.current === selectedId) { setProgress(value); setProgressError(null); }
    } catch (caught) {
      if (mounted.current && request === progressGeneration.current && selectedRef.current === selectedId) setProgressError(`研究资料暂时无法载入：${productErrorMessage(caught)}`);
    } finally { if (request === progressGeneration.current && loadingProgress.current === selectedId) loadingProgress.current = null; }
  }, [selectedId]);
  const loadHistory = useCallback(async (cursor?: string, force = false) => {
    if (!selectedId || (loadingHistory.current === selectedId && !force)) return;
    loadingHistory.current = selectedId;
    const request = ++historyGeneration.current;
    if (cursor) setHistoryBusy(true);
    try {
      const page = await listEpisodes(projectId, selectedId, cursor);
      if (!mounted.current || request !== historyGeneration.current || selectedRef.current !== selectedId) return;
      const items = page.items.filter(item => item.projectId === projectId && item.payload.agendaId === selectedId);
      setHistory(old => {
        const previous = old?.agendaId === selectedId ? old.items : [];
        const merged = cursor ? [...previous, ...items.filter(item => !previous.some(oldItem => oldItem.id === item.id))] : [...items.map(item => {
          const earlier = previous.find(oldItem => oldItem.id === item.id);
          return earlier && earlier.revision > item.revision ? earlier : item;
        }), ...previous.filter(item => !items.some(newItem => newItem.id === item.id))];
        return { agendaId: selectedId, items: merged, paged: Boolean(cursor) || (old?.agendaId === selectedId && old.paged), nextCursor: cursor ? page.nextCursor : old?.agendaId === selectedId && old.paged ? old.nextCursor : page.nextCursor };
      });
      setHistoryError(null);
    } catch (caught) {
      if (mounted.current && request === historyGeneration.current && selectedRef.current === selectedId) setHistoryError(`执行记录暂时无法载入：${productErrorMessage(caught)}`);
    } finally { if (request === historyGeneration.current && loadingHistory.current === selectedId) loadingHistory.current = null; if (mounted.current && request === historyGeneration.current) setHistoryBusy(false); }
  }, [projectId, selectedId]);
  useEffect(() => { const requests = generation; mounted.current = true; void load(); void loadGoals(); void loadLongFeature(); return () => { mounted.current = false; requests.current++; loadingTasks.current = false; }; }, [load, loadGoals, loadLongFeature]);
  // The database entry is offered only where the deployment has the connector; an unknown answer hides it.
  useEffect(() => { void researchDatabaseStatus(projectId).then(status => { if (mounted.current) setDatabaseAvailable(status.available === true); }).catch(() => {}); }, [projectId]);
  useEffect(() => { const progressRequests = progressGeneration; const historyRequests = historyGeneration; setProgress(null); setProgressError(null); setHistory(null); setHistoryError(null); setHistoryBusy(false); setSelectedEpisodeId(null); void loadProgress(); void loadHistory(); return () => { progressRequests.current++; historyRequests.current++; loadingProgress.current = null; loadingHistory.current = null; }; }, [loadProgress, loadHistory]);
  // A create intent restored by browser history or refresh has no live owner to accept its acknowledgement.
  // Never replay it automatically: the prior session may already have been created.
  useEffect(() => {
    const state = location.state && typeof location.state === "object" ? location.state : null;
    const intent = state?.runtimeUiIntent;
    if (!intent || typeof intent.requestId !== "string" || intent.requestId === pendingNativeIntent.current) return;
    if (intent.requestId !== acknowledgedNativeIntent.current) { setNativeSession(null); setNativePending(false); setNativeUncertain(true); }
    const next = { ...state }; delete next.runtimeUiIntent;
    navigate(location.pathname + location.search, { replace: true, state: next });
  }, [location, navigate]);
  const hasRunning = episodes.some(inFlight) || (goalRuns ?? []).some(run => run.status === "running" && run.automated === true);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden && !operating.current) { void load(); void loadGoals(); void loadProgress(); if (!historyBusy) void loadHistory(); } }, hasRunning ? 5_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [load, loadGoals, loadProgress, loadHistory, historyBusy, hasRunning]);

  const goals = observedResearchGoals(goalRuns ?? []);
  const goal = goals.find(item => item.key === selectedGoal) ?? null;
  const selected = !goal ? agendas?.find(item => item.id === selectedId) ?? null : null;
  const ownEpisodes = history?.agendaId === selectedId ? [...history.items].sort((a, b) => (b.payload.createdAt ?? "").localeCompare(a.payload.createdAt ?? "")) : [];
  const execution = ownEpisodes.find(item => item.id === selectedEpisodeId) ?? ownEpisodes[0] ?? null;
  const runningEpisode = selectedId ? episodes.find(item => item.payload.agendaId === selectedId && inFlight(item)) ?? ownEpisodes.find(inFlight) ?? null : null;
  const round = goal ? goal.rounds.find(item => item.id === selectedRound) ?? goal.latest : null;
  const liveSteer = runningEpisode?.payload.status === "running" && runningEpisode.payload.interactive === true && !!runningEpisode.payload.runId;

  const queue: QueueEntry[] = [
    ...goals.map(item => ({ key: `goal:${item.key}`, title: goalTitle(item), kind: "长期" as const,
      mode: (item.latest.status === "running" ? "running" : "done") as QueueMode,
      meta: item.latest.status === "running" ? `本轮 ${at(item.latest.startedAt)} 开始` : `最近一轮 ${at(item.latest.finishedAt ?? item.latest.startedAt)}` })),
    ...(agendas ?? []).map(item => {
      const last = latestRun(item.id, episodes);
      const schedule = scheduleOf(item);
      return { key: `agenda:${item.id}`, title: item.payload.title, kind: "定时" as const, mode: agendaMode(item, episodes),
        meta: [repeatLine(schedule), last ? `上次 ${at(last.payload.createdAt)}` : ""].filter(Boolean).join(" · ") };
    }),
  ].sort((a, b) => Number(b.mode === "running" || b.mode === "queued") - Number(a.mode === "running" || a.mode === "queued"));
  const queueSelected = goal ? `goal:${goal.key}` : selected ? `agenda:${selected.id}` : null;

  async function operation(action: () => Promise<unknown>) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setActionError(null); setActionNotice(null);
    try { await action(); if (mounted.current) await Promise.all([load(true), loadProgress(true), loadHistory(undefined, true)]); }
    catch (caught) { if (mounted.current) setActionError(caught instanceof MaterialInputError ? caught.message : productErrorMessage(caught)); }
    finally { operating.current = false; if (mounted.current) setBusy(false); }
  }
  const upload = () => { if (!selectedId) return; void operation(async () => {
    const target = selectedId;
    const current = () => mounted.current && getWebProjectId() === projectId && selectedRef.current === target;
    const files = (await pickFiles(KNOWLEDGE_BASE_ACCEPT));
    if (!current()) throw new Error("项目或研究已切换，请重新选择资料。");
    const { accepted, refused } = partitionKnowledgeBaseFiles(files);
    if (refused.length) throw new MaterialInputError(`部分文件无法添加：${refused.map(file => `${file.name}（${file.reason}）`).join("、")}`);
    if (!accepted.length) return;
    if (accepted.length > 10) throw new MaterialInputError("每次最多添加 10 份资料，请分批选择。");
    const names = await uploadFilesToWorkspace(accepted, "knowledge-base", "base", projectId, current);
    if (names.length !== accepted.length) throw new Error("上传未完成，请到知识库查看后重试。");
    const sha256 = await Promise.all(accepted.map(sha256Hex));
    if (!current()) throw new Error("项目或研究已切换，请重新选择资料。");
    try { await addAgendaMaterials(target, { sha256 }); }
    catch { throw new MaterialInputError("资料已上传到知识库，但没能加入本研究。请从知识库再选一次。"); }
  }); };
  const recordEpisode = (item: EpisodeRecord, agendaId: string) => {
    if (item.projectId !== projectId || item.payload.agendaId !== agendaId) throw new Error("执行记录与研究不一致。");
    if (!mounted.current) return;
    optimisticEpisodes.current.set(item.id, item);
    setEpisodes(old => [item, ...old.filter(entry => entry.id !== item.id)]);
    setHistory(old => old?.agendaId === agendaId ? { ...old, items: [item, ...old.items.filter(entry => entry.id !== item.id)] } : old);
  };
  const runNow = (agendaId: string) => void operation(async () => {
    const requestId = pendingRuns.current.get(agendaId) ?? crypto.randomUUID();
    pendingRuns.current.set(agendaId, requestId);
    const result = await runAgendaNow(agendaId, requestId);
    recordEpisode(result.episode, agendaId);
    pendingRuns.current.delete(agendaId);
  });
  const stopExecution = (agendaId: string, episodeId: string) => void operation(async () => {
    const requestId = pendingStops.current.get(episodeId) ?? crypto.randomUUID();
    pendingStops.current.set(episodeId, requestId);
    const result = await cancelEpisode(agendaId, episodeId, requestId);
    recordEpisode(result, agendaId);
    pendingStops.current.delete(episodeId);
  });
  const submitDirection = () => {
    if (!selected || !direction.trim()) return;
    const note = direction.trim();
    void operation(async () => {
      if (liveSteer && runningEpisode?.payload.runId) {
        try { await steerWebAgentRun(runningEpisode.payload.runId, note); }
        catch (caught) {
          if (caught instanceof WebApiError && caught.code === "agent_run_correction_limit") throw new MaterialInputError("这次执行的方向调整次数已用完，下次执行时再提。");
          if (caught instanceof WebApiError && caught.code === "agent_run_not_running") throw new MaterialInputError("这次执行刚刚结束，刷新后可以作为下一次执行的方向提交。");
          throw new MaterialInputError("没能确认方向是否送达，请先看实时动态，再决定是否重发。");
        }
        if (mounted.current) { setSteering(false); setDirection(""); setActionNotice("方向已送达，研究员会在下一步按此调整。"); }
        return;
      }
      const pending = pendingDirections.current.get(selected.id);
      const episodeId = execution?.id ?? null;
      const requestId = pending?.note === note && pending.episodeId === episodeId ? pending.requestId : crypto.randomUUID();
      pendingDirections.current.set(selected.id, { note, episodeId, requestId });
      const result = await followUpAgenda(selected.id, { requestId, note, ...(episodeId ? { episodeId } : {}) });
      if (result.episode) recordEpisode(result.episode, selected.id);
      pendingDirections.current.delete(selected.id);
      if (mounted.current) { setSteering(false); setDirection(""); setActionNotice(result.episode ? "已按新方向安排一次执行。" : "已记下，下一次执行会按这个方向进行。"); }
    });
  };
  const openFile = (path: string, runId: string) => { if (safeWorkspacePath(path) && SAFE_RUN.test(runId)) navigate(snapshotHref(runId, path)); };
  const clearNativeIntent = () => {
    const current = location.state && typeof location.state === "object" ? { ...location.state } : {};
    if (!("runtimeUiIntent" in current)) return;
    delete current.runtimeUiIntent;
    navigate(location.pathname + location.search, { replace: true, state: current });
  };
  const closeNative = () => { if (pendingNativeIntent.current) setNativeUncertain(true); pendingNativeIntent.current = null; setNativePending(false); setNativeSession(null); clearNativeIntent(); };
  const startLongResearch = () => {
    if (longFeature !== "enabled" || pendingNativeIntent.current) return;
    const intent = newRuntimeUiIntent("/loopx ");
    setNativeUncertain(false); pendingNativeIntent.current = intent.requestId; setNativePending(true);
    setNativeSession(intent.sessionId);
    const state = location.state && typeof location.state === "object" ? location.state : {};
    navigate(location.pathname + location.search, { replace: true, state: { ...state, runtimeUiIntent: intent } });
  };
  const openGoalConversation = (sessionId: string) => {
    pendingNativeIntent.current = null; setNativePending(false); clearNativeIntent(); setNativeSession(sessionId);
  };
  const onNativeAcknowledged = useCallback((requestId: string, sessionId: string) => {
    if (!mounted.current || pendingNativeIntent.current !== requestId) return;
    pendingNativeIntent.current = null; acknowledgedNativeIntent.current = requestId; setNativePending(false);
    setNativeSession(sessionId);
    const current = locationRef.current;
    const state = current.state && typeof current.state === "object" ? { ...current.state } : {};
    if (state.runtimeUiIntent?.requestId === requestId) {
      delete state.runtimeUiIntent;
      navigate(current.pathname + current.search, { replace: true, state });
    }
  }, [navigate]);
  const choose = (key: string) => {
    if (operating.current) return;
    closeNative(); setSelectedEpisodeId(null); setSelectedRound(null);
    if (key.startsWith("goal:")) { setSelectedGoal(key.slice(5)); return; }
    setSelectedGoal(null); setSelectedId(key.slice(7));
  };

  const loaded = agendas !== null;
  const nothing = loaded && !error && agendas.length === 0 && goals.length === 0;
  const runId = goal ? round?.id ?? null : execution?.payload.runId ?? null;
  const observedTitle = goal ? goalTitle(goal) : selected?.payload.title;
  const startButtons = <>
    <Button disabled={nativePending || longFeature !== "enabled"} onClick={startLongResearch}>新建长期研究</Button>
    <Button variant="secondary" disabled={!available} onClick={() => setEditor(true)}>新建定时研究</Button>
  </>;
  // The header says the same two things as an action plan (design system v3.2): the long research is the primary one.
  const startPlan: PageActionPlan = {
    primary: { id: "new-long", label: "新建长期研究", disabled: nativePending || longFeature !== "enabled", onSelect: startLongResearch },
    secondary: [{ id: "new-scheduled", label: "新建定时研究", disabled: !available, onSelect: () => setEditor(true) }],
  };

  // With nothing yet the empty state carries the two ways to start; the header does not repeat them.
  return <PageShell title="主动科研" width="wide" actionPlan={nothing && !nativeSession ? undefined : startPlan}><div className="space-y-6">
    {nativeUncertain && <p role="status" className="text-ui text-text">上次新建的长期研究可能已经创建，请先在对话列表里看一眼，再决定是否重新新建。</p>}
    {longFeature === "error" && <LoadError message="长期研究暂时无法使用。" onRetry={() => void loadLongFeature()} />}
    {longFeature === "disabled" && <p className="text-ui text-text">长期研究暂未开通，定时研究可以正常使用。</p>}
    {error && <LoadError message={error} onRetry={() => void load()} />}
    {goalError && <LoadError message="长期研究暂时无法载入。" onRetry={() => void loadGoals()} />}
    {!available && <p className="text-ui text-text">定时执行暂不可用，已有成果可以照常查看。</p>}
    {!loaded && !error && <div role="status" aria-label="正在载入研究" className="h-64 animate-pulse rounded-card bg-surface-2" />}
    {nothing && !nativeSession && <EmptyState icon={FlaskConical} titleAs="h2" title="让 AI 持续为你做研究"
      description={<><span className="block">长期研究：写下一个研究目标，AI 会检索、阅读、分析、撰写，一轮轮推进直到完成。</span><span className="mt-1 block">定时研究：按你设定的时间自动追踪一个问题，每次执行都会留下成果。</span></>}
      action={<div className="flex flex-wrap justify-center gap-2">{startButtons}</div>} />}
    {loaded && !nothing && <div>
      <ResearchQueue entries={queue} selected={queueSelected} disabled={busy} onSelect={choose} />
      <ResearchObservatory runId={runId} title={observedTitle} onOpenFile={openFile} />
    </div>}

    {selected && <section aria-label="当前研究" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h2 className="truncate text-section font-semibold text-text">{selected.payload.title}</h2>
          <p className="text-caption text-text-3">{execution ? `${runState(execution.payload)} · ${at(execution.payload.createdAt)}` : historyError ? "执行记录暂不可用" : history ? "还没有执行过" : "正在载入执行记录"}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {runningEpisode ? <Button variant="secondary" disabled={busy} onClick={() => stopExecution(selected.id, runningEpisode.id)}>停止本次</Button>
            : <Button variant="secondary" disabled={busy || !available || !activeAgenda(selected) || !history || !!historyError || history.agendaId !== selected.id} onClick={() => runNow(selected.id)}>立即执行</Button>}
          <Button variant="secondary" disabled={busy || !available || !activeAgenda(selected)} onClick={() => { setDirection(""); setSteering(true); }}>调整研究方向</Button>
          <Button variant="secondary" onClick={() => navigate(taskPath(selected.id))}>打开任务对话</Button>
        </div>
      </div>
      {actionError && !steering && <p role="alert" className="text-ui text-error">{actionError}</p>}
      {actionNotice && <p role="status" className="text-ui text-text">{actionNotice}</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        <ResultsPanel progress={progress?.agendaId === selectedId ? progress : null} files={ownEpisodes.flatMap(item => (item.payload.artifactRefs ?? [])
          .filter(ref => ref.projectId === projectId && ref.runId === item.payload.runId && ref.sessionId === item.payload.sessionId && SAFE_RUN.test(ref.runId) && safeWorkspacePath(ref.path))
          .map(ref => ({ runId: ref.runId, path: ref.path, at: item.payload.createdAt })))} />
        <ResearchDataPanel materials={progress?.agendaId === selectedId ? progress.materials : []} loading={!progress && !progressError} error={progressError} busy={busy} databaseAvailable={databaseAvailable} onUpload={upload} onPick={() => setPicking(true)} onDatabase={() => setDatabaseOpen(true)} onRemove={sourceId => void operation(() => removeAgendaMaterial(selected.id, sourceId))} onRetry={() => void loadProgress()} />
      </div>
      <section aria-label="执行记录" className="space-y-2">
        <h3 className="text-ui font-semibold text-text">执行记录</h3>
        {historyError && <LoadError message={historyError} onRetry={() => void loadHistory()} />}
        {!history && !historyError ? <p role="status" className="text-ui text-text-3">正在载入</p> : ownEpisodes.length === 0 ? (history ? <p className="text-ui text-text-3">还没有执行过</p> : null)
          : <List divided>{ownEpisodes.map(item => {
            const files = (item.payload.artifactRefs ?? []).filter(ref => ref.projectId === projectId && ref.runId === item.payload.runId && ref.sessionId === item.payload.sessionId && SAFE_RUN.test(ref.runId) && safeWorkspacePath(ref.path));
            return <ListRow key={item.id} title={`${runState(item.payload)} · ${at(item.payload.createdAt) || "时间未知"}`} selected={execution?.id === item.id} onOpen={() => setSelectedEpisodeId(item.id)}
              meta={files.length ? <span className="flex flex-wrap gap-x-3">{files.map(file => <Link key={`${file.runId}:${file.path}`} className="break-all text-accent underline" to={snapshotHref(file.runId, file.path)}>{file.path.split("/").pop()}</Link>)}</span> : undefined} />;
          })}</List>}
        {history?.nextCursor && <Button variant="text" disabled={historyBusy} onClick={() => void loadHistory(history.nextCursor ?? undefined)}>查看更早记录</Button>}
      </section>
    </section>}

    {goal && <GoalWorkbench goal={goal} round={round} projectId={projectId} busy={busy} onRound={setSelectedRound} onOpenConversation={() => openGoalConversation(goal.sessionId)} />}
    {nativeSession && <NativeResearchPane key={`${projectId}:${nativeSession}`} projectId={projectId} sessionId={nativeSession} onAcknowledged={onNativeAcknowledged} onClose={closeNative} />}

    {steering && selected && <FormDialog title="调整研究方向" busy={busy} onClose={() => { if (!busy) setSteering(false); }}><div className="space-y-4">
      <Textarea label="希望研究如何调整" value={direction} maxLength={4000} onChange={event => setDirection(event.target.value)} />
      <p className="text-ui text-text">{liveSteer ? "研究正在进行，研究员会在下一步按这个方向调整。" : "这条方向会用在下一次执行，不会改变当前执行。"}</p>
      {actionError && <p role="alert" className="text-ui text-error">{actionError}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setSteering(false)}>取消</Button><Button disabled={busy || !direction.trim()} onClick={submitDirection}>提交方向</Button></div>
    </div></FormDialog>}
    {databaseOpen && selected && <ResearchDatabaseDialog key={`${projectId}:${selected.id}`} projectId={projectId} agendaId={selected.id} onClose={() => setDatabaseOpen(false)} onCaptured={() => { void load(true); void loadProgress(true); }} />}
    {picking && selected && <FormDialog title="从知识库添加资料" busy={busy} onClose={() => { if (!busy) setPicking(false); }}><MaterialPicker projectId={projectId} taken={(selected.payload.materials ?? []).map(item => item.sourceId)} busy={busy} onCancel={() => setPicking(false)} onChoose={sourceIds => { setPicking(false); void operation(() => addAgendaMaterials(selected.id, { sourceIds })); }} /></FormDialog>}
    {editor && <NewScheduledResearchDialog projectId={projectId} available={available} saving={editorSaving} onBusyChange={setEditorSaving} onClose={() => setEditor(false)}
      onRecorded={record => { setSelectedGoal(null); setSelectedId(record.id); void load(); }}
      onSaved={record => { setEditor(false); setSelectedGoal(null); setSelectedId(record.id); void load(); }} />}
  </div></PageShell>;
}

/**
 * 「新建定时研究」: what to keep doing, and how often, made in place so the new research is the one the console shows. The scheduled-tasks
 * page makes a task in its main area (`NewTaskPane`); this is the same form (`TaskForm`) in a short dialog over the console, without the
 * examples and opportunities that page keeps beside it.
 */
function NewScheduledResearchDialog({ projectId, available, saving, onBusyChange, onClose, onRecorded, onSaved }: {
  projectId: string; available: boolean; saving: boolean; onBusyChange: (busy: boolean) => void; onClose: () => void;
  onRecorded: (record: AgendaRecord) => void; onSaved: (record: AgendaRecord) => void;
}) {
  const [dirty, setDirty] = useState(false);
  return <FormDialog title="新建定时研究" busy={saving} dirty={dirty} onClose={() => { if (!saving) onClose(); }}>
    {(requestClose, markSaved) => <TaskForm projectId={projectId} showBudgets={false} schedulingAvailable={available}
      onRecorded={record => { markSaved(); onRecorded(record); }} onBusyChange={onBusyChange} onDirtyChange={setDirty} onCancel={requestClose}
      onSaved={record => { markSaved(); onSaved(record); }} />}
  </FormDialog>;
}

/** What the research has produced: its findings with how each was checked, and every file its executions handed over. */
function ResultsPanel({ progress, files }: { progress: ResearchState | null; files: Array<{ runId: string; path: string; at?: string }> }) {
  const found = progress?.found ?? [];
  const open = progress?.unresolved.length ?? 0;
  return <section aria-label="研究成果" className="space-y-3">
    <div className="flex items-baseline justify-between gap-2"><h3 className="text-ui font-semibold text-text">研究成果</h3>{open > 0 && <span className="text-caption text-text-3">{open} 个问题待解决</span>}</div>
    {found.length === 0 && files.length === 0 ? <p className="text-ui text-text">执行完成后，研究发现和产出文件会出现在这里。</p> : <>
      {found.length > 0 && <ul className="space-y-2" aria-label="研究发现">{found.map(item => <li key={`${item.date}:${item.statement}`} className="flex items-start gap-2 text-ui text-text">
        <Tag tone={FOUND_TAG[item.check].tone}>{FOUND_TAG[item.check].label}</Tag><span className="min-w-0 flex-1 leading-relaxed">{item.statement}</span>
      </li>)}</ul>}
      {files.length > 0 && <ul className="space-y-1" aria-label="研究文件">{files.map(file => <li key={`${file.runId}:${file.path}`} className="flex items-baseline justify-between gap-3">
        <Link className="min-w-0 truncate text-ui text-accent underline" to={snapshotHref(file.runId, file.path)}>{file.path.split("/").pop()}</Link>
        {file.at && <span className="shrink-0 text-caption text-text-3">{at(file.at)}</span>}
      </li>)}</ul>}
    </>}
  </section>;
}

/** A long goal: its rounds, the files they handed over, and its own conversation. */
function GoalWorkbench({ goal, round, projectId, busy, onRound, onOpenConversation }: { goal: ObservedResearchGoal; round: WebAgentRun | null; projectId: string; busy: boolean; onRound: (id: string) => void; onOpenConversation: () => void }) {
  const files = goal.rounds.flatMap(run => SAFE_RUN.test(run.id) ? [...new Set([...(run.outputFiles ?? []), ...(run.presentedFiles ?? [])])].filter(path => safeWorkspacePath(path)).map(path => ({ runId: run.id, path, at: run.finishedAt ?? run.startedAt })) : []);
  return <section aria-label="长期研究" className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><h2 className="truncate text-section font-semibold text-text">{goalTitle(goal)}</h2><p className="text-caption text-text-3">长期研究 · 已推进 {goal.rounds.length} 轮</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={onOpenConversation}>在本页打开对话</Button>
        <Link className="text-ui text-accent underline" to={scopedConversationPath(chatPath(goal.sessionId), projectId)}>打开所属对话</Link>
      </div>
    </div>
    <div className="grid gap-6 lg:grid-cols-2">
      <ResultsPanel progress={null} files={files} />
      <section aria-label="推进记录" className="space-y-2">
        <h3 className="text-ui font-semibold text-text">推进记录</h3>
        <List divided>{goal.rounds.map((run, index) => <ListRow key={run.id} title={`第 ${goal.rounds.length - index} 轮 · ${run.status === "running" ? "进行中" : run.status === "succeeded" ? "已完成" : run.status === "failed" ? "未完成" : "已结束"}`}
          trailing={<span className="text-caption text-text-3">{at(run.startedAt)}</span>} selected={round?.id === run.id} onOpen={busy ? undefined : () => onRound(run.id)} />)}</List>
      </section>
    </div>
  </section>;
}

/** The shell's resident native conversation, placed inside this page without creating another composer. */
function NativeResearchPane({ projectId, sessionId, onAcknowledged, onClose }: { projectId: string; sessionId: string; onAcknowledged: (requestId: string, sessionId: string) => void; onClose: () => void }) {
  const pane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element) return undefined;
    const withdraw = registerTaskPane({ element, projectId, sessionId, onSessionAcknowledged: onAcknowledged });
    element.scrollIntoView?.({ block: "start" });
    return withdraw;
  }, [projectId, sessionId, onAcknowledged]);
  return <section aria-label="长期研究对话" className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-ui font-semibold text-text">长期研究对话</h2><Button variant="secondary" onClick={onClose}>收起对话</Button></div>
    <p className="text-ui text-text">写下研究目标后发送，AI 会一轮轮推进，直到目标完成。</p>
    <div ref={pane} role="region" aria-label="原生研究对话" className="relative min-h-screen" />
  </section>;
}
