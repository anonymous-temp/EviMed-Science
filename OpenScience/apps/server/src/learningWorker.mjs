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
   *          enabled?: boolean, window?: string, windowTimeZone?: string,
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
    // Which zone the window's numbers are written in. Empty means the process
    // clock, which is what this did before and is right for a local run.
    windowTimeZone = "",
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
    this.windowTimeZone = String(windowTimeZone ?? "");
    // Whether this Node can resolve the zone at all. The web image is a slim
    // Debian with no /usr/share/zoneinfo, and coreutils `date` there prints UTC
    // whatever TZ says; what the window reads is Node's own ICU, which carries
    // every IANA zone (memory: node reads TZ without tzdata). An unknown name
    // still falls back to the process clock rather than stopping the loop, but
    // it is no longer invisible: the status says so.
    this.windowTimeZoneResolved = !this.windowTimeZone || resolvesTimeZone(this.windowTimeZone);
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
    if (!withinWindow(this.window, this.now(), this.windowTimeZone)) return "outside_learning_window";
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
        // Looking again is not another attempt. Every claim counts one, so a
        // distillation still working at the third look — about a minute —
        // used to fail as exhausted while its run carried on (2026-09-21).
        await this.jobs.fail(job.userId, job.id, job.leaseToken,
          { code: "learning_run_pending", message: "The bounded run has not finished." },
          { retry: true, delayMs: 30_000, refundAttempt: true });
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
        const deferral = DEFERRED_LEARNING_ERRORS.get(this.lastError);
        try {
          await this.jobs.fail(job.userId, job.id, job.leaseToken,
            { code: this.lastError, message: deferral ? "The learning job is waiting." : "The learning job failed." },
            deferral
              ? { retry: true, delayMs: deferral, refundAttempt: true }
              : { retry: !terminal, delayMs: terminal ? 0 : Math.min(300_000, 5000 * 2 ** Math.min(job.attempts, 6)) });
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
      // Which clock the window's numbers are read on: the zone, and whether
      // this build could resolve it (see the constructor).
      windowTimeZone: this.windowTimeZone || null,
      windowTimeZoneResolved: this.windowTimeZoneResolved,
    };
  }

  /**
   * Which night a moment belongs to, as the date the window opened on in the
   * window's own zone — the identity of one nightly consolidation pass.
   * @param {Date} now @returns {string}
   */
  nightKey(now = this.now()) {
    return windowNightKey(this.window, now, this.windowTimeZone);
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null;
    this.reconcileTimer = null;
    await Promise.all([this.running, this.reconciling].filter(Boolean));
  }
}

/**
 * Codes that mean the work never started, and how long to wait before asking
 * again. A deferral costs no attempt (`refundAttempt`): the project was running
 * someone's research, every runtime slot was taken, or a cap was reached, and
 * none of that says anything about the lesson. They used to be ordinary
 * retries, so a lesson queued while its researcher asked a follow-up question
 * was spent in thirty seconds and never learnt (2026-09-20, three of three).
 */
const DEFERRED_LEARNING_ERRORS = new Map([
  ["runtime_busy", 60_000],
  ["runtime_limit_exceeded", 120_000],
  ["runtime_proxy_limit_exceeded", 120_000],
  ["usage_budget_exceeded", 3_600_000],
]);

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
 *
 * The zone is an argument because it was implicitly the process's. The web
 * container ships with no `TZ`, so a clock reading came back UTC while the
 * operator had written `22:00-09:00` meaning Beijing; the loop was therefore
 * armed for 06:00–17:00 China time — the working day, the exact opposite of
 * the off-peak band the window exists to hit (2026-09-15 walk, B3). It cost
 * nothing only because the deployment had no trajectories to learn from yet.
 *
 * A zone this build cannot resolve falls back to the process's own clock with
 * a named throw handled by the caller, rather than silently picking one.
 *
 * @param {LearningWindow} window
 * @param {Date} now
 * @param {string} [timeZone] IANA zone the window's numbers are written in.
 * @returns {boolean}
 */
export function withinWindow(window, now, timeZone = "") {
  if (!window) return true;
  const minutes = zonedMinutes(now, timeZone);
  if (window.startMinutes < window.endMinutes) return minutes >= window.startMinutes && minutes < window.endMinutes;
  return minutes >= window.startMinutes || minutes < window.endMinutes;
}

/**
 * Minutes past midnight in the given zone, or in the process's own zone when
 * none is given or the given one is not a zone this build knows.
 * @param {Date} now @param {string} timeZone @returns {number}
 */
function zonedMinutes(now, timeZone) {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(now);
      const hour = Number(parts.find((part) => part.type === "hour")?.value);
      const minute = Number(parts.find((part) => part.type === "minute")?.value);
      if (Number.isInteger(hour) && Number.isInteger(minute)) return hour * 60 + minute;
    } catch {
      // An unknown zone name is a configuration error, not a reason to stop
      // the loop; the process clock is what this did before the argument.
    }
  }
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * Whether this Node resolves an IANA zone name.
 * @param {string} timeZone @returns {boolean}
 */
export function resolvesTimeZone(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

/**
 * The date a window occurrence opened on, in the window's zone.
 *
 * The consolidation pass is once per night, and the night was keyed by the
 * UTC date. Beijing's night 22:00–09:00 is 14:00–01:00 UTC, so the UTC date
 * turned over at 08:00 Beijing, inside the window: the job for the "new day"
 * was queued and claimed at 08:00, an hour before the window closed, instead
 * of at 22:00 when it opens. Shifting the clock back by the window's end
 * before reading the date gives every moment of one occurrence one key —
 * 23:00 and 03:00 of the same night agree — and gives a daytime moment the
 * key of the night that is about to open.
 *
 * @param {LearningWindow} window @param {Date} now @param {string} [timeZone]
 * @returns {string} `YYYY-MM-DD`
 */
export function windowNightKey(window, now, timeZone = "") {
  const shifted = new Date(now.getTime() - (window ? window.endMinutes : 0) * 60_000);
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(shifted);
      const part = (/** @type {string} */ type) => parts.find((item) => item.type === type)?.value;
      if (part("year") && part("month") && part("day")) return `${part("year")}-${part("month")}-${part("day")}`;
    } catch {
      // An unknown zone reads the process clock, as the window itself does.
    }
  }
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}-${String(shifted.getDate()).padStart(2, "0")}`;
}

/** @param {number} minutes @returns {string} */
function pad(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
