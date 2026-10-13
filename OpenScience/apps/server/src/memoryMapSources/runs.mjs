/**
 * The map's first radar: what the researcher has been doing with the platform, by the kind of work, now and a month before.
 *
 * Hidden knowledge:
 *
 * - **Axes are fixed and named** (`WORK_AXES`, the closed list of `taskTypes.mjs`): writing, documents and slides, spreadsheets and
 *   data analysis, code, looking things up, medical evidence, other. Never the account's top topics: they would change who is on an
 *   axis from one month to the next, and a polygon whose axes moved means nothing. The medical axis is an axis only when the account
 *   has used it, so a researcher who never touched a clinical capability never sees a clinical axis.
 * - **What a conversation counts under**: the named capability's own category when a specialist answered it (the product's catalogue
 *   says what that work is), else the kind of work a model judged it to be (`runTaskType.mjs`, recorded on the ledger when the
 *   conversation finished). A conversation not yet judged is not counted; reading the map asks for a few of them to be judged, in
 *   the background, and never waits for the answer.
 * - **Shares, not counts**, over the researcher's own finished conversations of the last 30 days and of the 30 before
 *   (`isResearcherRun`: not a scheduled episode, not a continuation, not a source being read). The value at a vertex is the
 *   share; the count it came from rides along so the page can print it. One the researcher deleted, one that failed, and one of
 *   the platform's own internal capabilities does not count.
 *
 * @module memoryMapSources/runs
 */

import { CAPABILITY_DISPLAY } from "@evimed/domain";

import { isResearcherRun } from "../agentRuns.mjs";
import { TASK_TYPES, TASK_TYPE_IDS, TASK_TYPE_OF_CATEGORY, taskTypeLabel } from "../taskTypes.mjs";

/** The days of one period of the radar. */
export const WORK_PERIOD_DAYS = 30;
/** The projects one read walks the ledgers of. */
export const WORK_PROJECT_LIMIT = 12;

/** The axes: the general kinds of work always, and the medical one when used. */
export const WORK_AXES = Object.freeze(TASK_TYPES.map((type) => Object.freeze({ id: type.id, label: type.label, general: type.id !== "medical-evidence" })));

/** The most conversations one read asks to have judged, and the most it looks through to find them. */
export const WORK_BACKFILL_PER_READ = 12;
const WORK_BACKFILL_LOOK = 80;

/**
 * The kind of work a conversation counts under, or null when it counts under none yet.
 * @param {Record<string, any>} run
 */
export function workTypeOf(run) {
  const agent = String(run.effectiveAgentId ?? run.agentId ?? "");
  const catalogue = TASK_TYPE_OF_CATEGORY[CAPABILITY_DISPLAY[agent]?.category ?? ""];
  if (catalogue) return catalogue;
  return TASK_TYPE_IDS.has(run.taskType) ? /** @type {string} */ (run.taskType) : null;
}

/**
 * The researcher's finished conversations in a set of ledger runs, each with the axis it counts under.
 * @param {readonly any[]} runs @param {(agentId: string) => boolean} [isInternal]
 * @returns {{ at: string, label: string, projectId: string | null }[]}
 */
export function workOf(runs, isInternal = () => false) {
  const found = [];
  for (const run of runs ?? []) {
    if (!run?.id || run.deleted === true || run.status !== "succeeded" || !isResearcherRun(run)) continue;
    const agent = String(run.effectiveAgentId ?? run.agentId ?? "");
    if (!agent || isInternal(agent)) continue;
    const type = workTypeOf(run);
    const at = String(run.finishedAt ?? run.startedAt ?? "");
    if (type && at) found.push({ at, label: taskTypeLabel(type), projectId: typeof run.projectId === "string" ? run.projectId : null });
  }
  return found;
}

/**
 * The first radar from the work of two periods.
 * @param {readonly { at: string, label: string }[]} work @param {Date} now
 * @returns {import("./common.mjs").MapDimension}
 */
