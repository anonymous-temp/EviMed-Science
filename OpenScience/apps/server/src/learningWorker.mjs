import { randomUUID } from "node:crypto";

import { CONSOLIDATE_ACTIONS } from "./methodConsolidation.mjs";

/**
 * The claimer for the two learning job kinds that have been declared vocabulary
 * with no producer and no consumer since the job ledger shipped.
 *
 * Hidden knowledge: `distill` and `consolidate` are already members of
 * `PRODUCT_JOB_KINDS`, which is a DDL CHECK constraint. Adding a kind means a
 * migration on a live table; adding an *action* inside `consolidate`'s payload
 * means nothing at all. So there is one worker, two kinds, and four actions —
 * and the vocabulary the constraint enforces is unchanged.
 *
 * Two things make this worker different from the other four, and both are about
 * it being the only one whose work nobody asked for:
 *
 *  - **It observes a window.** Model calls are half price outside peak hours
 *    (`priceUsage`'s off-peak multiplier), and nothing the loop does is urgent,
 *    so it declines to claim outside the configured window and says so in its
 *    status rather than silently idling.
 *  - **It fails quietly and never retries a bad shape.** A distillation that
 *    cannot be attempted is not a customer-visible failure; it is a job that
 *    ends. The terminal set below is the list of codes where retrying would
 *    only spend money to reach the same conclusion.
 */
export class LearningWorker {
  /**
   * @param {{jobs: any, distillation: any, consolidation: any, resolveProject?: (job: any) => Promise<any>,
   *          resolveRun?: (project: any, job: any) => Promise<any>, maintain?: () => Promise<void>,
   *          enabled?: boolean, window?: string,
   *          pollMs?: number, leaseMs?: number, reconcileMs?: number, now?: () => Date}} dependencies
   */
  constructor({
    jobs,
    distillation,
    consolidation,
    resolveProject = async () => null,
    resolveRun = async () => null,
    maintain = async () => {},
    enabled = true,
    window: activeWindow = "",
    pollMs = 5000,
    leaseMs = 900_000,
    reconcileMs = 300_000,
    now = () => new Date(),
  }) {
    if (!jobs || !distillation || !consolidation) throw new TypeError("LearningWorker dependencies are required.");
    /** @type {[string, number, number][]} */
    const intervals = [["poll", pollMs, 100], ["lease", leaseMs, 1000], ["reconcile", reconcileMs, 1000]];
    for (const [name, value, minimum] of intervals) {
      if (!Number.isSafeInteger(value) || value < minimum || value > 86_400_000) {
        throw new TypeError(`Invalid learning ${name} interval.`);
      }
    }
    this.jobs = jobs;
    this.distillation = distillation;
    this.consolidation = consolidation;
    this.resolveProject = resolveProject;
    this.resolveRun = resolveRun;
    this.maintain = maintain;
    this.enabled = enabled;
    this.window = parseWindow(activeWindow);
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.reconcileMs = reconcileMs;
    this.now = now;
    this.kinds = ["distill", "consolidate"];
    this.workerId = `learning-${randomUUID()}`;
    // Named `timer` and `reconcileTimer` because `pauseRecurringWork` reaches
    // for those two fields by name to drain the system for maintenance. A
    // worker that stores its interval anywhere else keeps claiming jobs through
    // a drain and nothing reports it.
    this.timer = null;
    this.reconcileTimer = null;
    this.running = null;
    this.reconciling = null;
    this.lastError = null;
    this.lastCompletedAt = null;
    this.lastSkippedReason = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.pollMs);
    this.reconcileTimer = setInterval(() => { void this.reconcile(); }, this.reconcileMs);
    this.timer.unref();
    this.reconcileTimer.unref();
    void this.tick().catch(() => {});
  }

  /** Whether the loop may spend money right now. @returns {string | null} */
  claimBlockedReason() {
    if (!this.enabled) return "learning_disabled";
    if (!withinWindow(this.window, this.now())) return "outside_learning_window";
    return null;
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.#tick().catch((error) => {
      this.lastError = typeof error?.code === "string" ? error.code : "learning_worker_failed";
      return null;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async #tick() {
    const blocked = this.claimBlockedReason();
    if (blocked) {
      this.lastSkippedReason = blocked;
      return null;
    }
    this.lastSkippedReason = null;
    const job = await this.jobs.claim(this.kinds, this.workerId, { leaseMs: this.leaseMs });
    if (!job) return null;
    let leaseLost = false;
    const renewal = setInterval(() => {
      void this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
        .then((renewed) => { if (!renewed) leaseLost = true; })
        .catch(() => { leaseLost = true; });
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    try {
      const result = await this.#execute(job);
      // A run that has not finished yet is not a job that has: the bounded run
      // keeps its own identity, and re-claiming later adopts it by dispatch id
      // rather than starting a second one.
      if (result?.state === "pending") {
        await this.jobs.fail(job.userId, job.id, job.leaseToken,
          { code: "learning_run_pending", message: "The bounded run has not finished." },
          { retry: true, delayMs: 30_000 });
        return result;
      }
      // Re-check the lease immediately before the irreversible write. The
      // renewal interval mutates a closure variable from a floating promise, so
      // a renewal still in flight has not yet set the flag.
      const renewed = leaseLost ? false : await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs);
      if (leaseLost || !renewed) {
        this.lastError = "product_job_lease_lost";
        return null;
      }
      await this.jobs.finish(job.userId, job.id, job.leaseToken, result ?? {});
      this.lastError = null;
      this.lastCompletedAt = this.now().toISOString();
      return result;
    } catch (error) {
      this.lastError = typeof error?.code === "string" ? error.code : "learning_job_failed";
      if (!leaseLost && this.lastError !== "product_job_lease_lost") {
        const terminal = TERMINAL_LEARNING_ERRORS.has(this.lastError);
        try {
          await this.jobs.fail(job.userId, job.id, job.leaseToken,
            { code: this.lastError, message: "The learning job failed." },
            { retry: !terminal, delayMs: terminal ? 0 : Math.min(300_000, 5000 * 2 ** Math.min(job.attempts, 6)) });
        } catch (failure) {
          if (failure?.code !== "product_job_lease_lost") throw failure;
        }
      }
      return null;
    } finally {
      clearInterval(renewal);
    }
  }

  /** @param {any} job */
  async #execute(job) {
    if (job.kind === "consolidate") {
      const action = String(job.payload?.action ?? "");
      if (!CONSOLIDATE_ACTIONS.includes(action)) {
        const error = new Error("Unknown consolidation action.");
        /** @type {any} */ (error).code = "consolidate_action_invalid";
        throw error;
      }
      return this.consolidation.run({ job });
    }
    const project = await this.resolveProject(job);
    const run = await this.resolveRun(project, job);
    if (!project || !run) {
      // The run this job was queued for is gone — its project was deleted, or
      // its ledger rolled past it. There is nothing to learn and nothing to
      // retry.
      const error = new Error("The run this distillation was queued for is unavailable.");
      /** @type {any} */ (error).code = "distillation_run_unavailable";
      throw error;
    }
    return this.distillation.execute({ job, project, run, feedback: job.payload?.feedback ?? [], repairIssues: job.payload?.repairIssues ?? [] });
  }

  /**
   * Nothing to reconcile yet: the loop owns no external resource that can drift.
   * The timer exists so that adding one later does not require touching the
   * maintenance drain, which finds workers by field name.
   */
  /**
   * Housekeeping the loop owes whether or not it has a job to run.
   *
   * Today that is transcript retention, and it runs on this timer rather than
   * inside `tick` because it is not work a job asked for: `TRANSCRIPT_RETENTION_DAYS`
   * had no caller anywhere, so a deployment that set it deleted nothing and
   * every project accumulated every conversation it had ever had. It also runs
   * regardless of `enabled` and outside the spending window — deleting old
   * files costs no model calls, and a deployment that turned the loop off after
   * using it is precisely the one whose transcripts nobody is going to prune.
   */
  async reconcile() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = Promise.resolve()
      .then(() => this.maintain())
      .catch((error) => {
        this.lastError = typeof error?.code === "string" ? error.code : "learning_maintenance_failed";
      })
      .then(() => null)
      .finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  status() {
    return {
      running: Boolean(this.running),
      enabled: this.enabled,
      lastError: this.lastError,
      lastCompletedAt: this.lastCompletedAt,
      lastSkippedReason: this.lastSkippedReason,
      window: this.window ? `${pad(this.window.startMinutes)}-${pad(this.window.endMinutes)}` : null,
    };
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null;
    this.reconcileTimer = null;
    await Promise.all([this.running, this.reconciling].filter(Boolean));
  }
}

