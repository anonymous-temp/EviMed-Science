/**
 * Projects the platform keeps in an account for its own background work.
 *
 * Hidden knowledge: a bounded run takes its project's runtime, and opening
 * that project answers 423 until the run ends (`assertInteractiveRuntimeAvailable`).
 * The learning loop used to run in the researcher's own project — the one the
 * lesson came from — and once it stopped waiting for the night (2026-09-21) a
 * researcher who asked a follow-up after a delivery found their conversation
 * locked for the minutes a distillation takes. So the loop's runs live in a
 * project of their own, which the researcher never sees, which never takes
 * one of their runtime slots, and which never counts against their projects.
 *
 * The paired evaluation creates its own project through the public API
 * (`evals/method-quality/configs/*.json`, `eval-method-*`); it is the platform
 * measuring itself and is hidden the same way.
 *
 * @module internalProjects
 */

/** Where the learning loop's own runs happen, one per account. */
export const LEARNING_PROJECT_ID = "evimed-learning";

/** What the project is called where an operator lists everything. */
export const LEARNING_PROJECT_NAME = "EviMed 学习";

/** @param {unknown} projectId @returns {boolean} */
export function isInternalProject(projectId) {
  const id = String(projectId ?? "");
  return id === LEARNING_PROJECT_ID || /^eval-method-[a-z0-9-]+$/.test(id);
}