export function workDimension(work, now) {
  const end = now.getTime();
  const middle = end - WORK_PERIOD_DAYS * 86_400_000;
  const start = middle - WORK_PERIOD_DAYS * 86_400_000;
  const within = (/** @type {{ at: string }} */ item, /** @type {number} */ from, /** @type {number} */ to) => {
    const at = Date.parse(item.at);
    return Number.isFinite(at) && at > from && at <= to;
  };
  const current = work.filter((item) => within(item, middle, end));
  const previous = work.filter((item) => within(item, start, middle));
  const count = (/** @type {readonly { label: string }[]} */ items, /** @type {string} */ label) => items.filter((item) => item.label === label).length;
  const axes = WORK_AXES
    .filter((axis) => axis.general || count(current, axis.label) > 0 || count(previous, axis.label) > 0)
    .map((axis) => ({
      id: `kind:${axis.id}`, label: axis.label, count: count(current, axis.label),
      value: current.length ? count(current, axis.label) / current.length : 0,
      previousValue: previous.length ? count(previous, axis.label) / previous.length : 0,
    }));
  return { id: "work", title: "在做什么", previous: `前 ${WORK_PERIOD_DAYS} 天`, scale: "share", total: current.length, previousTotal: previous.length, axes };
}

/**
 * The researcher's own runs of the projects in scope, shared by the sources that read the ledgers (one read per request).
 * @param {import("./common.mjs").MapSourceRequest} request @param {{ researcherRuns: (project: any) => Promise<any[]> }} agentRuns
 * @param {(user: any, projectId: string) => Promise<any>} projectOf
 */
export async function ledgerRuns(request, agentRuns, projectOf) {
  return request.memo("runs", async () => {
    const ids = (request.projectId ? [request.projectId] : request.projects.map((project) => project.id)).slice(0, WORK_PROJECT_LIMIT);
    const settled = await Promise.allSettled(ids.map(async (projectId) => {
      const project = await projectOf(request.user, projectId);
      return (await agentRuns.researcherRuns(project)).map((run) => ({ ...run, projectId }));
    }));
    if (ids.length > 0 && settled.every((result) => result.status === "rejected")) throw /** @type {PromiseRejectedResult} */ (settled[0]).reason;
    return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  });
}

/**
 * @param {{ agentRuns: any, projectOf: (user: any, projectId: string) => Promise<any>, isInternal?: (agentId: string) => boolean,
 *   taskTypes?: { wants: (run: any) => boolean, consider: (project: any, run: any) => boolean } | null }} dependencies
 *   `projectOf`: the account's project by id (`store.requireProject`), which the ledger is read under. `taskTypes`: the judge of what
 *   kind of work a conversation was; reading the map asks it for the newest conversations that have none, and does not wait.
 * @returns {import("./common.mjs").MapSource}
 */
export function createRunsSource({ agentRuns, projectOf, isInternal = () => false, taskTypes = null }) {
  return {
    name: "runs",
    applies: () => Boolean(agentRuns) && typeof agentRuns.researcherRuns === "function",
    async read(request) {
      const runs = await ledgerRuns(request, agentRuns, projectOf);
      if (taskTypes) await askForJudgements(request, runs, { projectOf, taskTypes, isInternal });
      return { facets: { dimensions: [workDimension(workOf(runs, isInternal), request.now)] } };
    },
  };
}

/**
 * Starts the judging of the newest conversations that have no kind of work yet. Never throws and never waits for the model: a
 * conversation it cannot start is asked for again on the next read.
 * @param {import("./common.mjs").MapSourceRequest} request @param {readonly any[]} runs
 * @param {{ projectOf: (user: any, projectId: string) => Promise<any>, taskTypes: { wants: (run: any) => boolean, consider: (project: any, run: any) => boolean }, isInternal: (agentId: string) => boolean }} how
 */
async function askForJudgements(request, runs, { projectOf, taskTypes, isInternal }) {
  const newest = [...runs].sort((left, right) => String(right.finishedAt ?? right.startedAt ?? "").localeCompare(String(left.finishedAt ?? left.startedAt ?? "")));
  let started = 0;
  for (const run of newest.slice(0, WORK_BACKFILL_LOOK)) {
    if (started >= WORK_BACKFILL_PER_READ) break;
    if (!taskTypes.wants(run) || isInternal(String(run.effectiveAgentId ?? run.agentId ?? ""))) continue;
    try {
      if (taskTypes.consider(await projectOf(request.user, run.projectId), run)) started += 1;
    } catch { /* the conversation stays unjudged until a later read */ }
  }
}
