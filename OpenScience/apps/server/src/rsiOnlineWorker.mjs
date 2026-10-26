import { randomUUID } from 'node:crypto';
import { RSI_INCIDENT_TERMINAL_CODES } from './rsiIncidentExports.mjs';
/** The two online queues have one owner and one claimer; experiments never run here. `configured` admits claiming at
 * all (the transport identity a withdrawal needs); the export and import paths check their own full bindings. `sweep`
 * reconciles the journals with the deployment agreement at most once per sweepMs, and its failure never stops the queue.
 * @param {any} dependencies */
export function createRsiOnlineWorker({ jobs, owner, configured, incidents, pollBundles, sweep = null, canRun = async () => true, report = () => {}, pollMs = 15000, leaseMs = 120000, sweepMs = 600000 }) {
  const workerId = `rsi-online-${randomUUID()}`;
  let timer = null, active = null, closed = false, sweptAt = -Infinity;
  const kinds = Object.freeze(['rsi-incident-export', 'rsi-bundle-poll']);
  const notExportable = 'The incident cannot be exported.';
  async function perform() {
    if (closed || !configured() || !await canRun()) return null;
    if (sweep && Date.now() - sweptAt >= sweepMs) {
      sweptAt = Date.now();
      try { await sweep(); } catch { report('rsi_online_sweep_failed'); }
    }
    const job = await jobs.claim([...kinds], workerId, { leaseMs, ownerId: owner, admission: canRun });
    if (!job) return null;
    let lost = false;
    const heartbeat = setInterval(() => { jobs.renew(job.userId, job.id, job.leaseToken, leaseMs).then(ok => { if (!ok) lost = true; }).catch(() => { lost = true; }); }, Math.max(1000, Math.floor(leaseMs / 4)));
    try {
      if (job.userId !== owner) throw new Error('rsi_online_job_owner_mismatch');
      // A source invalidation a deletion hook could not record in place is retried here, from its own job.
      const result = job.kind !== 'rsi-incident-export' ? await pollBundles(job.payload, job)
        : job.payload?.invalidateSource ? await incidents.invalidateSource(job.payload.invalidateSource) : await incidents.processPending(job.payload);
      if (lost) throw new Error('rsi_online_lease_lost');
      if (result?.payload?.status === 'not-exportable') return jobs.fail(owner, job.id, job.leaseToken, { code: result.payload.failureCode ?? 'rsi_incident_not_exportable', message: notExportable }, { retry: false });
      if (['awaiting-configuration', 'withdrawal-pending'].includes(result?.payload?.status) || result?.state === 'waiting') return jobs.fail(owner, job.id, job.leaseToken, { code: 'rsi_online_waiting', message: 'Deployment bindings unavailable.' }, { retry: true, refundAttempt: true, delayMs: 60000 });
      return jobs.finish(owner, job.id, job.leaseToken, result ?? {});
    } catch (error) {
      // A property of the source or of one extraction: another attempt would pay the model again and fail the same way.
      if (job.kind === 'rsi-incident-export' && RSI_INCIDENT_TERMINAL_CODES.includes(error?.message)) {
        report(error.message);
        return jobs.fail(owner, job.id, job.leaseToken, { code: error.message, message: notExportable }, { retry: false });
      }
      report(error?.code ?? 'rsi_online_retry');
      return jobs.fail(owner, job.id, job.leaseToken, { code: 'rsi_online_retry', message: 'Online RSI operation will retry from its durable checkpoint.' }, { retry: true, refundAttempt: true, delayMs: 60000 });
    } finally { clearInterval(heartbeat); }
  }
  const tick = () => { if (!active) active = perform().finally(() => { active = null; }); return active; };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  return { kinds, tick, stop, start() { if (!closed && !timer && configured()) timer = setInterval(() => { tick().catch(() => report('rsi_online_worker_failed')); }, pollMs); }, async close() { closed = true; stop(); await active; }, status: () => ({ configured: configured(), running: active !== null }) };
}
