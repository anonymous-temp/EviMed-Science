import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAnalysisInput, analysisFilename, analysisFields } from '../src/dataAnalysisInputs.mjs';

test('input names and closed payloads reject path and credential injection', () => {
  for (const name of ['../x.csv', 'a/b.csv', 'a\\b.csv', '.env', 'a\r\nb.csv', '']) assert.throws(() => analysisFilename(name));
  assert.equal(analysisFilename('trial data.csv'), 'trial data.csv');
  assert.throws(() => analysisFields({url:'https://example.org',headers:{authorization:'secret'}},['url']));
});
test('raw HTTPS input validates every redirect before another transport call', async () => {
  let calls = 0;
  const transport = async () => { calls++; return {status:302,headers:{location:'http://127.0.0.1/internal'},body:Buffer.alloc(0)}; };
  await assert.rejects(fetchAnalysisInput({url:'https://example.org/a.csv',transport,maxBytes:100}), /public|https/i);
  assert.equal(calls,1);
});
test('credentials never cross a redirect origin and bytes are bounded', async () => {
  const headers = [];
  const body = await fetchAnalysisInput({url:'https://example.org/a.csv',authorization:'Bearer secret',maxBytes:100,
    transport:async request => {headers.push(request.headers);return headers.length===1 ? {status:302,headers:{location:'https://example.net/b.csv'},body:Buffer.alloc(0)} : {status:200,headers:{},body:Buffer.from('x,y\n1,2')};}});
  assert.equal(body.toString(),'x,y\n1,2'); assert.equal(headers[0].authorization,'Bearer secret'); assert.equal(headers[1].authorization,undefined);
  await assert.rejects(fetchAnalysisInput({url:'https://example.org',maxBytes:2,transport:async()=>({status:200,headers:{},body:Buffer.from('abc')})}), /limit/i);
});

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataAnalysisService } from '../src/dataAnalysisService.mjs';
import { projectDisplayName } from '../src/store.mjs';
import { HttpError } from '../src/security.mjs';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'analysis-api-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const rows=new Map(),projects=new Map(),runs=[];let dispatches=0;
  const dispatchLocks=new Set();
  const documents={database:{transaction:async fn=>{let lock=null;try{return await fn({query:async(sql,args)=>{if(sql.includes('pg_try_advisory')){const key=args.join(':');if(dispatchLocks.has(key))return {rows:[{locked:false}]};dispatchLocks.add(key);lock=key;return {rows:[{locked:true}]};}return {rows:[]};}});}finally{if(lock)dispatchLocks.delete(lock);}}},get:async(user,kind,id)=>structuredClone(rows.get(`${user}:${id}`)??null),put:async(user,kind,id,payload,options)=>{
    const key=`${user}:${id}`,previous=rows.get(key);if((previous?.revision??0)!==options.expectedRevision)throw new HttpError(409,'product_revision_conflict','Conflict');
    const record={id,revision:(previous?.revision??0)+1,payload:structuredClone(payload)};rows.set(key,record);return structuredClone(record);
  },remove:async(user,kind,id)=>{rows.delete(`${user}:${id}`);}};
  const store={requireProject:async(user,id)=>{const project=projects.get(`${user.id}:${id}`);if(!project)throw new HttpError(404,'project_not_found','Missing');return project;},
    listProjects:async user=>[...projects.values()].filter(project=>project.userId===user.id)};
  const withDispatchLock=async(user,turn,operation)=>{const key=`${user}:${turn}`;if(dispatchLocks.has(key))return operation(null);dispatchLocks.add(key);try{return await operation(async()=>{});}finally{dispatchLocks.delete(key);}};
  const deps={documents,store,withDispatchLock,config:{dataDir:directory,dataAnalysisMaxInputBytes:1024,dataAnalysisMaxArtifactBytes:1024*64,dataAnalysisMaxSnapshotBytes:1024*128},
    createProject:async(user,body)=>{const key=`${user.id}:${body.id}`;if(projects.has(key))throw new HttpError(409,'project_exists','Exists');const workspaceDir=path.join(directory,'projects',body.id);await fs.mkdir(workspaceDir,{recursive:true});projects.set(key,{id:body.id,userId:user.id,workspaceDir});},
    upload:async(user,project,relative,buffer)=>{const file=path.join(project.workspaceDir,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,buffer);},
    createSession:async()=> 'session-analysis',
    dispatch:async(user,project,sessionId,dispatchId,text,options)=>{dispatches++;assert.equal(options.unattended,true);assert.equal(options.automated,true);const run={id:`run_${dispatches}`,projectId:project.id,sessionId,dispatchId,status:'running',artifacts:[]};runs.push(run);return run;},
    // The shared project teardown, as far as this service can see it: the project, its workspace and (by the foreign key) its documents go.
    deleteProject:async(user,project)=>{projects.delete(`${user.id}:${project.id}`);for(const [key,row] of [...rows])if(row.payload.projectId===project.id)rows.delete(key);await fs.rm(project.workspaceDir,{recursive:true,force:true});},
    listRuns:async project=>runs.filter(run=>run.projectId===project.id),cancel:async(project,run)=>{run.status='cancelled';}};
  return {deps,service:new DataAnalysisService(deps),rows,projects,runs,user:{id:'alice'},dispatches:()=>dispatches};
}

