import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { Link, useNavigate } from "react-router";
import { cancelWebAgentRun, getWebProjectId, listWebAgentRuns, steerWebAgentRun, WebApiError, type WebAgentRun } from "@/lib/apiClient";
import { addAgendaMaterials, cancelEpisode, followUpAgenda, getResearchState, listAgendas, listEpisodes, removeAgendaMaterial, runAgendaNow, type AgendaRecord, type EpisodeRecord, type ResearchState } from "@/lib/autopilotClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { newResearchGoalRequest, startResearchGoal, type ResearchGoalRequest } from "@/lib/dispatch";
import { safeWorkspacePath } from "@/lib/claimCitations";
import { sha256Hex } from "@/lib/fileDigest";
import { formatDay, formatClock, formatLingdou } from "@/lib/format";
import { KNOWLEDGE_BASE_ACCEPT, partitionKnowledgeBaseFiles } from "@/lib/knowledgeBaseFiles";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { goalKey, goalTitle, observedResearchGoals, type ObservedResearchGoal } from "@/lib/observedResearchGoals";
import { registerTaskPane } from "@/lib/taskPane";
import { snapshotHref } from "@/lib/readPages";
import { researchDatabaseStatus } from "@/lib/researchDatabaseClient";
import { listResearchGoals, pauseResearchGoal, resumeResearchGoal, type ResearchGoalList, type ResearchGoalState } from "@/lib/researchGoalClient";
import { listPlatformSkills } from "@/lib/skillLibraryClient";
import { toast } from "@/lib/toast";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import type { PageActionPlan } from "@/components/layout/HeaderActions";
import { List, ListRow } from "@/components/ui/ListRow";
import { ConversationHeldNote } from "@/components/autopilot/ConversationHeldNote";
import { MaterialPicker } from "@/components/autopilot/MaterialPicker";
import { ResearchDatabaseDialog } from "@/components/autopilot/ResearchDatabaseDialog";
import { ResearchDataPanel } from "@/components/autopilot/ResearchDataPanel";
import { ResearchObservatory } from "@/components/autopilot/ResearchObservatory";
import { QUEUE_MODE_WORD, ResearchQueue, type QueueEntry, type QueueMode } from "@/components/autopilot/ResearchQueue";
import { roundModeOf, runLive, streamEnded, type ObservedRun } from "@/components/autopilot/researchRunState";
import { activeAgenda, CONVERSATION_HELD, inFlight, latestRun, repeatLine, runState, scheduleOf } from "@/components/autopilot/taskPresentation";
import { boundedLock, TaskPane } from "@/components/autopilot/TaskPane";
import { useExecutionFinishToasts } from "@/components/autopilot/useExecutionFinishToasts";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Textarea } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";

class MaterialInputError extends Error {}

/**
 * How often the page reads again, each thing at the rate it is worth. The project's executions and the displayed study are read quickly
 * while one of its executions is on its way and quietly otherwise; the run list is the sidebar's own read of the same ledger (it makes
 * the server recover runs, total the usage and backfill), so it is read at the sidebar's pace and never faster.
 */
const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 30_000;
const POLL_RUNS_MS = 20_000;

/** Runs `read` every `ms`, except while the document is hidden or an action is under way (`operating`); returns what stops it. */
function pollEvery(read: () => void, ms: number, operating: { current: boolean }): () => void {
  const timer = window.setInterval(() => { if (!document.hidden && !operating.current) read(); }, ms);
  return () => window.clearInterval(timer);
}

const at = (value: string | null | undefined) => [formatDay(value), formatClock(value)].filter(Boolean).join(" ");
const SAFE_RUN = /^[A-Za-z0-9_-]{1,160}$/;
const FOUND_TAG: Record<ResearchState["found"][number]["check"], { label: string; tone: "neutral" | "accent" | "warn" }> = {
  reproduced: { label: "已复现", tone: "accent" }, stands: { label: "复核成立", tone: "neutral" }, refuted: { label: "已推翻", tone: "warn" },
};

/** A goal round's state as its own record has it (the queue's word for it, with no stream to ask). */
function roundMode(run: WebAgentRun): QueueMode {
  return roundModeOf(run, null);
}

/** The views of the research on show, under the observatory: what it produced, what happened, and its conversation. */
type ResearchTab = "results" | "records" | "conversation";
const RESEARCH_TABS = [{ value: "results", label: "结果" }, { value: "records", label: "记录" }, { value: "conversation", label: "对话" }] as const;

/**
 * The control plane's word on a goal, which it keeps for the newest goal of a conversation only. Nothing where the deployment has no such
 * service or has no state for the goal: the page then reads the goal by its rounds alone.
 */
