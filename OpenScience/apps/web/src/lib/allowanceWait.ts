/** What a step waiting on the allowance is waiting on, as the step record carries it (`STEP_WAITING_ALLOWANCE`). */
export type AllowanceWaiting = "allowance" | "simulated_allowance";

/**
 * Whether a step's record says it waits on the allowance — and only while it is
 * queued: a step that has started, finished or failed waits on nothing, whatever
 * an older write left on its record.
 */
export function stepAllowanceWait(step: { status?: string; waiting?: string | null } | null | undefined): AllowanceWaiting | null {
  if (step?.status !== "queued") return null;
  return step.waiting === "allowance" || step.waiting === "simulated_allowance" ? step.waiting : null;
}
