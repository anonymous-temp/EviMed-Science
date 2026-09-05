import { randomUUID } from "node:crypto";

/** Durable ProductJobs drive indexing; timers only wake the next lease claim. */
export class MemoryIndexWorker {
  /** @param {{jobs:any,indexing:any,pollMs?:number,leaseMs?:number,reconcileMs?:number}} dependencies */
  constructor({ jobs, indexing, pollMs = 1000, leaseMs = 300_000, reconcileMs = 300_000 }) {
    /** @type {[string,number,number][]} */
    const intervals = [["poll", pollMs, 100], ["lease", leaseMs, 1000], ["reconcile", reconcileMs, 1000]];
    for (const [name, value, minimum] of intervals) {
      if (!Number.isSafeInteger(value) || value < minimum || value > 86_400_000) {
        throw new TypeError(`Invalid memory index ${name} interval.`);
      }
    }
    this.jobs = jobs;
    this.indexing = indexing;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.reconcileMs = reconcileMs;
    this.workerId = `memory-index-${randomUUID()}`;
    this.timer = null;
    this.reconcileTimer = null;
    this.running = null;
    this.reconciling = null;
    this.lastError = null;
    this.lastCompletedAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.pollMs);
    this.reconcileTimer = setInterval(() => { void this.reconcile(); }, this.reconcileMs);
    this.timer.unref();
    this.reconcileTimer.unref();
    void this.tick().catch(() => {});
    void this.reconcile();
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.#tick().catch((error) => {
      this.lastError = typeof error?.code === "string" ? error.code : "memory_index_worker_failed";
      return null;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async #tick() {
    const job = await this.jobs.claim(["memory-index"], this.workerId, { leaseMs: this.leaseMs });
    if (!job) return null;
    let leaseLost = false;
    const renewal = setInterval(() => {
      void this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
        .then((renewed) => { if (!renewed) leaseLost = true; })
        .catch(() => { leaseLost = true; });
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    try {
      const result = await this.indexing.rebuild(job);
      this.lastError = null;
      this.lastCompletedAt = new Date().toISOString();
      return result;
    } catch (error) {
      this.lastError = typeof error?.code === "string" ? error.code : "memory_index_failed";
      if (!leaseLost && this.lastError !== "product_job_lease_lost") {
        const terminal = ["memory_index_job_invalid", "mem_os_payload_invalid"].includes(this.lastError);
        try {
          await this.jobs.fail(job.userId, job.id, job.leaseToken,
            { code: this.lastError, message: "Memory indexing failed." },
            { retry: !terminal, delayMs: terminal ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)) });
        } catch (failure) {
          if (failure?.code !== "product_job_lease_lost") throw failure;
        }
      }
      return null;
    } finally {
      clearInterval(renewal);
    }
  }

  async reconcile() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.indexing.reconcile().catch((error) => {
      this.lastError = typeof error?.code === "string" ? error.code : "memory_index_reconcile_failed";
      return null;
    }).finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  status() {
    return { running: Boolean(this.running), lastError: this.lastError, lastCompletedAt: this.lastCompletedAt };
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null;
    this.reconcileTimer = null;
    await Promise.all([this.running, this.reconciling].filter(Boolean));
  }
}