test('API analysis names retain their full contract length while the backing project uses its own display limit',async t=>{
  const f=await fixture(t),create=f.deps.createProject,seen=[];
  f.deps.createProject=async(user,body)=>{seen.push(projectDisplayName(body.name));return create(user,body);};
  f.service=new DataAnalysisService(f.deps);
  const name='A long clinical analysis title with multiple data views and an explicit correction stage';
  const analysis=await f.service.create(f.user,{name,requestId:'long-name'});
  assert.equal(analysis.name,name);
  assert.ok([...seen[0]].length<=40);
  assert.equal((await f.service.create(f.user,{name,requestId:'long-name'})).id,analysis.id);
  const unicodeName='🧬'.repeat(120);
  assert.equal((await f.service.create(f.user,{name:unicodeName,requestId:'unicode-name'})).name,unicodeName);
});

test('serial lifecycle persists idempotency across restart and freezes historical files',async t=>{
  const f=await fixture(t),{user}=f,analysis=await f.service.create(user,{name:'Study',requestId:'create-1'});
  assert.equal((await f.service.create(user,{name:'Study',requestId:'create-1'})).id,analysis.id);
  await assert.rejects(f.service.create(user,{name:'Different',requestId:'create-1'}),{code:'analysis_request_conflict'});
  const input=await f.service.input(user,analysis.id,{filename:'data.csv',base64:Buffer.from('x\n1').toString('base64')});
  assert.equal(input.bytes,3);
  const turn=await f.service.turn(user,analysis.id,{question:'Summarize',requestId:'turn-1'});assert.equal(turn.status,'running');
  await assert.rejects(f.service.input(user,analysis.id,{filename:'other.csv',base64:'eA=='}),{code:'analysis_busy'});
  f.service=new DataAnalysisService(f.deps);
  assert.equal((await f.service.turn(user,analysis.id,{question:'Summarize',requestId:'turn-1'})).runId,turn.runId);assert.equal(f.dispatches(),1);
  await assert.rejects(f.service.turn(user,analysis.id,{question:'Other',requestId:'turn-1'}),{code:'analysis_request_conflict'});
  await assert.rejects(f.service.turn(user,analysis.id,{question:'Next',requestId:'turn-2'}),{code:'analysis_busy'});
  const project=await f.deps.store.requireProject(user,analysis.projectId);
  await fs.writeFile(path.join(project.workspaceDir,'report.md'),'Original finding');
  await fs.writeFile(path.join(project.workspaceDir,'analysis-results.json'),JSON.stringify({schemaVersion:1,analyses:[{estimate:2}]}));
  f.runs[0].status='succeeded';f.runs[0].artifacts=['report.md','analysis-results.json'];
  const result=await f.service.result(user,analysis.id,turn.id);assert.equal(result.result.summary,'Original finding');assert.equal(result.result.structuredResults.analyses[0].estimate,2);
  await f.service.turn(user,analysis.id,{question:'Next',requestId:'turn-2'});
  await fs.writeFile(path.join(project.workspaceDir,'report.md'),'Changed finding');
  const artifact=result.result.artifacts.find(a=>a.filename==='report.md');assert.equal((await f.service.artifact(user,analysis.id,artifact.id)).buffer.toString(),'Original finding');
  await assert.rejects(f.service.artifact({id:'mallory'},analysis.id,artifact.id),{code:'analysis_not_found'});
});

