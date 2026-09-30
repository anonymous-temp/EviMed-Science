/**
 * What sets the learning loop going — by itself.
 *
 * Hidden knowledge: why the loop never started. It had two producers. One
 * queued a lesson only when the researcher clicked both 「采纳」 and 「我改过」
 * on the same deliverable; production had zero adoptions. The other queued a
 * run that needed a server-side repair round and then succeeded — and
 * server-side repair rounds have defaulted to 0 since the 2026-09-17 ruling,
 * while its transcript condition read a receipt that was written after the
 * `run` object it inspected was taken. Under defaults neither could fire, and
 * the method library stayed empty (2026-09-19 proposal §2, fact 3).
 *
 * The owner's ruling (2026-09-19) replaces the clicks with three signals the
 * platform observes for itself:
 *
 *  - **a delivery finished** — a run that delivered. One that needed repairs
 *    inside its own turn (a deliverable submitted more than once) is the
 *    `repair_accepted` lesson; a clean one is `delivered`, where "no change"
 *    is the expected answer.
 *  - **the researcher corrected the assistant** — a correction sent into a
 *    running turn, or a `correction` memory the extractor wrote citing the
 *    researcher's own words. Whether a sentence is a correction is the
 *    extraction model's judgement; that it quotes the researcher verbatim was
 *    checked in code. "Sent into a running turn" is the ledger's `corrections`
 *    count: the steer route, and since 2026-09-28 a message steered into the
 *    turn from the kernel's own window (`AgentRunStore.recordSteeredInput`,
 *    counted by the frame proxy), which is where the researcher actually types.
 *  - **the same kind of operation repeated** — the Nth successful run of one
 *    capability, N = `METHOD_INDUCTION_MIN_TRAJECTORIES` (AWM's routine
 *    induction needs several trajectories to find what they share). "Same
 *    kind" is the capability, a closed vocabulary, never a judgement about the
 *    question. The family is the researcher's, across every one of their own
 *    projects (`routineFamily`): until 2026-09-28 it was one project's ledger,
 *    so a researcher who kept one question per project — which is what a
 *    project is for — never reached the third run of anything.
 *
 * None of this decides whether anything learned takes effect, or what it is.
 * A distillation proposes; the method ledger decides (`LearningService`): a
 * new method takes effect at once unless it conflicts with one on file
 * (`promotionVerdict`, since 2026-09-20), consolidation relates and re-admits
 * it after every learned revision and on the hourly pass
 * (`methodConsolidation.mjs`), and it is retired by its own runs — the harm
 * test over the runs that used it — or by the researcher, never by a paired
 * evaluation nobody asked for (ruling of 2026-09-21). A lesson whose only
 * evidence is the platform's own reviewer is kept for the capability handbook
 * and never becomes the researcher's method (`lessonSignal`).
 *
 * What this module still refuses is work that is not the researcher's: an
 * automated run (an evaluation cell, a probe, an audit or acceptance harness —
 * `automated`, set by the dispatch body or the `x-evimed-automated` header),
 * the platform's internal capabilities, a trial of
 * someone else's capsule, a paused account, and a run whose transcript is
 * incomplete, from which a lesson would be drawn on evidence the run cannot
 * see. There is no spending window or budget in the default configuration
 * (owner ruling of 2026-09-21); an operator can still set both.
 * Researcher-owned GEO and proactive episodes participate by owner decision
 * of 2026-09-29; their completion does not count as a new human visit.
 *
 * @module learningTriggers
 */

import { METHOD_INDUCTION_MIN_TRAJECTORIES, isResearcherOwnedWork } from "@evimed/domain";
import { isInternalProject } from "./internalProjects.mjs";
import { memoryPausedFor } from "./researchMemory.mjs";
import { TRANSCRIPT_RETENTION_DAYS } from "./runTranscripts.mjs";

/** The answer line: a plain question answered is not an operation to learn a
 *  procedure from (principle 12). */
const ANSWER_LINE_AGENT_ID = "open-domain-answer";

const DAY_MS = 86_400_000;

