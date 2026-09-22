/**
 * The frontier feed's editorial loops (「前沿动态」 编, plan §6.4, §10.3.1
 * steps 11–15, §10.5.5), ticked by the worker's compose hook.
 *
 * The worker calls `tick()` on every one of its own ticks (every few seconds);
 * this module decides which of its loops are due and runs them:
 *
 *   cluster   every 30 s   newly published items into events
 *   hot       every 10 min the hot list: heat, counts, snapshot, hot_version
 *   digests   every 2 min  owed event digests (at most three a round)
 *   daily     every minute today's issue once the daily time has passed
 *   push      every minute today's issue to readers whose digest time passed
 *   profiles  every 5 min  readers' profiles (a day old) and rankings (6 h old)
 *
 * Hidden knowledge:
 *
 * - **One timer, the worker's.** The maintenance pause stops recurring work by
 *   clearing each worker's timer; a timer here would be a loop maintenance
 *   could not stop. The worker never overlaps two ticks of this module, and a
 *   maintenance window waits for a running tick (`inspectActivity` reads the
 *   worker's `running`, which includes this).
 * - **Loops are ordered where one reads another.** The digests read the hot
 *   list, which reads the events clustering just made, so those three run in
 *   that order in one tick; the daily, the push and the profiles run beside
 *   them. The push follows the daily, so the minute an issue is written is
 *   the minute the first readers are told.
 * - **Each loop is bounded and fails alone.** A loop that fails is recorded
 *   with its named code and tried at its next due time; the others go on. The
 *   tick then reports the first failure to the worker (whose compose loop
 *   records it too), so a failure is never invisible.
 * - **A missing daily is said once.** From a quarter past the daily time, a
 *   day without its issue is reported on the worker's report line once per
 *   day, and stays visible in the status and the metrics (plan §10.5.8:
 *   「07:45 仍未生成」).
 *
 * @module frontierComposer
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** How often each loop runs (plan §6.4: the hot list every ten minutes). */
export const FRONTIER_COMPOSER_CADENCES = Object.freeze({
  cluster: 30 * SECOND,
  hot: 10 * MINUTE,
  digests: 2 * MINUTE,
  daily: MINUTE,
  push: MINUTE,
  profiles: 5 * MINUTE,
});
const LOOPS = Object.freeze(Object.keys(FRONTIER_COMPOSER_CADENCES));

/** @param {unknown} error */
function codeOf(error) {
  const value = /** @type {any} */ (error);
  return typeof value?.code === "string" && /^[a-z0-9_]{2,80}$/.test(value.code) ? value.code : "frontier_composer_failed";
}

export class FrontierComposer {
  /**
   * @param {{ events?: any, daily?: any, profiles?: any, canRun?: () => boolean, now?: () => Date,
   *           report?: (loop: string, code: string) => void, cadences?: Partial<Record<string, number>> }} dependencies
   *   `events` a `FrontierEvents`, `daily` a `FrontierDaily`, `profiles` a
   *   `FrontierProfiles`; each optional — an absent one's loops never run.
   */
  constructor({ events = null, daily = null, profiles = null, canRun = () => true, now = () => new Date(), report = () => {}, cadences = {} } = {}) {
    this.events = events;
    this.daily = daily;
    this.profiles = profiles;
    this.canRun = canRun;
    this.now = now;
    this.report = report;
    /** @type {Record<string, number>} */
    this.cadences = { ...FRONTIER_COMPOSER_CADENCES, ...cadences };
    /** @type {Record<string, { lastStarted: number, lastRunAt: string | null, lastOkAt: string | null, lastError: string | null, runs: number, failures: number, last: any }>} */
    this.loops = Object.fromEntries(LOOPS.map((loop) => [loop, { lastStarted: 0, lastRunAt: null, lastOkAt: null, lastError: null, runs: 0, failures: 0, last: null }]));
    /** The day a missing issue was last reported, so it is said once. @type {string | null} */
    this.missingReported = null;
  }

  /** @param {string} loop */
  #due(loop) {
    const state = this.loops[loop];
    return !state.lastStarted || this.now().getTime() - state.lastStarted >= this.cadences[loop];
  }

  /**
   * Run one loop and record how it ended; a failure is returned, not thrown,
   * so the loops beside it run.
   * @param {string} loop @param {() => Promise<unknown>} work
   * @returns {Promise<unknown | null>} the failure, or null
   */
  async #run(loop, work) {
    const state = this.loops[loop];
    if (!this.canRun()) return null;
    state.lastStarted = this.now().getTime();
    state.lastRunAt = new Date(state.lastStarted).toISOString();
    state.runs += 1;
    try {
      state.last = await work();
      state.lastError = null;
      state.lastOkAt = this.now().toISOString();
      return null;
    } catch (error) {
      state.lastError = codeOf(error);
      state.failures += 1;
      this.report(loop, state.lastError);
      return error;
    }
  }

  /**
   * Run every loop that is due. Resolves when they have all ended; rejects
   * with the first failure after that, so the worker sees it.
   */
  async tick() {
    if (!this.canRun()) return [];
    /** @type {Promise<unknown | null>[]} */
    const chains = [];
    const editorial = async () => {
      /** @type {unknown[]} */
      const failures = [];
      if (this.events && this.#due("cluster")) failures.push(await this.#run("cluster", () => this.events.clusterPending()));
      if (this.events && this.#due("hot")) failures.push(await this.#run("hot", () => this.events.computeHot()));
      if (this.events && this.#due("digests")) failures.push(await this.#run("digests", () => this.events.writeDigests()));
      return failures.find(Boolean) ?? null;
    };
    const issue = async () => {
      /** @type {unknown[]} */
      const failures = [];
      if (this.daily && this.#due("daily")) {
        failures.push(await this.#run("daily", () => this.daily.runDue()));
        this.#reportMissing();
      }
      if (this.daily && this.#due("push")) failures.push(await this.#run("push", () => this.daily.pushDue()));
      return failures.find(Boolean) ?? null;
    };
    chains.push(editorial(), issue());
    if (this.profiles && this.#due("profiles")) chains.push(this.#run("profiles", () => this.profiles.refreshDue()));
    const failures = await Promise.all(chains);
    const failure = failures.find(Boolean);
    if (failure) throw failure;
    return failures;
  }

  /** A day without its issue past the alert time, reported once that day. */
  #reportMissing() {
    const state = this.daily?.state;
    if (state?.missing && state.day && this.missingReported !== state.day) {
      this.missingReported = state.day;
      this.report("daily", "frontier_daily_missing");
    }
  }

  status() {
    const at = this.now().getTime();
    return {
      loops: Object.fromEntries(Object.entries(this.loops).map(([loop, state]) => [loop, {
        lastRunAt: state.lastRunAt, lastOkAt: state.lastOkAt, lastError: state.lastError, runs: state.runs, failures: state.failures,
        dueInMs: state.lastStarted ? Math.max(0, state.lastStarted + this.cadences[loop] - at) : 0,
      }])),
      events: this.events?.status?.() ?? null,
      daily: this.daily?.status?.() ?? null,
      profiles: this.profiles?.status?.() ?? null,
    };
  }
}