test('independent analyses run concurrently; same analysis CAS admits one; cancellation retains partial results',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'A',requestId:'a'}),b=await f.service.create(f.user,{name:'B',requestId:'b'});
  const outcomes=await Promise.allSettled([f.service.turn(f.user,a.id,{question:'One',requestId:'one'}),f.service.turn(f.user,a.id,{question:'Two',requestId:'two'})]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const second=await f.service.turn(f.user,b.id,{question:'Independent',requestId:'independent'});assert.equal(second.status,'running');assert.equal(f.dispatches(),2);
  const cancelled=await f.service.cancel(f.user,b.id,second.id);assert.equal(cancelled.status,'cancelled');assert(cancelled.result.notices.some(n=>n.code==='no_artifacts'));
});

test('creation, input and frozen-result reservations recover after interruption',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Recovery',requestId:'r'}),row=f.rows.get(`${f.user.id}:${a.id}`);
  row.payload.phase='creating';assert.equal((await f.service.create(f.user,{name:'Recovery',requestId:'r'})).phase,'ready');
  const input=await f.service.input(f.user,a.id,{filename:'data.csv',base64:'eA=='});
  const record=f.rows.get(`${f.user.id}:${a.id}`);record.payload.inputs=[];record.payload.active={kind:'input',id:input.id,token:'crashed'};
  assert.equal((await f.service.input(f.user,a.id,{filename:'data.csv',base64:'eA=='})).sha256,input.sha256);
  const turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});f.runs[0].status='succeeded';await f.service.result(f.user,a.id,turn.id);
  f.rows.get(`${f.user.id}:${a.id}`).payload.active={kind:'turn',id:turn.id};
  await f.service.result(f.user,a.id,turn.id);assert.equal((await f.service.get(f.user,a.id)).active,null);
});

test('an existing run with uncertain acceptance stays held and is never charged twice',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Unknown',requestId:'u'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  f.runs[0].dispatchStatus='unknown';const row=f.rows.get(`${f.user.id}:${turn.id}`);row.payload.status='dispatching';row.payload.runId=null;
  const repeated=await new DataAnalysisService(f.deps).turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  assert.equal(repeated.status,'dispatch_unknown');assert.equal(f.dispatches(),1);
  await assert.rejects(f.service.turn(f.user,a.id,{question:'Other',requestId:'next'}),{code:'analysis_busy'});
});

test('a crashed pre-dispatch preparation can be cancelled without resending an uncertain prompt',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Preparation',requestId:'p'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  f.runs.length=0;const row=f.rows.get(`${f.user.id}:${turn.id}`);row.payload.status='preparing';row.payload.runId=null;
  assert.equal((await f.service.cancel(f.user,a.id,turn.id)).errorCode,'analysis_preparation_cancelled');
  assert.equal((await f.service.get(f.user,a.id)).active,null);
  await f.service.turn(f.user,a.id,{question:'Retry',requestId:'new'});assert.equal(f.dispatches(),2);
});

test('missing, malformed and unsafe outputs leave usable partial files without a delivery veto',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Partial',requestId:'partial'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  const project=await f.deps.store.requireProject(f.user,a.projectId);
  await fs.writeFile(path.join(project.workspaceDir,'table.csv'),'x,y\n1,2');
  await fs.writeFile(path.join(project.workspaceDir,'analysis-results.json'),'{invalid');
  await fs.symlink('/etc/passwd',path.join(project.workspaceDir,'outside.txt'));
  f.runs[0].status='failed';f.runs[0].artifacts=['table.csv','analysis-results.json','missing.png','outside.txt','../escape.txt'];
  const result=(await f.service.result(f.user,a.id,turn.id)).result;
  assert(result.artifacts.some(a=>a.filename==='table.csv'));assert(!result.artifacts.some(a=>a.filename==='outside.txt'));
  assert(result.notices.some(n=>n.code==='structured_results_invalid'));assert(result.notices.some(n=>n.code==='artifact_unavailable'));
  assert.equal((await f.service.get(f.user,a.id)).active,null);
});

import { analysisInputBytes } from '../src/dataAnalysisInputs.mjs';
import { assertClientProject, isInternalProjectOf } from '../src/internalProjects.mjs';

