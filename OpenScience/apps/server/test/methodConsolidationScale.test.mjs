import assert from 'node:assert/strict';
import test from 'node:test';
import { MethodConsolidation } from '../src/methodConsolidation.mjs';
import { MethodConsolidationQueue, METHOD_PAIR_FLOOR } from '../src/methodConsolidationQueue.mjs';
import { createMethodSimilarity } from '../src/methodSimilarity.mjs';
import { selectLearnedMethods } from '../src/learnedMethodMount.mjs';
import { LearningService } from '../src/learningService.mjs';
import { learningSummary, learningMetricFamilies } from '../src/learningMetrics.mjs';
import { persistentDocuments } from '../../../evals/capsule-proving/learn/documents.mjs';

const method = (id, text = id) => ({ id, payload: { recordType: 'learned-method', status: 'approved', contentDigest: `sha256:${id}`,
  frontmatter: { name: id, description: text, whenToUse: text, metadata: { applies_when: text } }, body: `## Workflow\n${text}` } });
const job = { id: 'pass', userId: 'u', projectId: 'p', payload: { action: 'sleep' } };
async function harness({ size = 10, budget = 3, queueEnabled = true, recallEnabled = false, fail = false } = {}) {
  const documents = persistentDocuments(), calls = [], proposals = [];
  for (let i = 0; i < size; i++) await documents.put('u', 'method', `m${i}`, method(`m${i}`).payload, { expectedRevision: 0 });
  const learning = new LearningService({ documents });
  learning.retirementProposals = async () => [];
  const sim = { methodText: m => m.payload.body, nearest: async () => [], pairs: async (methods, options) => {
    proposals.push(options);
    return methods.slice(1).map((m, index) => ({ a: methods[0].id, b: m.id, score: 1 - index / 100, overlap: 1 }));
  } };
  const make = () => new MethodConsolidation({ learning, queueEnabled, recallEnabled, modelCalls: budget, similarity: sim,
    dispatch: async request => { calls.push(request); return { runId: request.dispatchId }; },
    readResult: async () => fail ? { status: 'failed' } : { status: 'succeeded', output: { assignments: [] } } });
  return { documents, learning, calls, proposals, make };
}