/**
 * How long one routine period lasts. A routine's family is the capability's
 * runs that finished in the same period as the run that completes it.
 *
 * Why it is bounded at all: the family is read out of every ledger the
 * researcher owns, and what a routine induction reads of each peer is its
 * transcript — which the retention sweep removes after
 * `transcriptRetentionDays` (`TRANSCRIPT_RETENTION_DAYS`, 90 by default). A
 * peer older than that is a number, not evidence. So the period is the
 * retention, and the composition root sets both from the same configuration.
 *
 * Why fixed periods rather than a window sliding back from each run: "every
 * Nth" needs positions that do not move. In a sliding window every run's
 * position shifts each time an old run leaves it, and a researcher who runs a
 * capability at a steady pace — one run leaving the window for each one
 * entering it — holds a constant count, which is a multiple of N on every run
 * or on none. A fixed period only grows between its two boundaries. What that
 * costs is a group still short of N when its period ends, which starts again
 * in the next one.
 */
export const ROUTINE_PERIOD_DAYS = TRANSCRIPT_RETENTION_DAYS;

/** @param {unknown} days @returns {number} the period in ms; the default for anything but a positive number */
export function routinePeriodMs(days) {
  const value = Number(days);
  return (Number.isFinite(value) && value > 0 ? value : ROUTINE_PERIOD_DAYS) * DAY_MS;
}

/** When a run finished, in ms; its start when the ledger has no finish. @param {any} run */
function finishedMs(run) {
  return Date.parse(String(run?.finishedAt ?? run?.startedAt ?? ""));
}

/**
 * The routine period a run finished in, or null for a run with no readable
 * time. Counted from the Unix epoch, so every reader agrees on the boundaries.
 * @param {any} run @param {number} [periodMs]
 * @returns {number | null}
 */
export function routinePeriodOf(run, periodMs = routinePeriodMs(ROUTINE_PERIOD_DAYS)) {
  const time = finishedMs(run);
  return Number.isFinite(time) && periodMs > 0 ? Math.floor(time / periodMs) : null;
}

/**
 * The capability a finished run could be the Nth run of, or null: it
 * succeeded, it delivered, and it was not a plain answer. The cheap part of
 * the rule, so the researcher's other ledgers are read only when they can
 * matter.
 * @param {any} run
 * @returns {string | null}
 */
export function routineCapability(run) {
  const agentId = String(run?.effectiveAgentId ?? "");
  if (run?.status !== "succeeded" || (run.artifacts?.length ?? 0) === 0) return null;
  return agentId && agentId !== ANSWER_LINE_AGENT_ID ? agentId : null;
}

/**
 * Whether a run is the researcher's own work. What the platform did on its own
 * behalf is not: an evaluation cell, a probe or a harness. Managed GEO and
 * proactive work belong to the researcher who commissioned them.
 * @param {any} run
 */
function researcherRun(run) {
  return isResearcherOwnedWork(run);
}

/**
 * @typedef {{ project: { id?: string | null, userId?: string | null, archivedAt?: string | null }, runs: readonly any[] }} ProjectLedger
 * one project's ledger, as a routine's family reads it
 */

/**
 * The runs a routine is counted over, oldest first: every successful run of
 * `capabilityId` that was the researcher's own work, in any of the
 * researcher's own projects, finished in the same routine period as `run`
 * (`ROUTINE_PERIOD_DAYS`).
 *
 * A project counts when it belongs to `owner`, is not archived (put away is
 * not being worked in) and is not one the platform keeps for its own
 * background work (`isInternalProject`). Every rule is applied here, however
 * the ledgers were gathered, so it can be read in one place.
 *
 * @param {{ run: any, owner?: string | null, capabilityId: string, ledgers: readonly ProjectLedger[], periodMs?: number }} input
 * @returns {{ run: any, projectId: string | null }[]}
 */