test('configured source grants are explicit and deployment-owned; caller headers are refused',async t=>{
  const f=await fixture(t),credentialFile=path.join(f.deps.config.dataDir,'credential'),sourcesFile=path.join(f.deps.config.dataDir,'sources.json');
  await fs.writeFile(credentialFile,'Bearer fixture-only-token');
  await fs.writeFile(sourcesFile,JSON.stringify({trial:{url:'https://example.org/trial.csv',accountIds:['alice'],credentialFile}}));
  const config={...f.deps.config,dataAnalysisSourcesFile:sourcesFile};let calls=0;
  const transport=async request=>{calls++;assert.equal(request.headers.authorization,'Bearer fixture-only-token');return {status:200,headers:{},body:Buffer.from('x\n1')};};
  await assert.rejects(analysisInputBytes({id:'mallory'},{filename:'x.csv',sourceId:'trial'},config,transport),{code:'analysis_source_forbidden'});assert.equal(calls,0);
  assert.equal((await analysisInputBytes(f.user,{filename:'x.csv',sourceId:'trial'},config,transport)).buffer.toString(),'x\n1');
  await assert.rejects(analysisInputBytes(f.user,{filename:'x.csv',sourceId:'trial',headers:{}},config,transport),{code:'analysis_payload_invalid'});
});

test('dedicated projects refuse generic client access while retaining ordinary quota classification',()=>{
  const id=`da-${'a'.repeat(40)}`;assert.throws(()=>assertClientProject(id),{code:'project_not_found'});
  assert.equal(isInternalProjectOf({operatorUsers:[]},'ordinary',id),false);
});

test('a crash after dispatching metadata but before ledger reservation resumes the same dispatch identity',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Gap',requestId:'gap'});
  f.service.dispatch=async()=>{throw new HttpError(503,'fixture_before_reservation','Stopped before run reservation');};
  const failed=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  const row=f.rows.get(`${f.user.id}:${failed.id}`);row.payload.status='dispatching';delete row.payload.errorCode;
  f.rows.get(`${f.user.id}:${a.id}`).payload.active={kind:'turn',id:failed.id,dispatchId:row.payload.dispatchId};
  const recovered=await new DataAnalysisService(f.deps).turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  assert.equal(recovered.dispatchId,failed.dispatchId);assert.equal(recovered.status,'running');assert.equal(f.dispatches(),1);
});

test('simultaneous original and replay before reservation cannot dispatch twice',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Race',requestId:'race'});
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  f.service.dispatch=async(...args)=>{entered();await barrier;return f.deps.dispatch(...args);};
  const original=f.service.turn(f.user,a.id,{question:'Analyze',requestId:'same'});await waiting;
  const duplicate=await new DataAnalysisService(f.deps).turn(f.user,a.id,{question:'Analyze',requestId:'same'});
  assert.equal(duplicate.status,'dispatch_unknown');assert.equal(f.dispatches(),0);release();
  const admitted=await original;const repeated=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'same'});
  assert.equal(admitted.runId,repeated.runId);assert.equal(f.dispatches(),1);
});

test('a snapshot limit lists what could not be preserved and returns the rest; polls, idle and cancel keep working',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Capacity',requestId:'capacity'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  const project=await f.deps.store.requireProject(f.user,a.projectId);
  await fs.writeFile(path.join(project.workspaceDir,'report.md'),'Keep');await fs.writeFile(path.join(project.workspaceDir,'model.bin'),Buffer.alloc(900,1));
  f.runs[0].status='succeeded';f.runs[0].artifacts=['report.md','model.bin'];f.deps.config.dataAnalysisMaxSnapshotBytes=300;
  const result=await f.service.result(f.user,a.id,turn.id);
  assert.deepEqual(result.result.artifacts.map(item=>item.filename),['report.md'],'what fits is returned');
  assert.deepEqual(result.result.notices.filter(item=>item.code==='artifact_unavailable'),[{code:'artifact_unavailable',path:'model.bin',reason:'snapshot_limit'}]);
  assert.equal((await f.service.artifact(f.user,a.id,result.result.artifacts[0].id)).buffer.toString(),'Keep');
  assert.equal((await f.service.get(f.user,a.id)).active,null,'the reservation is released, not held on a limit');
  assert.equal((await f.service.cancel(f.user,a.id,turn.id)).status,'succeeded');
  const next=await f.service.turn(f.user,a.id,{question:'Next',requestId:'next'});assert.equal(next.status,'running');
});

