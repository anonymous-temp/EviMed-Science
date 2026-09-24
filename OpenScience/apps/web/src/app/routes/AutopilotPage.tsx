import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CalendarClock, History, PauseCircle, PlayCircle, Plus, Sparkles } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import { createAgenda, decideDigest, getDigest, listAgendas, listDigests, listEpisodes, markDigestOpened, scheduleAgenda, startAgenda, stopAgenda,
  type AgendaRecord, type DigestClaim, type DigestRecord, type EpisodeRecord } from "@/lib/autopilotClient";
import { productErrorMessage } from "@/lib/productClient";
import { chatPath } from "@/lib/runLocation";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { listInbox, type InboxItem } from "@/lib/inboxClient";
import { InboxBody } from "@/components/inbox/InboxBody";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTitle } from "@/components/layout/PageTitle";

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
const TASK_TYPE_LABEL: Record<string, string> = Object.fromEntries(TASK_TYPE_LABELS.map((type) => [type.value, type.label]));

/** An episode's state, in words: what happened to that night's run. */
const EPISODE_STATUS: Record<string, { text: string; tone: string }> = {
  queued: { text: "排队中", tone: "text-muted" },
  running: { text: "进行中", tone: "text-accent" },
  merged: { text: "已完成", tone: "text-ok" },
  failed: { text: "失败", tone: "text-error" },
  canceled: { text: "已取消", tone: "text-muted" },
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
 * Creating a scheduled research task: one sentence, and the rest drafted.
 *
 * Manus, ChatGPT and Kimi all take a description rather than a form and hand
 * back an editable card of title, frequency and content. This asks for the
 * one thing only the researcher knows, picks the rest, and keeps every field
 * editable behind 「高级」. The API is unchanged. A task is created paused —
 * the service sets `enabled: false` and says why — so this spends nothing;
 * the researcher presses 开始 afterwards.
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
      <p className="text-caption text-muted">
        默认每天 {AGENDA_DEFAULTS.scheduleHour.padStart(2, "0")}:00 跑一次文献哨兵，
        单次最多 ¥{AGENDA_DEFAULTS.maxEpisodeCny}、每天 ¥{AGENDA_DEFAULTS.dailyBudgetCny}、每周 ¥{AGENDA_DEFAULTS.weeklyBudgetCny}。
        创建后处于暂停状态，按「开始」才会运行和产生费用。
      </p>
      <Disclosure summary="高级：名称、任务类型、预算与时刻">
        <div className="space-y-3">
          <Input label="名称" value={title} maxLength={200}
            placeholder={direction.trim() ? defaultTitle(direction) : "留空就用上面这句话"}
            onChange={(event) => setTitle(event.target.value)} />
          <fieldset className="space-y-1">
            <legend className="text-ui font-medium text-text">任务类型</legend>
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
          {!budgetsOrdered && <p className="text-ui text-muted">三档预算需满足：单次 ≤ 每日 ≤ 每周，且都大于 0。</p>}
        </div>
      </Disclosure>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={!ready || saving} loading={saving}>创建</Button>
        <Button size="sm" type="button" variant="ghost" disabled={saving} onClick={onCancel}>取消</Button>
      </div>
    </form>
  );
}

/**
 * How far a finding has been checked, and by whom.
 *
 * The tier is what separates "我们发现" from "看起来", so the reader is told which
 * one they are looking at rather than left to infer it from the position on the
 * page. A refutation is said out loud: a claim the digest offered yesterday and
 * an independent re-check overturned today is the one sentence a reader most
 * needs and would least expect to find.
 */
