import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { CalendarClock, PauseCircle, PlayCircle, Plus, Sparkles } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import { createAgenda, decideDigest, getDigest, listAgendas, listDigests, markDigestOpened, scheduleAgenda, startAgenda, stopAgenda,
  type AgendaRecord, type DigestClaim, type DigestRecord } from "@/lib/autopilotClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { listInbox, type InboxItem } from "@/lib/inboxClient";
import { InboxBody } from "@/components/inbox/InboxBody";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { PAGE_TITLE_CLASS } from "@/components/layout/PageHeader";
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

/**
 * What the platform picks when the researcher says nothing about it.
 *
 * ¥2 a turn, ¥10 a day, ¥50 a week is the ordered triple the service accepts
 * and roughly half a deep run's measured cost (¥3.4, 2026-09-20 benchmark), so
 * an agenda left alone costs less in a week than two deep runs. 07:00 is
 * before a working day in the researcher's own zone.
 */
const AGENDA_DEFAULTS = {
  taskTypes: ["literature-sentinel"],
  maxEpisodeCny: "2",
  dailyBudgetCny: "10",
  weeklyBudgetCny: "50",
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
 * Creating an agenda: one sentence.
 *
 * `POST /api/autopilot/agendas` has existed since the service shipped and no
 * surface ever called it: the page offered 开始 / 停止 / 立即运行 over a list
 * that could only ever be empty, so 「主动科研」 was a navigation row to a dead
 * end (2026-09-15 walk, B4). The form that fixed that asked for a name, a list
 * of directions, a set of task types and three budgets before it would accept
 * anything — six fields to start something the platform is supposed to run by
 * itself (2026-09-20 plan, R3). Now it asks for the one thing only the
 * researcher knows, picks the rest, and keeps every field editable behind
 * 「高级」 for the researcher who does care. The API is unchanged.
 *
 * An agenda is created paused — the service sets `enabled: false` and says why
 * — so this form spends nothing; the researcher presses 开始 afterwards.
 */
function NewAgendaForm({ projectId, busy, onCreated, onError }: {
  projectId: string;
  busy: boolean;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
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
      setOpen(false);
      setDirection(""); setTitle("");
      onCreated();
    } catch (caught) {
      onError(productErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button size="sm" disabled={busy} onClick={() => setOpen(true)}><Plus size={13} aria-hidden="true" />新建议程</Button>
    );
  }

  return (
    <Card title="让 EviMed 持续盯住一个方向" hint="议程创建后处于暂停状态，只有你按下「开始主动科研」才会运行和产生费用。">
      <form className="space-y-3" onSubmit={submit}>
        <Input label="想持续跟进什么？" value={direction} required maxLength={400}
          placeholder="例如：司美格鲁肽的胰腺炎与心血管结局"
          onChange={(event) => setDirection(event.target.value)} />
        <p className="text-caption text-muted">
          默认每天 {AGENDA_DEFAULTS.scheduleHour.padStart(2, "0")}:00 跑一次文献哨兵，
          单次最多 ¥{AGENDA_DEFAULTS.maxEpisodeCny}、每天 ¥{AGENDA_DEFAULTS.dailyBudgetCny}、每周 ¥{AGENDA_DEFAULTS.weeklyBudgetCny}。
        </p>
        <Disclosure summary="高级：名称、任务类型、预算与时刻">
          <div className="space-y-3">
            <Input label="议程名称" value={title} maxLength={200}
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
            <div className="grid gap-3 sm:grid-cols-4">
              <Input label="单次上限 ¥" type="number" min="0" step="0.5" value={maxEpisodeCny} onChange={(event) => setMaxEpisodeCny(event.target.value)} />
              <Input label="每日上限 ¥" type="number" min="0" step="1" value={dailyBudgetCny} onChange={(event) => setDailyBudgetCny(event.target.value)} />
              <Input label="每周上限 ¥" type="number" min="0" step="1" value={weeklyBudgetCny} onChange={(event) => setWeeklyBudgetCny(event.target.value)} />
              <Input label="每天运行时刻" type="number" min="0" max="23" step="1" value={scheduleHour} onChange={(event) => setScheduleHour(event.target.value)} />
            </div>
            {!budgetsOrdered && <p className="text-ui text-muted">三档预算需满足：单次 ≤ 每日 ≤ 每周，且都大于 0。</p>}
          </div>
        </Disclosure>
        <div className="flex gap-2">
          <Button size="sm" type="submit" disabled={!ready || saving}>创建议程</Button>
          <Button size="sm" type="button" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>取消</Button>
        </div>
      </form>
    </Card>
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
      .catch(() => { /* isolated: the briefing is the page, the inbox is a section of it */ });
    return () => { active = false; };
  }, []);

  // The page IS the briefing (§24.9), so it opens on one. Addressing it in the
  // URL rather than selecting it in state keeps every downstream behaviour —
  // the read record, the decision calls, a link from a notification — on the
  // one path they were written for.
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
   * The briefing's opening line.
   *
   * Only what the records hold: the newest digest's date, what it cost, and
   * how many findings and leads it carried. §24.9 also asks for the off-peak
   * saving and a balance runway — neither is on this API, and the one place
   * not to invent a number is the line a researcher reads before deciding
   * whether to keep paying for last night.
   */
  const latest = digests[0];
  const summaryLine = latest
    ? `${latest.payload.date} 的简报：${latest.payload.headlines.length} 条重点发现 · `
      + `${latest.payload.leads.length} 条待验证线索 · 花费 ¥${latest.payload.costCny}`
    : "按研究议程自动跑，受额度和停止规则约束；结果和你自己发起的研究走同一套检查。";

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
  return <div className="h-full overflow-y-auto px-5 py-6"><div className="mx-auto max-w-content-wide space-y-5">
    {runDialog}
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <PageTitle page="主动科研" />
        <h1 className={PAGE_TITLE_CLASS}>主动科研</h1>
        {/* The one line §24.9 asks the briefing to open with, from numbers the
          * ledger actually holds. The spec also wants off-peak savings and a
          * balance runway; neither is on this API, and an invented figure on a
          * briefing page is the kind a researcher acts on without checking. */}
        <p className="mt-2 text-ui text-muted">{summaryLine}</p>
      </div>
      <NewAgendaForm projectId={projectId} busy={busy} onCreated={() => void load()} onError={setError} />
    </header>
    {visibleError && <Card><div role="alert" className="flex items-center justify-between gap-3"><p className="text-ui text-error">{visibleError}</p>
      <Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div></Card>}

    {/* The briefing leads, because the page is the briefing (§24.9). It used to
      * open on an agenda board with the digests below it, and on 2026-09-15
      * there was no board either — the page offered 开始 / 停止 / 立即运行 over
      * a list that could only ever be empty (walk, B4/C4). */}
    <section className="space-y-3" aria-label="晨间简报">
      <h2 className="font-serif text-body text-text">晨间简报</h2>
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
      <h2 className="font-serif text-body text-text">需要你决定</h2>
      {decisions.map((item) => <Card key={item.id} title={item.title} hint={item.noticeType === "review" ? "需要审阅" : "等待回答"}>
        <InboxBody body={item.body} />
        <Button className="mt-2" size="sm" variant="ghost" onClick={() => navigate("/app/inbox")}>去收件箱处理</Button>
      </Card>)}
    </section>}

    <section className="space-y-3" aria-label="研究议程">
      <h2 className="font-serif text-body text-text">研究议程</h2>
      {agendas === null ? <MemorySkeleton /> : agendas.length === 0
        ? <EmptyState icon={CalendarClock} title="还没有主动科研议程" description="用右上角的「新建议程」写一句想持续跟进的方向就行，其余由平台给默认值。议程创建后默认暂停，只有你主动开始才会运行和产生费用。" />
        : agendas.map((agenda) => <Card key={agenda.id} title={agenda.payload.title}
          hint={`${agenda.payload.status === "active" ? "运行中" : "已暂停"} · ${agenda.payload.topics.join("、")}`}><div className="space-y-3">
          <p className="text-ui text-muted">每日 ¥{agenda.payload.dailyBudgetCny} · 每周 ¥{agenda.payload.weeklyBudgetCny} · 单次 ¥{agenda.payload.maxEpisodeCny}</p>
          {agenda.payload.pauseReason && <p className="text-ui text-muted">{agenda.payload.pauseReason}</p>}
          {pendingFollowUps(agenda) > 0 && <p className="text-ui text-muted">下一次先回答 {pendingFollowUps(agenda)} 条追问。</p>}
          <div className="flex flex-wrap gap-2">
            {/* Spending is confirmed; a verdict is not.
              * 「立即跑一次」 starts a paid episode on one click, so it says
              * what it may cost first (2026-09-16 review, U17). 「采纳 / 驳回」
              * are deliberately left one-click: `rememberDecision` writes a
              * capsule CANDIDATE, which takes effect only once confirmed — so
              * a dialog there would guard a step that already has a gate. */}
            {agenda.payload.status === "active" ? <><Button size="sm" disabled={busy} onClick={() => setRunning(agenda)}><Sparkles size={13} aria-hidden="true" />立即跑一次</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(() => stopAgenda(agenda.id, agenda.revision))}><PauseCircle size={13} aria-hidden="true" />停止</Button></>
              : <Button size="sm" disabled={busy} onClick={() => void mutate(() => startAgenda(agenda.id, agenda.revision))}><PlayCircle size={13} aria-hidden="true" />开始主动科研</Button>}
          </div></div></Card>)}
    </section>
  </div></div>;
}
