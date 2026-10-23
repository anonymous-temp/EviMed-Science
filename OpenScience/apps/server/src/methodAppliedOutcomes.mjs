/**
 * What the researcher did after a run that opened a learned method, folded into that method's counters.
 *
 * Hidden knowledge: after the paired evaluation was deleted (2026-10-10) the only thing that could retire a method that
 * made work worse was the harm test over the runs that opened it, and it read one verdict: a deliverable the gate rejected.
 * The answer line — most of the traffic, and the line the loop now learns from — delivers nothing the gate judges, so a
 * method learnt there could ride in every prompt and never be judged (audit 2026-10-23, F break 2). What that line does
 * produce is the researcher's next words. Another package records them as evidence events (`learningEvidence.mjs`, the
 * feedback ledger, `trigger_kind = 'learning-evidence'`, subject the run reacted to, `detail = { evidence, verdict, concerns:
 * [{ id, digest }], at, … }`); this module reads them and moves the counters (`LearningService.recordApplied`,
 * `foldApplied`):
 *
 *  - `corrected`: a correction, preference or rejection on the run whose `concerns` names this method, at the body the run read
 *    (its mounted digest, or its content digest — the judge is shown the cards of what the run opened and may name either);
 *  - `clean`: the conversation moved on — a `silent` event, an acceptance, or a later turn with verdict `none` — and no
 *    correction on the run is left unattributed.
 *
 * What is never recorded: a correction that names no method (the researcher corrected the answer, and nothing says it was the
 * method: a missing attribution is not a clean run), a run nobody reacted to (no event: unknown, never clean), a run the
 * platform made (`isResearcherOwnedWork`: an acceptance driver's traffic teaches nothing), and a method whose body has changed
 * since the run read it (the counters are about the text it held then).
 *
 * Idempotent by run: a window that overlaps the last one counts nothing twice, so it is run on the hourly pass and may be run
 * again at any time. A failure of one project or one method is that one's alone.
 *
 * @module methodAppliedOutcomes
 */

import { createHash } from "node:crypto";

import { isResearcherOwnedWork, mountedMethodDigest } from "@evimed/domain";

/** The trigger the evidence events are filed under in the feedback ledger. */
export const LEARNING_EVIDENCE_TRIGGER = "learning-evidence";

/** How far back the events are read, and how much of the ledger one settlement may read: bounds, not opinions. */
const DEFAULT_WINDOW_MS = 72 * 3_600_000;
const PAGE = 200;
const MAX_PAGES = 5;

const CORRECTION_VERDICTS = Object.freeze(["correction", "preference", "rejection"]);
const MOVED_ON_VERDICTS = Object.freeze(["accept", "none"]);

/** @param {string} text @returns {string} */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Whether an evidence event is the researcher correcting the work.
 * @param {any} detail @returns {boolean}
 */
function isCorrection(detail) {
  return ["steer", "result-corrected"].includes(String(detail?.evidence ?? "")) || CORRECTION_VERDICTS.includes(String(detail?.verdict ?? ""));
}

/**
 * Whether an evidence event says the conversation moved on from the run: nothing was said (`silent`), or what was said accepted
 * the work or was about something else.
 * @param {any} detail @returns {boolean}
 */
function isMovedOn(detail) {
  if (isCorrection(detail)) return false;
  return detail?.evidence === "silent" || MOVED_ON_VERDICTS.includes(String(detail?.verdict ?? ""));
}

/**
 * @param {{
 *   learning: { approvedMethods: (userId: string) => Promise<any[]>, recordApplied: (userId: string, methodId: string, applied: { runId: string, outcome: "corrected" | "clean", at: string }, expectedDigest?: string) => Promise<{ changed: boolean }> },
 *   feedback: { list: (userId: string, options: { trigger?: string | null, limit?: number, cursor?: string | null }) => Promise<{ items: any[], nextCursor: string | null }> },
 *   resolveProject: (userId: string, projectId: string) => Promise<any | null>,
 *   runsOf: (project: any) => Promise<any[]>,
 *   now?: () => number, windowMs?: number,
 *   onApplied?: ((outcome: "corrected" | "clean") => void) | null,
 *   audit?: ((event: string, detail: Record<string, unknown>) => unknown) | null,
 * }} dependencies
 */
