import { useEffect, useState } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { Disclosure } from "@/components/ui/Disclosure";

/**
 * A program's steps as one rail in the page header, with what each step
 * produced under its name (appendix E §3.2: no product surveyed makes its
 * workflow the navigation — the workflow is a rail and a task list, and the
 * tabs answer the reader's questions instead).
 *
 * Four states, each said three ways — shape, colour, word:
 *
 *  - `done` — a filled accent disc with a tick, and an accent connector.
 *  - `active` — an accent ring: being worked on now.
 *  - `waiting` — an accent ring inside an accent halo, and the note in the
 *    accent: **this is the step waiting for the reader**, and it is the one
 *    thing on the page a person must act on.
 *  - `todo` — a quiet ring.
 *
 * The rail is not a progress bar and there is never a second one: a percentage
 * on work an agent is doing is a number nobody can honour.
 *
 * On a phone eight steps in two columns are four rows of header before the
 * page begins. Given a `summary` the rail folds there into one line — what is
 * done and what is waited for — and the steps open under it; wider screens
 * always see the steps.
 */

export type RailState = "done" | "active" | "waiting" | "todo";

const STATE_WORDS: Record<RailState, string> = {
  done: "已完成",
  active: "进行中",
  waiting: "等你",
  todo: "未开始",
};

export interface RailStep {
  key: string;
  /** The step's name. */
  name: string;
  /** What it produced, in the reader's words: 「86 条事实」「32 篇」. */
  note?: string | null;
  state: RailState;
  /** Where the step's own result is read. */
  to?: string;
}

/** Whether the viewport is under the `sm` breakpoint (640 px); a test environment without a layout is never narrow. */
function useNarrow(): boolean {
  const query = "(max-width: 639px)";
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return narrow;
}

export function ProgressRail({
  label,
  steps,
  summary,
  className,
}: {
  /** The rail's accessible name. */
  label: string;
  steps: readonly RailStep[];
  /** One line standing for the rail on a phone: 「已完成 7 / 8 步 · 投放等媒介集市接通」. */
  summary?: string;
  className?: string;
}) {
  const narrow = useNarrow();
  const list = (
    <ol
      aria-label={label}
      className={cn(
        "grid grid-cols-2 gap-x-4 gap-y-4 rounded-card border border-border bg-surface px-4 py-3 sm:grid-cols-4 lg:grid-cols-8 lg:gap-x-0",
        summary && narrow && "border-0 px-0 py-0",
        !(summary && narrow) && className,
      )}
    >
      {steps.map((step, index) => (
        <li key={step.key} data-rail-step={step.key} data-rail-state={step.state} className="relative min-w-0">
          {/* The connector belongs to the step it leaves, and stops at the
              last one; it only joins steps that share a row. */}
          {index < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute left-4 right-0 top-1.5 hidden h-px lg:block",
                step.state === "done" ? "bg-accent" : "bg-border",
              )}
            />
          )}
          <RailMark state={step.state} />
          <Body step={step} />
        </li>
      ))}
    </ol>
  );
  if (!summary || !narrow) return list;
  return (
    <div data-rail-folded="" className={cn("rounded-card border border-border bg-surface px-4 py-2", className)}>
      <Disclosure summary={summary} summaryClassName="w-full text-text">{list}</Disclosure>
    </div>
  );
}

function Body({ step }: { step: RailStep }) {
  const body = (
    <>
      <span className={cn("block truncate text-ui font-medium", step.state === "todo" ? "text-text-3" : "text-text")}>
        {step.name}
        <span className="sr-only">{`，${STATE_WORDS[step.state]}`}</span>
      </span>
      {step.note && (
        <span className={cn("mt-0.5 block truncate text-caption", step.state === "waiting" ? "font-medium text-accent" : "text-text-3")}>
          {step.note}
        </span>
      )}
    </>
  );
  return step.to
    ? <Link to={step.to} className="mt-2.5 block min-w-0 rounded">{body}</Link>
    : <span className="mt-2.5 block min-w-0">{body}</span>;
}

/** The mark itself: drawn, because no icon fits inside a 14 px disc. */
function RailMark({ state }: { state: RailState }) {
  return (
    <span
      aria-hidden="true"
      data-status-mark=""
      className={cn(
        "relative z-10 block h-3.5 w-3.5 rounded-full",
        state === "done" && "bg-accent",
        state === "active" && "border-2 border-accent bg-surface",
        state === "waiting" && "border-2 border-accent bg-surface ring-4 ring-accent-soft",
        state === "todo" && "border border-border-control bg-surface",
      )}
    >
      {state === "done" && (
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 text-accent-fg">
          <path d="M4 7.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}
