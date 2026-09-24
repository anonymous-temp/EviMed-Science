import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CalendarClock, Plus } from "lucide-react";
import { directionVerdict, STOPPING_RULES } from "@evimed/domain";
import { getWebProjectId } from "@/lib/apiClient";
import { createAgenda, getDigest, listAgendas, listEpisodes, markDigestOpened, scheduleAgenda, startAgenda, stopAgenda,
  type AgendaRecord, type EpisodeRecord } from "@/lib/autopilotClient";
import { listInbox } from "@/lib/inboxClient";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { chatPath } from "@/lib/runLocation";
import { formatDay } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { Input } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { Switch } from "@/components/ui/Switch";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";

function pendingFollowUps(agenda: AgendaRecord): number {
  return (agenda.payload.followUps ?? []).filter((item) => !item.consumedBy).length;
}

/**
 * The kinds of work an agenda may do, in the product's words.
 *
 * Mirrors `@evimed/domain`'s `AUTOPILOT_TASK_TYPES`; the service validates
 * against that list, so a value here that is not there is refused rather than
 * silently accepted. Listed in the order a researcher would build one up:
 * watch the literature, then check what changed, then look further.
 */
const TASK_TYPE_LABELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "literature-sentinel", label: "文献哨兵" },
  { value: "evidence-update", label: "证据更新" },
  { value: "signal-monitoring", label: "安全信号监测" },
  { value: "data-prospecting", label: "数据探查" },
  { value: "hypothesis-suggestion", label: "假设建议" },
  { value: "writing-pipeline", label: "成稿流水线" },
];

/** A run's state, said in a task's history only when it is not simply done. */
const EPISODE_STATE: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  failed: "未完成",
  canceled: "已取消",
};

/**
 * What the platform picks when the researcher says nothing about it.
 *
 * ¥100 a turn, ¥500 a day, ¥3,000 a week: an ordered triple the service
 * accepts and far above what any turn has cost (a deep run measured ¥3.4–5.5),
 * because the owner ruled on 2026-09-21 that no money ceiling may stop the
 * product from being exercised while it is being tested. 07:00 is before a
 * working day in the researcher's own zone.
 */
const AGENDA_DEFAULTS = {
  taskTypes: ["literature-sentinel"],
  maxEpisodeCny: "100",
  dailyBudgetCny: "500",
  weeklyBudgetCny: "3000",
  scheduleHour: "7",
} as const;

/**
 * Why a task stopped itself, in a few words — keyed on the reasons the
 * domain's stopping rules write (`directionVerdict`), so a rule reworded there
 * is not silently shown raw here. The pause a researcher made themselves, and
 * the one a new task starts in, say only 「已暂停」: the switch already shows
 * who turned it off.
 */
const PAUSE_REASONS: ReadonlyMap<string, string> = (() => {
  const calm = { episodesWithoutGatedClaim: 0, consecutiveFailures: 0, daysSinceDigestOpened: 0, userRejected: false };
  const rules = STOPPING_RULES;
  return new Map([
    [directionVerdict({ ...calm, daysSinceDigestOpened: rules.daysWithoutOpeningDigestBeforePausing }).reason,
      `${rules.daysWithoutOpeningDigestBeforePausing} 天没有查看结果`],
    [directionVerdict({ ...calm, consecutiveFailures: rules.consecutiveFailuresBeforePausingTaskType }).reason,
      `连续 ${rules.consecutiveFailuresBeforePausingTaskType} 次未完成`],
    [directionVerdict({ ...calm, userRejected: true }).reason, "你驳回了这个方向"],
    [directionVerdict({ ...calm, episodesWithoutGatedClaim: rules.episodesWithoutGatedClaimBeforeParking }).reason,
      `连续 ${rules.episodesWithoutGatedClaimBeforeParking} 次没有新结论`],
  ]);
})();

/** A name for an agenda the researcher did not name: their own sentence. */
function defaultTitle(direction: string): string {
  const text = direction.trim().replace(/\s+/g, " ");
  return text.length <= 60 ? text : `${text.slice(0, 59)}…`;
}

