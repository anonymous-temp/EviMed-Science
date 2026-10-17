import { type ReactNode } from "react";
import { useNavigate } from "react-router";
import { CircleDashed, History, MessageSquare, TriangleAlert, UsersRound } from "lucide-react";
import { VCR_STEP_NEEDS } from "@evimed/domain";
import { cancelVcrStudy, runVcrStep, type VcrActivity, type VcrPartial, type VcrStaleNote, type VcrStepKey, type VcrStudy } from "@/lib/vcrClient";
import { vcrChatPath } from "@/lib/studyLocation";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { StepState, type StepInput } from "@/components/ui/StepState";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import { AllowanceTopUp } from "@/components/runs/AllowanceTopUp";
import { useStudyFrame } from "./studyFrameContext";
import { useVcrRun } from "./useVcrRun";
import { leadJob, runDetailLine, stepAction, stepName } from "./vcrActivity";
import { staleSentence, stepLabel, VCR_NO_DEFINITION, VCR_STEP_GIVES, VCR_STEP_NOUNS } from "./vcrText";
import { hasDefinition, VCR_STEP_TABS, vcrTabPath } from "./vcrTabs";

/**
 * The states every 「虚拟临床研究」 surface shares.
 *
 * The four every list on this product has — loading, empty, error with 重试,
 * content — and **three more this module needs** (build contract §6):
 *
 *  - **部分结果** — a computation that failed after part of it succeeded keeps
 *    what it computed (platform principle 19). The part that is there is
 *    shown; the part that is not is named.
 *  - **模型或数据不适用** — a route the study's data tier cannot support, or a
 *    model asked outside its declared range. It says which item is out of
 *    range and what the alternatives are; it never invents a trajectory.
 *  - **结果已过期** — an upstream input changed, so the numbers on screen were
 *    computed from something that no longer holds. **The numbers stay on
 *    screen**, greyed, under a pale bar that says a recomputation is queued
 *    (plan §9.6). Hiding them would lose the reader's place for no gain.
 *
 * 「不可估计」 is not in this list: it is a finished scientific result, and it
 * has a card of its own (`NotEstimableCard`).
 */

/** The sentence a direct link lands on where the module is off, or not offered here. */
export const VCR_OFF_SENTENCE = "虚拟临床研究还没有在这个工作空间开放。";

/**
 * The module-off page: one sentence, nothing to click. The navigation row is
 * already gone for this account; this is what a bookmark or a forwarded link
 * finds.
 */
export function VcrOffPage() {
  return (
    <PageShell title="虚拟临床研究">
      <EmptyState icon={UsersRound} title={VCR_OFF_SENTENCE} />
    </PageShell>
  );
}

function Bar({ className }: { className: string }) {
  return <div className={cn("rounded bg-surface-2", className)} />;
}

/** The home list's first paint: rows shaped like the studies they stand in for. */
export function VcrListSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true" data-vcr-loading="home">
      {["w-2/5", "w-1/3", "w-1/2"].map((width) => (
        <div key={width} className="flex items-start gap-6 border-b border-border px-2 py-5">
          <div className="flex flex-1 flex-col gap-2">
            <Bar className={`h-4 ${width}`} />
            <Bar className="h-3 w-1/3" />
            <Bar className="h-3 w-3/5" />
          </div>
          <Bar className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

/** A study page's first paint: the tab row and a conclusion with the table under it. */
export function VcrStudySkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true" data-vcr-loading="study">
      <div className="flex h-10 items-end gap-6 border-b border-border">
        {Array.from({ length: 7 }, (_, index) => <Bar key={index} className="mb-3 h-3.5 w-14" />)}
      </div>
      <Bar className="mt-6 h-20 rounded-card" />
      <div className="mt-4 flex flex-col gap-px rounded-panel border border-border bg-border">
        {Array.from({ length: 4 }, (_, index) => <Bar key={index} className="h-12 rounded-none" />)}
      </div>
    </div>
  );
}

/** A tab's first paint. */
export function VcrTabSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div data-vcr-loading="tab" className="animate-pulse" aria-hidden="true">
      <Bar className="h-sm w-48 rounded-full" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="mt-4 flex flex-col gap-2 border-b border-faint pb-4">
          <Bar className={cn("h-3.5", index % 2 ? "w-2/3" : "w-3/4")} />
          <Bar className="h-3 w-1/4" />
        </div>
      ))}
    </div>
  );
}

/** What the strip and the tab say a step waits for, as the noun `StepState` puts in 「“…”做完后自动开始」. */
function waitingNoun(waitingFor: string | null | undefined): string | undefined {
  if (!waitingFor || waitingFor === "allowance" || waitingFor === "simulated_allowance") return undefined;
  if (waitingFor === "run") return "这次运行";
  return stepName(waitingFor as VcrStepKey);
}

