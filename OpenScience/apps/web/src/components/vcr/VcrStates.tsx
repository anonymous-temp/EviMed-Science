import { useState, type ReactNode } from "react";
import { CircleDashed, History, TriangleAlert, UsersRound } from "lucide-react";
import { runVcrStep, type VcrPartial, type VcrStaleNote, type VcrStepKey, type VcrStudy } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { allowanceWaitingSentence } from "@evimed/domain";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import { AllowanceTopUp } from "@/components/runs/AllowanceTopUp";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { useOpenVcrConversation } from "./useOpenVcrConversation";
import { useVcrRun } from "./useVcrRun";
import { staleSentence, stepLabel, VCR_NO_DEFINITION, VCR_STEP_EMPTY, VCR_STEP_QUEUED } from "./vcrText";
import { hasDefinition } from "./vcrTabs";

/**
 * The states every 「虚拟临研」 surface shares.
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
export const VCR_OFF_SENTENCE = "虚拟临研还没有在这个工作空间开放。";

/**
 * The module-off page: one sentence, nothing to click. The navigation row is
 * already gone for this account; this is what a bookmark or a forwarded link
 * finds.
 */
export function VcrOffPage() {
  return (
    <PageShell title="虚拟临研">
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

/** A study page's first paint: the rail, the tab row and the number band. */
export function VcrStudySkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true" data-vcr-loading="study">
      <Bar className="h-20 rounded-card" />
      <div className="mt-6 flex h-10 items-end gap-6 border-b border-border">
        {Array.from({ length: 7 }, (_, index) => <Bar key={index} className="mb-3 h-3.5 w-10" />)}
      </div>
      <div className="mt-6 grid grid-cols-2 gap-px rounded-panel border border-border bg-border lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => <Bar key={index} className="h-28 rounded-none" />)}
      </div>
    </div>
  );
}

/** A tab's first paint. */
export function VcrTabSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div data-vcr-loading="tab" className="animate-pulse" aria-hidden="true">
      <Bar className="h-8 w-48 rounded-full" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="mt-4 flex flex-col gap-2 border-b border-faint pb-4">
          <Bar className={cn("h-3.5", index % 2 ? "w-2/3" : "w-3/4")} />
          <Bar className="h-3 w-1/4" />
        </div>
      ))}
    </div>
  );
}

/**
 * What a tab shows while it has nothing to show. A step being worked on says
 * so in one quiet line; a step that has not run offers 「让 AI 做」, which
 * starts it in the study's own conversation — the study page never grows a
 * second composer (plan §9.5). A step that failed with nothing to show says
 * so, and offers to go on from where it stopped rather than to begin again.
 */
export function VcrStepPending({ studyId, study, step }: { studyId: string; study: VcrStudy; step: VcrStepKey }) {
  const state = study.steps[step];
  // A queued step the allowance would not start is not work under way: it says what it waits on and where that is put right.
  const allowanceWait = stepAllowanceWait(state);
  if (allowanceWait) {
    return (
      <div data-vcr-step-allowance={step} role="status" className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="max-w-measure text-ui text-text-2">{allowanceWaitingSentence(stepLabel(step), allowanceWait)}</p>
        <AllowanceTopUp waiting={allowanceWait} />
      </div>
    );
  }
  if (state?.status === "running" || state?.status === "queued") {
    return (
      <p data-vcr-step-running={step} className="flex items-center justify-center gap-2 py-12 text-ui text-text-3">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-dot-running" />
        正在进行，做完会显示在这里。
      </p>
    );
  }
  if (state?.status === "failed") return <VcrStepFailed studyId={studyId} study={study} step={step} />;
  // Nothing waits in a queue for a study nobody has described: the one thing missing is the first sentence, and it is said that way.
  if (!hasDefinition(study)) return <VcrNoDefinition study={study} />;
  if (state?.status === "none" && state.requested === true) {
    return <p data-vcr-step-waiting={step} className="py-12 text-center text-ui text-text-3">{VCR_STEP_QUEUED}</p>;
  }
  return <VcrStepAsk studyId={studyId} study={study} step={step} />;
}

/**
 * What every empty tab of a study with no definition says: the study is waiting for its first sentence, which is said in the
 * conversation — and a way into it. Not 「正在排队」: nothing is queued.
 */
export function VcrNoDefinition({ study }: { study: Pick<VcrStudy, "projectId" | "sessionId" | "abilities"> }) {
  const open = useOpenVcrConversation();
  const [opening, setOpening] = useState(false);
  const go = () => {
    if (opening) return;
    setOpening(true);
    void open({ projectId: study.projectId, sessionId: study.sessionId })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "对话暂时无法打开，请稍后重试。" })))
      .finally(() => setOpening(false));
  };
  return (
    <div data-vcr-no-definition="" className="flex flex-col items-center gap-4 py-12 text-center">
      <p className="max-w-measure text-ui text-text-2">{VCR_NO_DEFINITION}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {/* There is nothing for the AI to start from yet: the button is there, and says why it is not pressable. */}
        {study.abilities.includes("run") && <Button disabled title={VCR_NO_DEFINITION}>让 AI 做</Button>}
        <Button variant="secondary" onClick={go} loading={opening}>去对话</Button>
      </div>
    </div>
  );
}

/** 「让 AI 做」: one sentence about the step and the button that starts it. */
function VcrStepAsk({ studyId, study, step }: { studyId: string; study: VcrStudy; step: VcrStepKey }) {
  const { run, busy } = useVcrRun(study);
  return (
    <div data-vcr-step-empty={step} className="flex flex-col items-center gap-4 py-12 text-center">
      <p className="max-w-measure text-ui text-text-2">{VCR_STEP_EMPTY[step]}</p>
      {/* Starting a step is `run`'s: a reader who cannot start one is not offered the button. */}
      {study.abilities.includes("run") && (
        <Button onClick={() => run(() => runVcrStep(studyId, step), "这一步无法开始，请稍后重试。")} loading={busy}>让 AI 做</Button>
      )}
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
      {partial && <PartialResultNote done={partial.done} missing={partial.missing} className="mt-3" />}
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
 * 部分结果: a computation that failed part-way keeps what it finished
 * (principle 19). What is on screen is named, and so is what is missing —
 * never a silent gap, and never a retry that starts from the beginning.
 */
export function PartialResultNote({ done, missing, className }: { done: string; missing: string; className?: string }) {
  return (
    <p data-vcr-partial="" role="status" className={cn("rounded border border-border bg-surface-1 px-3 py-2 text-caption text-text-2", className)}>
      <span className="font-medium text-text">已完成的部分保留：</span>
      {done}
      <span className="text-text-3">{`；未完成：${missing}`}</span>
    </p>
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
