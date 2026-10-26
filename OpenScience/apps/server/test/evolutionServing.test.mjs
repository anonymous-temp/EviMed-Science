import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createEvolutionServing } from '../src/evolutionServing.mjs';
import { evolutionServiceFixture } from './helpers/evolutionServiceFixture.mjs';

function fixture(){
 const f=evolutionServiceFixture();let next=null;
 const jobs={...f.service.jobs,claim:async kinds=>{assert.deepEqual(kinds,['evolution-event','evolution-decision']);const job=next;next=null;return job;},renew:async()=>true,finish:async()=>({status:'complete'}),fail:async()=>({status:'deferred'})};
 const user={id:'operator'};
 const facade=createEvolutionServing({config:{evolutionEnabled:true,operatorUsers:['operator'],dataDir:'/unused'},documents:f.documents,jobs,database:{query:async()=>({rows:[]})},store:{userById:async()=>user,projectFor:async()=>({id:'evolution'}),ensureSessionUser:async()=>({user}),assertCsrf:async()=>{},requireProject:async()=>({id:'p',userId:user.id})},registry:Promise.resolve({list:()=>[]}),runtimeManager:{},controller:{},agentRuns:{list:async()=>[]},notifications:f.service.notifications,autopilot:{wakeForEvolution:async()=>({woken:true})}});
 return {...f,facade,queue(job){next=job;}};
}
test('actual serving composition constructs no experimental engine and processes account feedback',async()=>{
 const f=fixture(),s=f.facade;
 assert.equal(s.loops,undefined);assert.equal(s.model,undefined);assert.equal(s.runs,undefined);assert.equal(s.worker.status().experimentScheduling,false);
 await s.integration.publish({id:'feedback',type:'researcher-feedback',userId:'operator',projectId:'p',runId:'r',sourceFeedbackId:'feedback',trigger:'corrected',correctionKind:'result'});
 const job=f.jobs.find(item=>item.kind==='evolution-event');assert.ok(job);f.queue({...job,id:'job',userId:'operator',leaseToken:'lease'});
 await s.worker.tick();const row=await s.service.get(job.payload.eventId,'operator');assert.equal(row.payload.status,'processed');assert.equal(f.jobs.some(item=>/mission|build|scout/.test(item.kind)),false);await s.worker.close();
});
test('serving routes preserve historical reads and reject experiment writes before queueing',async()=>{
 const {facade}=fixture();
 const invoke=async(method,url)=>{let result;const req=Object.assign(Readable.from([]),{method,url,headers:{}}),res={setHeader(){},writeHead(){},end(text){result=JSON.parse(text);}};await facade.routes(req,res);return result;};
 assert.equal((await invoke('GET','/api/evolution/status')).data.experimentScheduling,false);
 assert.deepEqual((await invoke('GET','/api/evolution/missions')).data,[]);
 await assert.rejects(invoke('POST','/api/evolution/prospective/register'),error=>error.status===409&&error.code==='evolution_offline_only');await facade.worker.close();
});
test('serving import closure cannot reach experimental constructors',async()=>{
 const visited=new Set();const forbidden=/\/(?:evolutionComposition|evolutionLoops|evolutionRuns|evolutionScout|evolutionBuild|evolutionPolicyTrial|evolutionMissions)\.mjs$/;
 async function visit(url){if(visited.has(url.href))return;visited.add(url.href);assert.equal(forbidden.test(url.pathname),false,url.pathname);const text=await readFile(url,'utf8');for(const match of text.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+\.mjs)['"]/g))await visit(new URL(match[1],url));}
 await visit(new URL('../src/evolutionServing.mjs',import.meta.url));
});
test('dataset continuation preserves a durable deferred self-check intent and never claims scientific completion',async()=>{
 const {facade}=fixture(),s=facade.service;
 await s.save('tool','existing-tool',{track:'M',status:'active',validationLevel:'V0',artifactDigest:'pin'});
 const waiter=await s.waitFor({userId:'operator',projectId:'p',agendaId:'agenda',toolId:'existing-tool',dataRequirements:{schema:{fields:[]}}});
 await s.resolveWaiters({type:'dataset-ready',id:'data-event',userId:'operator',projectId:'p',datasetId:'data',dataset:{semanticsChecksPassed:true}});
 const current=await s.get(waiter.id,'operator');assert.equal(current.payload.status,'waiting');assert.equal(current.payload.selfCheckIntent.reason,'evolution_offline_only');assert.equal(current.payload.selfCheckIntent.sourceEventId,'data-event');await facade.worker.close();
});
