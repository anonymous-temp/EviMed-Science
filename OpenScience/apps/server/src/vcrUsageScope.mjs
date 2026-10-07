/**
 * The usage scope of a 「虚拟临研」 study's own model calls: the ones no run asked
 * for, so that none of them is booked to nobody.
 *
 * Hidden knowledge:
 *
 * - **A scope is a `run_id` the ledger and the billing can both sum.** The usage
 *   ledger attributes a model call to a run id, and the research billing settles
 *   a run by summing the rows whose `run_id` is in that run's keys
 *   (`runUsageKeys`, `evimedCreditsService.settleTask`). A call with no run id was
 *   in neither: on 2026-10-04, 59 of the module's 79 second-opinion reviews (¥22.53
 *   of ¥29.75) had none — they were queued by the orchestrator when a computation
 *   finished, which no run had asked for. Autopilot solved the same problem for a
 *   planner decision by naming the episode as the run (`autopilotUsageScope`); a
 *   study is the module's episode.
 * - **Keyed by the study's project, not by the study.** A study is one row on top
 *   of one ordinary project, and a run knows its project and nothing of the study:
 *   the scope has to be computable from what a run object carries, or the billing
 *   could not find it.
 * - **A call that was asked for by a run keeps that run.** The scope is only the
 *   default for a call nothing asked for; a review requested after a package run
 *   finished still names that run.
 *
 * @module vcrUsageScope
 */

/** @param {unknown} projectId @returns {string | null} the scope, or null for a project id no scope can carry */
export function vcrUsageScope(projectId) {
  return typeof projectId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(projectId) ? `vcr-project-${projectId}` : null;
}

/**
 * The scope a module run's settlement also sums: the run is the module's when its
 * dispatch id says so (`vcrDispatchId`), and the scope is its project's.
 * @param {any} run @returns {string | null}
 */
export function vcrRunUsageScope(run) {
  return String(run?.dispatchId ?? "").startsWith("vcr-") ? vcrUsageScope(run?.projectId) : null;
}
