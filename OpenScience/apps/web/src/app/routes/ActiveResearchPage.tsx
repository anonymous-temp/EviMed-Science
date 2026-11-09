import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { Link, useNavigate } from "react-router";
import { cancelWebAgentRun, getWebProjectId, listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { newResearchGoalRequest, startResearchGoal, type ResearchGoalRequest } from "@/lib/dispatch";
import { safeWorkspacePath } from "@/lib/claimCitations";
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
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import type { PageActionPlan } from "@/components/layout/HeaderActions";
import { List, ListRow } from "@/components/ui/ListRow";
import { ResearchDatabaseDialog } from "@/components/activeResearch/ResearchDatabaseDialog";
import { ResearchObservatory } from "@/components/activeResearch/ResearchObservatory";
import { QUEUE_MODE_WORD, ResearchQueue, type QueueEntry, type QueueMode } from "@/components/activeResearch/ResearchQueue";
import { roundModeOf, streamEnded, type ObservedRun } from "@/components/activeResearch/researchRunState";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Textarea } from "@/components/ui/Input";

class MaterialInputError extends Error {}

/**
 * How often the page reads again. The run list is the sidebar's own read of the same ledger (it makes the server recover runs, total the
 * usage and backfill), so it is read at the sidebar's pace and never faster.
 */
const POLL_RUNS_MS = 20_000;

/** Runs `read` every `ms`, except while the document is hidden or an action is under way (`operating`); returns what stops it. */
function pollEvery(read: () => void, ms: number, operating: { current: boolean }): () => void {
  const timer = window.setInterval(() => { if (!document.hidden && !operating.current) read(); }, ms);
  return () => window.clearInterval(timer);
}

