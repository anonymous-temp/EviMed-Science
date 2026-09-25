/**
 * 「循证 GEO」's background work: one timer, many loops (build spec 2026-09-25
 * §5). The loops are other modules' tick functions — measurement (probe,
 * parse, metrics, errors), the marketplace (catalogue, orders, poll, verify,
 * reconcile, top-ups) and the orchestrator (program, schedules) — and this
 * class only decides when each runs and keeps what happened to it.
 *
 * Hidden knowledge:
 *
 * - **One timer**, like `frontierWorker.mjs`: the maintenance pause stops
 *   recurring work by clearing each worker's `timer` (`pauseRecurringWork` in
 *   `server.mjs`), so a second timer here would be a loop maintenance could
 *   not stop. The base tick is `OPEN_SCIENCE_GEO_POLL_MS`; each loop has its
 *   own cadence on top of it.
 * - **Loops are isolated.** A loop never overlaps itself and never waits for
 *   another; one that throws records its error code and failure count and the
 *   others run on. A loop still running past the lease
 *   (`OPEN_SCIENCE_GEO_LEASE_MS`) is reported as stalled — a promise cannot be
 *   cancelled, but it can be seen, and readiness says so.
 * - **A loop without its function is skipped and reported**, not an error:
 *   the measurement package plugs its four ticks in at composition, and until
 *   it does the status lists them under `missing` and readiness warns.
 * - **Cadences.** `every` loops start when their interval has passed since
 *   they last started (the first tick starts them). `daily` loops start once
 *   per calendar day in the module's time zone, at or after their hour; the
 *   day is claimed through `claimDay(loop, day)` when given (the
 *   orchestrator's marks — so a restart or a second process does not run a
 *   daily loop twice), else remembered in memory.
 * - **Leased across processes.** A loop marked `leased` (the orchestrator's
 *   two and every market tick) runs inside `lease(loop, work)` — a session
 *   advisory lock per loop on a dedicated connection — so two control planes,
 *   or a tick that outlived its interval in one of them, never run the same
 *   tick at once: the market's money path assumes it is alone. A loop whose
 *   lease another process holds is skipped this time (`last.held`), not
 *   failed. The measurement ticks take their own locks (the probe's).
 * - Every loop checks `canRun` (the maintenance lease's `claimingAllowed`)
 *   before it starts, like every other worker of this control plane.
 *
 * @module geoWorker
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The loops and their cadences, in the order a tick starts them.
 * `every`: milliseconds between starts (0 = every base tick). `daily`: the
 * local hour it runs at, once a day.
 */
export const GEO_WORKER_LOOPS = Object.freeze([
  Object.freeze({ name: "probe", package: "measurement", every: 0 }),
  Object.freeze({ name: "parse", package: "measurement", every: 0 }),
  Object.freeze({ name: "metrics", package: "measurement", every: 0 }),
  Object.freeze({ name: "errors", package: "measurement", every: 0 }),
  Object.freeze({ name: "orchestrator", package: "orchestrator", every: MINUTE, leased: true }),
  Object.freeze({ name: "schedules", package: "orchestrator", every: MINUTE, leased: true }),
  Object.freeze({ name: "catalogue", package: "market", daily: 5, leased: true }),
  Object.freeze({ name: "orders", package: "market", every: 10 * MINUTE, leased: true }),
  Object.freeze({ name: "poll", package: "market", every: 10 * MINUTE, leased: true }),
  Object.freeze({ name: "verify", package: "market", every: 10 * MINUTE, leased: true }),
  Object.freeze({ name: "reconcile", package: "market", daily: 4, leased: true }),
  Object.freeze({ name: "topups", package: "market", every: HOUR, leased: true }),
]);

/** @param {unknown} error */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "geo_loop_failed");

