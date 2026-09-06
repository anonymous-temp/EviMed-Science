import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["autopilot_job_invalid", "autopilot_stopped", "autopilot_episode_state_conflict",
  "runtime_prompt_acceptance_unknown", "runtime_prompt_rejected"]);

/** Leased launcher for proactive episodes. The callback is the ordinary
 * AgentRun dispatch path; this class only owns restart-safe queue semantics. */
export class AutopilotWorker {
  /** @param {{jobs:any,service:any,dispatchEpisode:(input:any)=>Promise<{runId:string,sessionId:string}>,cancelDispatched?:(input:any)=>Promise<void>,pollMs?:number,leaseMs?:number,reconcileMs?:number,busyDelayMs?:number}} dependencies */
  constructor({ jobs, service, dispatchEpisode, cancelDispatched = async () => {}, pollMs = 1000, leaseMs = 300_000,
    reconcileMs = 60_000, busyDelayMs = 31 * 60_000 }) {
    if (!jobs || !service || typeof dispatchEpisode !== "function") throw new TypeError("AutopilotWorker dependencies are required.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 86_400_000
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000
      || !Number.isSafeInteger(reconcileMs) || reconcileMs < 1000 || reconcileMs > 86_400_000
      || !Number.isSafeInteger(busyDelayMs) || busyDelayMs < 1000 || busyDelayMs > 86_400_000) throw new TypeError("Invalid autopilot worker interval.");
    this.jobs = jobs;
    this.service = service;
    this.dispatchEpisode = dispatchEpisode;
    this.cancelDispatched = cancelDispatched;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.reconcileMs = reconcileMs;
    this.busyDelayMs = busyDelayMs;
    this.workerId = `autopilot-${randomUUID()}`;
    this.timer = null;
    this.reconcileTimer = null;
    this.running = null;
    this.lastError = null;
    this.lastCompletedAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.reconcileTimer = setInterval(() => { void this.service.reconcileStopWork?.().catch(() => {}); }, this.reconcileMs);
    this.timer.unref();
    this.reconcileTimer.unref();
    void this.service.reconcileStopWork?.().catch(() => {});
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
    let dispatched = null;
    try {
      if (job.payload?.action === "cancel") {
        await this.cancelDispatched({ userId: job.userId, projectId: job.projectId, episodeId: job.payload.episodeId,
          sessionId: job.payload.sessionId, runId: job.payload.runId });
        await this.service.markCancellationCompleted(job.userId, job.payload.episodeId, job.payload.runId);
        const finished = await this.jobs.finish(job.userId, job.id, job.leaseToken, {
          episodeId: job.payload.episodeId, canceled: true,
        });
        this.lastError = null;
        this.lastCompletedAt = new Date().toISOString();
        return finished;
      }
      const agenda = await this.service.get(job.userId, job.payload?.agendaId);
      const episode = await this.service.getEpisode(job.userId, job.payload?.episodeId);
      if (!agenda.payload.enabled || agenda.payload.status !== "active" || !["queued", "failed"].includes(episode.payload.status)) {
        return await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: true, reason: "agenda_inactive" });
      }
      if (leaseLost || !(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) {
        const error = /** @type {Error & {code:string}} */ (Object.assign(new Error("Autopilot job lease was lost before dispatch."), { code: "product_job_lease_lost" })); throw error;
      }
      const currentAgenda = await this.service.checkInactivity(job.userId, job.payload?.agendaId);
      if (!currentAgenda.payload.enabled || currentAgenda.payload.status !== "active") {
        return await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: true, reason: "agenda_inactive" });
      }
      const activityLeaseRenewed = leaseLost ? false : await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs);
      if (leaseLost || !activityLeaseRenewed) {
        const error = /** @type {Error & {code:string}} */ (Object.assign(new Error("Autopilot job lease was lost during the activity check."), { code: "product_job_lease_lost" })); throw error;
      }
      dispatched = await this.dispatchEpisode({ ...job.payload, userId: job.userId, projectId: job.projectId, dispatchId: episode.id });
      if (leaseLost || !(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) {
        const error = /** @type {Error & {code:string}} */ (Object.assign(new Error("Autopilot job lease was lost after dispatch."), { code: "product_job_lease_lost" })); throw error;
      }
      await this.jobs.finish(job.userId, job.id, job.leaseToken, { episodeId: episode.id, ...dispatched });
      this.lastError = null;
      this.lastCompletedAt = new Date().toISOString();
      return dispatched;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "autopilot_dispatch_failed";
      this.lastError = code;
      if (job.payload?.action === "cancel") {
        if (!leaseLost && code !== "product_job_lease_lost") {
          await this.jobs.fail(job.userId, job.id, job.leaseToken, { code, message: "Proactive research cancellation failed." }, {
            retry: true, delayMs: Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)),
          }).catch((failure) => { if (failure?.code !== "product_job_lease_lost") throw failure; });
        }
      } else if (dispatched && ["autopilot_stopped", "autopilot_paused", "autopilot_episode_state_conflict"].includes(code)) {
        try {
          await this.service.queueDispatchedCancellation(job.userId, job.payload.episodeId, dispatched);
        } catch (queueError) {
          const queueCode = typeof queueError?.code === "string" ? queueError.code : "autopilot_cancellation_queue_failed";
          if (!leaseLost) await this.jobs.fail(job.userId, job.id, job.leaseToken,
            { code: queueCode, message: "Proactive research cancellation could not be queued." },
            { retry: true, delayMs: Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)) }).catch(() => {});
          return null;
        }
      } else if (job.payload?.episodeId && code !== "product_job_lease_lost") {
        await this.service.markEpisodeFailed(job.userId, job.payload.episodeId, { code }).catch(() => {});
      }
      if (job.payload?.action !== "cancel" && !leaseLost && code !== "product_job_lease_lost") {
        try {
          await this.jobs.fail(job.userId, job.id, job.leaseToken, { code, message: "Proactive research dispatch failed." }, {
            retry: !TERMINAL.has(code), delayMs: TERMINAL.has(code) ? 0
              : code === "runtime_busy" ? this.busyDelayMs : Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)),
          });
        } catch (failure) { if (failure?.code !== "product_job_lease_lost") throw failure; }
      }
      return null;
    } finally { clearInterval(renewal); }
  }

  status() { return { running: Boolean(this.running), lastError: this.lastError, lastCompletedAt: this.lastCompletedAt }; }
  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null;
    this.reconcileTimer = null;
    await this.running;
  }
}
