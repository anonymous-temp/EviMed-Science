import type { ReactNode } from "react";
import { Link } from "react-router";
import { CircleDashed, TriangleAlert } from "lucide-react";
import { allowanceWaitingSentence } from "@evimed/domain";
import { useElapsed } from "@/lib/useElapsed";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import type { ActivityCounts } from "@/components/ui/ActivityStrip";

/**
 * What a step's tab shows while it has nothing to show (R19, plan §2.2 rules 6 and 8; D §3.1).
 *
 * One body for the five states of a step, in place of `StepPending` (geo), `VcrStepPending`, `VcrStepAsk` and the overview's
 * own 「正在进行：」 — 23 call sites that each said less than the person needed. Whatever the state, it says **what is done,
 * when it starts, where the conversation is and how to stop it**, and never a lone 「正在进行」:
 *
 *  - `empty` — a recipe, not an explanation: what the step uses (each one clickable), what it gives, and the one button that
 *    names the work as a verb and its object (「生成虚拟患者」, not 「让 AI 做」). The button is the start; it does not take the
 *    person away — the page's activity strip says what happens next;
 *  - `queued` — waiting its turn: for which step, with 取消;
 *  - `running` — what is being done, how far (`counts`, no percentage), for how long, and 停止;
 *  - `failed` — it did not finish, what was kept and 接着做 (a retry that begins from nothing would throw away what was
 *    computed);
 *  - `credits` — it is waiting for the allowance, and where to put that right (`topUp`).
 *
 * Props are the facts (`phase`, `counts`, `startedAt`, `onStop`, `to`); the sentences are composed here, in one place, so no
 * two pages word a state differently. `data-step-state` carries the phase for the walk; the empty phase is an `EmptyState`
 * (`data-empty`) with its icon, title and action.
 */
export type StepPhase = "empty" | "queued" | "running" | "failed" | "credits";

export interface StepInput {
  label: string;
  to?: string;
  onOpen?: () => void;
}

export interface StepStateProps {
  phase: StepPhase;
  /** The work as the person would ask for it, verb and object: 「生成虚拟患者」. */
  step: string;
  /** What the step makes: the empty title is 「还没有虚拟患者」. Absent, the title is `step`. */
  noun?: string;
  /** The conversation behind the step, for 「查看对话」. */
  to?: string;

  /** `empty`: what the step uses, each one a way to the thing itself. */
  uses?: readonly StepInput[];
  /** `empty`: what it gives, as a noun phrase (「2,000 名虚拟患者的基线与随访轨迹」). */
  gives?: string;
  /** `empty`: starts the step. Absent where the person may not, with `reason` saying so. */
  onStart?: () => void;
  starting?: boolean;
  /** `empty` without a button: why there is none. */
  reason?: string;

  /** `queued`: the step it waits for. */
  after?: string;

  /** `running`: what `counts` counts (「计算」). */
  phaseName?: string;
  counts?: ActivityCounts;
  startedAt?: string | number | Date | null;
  onStop?: () => void;
  stopping?: boolean;

  /** `failed`: what was kept (「已算出的 1,200 名保留」), and the reason in the person's words. */
  kept?: string;
  failure?: string;
  onResume?: () => void;
  resuming?: boolean;

  /** `credits`: which wallet refused it, and the control that tops it up. */
  waiting?: "allowance" | "simulated_allowance";
  topUp?: ReactNode;
}

const NUMBER = new Intl.NumberFormat("zh-CN");

const SHELL = "flex flex-col items-center gap-3 px-6 py-12 text-center";

export function StepState(props: StepStateProps) {
  const { phase, step, noun, to, uses = [], gives, onStart, starting, reason, after, phaseName, counts, startedAt, onStop, stopping,
    kept, failure, onResume, resuming, waiting, topUp } = props;
  const elapsed = useElapsed(startedAt, phase === "running");
  const conversation = to ? <Link to={to} className="rounded text-ui text-link hover:underline">查看对话</Link> : null;

  if (phase === "empty") {
    const recipe = (uses.length > 0 || gives) ? (
      <div className="flex flex-col gap-1">
        {uses.length > 0 && (
          <p>
            <span>用 </span>
            {uses.map((input, index) => (
              <span key={`${index}-${input.label}`}>
                {index > 0 && <span aria-hidden="true"> · </span>}
                {input.to
                  ? <Link to={input.to} className="rounded text-link hover:underline">{input.label}</Link>
                  : input.onOpen
                    ? <button type="button" onClick={input.onOpen} className="rounded text-link hover:underline">{input.label}</button>
                    : <span>{input.label}</span>}
              </span>
            ))}
          </p>
        )}
        {gives && <p>{`得到 ${gives}`}</p>}
      </div>
    ) : undefined;
    return (
      <div data-step-state="empty">
        <EmptyState
          icon={CircleDashed}
          title={noun ? `还没有${noun}` : step}
          description={recipe}
          reason={onStart ? undefined : reason}
          action={onStart ? <Button onClick={onStart} loading={starting}>{step}</Button> : undefined}
        />
      </div>
    );
  }

  if (phase === "queued") {
    return (
      <div data-step-state="queued" role="status" className={SHELL}>
        <p className="text-ui font-medium text-text">{`${step}，排队中`}</p>
        <p className="text-caption text-text-3">{after ? `“${after}”做完后自动开始。` : "轮到它时会自动开始。"}</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {conversation}
          {onStop && <Button size="sm" variant="secondary" loading={stopping} onClick={onStop}>取消</Button>}
        </div>
      </div>
    );
  }

  if (phase === "running") {
    const detail = counts && counts.total > 0 ? `${phaseName ? `${phaseName} ` : ""}${NUMBER.format(counts.done)} / ${NUMBER.format(counts.total)}` : phaseName;
    return (
      <div data-step-state="running" role="status" className={SHELL}>
        <p className="flex items-center gap-2 text-ui font-medium text-text">
          <span aria-hidden="true" data-forced-colors="preserve" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-dot-running" />
          {`正在${step}`}
        </p>
        {(detail || elapsed) && (
          <p className="text-caption tabular-nums text-text-3">{[detail, elapsed && `已进行 ${elapsed}`].filter(Boolean).join(" · ")}</p>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3">
          {conversation}
          {onStop && <Button size="sm" variant="secondary" loading={stopping} onClick={onStop}>停止</Button>}
        </div>
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div data-step-state="failed" role="status" className={SHELL}>
        <p className="flex items-center gap-2 text-ui font-medium text-text">
          <TriangleAlert size={20} aria-hidden="true" className="text-warn" />
          {`${step}没有完成`}
        </p>
        {failure && <p className="max-w-measure text-ui text-text-2">{failure}</p>}
        {kept && <p className="text-caption text-text-3">{kept}</p>}
        <div className="flex flex-wrap items-center justify-center gap-3">
          {onResume && <Button variant="secondary" loading={resuming} onClick={onResume}>接着做</Button>}
          {conversation}
        </div>
      </div>
    );
  }

  return (
    <div data-step-state="credits" role="status" className={SHELL}>
      <p className="max-w-measure text-ui text-text-2">{allowanceWaitingSentence(step, waiting ?? "allowance")}</p>
      {topUp}
    </div>
  );
}
