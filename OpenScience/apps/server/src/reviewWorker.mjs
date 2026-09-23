/**
 * The reply-check worker: one timer that claims queued reply checks (L1) and
 * runs them, never two ticks at once.
 *
 * Hidden knowledge: a reply check is work after the fact — the answer has been
 * shown, and nothing waits on this. So it is a leased queue in the review
 * schema (`reply_checks`, `FOR UPDATE SKIP LOCKED`), claimed a few at a time,
 * paused with the rest of the recurring work during maintenance, and a claim
 * whose worker died is released by lease expiry at the next start.
 *
 * @module reviewWorker
 */

import { randomUUID } from "node:crypto";

export class ReviewWorker {
  /**
   * @param {{ service: any, pollMs?: number, canRun?: () => boolean, report?: (code: string) => void, now?: () => Date }} deps
   */
  constructor({ service, pollMs = 3_000, canRun = () => true, report = () => {}, now = () => new Date() }) {
    this.service = service;
    this.pollMs = pollMs;
    this.canRun = canRun;
    this.report = report;
    this.now = now;
    this.workerId = `review-${randomUUID().slice(0, 12)}`;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {Promise<unknown> | null} */
    this.running = null;
    this.closed = false;
    this.state = { runs: 0, processed: 0, failures: 0, /** @type {string | null} */ lastError: null, /** @type {string | null} */ lastRunAt: null, startedAt: /** @type {number | null} */ (null) };
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
        const processed = await this.service.processReplyChecks(this.workerId);
        this.state.processed += processed;
        this.state.lastError = null;
        return processed;
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : "review_worker_failed";
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
      processed: this.state.processed,
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
