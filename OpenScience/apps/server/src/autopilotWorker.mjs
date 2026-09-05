import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["autopilot_job_invalid", "autopilot_stopped", "autopilot_episode_state_conflict"]);

/** Leased launcher for proactive episodes. The callback is the ordinary
 * AgentRun dispatch path; this class only owns restart-safe queue semantics. */
export class AutopilotWorker {
  /** @param {{jobs:any,service:any,dispatchEpisode:(input:any)=>Promise<{runId:string,sessionId:string}>,pollMs?:number,leaseMs?:number}} dependencies */
  constructor({ jobs, service, dispatchEpisode, pollMs = 1000, leaseMs = 300_000 }) {
    if (!jobs || !service || typeof dispatchEpisode !== "function") throw new TypeError("AutopilotWorker dependencies are required.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 86_400_000
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000) throw new TypeError("Invalid autopilot worker interval.");
    this.jobs = jobs;
    this.service = service;
    this.dispatchEpisode = dispatchEpisode;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.workerId = `autopilot-${randomUUID()}`;
    this.timer = null;
    this.running = null;
    this.lastError = null;
    this.lastCompletedAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref();
    void this.tick();
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.#tick().catch((error) => {
      this.lastError = typeof error?.code === "string" ? error.code : "autopilot_worker_failed";
      return null;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async #tick() {
    const job = await this.jobs.claim(["episode"], this.workerId, { leaseMs: this.leaseMs });
    if (!job) return null;
    let leaseLost = false;
    const renewal = setInterval(() => {
      void this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
        .then((renewed) => { if (!renewed) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    try {
      const agenda = await this.service.get(job.userId, job.payload?.agendaId);
      const episode = await this.service.getEpisode(job.userId, job.payload?.episodeId);
      if (!agenda.payload.enabled || agenda.payload.status !== "active" || episode.payload.status !== "queued") {
        return await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: true, reason: "agenda_inactive" });
      }
      const dispatched = await this.dispatchEpisode({ ...job.payload, userId: job.userId, projectId: job.projectId, dispatchId: episode.id });
      await this.service.markEpisodeDispatched(job.userId, episode.id, dispatched);
      await this.jobs.finish(job.userId, job.id, job.leaseToken, { episodeId: episode.id, ...dispatched });
      this.lastError = null;
      this.lastCompletedAt = new Date().toISOString();
      return dispatched;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "autopilot_dispatch_failed";
      this.lastError = code;
      if (job.payload?.episodeId) await this.service.markEpisodeFailed(job.userId, job.payload.episodeId, { code }).catch(() => {});
      if (!leaseLost && code !== "product_job_lease_lost") {
        try {
          await this.jobs.fail(job.userId, job.id, job.leaseToken, { code, message: "Proactive research dispatch failed." }, {
            retry: !TERMINAL.has(code), delayMs: TERMINAL.has(code) ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)),
          });
        } catch (failure) { if (failure?.code !== "product_job_lease_lost") throw failure; }
      }
      return null;
    } finally { clearInterval(renewal); }
  }

  status() { return { running: Boolean(this.running), lastError: this.lastError, lastCompletedAt: this.lastCompletedAt }; }
  async close() { if (this.timer) clearInterval(this.timer); this.timer = null; await this.running; }
}
