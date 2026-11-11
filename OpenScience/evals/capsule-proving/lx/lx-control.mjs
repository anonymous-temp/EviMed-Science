// LX eval-only IPC actions (loaded by runner/learning-control.mjs when EVAL_CONTROL_EXTRA names this file). Reads go to the
// product's own ledger tables and counters; the only write besides moving queued jobs' run_after forward is `lxAmend`, the
// L1 replay ring's scripted amendment, which goes through the product's LearningService and queues the replay job exactly as a
// distillation that amends a method does (methodDistillationRuns.mjs #enqueueReplay). No evidence, lesson or approval is fabricated.
const KINDS = ['distill', 'consolidate', 'learning-evidence'];

/** The process counters of the learning loop, as plain JSON (they reset when the harness restarts). @param {any} app */
function counters(app) {
  const metrics = app.runtimeManager?.learningMetrics;
  if (!metrics) return null;
  return JSON.parse(JSON.stringify(metrics));
}

/** @param {any} app @param {string} userId */
async function state(app, userId) {
  const db = app.store.database;
  const events = (await db.query(`SELECT id, project_id, run_id, trigger_kind, subject_type, subject_id, detail, occurred_at, recorded_at
    FROM evimed_product.feedback_events WHERE user_id=$1 ORDER BY occurred_at, recorded_at, id`, [userId])).rows;
  const jobs = (await db.query(`SELECT id, project_id, kind, idempotency_key, payload, status, result, error, attempts, run_after, created_at, finished_at
    FROM evimed_product.jobs WHERE user_id=$1 AND kind=ANY($2::text[]) ORDER BY created_at, id`, [userId, KINDS])).rows;
  const methods = (await db.query(`SELECT id, project_id, revision, payload, created_at, updated_at, deleted_at
    FROM evimed_product.documents WHERE user_id=$1 AND kind='method' ORDER BY created_at, id`, [userId])).rows
    .map(row => { const payload = { ...row.payload }; delete payload.files; return { ...row, payload }; });
  return { at: new Date().toISOString(), events, jobs, methods, counters: counters(app) };
}

/** The learning service the worker's distillation holds (the composition does not return it on `app`). @param {any} app */
function learningService(app) {
  const service = app.learningWorker?.distillation?.learning;
  if (!service) throw new Error('learning service unavailable (learning off?)');
  return service;
}

export async function control(app, action, { userId, methodId, body, kinds = KINDS } = {}) {
  if (action === 'lxState') return state(app, userId);
  if (action === 'lxCounters') return counters(app);
  if (action === 'lxBring') {
    // Every queued learning job of this account whose time has not come, due now: the settle jobs wait out the 30-minute
    // reaction window in the product; the experiment does not wait for wall-clock time.
    const result = await app.store.database.query(`UPDATE evimed_product.jobs SET run_after=clock_timestamp(), updated_at=clock_timestamp()
      WHERE user_id=$1 AND kind=ANY($2::text[]) AND status='queued' AND run_after>clock_timestamp()`, [userId, kinds]);
    return { broughtForward: result.rowCount ?? 0 };
  }
  if (action === 'lxSettleApplied') {
    // The product folds a person's reactions into the counters of the methods a run opened on its consolidation-schedule pass
    // (server.mjs scheduleConsolidation -> methodApplied.settleUser), hourly by default. The same factory, the same dependencies,
    // called now for this account (idempotent by run). Official methods' platform-wide records are left out (official: null).
    const { createMethodAppliedOutcomes } = await import(`${process.env.OS}/apps/server/src/methodAppliedOutcomes.mjs`);
    const applied = createMethodAppliedOutcomes({ learning: learningService(app), feedback: app.feedbackEvents,
      resolveProject: async (owner, projectId) => { const user = await app.store.userById(owner); return user ? app.store.requireProject(user, projectId).catch(() => null) : null; },
      runsOf: project => app.agentRuns.list(project), onApplied: outcome => app.runtimeManager?.learningMetrics?.observeApplied(outcome) });
    return (await applied.settleUser(userId)) ?? null;
  }
  if (action === 'lxAmend') {
    const service = learningService(app);
    const current = await service.getMethod(userId, methodId);
    const previousDigest = current.payload?.contentDigest ?? null;
    const amended = await service.amendMethod(userId, methodId, { expectedRevision: current.revision, frontmatter: current.payload.frontmatter, body,
      provenance: { ...(current.payload.provenance ?? {}), origin: current.payload.provenance?.origin ?? 'explicit' } });
    const digest = amended?.payload?.contentDigest;
    let replayQueued = false;
    if (typeof digest === 'string' && digest && previousDigest && digest !== previousDigest) {
      const { ProductJobs } = await import(`${process.env.OS}/apps/server/src/productJobs.mjs`);
      const { LEARNING_PROJECT_ID, LEARNING_PROJECT_NAME } = await import(`${process.env.OS}/apps/server/src/internalProjects.mjs`);
      const user = await app.store.userById(userId);
      try { await app.store.requireProject(user, LEARNING_PROJECT_ID); }
      catch (error) { if (error.status !== 404) throw error; await app.store.createProject(user, LEARNING_PROJECT_ID, LEARNING_PROJECT_NAME); }
      await new ProductJobs(app.store.database).enqueue(userId, 'consolidate', { action: 'replay', methodId, digest, previousDigest },
        { idempotencyKey: `consolidate:replay:${methodId}:${digest}`, projectId: LEARNING_PROJECT_ID });
      replayQueued = true;
    }
    return { methodId, previousDigest, digest, status: amended?.payload?.status ?? null, revision: amended?.revision ?? null, replayQueued };
  }
  throw new Error(`Unknown LX control: ${action}`);
}