/** What the activity says of one step: the run that covers it, the engine job that works on it, and where it waits in line. */
function activityOfStep(activity: VcrActivity | null | undefined, step: VcrStepKey) {
  const run = activity?.run && activity.run.steps.includes(step) ? activity.run : null;
  const job = leadJob(activity && { ...activity, jobs: activity.jobs.filter((entry) => entry.step === step) });
  const queued = activity?.queue.find((entry) => entry.step === step) ?? null;
  return { run, job, queued };
}

/**
 * What a step's tab shows while it has nothing to show — the one body for four states, drawn by `StepState` (R19): **the recipe**
 * (what the step uses, each a way to the thing; what it gives; one button that names the work as a verb and its object) when it has
 * not run; **where it waits** when it is in line; **what is being done, for how long, and 停止** while it runs; and the way to the
 * allowance when that is what it waits for. A step that failed with nothing to show is `VcrStepFailed`'s.
 *
 * The button starts the step and **takes nobody anywhere**: the page's strip says what happens next, and this tab is the step's
 * state, so it is a recipe, then a run, then — when the page has read the study again — the result.
 */
export function VcrStepPending({ studyId, study, step, hint, start, blocked }: {
  studyId: string;
  study: VcrStudy;
  step: VcrStepKey;
  /** What the step gives, when the step's own sentence does not fit this study (matching at T0). */
  hint?: string;
  /** Why the step cannot start on this deployment (the evidence library is not connected): said in the button's place, which is not drawn. */
  blocked?: string | null;
  /** Where the step can be started directly (an evaluation of protocol versions that already exist), this is the one button instead. */
  start?: VcrStepStart;
}) {
  const frame = useStudyFrame();
  const { run, busy } = useVcrRun(study);
  const state = study.steps[step];
  const mayRun = study.abilities.includes("run");
  const activity = study.activity ?? frame?.activity ?? null;
  const here = activityOfStep(activity, step);
  const action = stepAction(step);
  const cancel = () => { void cancelVcrStudy(studyId).then(() => frame?.refresh()).catch(() => undefined); };

  // A queued step the allowance would not start is not work under way: it says what it waits on and where that is put right.
  const allowanceWait = stepAllowanceWait(state);
  if (allowanceWait) {
    return (
      <div data-vcr-step-allowance={step}>
        <StepState phase="credits" step={action} waiting={allowanceWait} topUp={<AllowanceTopUp waiting={allowanceWait} />} />
      </div>
    );
  }
  if (state?.status === "running") {
    const detail = here.run ? runDetailLine(here.run) : here.job?.total ? "计算" : "";
    return (
      <div data-vcr-step-running={step}>
        <StepState
          phase="running"
          step={here.run?.label || action}
          phaseName={detail || undefined}
          counts={here.job && here.job.done !== null && here.job.total ? { done: here.job.done, total: here.job.total } : undefined}
          startedAt={here.run?.startedAt}
          onStop={mayRun && (here.run || here.job) ? cancel : undefined}
        />
      </div>
    );
  }
  if (state?.status === "queued") {
    return (
      <div data-vcr-step-waiting={step}>
        <StepState phase="queued" step={action} after={waitingNoun(here.queued?.waitingFor)} onStop={mayRun ? cancel : undefined} />
      </div>
    );
  }
  if (state?.status === "failed") return <VcrStepFailed studyId={studyId} study={study} step={step} />;
  // Nothing waits in a queue for a study nobody has described: the one thing missing is the first sentence, and it is said that way.
  if (!hasDefinition(study)) return <VcrNoDefinition study={study} />;
  // Asked for and not started by the programme yet: it is in line, whatever the strip has not heard of. A step a cancel held is not in
  // line — it was stopped, and nothing starts it but a person's press — so it offers its start like a step never asked for.
  if (state?.status === "none" && state.requested === true && state.held !== true) {
    return (
      <div data-vcr-step-waiting={step}>
        <StepState phase="queued" step={action} onStop={mayRun ? cancel : undefined} />
      </div>
    );
  }

  // The recipe: each thing it uses is the tab it comes from, with what that tab found.
  const uses: StepInput[] = [];
  const needs = (VCR_STEP_NEEDS as Record<string, readonly string[]>)[step] ?? [];
  for (const need of needs) {
    const key = need as VcrStepKey;
    const note = study.stepSummaries[key]?.note;
    uses.push({ label: `${key === "definition" ? "研究定义" : stepName(key)}${note ? ` ${note}` : ""}`, to: vcrTabPath(studyId, VCR_STEP_TABS[key]) });
  }
  const cards = study.stepSummaries.evidence?.note;
  if (cards && step !== "evidence" && step !== "definition") uses.push({ label: cards, to: vcrTabPath(studyId, "data") });
  const startHere = blocked ? undefined : start ? start.onStart : mayRun ? () => { void run(() => runVcrStep(studyId, step), "这一步无法开始，请稍后重试。"); } : undefined;
  return (
    <div data-vcr-step-empty={step} className="flex flex-col items-center gap-4">
      <StepState
        phase="empty"
        step={start?.label ?? action}
        noun={VCR_STEP_NOUNS[step]}
        uses={uses}
        gives={hint ?? VCR_STEP_GIVES[step]}
        onStart={startHere}
        starting={start ? start.busy : busy}
        reason={startHere ? undefined : blocked || "需要有运行权限的成员来开始这一步。"}
      />
      {start?.note}
    </div>
  );
}

