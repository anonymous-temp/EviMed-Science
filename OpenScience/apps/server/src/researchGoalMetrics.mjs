// The operator's counter for what the control plane did about long research goals (`researchGoalService.mjs`).
//
// Principle 15: every limit has a counter. One series, module-level like `researchDbMetrics.mjs`: one process, one table, read by
// `/api/ops/metrics`, every label present from the start at zero.
//
//   open_science_research_goal_events_total{event}
//       paused_no_progress | paused_budget   the guard stopped a goal
//       paused_person | resumed_person       the page's pause and 继续
//       revived | retried | revive_failed    a goal taken up again, or set again because its first turn came back with nothing
//       finished | waiting | interrupted     what a goal with no more rounds came to
//       noted_sources                        a running round was told what was connected meanwhile
//       observe_failed | review_failed | tick_failed   the bookkeeping itself failed; the goal is untouched

export const RESEARCH_GOAL_EVENTS = Object.freeze([
  "paused_no_progress", "paused_budget", "paused_person", "resumed_person",
  "revived", "retried", "revive_failed",
  "finished", "waiting", "interrupted", "noted_sources",
  "observe_failed", "review_failed", "tick_failed",
]);

const counts = new Map(RESEARCH_GOAL_EVENTS.map((event) => [event, 0]));

/** @param {string} event */
export function recordResearchGoalEvent(event) {
  if (counts.has(event)) counts.set(event, Number(counts.get(event)) + 1);
}

export function researchGoalMetricFamilies() {
  return [{
    name: "open_science_research_goal_events_total",
    help: "What the control plane did about long research goals, by event.",
    type: "counter",
    series: [...counts].map(([event, value]) => ({ labels: { event }, value })),
  }];
}
