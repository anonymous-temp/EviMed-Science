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

test('resource release replay composes with actual decisions and repeated replay preserves the same informational disposition',async()=>{
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
 const saved=await service.list('decision');assert.equal(saved.length,1);assert.equal(saved[0].revision,1);assert.equal(saved[0].payload.decisionClass,'D');
 assert.equal(saved[0].payload.status,'pending');assert.equal(saved[0].payload.recommended,'wait');assert.equal(saved[0].payload.conservative,'wait');assert.equal(saved[0].payload.alternative,'wait');
 assert.deepEqual(saved[0].payload.options.map(row=>row.operation),['wait','keep']);assert.equal(tool.payload.status,'active');
});
