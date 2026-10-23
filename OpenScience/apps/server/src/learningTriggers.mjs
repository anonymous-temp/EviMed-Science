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
 * The owner's ruling (2026-09-19) replaces the clicks with signals the platform
 * observes for itself, and the rectification of 2026-10-23 moves two of them to
 * where the algorithm put them (self-evolving agent plan 6.2: EvoDS's τ = 3 is a
 * number of CLEAN trajectories, not "every third success"):
 *
 *  - **the researcher corrected the assistant** — `correction`, never sampled: a message
 *    typed into a running turn (`AgentRunStore.recordSteeredInput`, counted by the
 *    frame proxy), a result corrected in the page (`result-corrected`), a
 *    `correction` memory the extractor wrote citing their own words, and — the one
 *    that was missing — the first message of the next turn when a small model reads
 *    it as a correction, a preference or a rejection of the previous run
 *    (`learningEvidence.mjs`, `afterCorrection`). Whether a sentence is a correction
 *    is a model's judgement; that it quotes the researcher verbatim is checked in code.
 *  - **the same kind of work, done cleanly, three times** — `routine`. A trajectory is clean
 *    when nobody reacted to it (no steer, no corrected result, no follow-up that
 *    corrected it), and the same kind is the same SCOPE — the capability, or
 *    `conversation` for the ordinary answer line, which can trigger a routine for the first
 *    time — and the same artifact SHAPE (`@evimed/domain` `artifactShape.mjs`), inside
 *    one fixed period of `ROUTINE_PERIOD_DAYS`. It is decided where cleanness becomes known,
 *    when a run is settled (`learningEvidence.settle`, thirty minutes after it ended or
 *    when its next turn came), by `routineLessonFor` over the family
 *    the feedback ledger holds; every Nth, not only the Nth.
 *  - **a repaired delivery** — `repair_accepted`, at share 0 (below).
 *
 * `delivered` — one lesson per finished delivery, sampled at a third — is gone: its content is a
 * settled run (`silent` evidence) and the routine over such runs. What it queued was
 * `no_change` nearly every time, and learned the delivery's choreography.
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
 * A run that drew on someone else's pack that no other account has yet vouched for — a share by a new author, before enough
 * accounts have kept it enabled (`capsuleShareTrust.mjs`, plan §7, 2026-10-05) — still learns for its own account: its lessons
 * are queued as any run's are, marked `guestInfluence`. What it must not do is reach the platform, and the one channel from
 * learning to the platform is the handbook-gap scan (`evolutionLearningCoupling.mjs`), which leaves such a run out. The mark is
 * written here, once, when the run finishes.
 *
 * A delivery that needed repairs inside its own run is not read by default (owner ruling of 2026-10-12: the loop learns the researcher's research methods
 * from their corrections and edits, no longer how to pass the delivery gate). Since 2026-09-17 a verdict of the gate withholds nothing, so a repair is the
 * platform's own bookkeeping — 21 of the 28 lessons read by 2026-10-12 were of that kind, 14 of 17 handbooks they became failed on length, and the methods
 * the merging pass then built from them were rewordings of two lessons about anchors and recorded scope. Its share is
 * `OPEN_SCIENCE_LEARNING_REPAIR_DISTILL_SAMPLE_SHARE` (0), chosen by a hash of the run id (`runSampling.mjs`) and counted. What a researcher corrects in
 * the result (`result-corrected`, `afterCorrection`), says in the running turn, or has the extractor record as a `correction` memory stays unsampled.
 *
 * What this module still refuses is work that is not the researcher's: an
 * automated run (an evaluation cell, a probe, an audit or acceptance harness —
 * `automated`, set by the dispatch body or the `x-evimed-automated` header),
 * the platform's internal capabilities, a trial of
 * someone else's capsule, a paused account, and a run whose transcript is
 * incomplete, from which a lesson would be drawn on evidence the run cannot
 * see. Every refusal is counted by its reason (`LEARNING_REFUSAL_REASONS`,
 * `open_science_learning_trigger_refused_total`): the loop stopped for eleven days
 * without a sign, and a gate that cannot be counted cannot be told from a loop with nothing to learn.
 * There is no spending window or budget in the default configuration
 * (owner ruling of 2026-09-21); an operator can still set both.
 * Researcher-owned GEO and proactive episodes participate by owner decision
 * of 2026-09-29; their completion does not count as a new human visit. The
 * independent re-check of such an episode's claim (a verification run, route
 * reason `autopilot-verify`, the programme's `autopilot-verify:evidence`) is the
 * platform's own work on the task's behalf and is refused here (2026-10-14: it
 * carries no `automated` and no `autopilot:` prefix, so it read as a turn of the
 * researcher's; `isResearcherOwnedWork` in the domain is the one place that says so).
 *
 * @module learningTriggers
 */

import { METHOD_INDUCTION_MIN_TRAJECTORIES, artifactShapesMatch, isLearningCorrection, isResearcherOwnedWork } from "@evimed/domain";
import { isInternalProject } from "./internalProjects.mjs";
import { recordSkippedBeforeReset } from "./memoryMetrics.mjs";
import { endedBeforeReset, memoryPausedFor } from "./researchMemory.mjs";
import { sampledByHash } from "./runSampling.mjs";
import { TRANSCRIPT_RETENTION_DAYS } from "./runTranscripts.mjs";

/** The answer line: the ordinary conversation, which no capability took. Its scope is `conversation` (`learningScopeOf`). */
const ANSWER_LINE_AGENT_ID = "open-domain-answer";

/** The scope of the ordinary conversation, the one a routine and a method are kept under when no capability took the work. */
export const CONVERSATION_SCOPE = "conversation";

/**
 * Where a run's work happened, as a closed vocabulary: the capability that took it, or `conversation` for the ordinary answer line
 * (and for a turn nothing routed). A routine is counted within one scope, and a learned method records the scope it was learnt in
 * (`provenance.scope`) so a later run of that scope is offered it.
 * @param {any} run
 * @returns {string}
 */
export function learningScopeOf(run) {
  const agentId = String(run?.effectiveAgentId ?? "");
  return agentId && agentId !== ANSWER_LINE_AGENT_ID ? agentId : CONVERSATION_SCOPE;
}

/** What the repaired-delivery sample is hashed with, so it is independent of the platform handbooks' probation sample over the same runs. */
export const REPAIR_SAMPLE_PURPOSE = "learning-distill-repair";

/**
 * Why a finished run was not read for a lesson, as a closed vocabulary — each one is a counter (`open_science_learning_trigger_refused_total`),
 * because a gate that refuses silently looks exactly like a loop with nothing to learn:
 *  - `not_finished` — the run is still running or ended in a way that teaches nothing;
 *  - `not_researcher_work` — an evaluation cell, a probe, an acceptance or smoke driver, a verification re-check: the platform's own work;
 *  - `internal_project`, `internal_agent` — the platform's background work, among it the loop's own bounded runs;
 *  - `clinical_context` — the conversation read a patient record or a study's data, so its text is not the account's;
 *  - `paused` — the researcher stopped learning; `before_reset` — the conversation ended before the account reset its memory;
 *  - `trial` — a conversation trying someone else's capsule; `transcript_incomplete` — the history could not be read whole;
 *  - `run_unavailable`, `not_eligible`, `enqueue_failed` — a lesson that could not be attached to a run, to the rules, or to the queue.
 */
export const LEARNING_REFUSAL_REASONS = Object.freeze([
  "not_finished", "not_researcher_work", "internal_project", "internal_agent", "clinical_context", "paused", "before_reset", "trial",
  "transcript_incomplete", "run_unavailable", "not_eligible", "enqueue_failed",
]);

const DAY_MS = 86_400_000;

/**
 * How long one routine period lasts. A routine's family is the scope's
 * clean runs that settled in the same period as the run that completes it.
 *
 * Why it is bounded at all: what a routine induction reads of each peer is its
 * transcript — which the retention sweep removes after
 * `transcriptRetentionDays` (`TRANSCRIPT_RETENTION_DAYS`, 90 by default). A
 * peer older than that is a number, not evidence. So the period is the
 * retention, and the composition root sets both from the same configuration.
 *
 * Why fixed periods rather than a window sliding back from each run: "every
 * Nth" needs positions that do not move. In a sliding window every run's
 * position shifts each time an old run leaves it, and a researcher who works at
 * a steady pace — one run leaving the window for each one entering it — holds a
 * constant count, which is a multiple of N on every run or on none. A fixed
 * period only grows between its two boundaries. What that costs is a group still
 * short of N when its period ends, which starts again in the next one.
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
 * The routine period a moment belongs to, or null for one with no readable time. Counted from the Unix epoch, so every reader agrees
 * on the boundaries.
 * @param {any} at a run (its finish) or an instant (a Date or an ISO string) @param {number} [periodMs]
 * @returns {number | null}
 */
export function routinePeriodOf(at, periodMs = routinePeriodMs(ROUTINE_PERIOD_DAYS)) {
  const time = at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : finishedMs(at);
  return Number.isFinite(time) && periodMs > 0 ? Math.floor(time / periodMs) : null;
}

/**
 * Whether the turn produced or changed a file the researcher can open: what a delivery is in an ordinary conversation, where
 * there is no capability whose contract says what one is. Any of the ledger's three records of it counts — the files a gate
 * accepted (`artifacts`), the ones it did not grade (`unverifiedArtifacts`) and the ones an ordinary conversation's run recorded
 * from what changed in the workspace (`outputFiles`) — because which of them a turn's files land in depends on the line it ran on.
 * @param {any} run
 */
export function leftFiles(run) {
  return ["artifacts", "unverifiedArtifacts", "outputFiles"].some((field) => Array.isArray(run?.[field]) && run[field].length > 0);
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
 * Why a finished run may not be read for a lesson on what the run itself says, or null. Pure; the rules that need a store (the
 * clinical-context check, the researcher's pause, a reset, a trial) are the class's (`LearningTriggers.refusalFor`).
 *
 * A lesson drawn from an incomplete record rests on evidence the distillation cannot see, and would take effect the moment it is
 * written. The transcript is read before the runtime stops (L-G6), so "incomplete" now means a conversation that really could not
 * be read.
 * @param {{ run: any, runs?: readonly any[], project?: { id?: string | null } | null, internalAgent?: (agentId: string) => boolean }} input
 * @returns {string | null} one of `LEARNING_REFUSAL_REASONS`
 */
export function learningRefusal({ run, runs = [], project = null, internalAgent = () => false }) {
  if (!run || !["succeeded", "failed"].includes(run.status)) return "not_finished";
  // Work the platform did on its own behalf is not the researcher's operation: an evaluation cell and the loop's own bounded runs
  // (distillation learning from distillation is a hall of mirrors).
  if (!researcherRun(run)) return "not_researcher_work";
  if (project && isInternalProject(project.id)) return "internal_project";
  const agentId = String(run.effectiveAgentId ?? "");
  if (agentId && internalAgent(agentId)) return "internal_agent";
  const ledgerRun = runs.find((item) => item?.id === run.id) ?? run;
  if (ledgerRun.transcript?.completeness !== "complete") return "transcript_incomplete";
  return null;
}

/**
 * Which lessons one finished run is evidence for, at the moment it finishes. Pure, so the rules can be read and tested without a
 * queue. A correction typed into the run (or recorded by the extractor) is one; a delivery repaired inside its own run is the
 * other, and only where an operator asks for it. What the run teaches by being left alone is decided later, when it is settled
 * (`routineLessonFor`).
 *
 * `runs` is the ledger of the run's own `project`, where its current record is read.
 *
 * @param {{ run: any, runs: readonly any[], project?: { id?: string | null, userId?: string | null, archivedAt?: string | null } | null,
 *   projection?: any, memoryResult?: any,
 *   internalAgent?: (agentId: string) => boolean, guestInfluence?: boolean }} input
 *   `guestInfluence`: the run drew on a received pack no other account has vouched for; each lesson says so.
 * @returns {{ trigger: string, idempotencyKey: string, payload: Record<string, any> }[]}
 */
export function learningTriggersFor({ run, runs, project = null, projection = null, memoryResult = null, internalAgent = () => false, guestInfluence = false }) {
  if (learningRefusal({ run, runs, project, internalAgent })) return [];
  const ledgerRun = runs.find((item) => item?.id === run.id) ?? run;

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
  /** @param {typeof lessons} list */
  const marked = (list) => (guestInfluence ? list.map((lesson) => ({ ...lesson, payload: { ...lesson.payload, guestInfluence: { uncorroborated: true } } })) : list);
  if (run.status !== "succeeded" || !leftFiles(run)) return marked(lessons);

  const attempts = inRunAttempts(projection);
  const serverRounds = (run.repairRounds?.content ?? 0) + (run.repairRounds?.structural ?? 0);
  if (attempts > 1 || serverRounds > 0) {
    lessons.push({
      trigger: "repair_accepted",
      // The key the retired producer used, so a job it already queued is the
      // same job rather than a second lesson from one run.
      idempotencyKey: `distill:${run.id}:repair_accepted`,
      payload: { runId: run.id, trigger: "repair_accepted", repairRounds: run.repairRounds ?? null, inRunAttempts: attempts },
    });
  }
  return marked(lessons);
}

/**
 * The routine lesson a settled run completes, or null: τ = `METHOD_INDUCTION_MIN_TRAJECTORIES` clean trajectories of one scope whose
 * files are the same shape (EvoDS's threshold in the place it was meant for — what the work did three times, uncorrected, not the
 * third success). `family` is every other clean run of the scope in the period, oldest first, each with the shape of what it left
 * (`FeedbackEvents.cleanSettledRuns`); the run itself is counted in. Every Nth, not only the Nth: a routine seen again is new
 * evidence for the method it produced, and the distillation reads the related methods before it proposes anything. The key names
 * the run alone, so one run is induced from at most once however often it is settled.
 *
 * Pure. The shapes decide "the same": `artifactShapesMatch` (format, and structure where there is any); a run with no file has no
 * shape and teaches no routine.
 * @param {{ run: any, scope: string, shape: unknown, family: readonly { runId: string, projectId?: string | null, shape: unknown }[],
 *   guestInfluence?: boolean }} input
 * @returns {{ trigger: string, idempotencyKey: string, payload: Record<string, any> } | null}
 */
export function routineLessonFor({ run, scope, shape, family, guestInfluence = false }) {
  const matching = (family ?? []).filter((member) => member.runId !== run?.id && artifactShapesMatch(member.shape, shape));
  const count = matching.length + 1;
  if (!run?.id || count < METHOD_INDUCTION_MIN_TRAJECTORIES || count % METHOD_INDUCTION_MIN_TRAJECTORIES !== 0) return null;
  return {
    trigger: "routine",
    idempotencyKey: `distill:${run.id}:routine`,
    payload: {
      runId: run.id,
      trigger: "routine",
      scope,
      capabilityId: scope === CONVERSATION_SCOPE ? null : scope,
      // By run and project: a run id names a transcript only inside its own project, and a peer may be in another of the researcher's.
      peers: matching.slice(-(METHOD_INDUCTION_MIN_TRAJECTORIES - 1)).map((member) => ({ runId: member.runId, projectId: member.projectId ?? null })),
      ...(guestInfluence ? { guestInfluence: { uncorroborated: true } } : {}),
    },
  };
}

/**
 * The lesson one correction is evidence for, or null. Pure, so the rules can be read and tested without a queue.
 *
 * A correction is the researcher asking, in their own words, for a change to a result the run delivered
 * (`result-corrected`, `feedbackEvents.mjs`), or answering the run's result with a correction, a preference or a rejection
 * (a `follow-up` of `learning-evidence`, judged on the next turn). It is `correction` evidence: the explicit rule the researcher
 * spelled out, about the run whose result was corrected. The run is the ORIGINAL's, so a method the lesson amends is tied to the
 * work it was learnt from, and each correction is its own dispatch (`dispatchKey` is the event's id): two corrections of one
 * run are two lessons, and neither adopts the other's bounded run.
 *
 * The gates are the ones every other lesson passes (`learningRefusal`): the researcher's own work, never the
 * platform's, never an internal capability, never a transcript the distillation cannot read. Nothing here treats the
 * successor as adopted: the event says it is not.
 *
 * @param {{ run: any, runs: readonly any[], project?: { id?: string | null } | null, event: any,
 *   internalAgent?: (agentId: string) => boolean, guestInfluence?: boolean }} input
 * @returns {{ trigger: string, idempotencyKey: string, payload: Record<string, any> } | null}
 */
export function correctionLessonFor({ run, runs, project = null, event, internalAgent = () => false, guestInfluence = false }) {
  const corrected = event?.trigger === "result-corrected"
    || (event?.trigger === "learning-evidence" && event.detail?.evidence === "follow-up" && isLearningCorrection(event.detail));
  if (!run || !event?.id || !corrected) return null;
  if (learningRefusal({ run, runs, project, internalAgent })) return null;
  return {
    trigger: "correction",
    idempotencyKey: `distill:${run.id}:correction:${event.id}`,
    payload: { runId: run.id, trigger: "correction", dispatchKey: event.id, feedbackEventIds: [event.id], feedback: [event],
      ...(guestInfluence ? { guestInfluence: { uncorroborated: true } } : {}) },
  };
}

export class LearningTriggers {
  /**
   * `routinePeriodDays` is the transcript retention (`ROUTINE_PERIOD_DAYS`), which a routine's period is (its family is read from the
   * feedback ledger, `LearningEvidence`, and no longer from every ledger the researcher owns). `evidence` is told of every finished run and every
   * correction, to keep what the researcher did to it and to settle it (`learningEvidence.mjs`); without it the loop is what it was
   * before 2026-10-23. `onRefused(reason)` is told of every run or correction a gate turned away (`LEARNING_REFUSAL_REASONS`).
   * @param {{ jobs: any, agentRuns: any, memory?: any, internalAgent?: (agentId: string) => boolean | Promise<boolean>,
   *   sessionState?: ((userId: string, projectId: string, sessionId: string) => Promise<{ trialCapsuleId?: string | null } | null>) | null,
   *   audit?: (event: string, detail: Record<string, any>) => Promise<void>,
   *   canReuseRun?: ((project:any,run:any)=>Promise<boolean>) | null,
   *   canReuseRuns?: ((project:any,runs:readonly any[])=>Promise<boolean[]>) | null,
   *   routinePeriodDays?: number,
   *   guestInfluence?: { assess: (userId: string, run: any) => Promise<{ guest: any[], uncorroborated: string[] }>,
   *     mark: (project: any, run: any, assessment: any) => Promise<unknown>, count?: (assessment: any) => void } | null,
   *   evidence?: { afterRun: (project: any, run: any, options: { guestInfluence: boolean }) => Promise<unknown>,
   *     mirrorResultCorrected?: (project: any, input: { event: any, runId: string }) => Promise<unknown> } | null,
   *   onRefused?: ((reason: string) => void) | null,
   *   repairShare?: number, onRepairSample?: ((distilled: boolean) => void) | null }} dependencies
   *   `repairShare`: the share (0 to 1) of deliveries that needed repairs inside their own run that queue a lesson; 0, the default, is none
   *   (`OPEN_SCIENCE_LEARNING_REPAIR_DISTILL_SAMPLE_SHARE`), and `onRepairSample` is told, for each one that would have queued one, whether the sample took it.
   */
  constructor({ jobs, agentRuns, memory = null, internalAgent = async () => false, sessionState = null, audit = async () => {},
    routinePeriodDays = ROUTINE_PERIOD_DAYS, guestInfluence = null, canReuseRun = null, canReuseRuns = null,
    evidence = null, onRefused = null, repairShare = 0, onRepairSample = null }) {
    if (!jobs || !agentRuns) throw new TypeError("Learning triggers need the job queue and the run ledger.");
    this.jobs = jobs;
    this.agentRuns = agentRuns;
    this.memory = memory;
    this.internalAgent = internalAgent;
    this.sessionState = sessionState;
    this.audit = audit;
    this.canReuseRun = canReuseRun;
    this.canReuseRuns = canReuseRuns;
    this.periodMs = routinePeriodMs(routinePeriodDays);
    this.guestInfluence = guestInfluence;
    this.evidence = evidence;
    this.onRefused = onRefused;
    this.repairShare = repairShare;
    this.onRepairSample = onRepairSample;
  }

  /** Counts one refusal; a counter never decides what is learned. @param {string} reason @returns {string} */
  #refused(reason) {
    try { this.onRefused?.(reason); } catch { /* a counter never decides what is learned */ }
    return reason;
  }

  /**
   * The lessons that stand once the sample has been applied: a delivery that needed repairs inside its own run (`repair_accepted`) is
   * queued for `repairShare` of the runs only, none by default: what a run repaired against the gate is the gate's bookkeeping (a verdict
   * withholds nothing since 2026-09-17), and the loop is to learn how the researcher works. Every other lesson is untouched.
   * @param {any} run @param {readonly { trigger: string }[]} lessons
   * @returns {{ lessons: readonly any[], sampledOut: string[] }}
   */
  #sampled(run, lessons) {
    /** @type {string[]} */
    const sampledOut = [];
    const kept = lessons.filter((lesson) => {
      if (lesson.trigger !== "repair_accepted") return true;
      const taken = sampledByHash(run.id, this.repairShare, REPAIR_SAMPLE_PURPOSE);
      try { this.onRepairSample?.(taken); } catch { /* a counter never decides what is learned */ }
      if (!taken) sampledOut.push(lesson.trigger);
      return taken;
    });
    return { lessons: kept, sampledOut };
  }

  /**
   * Whether a finished run drew on a received pack that is not yet corroborated, and — if so — the mark that keeps it out of
   * platform-level consumers. A pack with no verified author or fewer than the required keeping accounts is uncorroborated, so
   * the safe answer is the default; a failure to read at all is audited and leaves the lesson as it was, because a lesson that
   * never queued would be the account losing its own learning to a defence that is not about it.
   * @param {any} project @param {any} run
   * @returns {Promise<boolean>} whether the run's lessons carry `guestInfluence`
   */
  async #guestInfluenced(project, run) {
    if (!this.guestInfluence) return false;
    try {
      const assessment = await this.guestInfluence.assess(project.userId, run);
      this.guestInfluence.count?.(assessment);
      if (assessment.uncorroborated.length === 0) return false;
      await this.guestInfluence.mark(project, run, assessment);
      return true;
    } catch (error) {
      await this.audit("learning.guest.assess", { userId: project.userId, projectId: project.id, runId: run.id,
        code: typeof error?.code === "string" ? error.code : "learning_guest_unreadable", detail: "guest capsule" }).catch(() => {});
      return false;
    }
  }

  /**
   * When the account last reset its memory, or null: unreadable is not a reset, so a store that cannot say costs the loop
   * nothing it had.
   * @param {string} userId @returns {Promise<string | null>}
   */
  async #resetInstant(userId) {
    if (typeof this.memory?.resetInstant !== "function") return null;
    return this.memory.resetInstant(userId).catch(() => null);
  }

  /**
   * When the account last reset its memory, or null: what a routine's family leaves out (a run that ended before it is no peer, review M-11).
   * @param {string} userId @returns {Promise<string | null>}
   */
  async resetInstantOf(userId) {
    return this.#resetInstant(userId);
  }

  /**
   * Why a finished run may not teach, by what needs a store: a conversation that read a clinical source (its text is the study's, not
   * the account's), the researcher's own 「停止学习」 (a method distilled from their runs is learning too), a conversation that ended
   * before a reset asked to start from nothing (review M-11), and one trying someone else's capsule (its work was theirs). Counted.
   * @param {any} project @param {any} run
   * @returns {Promise<string | null>} one of `LEARNING_REFUSAL_REASONS`
   */
  async #storeRefusal(project, run) {
    if (this.canReuseRun && !await this.canReuseRun(project, run)) return this.#refused("clinical_context");
    if ((await memoryPausedFor(this.memory, project.userId, project.id).catch(() => ({ learning: false }))).learning) return this.#refused("paused");
    if (endedBeforeReset(run, await this.#resetInstant(project.userId))) {
      recordSkippedBeforeReset("lesson");
      return this.#refused("before_reset");
    }
    if (this.sessionState && run.sessionId) {
      const state = await this.sessionState(project.userId, project.id, run.sessionId).catch(() => null);
      if (state?.trialCapsuleId) return this.#refused("trial");
    }
    return null;
  }

  /**
   * Why a run may not be learnt from, or null: the one place every path that reads a finished run for evidence asks (a finished run,
   * a correction, a follow-up, a settled run). The run's own ledger is read for its transcript receipt when `runs` is not given.
   * @param {any} project @param {any} run @param {{ runs?: readonly any[] | null }} [options]
   * @returns {Promise<string | null>}
   */
  async refusalFor(project, run, { runs = null } = {}) {
    const stored = await this.#storeRefusal(project, run);
    if (stored) return stored;
    const ledger = runs ?? await this.agentRuns.list(project).catch(() => []);
    const agentId = String(run.effectiveAgentId ?? "");
    const internal = agentId ? await Promise.resolve(this.internalAgent(agentId)).catch(() => false) : false;
    const reason = learningRefusal({ run, runs: ledger, project, internalAgent: () => internal });
    return reason ? this.#refused(reason) : null;
  }

  /**
   * Queue one lesson. Best effort: a lesson that could not be queued must not be the reason a run reports failure, and must not be
   * silent either.
   * @param {any} project @param {any} run @param {{ trigger: string, idempotencyKey: string, payload: Record<string, any> }} lesson
   * @returns {Promise<boolean>}
   */
  async queue(project, run, lesson) {
    try {
      await this.jobs.enqueue(project.userId, "distill", lesson.payload, { idempotencyKey: lesson.idempotencyKey, projectId: project.id });
      return true;
    } catch (error) {
      this.#refused("enqueue_failed");
      await this.audit("learning.distill.enqueue", {
        userId: project.userId, projectId: project.id, runId: run.id,
        code: typeof error?.code === "string" ? error.code : "learning_enqueue_failed",
        detail: lesson.trigger,
      }).catch(() => {});
      return false;
    }
  }

  /**
   * Whether a run that finished without a guest-pack influence assessment carries the mark (`#guestInfluenced`), for the paths outside
   * `afterRun`: a settled run's routine is marked as the run's lessons were.
   * @param {any} project @param {any} run @returns {Promise<boolean>}
   */
  async guestInfluenced(project, run) {
    return this.#guestInfluenced(project, run);
  }

  /**
   * Queue the lessons one finished run is evidence for, and hand the run to the evidence ledger (what the researcher typed into it, and
   * the settling of it thirty minutes on). Best effort: a lesson that could not be queued must not be the reason a run reports failure,
   * and must not be silent either.
   *
   * @param {any} project @param {any} run @param {any} [memoryResult]
   * @returns {Promise<{ queued: string[], skipped: string | null }>}
   */
  async afterRun(project, run, memoryResult = null) {
    const runs = await this.agentRuns.list(project).catch(() => []);
    const refused = await this.refusalFor(project, run, { runs });
    if (refused) return { queued: [], skipped: refused };
    const projection = await this.agentRuns.runWorkflowProjection(project, run).catch(() => null);
    const agentId = String(run.effectiveAgentId ?? "");
    const internal = agentId ? await Promise.resolve(this.internalAgent(agentId)).catch(() => false) : false;
    const guestInfluence = await this.#guestInfluenced(project, run);
    const { lessons, sampledOut } = this.#sampled(run, learningTriggersFor({
      run, runs, project, projection, memoryResult, internalAgent: () => internal, guestInfluence,
    }));
    const queued = [];
    for (const lesson of lessons) {
      if (await this.queue(project, run, lesson)) queued.push(lesson.trigger);
    }
    // What the researcher typed into the run, and the settling of it. A failure here is the evidence's, never the lessons'.
    try { await this.evidence?.afterRun(project, runs.find((/** @type {any} */ item) => item?.id === run.id) ?? run, { guestInfluence }); } catch { /* counted by the evidence ledger */ }
    return { queued, skipped: null, ...(sampledOut.length ? { sampledOut } : {}), ...(guestInfluence ? { guestInfluence: "uncorroborated" } : {}) };
  }

  /**
   * Queue the lesson one correction is evidence for (`correctionLessonFor`): a result corrected in the page, or a follow-up judged on
   * the next turn. Best effort, and under the same switches as every other lesson: the researcher's "stop learning", someone else's
   * capsule being tried, the platform's own work.
   *
   * @param {any} project @param {{ event: any, runId: string }} correction
   * @returns {Promise<{ queued: string[], skipped: string | null }>}
   */
  async afterCorrection(project, { event, runId }) {
    const runs = await this.agentRuns.list(project).catch(() => []);
    const run = runs.find((/** @type {any} */ item) => item?.id === runId);
    if (!run) return { queued: [], skipped: this.#refused("run_unavailable") };
    // The run corrected is an old conversation when the correction comes late: one that ended before a reset is not a lesson.
    const refused = await this.refusalFor(project, run, { runs });
    if (refused) return { queued: [], skipped: refused };
    // The same correction, counted as evidence for the methods the run read (a follow-up is that already).
    if (event?.trigger === "result-corrected") await this.evidence?.mirrorResultCorrected?.(project, { event, runId }).catch(() => null);
    const agentId = String(run.effectiveAgentId ?? "");
    const internal = agentId ? await Promise.resolve(this.internalAgent(agentId)).catch(() => false) : false;
    const guestInfluence = await this.#guestInfluenced(project, run);
    const lesson = correctionLessonFor({ run, runs, project, event, internalAgent: () => internal, guestInfluence });
    if (!lesson) return { queued: [], skipped: this.#refused("not_eligible") };
    return await this.queue(project, run, lesson) ? { queued: [lesson.trigger], skipped: null } : { queued: [], skipped: "enqueue_failed" };
  }
}
