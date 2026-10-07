/**
 * 「虚拟临床研究」's background work: one timer, seven loops (build plan
 * 2026-09-28 §11.2 layer 2).
 *
 *   `jobs`          — claim queued compute, push each running job one step,
 *                     register what came back
 *   `orchestrator`  — advance every active study: observe, enqueue, dispatch,
 *                     notify
 *   `recompute`     — pick up the stale marks a change left and queue what has
 *                     to be computed again
 *   `recheck`       — queue the matching job of every study with a deferral
 *                     date that has passed (a washout that ended), so a due
 *                     date is re-evaluated without anyone remembering it
 *   `frontierEvents` — read the frontier feed's trial events for each study's
 *                     entity keys: precedent candidates, 「有新证据」 on a card,
 *                     and the request for a new version (flywheel F24; absent
 *                     while its switch is off, which readiness does not report)
 *   `packSources`   — label a live platform knowledge pack 「来源有变更」 when the
 *                     source-change ledger holds a change to one of its sources
 *                     (flywheel F26; absent while platform packs are off)
 *   `drafts`        — delete the drafts nobody spoke in for an hour (`vcrDrafts.mjs`;
 *                     R10: 「新建研究」 makes the study before the first word)
 *
 * Hidden knowledge:
 *
 * - **One timer**, like `geoWorker.mjs` and `frontierWorker.mjs`: the
 *   maintenance pause stops recurring work by clearing each worker's `timer`
 *   (`pauseRecurringWork` in `server.mjs`), so a second timer here would be a
 *   loop maintenance could not stop.
 * - **Loops are isolated.** A loop never overlaps itself and never waits for
 *   another; one that throws records its error code and failure count and the
 *   others run on. A loop still running past the lease is reported as stalled
 *   — a promise cannot be cancelled, but it can be seen, and readiness says so.
 * - **The `jobs` loop is deliberately unleased.** Claiming is already
 *   exclusive in the database (`FOR UPDATE SKIP LOCKED` plus a per-job lease),
 *   and a lease around the whole loop would serialise two control planes that
 *   can safely both be pulling work. The `orchestrator` and `recompute` loops
 *   *are* leased, because dispatching a run and marking a study's results
 *   stale must happen once; so is `recheck`, because one due date is one job.
 * - **A loop without its function is skipped and reported**, not an error: a
 *   deployment with no engine composed still runs the orchestrator, and
 *   readiness warns rather than going red (plan §10.5).
 * - Every loop checks `canRun` (the maintenance lease's `claimingAllowed`)
 *   before it starts, like every other worker of this control plane.
 *
 * @module vcrWorker
 */

const MINUTE = 60_000;

/**
 * The loops and their cadences, in the order a tick starts them.
 * `every`: milliseconds between starts (0 = every base tick).
 */
export const VCR_WORKER_LOOPS = Object.freeze([
  Object.freeze({ name: "jobs", package: "jobs", every: 0 }),
  Object.freeze({ name: "orchestrator", package: "orchestrator", every: MINUTE, leased: true }),
  Object.freeze({ name: "recompute", package: "orchestrator", every: MINUTE, leased: true }),
  Object.freeze({ name: "recheck", package: "matching", every: 15 * MINUTE, leased: true }),
  Object.freeze({ name: "frontierEvents", package: "frontierEvents", every: 10 * MINUTE, leased: true, optional: true }),
  Object.freeze({ name: "packSources", package: "knowledge", every: 30 * MINUTE, leased: true, optional: true }),
  Object.freeze({ name: "drafts", package: "drafts", every: 10 * MINUTE, leased: true, optional: true }),
]);

/** @param {unknown} error */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "vcr_loop_failed");

/**
 * The `vcr` readiness check with what the worker says added as warnings on a
 * green check: a loop not wired, one whose last run failed, one past its
 * lease. Loops are background work — none of them makes the module red, and
 * the page keeps answering from what is stored.
 * @template {Record<string, any>} T @param {T} readiness @param {{ status?: () => any } | null} worker @returns {T}
 */
export function withVcrWorkerWarnings(readiness, worker) {
  if (!readiness || readiness.enabled === false || !worker?.status) return readiness;
  const status = worker.status();
  const added = [
    ...(status?.missing?.length ? ["vcr_worker_loop_missing"] : []),
    ...(status?.failing?.length ? ["vcr_worker_loop_failing"] : []),
    ...(status?.stalled?.length ? ["vcr_worker_loop_stalled"] : []),
  ];
  if (!added.length) return readiness;
  const warnings = [...(Array.isArray(readiness.warnings) ? readiness.warnings : []), ...added];
  return { ...readiness, warning: readiness.warning ?? warnings[0], warnings };
}

/** A small summary of what a tick returned, for the status (counts only, never rows). @param {unknown} value */
function summary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  /** @type {Record<string, number | string | boolean>} */
  const out = {};
  for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value)).slice(0, 20)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
    else if (typeof entry === "boolean") out[key] = entry;
    else if (typeof entry === "string" && entry.length <= 60) out[key] = entry;
    else if (Array.isArray(entry)) out[key] = entry.length;
  }
  return out;
}

