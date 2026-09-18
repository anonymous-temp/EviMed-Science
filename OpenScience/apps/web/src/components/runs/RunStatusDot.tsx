import { cn } from "@/lib/cn";
import { RUN_STATE_LABEL, type RunStateKey } from "@/lib/runPresentation";

/**
 * The mark beside a run, drawn from the one rule in `runState`.
 *
 * Five states, each with its own shape as well as its own colour (appendix D
 * §10.3): running is a pulsing circle, delivered a filled circle, delivered
 * with an open verdict a diamond, not delivered a square, cancelled a hollow
 * circle. Red and green mean opposite things in a Chinese market chart to what
 * they mean in a Western one, and one reader in twelve cannot tell them apart
 * at all, so the shape carries the state and the colour only repeats it.
 *
 * The word goes with it: `labelled` renders it as screen-reader text for a
 * list that already prints the label beside the dot; otherwise it is the
 * mark's accessible name and tooltip.
 */
export function RunStatusDot({
  state,
  className,
  labelled = false,
}: {
  state: RunStateKey;
  className?: string;
  /** The row prints the state's word itself; the dot is then decoration. */
  labelled?: boolean;
}) {
  const label = RUN_STATE_LABEL[state];
  return (
    <span
      className={cn("inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center", className)}
      data-run-state={state}
      {...(labelled
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label, title: label })}
    >
      <span
        className={cn(
          state === "running" && "h-2 w-2 animate-pulse rounded-full bg-dot-running",
          state === "done" && "h-2 w-2 rounded-full bg-dot-done",
          state === "review" && "h-1.5 w-1.5 rotate-45 bg-dot-review",
          state === "failed" && "h-2 w-2 bg-dot-failed",
          state === "canceled" && "h-2 w-2 rounded-full border-2 border-dot-canceled",
        )}
      />
    </span>
  );
}
