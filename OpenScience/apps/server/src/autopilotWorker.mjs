import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["autopilot_job_invalid", "autopilot_stopped", "autopilot_episode_state_conflict",
  "runtime_prompt_acceptance_unknown", "runtime_prompt_rejected"]);
// A verification that cannot be afforded, cannot be routed, or names a claim
// that is no longer there will not become affordable, routable or present by
// being tried again. Retrying it spends the little budget the claim had left on
// the same refusal.
const VERIFICATION_TERMINAL = new Set(["usage_budget_exceeded", "autopilot_job_invalid", "autopilot_stopped",
  "autopilot_paused", "autopilot_claim_not_found", "autopilot_episode_not_found", "autopilot_payload_invalid",
  "autopilot_capability_unavailable", "runtime_prompt_rejected"]);

/** Leased launcher for proactive episodes and for the independent verifications
 * their claims earn. The callbacks are the ordinary AgentRun dispatch path; this
 * class only owns restart-safe queue semantics. */
export class AutopilotWorker {
  /** @param {{jobs:any,service:any,dispatchEpisode:(input:any)=>Promise<{runId:string,sessionId:string}>,dispatchVerification?:((input:any)=>Promise<{runId:string,sessionId:string}>)|null,cancelDispatched?:(input:any)=>Promise<void>,pollMs?:number,leaseMs?:number,reconcileMs?:number,busyDelayMs?:number}} dependencies */
  constructor({ jobs, service, dispatchEpisode, dispatchVerification = null, cancelDispatched = async () => {},
    pollMs = 1000, leaseMs = 300_000, reconcileMs = 60_000, busyDelayMs = 31 * 60_000 }) {
    if (!jobs || !service || typeof dispatchEpisode !== "function") throw new TypeError("AutopilotWorker dependencies are required.");
    if (dispatchVerification !== null && typeof dispatchVerification !== "function") throw new TypeError("AutopilotWorker verification dispatch is invalid.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 86_400_000
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000
      || !Number.isSafeInteger(reconcileMs) || reconcileMs < 1000 || reconcileMs > 86_400_000
      || !Number.isSafeInteger(busyDelayMs) || busyDelayMs < 1000 || busyDelayMs > 86_400_000) throw new TypeError("Invalid autopilot worker interval.");
    this.jobs = jobs;
    this.service = service;
    this.dispatchEpisode = dispatchEpisode;
    this.dispatchVerification = dispatchVerification;
    // A worker with no verifier does not claim verification work: leaving those
    // jobs queued for a worker that can run them is honest, and finishing them
    // as "skipped" would retire the second opinion without ever asking for it.
    this.kinds = dispatchVerification ? ["episode", "verify"] : ["episode"];
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
    const job = await this.jobs.claim(this.kinds, this.workerId, { leaseMs: this.leaseMs });
    if (!job) return null;
    let leaseLost = false;
    const renewal = setInterval(() => {
      void this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
        .then((renewed) => { if (!renewed) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    let dispatched = null;
    // Whether the verification run itself was accepted. Everything after that
    // point -- the lease renewal, the job settlement -- can still fail, and the
    // run is out there either way; telling the claim its verification is
    // unavailable would drop the verdict that run is about to produce.
    let verificationDispatched = false;
    const holdsLease = async () => {
      if (leaseLost || !(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) {
        throw /** @type {Error & {code:string}} */ (Object.assign(new Error("Autopilot job lease was lost."), { code: "product_job_lease_lost" }));
      }
    };
    try {
      if (job.kind === "verify") {
        // The same activity and stop-rule guard the episode itself passed, run
        // again: a direction the researcher parked or a thread that went unread
        // must not keep spending on re-checking last week's claims.
        const agenda = await this.service.checkInactivity(job.userId, job.payload?.agendaId);
        if (!agenda.payload.enabled || agenda.payload.status !== "active") {
          return await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: true, reason: "agenda_inactive" });
        }
        await holdsLease();
        const verification = await this.dispatchVerification({ ...job.payload, userId: job.userId, projectId: job.projectId });
        verificationDispatched = true;
        await holdsLease();
        const finished = await this.jobs.finish(job.userId, job.id, job.leaseToken, {
          verificationId: job.payload?.verificationId, ...verification,
        });
        this.lastError = null;
        this.lastCompletedAt = new Date().toISOString();
        return finished;
      }
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
      } else if (job.kind === "verify") {
        // The claim keeps the tier its own episode's gate gave it. A failed
        // second opinion never promotes and never demotes; it is recorded so the
        // digest can say the re-check did not happen rather than imply it passed.
        const terminal = VERIFICATION_TERMINAL.has(code) || job.attempts >= Number(job.maxAttempts ?? 3);
        if (terminal && !verificationDispatched && code !== "product_job_lease_lost") {
          await this.service.recordVerification(job.userId, {
            episodeId: job.payload?.episodeId, verificationId: job.payload?.verificationId, errorCode: code,
          }).catch(() => {});
        }
        if (!leaseLost && code !== "product_job_lease_lost") {
          await this.jobs.fail(job.userId, job.id, job.leaseToken, { code, message: "Independent claim verification failed." }, {
            retry: !terminal, delayMs: terminal ? 0
              : code === "runtime_busy" ? this.busyDelayMs : Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)),
          }).catch((failure) => { if (failure?.code !== "product_job_lease_lost") throw failure; });
        }
        return null;
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