function verificationLabel(claim: DigestClaim): { text: string; refuted: boolean } | null {
  if (claim.refutation === "refuted") return { text: "独立复核未能复现，已降级为线索", refuted: true };
  if (claim.refutation === "weakened") return { text: "独立复核只能部分支持", refuted: false };
  if (claim.tier === "reproduced") return { text: "独立复核已复现", refuted: false };
  if (claim.refutation === "stands") return { text: "独立复核未能推翻", refuted: false };
  if (claim.verification?.status === "queued") return { text: "独立复核排队中", refuted: false };
  if (claim.verification?.status === "unavailable") return { text: "独立复核未完成，只通过了交付前的检查", refuted: false };
  // A claim that was never scheduled is not a claim awaiting its turn. The
  // service records the two separately on purpose, and a reader who cannot tell
  // them apart is waiting for something that is never coming.
  if (claim.verification?.status === "unscheduled") {
    return { text: claim.verification.reason === "verification_budget_unavailable"
      ? "本轮预算不足以安排独立复核" : "本轮复核名额已满，未安排独立复核", refuted: false };
  }
  if (claim.tier === "gated") return { text: "已通过交付前的检查，尚未独立复核", refuted: false };
  if (claim.tier === "unverified") return { text: "尚未通过任何验证", refuted: false };
  return null;
}

function ClaimVerification({ claim }: { claim: DigestClaim }) {
  const label = verificationLabel(claim);
  if (!label) return null;
  return <p className={label.refuted ? "mt-1 text-caption text-error" : "mt-1 text-caption text-muted"}>{label.text}</p>;
}

/** What the researcher last said about a finding; a rejection is echoed back as the promise it makes.
 *  A withdrawal takes back that claim's latest adopt or reject, as the score does. */
function decisionLabel(digest: DigestRecord, claimId: string): string | null {
  const standing: DigestRecord["payload"]["decisions"] = [];
  for (const decision of digest.payload.decisions ?? []) {
    if (decision.claimId !== claimId) continue;
    if (decision.action !== "withdraw") { standing.push(decision); continue; }
    for (let index = standing.length - 1; index >= 0; index -= 1) {
      if (standing[index].action === "adopt" || standing[index].action === "reject") { standing.splice(index, 1); break; }
    }
  }
  const last = standing.at(-1);
  if (!last) return null;
  if (last.action === "adopt") return "已采纳";
  if (last.action === "reject") return "已记住：不再按这个方向";
  if (last.action === "question") return `已追问：${last.note}`;
  return null;
}

/**
 * A task's runs: one per scheduled date, each a finished conversation to open
 * and the briefing it fed. Manus's replay is a completed session the reader
 * opens; so is this, with no scrubber and no speed — the conversation's own
 * 运行 tab is the process.
 */
