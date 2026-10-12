import { randomUUID } from "node:crypto";

/**
 * The leased worker of the knowledge-page compile (`knowledgePageService.runJob`).
 *
 * One job is one round of one project. A round that is not ready — the project is still changing, the runtime is taken, a
 * spending cap is reached, the run is still working — is put back with its attempt refunded and a delay, because none of that
 * is a failure of the round. A round whose run failed or delivered what cannot be read is closed (`recordFailure`) and failed,
 * so the next change asks for a new one; anything else is retried with a backoff until the job's attempts are spent.
 *
 * @module knowledgePageWorker
 */

/** Codes after which the same round would only read the same run again. */
const ROUND_CLOSING = new Set(["knowledge_run_failed", "knowledge_patch_invalid", "knowledge_output_missing", "knowledge_input_too_large", "knowledge_unconfigured"]);

export class KnowledgePageWorker {
  /** @param {{ jobs: any, service: any, pollMs?: number, leaseMs?: number }} dependencies */
  constructor({ jobs, service, pollMs = 5000, leaseMs = 900_000 }) {
    if (!jobs || !service) throw new TypeError("KnowledgePageWorker dependencies are required.");
    this.jobs = jobs; this.service = service; this.pollMs = pollMs; this.leaseMs = leaseMs;
    this.workerId = `knowledge-pages-${randomUUID()}`;
    /** @type {any} */ this.timer = null;
    /** @type {Promise<any> | null} */ this.running = null;
    /** @type {string | null} */ this.lastError = null;
    /** @type {string | null} */ this.lastCompletedAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref();
    void this.tick();
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.#tick().catch((/** @type {any} */ error) => {
      this.lastError = typeof error?.code === "string" ? error.code : "knowledge_worker_failed";
      return null;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async #tick() {
    if (!this.service.enabled) return null;
    const job = await this.jobs.claim(["wiki-compile"], this.workerId, { leaseMs: this.leaseMs });
    if (!job) return null;
    let leaseLost = false;
    let renewing = false;
    const renewNow = async () => {
      if (!(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) {
        leaseLost = true;
        throw Object.assign(new Error("The compile lease was lost."), { code: "product_job_lease_lost" });
      }
    };
    const renewal = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renewNow().catch(() => { leaseLost = true; }).finally(() => { renewing = false; });
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    try {
      const outcome = await this.service.runJob(job, { renew: renewNow });
      if (leaseLost) return null;
      if ("defer" in outcome) {
        await this.jobs.fail(job.userId, job.id, job.leaseToken, { code: outcome.defer.code, message: "The knowledge pages wait." },
          { retry: true, refundAttempt: true, delayMs: outcome.defer.delayMs });
        this.lastError = null;
        return outcome;
      }
      await this.jobs.finish(job.userId, job.id, job.leaseToken, outcome.result);
      this.lastError = null;
      this.lastCompletedAt = new Date().toISOString();
      return outcome;
    } catch (/** @type {any} */ error) {
      const code = typeof error?.code === "string" ? error.code : "knowledge_pages_failed";
      this.lastError = code;
      if (leaseLost || code === "product_job_lease_lost") return null;
      const closing = ROUND_CLOSING.has(code);
      if (closing) await this.service.recordFailure(job, code);
      try {
        await this.jobs.fail(job.userId, job.id, job.leaseToken, { code, message: "The knowledge pages could not be compiled." },
          { retry: !closing, delayMs: closing ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)) });
      } catch (/** @type {any} */ failure) {
        if (failure?.code !== "product_job_lease_lost") throw failure;
      }
      return null;
    } finally {
      clearInterval(renewal);
    }
  }

  status() {
    return { running: Boolean(this.running), lastError: this.lastError, lastCompletedAt: this.lastCompletedAt };
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
