// The operator's counter for the start-up retirement of the platform's own scheduler (`legacySchedulerRetirement.mjs`).
//
//   open_science_scheduler_retirement_total{outcome}
//       documents_deleted | jobs_deleted   rows of the retired kinds taken away (counted by row)
//       checks_narrowed                    the kind CHECKs rebuilt without the retired kinds
//       nothing_left                       the ledger held none of it and the CHECKs were already narrow
//       failed                             the retirement could not run; the next start asks again
//       mission_skipped                    a stored evolution mission of the retired `autopilot` module was met and left as it is

export const SCHEDULER_RETIREMENT_OUTCOMES = Object.freeze(["documents_deleted", "jobs_deleted", "checks_narrowed", "nothing_left", "failed", "mission_skipped"]);

const counts = new Map(SCHEDULER_RETIREMENT_OUTCOMES.map((outcome) => [outcome, 0]));

/** @param {string} outcome @param {number} [by] */
export function recordSchedulerRetirement(outcome, by = 1) {
  if (counts.has(outcome)) counts.set(outcome, Number(counts.get(outcome)) + by);
}

export function resetSchedulerRetirementMetrics() {
  for (const outcome of counts.keys()) counts.set(outcome, 0);
}

export function schedulerRetirementMetricFamilies() {
  return [{
    name: "open_science_scheduler_retirement_total",
    help: "What the start-up retirement of the platform's own scheduler did since this process started: rows of the retired document and job kinds deleted, the kind CHECKs narrowed, nothing left to do, failed, or met a stored evolution mission of the retired autopilot module and skipped it (mission_skipped).",
    type: "counter",
    series: [...counts].map(([outcome, value]) => ({ labels: { outcome }, value })),
  }];
}