test('storage that is full or the account total reached lists the file with its reason; an unexpected storage fault is retried, never thrown from a poll',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Storage',requestId:'storage'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  const project=await f.deps.store.requireProject(f.user,a.projectId);
  await fs.writeFile(path.join(project.workspaceDir,'a.csv'),'x'.repeat(100));await fs.writeFile(path.join(project.workspaceDir,'b.csv'),'y'.repeat(100));
  f.runs[0].status='succeeded';f.runs[0].artifacts=['a.csv','b.csv'];f.deps.config.dataAnalysisMaxSnapshotBytes=150;f.deps.config.dataAnalysisMaxArtifactBytes=1000;
  const result=(await f.service.result(f.user,a.id,turn.id)).result;
  assert.deepEqual(result.artifacts.map(item=>item.filename),['a.csv']);
  assert.deepEqual(result.notices.find(item=>item.code==='artifact_unavailable'),{code:'artifact_unavailable',path:'b.csv',reason:'snapshot_limit'});
  const g=await fixture(t),b=await g.service.create(g.user,{name:'Fault',requestId:'fault'}),second=await g.service.turn(g.user,b.id,{question:'Analyze',requestId:'t'});
  g.runs[0].status='succeeded';const root=g.service.root;
  g.service.root=async()=>{throw Object.assign(new Error('no space left'),{code:'ENOSPC'});};
  const held=await g.service.result(g.user,b.id,second.id);
  assert.deepEqual(held.notices,[{code:'snapshot_retry_required'}]);assert.equal(held.status,'succeeded');
  await assert.rejects(g.service.idle(g.user,b.id),{code:'analysis_busy'});
  assert.equal((await g.service.cancel(g.user,b.id,second.id)).status,'succeeded');
  g.service.root=root;assert.ok((await g.service.result(g.user,b.id,second.id)).result,'the next poll freezes it');
  assert.equal((await g.service.get(g.user,b.id)).active,null);
});

import { ResearchSessionStore } from '../src/researchSessions.mjs';
import { createDataAnalysisSession } from '../src/dataAnalysisService.mjs';

test('analysis session integration uses the actual ResearchSessionStore accepted fields',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Session contract',requestId:'session-contract'});
  const project=await f.deps.store.requireProject(f.user,a.projectId);project.rootDir=project.workspaceDir;project.baseDir=project.workspaceDir;project.metaDir=project.workspaceDir;
  const manifest=JSON.parse(await fs.readFile(new URL('../../../deploy/runtime-dsh/capabilities/statistical-analysis.json',import.meta.url),'utf8'));
  const registry={get:id=>id==='statistical-analysis'?{...manifest,runtimeAgent:'statistical-analysis'}:null};
  const sessions=new ResearchSessionStore(registry);
  const sessionId=await createDataAnalysisSession(project,{registry,sessions,runtime:{createRuntimeSession:async()=>({id:'session-contract'})}});
  const bound=await sessions.get(project,sessionId);assert.equal(bound.agentId,'statistical-analysis');assert.equal(bound.agentVersion,manifest.version);assert.equal(bound.runtimeAgent,'statistical-analysis');
});

import { AgentRunStore } from '../src/agentRuns.mjs';

test('the actual shared run ledger rejects a scheduler or second root in a dedicated analysis project',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Admission',requestId:'admission'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  const project=await f.deps.store.requireProject(f.user,a.projectId);project.rootDir=project.workspaceDir;project.metaDir=project.workspaceDir;
  const binding={sessionId:'session-analysis',mode:'open-domain',agentId:null,agentVersion:null,runtimeAgent:null};
  const store=new AgentRunStore({get:async()=>binding},{model:'deepseek/deepseek-v4-flash',authorizeReservation:(project,input)=>f.service.authorizeReservation(project,input)});
  t.after(()=>store.closeProject(project));
  const row=f.rows.get(`${f.user.id}:${turn.id}`);row.payload.status='dispatching';
  await assert.rejects(store.reserveRun(project,binding,{baselineCursor:null,dispatchId:'scheduler_other',dispatchFingerprint:'other'}),{code:'analysis_busy'});
  await assert.rejects(store.reserveRun(project,{...binding,sessionId:'second-root'},{baselineCursor:null,dispatchId:turn.dispatchId,dispatchFingerprint:turn.fingerprint}),{code:'analysis_busy'});
  const admitted=await store.reserveRun(project,binding,{baselineCursor:null,dispatchId:turn.dispatchId,dispatchFingerprint:turn.fingerprint});
  assert.equal(admitted.owner,true);assert.equal((await store.list(project)).length,1);
  // Settlement of a managed child is an event on this admitted root, not another reservation.
  await f.service.authorizeReservation({id:'ordinary',userId:f.user.id},{sessionId:'any',dispatchId:null,dispatchFingerprint:null});
});

