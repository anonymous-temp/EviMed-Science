import { cn } from "@/lib/cn";
import type { VcrStudySummary, VcrStepKey } from "@/lib/vcrClient";
import { VCR_RAIL_STEPS } from "./vcrTabs";
import { stepLabel } from "./vcrText";

/** The marks a step wears, shaped as the tabs' dots are: a filled dot is done, a ring is under way, an amber diamond needs the reader. */
const MARK: Record<"done" | "active" | "attention", string> = {
  done: "h-2 w-2 rounded-full bg-accent",
  active: "h-2 w-2 rounded-full bg-surface ring-2 ring-accent",
  attention: "h-2 w-2 rotate-45 bg-warn",
};

type Shown = { key: VcrStepKey; state: "done" | "active" | "attention"; word: string | null };

/**
 * Which steps a study's row names, and how: the steps that are done, the one under way and the one that did not finish — in the
 * programme's order. A step not started is not named: a row that listed seven words for a study that has done two read as a form.
 */
export function shownSteps(steps: VcrStudySummary["steps"]): Shown[] {
  const out: Shown[] = [];
  for (const { key } of VCR_RAIL_STEPS) {
    const status = steps[key]?.status;
    if (status === "done" || status === "minimal") out.push({ key, state: "done", word: null });
    else if (status === "running" || status === "queued") out.push({ key, state: "active", word: "进行中" });
    else if (status === "failed" || status === "stale") out.push({ key, state: "attention", word: status === "failed" ? "未完成" : "已过期" });
  }
  return out;
}

/**
 * A study's progress in words: 「● 定义 ● 人群 ○ 试验 进行中」 — the steps it has come through, each with its dot, and what is
 * happening now. The row used to carry seven dots with no words, and a reader had to open the study to learn which dot was which.
 */
export function VcrStepProgress({ steps, className }: { steps: VcrStudySummary["steps"]; className?: string }) {
  const shown = shownSteps(steps);
  const spoken = shown.length
    ? shown.map((entry) => `${stepLabel(entry.key)}${entry.word ? ` ${entry.word}` : "已完成"}`).join("，")
    : "还没有开始";
  return (
    <span data-vcr-progress="" role="img" aria-label={spoken} className={cn("flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-caption text-text-2", className)}>
      {shown.length === 0
        ? <span className="text-text-3">还没有开始</span>
        : shown.map((entry) => (
          <span key={entry.key} aria-hidden="true" data-vcr-step={entry.key} data-vcr-step-state={entry.state} className="inline-flex items-center gap-1.5">
            <span data-forced-colors="preserve" className={cn("inline-block shrink-0", MARK[entry.state])} />
            <span className={entry.state === "active" ? "font-semibold text-accent-strong" : undefined}>{stepLabel(entry.key)}</span>
            {entry.word && <span className={entry.state === "attention" ? "text-warn-strong" : "text-accent-strong"}>{entry.word}</span>}
          </span>
        ))}
    </span>
  );
}
