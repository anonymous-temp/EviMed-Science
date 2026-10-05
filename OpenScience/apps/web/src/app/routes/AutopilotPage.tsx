import { EvolutionOpportunities } from '@/components/evolution/EvolutionOpportunities';
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowLeft, ArrowUp, CalendarClock, Plus, RefreshCw } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import { addAgendaMaterials, archiveAgenda, followUpAgenda, getDigest, getResearchState, listAgendas, listEpisodes, markDigestOpened, removeAgendaMaterial, runAgendaNow, startAgenda, stopAgenda, type AgendaRecord, type EpisodeRecord, type ResearchState } from "@/lib/autopilotClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { sha256Hex } from "@/lib/fileDigest";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { chatPath } from "@/lib/runLocation";
import { cn } from "@/lib/cn";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormDialog } from "@/components/ui/FormDialog";
import { Textarea } from "@/components/ui/Input";
import { SearchInput } from "@/components/ui/SearchInput";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageTitle } from "@/components/layout/PageTitle";
import { MaterialPicker } from "@/components/autopilot/MaterialPicker";
import { ResearchProgress } from "@/components/autopilot/ResearchProgress";
import { TaskForm } from "@/components/autopilot/TaskForm";
import { TaskTimeline } from "@/components/autopilot/TaskTimeline";
import { activeAgenda, needsMaterial, pauseNotes, recurrence, RECOMMENDATIONS, resumableByReply, revisionConflict, scheduleOf, scheduleStatus, type Recommendation } from "@/components/autopilot/taskPresentation";
import { KNOWLEDGE_BASE_ACCEPT, KNOWLEDGE_BASE_UPLOAD_HINT, partitionKnowledgeBaseFiles } from "./FilesPage";

/** Where an upload lands: the project's knowledge base, which registers it as a source. */
const KNOWLEDGE_ROOT = "knowledge-base";

type Action = { kind: "pause" | "archive" | "resume" | "run" | "follow-up" | "material"; agenda: AgendaRecord; requestId?: string; note?: string; sourceIds?: string[]; remove?: string };

export function AutopilotPage() {
  useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  return <ProjectAutopilotPage key={projectId} projectId={projectId} />;
}

function ProjectAutopilotPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("task");
  const digestId = params.get("digest");
  const [agendas, setAgendas] = useState<AgendaRecord[] | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [taskEpisodes, setTaskEpisodes] = useState<{ agendaId: string; items: EpisodeRecord[] } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ agendaId: string; value: ResearchState } | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retry, setRetry] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editor, setEditor] = useState<{ agenda?: AgendaRecord; recommendation?: Recommendation } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshExhausted, setRefreshExhausted] = useState(false);
  const [refreshCycle, setRefreshCycle] = useState(0);
  const live = useRef(true);
  const generation = useRef(0);
  const historyGeneration = useRef(0);
  const progressGeneration = useRef(0);
  const operating = useRef(false);
  const selection = useRef(selectedId); selection.current = selectedId;

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
  useEffect(() => { setNote(""); setActionError(null); setRetry(null); }, [selectedId]);

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
  // What was found, what is unresolved and the material added: read like the history, for the selected task only.
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
    setProgressError(null); setProgress(null); void loadProgress();
    return () => { requests.current++; };
  }, [loadProgress]);
  const researchState = progress?.agendaId === selectedId ? progress.value : null;
  const selectedEpisodes = taskEpisodes?.agendaId === selectedId ? taskEpisodes.items : null;
  const pending = [...episodes, ...(selectedEpisodes ?? [])].some(episode => ["queued", "running", "verifying"].includes(episode.payload.status));
  const watching = pending || (agendas ?? []).some(agenda => activeAgenda(agenda) && agenda.payload.scheduleState !== "completed");
  // A bounded poll follows background work without maintaining a second kernel connection.
  useEffect(() => {
    if (!watching) { setRefreshExhausted(false); return; }
    let canceled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (canceled) return;
      if (!document.hidden && !operating.current) { attempts++; await Promise.all([load(), loadHistory(), loadProgress()]); }
      if (canceled) return;
      if (attempts >= 60) { setRefreshExhausted(true); return; }
      timer = setTimeout(() => void tick(), pending ? 5000 : 30000);
    };
    timer = setTimeout(() => void tick(), pending ? 5000 : 30000);
    return () => { canceled = true; clearTimeout(timer); };
  }, [watching, pending, load, loadHistory, loadProgress, refreshCycle]);

  useEffect(() => {
    if (!digestId) return;
    let active = true;
    void (async () => {
      try {
        const digest = await getDigest(digestId);
        if (!active) return;
        const runs = await listEpisodes(digest.projectId, digest.payload.agendaId);
        const episode = runs.items.find(item => item.payload.sessionId && (item.payload.digestId === digest.id || digest.payload.episodeIds?.includes(item.id)));
        if (active && episode?.payload.sessionId) {
          void markDigestOpened(digest.id).catch(() => { /* Reading a conversation never waits on read telemetry. */ });
          navigate(digest.projectId === getWebProjectId() ? chatPath(episode.payload.sessionId) : `/app/runs?run=${encodeURIComponent(episode.payload.runId ?? episode.payload.sessionId)}`, { replace: true }); return;
        }
      } catch { /* An obsolete briefing address falls back to tasks. */ }
      if (active) setParams(current => { const next = new URLSearchParams(current); next.delete("digest"); return next; }, { replace: true });
    })();
    return () => { active = false; };
  }, [digestId, navigate, setParams]);

  const select = (id: string | null) => setParams(current => { const next = new URLSearchParams(current); if (id) next.set("task", id); else next.delete("task"); return next; });
  const record = (value: AgendaRecord) => { generation.current++; setAgendas(current => [value, ...(current ?? []).filter(item => item.id !== value.id)]); };
  const operate = async (action: Action) => {
    if (operating.current) return;
    operating.current = true; setBusy(true); setActionError(null); setRetry(null);
    // In-flight background snapshots must not replace a successful mutation.
    generation.current++; historyGeneration.current++; progressGeneration.current++;
    // What the action has already done to the task: a reply that restarts it and then fails to send retries from the restarted one.
    let current = action.agenda;
    try {
      if (action.kind === "run" || action.kind === "follow-up") {
        // A task the planner paused is continued by the researcher's reply: sending it is their start.
        if (action.kind === "follow-up" && resumableByReply(current)) { current = await startAgenda(current.id, current.revision); record(current); }
        const result = action.kind === "run" ? await runAgendaNow(current.id, action.requestId!)
          : await followUpAgenda(current.id, { requestId: action.requestId!, note: action.note! });
        if (!live.current) return;
        // No episode: the message asked to hold the research and the planner paused it. The task, its message and the reason are read back.
        if (!result.episode) {
          if (selection.current === action.agenda.id) setNote("");
          await Promise.all([load(), loadHistory(), loadProgress()]);
        } else {
          const episode = result.episode;
          setEpisodes(items => [episode, ...items.filter(item => item.id !== episode.id)]);
          if (selection.current === action.agenda.id) setTaskEpisodes(items => ({ agendaId: action.agenda.id, items: [episode, ...(items?.agendaId === action.agenda.id ? items.items : []).filter(item => item.id !== episode.id)] }));
          setRefreshExhausted(false); setRefreshCycle(value => value + 1);
          if (action.kind === "follow-up" && selection.current === action.agenda.id) setNote("");
          if (action.kind === "follow-up") void loadProgress();
        }
      } else if (action.kind === "material") {
        let value = action.remove ? await removeAgendaMaterial(current.id, action.remove) : await addAgendaMaterials(current.id, { sourceIds: action.sourceIds });
        // The task was waiting for exactly this: adding it is the researcher's start, and nothing is set up again.
        if (!action.remove && needsMaterial(value)) value = await startAgenda(value.id, value.revision);
        if (!live.current) return;
        record(value);
        await Promise.all([load(), loadHistory(), loadProgress()]);
      } else {
        const value = await (action.kind === "pause" ? stopAgenda : action.kind === "resume" ? startAgenda : archiveAgenda)(action.agenda.id, action.agenda.revision);
        if (!live.current) return;
        if (action.kind === "archive") { setAgendas(items => (items ?? []).filter(item => item.id !== action.agenda.id)); if (selection.current === action.agenda.id) select(null); }
        else record(value);
        await Promise.all([load(), loadHistory(), loadProgress()]);
      }
    } catch (caught) {
      if (!live.current) return;
      const conflict = revisionConflict(caught);
      if (conflict) await load();
      if (live.current && selection.current === action.agenda.id) {
        setActionError(conflict ? "任务状态已变化，已刷新最新内容。请核对后重新操作。" : productErrorMessage(caught));
        if (!conflict) setRetry({ ...action, agenda: current });
      }
    } finally { operating.current = false; if (live.current) setBusy(false); }
  };
  const openDigest = (id?: string | null) => { if (id) void markDigestOpened(id).catch(() => { /* Read telemetry must not prevent opening a result. */ }); };
  const selected = agendas?.find(agenda => agenda.id === selectedId);
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
      await Promise.all([load(), loadHistory(), loadProgress()]);
    } catch (caught) {
      if (live.current) setActionError(`无法添加材料：${productErrorMessage(caught)}`);
    } finally { operating.current = false; if (live.current) setBusy(false); }
  };
  const visible = (agendas ?? []).filter(agenda => !agenda.payload.archivedAt && `${agenda.payload.title}\n${agenda.payload.prompt ?? agenda.payload.topics.join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const scheduled = visible.filter(agenda => activeAgenda(agenda) && agenda.payload.scheduleState !== "completed").sort((a, b) => (a.payload.nextRunAt ?? "z").localeCompare(b.payload.nextRunAt ?? "z"));
  const inactive = visible.filter(agenda => !scheduled.includes(agenda));
  const railList = (label: string, items: AgendaRecord[]) => items.length > 0 && <section aria-label={label} className="space-y-2"><h2 className="px-3 text-caption font-medium text-text-3">{label}</h2><ul className="space-y-1">{items.map(agenda => <li key={agenda.id}>
    <Button variant="text" aria-label={agenda.payload.title} aria-pressed={selectedId === agenda.id} className={cn("h-auto w-full flex-col items-start whitespace-normal px-3 py-3 text-left", selectedId === agenda.id && "bg-surface-3 text-text")} onClick={() => select(agenda.id)}>
      <span className="line-clamp-2 text-ui font-medium">{agenda.payload.title}</span><span className="text-caption font-normal text-text-3">{scheduleStatus(agenda)}</span><span className="text-caption font-normal text-text-3">{recurrence(scheduleOf(agenda))}</span>
    </Button>
  </li>)}</ul></section>;

  return <div className="flex h-full min-h-0 bg-bg">
    <PageTitle page="定时任务" />
    {/* One left edge in the list column (28 px): the title, the section names and the rows are inset 12 px, so the back link and 新建任务 take the same inset over their size's own 10 and 14. */}
    <aside aria-label="定时任务列表" className={cn("min-h-0 w-full shrink-0 overflow-y-auto bg-surface-1 p-4 md:w-72", selectedId && "hidden md:block")}>
      <Link to="/app/chat" className={cn(buttonClasses({ variant: "text", size: "sm" }), "mb-4 w-full justify-start px-3")}><ArrowLeft size={16} aria-hidden="true" />返回工作台</Link>
      <header className="mb-5 flex items-center justify-between px-3"><h1 className="text-heading font-semibold text-text">定时任务</h1><CalendarClock size={20} className="text-text-3" aria-hidden="true" /></header>
      <SearchInput label="搜索任务" className="mb-3 w-full" value={search} onChange={event => setSearch(event.target.value)} />
      <Button variant="text" className="mb-6 w-full justify-start px-3" onClick={() => setEditor({})}><Plus size={16} aria-hidden="true" />新建任务</Button>
      {error && <LoadError message={error} onRetry={() => void load()} />}
      {agendas === null ? <FilesSkeleton /> : <div className="space-y-6">
        {railList("即将执行", scheduled)}{railList("已暂停 / 已完成", inactive)}
        {visible.length === 0 && !error && <p className="px-3 text-ui text-text-3">{search ? "没有匹配的任务" : "还没有定时任务"}</p>}
        <EvolutionOpportunities projectId={projectId} onAdopted={id => { void load(); select(id); }} />
        <section aria-label="推荐" className="space-y-2"><h2 className="px-3 text-caption font-medium text-text-3">推荐</h2><ul className="space-y-1">{RECOMMENDATIONS.map(item => <li key={item.title}><Button variant="text" aria-label={item.title} className="h-auto w-full flex-col items-start whitespace-normal px-3 py-2 text-left" onClick={() => setEditor({ recommendation: item })}><span className="text-ui font-normal text-text-2">{item.title}</span><span className="line-clamp-1 text-caption font-normal text-text-3">{item.prompt}</span></Button></li>)}</ul></section>
      </div>}
    </aside>
    <section aria-label="任务详情" className={cn("min-h-0 min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden md:flex")}>
      {selected ? <>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0"><Button variant="text" size="sm" aria-label="返回任务列表" className="mb-2 md:hidden" onClick={() => select(null)}><ArrowLeft size={16} aria-hidden="true" />任务列表</Button><h2 className="text-body font-semibold text-text">{selected.payload.title}</h2><p className="mt-1 text-caption text-text-3">{recurrence(scheduleOf(selected))} · {scheduleOf(selected).timeZone}</p><p className="mt-1 text-caption text-text-3">{scheduleStatus(selected)}</p>{pauseNotes(selected).map(note => <p key={note} className="mt-1 whitespace-pre-wrap break-words text-caption text-text-2">{note}</p>)}</div>
          <div className="flex flex-wrap gap-1">
            <Button variant="text" size="sm" disabled={busy} onClick={() => setEditor({ agenda: selected })}>编辑任务</Button>
            <Button variant="text" size="sm" disabled={busy} onClick={() => activeAgenda(selected) ? setConfirm({ kind: "pause", agenda: selected }) : void operate({ kind: "resume", agenda: selected })}>{activeAgenda(selected) ? "暂停任务" : "启用任务"}</Button>
            <Button variant="secondary" size="sm" disabled={busy || !activeAgenda(selected)} onClick={() => setConfirm({ kind: "run", agenda: selected, requestId: crypto.randomUUID() })}>立即运行</Button>
            <Button variant="text" size="sm" disabled={busy} onClick={() => setConfirm({ kind: "archive", agenda: selected })}>删除任务</Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6"><div className="mx-auto max-w-read space-y-5">
          {error && <LoadError message={error} onRetry={() => void load()} />}
          {actionError && <div role="alert" className="text-ui text-error">{actionError}{retry && <Button variant="text" disabled={busy} onClick={() => void operate(retry)}>重试操作</Button>}</div>}
          <div className="ml-auto max-w-body rounded-panel bg-accent px-5 py-4 text-ui leading-relaxed text-accent-fg"><p className="whitespace-pre-wrap break-words">{selected.payload.prompt ?? selected.payload.topics.join("\n")}</p></div>
          <ResearchProgress agenda={selected} state={researchState} error={progressError} busy={busy} onAdd={() => void addMaterial()} onPick={() => setPicking(true)}
            onRemove={sourceId => void operate({ kind: "material", agenda: selected, remove: sourceId })} onRetry={() => void loadProgress()} />
          {historyError && <LoadError message={historyError} onRetry={() => void loadHistory()} />}
          {selectedEpisodes ? <TaskTimeline agenda={selected} episodes={selectedEpisodes} onOpen={openDigest} /> : !historyError && <FilesSkeleton />}
        </div></div>
        <div className="px-5 pb-5 pt-3"><form className="mx-auto max-w-read rounded-composer border border-border bg-surface-2 p-3 shadow-e1" onSubmit={event => { event.preventDefault(); if (!note.trim() || busy || !(activeAgenda(selected) || resumableByReply(selected)) || retry?.kind === "follow-up") return; void operate({ kind: "follow-up", agenda: selected, requestId: crypto.randomUUID(), note }); }}>
          <Textarea aria-label="针对任务追问" rows={2} maxLength={8000} placeholder={activeAgenda(selected) ? "提问、更正上面的结论，或说明需要暂停…" : resumableByReply(selected) ? "回复后任务会继续…" : "请先启用任务，再发送追问"} disabled={!(activeAgenda(selected) || resumableByReply(selected)) || busy || retry?.kind === "follow-up"} value={note} className="border-transparent bg-transparent focus:border-transparent" onChange={event => setNote(event.target.value)} />
          <div className="flex items-center justify-between gap-3"><span className="text-caption text-text-3">{activeAgenda(selected) ? `单次上限 ¥${selected.payload.maxEpisodeCny}` : resumableByReply(selected) ? "发送后任务将继续" : "请先启用任务"}</span><Button type="submit" aria-label="发送追问" size="sm" loading={busy} disabled={!(activeAgenda(selected) || resumableByReply(selected)) || !note.trim() || retry?.kind === "follow-up"}><ArrowUp size={16} aria-hidden="true" /></Button></div>
        </form>{refreshExhausted && <div className="mx-auto mt-2 flex max-w-read items-center gap-2 text-caption text-text-3">自动刷新已暂停<Button variant="text" size="sm" onClick={() => { setRefreshExhausted(false); setRefreshCycle(value => value + 1); void Promise.all([load(), loadHistory()]); }}><RefreshCw size={16} aria-hidden="true" />刷新结果</Button></div>}</div>
      </> : <div className="flex h-full items-center justify-center p-6">{agendas === null ? <FilesSkeleton /> : <div><Button variant="text" className="mb-4 md:hidden" onClick={() => select(null)}><ArrowLeft size={16} aria-hidden="true" />返回任务列表</Button><EmptyState icon={CalendarClock} title={selectedId ? "未找到这个任务" : "让研究按时继续"} description={selectedId ? "返回列表选择其他任务。" : "选择一个任务查看记录，或从推荐开始。"} /></div>}</div>}
    </section>
    {editor && <FormDialog title={editor.agenda ? "编辑任务" : "新建任务"} busy={editorSaving} onClose={() => { if (!editorSaving) setEditor(null); }}><TaskForm projectId={projectId} agenda={editor.agenda} recommendation={editor.recommendation} onRecorded={record} onBusyChange={setEditorSaving} onCancel={() => setEditor(null)} onSaved={value => { record(value); setEditor(null); select(value.id); }} /></FormDialog>}
    {picking && selected && <FormDialog title="从知识库添加资料" busy={busy} onClose={() => { if (!busy) setPicking(false); }}><MaterialPicker projectId={projectId} taken={(selected.payload.materials ?? []).map(item => item.sourceId)} busy={busy}
      onCancel={() => setPicking(false)} onChoose={sourceIds => { const target = selected; setPicking(false); void operate({ kind: "material", agenda: target, sourceIds }); }} /></FormDialog>}
    {confirm && <ConfirmDialog title={confirm.kind === "run" ? "立即运行？" : confirm.kind === "pause" ? "暂停任务？" : "删除任务？"} body={confirm.kind === "run" ? `本次最多花费 ¥${confirm.agenda.payload.maxEpisodeCny}，不改变原定计划。` : confirm.kind === "pause" ? "暂停后将取消正在进行和排队中的研究，已产生的结果会保留。" : "删除后停止后续计划，取消正在进行和排队中的研究，并保留历史研究结果。"} tone={confirm.kind === "run" ? "primary" : "danger"} confirmLabel={confirm.kind === "run" ? "立即运行" : confirm.kind === "pause" ? "暂停任务" : "删除任务"} onCancel={() => setConfirm(null)} onConfirm={() => { const action = confirm; setConfirm(null); void operate(action); }} />}
  </div>;
}
