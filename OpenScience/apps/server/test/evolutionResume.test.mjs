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

test('fixed native turns share one mission reservation and cleanup is generation fenced',async()=>{
 const {withEvolutionUsage}=await import('../src/evolutionUsage.mjs');
 const docs=new Map(),recorded=[];let reservations=0,target=null;const stops=[];
 const service={get:async id=>docs.get(id),save:async(_kind,id,payload)=>{const row={id,payload};docs.set(id,row);return row;}};
 const project={id:'eval-paper-runtime-fixture',userId:'operator'};
 const runtimeManager={reserveBoundedRuntimeSession:async(_project,scope)=>{reservations++;target={runId:scope.runId,generation:'observed-generation'};return {id:'same-session'};},boundedRuntimeCleanupTarget:()=>target,endBoundedRuntime:async(...args)=>{stops.push(args);return true;}};
 const runs=createEvolutionRuns({config:{evolutionEnabled:true,operatorUsers:['operator'],evolutionDailyBudgetCny:10,evolutionRunBudgetCny:10},service,store:{userById:async id=>({id}),projectFor:async()=>project},registry:Promise.resolve(new Map([['open-domain-answer',{id:'open-domain-answer',version:'1'}]])),runtimeManager,researchSessions:{get:async()=>({}),put:async()=>{}},usageLedger:{assertWithinLimits:async()=>{}},agentRuns:{list:async()=>recorded,dispatch:async(_project,input)=>{const row={id:'run-'+recorded.length,dispatchId:input.dispatchId,sessionId:input.sessionId,status:'succeeded'};recorded.push(row);return row;}}});
 const request={userId:'operator',projectId:project.id,capabilityId:'open-domain-answer',nativeProbe:true,brief:'fixed task'};
 const first=await withEvolutionUsage({missionId:'evolution-mission-same',moduleId:'runtime'},()=>runs.dispatch({...request,dispatchId:'runtime-probe-first'}));
 await withEvolutionUsage({missionId:'evolution-mission-same',moduleId:'runtime'},()=>runs.dispatch({...request,sessionId:first.sessionId,dispatchId:'runtime-probe-second'}));
 assert.equal(reservations,1);assert.equal(recorded.length,2);
 const attribution=docs.get(`evolution-run-attribution-${evolutionKey(['operator',project.id,'runtime-probe-first'])}`);
 assert.deepEqual(attribution.payload.runIds,['runtime-probe-first','runtime-probe-second']);
 await assert.rejects(()=>withEvolutionUsage({missionId:'evolution-mission-different',moduleId:'runtime'},()=>runs.dispatch({...request,sessionId:first.sessionId,dispatchId:'runtime-probe-third'})),{code:'evolution_scope_invalid'});
 await runs.closeNativeProbe(project,first.nativeScope);assert.equal(stops[0][2],'observed-generation');
});
