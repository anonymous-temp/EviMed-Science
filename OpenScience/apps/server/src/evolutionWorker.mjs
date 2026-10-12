import { withEvolutionUsage } from './evolutionUsage.mjs';
import { randomUUID } from 'node:crypto';
import { EVOLUTION_JOB_KINDS } from '@evimed/domain';
import { evolutionKey } from './evolutionService.mjs';
import { EVOLUTION_HEAVY_WINDOW_KINDS, evolutionHeavyWindowOpen } from './evolutionHeavyWindow.mjs';
const LIGHT_KINDS = ['evolution-event','evolution-decision','evolution-digest','evolution-maintain','evolution-plan','evolution-mission','evolution-meta','evolution-research','evolution-audit'];
const SEARCH_KINDS = new Set(['evolution-scout','evolution-build','evolution-mission','evolution-mission-heavy','evolution-plan','evolution-meta','evolution-research']);
/** Durable work with budget and concurrency admission. */
export class EvolutionWorker {
  /** @param {any} dependencies */
  constructor({ service, decisions, maintenance, callbacks = {}, config = {}, canRun = () => true, logger = console, lane = null, counters = null }) {
    this.service = service; this.decisions = decisions; this.maintenance = maintenance; this.callbacks = callbacks; this.config = config; this.canRun = canRun; this.logger = logger;
    this.workerId = `evolution-${randomUUID()}`; this.timer = null; this.running = false;
    this.activePromise = null; this.abortController = null; this.closed = false;
    /** @type {Set<Promise<any>>} */ this.inFlight = new Set(); /** @type {Promise<any>|null} */ this.housekeepingPromise = null;
    this.lane = lane;
    /** Heavy jobs claimed since process start, by whether the heavy window was open when they were (a job asked for by kind, by an operator or a test, ignores the window).
     * The lanes share their parent's. */
    this.counters = counters ?? { heavyStarted: { inside: 0, outside: 0 } };
    /** @type {Map<string, {at: number, key: string | null}>} */ this.blockRuns = new Map();
    this.lanes = lane ? null : ['heavy', ...Array.from({length: Math.max(1,Math.min(2,config.evolutionLightConcurrency ?? 2))}, () => 'light')]
      .map(workerLane => new EvolutionWorker({service,decisions,maintenance,callbacks,config,canRun,logger,lane:workerLane,counters:this.counters}));
  }
  /** Whether the heavy, model-intensive jobs may be claimed now (`evolutionHeavyWindow.mjs`). */
  heavyWindowOpen() { return evolutionHeavyWindowOpen(this.config, this.service.now?.() ?? new Date()); }
  status() { return { enabled: this.config.evolutionEnabled === true, running: this.running || Boolean(this.lanes?.some(worker => worker.running)), searchPaused: this.config.evolutionSearchPaused === true, heavyWindowOpen: this.heavyWindowOpen() }; }
  start() { if (!this.timer) this.timer = setInterval(() => { this.tick().catch((error) => this.logger.error('Evolution worker failed', error)); }, this.config.evolutionPollMs ?? 15000); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  interrupt() { this.abortController?.abort(); for (const worker of this.lanes ?? []) worker.interrupt(); }
  async close() { this.closed = true; this.stop(); this.interrupt(); await this.activePromise; await Promise.allSettled([...this.inFlight]); for (const worker of this.lanes ?? []) await worker.close(); }
  /** Optional closed job subset retains the normal lease, budget and runtime admission. @param {{kinds?:string[]}} [options] */
  tick(options = {}) {
    if (!this.lanes) {
      if (this.activePromise) return this.activePromise;
      this.activePromise = this.tickOnce(options.kinds).finally(() => { this.activePromise = null; });
      return this.activePromise;
    }
    // Each lane is gated by its own job only. A lane that is busy hands back the promise of the job it is running and
    // the others claim their next job now: one gate over all three made the light lanes wait for every heavy job, which
    // holds a runtime for many minutes (2026-10-07: three module missions queued behind one tool mission).
    const run = async () => {
      if (this.closed || this.config.evolutionEnabled !== true || !await this.canRun()) return null;
      await this.housekeepingOnce();
      const results = await Promise.all(this.lanes.map(worker => worker.tick(options)));
      return results.find(Boolean) ?? null;
    };
    const promise = run().finally(() => { this.inFlight.delete(promise); });
    this.inFlight.add(promise);
    return promise;
  }
  /** Housekeeping enqueues idempotently; one pass at a time is enough. */
  housekeepingOnce() {
    if (!this.housekeepingPromise) this.housekeepingPromise = Promise.resolve().then(() => this.housekeeping()).finally(() => { this.housekeepingPromise = null; });
    return this.housekeepingPromise;
  }
  /** @param {string[]} [requestedKinds] */
  async tickOnce(requestedKinds) {
    if (requestedKinds && (!requestedKinds.length || requestedKinds.some(kind => !EVOLUTION_JOB_KINDS.includes(kind)))) throw new Error("Unknown evolution job subset.");
    if (this.closed || this.running || this.config.evolutionEnabled !== true || !await this.canRun()) return null;
    this.running = true;
    try {
      const claim = async (/** @type {string[]} */ kinds, /** @type {boolean} */ heavy) => this.service.jobs.claim(kinds, this.workerId, { leaseMs: this.config.evolutionLeaseMs ?? 120000, admission: async (/** @type {any} */ client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-evolution-admission'))");
        const live = await client.query("SELECT count(*)::integer AS count FROM evimed_product.jobs WHERE kind=ANY($1::text[]) AND status='running' AND lease_expires_at>clock_timestamp()", [this.lane === 'light' ? LIGHT_KINDS : EVOLUTION_JOB_KINDS.filter(kind => !LIGHT_KINDS.includes(kind))]);
        if (Number(live.rows[0]?.count ?? 0) >= (this.lane === 'light' ? this.config.evolutionLightConcurrency ?? 2 : this.config.evolutionMaxConcurrency ?? 1)) return false;
        if (!heavy) return true;
        if (!this.callbacks.dailyCost || !this.callbacks.admitRuntime) return false;
        return true;
      }, candidateAdmission: heavy ? async (client, candidate) => {
        if (await this.callbacks.canResume?.(candidate)) return true;
        const cost = await this.callbacks.dailyCost(client);
        return cost < (this.config.evolutionDailyBudgetCny ?? 100) && this.callbacks.admitRuntime(client, { kinds, job: candidate });
      } : null });
      // The polling worker leaves the heavy, model-intensive jobs to the night window; a caller that names the kinds it wants run is not held by it.
      const heavyAllowed = requestedKinds !== undefined || this.heavyWindowOpen();
      const allowed = (requestedKinds ?? EVOLUTION_JOB_KINDS).filter(kind =>
        (this.lane === 'light' ? LIGHT_KINDS.includes(kind) : !LIGHT_KINDS.includes(kind))
        && !(this.config.evolutionSearchPaused && SEARCH_KINDS.has(kind))
        && (heavyAllowed || !EVOLUTION_HEAVY_WINDOW_KINDS.includes(kind)));
      const lightweight = LIGHT_KINDS.filter(kind => allowed.includes(kind));
      const runtimeKinds = allowed.filter(kind => !lightweight.includes(kind) && kind !== 'evolution-self-check');
      const computeKinds = allowed.filter(kind => kind === 'evolution-self-check');
      const job = (lightweight.length ? await claim(lightweight, false) : null)
        ?? (runtimeKinds.length ? await claim(runtimeKinds, true) : null)
        ?? (computeKinds.length ? await claim(computeKinds, true) : null);
      if (!job) return null;
      if (EVOLUTION_HEAVY_WINDOW_KINDS.includes(job.kind)) this.counters.heavyStarted[this.heavyWindowOpen() ? 'inside' : 'outside']++;
      this.abortController = new AbortController();
      if (this.closed) this.abortController.abort();
      let lost = false;
      /** @type {any} */ let mission = null;
      const heartbeat = setInterval(() => { this.service.jobs.renew(job.userId, job.id, job.leaseToken, this.config.evolutionLeaseMs ?? 120000).then((/** @type {boolean} */ owned) => { if (!owned) { lost = true; this.interrupt(); } }).catch(() => { lost = true; this.interrupt(); }); }, Math.max(1000, Math.floor((this.config.evolutionLeaseMs ?? 120000) / 4)));
      try {
        mission = await this.callbacks.ensureMission?.(job);
        if (this.callbacks.ensureMission && !mission?.id && !['evolution-event','evolution-digest','evolution-plan'].includes(job.kind)) {
          return await this.service.jobs.fail(job.userId, job.id, job.leaseToken, {code:'usage_budget_exceeded',message:'The next mission waits for its budget allocation.'}, {retry:true,refundAttempt:true,delayMs:3600000});
        }
        const execute = () => this.perform(job);
        const result = mission?.id ? await withEvolutionUsage({missionId:mission.id,moduleId:mission.payload.moduleId},execute) : await execute();
        if (mission?.id) await this.callbacks.recordMission?.(mission,result);
        if(['waiting_budget'].includes(result?.payload?.status??result?.status)||['confirmation-budget','development-budget'].includes(result?.payload?.reason))return this.service.jobs.fail(job.userId,job.id,job.leaseToken,{code:'usage_budget_exceeded',message:'The mission retains checkpoints while its next funding tranche waits.'},{retry:true,refundAttempt:true,delayMs:3600000});
        if (lost) throw new Error('Evolution work lease lost.');
        return await this.service.jobs.finish(job.userId, job.id, job.leaseToken, result ?? {});
      } catch (error) {
        // A model refusal of a run's spend limit does not say which limit it was, and the two are not alike: the day's
        // allowance frees in time, so the job keeps its checkpoints and waits for the window; a run's own cap does not free,
        // the same case costs the same again, and retrying it from scratch (each time a fresh project, dispatch id and
        // budget) spent the day's allowance on one case and starved every other job, hourly and without end.
        const refusal = await this.administrativeRefusal(job, error);
        if (refusal === 'run') {
          const exhausted = { code: 'evolution_run_budget_exhausted', status: 409 };
          await this.resourceWait(job, exhausted);
          await this.failMission(mission, exhausted);
          return this.service.jobs.fail(job.userId, job.id, job.leaseToken,
            { code: 'evolution_run_budget_exhausted', message: 'The work needs more than one run may spend; the closed failure record preserves its next step.' }, { retry: false });
        }
        // A refused daily reservation did not buy a model call. Keep this job and its
        // completed checkpoints for the rolling budget window; it is not a method failure.
        if (refusal !== null) {
          return await this.service.jobs.fail(job.userId, job.id, job.leaseToken,
            { code: 'paper_gold_administrative_deferred', message: 'Evaluation waits after an observed administrative model refusal.' },
            { retry: true, refundAttempt: true, delayMs: 3600000 });
        }
        if (error?.code === 'usage_budget_exceeded' && (error.status ?? error.statusCode) === 402 && ['day','mission'].includes(error.details?.window)) {
          return this.service.jobs.fail(job.userId, job.id, job.leaseToken,
            { code: 'usage_budget_exceeded', message: 'Evolution work waits for available rolling daily budget.' },
            { retry: true, refundAttempt: true, delayMs: 3600000 });
        }
        const terminal = Number(job.attempts ?? 1) >= Math.min(job.maxAttempts ?? 10, this.config.evolutionMaxJobAttempts ?? 3)
          || [400, 401, 403, 404, 422].includes(error?.status ?? error?.statusCode);
        if (terminal) { await this.resourceWait(job, error); await this.failMission(mission, error); }
        return this.service.jobs.fail(job.userId, job.id, job.leaseToken, { code: 'evolution_job_failed', message: 'Evolution work failed; the closed failure record preserves its next step.' }, { retry: !terminal, delayMs: this.config.evolutionRetryMs ?? 60000 });
      } finally { clearInterval(heartbeat); this.abortController = null; }
    } finally { this.running = false; }
  }
  /**
   * Whether a failure is the model refusing a run's spend limit, and if so which limit: `day` (the module's own allowance, which
   * frees), `run` (one run's cap, which does not) or `unknown` (nobody could say; treated as the window, as before, for the evaluation's
   * typed 402 only). `null` when it is no such refusal, or a development run's refusal nobody could attribute. Two shapes arrive: the evaluation's typed 402 and a development run that ended `runtime_spend_limit_reached`.
   * @param {any} job @param {any} error @returns {Promise<'day'|'run'|'unknown'|null>}
   */
  async administrativeRefusal(job, error) {
    const typed = error?.code === 'paper_gold_administrative_deferred' && (error.status ?? error.statusCode) === 402;
    if (!typed && error?.code !== 'runtime_spend_limit_reached') return null;
    /** @type {'day'|'run'|'unknown'} */
    let cause = 'unknown';
    try { cause = (await this.callbacks.refusalCause?.(job, error)) ?? 'unknown'; } catch { /* nobody could say */ }
    // The evaluation's own 402 is a typed statement that the stop was administrative, so it waits when the cause is not known; a
    // development run that merely ended `runtime_spend_limit_reached` is only waited for when the window is known to be the cause.
    return !typed && cause === 'unknown' ? null : cause;
  }
  /**
   * One block of housekeeping, run when it is due: it never ran, what it keys on has changed (the day, the month), or its interval has passed.
   * A block marks itself done only after it succeeded, so one that failed is tried again on the next poll.
   * @param {string} name @param {{ms: number, key?: string | null}} schedule @param {() => Promise<any>} work
   */
  async every(name, { ms, key = null }, work) {
    const at = this.service.now().getTime(), last = this.blockRuns.get(name);
    if (last && last.key === key && at - last.at < ms) return;
    await work();
    this.blockRuns.set(name, { at, key });
  }
  /**
   * The housekeeping every poll comes to. All of it is idempotent (an enqueue has a fixed key, a write reads first), and a poll is every 15 s, so
   * unguarded it was a standing load of dozens of reads and writes, several of them listing every tool and evaluation, that grew with what they
   * listed (review D-E24). Each block now runs on its first poll, when its day or month changes, and otherwise at most once a minute for what must
   * notice a change quickly (an interrupted enqueue, a retirement, the digest hour, the end of a pause) and once a day for the rest.
   */
  async housekeeping() {
    const now = this.service.now();
    const local = new Date(now.getTime() + 8 * 3600000);
    const day = local.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const quarter = `${local.getUTCFullYear()}-Q${Math.floor(local.getUTCMonth()/3)+1}`;
    const MINUTE = 60_000, DAY = 86_400_000;
    await this.every('reconcile', { ms: MINUTE }, async () => { await this.service.reconcileQueued?.(); });
    await this.every('retirements', { ms: MINUTE }, async () => {
      for (const tool of await this.service.tools()) if (tool.payload.status === 'retired' && tool.payload.retirement?.state !== 'complete') {
        await this.service.enqueue('maintain', { action: 'retirement-reconcile', toolId: tool.id }, `retirement:${tool.id}:${day}`);
      }
      for(const review of await this.service.list('maintenance-review')) if(review.payload.restoration?.state==='pending' && review.payload.restoration.decisionId) await this.service.enqueue('decision',{decisionId:review.payload.restoration.decisionId},`restore-decision:${review.id}:${day}`);
    });
    // A proposal for the platform's code was prepared and nobody has been told yet (the first attempt failed, or it was prepared before the inbox item
    // existed): the operators hear of it within the minute.
    await this.every('engine-reviews', { ms: MINUTE }, async () => { await this.service.callbacks?.announceEngineReviews?.(); });
    // The sources the platform asked the knowledge-source plugin for: those it has taken leave the list, and those it keeps declining lapse.
    // The records the loops write by the thousand and read once are folded into counts of their day (`evolutionRetention.mjs`); it counts its own failure.
    await this.every('retention', { ms: DAY, key: day }, async () => { await this.service.callbacks?.compactRecords?.(); });
    await this.every('source-requests', { ms: 6 * 60 * MINUTE }, async () => { await this.service.callbacks?.reconcileSourceRequests?.(); });
    await this.every('release', { ms: DAY }, async () => {
      const releaseId = String(this.config.releaseId ?? ''), sourceRevision = String(this.config.sourceRevision ?? '');
      if (/^[a-zA-Z0-9._-]{1,128}$/.test(releaseId) && !/^unknown$/i.test(releaseId) && /^[a-f0-9]{40}$/i.test(sourceRevision)) {
        await this.service.enqueue('evaluate', { action: 'release-replay', releaseId, sourceRevision }, `release-replay:${releaseId}:${sourceRevision}`);
      } else if (!await this.service.get('evolution-release-provenance-unknown')) await this.service.save('observation', 'evolution-release-provenance-unknown', {
        kind: 'release-replay', status: 'waiting', reason: 'A named deployment and immutable source revision are required before claiming release replay.' });
    });
    await this.every('digest', { ms: MINUTE }, async () => {
      const preferences = await this.service.notifications?.preferences?.(await this.service.owner());
      const digestTime = preferences?.digestTime ?? '08:00';
      if (local.toISOString().slice(11, 16) >= digestTime) await this.every('digest-queued', { ms: DAY, key: day }, () => this.service.enqueue('digest', { day }, `daily-digest:${day}`));
    });
    // A block that depends on the pause is not consulted while research is paused, so a poll that skipped it does not count as having run it.
    const paused = Boolean(this.config.evolutionSearchPaused);
    if (!paused) await this.every('scout', { ms: DAY, key: day }, () => this.service.enqueue('scout', { action: 'daily-scan', day }, `daily-scout:${day}`));
    await this.every('daily-events', { ms: DAY, key: day }, async () => {
      await this.service.ingestEvent({id:`handbook-scan:${day}`,type:"handbook-gap-scan"});
      await this.service.ingestEvent({ id: `source-facts:${day}`, type: 'source-facts-scan', origin: 'tool-result' });
      await this.service.ingestEvent({ id: `prospective-targets:${day}`, type: 'prospective-target-scan', origin: 'tool-result' });
      if (this.service.callbacks?.scanLeadSources) await this.service.ingestEvent({ id: `lead-sources:${day}`, type: 'lead-source-scan', origin: 'platform-inference' });
    });
    await this.every('monthly', { ms: DAY, key: month }, async () => {
      await this.service.enqueue('maintain', { month, metricsMonth: previousMonth }, `monthly-v2:${month}`);
      const observations = [...await this.service.tools(), ...await this.service.list('evaluation')];
      const firstMonth = observations.map(row => String(row.createdAt ?? '').slice(0, 7)).filter(value => /^\d{4}-\d{2}$/.test(value)).sort()[0];
      if (firstMonth) {
        const cursor = new Date(`${firstMonth}-01T00:00:00Z`);
        for (let count = 0; count < 120 && cursor.toISOString().slice(0, 7) < previousMonth; count++, cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
          const metricsMonth = cursor.toISOString().slice(0, 7);
          if (!await this.service.get(`evolution-monthly-metrics-${metricsMonth}`)) await this.service.enqueue('maintain', { month, metricsMonth, metricsOnly: true }, `monthly-metrics:${metricsMonth}`);
        }
      }
    });
    await this.every('weekly', { ms: DAY, key: day }, async () => {
      if (local.getUTCDay() === 1) await this.service.enqueue('evaluate', { action: 'scorer-audit', day }, `weekly-scorer-audit:${day}`);
      if (local.getUTCDay() === 1) await this.service.enqueue('evaluate', { action: 'time-holdout', day }, `weekly-holdout:${day}`);
    });
    if (!paused) {
      await this.every('plan', { ms: DAY, key: day }, async () => {
        const monday = new Date(local); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay()+6)%7);
        const week = monday.toISOString().slice(0,10);
        await this.service.enqueue('plan', {week}, `platform-plan:${week}:${day}`);
        await this.service.enqueue('research', {week}, `self-research:${week}`);
        await this.service.enqueue('meta', {month}, `meta-loop:${month}`);
      });
      await this.every('resume', { ms: MINUTE }, () => this.resumePaused());
    }
    // Audit composition curates and seals the quarter only after independent tasks exist.
    await this.every('audit', { ms: DAY, key: `${previousMonth}:${quarter}` }, () => this.service.enqueue('audit', {month:previousMonth,quarter}, `heldout-audit:${previousMonth}`));
  }
  /** A job that will not be tried again ends the mission opened to carry its cost as failed (`recordJob`); one that will be leaves it open.
   * @param {any} mission @param {any} error */
  async failMission(mission, error) {
    if (!mission?.id) return;
    try { await this.callbacks.recordMission?.(mission, { jobFailed: true, code: String(error?.code ?? 'evolution_job_failed') }); }
    catch { /* the job's own failure is what is reported */ }
  }
  /**
   * Missions the pause stopped wait for `search-resumed`, the one event they wake on (`missions.wake`), and nothing else said it, so research
   * paused once never ran again (review D-E4). Said here, where the pause is read, once it is over: one event for one set of paused missions,
   * so a later pause is resumed too.
   */
  async resumePaused() {
    const paused = (await this.service.list('mission', null, { status: 'paused' })).filter((/** @type {any} */ row) => row.payload.status === 'paused');
    if (!paused.length) return null;
    return this.service.ingestEvent({ id: `search-resumed:${evolutionKey(paused.map((/** @type {any} */ row) => [row.id, row.revision]))}`, type: 'search-resumed', origin: 'platform-inference' });
  }
  /** No private error prose enters shared failures or resource cards. @param {any} job @param {any} error */
  async resourceWait(job, error) {
    const code = String(error?.code ?? 'unknown');
    const gapCode = /model|provider|review|credential|budget/.test(code) ? 'model-capability'
      : /source|dataset|semantics|parser|fetch|gateway/.test(code) ? 'connector' : /extract/.test(code) ? 'extraction' : 'method-implementation';
    const stage = job.kind.slice('evolution-'.length);
    const dependencyKey = String(job.payload.dependencyId ?? job.payload.dossierId ?? job.payload.missionId ?? job.id);
    let failure = await this.service.recordFailure({ dossierId: `worker-${dependencyKey}`, version: 1, gapCode,
      workerStage: stage, dependencyKey, moduleId: job.payload.moduleId ?? 'tools', attemptedPaths: ['bounded-worker-attempts'], wakeConditions: ['new-data', 'new-tool', 'new-model'] });
    if (failure.payload.status === 'resolved') failure = await this.service.save('failure', failure.id, { ...failure.payload,
      status: 'waiting', reopens: Number(failure.payload.reopens ?? 0) + 1 }, failure);
    await this.decisions.propose({ category: 'worker-resource', subjectId: failure.id, resourceOnly: true,
      materialVersion: Number(failure.payload.reopens ?? 0) + 1,
      title: '进化任务等待所需资源', body: `任务类型 ${stage} 已停止重复尝试，缺口类别为 ${gapCode}。补齐资源后可选择重新检索；研究者的其他工作继续。`,
      options: [{ id: 'wait', label: '等待所需资源', operation: 'wait' }, { id: 'rescout', label: '重新检索', operation: 'rescout' }],
      recommended: 'wait', conservative: 'wait', alternative: 'wait' });
    return failure;
  }
  /** @param {any} job */
  async perform(job) {
    const p = job.payload;
    if (job.kind === 'evolution-decision') return { decision: await this.decisions.expire(p.decisionId) };
    if (job.kind === 'evolution-digest') return { digest: await this.decisions.digest(p.day) };
    if (job.kind === 'evolution-maintain') {
      if (p.action === 'retirement-reconcile') {
        const tool = await this.service.get(p.toolId);
        return { retirement: tool ? await this.maintenance.retire(tool, tool.payload.retirement?.reason ?? 'retirement-recovery') : null };
      }
      return { maintenance: await this.maintenance.monthly(p) };
    }
    if (job.kind === 'evolution-event') {
      const row = await this.service.get(p.eventId, p.eventOwnerId);
      if (!row || row.payload.status === 'processed') return {};
      await this.callbacks.onEvent?.(row.payload, this.service);
      await this.service.resolveWaiters(row.payload);
      await this.service.save('event', row.id, { ...row.payload, status: 'processed' }, row, p.eventOwnerId);
      return { eventId: row.id };
    }
    const rawName = job.kind.slice('evolution-'.length);
    const name = rawName === 'mission-heavy' ? 'mission' : rawName;
    const callback = this.callbacks[name === 'self-check' ? 'selfCheck' : name];
    if (!callback) throw new Error(`Missing evolution ${name} worker implementation.`);
    const result = await callback(p, { service: this.service, job, purpose: 'evolution', signal: this.abortController?.signal });
    if (name === 'self-check') await this.service.completeSelfCheck(p, result);
    for (const failure of await this.service.list('failure')) if (failure.payload.workerStage === name && failure.payload.status === 'waiting' && failure.payload.dependencyKey === String(p.dependencyId ?? p.dossierId ?? p.missionId ?? job.id)) {
      await this.service.save('failure', failure.id, { ...failure.payload, status: 'resolved', resolvedAt: this.service.now().toISOString() }, failure);
    }
    return result;
  }
}
/** @param {any} dependencies */
export function createEvolutionWorker(dependencies) { return new EvolutionWorker(dependencies); }
