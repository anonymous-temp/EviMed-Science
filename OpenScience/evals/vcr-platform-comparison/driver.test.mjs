import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promptFor, runCase, usageBound } from './run.mjs';

test('unknown usage retains the full reservation and known overage is never hidden',()=>{
  assert.equal(usageBound(null,5),5);
  assert.equal(usageBound({currency:'CNY',actualCost:0.25,reservedCalls:0,uncertainCalls:0},5),.25);
  assert.equal(usageBound({currency:'CNY',actualCost:7},5),7);
  assert.equal(usageBound({currency:'CNY',actualCost:2,reservedCost:4,reservedCalls:1},5),6);
  assert.equal(usageBound({currency:'CNY',actualCost:NaN},5),5);
});

test('known-candidate and retrieval tasks are explicitly different',()=>{
  assert.match(promptFor({collection:'sigir',task:'matching'},{id:'p'}),/trials.txt/);
  const retrieval=promptFor({collection:'trec',task:'retrieval'},{id:'p'});
  assert.match(retrieval,/500/);assert.doesNotMatch(retrieval,/trials.txt/);
  assert.throws(()=>promptFor({collection:'x',task:'invalid'},{id:'p'}));
});

test('a pre-aborted campaign cannot register an account or dispatch',async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-abort-'));const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('Must not contact the server');};
  try{
    const result=await runCase({base:'http://127.0.0.1:9',example:{id:'p'},manifest:{collection:'x'},out:tmp,signal:AbortSignal.abort()});
    assert.equal(calls,0);assert.equal(result.status,'interrupted');assert.equal(result.accountId,undefined);
  }finally{globalThis.fetch=original;await fs.rm(tmp,{recursive:true,force:true});}
});

test('server rejects remote and query-overridden database URLs before importing the application',()=>{
  for(const url of ['postgresql://example.com/evimed_test_x','postgresql://127.0.0.1/evimed_test_x?host=example.com']){
    const env={...process.env};
    for(const key of ['EVAL_PERSONA','EVAL_FAULT','LIVE_HOOK','EVAL_KERNEL_ENV'])delete env[key];
    for(const key of ['OS','TREE_DIR','LIVE_DIR','LIVE_DATA','DSH_BIN','EVAL_DEEPSEEK_KEY_FILE','VCR_COLLECTION_MANIFEST'])env[key]='/nonexistent-benchmark-test';
    env.LIVE_DATABASE_URL=url;env.VCR_BENCHMARK_BUDGET_FILE='/nonexistent-benchmark-test/budget.json';
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{env,encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/dedicated local test database/);
    assert.doesNotMatch(result.stderr,/Cannot find module|connection refused/i);
  }
});

for(const failure of [false,true,'project','poll'])test(`real account helper deletes after ${failure==='project'?'project failure':failure==='poll'?'poll failure':failure?'dispatch failure':'completion'}`,async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-driver-'));
  let registered=0,deleted=0,stopped=0,dispatched=false,project=null,polls=0;
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const body=text?JSON.parse(text):{};let data={},status=200;
    const route=req.url;
    if(route==='/api/auth/register'){registered++;status=201;data={csrfToken:'fixture-csrf',user:{id:body.username}};res.setHeader('set-cookie','fixture=1; Path=/');}
    else if(route==='/api/projects'){project=body.id;data={id:body.id};if(failure==='project')status=500;}
    else if(route==='/api/files/upload')data={source:{id:'source-fixture'}};
    else if(route==='/api/runtime/sessions')data={id:'fixture-session'};
    else if(route==='/api/agent-runs/dispatch'){
      assert.equal(body.automated,true);assert.equal(req.headers['x-evimed-automated'],'1');
      assert.ok(req.headers['x-open-science-project']);assert.equal(body.line,'answer');
      dispatched=true;data={id:'fixture-run'};status=failure===true?500:202;
    }else if(route==='/api/agent-runs'){polls++;data=[{id:'fixture-run',automated:true,status:'completed'}];if(failure==='poll'&&polls===1)status=500;}
    else if(route==='/api/vcr/studies')data={conversationStudies:dispatched?[{id:'study',projectId:project,originatingSessionId:'fixture-session',tabs:['matching']}]:[]};
    else if(route==='/api/vcr/studies/study/jobs')data={jobs:[]};
    else if(route.startsWith('/api/vcr/studies/study/matching')){
      const selected=new URL(route,'http://localhost').searchParams.get('candidate');
      data={candidateRoster:['patient_1'],opensOnPatient:'patient_1',patientTrials:{subject:selected,
        trials:selected?[{id:'trial_1',registryId:'NCT00000001'}]:[],selected:selected?{id:'trial_1',criteria:[{kind:'inclusion',text:'Age >= 18',state:'satisfied'}]}:null}};
    }
    else if(route==='/api/commands/stop_runtime'){stopped++;}
    else if(route==='/api/account/usage')data={currency:'CNY',actualCost:.12,reservedCalls:0,uncertainCalls:0};
    else if(route==='/api/account'&&req.method==='DELETE'){deleted++;assert.ok(body.confirm);assert.ok(body.password);}
    res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({data}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const file=path.join(tmp,'patient.txt');await fs.writeFile(file,'A public synthetic patient.');
    const example={id:'p1',files:[{name:'patient.txt',path:file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')}]};
    const record=await runCase({base:`http://127.0.0.1:${server.address().port}`,example,manifest:{collection:'sigir',task:'matching'},out:tmp});
    assert.equal(registered,1);assert.equal(deleted,1);assert.ok(failure==='project'||stopped>=1);assert.equal(dispatched,failure!=='project');
    assert.equal(record.cleanup.deleted,true);assert.equal(record.status,failure?'failed':'settled');
    if(!failure){assert.equal(record.studyId,'study');assert.equal(record.matching.patientTrials.subject,'patient_1');assert.equal(record.trialDetails.length,1);}
    if(failure==='poll')assert.ok(Object.hasOwn(record,'transcript'),'failed poll still preserves partial evidence before shutdown');
    assert.doesNotMatch(await fs.readFile(path.join(tmp,'p1/case.json'),'utf8'),/fixture-csrf|fixture=1/);
  }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(tmp,{recursive:true,force:true});}
});
