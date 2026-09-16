import { randomUUID } from "node:crypto";

/** Retrying a job whose input the index will refuse again only burns attempts:
 *  an unusable job payload, and a fact whose id, kind or revision cannot become
 *  a path, are decided before any request. */
export const TERMINAL_INDEX_FAILURES = ["memory_index_job_invalid", "memory_id_invalid"];

/**
 * How a failed `memory-index` job goes back to the queue.
 *
 * Exported because this worker is not the only claimer. `ProductJobs.claim`
 * selects by kind with no user filter, so the operator rebuild command claims
 * jobs this worker enqueued for accounts nobody named on its command line — and
 * a second policy over there would decide, on its own terms, the fate of a job
 * it did not create. One function, so a job's retries do not depend on which
 * process happened to pick it up.
 *
 * @param {string} code @param {number} attempts
 * @returns {{retry:boolean,delayMs:number}}
 */
export function memoryIndexFailurePolicy(code, attempts) {
  const terminal = TERMINAL_INDEX_FAILURES.includes(code);
  return {
    retry: !terminal,
    delayMs: terminal ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(Number(attempts) || 0, 6)),
  };
}

/** Durable ProductJobs drive indexing; timers only wake the next lease claim.
 *
 * Two producers, one worker. `memory-index` republishes a capsule's approved
 * facts; `memory-record-index` carries one research-memory record. They share a
 * worker because they share an index, a lease policy and a retry policy, and
 * because a second worker would be a second thing to compose, configure and
 * forget to compose — which is how the record half came to have no writer at
 * all while the capsule half had one.
 */
export class MemoryIndexWorker {
  /** @param {{jobs:any,indexing:any,substrate?:any,pollMs?:number,leaseMs?:number,reconcileMs?:number}} dependencies */
  constructor({ jobs, indexing, substrate = null, pollMs = 1000, leaseMs = 300_000, reconcileMs = 300_000 }) {
    /** @type {[string,number,number][]} */
    const intervals = [["poll", pollMs, 100], ["lease", leaseMs, 1000], ["reconcile", reconcileMs, 1000]];
    for (const [name, value, minimum] of intervals) {
      if (!Number.isSafeInteger(value) || value < minimum || value > 86_400_000) {
        throw new TypeError(`Invalid memory index ${name} interval.`);
      }
    }
    this.jobs = jobs;
    this.indexing = indexing;
    this.substrate = substrate;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.reconcileMs = reconcileMs;
    // Claim only what this worker can run. Without a substrate the record half
    // is not composed, and claiming its jobs would lease work nothing here can
    // do — worse than leaving them queued, which at least stays visible.
    // No indexing at all is a third state, and it is the deployment's normal
    // one: `MEMORY_INDEX_PROVIDER=builtin` composes no index, so nothing was
    // constructed to claim these jobs — while the database trigger that
    // enqueues them fires on every capsule and fact write regardless, because a
    // Postgres trigger cannot read a Node config. Two had been sitting queued
    // since 2026-09-15 with no claimer and no signal (2026-09-16 review, M5).
    //
    // Draining beats both leaving them and never enqueuing them: the job rows
    // record why they were closed, and the index a `builtin` deployment does
    // not have is fully rebuildable from PostgreSQL anyway
    // (`pnpm rebuild:memory-index --all`), so nothing is lost if a provider is
    // configured later.
    this.draining = !indexing;
    this.kinds = (substrate || this.draining) ? ["memory-index", "memory-record-index"] : ["memory-index"];
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
      const result = this.draining
        ? await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: "no_index_provider" })
        : job.kind === "memory-record-index"
          ? await this.substrate.indexRecord(job)
          : await this.indexing.rebuild(job);
      this.lastError = null;
      this.lastCompletedAt = new Date().toISOString();
      return result;
    } catch (error) {
      this.lastError = typeof error?.code === "string" ? error.code : "memory_index_failed";
      if (!leaseLost && this.lastError !== "product_job_lease_lost") {
        try {
          await this.jobs.fail(job.userId, job.id, job.leaseToken,
            { code: this.lastError, message: "Memory indexing failed." },
            memoryIndexFailurePolicy(this.lastError, job.attempts));
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
    // Both halves, because both can be left behind by the same outage: the
    // capsule ledger re-arms from what it published, the record half from the
    // jobs its writers enqueued.
    // Nothing to reconcile against when there is no index; draining is the
    // whole of the work.
    this.reconciling = Promise.all([
      this.indexing ? this.indexing.reconcile() : null,
      this.substrate ? this.substrate.reconcileRecords() : null,
    ]).catch((error) => {
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