export function routineFamily({ run, owner = null, capabilityId, ledgers, periodMs = routinePeriodMs(ROUTINE_PERIOD_DAYS) }) {
  const period = routinePeriodOf(run, periodMs);
  if (period == null) return [];
  /** @type {Map<string, { run: any, projectId: string | null }>} */
  const members = new Map();
  for (const ledger of ledgers ?? []) {
    const home = ledger?.project;
    if (!home || home.archivedAt || isInternalProject(home.id)) continue;
    if (owner != null && home.userId !== owner) continue;
    for (const item of ledger.runs ?? []) {
      if (!item?.id || members.has(item.id)) continue;
      if (item.status !== "succeeded" || String(item.effectiveAgentId ?? "") !== capabilityId || !researcherRun(item)) continue;
      if (routinePeriodOf(item, periodMs) !== period) continue;
      members.set(item.id, { run: item, projectId: home.id ? String(home.id) : null });
    }
  }
  return [...members.values()].sort((left, right) => (finishedMs(left.run) - finishedMs(right.run))
    || String(left.run.id).localeCompare(String(right.run.id)));
}

/**
 * The peer runs a `routine` lesson names, as `{ runId, projectId }`, in either
 * shape a lesson has been queued in: `peers` since 2026-09-28, when a peer can
 * be in another of the researcher's projects; and the `peerRunIds` of a lesson
 * queued before, whose peers were all in the lesson's own project — read as
 * `projectId: null`, which means exactly that. Malformed entries are dropped.
 * @param {any} payload
 * @returns {{ runId: string, projectId: string | null }[]}
 */
export function lessonPeers(payload) {
  const text = (/** @type {unknown} */ value) => (typeof value === "string" && value ? value : null);
  if (Array.isArray(payload?.peers)) {
    return payload.peers
      .filter((/** @type {any} */ peer) => text(peer?.runId))
      .map((/** @type {any} */ peer) => ({ runId: String(peer.runId), projectId: text(peer.projectId) }));
  }
  if (Array.isArray(payload?.peerRunIds)) {
    return payload.peerRunIds.filter(text).map((/** @type {string} */ runId) => ({ runId, projectId: null }));
  }
  return [];
}

/** The largest number of attempts any deliverable of the run took, from the
 *  run's own projection. @param {any} projection */
function inRunAttempts(projection) {
  const items = Array.isArray(projection?.plan?.items) ? projection.plan.items : [];
  return items.reduce((most, item) => Math.max(most, Number.isSafeInteger(item?.attempts) ? item.attempts : 0), 0);
}

/**
 * Which lessons one finished run is evidence for. Pure, so the rules can be
 * read and tested without a queue.
 *
 * `runs` is the ledger of the run's own `project`, where its current record is
 * read. `ledgers` are those a routine is counted over — the researcher's
 * projects, gathered by `LearningTriggers.ledgersFor`; when absent, the run's
 * own ledger is the only one.
 *
 * @param {{ run: any, runs: readonly any[], project?: { id?: string | null, userId?: string | null, archivedAt?: string | null } | null,
 *   ledgers?: readonly ProjectLedger[] | null, periodMs?: number, projection?: any, memoryResult?: any,
 *   internalAgent?: (agentId: string) => boolean }} input
 * @returns {{ trigger: string, idempotencyKey: string, payload: Record<string, any> }[]}
 */
