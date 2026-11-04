import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promptFor, readModelCallReceipts, reconcileCampaignReceipts, runCase, upstreamFailureWindow, usageBound } from './run.mjs';

test('upstream breaker only counts distinct explicit same-run provider refusals in the window', async()=>{
  const now=Date.now(), startedAt=new Date(now-120000).toISOString();
  const row=(i,extra={})=>({callId:`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`,projectId:'p',runId:'r',finishedAt:new Date(now-1000*i).toISOString(),dispatch:'rejected',outcome:'failed',errorCode:'model_gateway_upstream_error',upstreamStatus:503,...extra});
  const check=rows=>upstreamFailureWindow(rows,{projectId:'p',runId:'r',startedAt,now});
  assert.equal(check([row(1),row(2)]),null);
  assert.equal(check([row(1),row(1),row(2)]),null);
  for(const extra of [{projectId:'other'},{runId:'other'},{upstreamStatus:400},{dispatch:'accepted'},{errorCode:'model_gateway_timeout'},{finishedAt:new Date(now-63000).toISOString()}]) assert.equal(check([row(1),row(2),row(3,extra)]),null);
  assert.equal(check([row(1),row(2),row(3)]).events.length,3);
  assert.equal(check([row(1,{errorCode:'model_gateway_rate_limited',upstreamStatus:429})]),null);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-receipt-'));
  try {const file=path.join(dir,'calls');await fs.writeFile(file,JSON.stringify(row(1))+'\n'+JSON.stringify(row(2))+'\n'+JSON.stringify(row(3)).slice(0,25));
    assert.equal((await readModelCallReceipts(file)).length,2);assert.equal(check(await readModelCallReceipts(file)),null);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('post-shutdown reconciliation retains late evidence without rewriting case outcomes',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-reconcile-'));
  try {
    const receiptPath=path.join(dir,'calls.jsonl'),startedAt=new Date(Date.now()-3000).toISOString();
    await fs.writeFile(path.join(dir,'FROZEN.json'),JSON.stringify({modelCallsHostPath:receiptPath}));
    const cases=[{id:'p1',caseId:'p1',projectId:'p',runId:'r',startedAt,status:'settled'}];
    await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify({status:'finished',cases}));
    const lines=Array.from({length:3},(_,i)=>JSON.stringify({callId:`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`,projectId:'p',runId:'r',finishedAt:new Date().toISOString(),dispatch:'rejected',outcome:'failed',errorCode:'model_gateway_upstream_error',upstreamStatus:503}));
    await fs.writeFile(receiptPath,lines.join('\n')+'\n');
    const result=await reconcileCampaignReceipts(dir);assert.equal(result.circuitBreaker.originCaseId,'p1');
    const after=JSON.parse(await fs.readFile(path.join(dir,'summary.json'),'utf8'));
    assert.equal(after.status,'finished');assert.deepEqual(after.cases,cases);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

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

for(const failure of [false,true,'project','poll','breaker','late_breaker'])test(`real account helper deletes after ${failure==='project'?'project failure':failure==='poll'?'poll failure':failure==='breaker'||failure==='late_breaker'?'upstream breaker':failure?'dispatch failure':'completion'}`,async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-driver-'));
  let registered=0,deleted=0,stopped=0,dispatched=false,project=null,polls=0,canceled=false;
  const receiptPath=path.join(tmp,'model-calls.jsonl');
  const lateRow=i=>JSON.stringify({callId:`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`,projectId:'prior-project',runId:'prior-run',finishedAt:new Date().toISOString(),dispatch:'rejected',outcome:'failed',errorCode:'model_gateway_upstream_error',upstreamStatus:503});
  if(failure==='late_breaker')await fs.writeFile(receiptPath,lateRow(0)+'\n'+lateRow(1)+'\n');
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
      if(failure==='breaker')await fs.writeFile(receiptPath,Array.from({length:3},(_,i)=>JSON.stringify({callId:`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`,projectId:project,runId:'fixture-run',finishedAt:new Date().toISOString(),dispatch:'rejected',outcome:'failed',errorCode:'model_gateway_upstream_error',upstreamStatus:503})).join('\n')+'\n');
      if(failure==='late_breaker')await fs.appendFile(receiptPath,lateRow(2)+'\n');
    }else if(route==='/api/agent-runs'){polls++;data=[{id:'fixture-run',automated:true,status:['breaker','late_breaker'].includes(failure)&&!canceled?'running':'completed'}];if(failure==='poll'&&polls===1)status=500;}
    else if(route==='/api/agent-runs/fixture-run/cancel'){canceled=true;}
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
    const record=await runCase({base:`http://127.0.0.1:${server.address().port}`,example,manifest:{collection:'sigir',task:'matching'},out:tmp,receiptPath,
      priorScopes:failure==='late_breaker'?[{caseId:'prior',projectId:'prior-project',runId:'prior-run',startedAt:new Date(Date.now()-60000).toISOString()}]:[]});
    assert.equal(registered,1);assert.equal(deleted,1);assert.ok(failure==='project'||stopped>=1);assert.equal(dispatched,failure!=='project');
    assert.equal(record.cleanup.deleted,true);assert.equal(record.status,['breaker','late_breaker'].includes(failure)?'upstream_stopped':failure?'failed':'settled');
    if(['breaker','late_breaker'].includes(failure)){assert.equal(canceled,true);assert.equal(record.circuitBreaker.events.length,3);assert.ok(record.transcript);}
    if(failure==='late_breaker')assert.equal(record.circuitBreaker.originCaseId,'prior');
    if(!failure){assert.equal(record.studyId,'study');assert.equal(record.matching.patientTrials.subject,'patient_1');assert.equal(record.trialDetails.length,1);}
    if(failure==='poll')assert.ok(Object.hasOwn(record,'transcript'),'failed poll still preserves partial evidence before shutdown');
    assert.doesNotMatch(await fs.readFile(path.join(tmp,'p1/case.json'),'utf8'),/fixture-csrf|fixture=1/);
  }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(tmp,{recursive:true,force:true});}
});