function stateOfGoal(goal: ObservedResearchGoal, goals: readonly ObservedResearchGoal[], list: ResearchGoalList | null): ResearchGoalState | null {
  if (!list?.available || goals.find(item => item.sessionId === goal.sessionId)?.key !== goal.key) return null;
  return list.goals.find(item => item.sessionId === goal.sessionId) ?? null;
}

/**
 * A goal in the queue: a round that is going says so; between rounds the goal's own state does (the control plane's, where it has one);
 * and with no state a round that ran to its end does not say the goal is finished, only that the round is.
 */
function goalMode(goal: ObservedResearchGoal, observed: ObservedRun | null, state: ResearchGoalState | null): QueueMode {
  const mode = roundModeOf(goal.latest, observed);
  if (mode === "running") return mode;
  switch (state?.status) {
    case "active": return "running";
    case "paused": return "paused";
    case "stopped": return "ended";
    case "finished": return "done";
    case "waiting": return "needs";
    case "interrupted": return "interrupted";
    default: return mode === "done" ? "between" : mode;
  }
}

/** Why a goal rests, when a person should know it. A pause or stop the person asked for is not one. */
function restingNote(state: ResearchGoalState | null): string | null {
  switch (state?.status) {
    case "paused": return state.reason === "no_progress" ? "连续几轮没有新的产出，已自动暂停。" : state.reason === "budget" ? "到了这项研究的花费上限，已自动暂停。" : null;
    case "interrupted": return "运行被中断后没能自动接上。";
    case "waiting": return "还有没做完的部分，AI 没有继续。";
    default: return null;
  }
}

/** What all of a goal's rounds cost, in CNY (a lingdou is one); null when no round reported any usage, which is not the same as nothing. */
function goalSpend(goal: ObservedResearchGoal): number | null {
  const costs = goal.rounds.map(run => run.usage?.costCny).filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost) && cost >= 0);
  return costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null;
}

/**
 * An execution's mode in the queue. The run stream, where it is open for the run, says whether it is going (`runLive`); the poll
 * says it otherwise.
 */
function agendaMode(agenda: AgendaRecord, episodes: readonly EpisodeRecord[], observed: ObservedRun | null): QueueMode {
  const flying = episodes.find(item => item.payload.agendaId === agenda.id && inFlight(item));
  if (flying) {
    if (runLive(flying.payload.runId, true, observed)) return flying.payload.status === "queued" ? "queued" : "running";
    // The poll still has it on its way and the stream has said how it ended: the card says that, as the stream's goal rounds do.
    return roundModeOf({ id: flying.payload.runId ?? "", status: "running" }, observed);
  }
  if (!activeAgenda(agenda)) return "paused";
  const last = latestRun(agenda.id, episodes)?.payload.status;
  return last === "merged" ? "done" : last === "failed" ? "failed" : "waiting";
}

/**
 * A project's active research, opened on what is at work: the observatory of the running research, with the queue of the rest above it.
 * New research is one thing to do here (a goal, in the person's words) and data one more; a scheduled study is made in 定时任务 and shown here.
 */
export function ActiveResearchPage() {
  useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  return <ResearchWorkspace key={projectId} projectId={projectId} />;
}