export class VcrWorker {
  /**
   * @param {{ loops: Record<string, (() => Promise<unknown>) | null | undefined>, pollMs?: number, leaseMs?: number,
   *   canRun?: () => boolean, now?: () => Date, report?: (loop: string, code: string) => void,
   *   lease?: ((loop: string, work: () => Promise<unknown>) => Promise<{ acquired: boolean, value?: unknown }>) | null,
   *   cadence?: Record<string, { every?: number }> }} dependencies
   */
  constructor({ loops, pollMs = 5_000, leaseMs = 900_000, canRun = () => true, now = () => new Date(),
    report = () => {}, lease = null, cadence = {} }) {
    if (!loops || typeof loops !== "object") throw new TypeError("The VCR worker needs its loops.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 3_600_000) throw new TypeError("Invalid VCR worker poll interval.");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 86_400_000) throw new TypeError("Invalid VCR worker lease.");
    for (const name of Object.keys(loops)) {
      if (!VCR_WORKER_LOOPS.some((loop) => loop.name === name)) throw new TypeError(`Unknown VCR worker loop: ${name}.`);
      if (loops[name] != null && typeof loops[name] !== "function") throw new TypeError(`The VCR worker loop ${name} must be a function.`);
    }
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.canRun = canRun;
    this.now = now;
    this.report = report;
    this.lease = lease;
    /** @type {Array<{ name: string, package: string, every?: number, leased?: boolean, optional?: boolean, run: (() => Promise<unknown>) | null }>} */
    this.table = VCR_WORKER_LOOPS.map((loop) => ({ ...loop, ...(cadence[loop.name] ?? {}), run: loops[loop.name] ?? null }));
    /** @type {ReturnType<typeof setInterval> | null} cleared by the maintenance pause */
    this.timer = null;
    this.closed = false;
    /** @type {Record<string, Promise<unknown> | null>} */
    this.running = Object.fromEntries(this.table.map((loop) => [loop.name, null]));
    /** @type {Record<string, { startedAt: number | null, lastRunAt: string | null, lastOkAt: string | null,
     *   lastError: string | null, runs: number, failures: number, last: Record<string, unknown> | null }>} */
    this.loops = Object.fromEntries(this.table.map((loop) => [loop.name, {
      startedAt: null, lastRunAt: null, lastOkAt: null, lastError: null, runs: 0, failures: 0, last: null,
    }]));
    /** When each loop last started (epoch ms); 0 = due now. */
    this.lastStarted = Object.fromEntries(this.table.map((loop) => [loop.name, 0]));
  }

  /** The code of a loop whose last run failed, or null. */
  get lastError() {
    return Object.values(this.loops).find((state) => state.lastError)?.lastError ?? null;
  }

  start() {
    this.closed = false;
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** @param {string} name @param {() => Promise<unknown>} work */
  #run(name, work) {
    if (this.running[name]) return this.running[name];
    const state = this.loops[name];
    state.startedAt = this.now().getTime();
    state.lastRunAt = new Date(state.startedAt).toISOString();
    state.runs += 1;
    const running = (async () => {
      try {
        const result = await work();
        state.lastError = null;
        state.lastOkAt = this.now().toISOString();
        state.last = summary(result);
        return result;
      } catch (error) {
        const code = codeOf(error);
        state.lastError = code;
        state.failures += 1;
        this.report(name, code);
        return null;
      } finally {
        state.startedAt = null;
        this.running[name] = null;
      }
    })();
    this.running[name] = running;
    return running;
  }

  /**
   * Start every loop that is due. Resolves when the loops started by this
   * tick have finished — which is what a test awaits; the timer does not.
   */
  async tick() {
    if (this.closed || !this.canRun()) return [];
    /** @type {Promise<unknown>[]} */
    const started = [];
    const at = this.now().getTime();
    for (const loop of this.table) {
      if (!loop.run || this.running[loop.name]) continue;
      const every = Number(loop.every ?? 0);
      if (every > 0 && this.lastStarted[loop.name] && at - this.lastStarted[loop.name] < every) continue;
      if (!this.canRun() || this.closed) break;
      this.lastStarted[loop.name] = at;
      started.push(this.#run(loop.name, this.#work(loop)));
    }
    return Promise.all(started);
  }

  /** Run one loop now, whatever its cadence (a test, an operator). @param {string} name */
  async runNow(name) {
    const loop = this.table.find((entry) => entry.name === name);
    if (!loop?.run) return null;
    return this.#run(loop.name, this.#work(loop));
  }

  /** A loop's work, inside its lease when it is leased. @param {{ name: string, leased?: boolean, run: (() => Promise<unknown>) | null }} loop */
  #work(loop) {
    const run = /** @type {() => Promise<unknown>} */ (loop.run);
    const lease = this.lease;
    if (!loop.leased || !lease) return () => run();
    return async () => {
      const held = await lease(loop.name, run);
      return held.acquired ? held.value : { held: "elsewhere" };
    };
  }

  status() {
    const at = this.now().getTime();
    const loops = Object.fromEntries(this.table.map((loop) => {
      const state = this.loops[loop.name];
      return [loop.name, {
        wired: Boolean(loop.run),
        running: Boolean(this.running[loop.name]),
        stalled: state.startedAt != null && at - state.startedAt > this.leaseMs,
        lastRunAt: state.lastRunAt, lastOkAt: state.lastOkAt, lastError: state.lastError,
        runs: state.runs, failures: state.failures, last: state.last,
      }];
    }));
    return {
      running: Object.values(this.running).some(Boolean),
      armed: Boolean(this.timer),
      lastError: this.lastError,
      // A loop whose module is switched off on purpose is not a missing one.
      missing: this.table.filter((loop) => !loop.run && !loop.optional).map((loop) => loop.name),
      failing: this.table.filter((loop) => this.loops[loop.name].lastError).map((loop) => loop.name),
      stalled: Object.entries(loops).filter(([, entry]) => entry.stalled).map(([name]) => name),
      loops,
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(Object.values(this.running).filter(Boolean));
  }
}

/**
 * The loop functions, built from the composed module. Kept here so
 * `server.mjs` composes a worker with one call and the loops' own logic stays
 * with the packages that own it.
 *
 * @param {{ jobs: any, orchestrator: any, store: any, matching?: any, frontierEvents?: any, knowledge?: any, drafts?: any }} vcr
 */
export function createVcrWorkerLoops({ jobs, orchestrator, store, matching = null, frontierEvents = null, knowledge = null, drafts = null }) {
  return {
    /**
     * Claim what is queued, then push everything this process holds one step.
     * Jobs that ended without this loop's help are folded in too: one that ran
     * out of attempts while nobody held it (the claim fails it by name), and one
     * cancelled after the engine had already computed part of it (its partial
     * result is fetched and kept).
     */
    jobs: jobs
      ? async () => {
        const claimed = await jobs.claim({ limit: Math.max(1, Number(jobs.maxConcurrent ?? 1)) });
        let advanced = 0;
        let finished = 0;
        /** @param {any} outcome */
        const told = async (outcome) => {
          if (outcome?.action !== "finished") return;
          finished += 1;
          if (orchestrator?.onJobFinished) await orchestrator.onJobFinished(outcome).catch(() => null);
        };
        for (const job of claimed) {
          advanced += 1;
          await told(await jobs.advance(job));
        }
        // Jobs already out with this process's lease: read where they got to.
        const running = await store.rows(
          "SELECT id, study_id FROM evimed_vcr.jobs WHERE state = 'running' AND lease_owner = $1 LIMIT 20", [jobs.owner]);
        for (const row of running) {
          if (claimed.some((job) => job.id === String(row.id))) continue;
          advanced += 1;
          await told(await jobs.advance({ id: String(row.id) }));
        }
        let failedForAttempts = 0;
        for (const job of jobs.takeReaped?.() ?? []) {
          failedForAttempts += 1;
          if (orchestrator?.onJobFinished) await orchestrator.onJobFinished({ job, result: null }).catch(() => null);
        }
        let recovered = 0;
        for (const kept of (await jobs.recoverCanceled?.().catch(() => [])) ?? []) {
          recovered += 1;
          if (orchestrator?.onJobFinished) await orchestrator.onJobFinished({ job: kept.job, result: kept.result, partial: true }).catch(() => null);
        }
        return { claimed: claimed.length, advanced, finished, failedForAttempts, recovered };
      }
      : null,

    /** Advance every active study once. */
    orchestrator: orchestrator ? () => orchestrator.tick() : null,

    /**
     * Stale marks with no recompute queued yet. The orchestrator's own
     * `advance` enqueues the work; this loop is what notices a study nobody
     * has touched since its inputs changed.
     */
    recompute: orchestrator
      ? async () => {
        const rows = await store.rows(`SELECT DISTINCT s.study_id FROM evimed_vcr.stale_marks s
          JOIN evimed_vcr.studies t ON t.id = s.study_id AND t.deleted_at IS NULL AND t.status = 'active'
          WHERE s.cleared_at IS NULL LIMIT 100`);
        let advanced = 0;
        for (const row of rows) {
          await orchestrator.advance(String(row.study_id)).catch(() => null);
          advanced += 1;
        }
        return { studies: rows.length, advanced };
      }
      : null,

    /**
     * The subjects whose deferral date has passed: the matching package queues
     * one frozen job per study with something due. A deployment with no
     * matching package composed has no such loop, and readiness says so.
     */
    recheck: matching?.recheckDue ? () => matching.recheckDue() : null,

    /** The frontier feed's trial events for every active study, a bounded number each tick (`vcrFrontierEvents.mjs`). Absent while off. */
    frontierEvents: frontierEvents?.tick ? () => frontierEvents.tick() : null,

    /** The platform packs' source watch (`vcrKnowledge.mjs`). Absent while platform packs are off. */
    packSources: knowledge?.platform?.enabled && knowledge.watchPlatformPackSources ? () => knowledge.watchPlatformPackSources() : null,

    /** The drafts nobody spoke in for an hour (`vcrDrafts.mjs`). */
    drafts: drafts?.sweep ? () => drafts.sweep() : null,
  };
}