/** Codes where another attempt would spend money to reach the same conclusion. */
const TERMINAL_LEARNING_ERRORS = new Set([
  "consolidate_action_invalid",
  "consolidate_payload_invalid",
  "distillation_trigger_invalid",
  "distillation_run_unavailable",
  "method_candidate_invalid",
  "method_invalid",
  "method_not_found",
  "method_relation_invalid",
  "method_evaluation_unavailable",
  "product_document_too_large",
]);

/**
 * @typedef {{startMinutes: number, endMinutes: number} | null} LearningWindow
 */

/**
 * Parse `HH:MM-HH:MM`. An unparseable window is no window rather than a refusal:
 * a typo in an operator's environment file should cost the off-peak discount,
 * not the feature.
 * @param {string} value
 * @returns {LearningWindow}
 */
export function parseWindow(value) {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const startMinutes = Number(match[1]) * 60 + Number(match[2]);
  const endMinutes = Number(match[3]) * 60 + Number(match[4]);
  if (startMinutes > 1439 || endMinutes > 1439 || startMinutes === endMinutes) return null;
  return { startMinutes, endMinutes };
}

/**
 * Windows wrap midnight, which is the only case that matters: the off-peak
 * window this exists for is 22:00 to 09:00.
 * @param {LearningWindow} window
 * @param {Date} now
 * @returns {boolean}
 */
export function withinWindow(window, now) {
  if (!window) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (window.startMinutes < window.endMinutes) return minutes >= window.startMinutes && minutes < window.endMinutes;
  return minutes >= window.startMinutes || minutes < window.endMinutes;
}

/** @param {number} minutes @returns {string} */
function pad(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