test('scale fast check: overlapping pairs survive budgets and a restart; unchanged work costs no calls', async () => {
  const h = await harness({budget:1});
  const first = await h.make().sleep({ job });
  assert.equal(first.coverage.backlog, 2);
  assert.equal(first.coverage.examined, 7);
  assert.equal(first.coverage.modelCalls, 1);
  for (let i = 1; i < 3; i++) await h.make().sleep({ job: { ...job, id: `pass${i}` } });
  const last = await h.make().sleep({ job });
  assert.equal(last.coverage.backlog, 0);
  assert.equal(last.coverage.modelCalls, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(new Set(h.calls.map(r => r.dispatchId)).size, 2);
  assert.equal(h.proposals.length, 1);
  assert.equal(h.proposals[0].floor, METHOD_PAIR_FLOOR);
  const changed = await h.learning.getMethod('u', 'm2');
  await h.documents.put('u', 'method', 'm2', { ...changed.payload, contentDigest: 'changed', body: 'changed' }, { expectedRevision: changed.revision });
  const result = await h.make().sleep({ job });
  assert.deepEqual(h.proposals.at(-1).onlyIds, ['m2']);
  assert.equal(result.coverage.enqueued, 1);
  assert.equal(result.coverage.examined, 1);
});

test('the enabled pass paginates beyond 100; default pass keeps its read window and no queue rows', async () => {
  const on = await harness({ size: 205, budget: 1 });
  const result = await on.make().sleep({ job });
  assert.equal(result.methods, 205);
  assert.equal(result.coverage.enqueued, 204);
  const off = await harness({ size: 205, queueEnabled: false });
  const old = await off.make().sleep({ job });
  assert.equal(old.methods, 100);
  assert.equal(old.coverage, undefined);
  assert.equal([...off.documents.rows.values()].filter(row => row.kind === 'method-consolidation').length, 0);
});

test('failed decisions remain unexamined; scope leases exclude concurrent spend and recover after expiry', async () => {
  const h = await harness({ fail: true, budget: 2 });
  const result = await h.make().sleep({ job });
  assert.equal(result.coverage.backlog, 9);
  assert.equal(result.coverage.examined, 0);
  assert.equal(result.coverage.modelCalls, 2);
  let ms = 1000;
  const q = new MethodConsolidationQueue(h.documents, { now: () => new Date(ms) });
  const lease = await q.acquire('u', 'owned', 100);
  assert.ok(lease);
  assert.equal(await q.acquire('u', 'owned', 100), null);
  assert.ok(await q.acquire('other-user', 'owned', 100));
  assert.ok(await q.acquire('u', 'geo:project', 100));
  ms += 101;
  assert.ok(await q.acquire('u', 'owned', 100));
});

test('deferred BUILD uses a later pass without charging the cached DECIDE again', async () => {
  const h = await harness({ size: 3, budget: 1 });
  const pass = h.make(); let decided = false;
  pass.readResult = async identity => {
    const build = identity.runId.includes('build'), calls = build || !decided ? 1 : 0;
    decided = true;
    return { status:'succeeded', usage:{calls}, output:build ? {revisions:[]} : {assignments:[
      {ASSIGNMENT:'A1',SKILLS:h.calls.at(-1).input.methods.map(m=>m.id),RELATION_TYPE:'shared_part',REASON:'Same exact sub-step.'},
    ]} };
  };
  const first = await pass.sleep({ job });
  assert.equal(first.coverage.backlog, 0);
  assert.equal(first.coverage.pendingBuilds, 2);
  assert.equal(h.calls.length, 1);
  const queued=[...h.documents.rows.values()].find(row=>row.kind==='method-consolidation'&&row.payload.recordType==='pair');
  await h.documents.put('u',queued.kind,queued.id,{...queued.payload,status:'done'},{expectedRevision:queued.revision,telemetry:true});
  const firstQuestion=structuredClone(h.calls[0].input);
  const second = await pass.sleep({ job });
  assert.deepEqual(h.calls[1].input,firstQuestion,'the exact paid question survives a partially completed batch');
  assert.equal(second.coverage.backlog, 0);
  assert.equal(second.coverage.pendingBuilds, 0);
  assert.equal(second.coverage.modelCalls, 1);
  assert.equal(h.calls.length, 3);
});

test('applicability retrieval proposes a pair missed by the summary view; switch off preserves the old answer', async () => {
  const sim = createMethodSimilarity({ embed: async texts => texts.map(text => text === 'same situation\nsame situation' ? [1,0,0] : text.includes('other body') ? [0,0,1] : [0,1,0]) });
  const a = method('a', 'same situation'), b = method('b', 'same situation');
  b.payload.body = 'other body';
  b.payload.frontmatter.description = 'other body';
  assert.equal((await sim.pairs([a,b], { floor: 0.60 })).length, 0);
  assert.equal((await sim.pairs([a,b], { floor: 0.60, applicability: true })).length, 1);
});

test('pending-retirement mount is opt-in, digest-bound and restorable when the replacement is retired', async () => {
  const a = method('a'), b = method('b'), canonical = method('canonical');
  canonical.payload.provenance = { pendingRetirements: [a,b].map(m => ({ methodId: m.id, baseDigest: m.payload.contentDigest })) };
  const learning = { approvedMethods: async () => [a,b,canonical].filter(m => m.payload.status === 'approved') };
  const scope = { userId: 'u', projectId: 'p', family: 'research', maxCount: 10 };
  assert.equal((await selectLearnedMethods(learning, scope)).length, 3);
  assert.deepEqual((await selectLearnedMethods(learning, { ...scope, skipPendingRetirements: true })).map(m => m.id), ['canonical']);
  a.payload.contentDigest = 'new-body';
  assert.equal((await selectLearnedMethods(learning, { ...scope, skipPendingRetirements: true })).length, 2);
  canonical.payload.status = 'retired';
  assert.equal((await selectLearnedMethods(learning, { ...scope, skipPendingRetirements: true })).length, 2);
});

test('methods data and operator gauges report durable unexamined pairs only when enabled', async () => {
  const queries = [];
  const database = { query: async (sql, values) => { queries.push({sql,values}); return { rows: sql.includes("kind='method-consolidation'") ? [{ backlog: 7, pending_builds: 2 }] : [] }; } };
  const off = await learningSummary(database, 'u');
  assert.equal(off.consolidation, undefined);
  const on = await learningSummary(database, 'u', { consolidationQueue: true });
  assert.deepEqual(on.consolidation, { backlog: 7, pendingBuilds: 2 });
  assert.deepEqual(queries.at(-1).values, ['u']);
  assert.equal(learningMetricFamilies(true, { methods: {}, uses: {}, lessons: {}, results: {}, evidence: {}, evidenceLastAt: [], coverage: on.consolidation }, null)
    .find(f => f.name === 'open_science_learning_consolidation_backlog').series[0].value, 7);
});

test('PostgreSQL queue survives service recreation, paginates, scopes owners and never locks a model call',
  { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Test PostgreSQL is not configured' }, async () => {
    const { ControlPlaneDatabase } = await import('../src/controlPlaneDatabase.mjs');
    const { ProductDocuments } = await import('../src/productStore.mjs');
    const { randomUUID } = await import('node:crypto');
    const database = new ControlPlaneDatabase({ databaseUrl: process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
    const owner = `p34-${randomUUID()}`;
    try {
      await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'P34 test','development')", [owner]);
      const documents = new ProductDocuments(database), q = new MethodConsolidationQueue(documents);
      const methods = Array.from({length: 105}, (_,i) => method(`pg-${i}`));
      await q.sync(owner, 'owned', methods, async () => methods.slice(1).map(m => ({a:methods[0].id,b:m.id,score:.7})));
      const reopened = new MethodConsolidationQueue(new ProductDocuments(database));
      assert.equal(reopened.summary(await reopened.rows(owner, 'owned')).backlog, 104);
      assert.equal((await reopened.rows(owner, 'geo:other')).length, 0);
      const [a,b] = await Promise.all([q.acquire(owner,'owned',1000), reopened.acquire(owner,'owned',1000)]);
      assert.equal([a,b].filter(Boolean).length,1);
      await reopened.release(owner,a??b);
      const summary = await learningSummary(database, owner, {consolidationQueue:true});
      assert.deepEqual(summary.consolidation,{backlog:104,pendingBuilds:0});
    } finally {
      await database.query('DELETE FROM evimed_control.users WHERE id=$1',[owner]);
      await database.close();
    }
  });

test('provider call receipts include repairs before admitting another pair', async () => {
  const h = await harness({ budget: 3 });
  const pass = h.make();
  pass.readResult = async () => ({ status:'succeeded',output:{assignments:[]},usage:{calls:3} });
  const result = await pass.sleep({job});
  assert.equal(result.coverage.modelCalls,3);
  assert.equal(h.calls.length,1);
  assert.equal(result.coverage.backlog,2);
});

test('retirement invalidates pending snapshots, and restoring the same body proposes them again', async () => {
  const documents=persistentDocuments(),q=new MethodConsolidationQueue(documents),a=method('a'),b=method('b');
  const propose=async()=>[{a:'a',b:'b',score:.8}];
  await q.sync('u','owned',[a,b],propose);
  const stopped=await q.sync('u','owned',[a],propose);
  assert.equal(q.summary(stopped.rows).backlog,0);
  const restored=await q.sync('u','owned',[a,b],propose);
  assert.equal(q.summary(restored.rows).backlog,1);
});

test('P34 switches default off and expose explicit overrides', async () => {
  const {loadConfig}=await import('../src/config.mjs');
  const rootDir=new URL('../../../',import.meta.url).pathname;
  const defaults=loadConfig({rootDir});
  assert.equal(defaults.methodConsolidationQueueEnabled,false);
  assert.equal(defaults.methodConsolidationRecallEnabled,false);
  assert.equal(defaults.methodPendingRetirementMountEnabled,false);
  assert.equal(defaults.methodConsolidationModelCalls,12);
  const on=loadConfig({rootDir,methodConsolidationQueueEnabled:true,methodConsolidationRecallEnabled:true,
    methodPendingRetirementMountEnabled:true,methodConsolidationModelCalls:48});
  assert.equal(on.methodConsolidationQueueEnabled,true);
  assert.equal(on.methodConsolidationModelCalls,48);
});

test('an older unexamined pair gets a turn as higher similarity methods keep arriving', () => {
  const q=new MethodConsolidationQueue(persistentDocuments());
  const old={id:'old',payload:{status:'pending',examined:false,attempts:0,score:.61,enqueuedAt:'2026-01-01'}};
  const recent={id:'recent',payload:{status:'pending',examined:false,attempts:0,score:.99,enqueuedAt:'2026-11-11'}};
  const tried={id:'failed',payload:{status:'pending',examined:false,attempts:1,score:1,enqueuedAt:'2025-01-01',lastTriedAt:'2026-11-11'}};
  assert.deepEqual(q.pending([recent,old,tried]).map(row=>row.id),['old','recent','failed']);
});

test('failed bounded runs expose provider call receipts only for the opt-in budget', async () => {
  const {createLearningRuntime}=await import('../src/learningRuntime.mjs');
  const identity={userId:'u',runId:'r',sessionId:'s',dispatchId:'method-relations-test',capabilityId:'method-relations'};
  const runtime=createLearningRuntime({config:{},store:{userById:async()=>({id:'u'}),requireProject:async()=>({id:'evimed-learning',userId:'u'})},
    agentRuns:{list:async()=>[{id:'r',sessionId:'s',dispatchId:identity.dispatchId,status:'failed'}]},
    runtimeManager:{},researchSessions:{},registry:Promise.resolve(new Map()),usageLedger:{summaryRun:async()=>({calls:3})},prepareContext:async()=>({})});
  assert.deepEqual(await runtime.readResult(identity),{status:'failed'});
  assert.deepEqual(await runtime.readResult({...identity,includeUsage:true}),{status:'failed',usage:{calls:3}});
});

test('runtime mounting forwards the pending-retirement switch and removes stale directories', async () => {
  const {materializeCapsuleMethods}=await import('../src/capsuleMethods.mjs');
  const {mkdtemp,rm,readdir}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const root=await mkdtemp(`${tmpdir()}/p34-mount-`);
  const a=method('a'),b=method('b'),canonical=method('canonical');
  canonical.payload.provenance={pendingRetirements:[a,b].map(m=>({methodId:m.id,baseDigest:m.payload.contentDigest}))};
  const input={capsules:null,project:{id:'p',userId:'u',rootDir:root,runtimeDir:root},directory:`${root}/methods`,
    learning:{approvedMethods:async()=>[a,b,canonical]}};
  try {
    assert.equal((await materializeCapsuleMethods(input)).learned.length,3);
    assert.equal((await materializeCapsuleMethods({...input,methodSelection:{skipPendingRetirements:true}})).learned.length,1);
    assert.equal((await readdir(input.directory,{withFileTypes:true})).filter(entry=>entry.isDirectory()).length,1);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('turning recall on invalidates the previous queue policy without replaying unchanged peers', async () => {
  const documents=persistentDocuments(),methods=[method('a'),method('b')];
  const propose=async()=>[{a:'a',b:'b',score:.8}];
  const base=new MethodConsolidationQueue(documents,{version:'base1'});
  const initial=await base.sync('u','owned',methods,propose);
  const row=initial.rows[0];await base.save('u',row.id,{...row.payload,status:'done',examined:true},row);
  const recall=new MethodConsolidationQueue(documents,{version:'recall1'});
  const changed=await recall.sync('u','owned',methods,propose);
  assert.equal(changed.changed,2);
  assert.equal(changed.enqueued,1);
  assert.equal(recall.summary(changed.rows).backlog,1);
  assert.equal((await recall.sync('u','owned',methods,propose)).changed,0);
});

test('incremental screening includes incoming neighbours of a changed method', async () => {
  const sim=createMethodSimilarity({embed:async texts=>texts.map(text=>text.includes('vector-a')?[1,0]:text.includes('vector-b')?[.8,.6]:[0,1])});
  const pairs=await sim.pairs([method('a','vector-a'),method('b','vector-b'),method('c','vector-c')],{topK:1,floor:.59,onlyIds:['b']});
  assert.equal(pairs.length,2);
  assert.ok(pairs.every(pair=>pair.a==='b'||pair.b==='b'));
});

test('recall screening embeds the entire stored body separately from applicability', async () => {
  const seen=[];
  const sim=createMethodSimilarity({embed:async texts=>{seen.push(...texts);return texts.map(()=>[1,0]);}});
  const a=method('a');a.payload.body='long procedure '.repeat(1000)+'last constraint';
  await sim.pairs([a,method('b')],{applicability:true});
  assert.ok(seen.includes(a.payload.body));
  assert.ok(seen.includes('a\na'));
});

test('batched decisions cover every queued cross-group pair without exceeding eight bodies', async () => {
  const {queuedPairBatch}=await import('../src/methodConsolidationQueue.mjs');
  let pending=[];
  for(let a=0;a<10;a++)for(let b=a+1;b<10;b++)pending.push({id:`${a}:${b}`,payload:{a:String(a),b:String(b),examined:false}});
  const examined=new Set();
  while(pending.length) {
    const batch=queuedPairBatch(pending,pending[0],8);
    assert.ok(new Set(batch.flatMap(row=>[row.payload.a,row.payload.b])).size<=8);
    for(const row of batch){assert.ok(!examined.has(row.id));examined.add(row.id);}
    pending=pending.filter(row=>!examined.has(row.id));
  }
  assert.equal(examined.size,45);
});

test('one account call budget rotates between owned and shared libraries without mixing their inputs', async () => {
  const h=await harness({size:4,budget:1});
  for(const id of ['m2','m3']) {
    const row=await h.learning.getMethod('u',id);
    await h.documents.put('u','method',id,{...row.payload,provenance:{sourceProjectId:'geo'}},{expectedRevision:row.revision});
  }
  const rows=async()=>[...(await h.learning.listMethods('u',{limit:100})).items];
  const policyForJob=async job=>job.payload.sourceProjectId?{kind:'geo-project',ownerId:'u',controlProjectId:'geo'}:null;
  const scopedMethods=async(_user,policy)=>(await rows()).filter(row=>Boolean(row.payload.provenance?.sourceProjectId)===Boolean(policy?.kind==='geo-project'));
  const pass=h.make();pass.contextProvenance={rows,policyFor:async()=>({kind:'geo-project'}),policyForJob,scopedMethods,
    methodFor:async(user,id,policy)=>(await scopedMethods(user,policy)).find(row=>row.id===id),completedCompound:async()=>null};
  const first=await pass.sleep({job});
  assert.equal(first.coverage.modelCalls,1);
  assert.ok(h.calls[0].input.methods.every(m=>['m0','m1'].includes(m.id)));
  const next=await pass.sleep({job:{...job,id:'next'}});
  assert.equal(next.coverage.modelCalls,1);
  assert.ok(h.calls[1].input.methods.every(m=>['m2','m3'].includes(m.id)));
  assert.equal(next.coverage.backlog,0);
});

test('an examined batch held by an unproven merge costs no repeated DECIDE calls', async () => {
  const h=await harness({size:2,budget:3});
  const row=await h.learning.getMethod('u','m0');
  await h.documents.put('u','method',row.id,{...row.payload,provenance:{origin:'inferred',consolidatedBy:'consolidate:prior'}},{expectedRevision:row.revision});
  const pass=h.make();
  pass.readResult=async()=>({status:'succeeded',output:{assignments:[{ASSIGNMENT:'A1',SKILLS:['m0','m1'],RELATION_TYPE:'merge',REASON:'Same complete procedure.'}]}});
  const first=await pass.sleep({job});
  assert.equal(first.coverage.pendingBuilds,1);
  const second=await pass.sleep({job:{...job,id:'later'}});
  assert.equal(second.coverage.backlog,0);
  assert.equal(second.coverage.pendingBuilds,1);
  assert.equal(second.coverage.blockedUnproven,1);
  assert.equal(second.coverage.modelCalls,0);
  assert.equal(h.calls.length,1);
});

test('queued conflicts record their edges without buying a builder that can change nothing', async () => {
  const h=await harness({size:2});const pass=h.make();
  pass.readResult=async()=>({status:'succeeded',output:{assignments:[{ASSIGNMENT:'A1',SKILLS:['m0','m1'],RELATION_TYPE:'conflicts_with',REASON:'Incompatible instructions in the same situation.'}]}});
  const result=await pass.sleep({job});
  assert.equal(result.coverage.pendingBuilds,0);
  assert.equal(h.calls.length,1);
  assert.equal(result.relationTypes.conflicts_with,2);
});

test('a transiently failed pair gets another turn despite a steady stream of new methods', () => {
  const q=new MethodConsolidationQueue(persistentDocuments());
  const failed={id:'failed',payload:{status:'pending',examined:false,attempts:1,score:.6,enqueuedAt:'2026-01-01',lastTriedAt:'2026-11-01'}};
  const fresh={id:'fresh',payload:{status:'pending',examined:false,attempts:0,score:.99,enqueuedAt:'2026-11-10'}};
  assert.equal(q.pending([fresh,failed])[0].id,'failed');
});