test('input provenance separates acquisition sources and never retains a signed URL query',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Sources',requestId:'sources'});
  f.service.transport=async()=>({status:200,headers:{},body:Buffer.from('x\n1')});
  const url=await f.service.input(f.user,a.id,{filename:'data.csv',url:'https://example.org/trial.csv?signature=private-token'});
  const upload=await f.service.input(f.user,a.id,{filename:'data.csv',base64:Buffer.from('x\n1').toString('base64')});
  assert.equal(url.sha256,upload.sha256);assert.notEqual(url.id,upload.id);assert.equal(url.provenance.kind,'url');assert.equal(url.provenance.origin,'https://example.org');assert.equal(url.provenance.pathname,'/trial.csv');
  assert(url.provenance.acquiredAt);assert.equal(upload.provenance.kind,'upload');assert(!JSON.stringify(await f.service.get(f.user,a.id)).includes('private-token'));
});

test('an unavailable run ledger leaves a queryable unknown reservation and never dispatches a retry',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Ledger unavailable',requestId:'ledger'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  f.service.listRuns=async()=>{throw new Error('unavailable');};
  const result=await f.service.result(f.user,a.id,turn.id);assert.equal(result.status,'dispatch_unknown');assert.equal(result.notices[0].code,'run_ledger_unavailable');
  await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});assert.equal(f.dispatches(),1);assert.equal((await f.service.get(f.user,a.id)).active.id,turn.id);
});

test('base64 validation remains constant-stack through the default 20 MiB input limit',async()=>{
  const config={dataAnalysisMaxInputBytes:20*1024*1024};
  for(const mib of [5,10,20]){
    const source=Buffer.alloc(mib*1024*1024,97),encoded=source.toString('base64');
    const {buffer}=await analysisInputBytes({id:'alice'},{filename:'large.csv',base64:encoded},config);
    assert.equal(buffer.length,source.length);assert(buffer.equals(source));
  }
  for(const invalid of ['YR==','YQ=','Y=Q=','YQ==AAAA','YQ\n=='])await assert.rejects(analysisInputBytes({id:'alice'},{filename:'bad.csv',base64:invalid},config),{code:'analysis_base64_invalid'});
});

test('a late acknowledgement CAS conflict cannot release a turn whose snapshots were not persisted',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Snapshot race',requestId:'snapshot-race'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  f.runs[0].status='succeeded';const originalPut=f.deps.documents.put;let conflict=true;
  f.deps.documents.put=async(user,kind,id,payload,options)=>{
    if(id===turn.id&&payload.result&&conflict){conflict=false;const row=f.rows.get(`${user}:${id}`);row.revision++;row.payload.status='running';}
    return originalPut(user,kind,id,payload,options);
  };
  const first=await f.service.result(f.user,a.id,turn.id);assert.equal(first.result,undefined);assert.equal((await f.service.get(f.user,a.id)).active.id,turn.id);
  const retry=await f.service.result(f.user,a.id,turn.id);assert(retry.result);assert.equal((await f.service.get(f.user,a.id)).active,null);
});

test('cancelled statistical runs preserve their actual unverified partial artifacts',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Cancelled partial',requestId:'cancel-partial'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  const project=await f.deps.store.requireProject(f.user,a.projectId);await fs.writeFile(path.join(project.workspaceDir,'partial.csv'),'x\n1');
  f.runs[0].status='cancelled';f.runs[0].artifacts=[];f.runs[0].unverifiedArtifacts=['partial.csv'];
  const frozen=await f.service.result(f.user,a.id,turn.id);assert.equal(frozen.result.artifacts[0].verification,'unverified');
  assert.equal((await f.service.artifact(f.user,a.id,frozen.result.artifacts[0].id)).buffer.toString(),'x\n1');
});

test('package-relative manifest references label only already admitted artifacts',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Package paths',requestId:'package'}),turn=await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  const project=await f.deps.store.requireProject(f.user,a.projectId);await fs.mkdir(path.join(project.workspaceDir,'deliverables'),{recursive:true});
  await fs.writeFile(path.join(project.workspaceDir,'deliverables','chart.pdf'),'plot fixture');
  await fs.writeFile(path.join(project.workspaceDir,'deliverables','analysis-output.json'),JSON.stringify({schemaVersion:1,summary:'Observed result',figures:[{path:'chart.pdf'}]}));
  f.runs[0].status='succeeded';f.runs[0].artifacts=['deliverables/chart.pdf','deliverables/analysis-output.json'];
  const result=(await f.service.result(f.user,a.id,turn.id)).result;
  assert.equal(result.artifacts.find(a=>a.filename==='chart.pdf').role,'figure');assert(!result.notices.some(n=>n.code==='manifest_reference_unavailable'));
});