for(const mode of ['complete','missing','failed'])test('protocol matching uses normal isolated conversation and saved assessment ('+mode+')',async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'n2c2-driver-synthetic-'));
  const definition=JSON.parse(await fs.readFile(new URL('./n2c2-protocol.json',import.meta.url),'utf8'));
  const calls=[],uploads=[];
  let project=null,dispatched=false,polls=0,deleted=0;
  const server=createServer(async(req,res)=>{
    let bodyText='';for await(const part of req)bodyText+=part;
    const body=bodyText?JSON.parse(bodyText):{};
    const route=req.url;calls.push({method:req.method,route});
    let status=200,data={};
    if(route==='/api/auth/register'){status=201;data={csrfToken:'fixture-only',user:{id:body.username}};res.setHeader('set-cookie','synthetic=1; Path=/');}
    else if(route==='/api/projects'){project=body.id;data={id:project};}
    else if(route==='/api/files/upload'){uploads.push(Buffer.from(body.data,'base64').toString());data={source:{id:'uploaded-synthetic'}};}
    else if(route==='/api/runtime/sessions')data={id:'session-fixture'};
    else if(route==='/api/agent-runs/dispatch'){
      assert.equal(body.automated,true);assert.equal(body.line,'answer');assert.match(body.text,/trial_to_patient/);
      assert.equal(req.headers['x-evimed-automated'],'1');
      assert.doesNotMatch(body.text,/NCT\d/);dispatched=true;status=202;data={id:'run-fixture'};
    }else if(route==='/api/agent-runs'){
      polls++;status=mode==='failed'&&polls===1?500:200;data=[{id:'run-fixture',automated:true,status:'completed'}];
    }else if(route==='/api/vcr/studies')data={conversationStudies:dispatched?[{id:'study-fixture',projectId:project,originatingSessionId:'session-fixture'}]:[]};
    else if(route==='/api/vcr/studies/study-fixture/jobs')data={jobs:[]};
    else if(route.startsWith('/api/vcr/studies/study-fixture/matching')){
      const query=new URL(route,'http://localhost').searchParams;
      assert.equal(query.get('direction'),'trial_to_patient');
      const selected=query.get('candidate');
      data={direction:'trial_to_patient',candidateRoster:['subject-fixture'],protocolVersionId:'protocol-fixture',
        selected:selected&&mode!=='missing'?{assessmentId:'assessment-fixture',candidate:{id:'subject-fixture'},
          criteria:definition.criteria.map((row,i)=>({criterionId:'criterion-'+i,kind:'inclusion',text:row.text,
            state:i===0?'unknown':'satisfied',applicable:true,decidedBy:i===0?'model':'code'}))}:null};
    }else if(route==='/api/account/usage')data={currency:'CNY',actualCost:0,reservedCalls:0,uncertainCalls:0};
    else if(route==='/api/account'&&req.method==='DELETE'){deleted++;assert.ok(body.confirm);assert.ok(body.password);}
    res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({data}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const files=[];
    for(const[name,text]of [['patient.txt','Record date: 2020-01-15\nA fabricated fixture for an offline transport test.'],
      ['protocol.txt',definition.criteria.map(row=>'['+row.tag+'] '+row.text).join('\n')]]){
      const file=path.join(tmp,name);await fs.writeFile(file,text);
      files.push({path:file,name,sha256:createHash('sha256').update(text).digest('hex')});
    }
    const record=await runCase({base:'http://127.0.0.1:'+server.address().port,
      example:{id:'n2c2-test-001',asOf:'2020-01-15',files},
      manifest:{dataset:'n2c2-2018-t1',task:'protocol_matching'},out:tmp});
    assert.equal(record.cleanup.deleted,true);assert.equal(deleted,1);assert.equal(uploads.length,2);
    assert.ok(uploads.every(text=>!/<TAGS|\bmet="/.test(text)));
    assert.ok(!calls.some(call=>/trial_registry_record|vcr_write/.test(call.route)));
    assert.equal(record.status,mode==='complete'?'settled':mode==='missing'?'missing_feature_result':'failed');
    if(mode==='complete'){assert.equal(record.matching.selected.assessmentId,'assessment-fixture');assert.equal(record.matching.selected.criteria.length,13);}
    if(mode==='failed')assert.ok(record.partialMatching);
    assert.equal(record.trialDetails?.length??0,0);
  }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(tmp,{recursive:true,force:true});}
});
