/**
 * The IM module's worker: one loop that handles what arrived, moves the
 * tracked tasks forward and sends the pushes that are due.
 *
 * Every piece of work it takes is leased in PostgreSQL (`channels/store.mjs`):
 * an inbound message, a task, a push. A second control-plane process running
 * the same loop takes different rows, and a process that dies mid-step leaves
 * rows another picks up when the lease runs out — the durable half of dsh-im's
 * "timeout resend", which in a single local host could live in memory and
 * here cannot.
 *
 * The long connections are not leased: Feishu delivers each event to one
 * client of an app in cluster mode, so every process may hold one, and the
 * durable inbound row is what makes that correct.
 *
 * @module imWorker
 */

/** Connections, pending-approval bots and sweeps: once a minute. */
const SLOW_TICK_MS = 60_000;
/** Pushes a crash may have dropped are re-derived every five minutes. */
const RECONCILE_MS = 5 * 60_000;

export class ImWorker {
  /**
   * @param {{ service: any, pollMs?: number, now?: () => number,
   *   write?: (line: string) => void }} input
   */
  constructor({ service, pollMs = 2_000, now = Date.now, write = (line) => { process.stderr.write(line); } }) {
    this.service = service;
    this.pollMs = Math.max(250, Number(pollMs) || 2_000);
    this.now = now;
    this.write = write;
    /** Named `timer` like every other worker, so the server's pause clears it. */
    this.timer = null;
    /** @type {Promise<void> | null} */
    this.running = null;
    this.lastSlow = 0;
    this.lastReconcile = 0;
    this.again = false;
    this.lastError = null;
    // New work (an inbound message, a dispatched run, a queued push) wakes the
    // loop instead of waiting for the next tick.
    service.wake = () => this.nudge();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  nudge() {
    if (!this.timer) return;
    if (this.running) this.again = true;
    else setImmediate(() => { void this.tick(); });
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.#run()
      .catch((/** @type {any} */ error) => {
        this.lastError = typeof error?.code === "string" ? error.code : "im_worker_failed";
        this.write(`im worker tick failed: ${this.lastError}\n`);
      })
      .finally(() => {
        this.running = null;
        if (this.again && this.timer) {
          this.again = false;
          setImmediate(() => { void this.tick(); });
        }
      });
    return this.running;
  }

  async #run() {
    const now = this.now();
    if (now - this.lastSlow >= SLOW_TICK_MS) {
      this.lastSlow = now;
      await this.#step("connections", () => this.service.syncConnections());
      await this.#step("bots", () => this.service.refreshPendingBots());
      await this.#step("prune", () => this.service.prune());
    }
    // Each queue is isolated: a failing push must not stop a reply.
    await this.#step("inbound", () => this.service.processInbound());
    await this.#step("tasks", () => this.service.processTasks());
    await this.#step("deliveries", () => this.service.processDeliveries());
    if (now - this.lastReconcile >= RECONCILE_MS) {
      this.lastReconcile = now;
      await this.#step("reconcile", () => this.service.reconcilePushes());
    }
  }

  /** @param {string} name @param {() => Promise<unknown>} step */
  async #step(name, step) {
    try {
      await step();
    } catch (/** @type {any} */ error) {
      this.lastError = `${name}:${typeof error?.code === "string" ? error.code : "failed"}`;
      this.service.count?.(`worker_${name}_failed`);
      this.write(`im worker ${name} failed: ${this.lastError}\n`);
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
    await this.service.close();
  }
}
