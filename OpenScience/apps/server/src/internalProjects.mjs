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
 * Understanding an uploaded document is the same kind of work and lives the
 * same way, in its own project: a knowledge-base upload used to reserve the
 * researcher's project runtime, stop their conversation's container to start
 * one on a subdirectory the runtime controller never mounts, and fail every
 * upload after locking the project (2026-09-21, reproduced live).
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

/** Where the understanding runs of uploaded documents happen, one per account. */
export const SOURCES_PROJECT_ID = "evimed-sources";

/** What that project is called where an operator lists everything. */
export const SOURCES_PROJECT_NAME = "EviMed 资料";

/**
 * Where the frontier feed's model calls are billed (「前沿动态」, plan §7.2):
 * one project, under the first operator account, made when the feed's worker
 * starts. The feed is the platform's own work for every reader at once — no
 * researcher asked for it and none should see it in their spend — and the
 * usage ledger wants a real account and project for every row, so it borrows
 * an operator's, the way the learning loop borrows each researcher's.
 */
export const FRONTIER_PROJECT_ID = "evimed-frontier";

/** What the frontier project is called where an operator lists everything. */
export const FRONTIER_PROJECT_NAME = "EviMed 前沿动态";

/**
 * The paired evaluation's cells, one short-lived project each
 * (`learningEvaluation.mjs`). Missing from this list until 2026-09-21, so
 * while an evaluation ran its 「Private method evaluation」 projects sat in the
 * researcher's project list and held their runtime slots.
 */
const EVALUATION_CELL_PROJECT = /^methodeval-[a-f0-9]{24}$/;

/** @param {unknown} projectId @returns {boolean} */
export function isInternalProject(projectId) {
  const id = String(projectId ?? "");
  return id === LEARNING_PROJECT_ID || id === SOURCES_PROJECT_ID || id === FRONTIER_PROJECT_ID
    || /^eval-method-[a-z0-9-]+$/.test(id) || EVALUATION_CELL_PROJECT.test(id);
}

/**
 * How many of the deployment's runtimes the platform's own background work may
 * hold at once: all but one researcher's full share, and never fewer than one.
 *
 * Background work now runs around the clock — learning, document
 * understanding, paired evaluations of hours — and on 2026-09-21 it could hold
 * every one of the four runtimes, so a researcher opening a project was
 * refused. It waits for room instead; a researcher never waits for it. The
 * runtime controller and the control plane compute the same number.
 * @param {number | null | undefined} maxGlobal @param {number | null | undefined} maxPerUser
 * @returns {number | null} null when the deployment sets no global ceiling
 */
export function backgroundRuntimeLimit(maxGlobal, maxPerUser) {
  const global = Number(maxGlobal);
  if (maxGlobal == null || !Number.isFinite(global) || global <= 0) return null;
  const share = Number(maxPerUser);
  return Math.max(1, global - (maxPerUser != null && Number.isFinite(share) && share > 0 ? share : 1));
}
