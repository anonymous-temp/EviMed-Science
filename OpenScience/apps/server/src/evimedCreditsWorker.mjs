/**
 * The 灵豆 retry worker: one timer that sends the settlements whose next attempt
 * is due, never two ticks at once.
 *
 * Hidden knowledge: a settlement is work after the fact — the run has finished
 * and been delivered, and nothing waits on this. So it is a claimed queue in the
 * credits schema (`FOR UPDATE SKIP LOCKED`, one row per claim), paused with the
 * rest of the recurring work during maintenance, and a claim whose process died
 * comes back when its backoff elapses rather than needing a lease of its own —
 * the claim *is* the backoff push, and the run id keeps the charge idempotent
 * however many processes try.
 *
 * @module evimedCreditsWorker
 */

export class EvimedCreditsWorker {
  /**
   * @param {{ service: any, pollMs?: number, batch?: number, canRun?: () => boolean,
   *   report?: (code: string) => void, now?: () => Date }} deps
   */
  constructor({ service, pollMs = 60_000, batch = 20, canRun = () => true, report = () => {}, now = () => new Date() }) {
    this.service = service;
    this.pollMs = pollMs;
    this.batch = batch;
    this.canRun = canRun;
    this.report = report;
    this.now = now;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {Promise<number> | null} */
    this.running = null;
    this.closed = false;
    this.state = {
      runs: 0, attempted: 0, failures: 0,
      lastError: /** @type {string | null} */ (null),
      lastRunAt: /** @type {string | null} */ (null),
      startedAt: /** @type {number | null} */ (null),
    };
  }

  start() {
    this.closed = false;
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** One tick, unless one is running. Resolves when it has finished. */
  tick() {
    if (this.closed || !this.canRun() || this.running) return this.running ?? Promise.resolve(0);
    this.state.runs += 1;
    this.state.startedAt = this.now().getTime();
    this.state.lastRunAt = new Date(this.state.startedAt).toISOString();
    this.running = (async () => {
      try {
        const attempted = await this.service.retryDue(this.batch);
        this.state.attempted += attempted;
        this.state.lastError = null;
        return attempted;
      } catch (error) {
        const code = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "evimed_credits_worker_failed";
        this.state.failures += 1;
        this.state.lastError = code;
        this.report(code);
        return 0;
      } finally {
        this.state.startedAt = null;
        this.running = null;
      }
    })();
    return this.running;
  }

  status() {
    const at = this.now().getTime();
    return {
      running: Boolean(this.running),
      armed: Boolean(this.timer),
      stalled: this.state.startedAt != null && at - this.state.startedAt > 10 * 60_000,
      runs: this.state.runs,
      attempted: this.state.attempted,
      failures: this.state.failures,
      lastError: this.state.lastError,
      lastRunAt: this.state.lastRunAt,
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch?.(() => {});
  }
}
