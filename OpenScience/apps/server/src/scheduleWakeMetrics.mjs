// The operator's counter for waking runtimes for scheduled tasks (`scheduleWake.mjs`). Principle 15: every limit has a counter.
//
//   open_science_schedule_wake_total{outcome}
//       woken | rested                 a stopped runtime started for a due task; one it started stopped again
//       no_balance | no_room | failed  the wake waited: the account's allowance, the deployment's room, the start itself
//       observe_failed | tick_failed   the bookkeeping failed; a task is delivered at the next start whatever happened here

export const SCHEDULE_WAKE_OUTCOMES = Object.freeze(["woken", "rested", "no_balance", "no_room", "failed", "observe_failed", "tick_failed"]);

const counts = new Map(SCHEDULE_WAKE_OUTCOMES.map((outcome) => [outcome, 0]));

/** @param {string} outcome */
export function recordScheduleWake(outcome) {
  if (counts.has(outcome)) counts.set(outcome, Number(counts.get(outcome)) + 1);
}

export function scheduleWakeMetricFamilies() {
  return [{
    name: "open_science_schedule_wake_total",
    help: "What the control plane did about runtimes with a scheduled task due, by outcome.",
    type: "counter",
    series: [...counts].map(([outcome, value]) => ({ labels: { outcome }, value })),
  }];
}
