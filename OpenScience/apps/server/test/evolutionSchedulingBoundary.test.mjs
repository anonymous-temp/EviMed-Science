import test from 'node:test';
import assert from 'node:assert/strict';
import {EvolutionWorker} from '../src/evolutionWorker.mjs';
import {EvolutionMaintenance} from '../src/evolutionMaintenance.mjs';
import {EvolutionDecisions} from '../src/evolutionDecisions.mjs';
import {EvolutionService} from '../src/evolutionService.mjs';

test('monthly UTC windows retain the proper monthly key across Shanghai month and year boundaries',async()=>{
 for(const [instant,month,metricsMonth,localDay] of [
  ['2026-09-30T16:30:00Z','2026-09','2026-08','2026-10-01'],
  ['2026-10-01T00:30:00Z','2026-10','2026-09','2026-10-01'],
  ['2026-12-31T16:30:00Z','2026-12','2026-11','2027-01-01'],
  ['2027-01-01T00:30:00Z','2027-01','2026-12','2027-01-01'],
 ]){
  const jobs=[];const service={now:()=>new Date(instant),tools:async()=>[],list:async()=>[],owner:async()=>'operator',get:async()=>null,save:async()=>{},enqueue:async(kind,payload,key)=>jobs.push({kind,payload,key}),ingestEvent:async()=>{}};
  await new EvolutionWorker({service}).housekeeping();
  const monthly=jobs.find(row=>row.key.startsWith('monthly-v2:'));assert.deepEqual(monthly,{kind:'maintain',payload:{month,metricsMonth},key:`monthly-v2:${month}`});
  assert.ok(jobs.some(row=>row.key===`daily-scout:${localDay}`),'daily scheduling retains Shanghai day');
 }
});

test('resource release replay asks nobody and repeated replay preserves the same informational disposition',async()=>{
 const rows=new Map();const time=new Date('2026-10-04T00:00:00Z');
 const documents={
  get:async(owner,kind,id)=>structuredClone(rows.get(`${owner}:${kind}:${id}`)??null),
  list:async(owner,kind,{filter})=>({items:[...rows.values()].filter(row=>row.payload.recordType===filter.recordType),nextCursor:null}),
  put:async(owner,kind,id,payload,{expectedRevision,projectId})=>{const key=`${owner}:${kind}:${id}`,old=rows.get(key);assert.equal(old?.revision??0,expectedRevision);const row={id,payload:structuredClone(payload),projectId,revision:expectedRevision+1,createdAt:old?.createdAt??time.toISOString()};rows.set(key,row);return structuredClone(row);},
 };
 const service=new EvolutionService({documents,ownerId:'operator',now:()=>time,jobs:{enqueue:async()=>{}},config:{}});
 const decisions=new EvolutionDecisions({service});
 const maintenance=new EvolutionMaintenance({service,callbacks:{proposeReview:input=>decisions.propose(input)}});
 const tool={id:'tool-existing',payload:{status:'active',artifactDigest:`sha256:${'a'.repeat(64)}`}};
 const first=await maintenance.releaseReplay(tool,{ok:false,status:'waiting_resource',resourceCode:'runtime_limit_exceeded'},'release-v1');
 const second=await maintenance.releaseReplay(tool,{ok:false,status:'waiting_resource'},'release-v1');
 assert.deepEqual(first,second);assert.equal(first.disposition,'resource');
 // Owner ruling of 2026-10-12: a wait for material only an outside party can bring makes no decision, no card and no inbox line.
 assert.equal((await service.list('decision')).length,0);assert.equal(decisions.counters.resourceWaits['release-replay-resource'],2);assert.equal(tool.payload.status,'active');
});

// Live acceptance of 2026-10-05 found a dossier's second branch waiting with no record to answer. Since 2026-10-12 a validation wait asks nobody: it is the branch's
// own annotation on the dossier, written once per branch, and a rescout still opens the next branch, which is annotated in turn.
test('a validation wait is a silent annotation on its dossier, one per branch, and makes no decision',async()=>{
 const {evolutionValidationWait}=await import('../src/evolutionDecisions.mjs');
 const rows=new Map();const time=new Date('2026-10-05T14:00:00Z');
 const documents={
  get:async(owner,kind,id)=>structuredClone(rows.get(`${owner}:${kind}:${id}`)??null),
  list:async(owner,kind,{filter})=>({items:[...rows.values()].filter(row=>row.payload.recordType===filter.recordType).map(row=>structuredClone(row)),nextCursor:null}),
  put:async(owner,kind,id,payload,{expectedRevision,projectId})=>{const key=`${owner}:${kind}:${id}`,old=rows.get(key);assert.equal(old?.revision??0,expectedRevision);const row={id,payload:structuredClone(payload),projectId,revision:expectedRevision+1,createdAt:old?.createdAt??time.toISOString()};rows.set(key,row);return structuredClone(row);},
 };
 const service=new EvolutionService({documents,ownerId:'operator',now:()=>time,jobs:{enqueue:async()=>{}},config:{}});
 const executed=[];const decisions=new EvolutionDecisions({service,callbacks:{execute:async action=>{executed.push(action);return{state:'queued'};}}});
 const dossierId='evolution-dossier-one',goal='g';
 await service.save('dossier',dossierId,{methodId:'m',status:'waiting_resource'});
 const first=await decisions.propose(evolutionValidationWait({dossierId,goal}));
 assert.equal(first.payload.resourceWait.category,'validation-resource');assert.equal(first.payload.resourceWait.branch,1);assert.equal(first.payload.status,'waiting_resource');
 const again=await decisions.propose(evolutionValidationWait({dossierId,goal}));
 assert.equal(again.revision,first.revision,'the same branch is annotated once');
 const second=await decisions.propose(evolutionValidationWait({dossierId,decisionActionId:'branch-two',goal}));
 assert.equal(second.payload.resourceWait.branch,'branch-two');assert.equal(second.revision,first.revision+1);
 assert.equal((await service.list('decision')).length,0,'no decision, so nothing to deliver, answer or expire');assert.equal(executed.length,0);
 assert.deepEqual(decisions.counters.resourceWaits,{'validation-resource':2});
 // A dossier that cannot be written does not fail the job that found the wait.
 const broken=new EvolutionDecisions({service:{get:async()=>{throw new Error('ledger unavailable');}}});
 assert.equal(await broken.propose(evolutionValidationWait({dossierId,goal})),null);assert.equal(broken.counters.resourceWaitFailed,1);
 // The build proposes its wait through this record with its branch.
 const composition=await (await import('node:fs/promises')).readFile(new URL('../src/evolutionComposition.mjs',import.meta.url),'utf8');
 assert.ok(composition.includes('decisions.propose(evolutionValidationWait({ dossierId: dossier.id, decisionActionId, goal: card.goal }))'));
 assert.ok(!composition.includes('"validation-resource"'));
});