function ResearchWorkspace({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [agendas, setAgendas] = useState<AgendaRecord[] | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [goalRuns, setGoalRuns] = useState<WebAgentRun[] | null>(null);
  const [goalError, setGoalError] = useState(false);
  const [goalStates, setGoalStates] = useState<ResearchGoalList | null>(null);
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
  const [chosen, setChosen] = useState(false);
  const [selectedRound, setSelectedRound] = useState<string | null>(null);
  const [tab, setTab] = useState<ResearchTab>("results");
  const [observed, setObserved] = useState<ObservedRun | null>(null);
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
  const [starting, setStarting] = useState(false);
  const [intake, setIntake] = useState(false);
  const [picking, setPicking] = useState(false);
  const [databaseFor, setDatabaseFor] = useState<"study" | "knowledge-base" | null>(null);
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
  // The request a goal is started with, kept across the dialog's closing and opening until the goal is known to have started.
  const goalRequest = useRef<ResearchGoalRequest | null>(null);
  const loadingGoals = useRef(false);
  const goalGeneration = useRef(0);
  const loadingHistory = useRef<string | null>(null);
  const loadingProgress = useRef<string | null>(null);
  const mounted = useRef(true);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const episodesRef = useRef(episodes); episodesRef.current = episodes;

  /**
   * The project's tasks and executions. The first read pages through every execution, so older running work is not hidden; a `recent`
   * read (the poll) takes the newest page only and keeps the older ones it already has, since only the newest can have changed.
   */
  const load = useCallback(async (force = false, recent = false) => {
    if (loadingTasks.current && !force) return;
    loadingTasks.current = true;
    const request = ++generation.current;
    try {
      const [tasks, firstPage] = await Promise.all([listAgendas(projectId), listEpisodes(projectId)]);
      const runs = [...firstPage.items];
      const seenCursors = new Set<string>();
      let cursor = recent ? null : firstPage.nextCursor;
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
      if (recent) ownRuns.push(...episodesRef.current.filter(item => !ownRuns.some(fresh => fresh.id === item.id)));
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
  /**
   * The project's goals: its runs, and the control plane's word on each goal (running a round, resting and why). The two are read apart: a
   * state that cannot be read keeps the last one the page had and breaks nothing, since the rounds alone still say what the goal did.
   * A `force`d read (after an action) is not turned away by one already out, and the older answer never lands over the newer.
   */
  const loadGoals = useCallback(async (force = false) => {
    if (loadingGoals.current && !force) return;
    loadingGoals.current = true;
    const request = ++goalGeneration.current;
    const current = () => mounted.current && request === goalGeneration.current;
    try {
      await Promise.all([
        listWebAgentRuns({ projectId }).then(runs => { if (current()) { setGoalRuns(runs); setGoalError(false); } }, () => { if (current()) setGoalError(true); }),
        listResearchGoals(projectId).then(answer => { if (current() && answer && Array.isArray(answer.goals)) setGoalStates(answer); }, () => {}),
      ]);
    } finally { if (request === goalGeneration.current) loadingGoals.current = false; }
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
  const goals = observedResearchGoals(goalRuns ?? []);
  const stateOf = (item: ObservedResearchGoal) => stateOfGoal(item, goals, goalStates);
  // Until the person chooses, the page shows what is at work: a running study, then a running goal, then whichever ran last.
  const newestGoal = goals[0] ?? null;
  const newestStudyRun = episodes.reduce((newest, item) => (item.payload.createdAt ?? "") > newest ? item.payload.createdAt ?? "" : newest, "");
  const openingGoal = chosen || episodes.some(inFlight) ? null : goals.find(item => item.latest.status === "running")
    ?? (!newestGoal || (newestStudyRun && Date.parse(newestStudyRun) > Date.parse(newestGoal.latest.startedAt)) ? null : newestGoal);
  const goal = goals.find(item => item.key === selectedGoal) ?? openingGoal;
  const selected = !goal ? agendas?.find(item => item.id === selectedId) ?? null : null;
  const ownEpisodes = history?.agendaId === selectedId ? [...history.items].sort((a, b) => (b.payload.createdAt ?? "").localeCompare(a.payload.createdAt ?? "")) : [];
  const execution = ownEpisodes.find(item => item.id === selectedEpisodeId) ?? ownEpisodes[0] ?? null;
  const polledRunning = selectedId ? episodes.find(item => item.payload.agendaId === selectedId && inFlight(item)) ?? ownEpisodes.find(inFlight) ?? null : null;
  // Whether it is still going is the run stream's word where the stream is open for it, and the poll's otherwise (`runLive`).
  const runningEpisode = polledRunning && runLive(polledRunning.payload.runId, true, observed) ? polledRunning : null;
  const round = goal ? goal.rounds.find(item => item.id === selectedRound) ?? goal.latest : null;
  const liveSteer = runningEpisode?.payload.status === "running" && runningEpisode.payload.interactive === true && !!runningEpisode.payload.runId;

  // The page keeps reading while it is open, each read at its own rate and none while the document is hidden or an action is under way.
  // The tasks and their newest executions follow whether any execution is on its way; the displayed study (its progress and its
  // executions) is read only while a study is displayed — a shown goal is read through the run list, not through the study that was
  // chosen before it; and the run list, the heavy one, is read at the sidebar's pace.
  const tasksBusy = episodes.some(inFlight);
  const studyShown = selected !== null;
  const studyBusy = polledRunning !== null;
  const reads = useRef({ tasks: () => {}, runs: () => {}, study: () => {} });
  reads.current = {
    tasks: () => void load(false, true),
    runs: () => void loadGoals(),
    study: () => { void loadProgress(); if (!historyBusy) void loadHistory(); },
  };
  useEffect(() => pollEvery(() => reads.current.tasks(), tasksBusy ? POLL_ACTIVE_MS : POLL_IDLE_MS, operating), [tasksBusy]);
  // The stream says a run is over: the records are read at once, so the page does not wait for the next poll to agree with it.
  const ended = streamEnded(observed);
  useEffect(() => { if (ended) { reads.current.tasks(); reads.current.runs(); if (studyShown) reads.current.study(); } }, [ended, observed?.runId, studyShown]);
  useExecutionFinishToasts(episodes, agendaId => agendas?.find(item => item.id === agendaId)?.payload.title);
  useEffect(() => pollEvery(() => reads.current.runs(), POLL_RUNS_MS, operating), []);
  useEffect(() => (studyShown ? pollEvery(() => reads.current.study(), studyBusy ? POLL_ACTIVE_MS : POLL_IDLE_MS, operating) : undefined), [studyShown, studyBusy, selectedId]);

  const queue: QueueEntry[] = [
    ...goals.map(item => {
      const mode = goalMode(item, observed, stateOf(item));
      return { key: `goal:${item.key}`, title: goalTitle(item), kind: "长期" as const, mode,
        meta: roundModeOf(item.latest, observed) === "running" ? `本轮 ${at(item.latest.startedAt)} 开始` : mode === "running" ? "下一轮马上开始" : `最近一轮 ${at(item.latest.finishedAt ?? item.latest.startedAt)}` };
    }),
    ...(agendas ?? []).map(item => {
      const last = latestRun(item.id, episodes);
      const schedule = scheduleOf(item);
      return { key: `agenda:${item.id}`, title: item.payload.title, kind: "定时" as const, mode: agendaMode(item, episodes, observed),
        meta: [repeatLine(schedule), last ? `上次 ${at(last.payload.createdAt)}` : ""].filter(Boolean).join(" · ") };
    }),
  ].sort((a, b) => Number(b.mode === "running" || b.mode === "queued") - Number(a.mode === "running" || a.mode === "queued"));
  const queueSelected = goal ? `goal:${goal.key}` : selected ? `agenda:${selected.id}` : null;
  // Work that is going now, for the band's activity strip: the one on show first. A queued execution has not started, and the queue's card says so.
  const working = [
    ...goals.filter(item => roundModeOf(item.latest, observed) === "running").map(item => ({ key: `goal:${item.key}`, label: `推进“${goalTitle(item)}”`, since: item.latest.startedAt })),
    ...(agendas ?? []).flatMap(item => {
      const live = episodes.find(entry => entry.payload.agendaId === item.id && inFlight(entry) && entry.payload.status !== "queued" && runLive(entry.payload.runId, true, observed));
      return live ? [{ key: `agenda:${item.id}`, label: `运行“${item.payload.title}”`, since: live.payload.createdAt }] : [];
    }),
  ];
  const shownWork = working.find(item => item.key === queueSelected) ?? working[0];
  // A bounded execution holds the project's conversation while it runs: said here, before the researcher meets the wall (audit D1).
  const holder = boundedLock(episodes);

  async function operation(action: () => Promise<unknown>) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setActionError(null); setActionNotice(null);
    try { await action(); if (mounted.current) await Promise.all([load(true), loadProgress(true), loadHistory(undefined, true)]); }
    catch (caught) { if (mounted.current) setActionError(caught instanceof MaterialInputError ? caught.message : productErrorMessage(caught)); }
    finally { operating.current = false; if (mounted.current) setBusy(false); }
  }
  /** Picks files and puts them in the project's knowledge base; what was accepted comes back, nothing when the person picked nothing. */
  const uploadToKnowledgeBase = async (current: () => boolean) => {
    const files = await pickFiles(KNOWLEDGE_BASE_ACCEPT);
    if (!current()) throw new Error("项目或研究已切换，请重新选择资料。");
    const { accepted, refused } = partitionKnowledgeBaseFiles(files);
    if (refused.length) throw new MaterialInputError(`部分文件无法添加：${refused.map(file => `${file.name}（${file.reason}）`).join("、")}`);
    if (!accepted.length) return accepted;
    if (accepted.length > 10) throw new MaterialInputError("每次最多添加 10 份资料，请分批选择。");
    const names = await uploadFilesToWorkspace(accepted, "knowledge-base", "base", projectId, current);
    if (names.length !== accepted.length) throw new Error("上传未完成，请到知识库查看后重试。");
    return accepted;
  };
  const upload = () => { if (!selectedId) return; void operation(async () => {
    const target = selectedId;
    const current = () => mounted.current && getWebProjectId() === projectId && selectedRef.current === target;
    const accepted = await uploadToKnowledgeBase(current);
    if (!accepted.length) return;
    const sha256 = await Promise.all(accepted.map(sha256Hex));
    if (!current()) throw new Error("项目或研究已切换，请重新选择资料。");
    try { await addAgendaMaterials(target, { sha256 }); }
    catch { throw new MaterialInputError("资料已上传到知识库，但没能加入本研究。请从知识库再选一次。"); }
  }); };
  /** 「接入数据」: into the project's knowledge base, where its research reads it. */
  const connectFiles = () => { setIntake(false); void operation(async () => {
    const accepted = await uploadToKnowledgeBase(() => mounted.current && getWebProjectId() === projectId);
    if (accepted.length && mounted.current) setActionNotice(`已接入 ${accepted.length} 份资料，这个项目的研究都可以使用。`);
  }); };
  const connectData = () => { if (databaseAvailable) setIntake(true); else connectFiles(); };
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
    toast.success(`已开始运行。${CONVERSATION_HELD}`);
  });
  const stopExecution = (agendaId: string, episodeId: string) => void operation(async () => {
    const requestId = pendingStops.current.get(episodeId) ?? crypto.randomUUID();
    pendingStops.current.set(episodeId, requestId);
    const result = await cancelEpisode(agendaId, episodeId, requestId);
    recordEpisode(result, agendaId);
    pendingStops.current.delete(episodeId);
  });
  // A goal's three acts. The control plane keeps the goal's state; after each the goals are read at once, so the page says what happened.
  const pauseGoal = (sessionId: string) => void operation(async () => { await pauseResearchGoal(projectId, sessionId); await loadGoals(true); });
  const resumeGoal = (sessionId: string) => void operation(async () => { await resumeResearchGoal(projectId, sessionId); await loadGoals(true); });
  /** Stopping the round that is going stops the goal (the control plane writes that down when the round ends). */
  const stopRound = (runId: string) => void operation(async () => { await cancelWebAgentRun(runId); await loadGoals(true); });
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
  const onResearchStarted = (run: WebAgentRun) => {
    goalRequest.current = null;
    setStarting(false); setChosen(true); setSelectedRound(null); setTab("results");
    setGoalRuns(old => [run, ...(old ?? []).filter(item => item.id !== run.id)]);
    if (typeof run.sessionId === "string") setSelectedGoal(goalKey(run.sessionId, run.id));
    void loadGoals();
  };
  const choose = (key: string) => {
    if (operating.current) return;
    setChosen(true); setSelectedEpisodeId(null); setSelectedRound(null); setTab("results");
    if (key.startsWith("goal:")) { setSelectedGoal(key.slice(5)); return; }
    setSelectedGoal(null); setSelectedId(key.slice(7));
  };

  const loaded = agendas !== null;
  // Nothing is known of the long goals until their list has been read, or when it could not be: the recipe for a first research is not
  // shown over a read that is still out or that failed, where it would say there is none.
  const nothing = loaded && !error && agendas.length === 0 && goals.length === 0 && goalRuns !== null && !goalError;
  const reading = !error && (!loaded || (agendas.length === 0 && goalRuns === null && !goalError));
  const runId = goal ? round?.id ?? null : execution?.payload.runId ?? null;
  const observedTitle = goal ? goalTitle(goal) : selected?.payload.title;
  // What is on show is the goal or the task chosen in the queue.
  const subject = Boolean(goal || selected);
  const showViews = loaded && !nothing && !reading && subject;
  const canStart = longFeature === "enabled";
  // A read that fails while the page is open does not take away what it showed: the error is said above it and the next read that succeeds
  // clears it. Only a first read that failed (nothing was ever shown) is the error alone.
  const shown = loaded && (queue.length > 0 || subject);
  // The header says the two things that start from here. With nothing yet the standby scene carries them and the header does not repeat them.
  const actionPlan: PageActionPlan = {
    primary: { id: "start-research", label: "发起研究", disabled: !canStart, onSelect: () => setStarting(true) },
    secondary: [{ id: "connect-data", label: "接入数据", kind: "set", disabled: busy, onSelect: connectData }],
  };
  const files = selected ? ownEpisodes.flatMap(item => (item.payload.artifactRefs ?? [])
    .filter(ref => ref.projectId === projectId && ref.runId === item.payload.runId && ref.sessionId === item.payload.sessionId && SAFE_RUN.test(ref.runId) && safeWorkspacePath(ref.path))
    .map(ref => ({ runId: ref.runId, path: ref.path, at: item.payload.createdAt }))) : [];
  const goalFiles = goal ? goalFilesOf(goal) : [];
  const ledgerRun = holder?.payload.runId ? goalRuns?.find(item => item.id === holder.payload.runId) ?? null : null;

  // The one path to the conversation of what is on show: the 对话 view. For a goal it is the goal's own conversation, for a scheduled task
  // the task's (the page the three buttons used to open elsewhere).
  const spend = goal ? goalSpend(goal) : null;
  const subline = selected ? (execution ? `${runState(execution.payload)} · ${at(execution.payload.createdAt)}` : historyError ? "执行记录暂不可用" : history ? "还没有执行过" : "正在载入执行记录")
    : goal ? ["长期研究", `已推进 ${goal.rounds.length} 轮`, spend === null ? "" : `累计消耗 ${formatLingdou(spend)}`].filter(Boolean).join(" · ") : "";
  // Only where the deployment keeps goals: a round going can be paused or stopped, a goal at rest can be taken up again, a finished one neither.
  const goalService = goalStates?.available === true;
  const goalState = goal ? stateOf(goal) : null;
  const goalLive = goal ? roundModeOf(goal.latest, observed) === "running" : false;
  const canPause = goalService && (goalState?.status === "active" || (goalLive && goalState?.status !== "paused" && goalState?.status !== "stopped"));
  const canResume = goalService && !goalLive && (goalState?.status === "paused" || goalState?.status === "stopped" || goalState?.status === "waiting" || goalState?.status === "interrupted");
  const resting = goal && !goalLive ? restingNote(goalState) : null;
  const subjectRow = subject && <section aria-label="当前研究" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
    <p className="min-w-0 truncate text-caption text-text-3">{subline}</p>
    <div className="flex flex-wrap items-center gap-2">
      {selected && (runningEpisode ? <Button variant="secondary" actionKind="set" disabled={busy} onClick={() => stopExecution(selected.id, runningEpisode.id)}>停止本次</Button>
        : <Button variant="secondary" actionKind="start" disabled={busy || !available || !activeAgenda(selected) || !history || !!historyError || history.agendaId !== selected.id} onClick={() => runNow(selected.id)}>立即运行</Button>)}
      {selected && <Button variant="secondary" actionKind="set" disabled={busy || !available || !activeAgenda(selected)} onClick={() => { setDirection(""); setSteering(true); }}>调整研究方向</Button>}
      {goal && resting && <p className="text-caption text-text-3">{resting}</p>}
      {goal && canPause && <Button variant="secondary" actionKind="set" disabled={busy} onClick={() => pauseGoal(goal.sessionId)}>暂停</Button>}
      {goal && goalService && goalLive && <Button variant="secondary" actionKind="set" disabled={busy} onClick={() => stopRound(goal.latest.id)}>停止本轮</Button>}
      {goal && canResume && <Button variant="secondary" actionKind="start" disabled={busy} onClick={() => resumeGoal(goal.sessionId)}>继续</Button>}
      <Button variant="secondary" onClick={() => setTab("conversation")}>打开对话</Button>
    </div>
  </section>;

  const body = !showViews ? null
    : tab === "conversation"
      ? goal ? <NativeResearchPane key={`${projectId}:${goal.sessionId}`} projectId={projectId} sessionId={goal.sessionId} onClose={() => setTab("results")} />
        : selected ? <TaskPane agenda={selected} execution={execution} lock={holder} ledgerRun={ledgerRun} projectId={projectId} /> : null
      : tab === "records"
        ? goal ? <GoalRounds goal={goal} round={round} busy={busy} onRound={setSelectedRound} />
          : selected ? <section aria-label="执行记录" className="space-y-2">
            <h3 className="text-ui font-semibold text-text">执行记录</h3>
            {historyError && <LoadError message={historyError} onRetry={() => void loadHistory()} />}
            {!history && !historyError ? <p role="status" className="text-ui text-text-3">正在载入</p> : ownEpisodes.length === 0 ? (history ? <p className="text-ui text-text-3">还没有执行过</p> : null)
              : <List divided>{ownEpisodes.map(item => {
                const itemFiles = (item.payload.artifactRefs ?? []).filter(ref => ref.projectId === projectId && ref.runId === item.payload.runId && ref.sessionId === item.payload.sessionId && SAFE_RUN.test(ref.runId) && safeWorkspacePath(ref.path));
                return <ListRow key={item.id} title={`${runState(item.payload)} · ${at(item.payload.createdAt) || "时间未知"}`} selected={execution?.id === item.id} onOpen={() => setSelectedEpisodeId(item.id)}
                  meta={itemFiles.length ? <span className="flex flex-wrap gap-x-3">{itemFiles.map(file => <Link key={`${file.runId}:${file.path}`} className="break-all text-accent underline" to={snapshotHref(file.runId, file.path)}>{file.path.split("/").pop()}</Link>)}</span> : undefined} />;
              })}</List>}
            {history?.nextCursor && <Button variant="text" disabled={historyBusy} onClick={() => void loadHistory(history.nextCursor ?? undefined)}>查看更早记录</Button>}
          </section> : null
        : goal ? <ResultsPanel progress={null} files={goalFiles} />
          : selected ? <div className="grid gap-6 lg:grid-cols-2">
            <ResultsPanel progress={progress?.agendaId === selectedId ? progress : null} files={files} />
            <ResearchDataPanel materials={progress?.agendaId === selectedId ? progress.materials : []} loading={!progress && !progressError} error={progressError} busy={busy} databaseAvailable={databaseAvailable} onUpload={upload} onPick={() => setPicking(true)} onDatabase={() => setDatabaseFor("study")} onRemove={sourceId => void operation(() => removeAgendaMaterial(selected.id, sourceId))} onRetry={() => void loadProgress()} />
          </div> : null;

  // The observatory leads the page (owner, 2026-10-28); the rest of the research is its views under the tabs.
  const introduction = <div className="space-y-6">
    {longFeature === "error" && <LoadError message="发起研究暂时不可用。" onRetry={() => void loadLongFeature()} />}
    {longFeature === "disabled" && <p className="text-ui text-text">这个账号暂未开通发起研究。</p>}
    {error && <LoadError message={error} onRetry={() => void load()} />}
    {goalError && <LoadError message="长期研究暂时无法载入。" onRetry={() => void loadGoals()} />}
    {!available && <p className="text-ui text-text">定时执行暂不可用，已有成果可以照常查看。</p>}
    {holder && <ConversationHeldNote onStop={selected && holder.payload.agendaId === selected.id ? () => stopExecution(selected.id, holder.id) : undefined} busy={busy}
      otherTaskId={!selected || holder.payload.agendaId !== selected.id ? holder.payload.agendaId : undefined} />}
    {actionError && !steering && <p role="alert" className="text-ui text-error">{actionError}</p>}
    {actionNotice && <p role="status" className="text-ui text-text">{actionNotice}</p>}
    {reading && <div role="status" aria-label="正在载入研究" className="h-64 animate-pulse rounded-card bg-surface-2" />}
    {!reading && (!error || shown) && <div className="space-y-2">
      {queue.length > 0 && <ResearchQueue entries={queue} selected={queueSelected} disabled={busy} onSelect={choose} />}
      {subjectRow}
      <ResearchObservatory runId={runId} title={observedTitle} onOpenFile={openFile} onObserved={setObserved} standbyActions={nothing ? <>
        <Button disabled={!canStart} onClick={() => setStarting(true)}>发起研究</Button>
        <Button variant="secondary" actionKind="set" disabled={busy} onClick={connectData}>接入数据</Button>
      </> : undefined} />
    </div>}
  </div>;

  // With nothing yet the standby scene carries the two ways to begin; the header does not repeat them.
  return <PageShell title="主动科研" width="wide" actionPlan={nothing ? undefined : actionPlan}
    introduction={introduction}
    activity={shownWork ? { label: shownWork.label, startedAt: shownWork.since } : undefined}
    tabs={showViews ? { label: "研究视图", items: RESEARCH_TABS, value: tab, onChange: value => setTab(value as ResearchTab), panelId: "research-view" } : undefined}>
    <div className="space-y-6">
      {body}

      {steering && selected && <FormDialog title="调整研究方向" busy={busy} onClose={() => { if (!busy) setSteering(false); }}><div className="space-y-4">
        <Textarea label="希望研究如何调整" value={direction} maxLength={4000} onChange={event => setDirection(event.target.value)} />
        <p className="text-ui text-text">{liveSteer ? "研究正在进行，研究员会在下一步按这个方向调整。" : "这条方向会用在下一次执行，不会改变当前执行。"}</p>
        {actionError && <p role="alert" className="text-ui text-error">{actionError}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setSteering(false)}>取消</Button><Button actionKind="start" disabled={busy || !direction.trim()} onClick={submitDirection}>提交方向</Button></div>
      </div></FormDialog>}
      {(databaseFor === "knowledge-base" || (databaseFor === "study" && selected)) && <ResearchDatabaseDialog key={`${projectId}:${databaseFor === "study" ? selected?.id : ""}`} projectId={projectId} agendaId={databaseFor === "study" ? selected?.id : undefined} onClose={() => setDatabaseFor(null)} onCaptured={() => { void load(true); void loadProgress(true); }} />}
      {picking && selected && <FormDialog title="从知识库添加资料" busy={busy} onClose={() => { if (!busy) setPicking(false); }}><MaterialPicker projectId={projectId} taken={(selected.payload.materials ?? []).map(item => item.sourceId)} busy={busy} onCancel={() => setPicking(false)} onChoose={sourceIds => { setPicking(false); void operation(() => addAgendaMaterials(selected.id, { sourceIds })); }} /></FormDialog>}
      {starting && <StartResearchDialog request={goalRequest} onClose={() => setStarting(false)} onStarted={onResearchStarted} />}
      {intake && <FormDialog title="接入数据" onClose={() => setIntake(false)}><div className="flex flex-wrap gap-2">
        <Button actionKind="set" onClick={connectFiles}>上传文件</Button>
        <Button variant="secondary" onClick={() => { setIntake(false); setDatabaseFor("knowledge-base"); }}>从数据库导入</Button>
      </div></FormDialog>}
    </div>
  </PageShell>;
}

/**
 * 「发起研究」: the goal in the person's words. The same goal retried is the same request, so a lost answer cannot start it twice: the
 * request lives with the page and not with the dialog, because a person whose answer was lost closes the dialog and opens it again, and the
 * goal is started once or not at all until the page knows it started (`onStarted` clears it).
 */
function StartResearchDialog({ request, onClose, onStarted }: { request: MutableRefObject<ResearchGoalRequest | null>; onClose: () => void; onStarted: (run: WebAgentRun) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = async () => {
    const goal = text.trim();
    if (!goal || busy) return;
    if (request.current?.text !== goal) request.current = newResearchGoalRequest(goal);
    setBusy(true); setFailure(null);
    try { onStarted(await startResearchGoal(request.current)); }
    catch (caught) { setFailure(productErrorMessage(caught)); setBusy(false); }
  };
  return <FormDialog title="发起研究" busy={busy} dirty={text.trim().length > 0} onClose={() => { if (!busy) onClose(); }}><div className="space-y-4">
    <Textarea label="研究目标" rows={5} value={text} maxLength={4000} placeholder="例如：评估 SGLT2 抑制剂对射血分数保留型心衰的长期获益，产出一份综述" onChange={event => setText(event.target.value)} />
    {failure && <p role="alert" className="text-ui text-error">{failure}</p>}
    <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button actionKind="start" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? "正在启动" : "开始研究"}</Button></div>
  </div></FormDialog>;
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

/** The files the rounds of a long goal handed over: a file a round after round rewrote is one row, the newest. */
function goalFilesOf(goal: ObservedResearchGoal): Array<{ runId: string; path: string; at?: string }> {
  const newest = new Map<string, { runId: string; path: string; at?: string }>();
  for (const run of goal.rounds) {
    if (!SAFE_RUN.test(run.id)) continue;
    const at = run.finishedAt ?? run.startedAt;
    for (const path of new Set([...(run.outputFiles ?? []), ...(run.presentedFiles ?? [])])) {
      if (!safeWorkspacePath(path)) continue;
      const old = newest.get(path);
      if (!old || Date.parse(at) > Date.parse(old.at ?? "")) newest.set(path, { runId: run.id, path, at });
    }
  }
  return [...newest.values()];
}

/** A long goal's rounds: the observatory shows the round that is selected. */
function GoalRounds({ goal, round, busy, onRound }: { goal: ObservedResearchGoal; round: WebAgentRun | null; busy: boolean; onRound: (id: string) => void }) {
  return <section aria-label="推进记录" className="space-y-2">
    <h3 className="text-ui font-semibold text-text">推进记录</h3>
    <List divided>{goal.rounds.map((run, index) => <ListRow key={run.id} title={`第 ${goal.rounds.length - index} 轮 · ${QUEUE_MODE_WORD[roundMode(run)]}`}
      trailing={<span className="text-caption text-text-3">{at(run.startedAt)}</span>} selected={round?.id === run.id} onOpen={busy ? undefined : () => onRound(run.id)} />)}</List>
  </section>;
}

/** The least a conversation pane is high, so a short window still holds the composer and some of the conversation. */
const PANE_MIN_HEIGHT = 360;

/**
 * The shell's resident native conversation, placed inside this page without creating another composer.
 *
 * The resident frame is laid over this element's rectangle (`SessionFrameHost`) and the shell clips at the window's bottom, so a pane taller
 * than what the window leaves below its top loses the frame's bottom, the composer first. The pane is therefore as tall as the window leaves
 * below its top, measured once the page has scrolled to it and again when the window changes size.
 */
function NativeResearchPane({ projectId, sessionId, onClose }: { projectId: string; sessionId: string; onClose: () => void }) {
  const pane = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element) return undefined;
    const withdraw = registerTaskPane({ element, projectId, sessionId });
    element.scrollIntoView?.({ block: "start" });
    const fit = () => {
      const next = Math.max(PANE_MIN_HEIGHT, Math.floor(window.innerHeight - Math.max(0, element.getBoundingClientRect().top)));
      setHeight(old => (old === next ? old : next));
    };
    fit();
    // Once more after the first layout, where the scroll to the pane may have settled somewhere else than the first read saw.
    const settle = window.requestAnimationFrame?.(fit);
    window.addEventListener("resize", fit);
    return () => { withdraw(); window.removeEventListener("resize", fit); if (settle !== undefined) window.cancelAnimationFrame?.(settle); };
  }, [projectId, sessionId]);
  return <section aria-label="研究对话" className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-ui font-semibold text-text">研究对话</h2><Button variant="secondary" onClick={onClose}>收起对话</Button></div>
    <div ref={pane} role="region" aria-label="原生研究对话" className="relative" style={{ height: height ?? "100dvh", minHeight: PANE_MIN_HEIGHT }} />
  </section>;
}