import { dataAnalysisMetricFamilies, resetDataAnalysisMetrics } from '../src/dataAnalysisMetrics.mjs';
import { analysisSnapshotRoot } from '../src/dataAnalysisArtifacts.mjs';

test('an account keeps a bounded number of analyses; a replay is not a new one, the refusal is named and counted, deleting frees one',async t=>{
  resetDataAnalysisMetrics();
  const f=await fixture(t);f.deps.config.dataAnalysisMaxPerAccount=2;
  const a=await f.service.create(f.user,{name:'A',requestId:'a'});await f.service.create(f.user,{name:'B',requestId:'b'});
  assert.equal((await f.service.create(f.user,{name:'A',requestId:'a'})).id,a.id,'the same requestId at the cap is the same analysis');
  await assert.rejects(f.service.create(f.user,{name:'C',requestId:'c'}),{code:'analysis_limit_reached',status:409});
  assert.equal((await f.service.create({id:'bob'},{name:'C',requestId:'c'})).phase,'ready','another account has its own count');
  assert.equal(dataAnalysisMetricFamilies()[0].series.find(row=>row.labels.reason==='analysis_limit').value,1);
  await f.service.remove(f.user,a.id);
  assert.equal((await f.service.create(f.user,{name:'C',requestId:'c'})).phase,'ready');
});

test('concurrent creations at the cap admit exactly as many as fit',async t=>{
  const f=await fixture(t);f.deps.config.dataAnalysisMaxPerAccount=2;
  await f.service.create(f.user,{name:'Seed',requestId:'seed'});
  const outcomes=await Promise.allSettled(['x','y','z'].map(key=>f.service.create(f.user,{name:key,requestId:key})));
  assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(item=>item.status==='rejected'&&item.reason.code==='analysis_limit_reached').length,2);
});

test('deleting an analysis removes its project, records and preserved bytes, stops running work, and only its own',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Doomed',requestId:'doomed'}),keep=await f.service.create(f.user,{name:'Keep',requestId:'keep'});
  await f.service.input(f.user,a.id,{filename:'data.csv',base64:Buffer.from('x\n1').toString('base64')});
  await f.service.input(f.user,keep.id,{filename:'data.csv',base64:Buffer.from('x\n1').toString('base64')});
  await f.service.turn(f.user,a.id,{question:'Analyze',requestId:'t'});
  const root=analysisSnapshotRoot(f.deps.config,f.user.id,a.id),keptRoot=analysisSnapshotRoot(f.deps.config,f.user.id,keep.id);
  await fs.access(root);
  await assert.rejects(f.service.remove({id:'mallory'},a.id),{code:'analysis_not_found'});
  await assert.rejects(f.service.remove(f.user,a.id,'da-another-project'),{code:'analysis_project_scope',status:403});
  assert.deepEqual(await f.service.remove(f.user,a.id,a.projectId),{id:a.id,deleted:true});
  await assert.rejects(f.service.get(f.user,a.id),{code:'analysis_not_found'});
  await assert.rejects(fs.access(root),{code:'ENOENT'});
  assert.ok(!f.projects.has(`${f.user.id}:${a.projectId}`));
  await fs.access(keptRoot);assert.equal((await f.service.get(f.user,keep.id)).id,keep.id);
  await assert.rejects(f.service.remove(f.user,a.id),{code:'analysis_not_found'},'a second delete finds nothing');
  assert.equal((await f.service.create(f.user,{name:'Doomed',requestId:'doomed'})).phase,'ready','the same requestId after a delete is a new analysis');
});

test('an analysis whose project was never created can still be deleted',async t=>{
  const f=await fixture(t),a=await f.service.create(f.user,{name:'Half',requestId:'half'});
  f.projects.delete(`${f.user.id}:${a.projectId}`);
  assert.deepEqual(await f.service.remove(f.user,a.id),{id:a.id,deleted:true});
  assert.equal(f.rows.has(`${f.user.id}:${a.id}`),false);
});
