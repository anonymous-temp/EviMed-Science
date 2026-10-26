import { randomUUID } from 'node:crypto';
/** The two online queues have one owner and one claimer; experiments never run here. @param {any} dependencies */
export function createRsiOnlineWorker({ jobs, owner, configured, incidents, pollBundles, canRun = async () => true, report = () => {}, pollMs = 15000, leaseMs = 120000 }) {
  const workerId = `rsi-online-${randomUUID()}`;
  let timer = null, active = null, closed = false;
  const kinds = Object.freeze(['rsi-incident-export', 'rsi-bundle-poll']);
  async function perform() {
    if (closed || !configured() || !await canRun()) return null;
    const job = await jobs.claim([...kinds], workerId, { leaseMs, ownerId: owner, admission: canRun });
    if (!job) return null;
    let lost = false;
    const heartbeat = setInterval(() => { jobs.renew(job.userId, job.id, job.leaseToken, leaseMs).then(ok => { if (!ok) lost = true; }).catch(() => { lost = true; }); }, Math.max(1000, Math.floor(leaseMs / 4)));
    try {
      if (job.userId !== owner) throw new Error('rsi_online_job_owner_mismatch');
      const result = job.kind === 'rsi-incident-export' ? await incidents.processPending(job.payload) : await pollBundles(job.payload);
      if (lost) throw new Error('rsi_online_lease_lost');
      if (['awaiting-configuration', 'withdrawal-pending'].includes(result?.payload?.status) || result?.state === 'waiting') return jobs.fail(owner, job.id, job.leaseToken, { code: 'rsi_online_waiting', message: 'Deployment bindings unavailable.' }, { retry: true, refundAttempt: true, delayMs: 60000 });
      return jobs.finish(owner, job.id, job.leaseToken, result ?? {});
    } catch (error) {
      report(error?.code ?? 'rsi_online_retry');
      return jobs.fail(owner, job.id, job.leaseToken, { code: 'rsi_online_retry', message: 'Online RSI operation will retry from its durable checkpoint.' }, { retry: true, refundAttempt: true, delayMs: 60000 });
    } finally { clearInterval(heartbeat); }
  }
  const tick = () => { if (!active) active = perform().finally(() => { active = null; }); return active; };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  return { kinds, tick, stop, start() { if (!closed && !timer && configured()) timer = setInterval(() => { tick().catch(() => report('rsi_online_worker_failed')); }, pollMs); }, async close() { closed = true; stop(); await active; }, status: () => ({ configured: configured(), running: active !== null }) };
}
