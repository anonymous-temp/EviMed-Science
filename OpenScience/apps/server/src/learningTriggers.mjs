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
 *    checked in code.
 *  - **the same kind of operation repeated** — the Nth successful run of one
 *    capability in one project, N = `METHOD_INDUCTION_MIN_TRAJECTORIES`
 *    (AWM's routine induction needs several trajectories to find what they
 *    share). "Same kind" is the capability, a closed vocabulary, never a
 *    judgement about the question.
 *
 * None of this decides whether anything learned takes effect. A distillation
 * writes a candidate; only the nightly pass promotes one, and only on a paired
 * evaluation against the current methods (`methodConsolidation.mjs`). What is
 * bounded here is spend: the worker runs only in the off-peak window and under
 * the learning budget, and a lesson is not queued from a transcript the
 * promotion rule would refuse anyway.
 *
 * @module learningTriggers
 */

import { METHOD_INDUCTION_MIN_TRAJECTORIES } from "@evimed/domain";
import { memoryPausedFor } from "./researchMemory.mjs";

/** The answer line: a plain question answered is not an operation to learn a
 *  procedure from (principle 12). */
const ANSWER_LINE_AGENT_ID = "open-domain-answer";

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
 * @param {{ run: any, runs: readonly any[], projection?: any, memoryResult?: any,
 *   internalAgent?: (agentId: string) => boolean }} input
 * @returns {{ trigger: string, idempotencyKey: string, payload: Record<string, any> }[]}
 */
export function learningTriggersFor({ run, runs, projection = null, memoryResult = null, internalAgent = () => false }) {
  if (!run || !["succeeded", "failed"].includes(run.status)) return [];
  // Work the platform did on its own behalf is not the researcher's operation:
  // an evaluation cell, a nightly autopilot episode, and the loop's own
  // bounded runs (distillation learning from distillation is a hall of mirrors).
  if (run.automated === true || String(run.effectiveRouteReason ?? "").startsWith("autopilot:")) return [];
  const agentId = String(run.effectiveAgentId ?? "");
  if (agentId && internalAgent(agentId)) return [];
  // The promotion rule refuses a candidate distilled from an incomplete
  // record, so a lesson queued from one would be paid for and then thrown away.
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

  if (agentId && agentId !== ANSWER_LINE_AGENT_ID) {
    const family = runs
      .filter((item) => item?.status === "succeeded" && String(item.effectiveAgentId ?? "") === agentId)
      .filter((item) => item.automated !== true && !String(item.effectiveRouteReason ?? "").startsWith("autopilot:"))
      .sort((left, right) => String(left.finishedAt ?? left.startedAt ?? "").localeCompare(String(right.finishedAt ?? right.startedAt ?? "")));
    const position = family.findIndex((item) => item.id === run.id) + 1;
    // Every Nth, not only the Nth: a routine seen again after the first
    // induction is new evidence for the method it produced, and the
    // distillation reads the related methods before it proposes anything.
    if (position > 0 && position % METHOD_INDUCTION_MIN_TRAJECTORIES === 0) {
      lessons.push({
        trigger: "routine",
        idempotencyKey: `distill:${run.id}:routine`,
        payload: {
          runId: run.id,
          trigger: "routine",
          capabilityId: agentId,
          peerRunIds: family.slice(position - METHOD_INDUCTION_MIN_TRAJECTORIES, position - 1).map((item) => item.id),
        },
      });
    }
  }
  return lessons;
}

export class LearningTriggers {
  /**
   * @param {{ jobs: any, agentRuns: any, memory?: any, internalAgent?: (agentId: string) => boolean | Promise<boolean>,
   *   sessionState?: ((userId: string, projectId: string, sessionId: string) => Promise<{ incognito?: boolean } | null>) | null,
   *   audit?: (event: string, detail: Record<string, any>) => Promise<void> }} dependencies
   */
  constructor({ jobs, agentRuns, memory = null, internalAgent = async () => false, sessionState = null, audit = async () => {} }) {
    if (!jobs || !agentRuns) throw new TypeError("Learning triggers need the job queue and the run ledger.");
    this.jobs = jobs;
    this.agentRuns = agentRuns;
    this.memory = memory;
    this.internalAgent = internalAgent;
    this.sessionState = sessionState;
    this.audit = audit;
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
      // An incognito conversation leaves nothing behind: no memory, no method.
      if (state?.incognito) return { queued: [], skipped: "incognito" };
    }
    const runs = await this.agentRuns.list(project).catch(() => []);
    const projection = await this.agentRuns.runWorkflowProjection(project, run).catch(() => null);
    const agentId = String(run.effectiveAgentId ?? "");
    const internal = agentId ? await Promise.resolve(this.internalAgent(agentId)).catch(() => false) : false;
    const lessons = learningTriggersFor({ run, runs, projection, memoryResult, internalAgent: () => internal });
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
