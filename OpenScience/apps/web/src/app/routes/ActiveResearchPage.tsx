import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { getWebProjectId, listWebAgentRuns, steerWebAgentRun, WebApiError, type WebAgentRun } from "@/lib/apiClient";
import { addAgendaMaterials, cancelEpisode, followUpAgenda, getResearchState, listAgendas, listEpisodes, removeAgendaMaterial, runAgendaNow, type AgendaRecord, type EpisodeRecord, type ResearchState } from "@/lib/autopilotClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { safeWorkspacePath } from "@/lib/claimCitations";
import { sha256Hex } from "@/lib/fileDigest";
import { formatDay, formatClock } from "@/lib/format";
import { KNOWLEDGE_BASE_ACCEPT, partitionKnowledgeBaseFiles } from "@/lib/knowledgeBaseFiles";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { observedResearchGoals } from "@/lib/observedResearchGoals";
import { chatPath } from "@/lib/runLocation";
import { newRuntimeUiIntent, scopedConversationPath } from "@/lib/runtimeUiNavigation";
import { registerTaskPane } from "@/lib/taskPane";
import { snapshotHref } from "@/lib/readPages";
import { listPlatformSkills } from "@/lib/skillLibraryClient";
import { taskPath } from "@/lib/taskLocation";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { List } from "@/components/ui/ListRow";
import { MaterialPicker } from "@/components/autopilot/MaterialPicker";
import { ResearchDatabaseDialog } from "@/components/autopilot/ResearchDatabaseDialog";
import { ResearchDataPanel } from "@/components/autopilot/ResearchDataPanel";
import { ResearchObservatory } from "@/components/autopilot/ResearchObservatory";
import { TaskDialog } from "@/components/autopilot/TaskDialog";
import { activeAgenda, inFlight, latestRun, runState } from "@/components/autopilot/taskPresentation";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Textarea } from "@/components/ui/Input";

class MaterialInputError extends Error {}