/** The calendar day and hour of `date` in `timeZone`. @param {Date} date @param {string} timeZone */
export function zonedDayHour(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/**
 * The `geo` readiness check with what the worker says added as warnings on
 * a green check: a loop not wired (`geo_worker_loop_missing`), one whose last
 * run failed (`geo_worker_loop_failing`), one past its lease
 * (`geo_worker_loop_stalled`). Loops are background work — none of them makes
 * the module red, and the page keeps answering from what is stored.
 * @template {Record<string, any>} T @param {T} readiness @param {{ status?: () => any } | null} worker @returns {T}
 */
export function withGeoWorkerWarnings(readiness, worker) {
  if (!readiness || readiness.enabled === false || !worker?.status) return readiness;
  const status = worker.status();
  const added = [
    ...(status?.missing?.length ? ["geo_worker_loop_missing"] : []),
    ...(status?.failing?.length ? ["geo_worker_loop_failing"] : []),
    ...(status?.stalled?.length ? ["geo_worker_loop_stalled"] : []),
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

export class GeoWorker {
  /**
   * @param {{ loops: Record<string, (() => Promise<unknown>) | null | undefined>, pollMs?: number, leaseMs?: number,
   *   timeZone?: string, canRun?: () => boolean, now?: () => Date, report?: (loop: string, code: string) => void,
   *   claimDay?: ((loop: string, day: string) => Promise<boolean>) | null,
   *   lease?: ((loop: string, work: () => Promise<unknown>) => Promise<{ acquired: boolean, value?: unknown }>) | null,
   *   cadence?: Record<string, { every?: number, daily?: number }> }} dependencies
   *   `loops` maps a loop name of {@link GEO_WORKER_LOOPS} to the function it runs; `cadence` overrides a loop's cadence (tests).
   */
  constructor({ loops, pollMs = 5_000, leaseMs = 600_000, timeZone = "Asia/Shanghai", canRun = () => true, now = () => new Date(),
    report = () => {}, claimDay = null, lease = null, cadence = {} }) {
    if (!loops || typeof loops !== "object") throw new TypeError("The GEO worker needs its loops.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 3_600_000) throw new TypeError("Invalid GEO worker poll interval.");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 86_400_000) throw new TypeError("Invalid GEO worker lease.");
    for (const name of Object.keys(loops)) {
      if (!GEO_WORKER_LOOPS.some((loop) => loop.name === name)) throw new TypeError(`Unknown GEO worker loop: ${name}.`);
      if (loops[name] != null && typeof loops[name] !== "function") throw new TypeError(`The GEO worker loop ${name} must be a function.`);
    }
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.timeZone = timeZone;
    this.canRun = canRun;
    this.now = now;
    this.report = report;
    this.claimDay = claimDay;
    this.lease = lease;
    /** @type {Array<{ name: string, package: string, every?: number, daily?: number, leased?: boolean, run: (() => Promise<unknown>) | null }>} */
    this.table = GEO_WORKER_LOOPS.map((loop) => ({ ...loop, ...(cadence[loop.name] ?? {}), run: loops[loop.name] ?? null }));
    /** @type {ReturnType<typeof setInterval> | null} cleared by the maintenance pause */
    this.timer = null;
    this.closed = false;
    /** @type {Record<string, Promise<unknown> | null>} */
    this.running = Object.fromEntries(this.table.map((loop) => [loop.name, null]));
    /** @type {Record<string, { startedAt: number | null, lastRunAt: string | null, lastOkAt: string | null, lastError: string | null,
     *   runs: number, failures: number, last: Record<string, unknown> | null }>} */
    this.loops = Object.fromEntries(this.table.map((loop) => [loop.name, {
      startedAt: null, lastRunAt: null, lastOkAt: null, lastError: null, runs: 0, failures: 0, last: null,
    }]));
    /** When each `every` loop last started (epoch ms); 0 = due now. */
    this.lastStarted = Object.fromEntries(this.table.map((loop) => [loop.name, 0]));
    /** The local day each `daily` loop last ran (in memory; `claimDay` makes it durable). */
    /** @type {Record<string, string | null>} */
    this.lastDay = Object.fromEntries(this.table.map((loop) => [loop.name, null]));
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
   * Whether a daily loop is due now: its hour has come today and today is
   * not yet claimed.
   * @param {{ name: string, daily?: number }} loop
   */
  async #dailyDue(loop) {
    const { day, hour } = zonedDayHour(this.now(), this.timeZone);
    if (hour < Number(loop.daily) || this.lastDay[loop.name] === day) return false;
    if (this.claimDay) {
      let claimed = false;
      try { claimed = await this.claimDay(loop.name, day); }
      catch (error) { this.loops[loop.name].lastError = codeOf(error); this.report(loop.name, codeOf(error)); return false; }
      // Claimed elsewhere (another process, or before a restart): done for today here too.
      this.lastDay[loop.name] = day;
      return claimed;
    }
    this.lastDay[loop.name] = day;
    return true;
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
      if (loop.daily != null) {
        if (!(await this.#dailyDue(loop))) continue;
      } else {
        const every = Number(loop.every ?? 0);
        if (every > 0 && this.lastStarted[loop.name] && at - this.lastStarted[loop.name] < every) continue;
      }
      if (!this.canRun() || this.closed) break;
      this.lastStarted[loop.name] = at;
      started.push(this.#run(loop.name, this.#work(loop)));
    }
    return Promise.all(started);
  }

  /** Run one loop now, whatever its cadence (an operator's 「同步目录」, a test). @param {string} name */
  async runNow(name) {
    const loop = this.table.find((entry) => entry.name === name);
    if (!loop?.run) return null;
    return this.#run(name, this.#work(loop));
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
        lastRunAt: state.lastRunAt, lastOkAt: state.lastOkAt, lastError: state.lastError, runs: state.runs, failures: state.failures,
        last: state.last,
      }];
    }));
    return {
      running: Object.values(this.running).some(Boolean),
      armed: Boolean(this.timer),
      lastError: this.lastError,
      missing: this.table.filter((loop) => !loop.run).map((loop) => loop.name),
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