export function learningTriggersFor({ run, runs, project = null, ledgers = null, periodMs = routinePeriodMs(ROUTINE_PERIOD_DAYS),
  projection = null, memoryResult = null, internalAgent = () => false }) {
  if (!run || !["succeeded", "failed"].includes(run.status)) return [];
  // Work the platform did on its own behalf is not the researcher's operation:
  // an evaluation cell and the loop's own
  // bounded runs (distillation learning from distillation is a hall of mirrors).
  if (!researcherRun(run)) return [];
  if (project && isInternalProject(project.id)) return [];
  const agentId = String(run.effectiveAgentId ?? "");
  if (agentId && internalAgent(agentId)) return [];
  // A lesson drawn from an incomplete record rests on evidence the
  // distillation cannot see, and would take effect the moment it is written.
  // The transcript is read before the runtime stops (L-G6), so "incomplete"
  // now means a conversation that really could not be read.
  const ledgerRun = runs.find((item) => item?.id === run.id) ?? run;
  if (ledgerRun.transcript?.completeness !== "complete") return [];

  /** @type {{ trigger: string, idempotencyKey: string, payload: Record<string, any> }[]} */
  const lessons = [];
  const extracted = Array.isArray(memoryResult?.corrections) ? memoryResult.corrections : [];
  const steered = Number(ledgerRun.corrections ?? run.corrections ?? 0);
  if (steered > 0 || extracted.length > 0) {
    lessons.push({
      trigger: "correction",
      idempotencyKey: `distill:${run.id}:correction`,
      payload: {
        runId: run.id,
        trigger: "correction",
        // What the researcher corrected, by record, so the excerpt can be read
        // against it; the text itself stays in the memory store.
        corrections: extracted.slice(0, 8).map((entry) => ({ recordId: entry.recordId, key: entry.key })),
        steeredCorrections: steered,
      },
    });
  }
  if (run.status !== "succeeded" || (run.artifacts?.length ?? 0) === 0) return lessons;

  const attempts = inRunAttempts(projection);
  const serverRounds = (run.repairRounds?.content ?? 0) + (run.repairRounds?.structural ?? 0);
  lessons.push(attempts > 1 || serverRounds > 0
    ? {
      trigger: "repair_accepted",
      // The key the retired producer used, so a job it already queued is the
      // same job rather than a second lesson from one run.
      idempotencyKey: `distill:${run.id}:repair_accepted`,
      payload: { runId: run.id, trigger: "repair_accepted", repairRounds: run.repairRounds ?? null, inRunAttempts: attempts },
    }
    : {
      trigger: "delivered",
      idempotencyKey: `distill:${run.id}:delivered`,
      payload: { runId: run.id, trigger: "delivered" },
    });

  const capabilityId = routineCapability(run);
  if (capabilityId) {
    const family = routineFamily({
      run, owner: project?.userId ?? null, capabilityId, periodMs,
      ledgers: ledgers ?? [{ project: project ?? {}, runs }],
    });
    const position = family.findIndex((member) => member.run.id === run.id) + 1;
    // Every Nth, not only the Nth: a routine seen again after the first
    // induction is new evidence for the method it produced, and the
    // distillation reads the related methods before it proposes anything.
    // The key names the run alone, so one run is induced from at most once
    // however often its lessons are queued.
    if (position > 0 && position % METHOD_INDUCTION_MIN_TRAJECTORIES === 0) {
      lessons.push({
        trigger: "routine",
        idempotencyKey: `distill:${run.id}:routine`,
        payload: {
          runId: run.id,
          trigger: "routine",
          capabilityId,
          // By run and project: a run id names a transcript only inside its
          // own project, and a peer may be in another of the researcher's.
          peers: family.slice(position - METHOD_INDUCTION_MIN_TRAJECTORIES, position - 1)
            .map((member) => ({ runId: member.run.id, projectId: member.projectId })),
        },
      });
    }
  }
  return lessons;
}

export class LearningTriggers {
  /**
   * `projects` lists one account's projects, each as the store resolves it
   * (`{ id, userId, archivedAt, rootDir, … }`), so a routine is counted across
   * all of the researcher's own; without it a routine is counted in the run's
   * own project. `routinePeriodDays` is the transcript retention
   * (`ROUTINE_PERIOD_DAYS`).
   * @param {{ jobs: any, agentRuns: any, memory?: any, internalAgent?: (agentId: string) => boolean | Promise<boolean>,
   *   sessionState?: ((userId: string, projectId: string, sessionId: string) => Promise<{ trialCapsuleId?: string | null } | null>) | null,
   *   audit?: (event: string, detail: Record<string, any>) => Promise<void>,
   *   projects?: ((userId: string) => Promise<readonly any[]>) | null, routinePeriodDays?: number }} dependencies
   */
  constructor({ jobs, agentRuns, memory = null, internalAgent = async () => false, sessionState = null, audit = async () => {},
    projects = null, routinePeriodDays = ROUTINE_PERIOD_DAYS }) {
    if (!jobs || !agentRuns) throw new TypeError("Learning triggers need the job queue and the run ledger.");
    this.jobs = jobs;
    this.agentRuns = agentRuns;
    this.memory = memory;
    this.internalAgent = internalAgent;
    this.sessionState = sessionState;
    this.audit = audit;
    this.projects = projects;
    this.periodMs = routinePeriodMs(routinePeriodDays);
  }