/** A step started directly rather than by the programme: the button's name, whether it is working, and what it said last. */
export interface VcrStepStart {
  label: string;
  busy: boolean;
  onStart: () => void;
  /** What came of the last press, under the button. */
  note?: ReactNode;
}

/**
 * What every empty tab of a study with no definition says: the study is waiting for its first sentence, which is said in its
 * conversation — and the one button that goes there, as a view of this page. Not 「正在排队」: nothing is queued.
 */
export function VcrNoDefinition({ study }: { study: Pick<VcrStudy, "id" | "abilities"> }) {
  const frame = useStudyFrame();
  const navigate = useNavigate();
  const go = () => (frame ? frame.openChat() : navigate(vcrChatPath(study.id)));
  return (
    <div data-vcr-no-definition="">
      <EmptyState
        icon={MessageSquare}
        title={VCR_NO_DEFINITION}
        action={<Button onClick={go}>说明研究问题</Button>}
      />
    </div>
  );
}

/**
 * 「这一步未完成」: a step whose run did not finish. A failed step is never
 * drawn as one that has not started (plan §9.6): it says it did not finish,
 * what it kept, and offers to go on from the checkpoint — a retry that begins
 * from nothing would throw away what was already computed (principle 19).
 * `partial` is the run's own account of what is on screen and what is not.
 */
