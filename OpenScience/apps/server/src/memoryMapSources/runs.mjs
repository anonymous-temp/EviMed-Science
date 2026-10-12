/**
 * The map's first radar: what the researcher has been doing with the platform, by the kind of work, now and a month before.
 *
 * Hidden knowledge:
 *
 * - **Axes are fixed and named** (`WORK_AXES`): the product's own categories of capability — the same words the tool pages group
 *   by — and plain question-and-answer. Never the account's top topics: they would change who is on an axis from one month to the
 *   next, and a polygon whose axes moved means nothing. A category outside the general three is an axis only when the account
 *   has used it, so a researcher who never touched a clinical capability never sees a clinical axis.
 * - **Shares, not counts**, over the researcher's own finished conversations of the last 30 days and of the 30 before
 *   (`isResearcherRun`: not a scheduled episode, not a continuation, not a source being read). The value at a vertex is the
 *   share; the count it came from rides along so the page can print it.
 * - A conversation counts under the capability that answered it (`effectiveAgentId`), and one the researcher deleted, one that
 *   failed, and one of the platform's own internal capabilities does not count.
 * - The ledger holds no model-judged type of task yet (`taskType`); when the dispatch classifier writes one it replaces the
 *   capability here as the axis, and nothing else in the map changes.
 *
 * @module memoryMapSources/runs
 */

import { CAPABILITY_DISPLAY } from "@evimed/domain";

import { isResearcherRun } from "../agentRuns.mjs";
import { OPEN_DOMAIN_ANSWER_AGENT_ID } from "../specialistRouting.mjs";

/** The days of one period of the radar. */
export const WORK_PERIOD_DAYS = 30;
/** The projects one read walks the ledgers of. */
export const WORK_PROJECT_LIMIT = 12;

/** The general axes, always present, and the medical ones, present when used. */
export const WORK_AXES = Object.freeze([
  { label: "普通问答", general: true },
  { label: "写作与传播", general: true },
  { label: "研究设计与数据", general: true },
  { label: "药学评价", general: false },
  { label: "临床证据", general: false },
  { label: "虚拟临床研究", general: false },
]);

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
    const label = agent === OPEN_DOMAIN_ANSWER_AGENT_ID ? "普通问答"
      : WORK_AXES.some((axis) => axis.label === (CAPABILITY_DISPLAY[agent]?.category ?? "")) ? /** @type {string} */ (CAPABILITY_DISPLAY[agent]?.category) : null;
    const at = String(run.finishedAt ?? run.startedAt ?? "");
    if (label && at) found.push({ at, label, projectId: typeof run.projectId === "string" ? run.projectId : null });
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
      id: `cat:${axis.label}`, label: axis.label, count: count(current, axis.label),
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
 * @param {{ agentRuns: any, projectOf: (user: any, projectId: string) => Promise<any>, isInternal?: (agentId: string) => boolean }} dependencies
 *   `projectOf`: the account's project by id (`store.requireProject`), which the ledger is read under
 * @returns {import("./common.mjs").MapSource}
 */
export function createRunsSource({ agentRuns, projectOf, isInternal = () => false }) {
  return {
    name: "runs",
    applies: () => Boolean(agentRuns) && typeof agentRuns.researcherRuns === "function",
    async read(request) {
      const runs = await ledgerRuns(request, agentRuns, projectOf);
      return { facets: { dimensions: [workDimension(workOf(runs, isInternal), request.now)] } };
    },
  };
}
