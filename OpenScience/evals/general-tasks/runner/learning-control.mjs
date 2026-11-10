// Eval-only IPC adapter. All writes use product entry points; no learning evidence or approvals are fabricated.
export async function control(app, action, { userId, key = 'l3', projectId, runId } = {}) {
  if (action === 'facts') return { nativeMemory: app.openVikingEngine?.ready('nativeMemory') ?? null,
    knowledge: app.openVikingEngine?.ready('knowledge') ?? null, ranker: Boolean(app.runtimeManager.methodSimilarity) };
  if (action === 'usage') return { account: await app.usageLedger.summary(userId),
    learning: await app.usageLedger.summary(userId, { purposes: ['learning'] }) };
  if (action === 'methods') {
    const { runMethodObservations, methodObservationSessionsForRun } = await import(`${process.env.OS}/apps/server/src/methodObservations.mjs`);
    const { collectRunTranscripts } = await import(`${process.env.OS}/apps/server/src/runTranscripts.mjs`);
    const user = await app.store.userById(userId);
    const project = await app.store.requireProject(user, projectId);
    const run = (await app.agentRuns.list(project)).find(row => row.id === runId);
    if (!run) throw new Error('Method observer cannot find the run');
    const known = [...app.runtimeManager.methodsGivenTo(project, run.sessionId),
      ...app.runtimeManager.officialGivenTo(project, run.sessionId).offered.map(method => ({ ...method, reason: 'similarity' }))];
    const read = await app.agentRuns.runWorkflowProjection(project, run);
    const projection = { ...(read ?? {}), mountedMethods: known };
    const sessions = await collectRunTranscripts(app.runtimeManager, project, run,
      { children: (read?.subagents ?? []).map(child => ({ sessionId: child.childSessionId, parentSessionId: run.sessionId })) });
    const scoped = methodObservationSessionsForRun({ run, projection, sessions });
    const result = runMethodObservations({ run, projection, methods: known, sessions: scoped });
    return { source: 'product-read-only-observer', methodsLoaded: result.methodsLoaded, methodsInvoked: result.methodsInvoked,
      transcriptGaps: sessions.filter(session => session.error).map(session => ({ sessionId: session.sessionId, error: session.error })) };
  }
  const worker = app.learningWorker;
  if (!worker) return { enabled: false, jobs: [] };
  const db = app.store.database;
  const rows = async () => (await db.query(`SELECT id,kind,payload,status,error,run_after,idempotency_key,result
    FROM evimed_product.jobs WHERE user_id=$1 AND kind=ANY($2::text[]) ORDER BY created_at`,
  [userId, ['distill', 'consolidate', 'learning-evidence']])).rows;
  if (action === 'pause') {
    worker.enabled = false;
    await Promise.all([...worker.lanes]);
    // The worker's internal kernel otherwise holds the slot's bridge port into the exam phase.
    const user = await app.store.userById?.(userId);
    if (user && app.runtimeManager) {
      let project = null;
      try { project = await app.store.requireProject(user, 'evimed-learning'); } catch (error) { if (error.status !== 404) throw error; }
      if (project) await app.runtimeManager.stop(project);
    }
  } else if (action === 'start') {
    await worker.reconcile();
    const { ProductJobs } = await import(`${process.env.OS}/apps/server/src/productJobs.mjs`);
    const jobs = new ProductJobs(db);
    for (const row of await rows()) if (row.kind === 'learning-evidence' && row.status === 'queued') await jobs.bringForward(userId, row.idempotency_key);
    worker.enabled = true;
  } else if (action === 'sleep') {
    const { LEARNING_PROJECT_ID, LEARNING_PROJECT_NAME } = await import(`${process.env.OS}/apps/server/src/internalProjects.mjs`);
    const { ProductJobs } = await import(`${process.env.OS}/apps/server/src/productJobs.mjs`);
    const user = await app.store.userById(userId);
    try { await app.store.requireProject(user, LEARNING_PROJECT_ID); }
    catch (error) { if (error.status !== 404) throw error; await app.store.createProject(user, LEARNING_PROJECT_ID, LEARNING_PROJECT_NAME); }
    const jobs = new ProductJobs(db);
    const idempotencyKey = `consolidate:sleep:eval:${key}`;
    // A retry must keep the first request's date: the product rejects a changed payload under an existing key.
    const previous = (await rows()).find(row => row.idempotency_key === idempotencyKey);
    await jobs.enqueue(userId, 'consolidate', previous?.payload ?? { action: 'sleep', date: new Date().toISOString() },
      { projectId: LEARNING_PROJECT_ID, idempotencyKey });
  } else if (action !== 'status') throw new Error(`Unknown eval control: ${action}`);
  return { enabled: worker.enabled, worker: worker.status(), jobs: await rows() };
}
