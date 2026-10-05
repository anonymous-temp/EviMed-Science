import test from "node:test";
import assert from "node:assert/strict";
import { createEvolutionRuns } from "../src/evolutionRuns.mjs";
import { evolutionKey } from "../src/evolutionService.mjs";

test("recovery admission requires the exact durable job, owner and real dispatch ledger", async () => {
  const row = { payload: { jobId: "job", userId: "operator", projectId: "eval-paper-build-one", dispatchId: "dispatch" } };
  let recorded = [];
  const reads = [];
  const runs = createEvolutionRuns({ service: { get: async id => { reads.push(id); return row; } },
    store: { userById: async id => ({ id }), requireProject: async (user, id) => ({ userId: user.id, id }) },
    agentRuns: { list: async project => { assert.equal(project.userId, "operator"); assert.equal(project.id, "eval-paper-build-one"); return recorded; } } });
  assert.equal(await runs.canResume({ id: "job", userId: "operator" }), false);
  recorded = [{ dispatchId: "dispatch", status: "running" }];
  assert.equal(await runs.canResume({ id: "job", userId: "operator" }), true);
  assert.equal(await runs.canResume({ id: "different-job", userId: "operator" }), false);
  assert.equal(await runs.canResume({ id: "job", userId: "other-owner" }), false);
  recorded = [{ dispatchId: "different-dispatch", status: "running" }];
  assert.equal(await runs.canResume({ id: "job", userId: "operator" }), false);
  assert.equal(reads[0], `evolution-runtime-work-${evolutionKey("job")}`);
});

test('completed protected dispatch binds exact existing run before return without new execution', async () => {
  const calls = [], existing = { id: 'sealed-run', dispatchId: 'dispatch', status: 'succeeded' };
  const runs = createEvolutionRuns({ config: { evolutionEnabled: true, operatorUsers: ['operator'] }, store: { userById: async id => ({ id }), projectFor: async (user, id) => ({ userId: user.id, id }) }, agentRuns: { list: async () => [existing] }, evaluationIsolation: { registerPending: async (...args) => calls.push(['pending', ...args]), bindRun: async (...args) => calls.push(['binding', ...args]) } });
  assert.equal(await runs.dispatch({ userId: 'operator', projectId: 'eval-paper-probe', dispatchId: 'dispatch', evaluationPolicy: { aliases: ['target'] } }), existing);
  assert.deepEqual(calls[1], ['binding', { userId: 'operator', projectId: 'eval-paper-probe' }, 'sealed-run', { dispatchId: 'dispatch' }]);
});

test('a protected dispatch binds the run under both of its names, so its bounded runtime\'s own requests are filtered, not refused', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const { createEvaluationIsolation } = await import('../src/evaluationIsolation.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'evolution-binding-'));
  try {
    const isolation = createEvaluationIsolation({ dataDir, resolveRunId: identity => identity.runId ?? null });
    const policy = { aliases: ['10.1136/bmj.n71'], titles: [] };
    const recorded = [];
    const runs = createEvolutionRuns({ config: { evolutionEnabled: true, operatorUsers: ['operator'], evolutionDailyBudgetCny: 1, evolutionRunBudgetCny: 1 },
      store: { userById: async id => ({ id }), projectFor: async (user, id) => ({ userId: user.id, id }) },
      registry: Promise.resolve(new Map([['evolution-scout', { id: 'evolution-scout', version: '1', runtimeAgent: 'evimed' }]])),
      usageLedger: { assertWithinLimits: async () => {} }, researchSessions: { put: async () => {} },
      runtimeManager: { reserveBoundedRuntimeSession: async () => ({ id: 'session' }), endBoundedRuntime: async () => {} },
      // The ledger names the run; the dispatch callback is where the binding is written, before any prompt.
      agentRuns: { list: async () => recorded, dispatch: async (_project, request, start) => {
        const run = { id: 'run_ledger', dispatchId: request.dispatchId, status: 'running' }; recorded.push(run);
        await start({}, run).catch(() => {}); return run; } },
      evaluationIsolation: isolation });
    const identity = { userId: 'operator', projectId: 'eval-paper-isolation-blocked' };
    for (const pass of ['fresh', 'resumed']) {
      const run = await runs.dispatch({ ...identity, capabilityId: 'evolution-scout', dispatchId: 'evolution_isolation_blocked', brief: 'x', evaluationPolicy: policy });
      assert.equal(run.id, 'run_ledger', pass);
      // What the runtime's gateway token says (`issueModelGatewayRuntimeToken`'s budget scope): the dispatch id.
      await assert.rejects(isolation.assertRequest({ ...identity, runId: 'evolution_isolation_blocked' }, 'public-source', { url: 'https://doi.org/10.1136/bmj.n71' }), { status: 403, code: 'evaluation_source_excluded' }, pass);
    }
    assert.deepEqual((await isolation.audit('run_ledger')).events.map(event => event.tier), ['blocked', 'blocked']);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