/**
 * The directions a sentence names. A researcher writing 「司美格鲁肽的胰腺炎
 * 与心血管结局」 means three of them; splitting on the punctuation that already
 * separates them is what makes 「研究方向」 a field they never have to fill.
 */
function splitTopics(direction: string): string[] {
  const parts = direction.split(/[,，、;；\n]|\s和\s|与/).map((value) => value.trim()).filter(Boolean);
  return parts.length > 0 ? parts.slice(0, 12) : [];
}

/**
 * Today, in the agenda's own zone.
 *
 * `toISOString().slice(0, 10)` is the UTC date, and the create form records
 * the researcher's zone precisely because the two differ: between 00:00 and
 * 08:00 Beijing time it names yesterday, so 「立即运行」 scheduled the
 * previous day's episode (2026-09-16 walk, U7). Read per agenda, because two
 * agendas may not share a zone.
 */
function todayIn(timeZone?: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/**
 * The task's line under its name: how often, and then when it next runs — or
 * that it is paused, and why when a stopping rule paused it. The schedule
 * runs once a day at the hour, so 「下次」 is today until today's run has been
 * scheduled, and tomorrow after (the scheduler's own test, server.mjs).
 */
function scheduleLine(agenda: AgendaRecord): string {
  const payload = agenda.payload;
  const frequency = `每天 ${String(payload.scheduleHour).padStart(2, "0")}:00`;
  const reason = payload.pauseReason ? PAUSE_REASONS.get(payload.pauseReason) : undefined;
  const state = payload.status === "active"
    ? `下次 ${payload.lastScheduledDate === todayIn(payload.timeZone) ? "明天" : "今天"}`
    : reason ? `已暂停：${reason}` : "已暂停";
  const followUps = pendingFollowUps(agenda);
  return [frequency, state, followUps > 0 ? `${followUps} 条追问待答` : ""].filter(Boolean).join(" · ");
}

/**
 * The run a task's row opens, the words at the row's end, and what opening it
 * does, said to a screen reader after the task's name: the newest run while
 * it is still going, otherwise the newest one that has a conversation. The
 * server lists a project's runs newest first.
 */
function lastResult(episodes: readonly EpisodeRecord[]): { episode: EpisodeRecord | null; label: string; opens: string } {
  const newest = episodes[0];
  if (newest && (newest.payload.status === "queued" || newest.payload.status === "running")) {
    return { episode: newest.payload.sessionId ? newest : null, label: "进行中", opens: "打开正在进行的这次运行" };
  }
  const finished = episodes.find((episode) => episode.payload.sessionId) ?? null;
  if (!finished) return { episode: null, label: "还没有结果", opens: "" };
  return finished.payload.status === "failed"
    ? { episode: finished, label: "上次未完成", opens: "打开上次运行" }
    : { episode: finished, label: "上次结果", opens: "打开上次结果" };
}

/**
 * Creating a scheduled research task: one sentence, and the rest drafted.
 *
 * Manus, ChatGPT and Kimi all take a description rather than a form and hand
 * back an editable card of title, frequency and content. This asks for the
 * one thing only the researcher knows, picks the rest, and keeps every field
 * editable behind 「高级」. The API is unchanged. A task is created paused —
 * the service sets `enabled: false` — so this spends nothing until the
 * researcher turns its switch on.
 */
function NewAgendaForm({ projectId, onCreated, onError, onCancel }: {
  projectId: string;
  onCreated: () => void;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const [direction, setDirection] = useState("");
  const [title, setTitle] = useState("");
  const [taskTypes, setTaskTypes] = useState<string[]>([...AGENDA_DEFAULTS.taskTypes]);
  const [maxEpisodeCny, setMaxEpisodeCny] = useState<string>(AGENDA_DEFAULTS.maxEpisodeCny);
  const [dailyBudgetCny, setDailyBudgetCny] = useState<string>(AGENDA_DEFAULTS.dailyBudgetCny);
  const [weeklyBudgetCny, setWeeklyBudgetCny] = useState<string>(AGENDA_DEFAULTS.weeklyBudgetCny);
  const [scheduleHour, setScheduleHour] = useState<string>(AGENDA_DEFAULTS.scheduleHour);
  const [saving, setSaving] = useState(false);

  const topicList = splitTopics(direction);
  const episode = Number(maxEpisodeCny);
  const daily = Number(dailyBudgetCny);
  const weekly = Number(weeklyBudgetCny);
  // The service refuses an unordered triple with `autopilot_budget_invalid`.
  // Saying so before the request is what keeps that refusal from being the
  // first the researcher hears of the rule — and these are only reachable
  // under 「高级」, so the defaults can never trip it.
  const budgetsOrdered = [episode, daily, weekly].every((value) => Number.isFinite(value) && value > 0)
    && episode <= daily && daily <= weekly;
  const ready = topicList.length > 0 && taskTypes.length > 0 && budgetsOrdered;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    try {
      await createAgenda({
        projectId,
        title: title.trim() || defaultTitle(direction),
        topics: topicList,
        taskTypes,
        maxEpisodeCny: episode,
        dailyBudgetCny: daily,
        weeklyBudgetCny: weekly,
        scheduleHour: Number(scheduleHour),
        // The researcher's zone, not the container's. The learning window was
        // written in Beijing time and evaluated in UTC for exactly this reason.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      });
      onCreated();
    } catch (caught) {
      onError(productErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <Input label="想持续跟进什么？" value={direction} required maxLength={400}
        placeholder="例如：司美格鲁肽的胰腺炎与心血管结局"
        onChange={(event) => setDirection(event.target.value)} />
      <Disclosure summary="高级">
        <div className="space-y-3">
          <Input label="名称" value={title} maxLength={200}
            placeholder={direction.trim() ? defaultTitle(direction) : undefined}
            onChange={(event) => setTitle(event.target.value)} />
          <fieldset className="space-y-2">
            <legend className="mb-2 text-ui font-medium text-text">任务类型</legend>
            <div className="flex flex-wrap gap-3">
              {TASK_TYPE_LABELS.map((type) => (
                <label key={type.value} className="flex items-center gap-1.5 text-ui text-text">
                  <input type="checkbox" checked={taskTypes.includes(type.value)}
                    onChange={(event) => setTaskTypes((current) => event.target.checked
                      ? [...current, type.value]
                      : current.filter((value) => value !== type.value))} />
                  {type.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="单次上限 ¥" type="number" min="0" step="0.5" value={maxEpisodeCny} onChange={(event) => setMaxEpisodeCny(event.target.value)} />
            <Input label="每日上限 ¥" type="number" min="0" step="1" value={dailyBudgetCny} onChange={(event) => setDailyBudgetCny(event.target.value)} />
            <Input label="每周上限 ¥" type="number" min="0" step="1" value={weeklyBudgetCny} onChange={(event) => setWeeklyBudgetCny(event.target.value)} />
            <Input label="每天运行时刻" type="number" min="0" max="23" step="1" value={scheduleHour} onChange={(event) => setScheduleHour(event.target.value)} />
          </div>
          {!budgetsOrdered && <p className="text-caption text-danger">需单次 ≤ 每日 ≤ 每周，且都大于 0</p>}
        </div>
      </Disclosure>
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready || saving} loading={saving}>创建</Button>
        <Button variant="secondary" disabled={saving} onClick={onCancel}>取消</Button>
      </div>
    </form>
  );
}

/**
 * A task's runs, newest first: one per scheduled day, each a finished
 * conversation to open — Manus's replay is a completed session the reader
 * opens; so is this, with no scrubber and no speed. The conversation's own
 * 运行 view is the process.
 */
function EpisodeHistory({ projectId, agenda, onOpen }: { projectId: string; agenda: AgendaRecord; onOpen: (episode: EpisodeRecord) => void }) {
  const [episodes, setEpisodes] = useState<EpisodeRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setEpisodes((await listEpisodes(projectId, agenda.id)).items); }
    catch (caught) { setEpisodes([]); setError(productErrorMessage(caught)); }
  }, [projectId, agenda.id]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (episodes === null) return <FilesSkeleton />;
  if (episodes.length === 0) return <p className="text-ui text-text-3">还没有运行</p>;
  return (
    <List label="运行">
      {episodes.map((episode) => {
        const state = EPISODE_STATE[episode.payload.status];
        return (
          <ListRow
            key={episode.id}
            title={formatDay(episode.payload.date) || episode.payload.date}
            onOpen={episode.payload.sessionId ? () => onOpen(episode) : undefined}
            trailing={state ? <span>{state}</span> : undefined}
          />
        );
      })}
    </List>
  );
}

/**
 * 主动科研 — scheduled research tasks, and what each last produced.
 *
 * The owner's ruling (2026-09-22): the core of proactive research is the
 * scheduled task and its reproducible result — the finished conversation of
 * its last run, which the researcher opens (「相当于 AI 自动模拟用户行为提前
 * 做了一遍，用户可以点进去看一下」). So the page is one list: a row is a task,
 * its schedule and a switch, and the row — 「上次结果 ›」 — opens that run's
 * conversation. The briefing cards with their adopt / reject / follow-up
 * buttons and the 「需要你决定」 block left the page (plan §5.7); what waits
 * on the researcher is one line pointing at the inbox, where it is resolved.
 *
 * Opening a result also records that its briefing was read: the stopping rule
 * that pauses a task nobody looks at (`daysWithoutOpeningDigestBeforePausing`)
 * counts that record, and the briefing is no longer shown anywhere else.
 */
export function AutopilotPage() {
  // A project switch in the sidebar reloads the page for the new project.
  useProjectStore((state) => state.currentId);
  const projectId = getWebProjectId();
  return <ProjectAutopilotPage key={projectId} projectId={projectId} />;
}

function ProjectAutopilotPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const digestId = searchParams.get("digest");
  const [agendas, setAgendas] = useState<AgendaRecord[] | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState(0);
  /** The agenda a researcher asked to run now, held until they confirm the
   *  spend: running is the one control on this page that costs money. */
  const [running, setRunning] = useState<AgendaRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState<AgendaRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    const current = ++generation.current;
    setError(null);
    if (!background) setAgendas(null);
    try {
      const [agendaPage, episodePage] = await Promise.all([listAgendas(projectId), listEpisodes(projectId)]);
      if (current !== generation.current) return;
      setAgendas(agendaPage.items); setEpisodes(episodePage.items);
    } catch (loadError) {
      if (current !== generation.current) return;
      setAgendas([]); setError(`主动科研状态不可用：${productErrorMessage(loadError)}`);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
    const requests = generation;
    return () => { requests.current++; };
  }, [load]);

  // What waits on the researcher — questions and reviews in the inbox — is a
  // count and a way there; the inbox is where each one is answered.
  useEffect(() => {
    let active = true;
    void listInbox({ unread: true })
      .then((page) => {
        if (active) setDecisions(page.items.filter((item) => item.noticeType !== "notify" && !item.resolvedAt).length);
      })
      .catch(() => { /* isolated: the count is a pointer, and the inbox has the items */ });
    return () => { active = false; };
  }, []);

  /** A run's result is its conversation; opening it is reading its briefing. */
  const openResult = useCallback((episode: EpisodeRecord) => {
    const { sessionId, digestId: briefing } = episode.payload;
    if (!sessionId) return;
    if (briefing) void markDigestOpened(briefing).catch(() => { /* the stopping rule's record; never blocks the reader */ });
    navigate(chatPath(sessionId));
  }, [navigate]);

  // A briefing's address — what an inbox notice or a Feishu card carries —
  // opens the conversation of the run that produced it, in whichever of the
  // account's projects that run is. A briefing with no conversation, or one
  // that cannot be read, lands on the list.
  useEffect(() => {
    if (!digestId) return;
    let live = true;
    void (async () => {
      try {
        const digest = await getDigest(digestId);
        const runs = await listEpisodes(digest.projectId);
        const episode = runs.items.find((item) => item.payload.sessionId
          && (item.payload.digestId === digest.id || digest.payload.episodeIds?.includes(item.id))) ?? null;
        if (live && episode?.payload.sessionId) {
          void markDigestOpened(digest.id).catch(() => { /* never blocks the reader */ });
          navigate(digest.projectId === getWebProjectId()
            ? chatPath(episode.payload.sessionId)
            : `/app/runs?run=${encodeURIComponent(episode.payload.runId ?? episode.payload.sessionId)}`, { replace: true });
          return;
        }
      } catch { /* fall through to the list */ }
      if (live) setSearchParams((current) => { const next = new URLSearchParams(current); next.delete("digest"); return next; }, { replace: true });
    })();
    return () => { live = false; };
  }, [digestId, navigate, setSearchParams]);

  const mutate = async (operation: () => Promise<unknown>) => {
    const current = generation.current;
    setBusy(true);
    try { await operation(); if (current === generation.current) await load({ background: true }); }
    catch (operationError) { if (current === generation.current) toast.error(productErrorMessage(operationError)); }
    finally { setBusy(false); }
  };

  const runsOf = (agenda: AgendaRecord) => episodes.filter((episode) => episode.payload.agendaId === agenda.id);

  return (
    <PageShell
      title="主动科研"
      actions={<Button disabled={busy} onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />新建定时研究</Button>}
    >
      {decisions > 0 && (
        <Link to="/app/inbox" className="mb-4 inline-flex rounded text-ui text-text-2 hover:text-text">{decisions} 项待你决定 →</Link>
      )}
      {error && <LoadError message={error} onRetry={() => void load()} className="mb-4" />}
      {agendas === null ? <FilesSkeleton /> : agendas.length === 0
        ? (error ? null : <EmptyState icon={CalendarClock} title="还没有定时研究。" />)
        : (
          <List label="定时研究" divided>
            {agendas.map((agenda) => {
              const title = agenda.payload.title;
              const active = agenda.payload.status === "active";
              const result = lastResult(runsOf(agenda));
              const open = result.episode ? () => openResult(result.episode!) : undefined;
              return (
                <ListRow
                  key={agenda.id}
                  title={open ? <>{title}<span className="sr-only">：{result.opens}</span></> : title}
                  onOpen={open}
                  meta={scheduleLine(agenda)}
                  trailing={<>
                    {open
                      // The whole row opens the result; these words are its
                      // visible handle, so they are not a second tab stop.
                      ? <Button variant="text" size="sm" tabIndex={-1} aria-hidden="true" onClick={open}>{result.label} ›</Button>
                      : <span className="px-2 text-ui">{result.label}</span>}
                    <Switch checked={active} label={`定时运行「${title}」`} disabled={busy}
                      onChange={(on) => void mutate(() => (on ? startAgenda : stopAgenda)(agenda.id, agenda.revision))} />
                  </>}
                  menu={<Menu label={`「${title}」的更多操作`} items={[
                    ...(active ? [{ label: "立即运行", onSelect: () => setRunning(agenda), disabled: busy }] : []),
                    { label: "历史", onSelect: () => setHistory(agenda) },
                  ]} />}
                />
              );
            })}
          </List>
        )}

      {running && <ConfirmDialog
        tone="primary"
        title="立即运行？"
        body={`最多花费 ¥${running.payload.maxEpisodeCny}。`}
        confirmLabel="立即运行"
        onCancel={() => setRunning(null)}
        onConfirm={() => {
          const agenda = running;
          setRunning(null);
          void mutate(() => scheduleAgenda(agenda.id, todayIn(agenda.payload.timeZone)));
        }}
      />}
      {creating && (
        <Drawer title="新建定时研究" onClose={() => setCreating(false)}>
          <NewAgendaForm projectId={projectId} onCancel={() => setCreating(false)}
            onCreated={() => { setCreating(false); void load({ background: true }); }}
            onError={(message) => { setCreating(false); toast.error(message); }} />
        </Drawer>
      )}
      {history && (
        <Drawer
          title={history.payload.title}
          description={`每天 ${String(history.payload.scheduleHour).padStart(2, "0")}:00 · 单次 ¥${history.payload.maxEpisodeCny} · 每日 ¥${history.payload.dailyBudgetCny} · 每周 ¥${history.payload.weeklyBudgetCny}`}
          onClose={() => setHistory(null)}
          widthClassName="max-w-2xl"
        >
          <EpisodeHistory projectId={history.projectId} agenda={history} onOpen={(episode) => { setHistory(null); openResult(episode); }} />
        </Drawer>
      )}
    </PageShell>
  );
}