function EpisodeHistory({ projectId, agenda, onDigest }: { projectId: string; agenda: AgendaRecord; onDigest: (digestId: string) => void }) {
  const [episodes, setEpisodes] = useState<EpisodeRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setEpisodes((await listEpisodes(projectId, agenda.id)).items); }
    catch (caught) { setEpisodes([]); setError(productErrorMessage(caught)); }
  }, [projectId, agenda.id]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <div role="alert" className="flex items-center gap-3 text-ui text-error"><span className="flex-1">{error}</span><Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div>;
  if (episodes === null) return <MemorySkeleton />;
  if (episodes.length === 0) return <EmptyState icon={History} title="还没有运行过" description="按「立即跑一次」，或等到设定的时刻，这里会列出每一次运行。" />;
  return (
    <ul className="divide-y divide-border rounded-card border border-border bg-surface">
      {episodes.map((episode) => {
        const status = EPISODE_STATUS[episode.payload.status] ?? { text: episode.payload.status, tone: "text-muted" };
        return (
          <li key={episode.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <span className="text-ui text-text">{episode.payload.date}</span>
            <span className="text-caption text-muted">{TASK_TYPE_LABEL[episode.payload.taskType] ?? episode.payload.taskType}</span>
            <span className={cn("text-caption font-medium", status.tone)}>{status.text}</span>
            <span className="flex-1" />
            {episode.payload.sessionId && (
              <Link to={chatPath(episode.payload.sessionId)} className="text-ui text-link hover:underline">打开这次运行</Link>
            )}
            {episode.payload.digestId && (
              <button type="button" onClick={() => onDigest(episode.payload.digestId!)} className="text-ui text-link hover:underline">查看简报</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 主动科研 — the scheduled research tasks, and what they produced.
 *
 * Until 2026-09-22 the page opened on the morning briefing with the agendas
 * as cards under it. The owner's reading: the core of proactive research is
 * scheduled tasks and their reproducible results (「相当于 AI 自动模拟用户
 * 行为提前做了一遍，用户可以点进去看一下」), which is what Manus's task list
 * and use-case gallery are. So the page is a list of tasks first — each with
 * its schedule, its state and a history drawer whose every run opens as a
 * finished conversation — and the briefing after it, where the findings are
 * adopted, rejected or questioned as before.
 */
export function AutopilotPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const digestId = searchParams.get("digest");
  const [agendas, setAgendas] = useState<AgendaRecord[] | null>(null);
  const [digests, setDigests] = useState<DigestRecord[]>([]);
  const [selectedDigest, setSelectedDigest] = useState<DigestRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<InboxItem[]>([]);
  const [followUp, setFollowUp] = useState<{ digestId: string; claimId: string; note: string } | null>(null);
  /** The agenda a researcher asked to run now, held until they confirm the
   *  spend. Running is the one control on this page that costs money on a
   *  single click. */
  const [running, setRunning] = useState<AgendaRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState<AgendaRecord | null>(null);
  const [busy, setBusy] = useState(false);
  // The project the form creates in. `load` resolves its own project from the
  // selected digest, which may belong to another one; a new agenda always
  // belongs to the project the researcher is currently in.
  const projectId = getWebProjectId();
  const generation = useRef(0);
  const digestView = useRef(0);
  const pendingOpen = useRef<string | null>(null);
  const recordedOpen = useRef<string | null>(null);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    setAgendas(null); setSelectedDigest(null);
    try {
      const selected = digestId ? await getDigest(digestId) : null;
      if (current !== generation.current) return;
      const projectId = selected?.projectId ?? getWebProjectId();
      const [agendaPage, digestPage] = await Promise.all([listAgendas(projectId), listDigests(projectId)]);
      if (current !== generation.current) return;
      setAgendas(agendaPage.items); setDigests(digestPage.items); setSelectedDigest(selected);
    } catch (loadError) {
      if (current !== generation.current) return;
      setAgendas([]); setDigests([]); setError(`主动科研状态不可用：${productErrorMessage(loadError)}`);
    }
  }, [digestId]);
  // 「需要你决定」: the审阅 and 提问 items the inbox is holding. Read here as
  // well as on the inbox page because §24.9 puts them in the morning briefing —
  // a decision the loop is waiting on is the one thing on this page that is
  // blocking tonight's work.
  useEffect(() => {
    let active = true;
    void listInbox({ unread: true })
      .then((page) => {
        if (active) setDecisions(page.items.filter((item) => item.noticeType !== "notify").slice(0, 5));
      })
      .catch(() => { /* isolated: the briefing is a section of the page, the inbox is where it is resolved */ });
    return () => { active = false; };
  }, []);

  // The briefing opens on the newest one. Addressing it in the URL rather
  // than selecting it in state keeps every downstream behaviour — the read
  // record, the decision calls, a link from a notification — on one path.
  useEffect(() => {
    if (digestId || !digests.length) return;
    setSearchParams({ digest: digests[0].id }, { replace: true });
  }, [digestId, digests, setSearchParams]);

  useEffect(() => {
    const requests = generation;
    const views = digestView;
    views.current++;
    pendingOpen.current = null;
    recordedOpen.current = null;
    setActivityError(null);
    void load();
    return () => { requests.current++; views.current++; };
  }, [load]);
  useEffect(() => {
    if (!selectedDigest || selectedDigest.id !== digestId || recordedOpen.current === digestId || pendingOpen.current === digestId) return;
    // Reloading this digest after a decision does not finish its pending read.
    // Only leaving the digest invalidates the completion or retry feedback.
    const view = digestView.current;
    pendingOpen.current = digestId;
    void markDigestOpened(selectedDigest.id).then(() => {
      if (view !== digestView.current) return;
      pendingOpen.current = null;
      recordedOpen.current = digestId;
      setActivityError(null);
    }).catch((openError) => {
      if (view !== digestView.current) return;
      pendingOpen.current = null;
      setActivityError(`阅读记录未保存：${productErrorMessage(openError)}`);
    });
  }, [selectedDigest, digestId]);
  const mutate = async (operation: () => Promise<unknown>) => {
    const current = generation.current;
    setBusy(true); setError(null);
    try { await operation(); if (current === generation.current) await load(); }
    catch (operationError) { if (current === generation.current) setError(productErrorMessage(operationError)); }
    finally { setBusy(false); }
  };
  // 采纳 writes a candidate memory and 驳回 parks the direction at its next
  // episode, each from one click, so each says so and offers the way back
  // (2026-09-16 review, U17).
  const decide = async (id: string, claimId: string, action: "adopt" | "reject") => {
    let recorded = false;
    await mutate(async () => { await decideDigest(id, { action, claimId, note: "" }); recorded = true; });
    if (!recorded) return;
    toast.success(action === "adopt" ? "已采纳，记为待你确认的记忆" : "已驳回：之后不再按这个方向", {
      action: { label: "撤销", onClick: () => void mutate(() => decideDigest(id, { action: "withdraw", claimId, note: "" })) },
    });
  };
  const visibleDigests = selectedDigest ? [selectedDigest, ...digests.filter((digest) => digest.id !== selectedDigest.id)] : digests;
  const visibleError = error ?? activityError;
  /**
   * Today, in the agenda's own zone.
   *
   * `toISOString().slice(0, 10)` is the UTC date, and the create form already
   * records the researcher's zone precisely because the two differ: between
   * 00:00 and 08:00 Beijing time it names yesterday, so 「立即跑一次」
   * scheduled the previous day's episode (2026-09-16 walk, U7). Read per
   * agenda, because two agendas may not share a zone.
   */
  const todayIn = (timeZone?: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

  /**
   * The page's opening line: only what the records hold — the newest
   * briefing's date, what it cost, and how many findings and leads it carried.
   */
  const latest = digests[0];
  const summaryLine = latest
    ? `${latest.payload.date} 的简报：${latest.payload.headlines.length} 条重点发现 · `
      + `${latest.payload.leads.length} 条待验证线索 · 花费 ¥${latest.payload.costCny}`
    : "按定时研究自动跑，受额度和停止规则约束；结果和你自己发起的研究走同一套检查。";

  /**
   * When the first briefing is due, said in the agenda's own words.
   *
   * An active agenda knows its hour and its zone, so the empty state can name
   * them instead of saying "later". A paused one is waiting on the researcher,
   * and saying so is the difference between "nothing has happened yet" and
   * "nothing will happen until you press start".
   */
  const scheduled = (agendas ?? []).find((agenda) => agenda.payload.status === "active");
  const firstRunHint = scheduled
    ? `「${scheduled.payload.title}」将在每天 ${String(scheduled.payload.scheduleHour).padStart(2, "0")}:00`
      + `（${scheduled.payload.timeZone}）跑一次，完成后在这里汇总发现、变化与花费。`
    : (agendas ?? []).length > 0
      ? "议程目前是暂停的。按「开始主动科研」之后，它会按设定的时刻运行，第一份简报在那之后出现。"
      : "完成的主动科研会在这里汇总发现、变化与花费。";
  const runDialog = running ? <ConfirmDialog
    title="现在就跑一次？"
    body={`「${running.payload.title}」会立即开始一次主动科研，按上限最多花费 ¥${running.payload.maxEpisodeCny}（每日上限 ¥${running.payload.dailyBudgetCny}）。结果会作为简报出现在这一页。`}
    confirmLabel="现在就跑"
    onCancel={() => setRunning(null)}
    onConfirm={() => {
      const agenda = running;
      setRunning(null);
      void mutate(() => scheduleAgenda(agenda.id, todayIn(agenda.payload.timeZone)));
    }}
  /> : null;
  return <div className="h-full overflow-y-auto bg-bg"><div className="mx-auto w-full max-w-content-wide space-y-6 px-6 py-6">
    {runDialog}
    <PageTitle page="主动科研" />
    <PageHeader
      title="主动科研"
      description={summaryLine}
      actions={<Button size="sm" disabled={busy} onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />新建定时研究</Button>}
    />
    {visibleError && <Card><div role="alert" className="flex items-center justify-between gap-3"><p className="text-ui text-error">{visibleError}</p>
      <Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div></Card>}

    {/* The tasks first: one row each, with the schedule, the state and the
      * way into its history. The briefing they produce follows. */}
    <section className="space-y-3" aria-label="定时研究">
      <h2 className="text-body font-semibold text-text">定时研究</h2>
      {agendas === null ? <MemorySkeleton /> : agendas.length === 0
        ? <EmptyState icon={CalendarClock} title="还没有定时研究" description="用右上角的「新建定时研究」写一句想持续跟进的方向就行，其余由平台给默认值。创建后默认暂停，只有你主动开始才会运行和产生费用。" />
        : <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {agendas.map((agenda) => {
            const active = agenda.payload.status === "active";
            return <li key={agenda.id} className="space-y-1.5 px-4 py-3" data-agenda={agenda.id}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", active ? "bg-dot-running" : "bg-strong")} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-ui font-medium text-text">{agenda.payload.title}</span>
                <span className="text-caption text-muted">每天 {String(agenda.payload.scheduleHour).padStart(2, "0")}:00（{agenda.payload.timeZone}）</span>
                <span className={cn("text-caption font-medium", active ? "text-ok" : "text-muted")}>{active ? "运行中" : "已暂停"}</span>
              </div>
              <p className="text-caption text-muted">{agenda.payload.topics.join("、")} · {agenda.payload.taskTypes.map((type) => TASK_TYPE_LABEL[type] ?? type).join("、")}</p>
              <p className="text-ui text-muted">每日 ¥{agenda.payload.dailyBudgetCny} · 每周 ¥{agenda.payload.weeklyBudgetCny} · 单次 ¥{agenda.payload.maxEpisodeCny}</p>
              {agenda.payload.pauseReason && <p className="text-ui text-muted">{agenda.payload.pauseReason}</p>}
              {pendingFollowUps(agenda) > 0 && <p className="text-ui text-muted">下一次先回答 {pendingFollowUps(agenda)} 条追问。</p>}
              <div className="flex flex-wrap gap-2">
                {/* Spending is confirmed; a verdict is not. 「立即跑一次」 starts
                  * a paid episode on one click, so it says what it may cost
                  * first (2026-09-16 review, U17). */}
                {active ? <><Button size="sm" disabled={busy} onClick={() => setRunning(agenda)}><Sparkles size={16} aria-hidden="true" />立即跑一次</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(() => stopAgenda(agenda.id, agenda.revision))}><PauseCircle size={16} aria-hidden="true" />停止</Button></>
                  : <Button size="sm" disabled={busy} onClick={() => void mutate(() => startAgenda(agenda.id, agenda.revision))}><PlayCircle size={16} aria-hidden="true" />开始主动科研</Button>}
                <Button size="sm" variant="ghost" onClick={() => setHistory(agenda)}><History size={16} aria-hidden="true" />运行历史</Button>
              </div>
            </li>;
          })}
        </ul>}
    </section>

    {/* The briefing the tasks produce: findings to adopt, reject or question. */}
    <section className="space-y-3" aria-label="简报">
      <h2 className="text-body font-semibold text-text">简报</h2>
      {agendas === null ? <MemorySkeleton />
        : visibleDigests.length === 0
          ? <EmptyState icon={CalendarClock} title="还没有简报" description={firstRunHint} />
          : visibleDigests.map((digest) => <Card key={digest.id} title={digest.payload.date} hint={`本期花费 ¥${digest.payload.costCny}`}><div className="space-y-4">
            {selectedDigest?.id !== digest.id ? <Button size="sm" variant="ghost" onClick={() => setSearchParams({ digest: digest.id })}>查看简报</Button>
              : [...digest.payload.headlines.map((claim) => ({ claim, kind: "重点发现" })), ...digest.payload.leads.map((claim) => ({ claim, kind: "待验证线索" }))].map(({ claim, kind }) => <div key={claim.id} className="rounded-input bg-surface-2 p-3">
              <p className="text-caption text-muted">{kind}</p><p className="mt-1 text-ui text-text">{claim.statement}</p>
              <ClaimVerification claim={claim} />
              {decisionLabel(digest, claim.id) && <p className="mt-1 text-ui text-muted">{decisionLabel(digest, claim.id)}</p>}
              <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="ghost" aria-label={`采纳${claim.statement}`} disabled={busy} onClick={() => void decide(digest.id, claim.id, "adopt")}>采纳</Button>
                <Button size="sm" variant="ghost" aria-label={`驳回${claim.statement}`} disabled={busy} onClick={() => void decide(digest.id, claim.id, "reject")}>驳回</Button>
                <Button size="sm" variant="ghost" aria-label={`追问${claim.statement}`} disabled={busy} onClick={() => setFollowUp(followUp?.claimId === claim.id && followUp.digestId === digest.id ? null : { digestId: digest.id, claimId: claim.id, note: "" })}>追问</Button></div>
              {followUp?.digestId === digest.id && followUp.claimId === claim.id && <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => {
                event.preventDefault();
                const note = followUp.note.trim();
                if (!note) return;
                void mutate(async () => { await decideDigest(digest.id, { action: "question", claimId: claim.id, note }); setFollowUp(null); });
              }}>
                <Input className="min-w-0 flex-1" label="追问" placeholder="想让下一次先回答什么？" value={followUp.note} onChange={(event) => setFollowUp({ ...followUp, note: event.target.value })} />
                <Button size="sm" type="submit" disabled={busy || !followUp.note.trim()}>发送追问</Button>
              </form>}
            </div>)}</div></Card>)}
    </section>

    {/* 「需要你决定」 (§24.9): the审阅 and 提问 items the inbox is holding. They
      * are here because a decision the loop is waiting on is what blocks
      * tonight's work; the inbox is still where they are resolved. */}
    {decisions.length > 0 && <section className="space-y-2" aria-label="需要你决定">
      <h2 className="text-body font-semibold text-text">需要你决定</h2>
      {decisions.map((item) => <Card key={item.id} title={item.title} hint={item.noticeType === "review" ? "需要审阅" : "等待回答"}>
        <InboxBody body={item.body} />
        <Button className="mt-2" size="sm" variant="ghost" onClick={() => navigate("/app/inbox")}>去收件箱处理</Button>
      </Card>)}
    </section>}

    {creating && (
      <Drawer title="新建定时研究" description="写一句想持续跟进的方向，其余由平台给默认值。" onClose={() => setCreating(false)}>
        <NewAgendaForm projectId={projectId} onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); void load(); }} onError={(message) => { setCreating(false); setError(message); }} />
      </Drawer>
    )}
    {history && (
      <Drawer title="运行历史" description={`「${history.payload.title}」的每一次运行：打开就是那次研究的完整对话。`} onClose={() => setHistory(null)} widthClassName="max-w-2xl">
        <EpisodeHistory projectId={history.projectId} agenda={history} onDigest={(id) => { setHistory(null); setSearchParams({ digest: id }); }} />
      </Drawer>
    )}
  </div></div>;
}
