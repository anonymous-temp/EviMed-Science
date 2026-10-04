import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ENGINE_INPUT_CODES, METHOD_REFUSAL_CODES } from "@evimed/domain/method-records";
import { HttpError } from "./security.mjs";

/** Durable jobs retain ownership across control-plane restarts. The engine's
 * stable job identity joins or recovers the existing calculation. */
export class ResultReplayWorker {
  /** @param {{service:any,jobs:any,engine:any,config:any,report?:(code:string)=>void,admission?:(client:any)=>Promise<boolean>}} dependencies */
  constructor({ service, jobs, engine, config, report = () => {}, admission = async () => true }) {
    this.service = service; this.jobs = jobs; this.engine = engine; this.config = config; this.report = report; this.admission = admission;
    this.workerId = `result-replay-${randomUUID()}`; this.timer = null; this.running = null; this.abort = null;
  }
  start() { if (!this.timer) { this.timer = setInterval(() => void this.tick(), 2000); this.timer.unref?.(); void this.tick(); } }
  async close() { clearInterval(this.timer); this.timer = null; this.abort?.abort(); await this.running; }
  async tick() {
    if (this.running) return this.running;
    this.running = this.process().catch(error => this.report(error.code ?? "result_replay_failed")).finally(() => { this.running = null; });
    return this.running;
  }
  async process() {
    await this.service.reconcileTerminatedAttempts();
    const job = await this.jobs.claim(["result-replay"], this.workerId, { leaseMs: 60000, admission: this.admission });
    if (!job) return;
    const abort = new AbortController(); this.abort = abort;
    const deadline = Date.now() + (this.config.resultReplayTimeoutMs ?? 300000);
    let prepared;
    try {
      prepared = await this.service.prepare(job);
      let answer = await this.service.start(job, prepared, { signal: abort.signal });
      for (;;) {
        if (answer.state === "succeeded") { await this.service.complete(job, prepared, answer); return; }
        if (["failed", "canceled", "timed_out", "ownership_unknown"].includes(answer.state)) {
          // An engine that declined this calculation names why, in the closed vocabulary of the method records (and the
          // two codes for an input it cannot read): that is what the researcher can correct. Any other code it sent stays
          // "failed" — nothing else it said is repeated.
          const declined = answer.state === "failed" && typeof answer.error === "string"
            && (METHOD_REFUSAL_CODES.has(answer.error) || ENGINE_INPUT_CODES.has(answer.error)) ? answer.error : null;
          throw new HttpError(409, answer.state === "ownership_unknown" ? "result_replay_stop_unconfirmed" : declined ?? "result_replay_failed", "The calculation did not finish.");
        }
        if (Date.now() >= deadline) throw new HttpError(504, "result_replay_timeout", "The calculation exceeded its time allowance.");
        if (!await this.jobs.renew(job.userId, job.id, job.leaseToken, 60000)) throw new HttpError(409, "product_job_lease_lost", "The worker no longer owns this calculation.");
        await delay(1000, undefined, { signal: abort.signal });
        answer = await this.engine.status(prepared.execution, { signal: abort.signal });
      }
    } catch (error) {
      if (error.code !== "product_job_lease_lost") await this.service.stop(job, prepared);
      if (error.code !== "product_job_lease_lost") await this.jobs.fail(job.userId, job.id, job.leaseToken,
        { code: error.code ?? "result_replay_failed", message: "The calculation did not finish." }, { retry: false });
    } finally { if (this.abort === abort) this.abort = null; }
  }
}