export function createMethodAppliedOutcomes({ learning, feedback, resolveProject, runsOf, now = () => Date.now(), windowMs = DEFAULT_WINDOW_MS, onApplied = null, audit = null }) {
  /** @param {string} event @param {Record<string, unknown>} detail */
  const say = (event, detail) => { try { void Promise.resolve(audit?.(event, detail)).catch(() => {}); } catch { /* an audit line never decides */ } };

  /**
   * The evidence events of the window, newest first, grouped by the run each reacted to.
   * @param {string} userId
   * @returns {Promise<Map<string, { projectId: string, events: any[] }>>}
   */
  async function recentEvidence(userId) {
    /** @type {Map<string, { projectId: string, events: any[] }>} */
    const byRun = new Map();
    const since = now() - windowMs;
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await feedback.list(userId, { trigger: LEARNING_EVIDENCE_TRIGGER, limit: PAGE, cursor });
      let reachedBack = false;
      for (const event of result.items ?? []) {
        if (Date.parse(String(event.occurredAt ?? "")) < since) { reachedBack = true; continue; }
        if (event.subject?.type !== "run" || !event.subject?.id || !event.projectId) continue;
        const held = byRun.get(String(event.subject.id)) ?? { projectId: String(event.projectId), events: [] };
        held.events.push(event);
        byRun.set(String(event.subject.id), held);
      }
      cursor = result.nextCursor ?? null;
      if (reachedBack || !cursor) break;
    }
    return byRun;
  }

  /**
   * Fold what the researcher did after each recent run that opened a method into the methods' counters.
   * @param {string} userId
   * @returns {Promise<{ runs: number, corrected: number, clean: number, unattributed: number, stale: number, failed: number }>}
   */
  async function settleUser(userId) {
    const result = { runs: 0, corrected: 0, clean: 0, unattributed: 0, stale: 0, failed: 0 };
    let evidence;
    try { evidence = await recentEvidence(userId); }
    catch (error) {
      say("learning.applied.read", { userId, code: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evidence_unreadable" });
      return { ...result, failed: 1 };
    }
    if (!evidence.size) return result;
    /** @type {Map<string, any>} */
    const byName = new Map();
    try {
      for (const document of await learning.approvedMethods(userId)) byName.set(String(document?.payload?.frontmatter?.name ?? ""), document);
    } catch (error) {
      say("learning.applied.read", { userId, code: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "methods_unreadable" });
      return { ...result, failed: 1 };
    }
    /** @type {Map<string, Map<string, any>>} */
    const runsByProject = new Map();
    for (const [runId, { projectId, events }] of evidence) {
      try {
        let runs = runsByProject.get(projectId);
        if (!runs) {
          const project = await resolveProject(userId, projectId);
          runs = new Map((project ? await runsOf(project) : []).map((entry) => [String(entry.id), entry]));
          runsByProject.set(projectId, runs);
        }
        const run = runs.get(runId);
        if (!run || !isResearcherOwnedWork(run)) continue;
        const opened = (Array.isArray(run.methodsInvoked) ? run.methodsInvoked : []).filter((/** @type {any} */ entry) => entry?.name && entry?.digest && entry.trial !== true);
        if (!opened.length) continue;
        result.runs += 1;
        const corrections = events.filter((event) => isCorrection(event.detail));
        const movedOn = events.some((event) => isMovedOn(event.detail));
        const latest = (/** @type {any[]} */ list) => String(list.map((event) => String(event.detail?.at ?? event.occurredAt ?? "")).sort().at(-1) ?? "");
        for (const entry of opened) {
          const document = byName.get(String(entry.name));
          if (!document) continue;
          const payload = document.payload ?? {};
          // The reaction is to the text the run read: a method amended since holds another body and is not credited with it.
          if (mountedMethodDigest(payload, sha256) !== entry.digest) { result.stale += 1; continue; }
          const named = corrections.filter((event) => (Array.isArray(event.detail?.concerns) ? event.detail.concerns : []).some((/** @type {any} */ concern) =>
            concern?.id === document.id && (concern?.digest === entry.digest || concern?.digest === payload.contentDigest)));
          /** @type {"corrected" | "clean" | null} */
          let outcome = null;
          if (named.length) outcome = "corrected";
          else if (!corrections.length && movedOn) outcome = "clean";
          else if (corrections.length) { result.unattributed += 1; continue; }
          if (!outcome) continue;
          const at = latest(named.length ? named : events);
          try {
            const { changed } = await learning.recordApplied(userId, document.id, { runId, outcome, at: at || new Date(now()).toISOString() }, payload.contentDigest);
            if (changed) {
              result[outcome] += 1;
              try { onApplied?.(outcome); } catch { /* a counter never decides */ }
            }
          } catch (error) {
            result.failed += 1;
            say("learning.applied.record", { userId, projectId, runId, code: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "applied_unrecorded" });
          }
        }
      } catch (error) {
        result.failed += 1;
        say("learning.applied.project", { userId, projectId, runId, code: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "applied_project_unreadable" });
      }
    }
    return result;
  }

  return { settleUser };
}
