import { Link } from "react-router";
import { vcrNext, VCR_STEP_STATUS_LABELS_ZH } from "@evimed/domain";
import { cn } from "@/lib/cn";
import type { VcrStepKey, VcrStudySummary } from "@/lib/vcrClient";
import { stepAction, stepName } from "./vcrActivity";
import { VCR_RAIL_STEPS, VCR_STEP_TABS, vcrTabPath } from "./vcrTabs";

/** The marks a step wears, shaped as the tabs' dots are: a filled dot is done, a ring is under way, an amber diamond needs the reader, a small hollow one is not started. */
const MARK: Record<"done" | "active" | "attention" | "todo", string> = {
  done: "h-2 w-2 rounded-full bg-accent",
  active: "h-2 w-2 rounded-full bg-surface ring-2 ring-accent",
  attention: "h-2 w-2 rotate-45 bg-warn",
  todo: "h-1.5 w-1.5 rounded-full bg-surface-2 ring-1 ring-border-control",
};

export type StepMarkState = keyof typeof MARK;

export interface ShownStep {
  key: VcrStepKey;
  state: StepMarkState;
  /** The state's word, for the states a reader should not have to guess from a shape (「进行中」「未完成」「已过期」「排队中」); null for done and not started. */
  word: string | null;
}

/**
 * All seven steps of a study's row, in the programme's order — the ones not started included, as a hollow dot (R19, audit B §4.8: the
 * row used to draw only the steps that were done or moving, so a study with two done read as two words and gave no sense of how
 * far seven is).
 */
export function stepsOfRow(steps: VcrStudySummary["steps"]): ShownStep[] {
  return VCR_RAIL_STEPS.map(({ key }) => {
    const status = steps[key]?.status ?? "none";
    if (status === "done" || status === "minimal") return { key, state: "done" as const, word: null };
    if (status === "running" || status === "queued") return { key, state: "active" as const, word: (VCR_STEP_STATUS_LABELS_ZH as Record<string, string>)[status] };
    if (status === "failed" || status === "stale") return { key, state: "attention" as const, word: (VCR_STEP_STATUS_LABELS_ZH as Record<string, string>)[status] };
    return { key, state: "todo" as const, word: null };
  });
}

/**
 * A study's progress in its row: the seven steps in order, **each a link to the tab that holds it** (the word is the link —
 * 「词即链接」, audit B §2.5), how many are done, and the step that comes next, itself a link.
 *
 * The next step is the domain's one function (`vcrNext`), the same the study's own page offers as its primary action, so the row and
 * the page cannot name different steps. A study that is paused says so and offers none.
 *
 * Rendered above the row's stretched title link (`relative z-sticky`), so each word stays a link of its own.
 */
export function VcrStepProgress({ studyId, steps, described = true, paused = false, className }: {
  studyId: string;
  steps: VcrStudySummary["steps"];
  /** Whether the study says what it is about; nothing is next for one that does not. */
  described?: boolean;
  paused?: boolean;
  className?: string;
}) {
  const shown = stepsOfRow(steps);
  const done = shown.filter((entry) => entry.state === "done").length;
  const next = paused ? null : vcrNext({ steps, described });
  const moving = shown.some((entry) => entry.state === "active");
  const spoken = shown.map((entry) => `${stepName(entry.key)}${entry.state === "done" ? "已完成" : entry.word ?? "未开始"}`).join("，");
  return (
    <div data-vcr-progress="" className={cn("relative z-sticky flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-text-2", className)}>
      <ol aria-label={`七个步骤：${spoken}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {shown.map((entry) => (
          <li key={entry.key} data-vcr-step={entry.key} data-vcr-step-state={entry.state}>
            <Link
              to={vcrTabPath(studyId, VCR_STEP_TABS[entry.key])}
              className={cn("inline-flex items-center gap-1.5 rounded hover:text-text hover:underline hover:underline-offset-4", entry.state === "todo" && "text-text-3")}
            >
              <span aria-hidden="true" data-forced-colors="preserve" className={cn("inline-block shrink-0", MARK[entry.state])} />
              <span className={entry.state === "active" ? "font-semibold text-accent" : undefined}>{stepName(entry.key)}</span>
              {entry.word && <span className={entry.state === "attention" ? "text-warn-strong" : "text-accent"}>{entry.word}</span>}
            </Link>
          </li>
        ))}
      </ol>
      <span data-vcr-done="" className="tabular-nums text-text-3">{`${done}/${shown.length} 步`}</span>
      {next && !moving && (
        <Link to={vcrTabPath(studyId, VCR_STEP_TABS[next.step as VcrStepKey])} className="rounded text-link hover:underline">
          {`下一步：${stepAction(next.step as VcrStepKey)}`}
        </Link>
      )}
    </div>
  );
}
