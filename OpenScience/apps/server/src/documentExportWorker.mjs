import { randomUUID } from 'node:crypto';

/** The shared ProductJobs worker owns leases; the controller owns processes. */
export class DocumentExportWorker {
  /** @param {{service:any,jobs:any,controller:any,admission?:(client:any)=>Promise<boolean>,report?:(code:string)=>void}} options */
  constructor({ service, jobs, controller, admission = async () => true, report = () => {} }) {
    this.service = service; this.jobs = jobs; this.controller = controller; this.admission = admission; this.report = report;
    this.workerId = `document-export-${randomUUID()}`;
    this.timer = null;
    this.running = null;
    this.abort = null;
  }
  start() { if (!this.timer) { this.timer = setInterval(() => void this.tick(), 2000); this.timer.unref?.(); void this.tick(); } }
  async close() { clearInterval(this.timer); this.timer = null; this.abort?.abort(); await this.running; }
  async tick() {
    if (this.running) return this.running;
    this.running = this.process().catch(error => this.report(error.code ?? 'document_export_worker_failed')).finally(() => { this.running = null; });
    return this.running;
  }
  async process() {
    await this.service.reconcileTerminatedAttempts();
    const job = await this.jobs.claim(['document-export'], this.workerId, { leaseMs: 60_000, admission: this.admission });
    if (!job) return;
    const abort = new AbortController();
    this.abort = abort;
    let heartbeatRunning = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      try { if (!await this.jobs.renew(job.userId, job.id, job.leaseToken, 60_000)) abort.abort(); }
      catch { abort.abort(); }
      finally { heartbeatRunning = false; }
    }, 10_000);
    let prepared;
    try {
      prepared = await this.service.prepare(job);
      if (!prepared.recovered) await this.controller.renderDocument(prepared.attempt, { signal: abort.signal });
      await this.service.complete(job, prepared.attempt, prepared.dir);
    } catch (error) {
      let failure = error;
      if (error.code === 'document_render_stop_unconfirmed') throw error;
      // Keep an uncertain physical process represented as running until the
      // controller confirms it is gone; an expired lease is not free memory.
      const waiting = ['document_render_busy','document_render_capacity'].includes(error.code);
      if (prepared) {
        await this.controller.cancelDocumentRender(prepared.attempt);
        try {
          if (await this.service.complete(job, prepared.attempt, prepared.dir, { partialOnly: true })) return;
        } catch (partialError) {
          if (!['ENOENT', 'file_not_found', 'product_job_lease_lost'].includes(partialError.code)) failure = partialError;
        }
        if (waiting) await this.service.refundPreparation(job, prepared.attempt);
        else await this.service.discardAttempt(prepared.attempt);
      }
      if (failure.code !== 'product_job_lease_lost') {
        await this.jobs.fail(job.userId, job.id, job.leaseToken, { code: failure.code ?? 'document_render_failed', message: 'Document conversion did not finish.' },
          { retry: true, refundAttempt: waiting, delayMs: waiting ? 10000 : 5000 }).catch(leaseFailure => { if (leaseFailure.code !== 'product_job_lease_lost') throw leaseFailure; });
      }
    } finally { clearInterval(heartbeat); if (this.abort === abort) this.abort = null; }
  }
}
