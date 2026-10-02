import { randomUUID } from 'node:crypto';
/** Single dispatch is persisted before the privileged call; uncertain work is recovered, never retried. */
export class ExtensionOperationWorker {
  /** @param {{service:any,pollMs?:number}} options */
  constructor({
    service,
    pollMs = 1000
  }) {
    this.service = service;
    this.pollMs = pollMs;
    this.workerId = 'extension-execute-' + randomUUID();
    this.running = null;
    this.timer = null;
    this.active = new Map();
    this.lastError = null;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    this.timer = null;
    for (const active of this.active.values()) active.abort.abort();
    await this.running;
    return this.active.size === 0 && !(await this.service.hasUnjoined());
  }
  async tick() {
    if (this.running) return this.running;
    this.running = this.run().catch(error => {
      this.lastError = error?.code ?? 'product_state_unavailable';
      return null;
    }).finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async run() {
    await this.service.recover();
    const job = await this.service.claim(this.workerId);
    if (!job) return null;
    const abort = new AbortController();
    let timer = null;
    try {
      const identity = await this.service.markDispatch(job);
      this.active.set(job.id, {
        abort,
        identity
      });
      timer = setInterval(() => {
        void this.service.jobs.renew(job.userId, job.id, job.leaseToken, this.service.leaseMs).then(ok => {
          if (!ok) abort.abort();
        }).catch(() => abort.abort());
      }, Math.floor(this.service.leaseMs / 3));
      timer.unref();
      const result = await this.service.controller.execute({
        descriptorId: job.payload.scope.descriptorId,
        operationId: job.payload.operationId,
        request: job.payload.request,
        identity
      }, {
        signal: abort.signal
      });
      await this.service.complete(job, result);
      return job.id;
    } catch (error) {
      if (job.payload.dispatch) {
        await this.service.retain(job, error);
        return null;
      }
      try {
        await this.service.jobs.fail(job.userId, job.id, job.leaseToken, {
          code: error?.code ?? 'extension_access_denied',
          message: 'The extension operation was refused.'
        }, {
          retry: false
        });
        await this.service.grants.remove(job.payload.operationId);
      } catch {
        await this.service.retain(job, error);
      }
      return null;
    } finally {
      clearInterval(timer);
      this.active.delete(job.id);
    }
  }
}