export function VcrStepFailed({ studyId, study, step, partial }: {
  studyId: string;
  study: VcrStudy;
  step: VcrStepKey;
  partial?: VcrPartial | null;
}) {
  const { run, busy } = useVcrRun(study);
  const note = study.steps[step]?.note;
  return (
    <section data-vcr-step-failed={step} role="status" className="rounded-card border border-border bg-surface p-4">
      <h3 className="flex items-center gap-2 text-section font-semibold text-text">
        <TriangleAlert size={20} aria-hidden="true" className="text-warn" />
        这一步未完成
        <span className="text-ui font-normal text-text-3">{stepLabel(step)}</span>
      </h3>
      {note && <p className="mt-1 text-ui text-text-2">{note}</p>}
      {partial && <PartialResultNote sentence={partial.sentence} className="mt-3" />}
      {study.abilities.includes("run") && (
        <div className="mt-3">
          <Button variant="secondary" loading={busy} onClick={() => run(() => runVcrStep(studyId, step), "这一步无法继续，请稍后重试。")}>
            接着做
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * 「输入已变更，排队重算中」 — the pale bar over a result whose inputs moved
 * under it. Its numbers are still true of the inputs they were computed from,
 * which is why they are still on screen. It says 「排队重算中」 only when a
 * recomputation is actually queued.
 */
export function StaleBar({ reason, queued = false, className }: { reason?: string | null; queued?: boolean; className?: string }) {
  return (
    <p data-vcr-stale="" className={cn("flex items-center gap-2 rounded bg-surface-2 px-2 py-1 text-caption text-text-3", className)}>
      <History size={16} aria-hidden="true" />
      <span>{reason ? `${reason} · ${staleSentence(queued)}` : staleSentence(queued)}</span>
    </p>
  );
}

/**
 * A stale block of results: the bar, then the results themselves in the
 * secondary colour. Every result block of every tab is wrapped in one, driven
 * by the payload's own `stale` note — a stale number that was merely dimmed,
 * with no bar to say why, was the defect this replaces.
 */
export function Stale({ note, children }: { note: VcrStaleNote | null | undefined; children: ReactNode }) {
  if (!note) return <>{children}</>;
  return (
    <div data-vcr-stale-block="">
      <StaleBar reason={note.reason} queued={note.queued} className="mb-3" />
      <div className="text-text-2 opacity-disabled">{children}</div>
    </div>
  );
}

/**
 * 「不可估计」 — a finished result, not a blank and not a zero (plan §9.6).
 *
 * It says which data are missing and, for each, what the study could answer
 * once it is there; that second half is the whole point, and a card without
 * it would be a refusal dressed as a finding.
 */
export function NotEstimableCard({
  title = "不可估计",
  needs,
  items,
  conclusion,
  className,
}: {
  title?: string;
  /** What the route would need at minimum: 「需要 T2 · 完整治疗与纵向结局」. */
  needs?: string | null;
  items: ReadonlyArray<{ title: string; detail?: string | null; answers?: string | null }>;
  /** 「三项补齐后可估计：…」. */
  conclusion?: string | null;
  className?: string;
}) {
  return (
    <section data-vcr-not-estimable="" className={cn("rounded-card border border-border bg-surface p-4", className)}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="flex items-center gap-2 text-section font-semibold text-text">
          <CircleDashed size={20} aria-hidden="true" className="text-warn" />
          {title}
          <span className="text-ui font-normal text-text-3">{`缺 ${items.length} 项数据`}</span>
        </h3>
        {needs && <span className="text-caption text-text-3">{needs}</span>}
      </header>
      <ol className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item, index) => (
          <li key={item.title} className="rounded border border-border bg-surface-1 p-3">
            <p className="flex items-baseline gap-2 text-ui font-medium text-text">
              <span aria-hidden="true" className="text-caption tabular-nums text-text-3">{index + 1}</span>
              {item.title}
            </p>
            {item.detail && <p className="mt-1 text-caption text-text-3">{item.detail}</p>}
            {item.answers && (
              <p className="mt-2 text-caption text-text-2">
                <span className="text-text-3">补上后能回答</span>
                <br />
                {item.answers}
              </p>
            )}
          </li>
        ))}
      </ol>
      {conclusion && <p className="mt-3 text-ui text-text-2">{conclusion}</p>}
    </section>
  );
}

/**
 * 部分结果: a computation that stopped part-way keeps what it finished (principle 19), and says so in **one line**, in Chinese —
 * how far it got, why it stopped, and that what is below is what was done (「这次模拟算完了 18,000 / 20,000 次重复就到了计算时间上限，下面是已完成部分的结果。」).
 * The sentence is the server's, written from the result's own record; the engine's English note and a second box saying the same
 * thing are what this replaces (2026-10-07). 「续算」 is offered when the reader may run the step: it goes on from where it stopped.
 */
export function PartialResultNote({ sentence, resume, className }: {
  sentence: string;
  /** The step this result belongs to, when the reader may continue it. */
  resume?: { studyId: string; study: VcrStudy; step: VcrStepKey };
  className?: string;
}) {
  return (
    <p data-vcr-partial="" role="status" className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-surface-2 px-3 py-2 text-ui text-text-2", className)}>
      <span className="min-w-0 flex-1">{sentence}</span>
      {resume && <ResumeStep {...resume} />}
    </p>
  );
}

/** 「续算」: the step asked for again — the failed marks are cleared and the computation goes on from its checkpoint; the page stays and the strip says so. */
function ResumeStep({ studyId, study, step }: { studyId: string; study: VcrStudy; step: VcrStepKey }) {
  const { run, busy } = useVcrRun(study);
  const status = study.steps[step]?.status;
  // A step already running or queued is going on by itself, and a reader who may not run steps is not offered a button that is refused.
  if (!study.abilities.includes("run") || status === "running" || status === "queued") return null;
  return (
    <Button size="sm" variant="text" loading={busy} onClick={() => run(() => runVcrStep(studyId, step), "这一步无法继续，请稍后重试。")}>续算</Button>
  );
}

/**
 * 模型或数据不适用: the route or the model cannot answer here. It names the
 * item that is out of range and the ways round it; it never substitutes a
 * made-up trajectory (plan §10.5).
 */
export function NotApplicableCard({ title, reason, options, className }: {
  title: string;
  reason: string;
  /** 「换一个合适的模型」「用文献模型或情景模型」「提一个数据需求」. */
  options?: readonly string[];
  className?: string;
}) {
  return (
    <section data-vcr-not-applicable="" className={cn("rounded-card border border-border bg-surface p-4", className)}>
      <h3 className="text-section font-semibold text-text">{title}</h3>
      <p className="mt-1 text-ui text-text-2">{reason}</p>
      {options && options.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-caption text-text-3">
          {options.map((option) => <li key={option}>{option}</li>)}
        </ul>
      )}
    </section>
  );
}