/** A project-scoped view of the researcher's scheduled work and observed executions. */
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
      if (mounted.current && request === generation.current) setError(`研究任务暂不可用：${productErrorMessage(caught)}`);
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
      if (mounted.current && request === progressGeneration.current && selectedRef.current === selectedId) setProgressError(`研究资料暂不可用：${productErrorMessage(caught)}`);
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
      if (mounted.current && request === historyGeneration.current && selectedRef.current === selectedId) setHistoryError(`执行记录暂不可用：${productErrorMessage(caught)}`);
    } finally { if (request === historyGeneration.current && loadingHistory.current === selectedId) loadingHistory.current = null; if (mounted.current && request === historyGeneration.current) setHistoryBusy(false); }
  }, [projectId, selectedId]);
  useEffect(() => { const requests = generation; mounted.current = true; void load(); void loadGoals(); void loadLongFeature(); return () => { mounted.current = false; requests.current++; loadingTasks.current = false; }; }, [load, loadGoals, loadLongFeature]);
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
  const active = agendas?.filter(item => episodes.some(run => run.payload.agendaId === item.id && inFlight(run))) ?? [];
  const completed = agendas?.filter(item => !active.includes(item) && latestRun(item.id, episodes)?.payload.status === "merged") ?? [];
  const others = agendas?.filter(item => !active.includes(item) && !completed.includes(item)) ?? [];

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
    if (!current()) throw new Error("项目或任务已变化，请重新选择资料。");
    const { accepted, refused } = partitionKnowledgeBaseFiles(files);
    if (refused.length) throw new MaterialInputError(`部分文件无法添加：${refused.map(file => `${file.name}（${file.reason}）`).join("、")}`);
    if (!accepted.length) return;
    if (accepted.length > 10) throw new MaterialInputError("每次最多添加 10 份资料，请分批选择。");
    const names = await uploadFilesToWorkspace(accepted, "knowledge-base", "base", projectId, current);
    if (names.length !== accepted.length) throw new Error("上传未完成，请检查知识库后重试。");
    const sha256 = await Promise.all(accepted.map(sha256Hex));
    if (!current()) throw new Error("项目或任务已变化，请重新选择资料。");
    try { await addAgendaMaterials(target, { sha256 }); }
    catch { throw new MaterialInputError("资料已上传到知识库，但未能关联本研究。请检查资料列表后重试关联。"); }
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
      if (runningEpisode?.payload.status === "running" && runningEpisode.payload.interactive === true && runningEpisode.payload.runId) {
        try { await steerWebAgentRun(runningEpisode.payload.runId, note); }
        catch (caught) {
          if (caught instanceof WebApiError && caught.code === "agent_run_correction_limit") throw new MaterialInputError("本次执行的方向调整次数已用完。");
          if (caught instanceof WebApiError && caught.code === "agent_run_not_running") throw new MaterialInputError("本次执行已结束，请刷新后提交后续研究方向。");
          throw new MaterialInputError("方向提交结果未确认，请先查看当前执行记录，再决定是否重试。");
        }
        if (mounted.current) { setSteering(false); setDirection(""); setActionNotice("方向已送入当前执行，将在下一个执行边界处理。"); }
        return;
      }
      const pending = pendingDirections.current.get(selected.id);
      const episodeId = execution?.id ?? null;
      const requestId = pending?.note === note && pending.episodeId === episodeId ? pending.requestId : crypto.randomUUID();
      pendingDirections.current.set(selected.id, { note, episodeId, requestId });
      const result = await followUpAgenda(selected.id, { requestId, note, ...(episodeId ? { episodeId } : {}) });
      if (result.episode) recordEpisode(result.episode, selected.id);
      pendingDirections.current.delete(selected.id);
      if (mounted.current) { setSteering(false); setDirection(""); setActionNotice(result.episode ? "研究方向已提交，已安排后续执行。" : "已处理研究方向，没有创建新的执行。" ); }
    });
  };
  const openFile = (path: string, runId: string) => { if (safeWorkspacePath(path) && /^[A-Za-z0-9_-]{1,160}$/.test(runId)) navigate(snapshotHref(runId, path)); };
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
  const choose = (id: string) => { if (operating.current) return; closeNative(); setSelectedGoal(null); setSelectedId(id); setSelectedEpisodeId(null); };
  const renderRows = (items: AgendaRecord[]) => <List divided>{items.map(item => {
    const run = episodes.find(record => record.payload.agendaId === item.id && inFlight(record)) ?? latestRun(item.id, episodes);
    return <li key={item.id} className="flex flex-wrap items-center gap-3 py-3"><button type="button" className="min-w-0 flex-1 text-left text-ui font-semibold text-text" aria-pressed={selectedId === item.id} disabled={busy} onClick={() => choose(item.id)}>{item.payload.title}</button><span className="text-caption text-text-3">{run ? runState(run.payload) : "未显示近期执行记录"}</span><Link className="text-caption text-accent" to={taskPath(item.id)}>打开任务</Link></li>;
  })}</List>;
  return <PageShell title="主动科研" width="wide" actions={<><Button disabled={nativePending || longFeature !== "enabled"} onClick={startLongResearch}>新增长期研究</Button><Button variant="secondary" disabled={!available} onClick={() => setEditor(true)}>新建定时研究</Button></>}><div className="space-y-6">
    {nativeUncertain && <p role="status" className="text-ui text-text">上一次长期研究对话的创建结果尚不明确，请先在对话列表检查，再决定是否新建。</p>}
    {longFeature === "error" && <LoadError message="长期研究能力状态暂不可用。" onRetry={() => void loadLongFeature()} />}
    {longFeature === "disabled" && <p className="text-ui text-text">当前环境未启用长期研究，已有记录仍可查看。</p>}
    {error && <LoadError message={error} onRetry={() => void load()} />}
    {agendas === null && !error && <p role="status" className="text-ui text-text-3">正在加载研究任务</p>}
    {!available && <p className="text-ui text-text">定时执行暂不可用，已有结果仍可查看。</p>}
    {goal && <section className="space-y-4" aria-label="长期目标续跑"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-body font-semibold text-text">长期目标的续跑记录</h2><p className="text-ui text-text">这里只显示最近一次观察到的执行，目标当前状态可能不同。</p></div><Button variant="secondary" onClick={() => openGoalConversation(goal.sessionId)}>在本页打开对话</Button></div><ResearchObservatory runId={goal.latest.id} onOpenFile={openFile} /></section>}
    {selected && <section className="space-y-4" aria-label="当前研究"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-body font-semibold text-text">{selected.payload.title}</h2><p className="text-caption text-text-3">{execution ? runState(execution.payload) : historyError ? "执行记录暂不可用" : history ? "尚无执行记录" : "正在加载执行记录"}</p></div><div className="flex gap-2">{runningEpisode ? <Button variant="secondary" disabled={busy} onClick={() => stopExecution(selected.id, runningEpisode.id)}>停止本次</Button> : <Button variant="secondary" disabled={busy || !available || !activeAgenda(selected) || !history || !!historyError || history.agendaId !== selected.id} onClick={() => runNow(selected.id)}>立即执行</Button>}<Button variant="text" disabled={busy || !available || !activeAgenda(selected)} onClick={() => { setDirection(""); setSteering(true); }}>提出研究方向</Button><Link className="text-ui text-accent" to={taskPath(selected.id)}>打开任务对话</Link></div></div>
      <ResearchObservatory runId={execution?.payload.runId ?? null} onOpenFile={openFile} />
      <ResearchDataPanel materials={progress?.agendaId === selectedId ? progress.materials : []} loading={!progress && !progressError} error={progressError} busy={busy} onUpload={upload} onPick={() => setPicking(true)} onDatabase={() => setDatabaseOpen(true)} onRemove={sourceId => void operation(() => removeAgendaMaterial(selected.id, sourceId))} onRetry={() => void loadProgress()} />
      <section aria-label="研究成果" className="space-y-2"><h3 className="text-body font-semibold text-text">研究成果与执行记录</h3>{historyError && <LoadError message={historyError} onRetry={() => void loadHistory()} />}{!history && !historyError ? <p role="status" className="text-ui text-text-3">正在加载执行记录</p> : ownEpisodes.length === 0 ? (history ? <p className="text-ui text-text-3">尚无执行记录</p> : null) : <List divided>{ownEpisodes.map(item => {
        const files = (item.payload.artifactRefs ?? []).filter(ref => ref.projectId === projectId && ref.runId === item.payload.runId && ref.sessionId === item.payload.sessionId && /^[A-Za-z0-9_-]{1,160}$/.test(ref.runId) && safeWorkspacePath(ref.path));
        return <li key={item.id} className="space-y-1 py-3"><button type="button" className="text-left text-ui font-semibold text-text" aria-pressed={execution?.id === item.id} onClick={() => setSelectedEpisodeId(item.id)}>{runState(item.payload)} · {[formatDay(item.payload.createdAt), formatClock(item.payload.createdAt)].filter(Boolean).join(" ") || "时间未知"}</button><div className="flex flex-wrap gap-x-4 gap-y-1">{files.map(file => <Link key={`${file.runId}:${file.path}`} className="break-all text-caption text-accent" to={snapshotHref(file.runId, file.path)}>{file.path.split("/").pop()}</Link>)}</div></li>;
      })}</List>}{history?.nextCursor && <Button variant="text" disabled={historyBusy} onClick={() => void loadHistory(history.nextCursor ?? undefined)}>查看更早记录</Button>}</section>
    </section>}
    {nativeSession && <NativeResearchPane key={`${projectId}:${nativeSession}`} projectId={projectId} sessionId={nativeSession} onAcknowledged={onNativeAcknowledged} onClose={closeNative} />}
    {actionError && !steering && <p role="alert" className="text-ui text-error">{actionError}</p>}
    {actionNotice && <p role="status" className="text-ui text-text">{actionNotice}</p>}
    {goalError && <LoadError message="长期目标续跑记录暂不可用。" onRetry={() => void loadGoals()} />}
    {goals.length > 0 && <section aria-label="长期目标续跑记录" className="space-y-2"><h2 className="text-body font-semibold text-text">长期目标续跑记录</h2><p className="text-ui text-text">这里只包含已观察到的自动续跑，不能代表全部长期目标。</p><List divided>{goals.map((item, index) => <li key={item.key} className="flex flex-wrap items-center gap-3 py-3"><Button variant="text" disabled={busy} aria-pressed={goal?.key === item.key} onClick={() => { closeNative(); setSelectedGoal(item.key); }}>查看续跑 {index + 1} · {formatDay(item.latest.startedAt)} {formatClock(item.latest.startedAt)}</Button><span className="min-w-0 flex-1 break-words text-caption text-text-2">本次记录：{item.latest.question || item.latest.title || "问题未知"}</span><span className="text-caption text-text-3">{item.latest.status === "running" ? "本次执行中" : item.latest.status === "succeeded" ? "本次已结束" : "本次状态见详情"}</span><Link className="text-caption text-accent" to={scopedConversationPath(chatPath(item.sessionId), projectId)}>打开所属对话</Link></li>)}</List></section>}
    {agendas !== null && <section aria-label="研究任务列表" className="space-y-4"><div><h2 className="text-body font-semibold text-text">执行中 · {active.length}</h2>{active.length ? renderRows(active) : <p className="text-ui text-text-3">目前没有执行中的任务</p>}</div><div><h2 className="text-body font-semibold text-text">已完成 · {completed.length}</h2>{completed.length ? renderRows(completed) : <p className="text-ui text-text-3">暂无已完成任务</p>}</div>{others.length > 0 && <div><h2 className="text-body font-semibold text-text">待执行与未完成 · {others.length}</h2>{renderRows(others)}</div>}</section>}
    {steering && selected && <FormDialog title="提出研究方向" busy={busy} onClose={() => { if (!busy) setSteering(false); }}><div className="space-y-4"><Textarea label="希望研究如何调整" value={direction} maxLength={4000} onChange={event => setDirection(event.target.value)} /><p className="text-ui text-text">{runningEpisode?.payload.status === "running" && runningEpisode.payload.interactive === true && runningEpisode.payload.runId ? "将送入当前执行，在下一个执行边界处理。" : "系统将处理这条补充；可能安排后续执行或暂停任务，不会改变当前执行。"}</p>{actionError && <p role="alert" className="text-ui text-error">{actionError}</p>}<div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setSteering(false)}>取消</Button><Button disabled={busy || !direction.trim()} onClick={submitDirection}>提交方向</Button></div></div></FormDialog>}
    {databaseOpen && selected && <ResearchDatabaseDialog key={`${projectId}:${selected.id}`} projectId={projectId} agendaId={selected.id} onClose={() => setDatabaseOpen(false)} onCaptured={() => { void load(true); void loadProgress(true); }} />}
    {picking && selected && <FormDialog title="从知识库添加资料" busy={busy} onClose={() => { if (!busy) setPicking(false); }}><MaterialPicker projectId={projectId} taken={(selected.payload.materials ?? []).map(item => item.sourceId)} busy={busy} onCancel={() => setPicking(false)} onChoose={sourceIds => { setPicking(false); void operation(() => addAgendaMaterials(selected.id, { sourceIds })); }} /></FormDialog>}
    {editor && <TaskDialog projectId={projectId} available={available} showBudgets={false} saving={editorSaving} onBusyChange={setEditorSaving} onClose={() => setEditor(false)} onRecorded={record => { setSelectedId(record.id); void load(); }} onSaved={record => { setEditor(false); setSelectedId(record.id); void load(); }} onAdopted={id => { setEditor(false); setSelectedId(id); void load(); }} />}
  </div></PageShell>;
}

/** The shell's existing resident native conversation, placed inside this page without creating another composer. */
function NativeResearchPane({ projectId, sessionId, onAcknowledged, onClose }: { projectId: string; sessionId: string; onAcknowledged: (requestId: string, sessionId: string) => void; onClose: () => void }) {
  const pane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element) return undefined;
    const withdraw = registerTaskPane({ element, projectId, sessionId, onSessionAcknowledged: onAcknowledged });
    element.scrollIntoView?.({ block: "start" });
    return withdraw;
  }, [projectId, sessionId, onAcknowledged]);
  return <section aria-label="长期研究对话" className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-body font-semibold text-text">长期研究对话</h2><Button variant="secondary" onClick={onClose}>收起对话</Button></div><p className="text-ui text-text">输入研究目标，并使用长任务控件启动或暂停。</p><div ref={pane} role="region" aria-label="原生研究对话" className="relative min-h-screen" /></section>;
}
