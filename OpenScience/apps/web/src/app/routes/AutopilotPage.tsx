import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { CalendarClock } from "lucide-react";
import { AUTOPILOT_BUDGET_ERROR_CODES } from "@evimed/domain";
import { getWebProjectId, listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { addAgendaMaterials, archiveAgenda, cancelEpisode, getDigest, getResearchState, listAgendas, listEpisodes, markDigestOpened, removeAgendaMaterial, runAgendaNow, startAgenda, stopAgenda, type AgendaRecord, type EpisodeRecord, type ResearchState } from "@/lib/autopilotClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { safeWorkspacePath } from "@/lib/claimCitations";
import { sha256Hex } from "@/lib/fileDigest";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectLabels } from "@/lib/projectNames";
import { useProjectStore } from "@/lib/projects";
import { snapshotHref } from "@/lib/readPages";
import { splitArtifacts } from "@/lib/artifactNames";
import { taskPath } from "@/lib/taskLocation";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { FormDialog } from "@/components/ui/FormDialog";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageTitle } from "@/components/layout/PageTitle";
import { MaterialPicker } from "@/components/autopilot/MaterialPicker";
import { ResearchProgress } from "@/components/autopilot/ResearchProgress";
import { TaskBar } from "@/components/autopilot/TaskBar";
import { TaskDialog } from "@/components/autopilot/TaskDialog";
import { TaskList, type TaskRowActions } from "@/components/autopilot/TaskList";
import { boundedLock, TaskPane } from "@/components/autopilot/TaskPane";
import { activeAgenda, budgetBlocks, executionsOf, inFlight, inLingdou, latestRun, lastRunLine, needsMaterial, revisionConflict } from "@/components/autopilot/taskPresentation";
import { KNOWLEDGE_BASE_ACCEPT, KNOWLEDGE_BASE_UPLOAD_HINT, partitionKnowledgeBaseFiles } from "@/lib/knowledgeBaseFiles";

/** Where an upload lands: the project's knowledge base, which registers it as a source. */
const KNOWLEDGE_ROOT = "knowledge-base";

/**
 * The list column beside a task is this wide, and the conversation next to it is never narrower than `PANE_MIN`: the kernel's
 * composer holds an attachment button, a model choice and a send key, and below about this width it does not fit. The two together
 * are what the page's own content area must offer for the columns to sit side by side — measured on the page, not on the window,
 * because the shell's sidebar takes up to 340 px of it. Narrower, the list is the page and a row opens the task.
 */
const LIST_COLUMN = 300;
const PANE_MIN = 640;

/** How often the page reads the project again: quickly while an execution is on its way, quietly otherwise. */
const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 30_000;

type Action = { kind: "pause" | "archive" | "resume" | "run" | "stop-run" | "material"; agenda: AgendaRecord; requestId?: string; episode?: EpisodeRecord; sourceIds?: string[]; remove?: string };

/** `/app/autopilot` (the list) and `/app/autopilot/:taskId` (one task); the old `?task=` address becomes the second. */
export function AutopilotPage() {
  useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  const [params] = useSearchParams();
  const { taskId } = useParams();
  const legacy = params.get("task");
  if (legacy && !taskId) return <Navigate to={taskPath(legacy, { search: params.get("q") ?? "" })} replace />;
  return <ProjectAutopilotPage key={projectId} projectId={projectId} />;
}

function ProjectAutopilotPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  // The page follows the sidebar's project and says which: plain text, not a second selector with a different meaning. It is the
  // label every picker uses (`projectLabels`), so two projects of one name are told apart here as they are in the sidebar.
  const projectName = useProjectLabels().get(projectId);
  const [params, setParams] = useSearchParams();
  const { taskId } = useParams();
  const selectedId = taskId ?? null;
  const digestId = params.get("digest");
  const executionParam = params.get("execution");
  const urlSearch = params.get("q") ?? "";
  const [search, setSearch] = useState(urlSearch);
  const [agendas, setAgendas] = useState<AgendaRecord[] | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [taskEpisodes, setTaskEpisodes] = useState<{ agendaId: string; items: EpisodeRecord[] } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ agendaId: string; value: ResearchState } | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [ledger, setLedger] = useState<WebAgentRun[]>([]);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retry, setRetry] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editor, setEditor] = useState<{ agenda?: AgendaRecord } | null>(null);
  const [busy, setBusy] = useState(false);
  // The task a spent budget refused: its caps are the one thing the edit dialog then offers beside the rest (`budgetBlocks`).
  const [budgetRefused, setBudgetRefused] = useState<string | null>(null);
  const [refreshCycle, setRefreshCycle] = useState(0);
  const [width, setWidth] = useState(0);
  const live = useRef(true);
  const generation = useRef(0);
  const historyGeneration = useRef(0);
  const progressGeneration = useRef(0);
  const operating = useRef(false);
  const selection = useRef(selectedId); selection.current = selectedId;
  const searchNow = useRef(search); searchNow.current = search;
  const layout = useRef<HTMLDivElement>(null);

  // Beside the list or instead of it, by what the page itself has room for.
  useLayoutEffect(() => {
    const element = layout.current;
    if (!element) return undefined;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(entries => {
      const next = entries[entries.length - 1]?.contentRect.width;
      if (typeof next === "number") setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const split = width >= LIST_COLUMN + PANE_MIN;
  const showList = split || !selectedId;
  const showMain = split || Boolean(selectedId);

  // The search is the address's `q`; Back and Forward bring the earlier text back.
  useEffect(() => { setSearch(urlSearch); }, [urlSearch]);
  const onSearch = (value: string) => {
    setSearch(value);
    setParams(current => { const next = new URLSearchParams(current); if (value) next.set("q", value); else next.delete("q"); return next; }, { replace: true });
  };

  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const [tasks, runs] = await Promise.all([listAgendas(projectId), listEpisodes(projectId)]);
      if (!live.current || request !== generation.current) return;
      setAgendas(tasks.items); setEpisodes(runs.items); setError(null);
    } catch (caught) {
      if (live.current && request === generation.current) { setError(`定时任务暂不可用：${productErrorMessage(caught)}`); setAgendas(current => current ?? []); }
    }
  }, [projectId]);
  useEffect(() => { const requests = generation; live.current = true; void load(); return () => { live.current = false; requests.current++; }; }, [load]);
  useEffect(() => { setActionError(null); setRetry(null); setProgressOpen(false); }, [selectedId]);

  // The selected task's own executions: the project-wide newest hundred may not reach back to an old task.
  const loadHistory = useCallback(async () => {
    if (!selectedId || selectedId !== selection.current) return;
    const request = ++historyGeneration.current;
    try {
      const page = await listEpisodes(projectId, selectedId);
      if (live.current && selectedId === selection.current && request === historyGeneration.current) { setTaskEpisodes({ agendaId: selectedId, items: page.items }); setHistoryError(null); }
    } catch (caught) {
      if (live.current && selectedId === selection.current && request === historyGeneration.current) setHistoryError(`任务记录暂不可用：${productErrorMessage(caught)}`);
    }
  }, [projectId, selectedId]);
  useEffect(() => {
    const requests = historyGeneration;
    setHistoryError(null); setTaskEpisodes(null); void loadHistory();
    return () => { requests.current++; };
  }, [loadHistory]);
  // What was found, what is unresolved and the material added: a record, read when the drawer is opened and while it is.
  const loadProgress = useCallback(async () => {
    if (!selectedId || selectedId !== selection.current) return;
    const request = ++progressGeneration.current;
    try {
      const value = await getResearchState(selectedId);
      if (live.current && selectedId === selection.current && request === progressGeneration.current) { setProgress({ agendaId: selectedId, value }); setProgressError(null); }
    } catch (caught) {
      if (live.current && selectedId === selection.current && request === progressGeneration.current) setProgressError(`研究进展暂不可用：${productErrorMessage(caught)}`);
    }
  }, [selectedId]);
  useEffect(() => {
    const requests = progressGeneration;
    setProgressError(null); setProgress(null);
    if (progressOpen) void loadProgress();
    return () => { requests.current++; };
  }, [loadProgress, progressOpen]);

  const researchState = progress?.agendaId === selectedId ? progress.value : null;
  const selectedEpisodes = taskEpisodes?.agendaId === selectedId ? taskEpisodes.items : null;
  const selected = agendas?.find(agenda => agenda.id === selectedId);
  const everyEpisode = [...episodes, ...(selectedEpisodes ?? [])];
  const pending = everyEpisode.some(inFlight);
  // A bounded runtime holds the whole project while it runs: no conversation of it opens until it ends.
  const lock = boundedLock(everyEpisode);
  const lockRunId = lock?.payload.agendaId === selectedId ? lock?.payload.runId ?? null : null;
  const lockRunRef = useRef<string | null>(null); lockRunRef.current = lockRunId;
  // The run ledger's account of that execution: what it has done so far, which is all there is to show until it ends.
  const loadLedger = useCallback(async () => {
    if (!lockRunRef.current) return;
    try {
      const runs = await listWebAgentRuns({ projectId });
      if (live.current) setLedger(runs);
    } catch { /* The progress is a nicety; the execution itself does not wait on it. */ }
  }, [projectId]);
  useEffect(() => { if (lockRunId) void loadLedger(); }, [lockRunId, loadLedger]);
  const ledgerRun = lockRunId ? ledger.find(run => run.id === lockRunId) ?? null : null;

  // The page keeps reading for as long as it is open: every few seconds while an execution is on its way, every half minute
  // otherwise, and not at all while the document is hidden (it reads at once when the tab is back). It never gives up: an
  // execution can run for two hours.
  const refresh = useRef<() => Promise<unknown>>(async () => undefined);
  refresh.current = () => Promise.all([load(), loadHistory(), progressOpen ? loadProgress() : undefined, loadLedger()]);
  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delay = pending ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    const tick = async () => {
      timer = undefined;
      if (canceled) return;
      if (!document.hidden && !operating.current) await refresh.current();
      if (canceled) return;
      timer = setTimeout(() => void tick(), delay);
    };
    const returned = () => { if (!document.hidden && timer !== undefined) { clearTimeout(timer); void tick(); } };
    timer = setTimeout(() => void tick(), delay);
    document.addEventListener("visibilitychange", returned);
    return () => { canceled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", returned); };
  }, [pending, refreshCycle]);

  // A briefing's address (the inbox, the Feishu card) opens the task it belongs to with that execution selected. A briefing of another
  // project opens that execution's conversation there, as it always has.
  useEffect(() => {
    if (!digestId) return undefined;
    let active = true;
    void (async () => {
      try {
        const digest = await getDigest(digestId);
        if (!active) return;
        const runs = await listEpisodes(digest.projectId, digest.payload.agendaId);
        const episode = runs.items.find(item => item.payload.digestId === digest.id || digest.payload.episodeIds?.includes(item.id));
        if (!active) return;
        if (digest.projectId !== getWebProjectId()) {
          if (episode?.payload.sessionId) {
            void markDigestOpened(digest.id).catch(() => { /* Reading a conversation never waits on read telemetry. */ });
            navigate(`/app/runs?run=${encodeURIComponent(episode.payload.runId ?? episode.payload.sessionId)}`, { replace: true }); return;
          }
        } else {
          const agendaId = digest.payload.agendaId ?? episode?.payload.agendaId;
          if (agendaId) {
            if (episode) void markDigestOpened(digest.id).catch(() => { /* Reading a result never waits on read telemetry. */ });
            navigate(taskPath(agendaId, { execution: episode?.id }), { replace: true }); return;
          }
        }
      } catch { /* An obsolete briefing address falls back to the list. */ }
      if (active) setParams(current => { const next = new URLSearchParams(current); next.delete("digest"); return next; }, { replace: true });
    })();
    return () => { active = false; };
  }, [digestId, navigate, setParams]);

  const record = (value: AgendaRecord) => { generation.current++; setAgendas(current => [value, ...(current ?? []).filter(item => item.id !== value.id)]); };
  const recordEpisode = (episode: EpisodeRecord, agendaId: string) => {
    setEpisodes(items => [episode, ...items.filter(item => item.id !== episode.id)]);
    if (selection.current === agendaId) setTaskEpisodes(items => ({ agendaId, items: [episode, ...(items?.agendaId === agendaId ? items.items : []).filter(item => item.id !== episode.id)] }));
  };
  const operate = async (action: Action) => {
    if (operating.current) return;
    operating.current = true; setBusy(true); setActionError(null); setRetry(null);
    // In-flight background snapshots must not replace a successful mutation.
    generation.current++; historyGeneration.current++; progressGeneration.current++;
    // What the action has already done to the task, for a retry that starts from there.
    const current = action.agenda;
    try {
      if (action.kind === "run") {
        const result = await runAgendaNow(current.id, action.requestId!);
        if (!live.current) return;
        recordEpisode(result.episode, current.id);
        setRefreshCycle(value => value + 1);
        // The new execution is the one to look at: its task, with no earlier execution chosen.
        navigate(taskPath(current.id, { search: searchNow.current }), { replace: selection.current === current.id });
      } else if (action.kind === "stop-run") {
        const episode = await cancelEpisode(current.id, action.episode!.id, action.requestId!);
        if (!live.current) return;
        recordEpisode(episode, current.id);
        await Promise.all([load(), loadHistory()]);
      } else if (action.kind === "material") {
        let value = action.remove ? await removeAgendaMaterial(current.id, action.remove) : await addAgendaMaterials(current.id, { sourceIds: action.sourceIds });
        // The task was waiting for exactly this: adding it is the researcher's start, and nothing is set up again.
        if (!action.remove && needsMaterial(value)) value = await startAgenda(value.id, value.revision);
        if (!live.current) return;
        record(value);
        await Promise.all([load(), loadHistory(), progressOpen ? loadProgress() : undefined]);
      } else {
        const value = await (action.kind === "pause" ? stopAgenda : action.kind === "resume" ? startAgenda : archiveAgenda)(current.id, current.revision);
        if (!live.current) return;
        if (action.kind === "archive") { setAgendas(items => (items ?? []).filter(item => item.id !== current.id)); if (selection.current === current.id) navigate(taskPath(null, { search: searchNow.current }), { replace: true }); }
        else record(value);
        await Promise.all([load(), loadHistory(), progressOpen ? loadProgress() : undefined]);
      }
    } catch (caught) {
      if (!live.current) return;
      const conflict = revisionConflict(caught);
      if (conflict) await load();
      // The refusal is said on the task it was asked of, and only there.
      if (typeof caught === "object" && caught !== null && "code" in caught && AUTOPILOT_BUDGET_ERROR_CODES.includes(String(caught.code))) setBudgetRefused(action.agenda.id);
      if (live.current && selection.current === action.agenda.id) {
        setActionError(conflict ? "任务状态已变化，已刷新最新内容。请核对后重新操作。" : inLingdou(productErrorMessage(caught)));
        if (!conflict) setRetry(action);
      }
    } finally { operating.current = false; if (live.current) setBusy(false); }
  };
  const openDigest = (id?: string | null) => { if (id) void markDigestOpened(id).catch(() => { /* Read telemetry must not prevent opening a result. */ }); };

  // Material: files are uploaded through the knowledge base (which registers them as sources), then named to the
  // task by their digest; the task itself never receives bytes.
  const addMaterial = async () => {
    if (!selected || operating.current) return;
    let files: File[] = [];
    try { files = await pickFiles(KNOWLEDGE_BASE_ACCEPT); } catch (caught) { setActionError(productErrorMessage(caught)); return; }
    const { accepted, refused } = partitionKnowledgeBaseFiles(files);
    if (refused.length > 0) setActionError(`没有添加：${refused.map(file => `${file.name}（${file.reason}）`).join("、")}。${KNOWLEDGE_BASE_UPLOAD_HINT}`);
    if (accepted.length === 0) return;
    operating.current = true; setBusy(true); setRetry(null);
    if (refused.length === 0) setActionError(null);
    generation.current++; historyGeneration.current++; progressGeneration.current++;
    try {
      const names = await uploadFilesToWorkspace(accepted, KNOWLEDGE_ROOT, "base");
      if (names.length === 0) throw new Error("upload unavailable");
      const sha256 = await Promise.all(accepted.map(sha256Hex));
      let value = await addAgendaMaterials(selected.id, { sha256 });
      if (needsMaterial(value)) value = await startAgenda(value.id, value.revision);
      if (!live.current) return;
      record(value);
      await Promise.all([load(), loadHistory(), progressOpen ? loadProgress() : undefined]);
    } catch (caught) {
      if (live.current) setActionError(`无法添加材料：${productErrorMessage(caught)}`);
    } finally { operating.current = false; if (live.current) setBusy(false); }
  };

  const rowActions: TaskRowActions = {
    run: agenda => void operate({ kind: "run", agenda, requestId: crypto.randomUUID() }),
    togglePause: agenda => activeAgenda(agenda) ? setConfirm({ kind: "pause", agenda }) : void operate({ kind: "resume", agenda }),
    edit: agenda => setEditor({ agenda }),
    remove: agenda => setConfirm({ kind: "archive", agenda }),
  };

  // The task on screen: its executions oldest first, the one the conversation shows (the researcher's choice in the address, else
  // the newest), the one that is on its way, and the newest result there is to read.
  const executions = selected && selectedEpisodes ? executionsOf(selected.id, selectedEpisodes) : [];
  const execution = executions.find(item => item.id === executionParam) ?? executions[executions.length - 1] ?? null;
  const running = [...executions].reverse().find(inFlight) ?? null;
  const withResult = selected ? [...executions].reverse().map(item => {
    const refs = (item.payload.artifactRefs ?? []).filter(ref => ref.projectId === selected.projectId && ref.runId === item.payload.runId
      && ref.sessionId === item.payload.sessionId && /^[A-Za-z0-9_-]{1,160}$/.test(ref.runId) && safeWorkspacePath(ref.path));
    return { episode: item, file: splitArtifacts(refs).readable[0] };
  }).find(entry => entry.file) : undefined;
  const selectExecution = (id: string) => setParams(current => {
    const next = new URLSearchParams(current);
    if (id === executions[executions.length - 1]?.id) next.delete("execution"); else next.set("execution", id);
    return next;
  });

  const closeEditor = () => setEditor(null);
  const main = !selectedId
    ? <EmptyState icon={CalendarClock} title="选择一项任务" description="任务的对话在这里打开。" className="min-h-0 flex-1" />
    : agendas === null ? <div className="px-6 py-6"><FilesSkeleton /></div>
      : !selected ? <EmptyState icon={CalendarClock} title="未找到这个任务" description="它可能已经删除。从列表选择其他任务。" className="min-h-0 flex-1" />
        : <>
          <TaskBar agenda={selected} executions={executions} selected={execution} running={running} busy={busy} backTo={split ? undefined : taskPath(null, { search })}
            latestResultHref={withResult ? snapshotHref(withResult.episode.payload.runId ?? "", withResult.file!.path) : null}
            onResultOpened={() => openDigest(withResult?.episode.payload.digestId)}
            error={actionError ? { message: actionError, retry: retry ? () => void operate(retry) : undefined } : null}
            actions={{
              run: () => void operate({ kind: "run", agenda: selected, requestId: crypto.randomUUID() }),
              stop: () => { if (running) void operate({ kind: "stop-run", agenda: selected, episode: running, requestId: crypto.randomUUID() }); },
              openProgress: () => setProgressOpen(true),
              edit: () => setEditor({ agenda: selected }),
              togglePause: () => rowActions.togglePause(selected),
              remove: () => setConfirm({ kind: "archive", agenda: selected }),
              supply: () => void addMaterial(),
              selectExecution,
            }} />
          {historyError ? <div className="px-6 py-6"><LoadError message={historyError} onRetry={() => void loadHistory()} /></div>
            : selectedEpisodes === null ? <div className="px-6 py-6"><FilesSkeleton /></div>
              : <TaskPane agenda={selected} execution={execution} lock={lock} ledgerRun={ledgerRun} projectId={projectId} />}
        </>;

  return <div ref={layout} className="flex h-full min-h-0 bg-bg" data-autopilot-layout={split ? "split" : "single"}>
    <PageTitle page={selected?.payload.title ?? "定时任务"} section={selected ? "定时任务" : undefined} />
    {showList && <section key="list" aria-label="任务列表" data-task-list="" className={cn("flex min-h-0 flex-col", split ? "shrink-0 border-r border-border" : "min-w-0 flex-1")} style={split ? { width: LIST_COLUMN } : undefined}>
      <TaskList agendas={agendas} episodes={episodes} selectedId={selectedId} search={search} onSearch={onSearch} projectName={projectName} error={error}
        onRetry={() => void load()} onCreate={() => setEditor({})} busy={busy} actions={rowActions} singleColumn={!split} />
    </section>}
    {showMain && <section key="main" aria-label="任务" data-task-main="" className="flex min-h-0 min-w-0 flex-1 flex-col">{main}</section>}
    {progressOpen && selected && <Drawer title="研究进展" onClose={() => setProgressOpen(false)}>
      <ResearchProgress agenda={selected} state={researchState} error={progressError} busy={busy} lastRun={lastRunLine(selected, selectedEpisodes ?? episodes, { withTime: true })}
        onAdd={() => void addMaterial()} onPick={() => setPicking(true)} onRemove={sourceId => void operate({ kind: "material", agenda: selected, remove: sourceId })} onRetry={() => void loadProgress()} />
      {!progressError && !researchState && <FilesSkeleton />}
    </Drawer>}
    {editor && <TaskDialog projectId={projectId} agenda={editor.agenda} showBudgets={editor.agenda ? budgetRefused === editor.agenda.id || budgetBlocks(editor.agenda, latestRun(editor.agenda.id, everyEpisode)) : false}
      saving={editorSaving} onBusyChange={setEditorSaving} onClose={closeEditor} onRecorded={record}
      onSaved={value => { record(value); closeEditor(); setBudgetRefused(null); if (!editor.agenda) navigate(taskPath(value.id, { search: searchNow.current })); }}
      onAdopted={id => { void load(); closeEditor(); navigate(taskPath(id, { search: searchNow.current })); }} />}
    {picking && selected && <FormDialog title="从知识库添加资料" busy={busy} onClose={() => { if (!busy) setPicking(false); }}><MaterialPicker projectId={projectId} taken={(selected.payload.materials ?? []).map(item => item.sourceId)} busy={busy}
      onCancel={() => setPicking(false)} onChoose={sourceIds => { const target = selected; setPicking(false); void operate({ kind: "material", agenda: target, sourceIds }); }} /></FormDialog>}
    {confirm && <ConfirmDialog title={confirm.kind === "pause" ? "暂停任务？" : "删除任务？"} body={confirm.kind === "pause" ? "暂停后将取消正在进行和排队中的研究，已产生的结果会保留。" : "删除后停止后续计划，取消正在进行和排队中的研究，并保留历史研究结果。"} tone="danger" confirmLabel={confirm.kind === "pause" ? "暂停任务" : "删除任务"} onCancel={() => setConfirm(null)} onConfirm={() => { const action = confirm; setConfirm(null); void operate(action); }} />}
  </div>;
}