const at = (value: string | null | undefined) => [formatDay(value), formatClock(value)].filter(Boolean).join(" ");
const SAFE_RUN = /^[A-Za-z0-9_-]{1,160}$/;

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
 * A project's active research, opened on what is at work: the observatory of the running research, with the queue of the rest above it.
 * New research is one thing to do here (a goal, in the person's words) and data one more; a scheduled task is made in 定时任务 (`/app/autopilot`).
 *
 * Anatomy: research inventory, selected observatory and its results, records or conversation.
 * Variants: long goals, with a detail view for the selection.
 * States: the observed round and saved records determine status, recovery and available actions.
 * Hit area: shared row, tab and action controls own the interactive targets.
 * Keyboard: inventory, tabs and the selected view remain in their reading order.
 * Long content: the main detail gives descriptions more width when both sections fit.
 * Theme: shared semantic surfaces, rules and status treatments.
 * Responsive: detail columns depend on the detail's width inside the workspace.
 * Verification: ActiveResearchPage.test.tsx and the active-research fixture walk.
 */
export function ActiveResearchPage() {
  useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  return <ResearchWorkspace key={projectId} projectId={projectId} />;
}

function ResearchWorkspace({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [goalRuns, setGoalRuns] = useState<WebAgentRun[] | null>(null);
  const [goalError, setGoalError] = useState(false);
  const [goalStates, setGoalStates] = useState<ResearchGoalList | null>(null);
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
  const [chosen, setChosen] = useState(false);
  const [selectedRound, setSelectedRound] = useState<string | null>(null);
  const [tab, setTab] = useState<ResearchTab>("results");
  const [observed, setObserved] = useState<ObservedRun | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [longFeature, setLongFeature] = useState<"loading" | "enabled" | "disabled" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [intake, setIntake] = useState(false);
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const [databaseAvailable, setDatabaseAvailable] = useState(false);
  const operating = useRef(false);
  // The request a goal is started with, kept across the dialog's closing and opening until the goal is known to have started.
  const goalRequest = useRef<ResearchGoalRequest | null>(null);
  const loadingGoals = useRef(false);
  const goalGeneration = useRef(0);
  const mounted = useRef(true);

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
  useEffect(() => { const requests = goalGeneration; mounted.current = true; void loadGoals(); void loadLongFeature(); return () => { mounted.current = false; requests.current++; loadingGoals.current = false; }; }, [loadGoals, loadLongFeature]);
  // The database entry is offered only where the deployment has the connector; an unknown answer hides it.
  useEffect(() => { void researchDatabaseStatus(projectId).then(status => { if (mounted.current) setDatabaseAvailable(status.available === true); }).catch(() => {}); }, [projectId]);
  const goals = observedResearchGoals(goalRuns ?? []);
  const stateOf = (item: ObservedResearchGoal) => stateOfGoal(item, goals, goalStates);
  // Until the person chooses, the page shows what is at work: a running goal, then whichever ran last.
  const openingGoal = chosen ? null : goals.find(item => item.latest.status === "running") ?? goals[0] ?? null;
  const goal = goals.find(item => item.key === selectedGoal) ?? openingGoal;
  const round = goal ? goal.rounds.find(item => item.id === selectedRound) ?? goal.latest : null;

  // The page keeps reading while it is open: the run list at the sidebar's pace, and at once when the stream says the round on screen is over.
  const reads = useRef({ runs: () => {} });
  reads.current = { runs: () => void loadGoals() };
  const ended = streamEnded(observed);
  useEffect(() => { if (ended) reads.current.runs(); }, [ended, observed?.runId]);
  useEffect(() => pollEvery(() => reads.current.runs(), POLL_RUNS_MS, operating), []);

  const queue: QueueEntry[] = goals.map(item => {
    const mode = goalMode(item, observed, stateOf(item));
    return { key: `goal:${item.key}`, title: goalTitle(item), kind: "长期" as const, mode,
      meta: roundModeOf(item.latest, observed) === "running" ? `本轮 ${at(item.latest.startedAt)} 开始` : mode === "running" ? "下一轮马上开始" : `最近一轮 ${at(item.latest.finishedAt ?? item.latest.startedAt)}` };
  }).sort((a, b) => Number(b.mode === "running" || b.mode === "queued") - Number(a.mode === "running" || a.mode === "queued"));
  const queueSelected = goal ? `goal:${goal.key}` : null;
  // Work that is going now, for the band's activity strip: the one on show first.
  const working = goals.filter(item => roundModeOf(item.latest, observed) === "running").map(item => ({ key: `goal:${item.key}`, label: `推进“${goalTitle(item)}”`, since: item.latest.startedAt }));
  const shownWork = working.find(item => item.key === queueSelected) ?? working[0];

  async function operation(action: () => Promise<unknown>) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setActionError(null); setActionNotice(null);
    try { await action(); }
    catch (caught) { if (mounted.current) setActionError(caught instanceof MaterialInputError ? caught.message : productErrorMessage(caught)); }
    finally { operating.current = false; if (mounted.current) setBusy(false); }
  }
  /** Picks files and puts them in the project's knowledge base; what was accepted comes back, nothing when the person picked nothing. */
  const uploadToKnowledgeBase = async (current: () => boolean) => {
    const files = await pickFiles(KNOWLEDGE_BASE_ACCEPT);
    if (!current()) throw new Error("项目已切换，请重新选择资料。");
    const { accepted, refused } = partitionKnowledgeBaseFiles(files);
    if (refused.length) throw new MaterialInputError(`部分文件无法添加：${refused.map(file => `${file.name}（${file.reason}）`).join("、")}`);
    if (!accepted.length) return accepted;
    if (accepted.length > 10) throw new MaterialInputError("每次最多添加 10 份资料，请分批选择。");
    const names = await uploadFilesToWorkspace(accepted, "knowledge-base", "base", projectId, current);
    if (names.length !== accepted.length) throw new Error("上传未完成，请到知识库查看后重试。");
    return accepted;
  };
  /** 「接入数据」: into the project's knowledge base, where its research reads it. */
  const connectFiles = () => { setIntake(false); void operation(async () => {
    const accepted = await uploadToKnowledgeBase(() => mounted.current && getWebProjectId() === projectId);
    if (accepted.length && mounted.current) setActionNotice(`已接入 ${accepted.length} 份资料，这个项目的研究都可以使用。`);
  }); };
  const connectData = () => { if (databaseAvailable) setIntake(true); else connectFiles(); };
  // A goal's three acts. The control plane keeps the goal's state; after each the goals are read at once, so the page says what happened.
  const pauseGoal = (sessionId: string) => void operation(async () => { await pauseResearchGoal(projectId, sessionId); await loadGoals(true); });
  const resumeGoal = (sessionId: string) => void operation(async () => { await resumeResearchGoal(projectId, sessionId); await loadGoals(true); });
  /** Stopping the round that is going stops the goal (the control plane writes that down when the round ends). */
  const stopRound = (runId: string) => void operation(async () => { await cancelWebAgentRun(runId); await loadGoals(true); });
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
    setChosen(true); setSelectedRound(null); setTab("results");
    if (key.startsWith("goal:")) setSelectedGoal(key.slice(5));
  };

  // Nothing is known of the goals until their list has been read, or when it could not be: the recipe for a first research is not
  // shown over a read that is still out or that failed, where it would say there is none.
  const nothing = goalRuns !== null && !goalError && goals.length === 0;
  const reading = goalRuns === null && !goalError;
  const runId = round?.id ?? null;
  const observedTitle = goal ? goalTitle(goal) : undefined;
  const showViews = !nothing && !reading && goal !== null;
  const canStart = longFeature === "enabled";
  // A read that fails while the page is open does not take away what it showed: the error is said above it and the next read that succeeds
  // clears it. Only a first read that failed (nothing was ever shown) is the error alone.
  const shown = queue.length > 0 || goal !== null;
  // The header says the two things that start from here. With nothing yet the standby scene carries them and the header does not repeat them.
  const actionPlan: PageActionPlan = {
    primary: { id: "start-research", label: "发起研究", disabled: !canStart, onSelect: () => setStarting(true) },
    secondary: [{ id: "connect-data", label: "接入数据", kind: "set", disabled: busy, onSelect: connectData }],
  };
  const goalFiles = goal ? goalFilesOf(goal) : [];

  const spend = goal ? goalSpend(goal) : null;
  const subline = goal ? ["长期研究", `已推进 ${goal.rounds.length} 轮`, spend === null ? "" : `累计消耗 ${formatLingdou(spend)}`].filter(Boolean).join(" · ") : "";
  // Only where the deployment keeps goals: a round going can be paused or stopped, a goal at rest can be taken up again, a finished one neither.
  const goalService = goalStates?.available === true;
  const goalState = goal ? stateOf(goal) : null;
  const goalLive = goal ? roundModeOf(goal.latest, observed) === "running" : false;
  const canPause = goalService && (goalState?.status === "active" || (goalLive && goalState?.status !== "paused" && goalState?.status !== "stopped"));
  const canResume = goalService && !goalLive && (goalState?.status === "paused" || goalState?.status === "stopped" || goalState?.status === "waiting" || goalState?.status === "interrupted");
  const resting = goal && !goalLive ? restingNote(goalState) : null;
  const subjectRow = goal && <section aria-label="当前研究" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
    <p className="min-w-0 truncate text-caption text-text-3">{subline}</p>
    <div className="flex flex-wrap items-center gap-2">
      {resting && <p className="text-caption text-text-3">{resting}</p>}
      {canPause && <Button variant="secondary" actionKind="set" disabled={busy} onClick={() => pauseGoal(goal.sessionId)}>暂停</Button>}
      {goalService && goalLive && <Button variant="secondary" actionKind="set" disabled={busy} onClick={() => stopRound(goal.latest.id)}>停止本轮</Button>}
      {canResume && <Button variant="secondary" actionKind="start" disabled={busy} onClick={() => resumeGoal(goal.sessionId)}>继续</Button>}
      <Button variant="secondary" onClick={() => setTab("conversation")}>打开对话</Button>
    </div>
  </section>;

  const body = !showViews || !goal ? null
    : tab === "conversation" ? <NativeResearchPane key={`${projectId}:${goal.sessionId}`} projectId={projectId} sessionId={goal.sessionId} onClose={() => setTab("results")} />
      : tab === "records" ? <GoalRounds goal={goal} round={round} busy={busy} onRound={setSelectedRound} />
        : <ResultsPanel files={goalFiles} />;

  // The observatory leads the page (owner, 2026-10-28); the rest of the research is its views under the tabs.
  const introduction = <div className="space-y-6">
    {longFeature === "error" && <LoadError message="发起研究暂时不可用。" onRetry={() => void loadLongFeature()} />}
    {longFeature === "disabled" && <p className="text-ui text-text">这个账号暂未开通发起研究。</p>}
    {goalError && <LoadError message="长期研究暂时无法载入。" onRetry={() => void loadGoals()} />}
    {actionError && <p role="alert" className="text-ui text-error">{actionError}</p>}
    {actionNotice && <p role="status" className="text-ui text-text">{actionNotice}</p>}
    {reading && <div role="status" aria-label="正在载入研究" className="h-64 animate-pulse rounded-card bg-surface-2" />}
    {!reading && (!goalError || shown) && <div className="space-y-2">
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
      {databaseOpen && <ResearchDatabaseDialog key={projectId} projectId={projectId} onClose={() => setDatabaseOpen(false)} onCaptured={() => {}} />}
      {starting && <StartResearchDialog request={goalRequest} onClose={() => setStarting(false)} onStarted={onResearchStarted} />}
      {intake && <FormDialog title="接入数据" onClose={() => setIntake(false)}><div className="flex flex-wrap gap-2">
        <Button actionKind="set" onClick={connectFiles}>上传文件</Button>
        <Button variant="secondary" onClick={() => { setIntake(false); setDatabaseOpen(true); }}>从数据库导入</Button>
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

/** What the research has produced: every file its rounds handed over. */
function ResultsPanel({ files }: { files: Array<{ runId: string; path: string; at?: string }> }) {
  return <section aria-label="研究成果" className="space-y-3">
    <h3 className="text-ui font-semibold text-text">研究成果</h3>
    {files.length === 0 ? <p className="text-ui text-text">执行完成后，产出文件会出现在这里。</p>
      : <ul className="space-y-1" aria-label="研究文件">{files.map(file => <li key={`${file.runId}:${file.path}`} className="flex items-baseline justify-between gap-3">
        <Link className="min-w-0 truncate text-ui text-accent underline" to={snapshotHref(file.runId, file.path)}>{file.path.split("/").pop()}</Link>
        {file.at && <span className="shrink-0 text-caption text-text-3">{at(file.at)}</span>}
      </li>)}</ul>}
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
    // Once more after the first layout, where the scroll to the pane may have settled somewhere else than the first read saw; and a window
    // that changes size moves what is above the pane a moment after the event, so it is read again then.
    const settle = window.requestAnimationFrame?.(fit);
    let settling: ReturnType<typeof setTimeout> | undefined;
    const resized = () => { fit(); clearTimeout(settling); settling = setTimeout(fit, 300); };
    window.addEventListener("resize", resized);
    return () => { withdraw(); window.removeEventListener("resize", resized); clearTimeout(settling); if (settle !== undefined) window.cancelAnimationFrame?.(settle); };
  }, [projectId, sessionId]);
  return <section aria-label="研究对话" className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-ui font-semibold text-text">研究对话</h2><Button variant="secondary" onClick={onClose}>收起对话</Button></div>
    <div ref={pane} role="region" aria-label="原生研究对话" className="relative" style={{ height: height ?? "100dvh", minHeight: PANE_MIN_HEIGHT }} />
  </section>;
}