  /**
   * The ledgers a routine of `capabilityId` is counted over: the run's own, as
   * already read, and that of every other project of the same researcher that
   * is neither archived nor internal. Each is cut to the capability and the
   * run's period as it is read, so what is held is one period of one
   * capability rather than every ledger's history.
   *
   * Throws when any of them cannot be read. A position counted over part of
   * the family is a wrong answer, and no routine is better than one induced
   * at the wrong run.
   * @param {any} project @param {readonly any[]} runs @param {any} run @param {string} capabilityId
   * @returns {Promise<ProjectLedger[]>}
   */
  async ledgersFor(project, runs, run, capabilityId) {
    const period = routinePeriodOf(run, this.periodMs);
    const cut = (/** @type {readonly any[]} */ ledger) => ledger.filter((item) => String(item?.effectiveAgentId ?? "") === capabilityId
      && routinePeriodOf(item, this.periodMs) === period);
    /** @type {ProjectLedger[]} */
    const ledgers = [{ project, runs: cut(runs) }];
    if (!this.projects) return ledgers;
    for (const other of (await this.projects(project.userId)) ?? []) {
      if (!other?.id || String(other.id) === String(project.id)) continue;
      if (other.userId !== project.userId || other.archivedAt || isInternalProject(other.id)) continue;
      ledgers.push({ project: other, runs: cut(await this.agentRuns.list(other)) });
    }
    return ledgers;
  }

  /**
   * Queue the lessons one finished run is evidence for. Best effort: a lesson
   * that could not be queued must not be the reason a run reports failure,
   * and must not be silent either.
   *
   * @param {any} project @param {any} run @param {any} [memoryResult]
   * @returns {Promise<{ queued: string[], skipped: string | null }>}
   */
  async afterRun(project, run, memoryResult = null) {
    // The researcher's own switch. "Stop learning" has meant no memory is
    // written; a method distilled from their runs is learning too.
    if ((await memoryPausedFor(this.memory, project.userId, project.id).catch(() => ({ learning: false }))).learning) {
      return { queued: [], skipped: "paused" };
    }
    if (this.sessionState && run.sessionId) {
      const state = await this.sessionState(project.userId, project.id, run.sessionId).catch(() => null);
      // A conversation trying someone else's capsule leaves nothing behind:
      // its work was theirs.
      if (state?.trialCapsuleId) return { queued: [], skipped: "trial" };
    }
    const runs = await this.agentRuns.list(project).catch(() => []);
    const projection = await this.agentRuns.runWorkflowProjection(project, run).catch(() => null);
    const agentId = String(run.effectiveAgentId ?? "");
    const internal = agentId ? await Promise.resolve(this.internalAgent(agentId)).catch(() => false) : false;
    // The other ledgers are read only when this run could complete a routine.
    const capabilityId = internal || !researcherRun(run) ? null : routineCapability(run);
    /** @type {ProjectLedger[] | null} */
    let ledgers = null;
    if (capabilityId) {
      ledgers = await this.ledgersFor(project, runs, run, capabilityId).catch(async (error) => {
        await this.audit("learning.routine.family", {
          userId: project.userId, projectId: project.id, runId: run.id,
          code: typeof error?.code === "string" ? error.code : "learning_routine_family_unreadable",
          detail: capabilityId,
        }).catch(() => {});
        return [];
      });
    }
    const lessons = learningTriggersFor({
      run, runs, project, ledgers, periodMs: this.periodMs, projection, memoryResult, internalAgent: () => internal,
    });
    const queued = [];
    for (const lesson of lessons) {
      try {
        await this.jobs.enqueue(project.userId, "distill", lesson.payload, {
          idempotencyKey: lesson.idempotencyKey,
          projectId: project.id,
        });
        queued.push(lesson.trigger);
      } catch (error) {
        await this.audit("learning.distill.enqueue", {
          userId: project.userId, projectId: project.id, runId: run.id,
          code: typeof error?.code === "string" ? error.code : "learning_enqueue_failed",
          detail: lesson.trigger,
        }).catch(() => {});
      }
    }
    return { queued, skipped: null };
  }
}
