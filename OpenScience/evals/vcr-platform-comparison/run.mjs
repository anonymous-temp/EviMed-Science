#!/usr/bin/env node
/** Real local product driver. Each patient owns a disposable account/project/session.
 * No conditions, facts or answers are seeded. All inference enters automated dispatch.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openThrowawayAccount, fetchTransport } from '../../scripts/ops/throwaway-account.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ACTIVE = new Set(['queued','running','planned','dispatching','starting','waiting']);
const JOB_TERMINAL = new Set(['completed','succeeded','done','failed','canceled','cancelled']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, {cwd:ROOT,encoding:'utf8'}).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const safe = value => {if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Unsafe case identity');return value;};
const rows = value => Array.isArray(value) ? value : value?.runs ?? value?.items ?? [];
async function save(file,value) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(temporary,file);
}

async function downloadArtifact({base,account,projectId,relative,folder,signal,instance}){
  const response=await fetch(base+'/api/files/download/'+relative.split('/').map(encodeURIComponent).join('/'),{redirect:'error',
    headers:{...account.headers,'x-open-science-project':projectId,'x-evimed-automated':'1'},signal});
  if(instance&&response.headers.get('x-evimed-benchmark-instance')!==instance)throw new Error('Artifact server instance changed');
  if(!response.ok)return{path:relative,status:response.status};
  if(Number(response.headers.get('content-length'))>10*1024*1024){await response.body?.cancel();return{path:relative,status:'too_large'};}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>10*1024*1024)throw new Error('Artifact exceeds export bound');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);const filename=hash(bytes)+path.extname(relative).replace(/[^.A-Za-z0-9]/g,'').slice(0,12);
  await fs.mkdir(path.join(folder,'files'),{recursive:true});await fs.writeFile(path.join(folder,'files',filename),bytes,{mode:0o600});
  return{path:relative,file:'files/'+filename,sha256:hash(bytes),bytes:size,status:200};
}

export function promptFor(manifest,example) {
  const task=manifest.task??'matching';
  if (!['matching','retrieval'].includes(task)) throw new Error('Unsupported task');
  if (!/^[A-Za-z0-9_.:@-]{1,160}$/.test(manifest.collection)) throw new Error('Invalid collection');
  const purpose=task==='matching'
    ? '请用虚拟临床研究的患者匹配功能，将附件 patient.txt 的患者与 trials.txt 列出的每项试验逐条匹配。'
    : '请用虚拟临床研究的患者匹配功能，为附件 patient.txt 的患者检索试验，获取最多500项候选，并评估最相关的前20项、给出排序。';
  return `${purpose}\n这是公开合成患者与历史试验资料的研究测试。试验资料使用冻结集合 ${manifest.collection}，不使用实时注册库替换。先确认该集合的版本，并沿用该版本读取试验。\n请完成实际匹配，在平台保存可查看的患者与试验结果；逐条保留入排标准原文、判断、患者证据和缺失资料。资料没有提供的内容直接说明，不需要等待补充。没有证据的项目不可编造。完成后说明候选顺序及其依据，保存 matching-assessment.json 供下载。不要联系、转诊或招募患者。\n附件已通过平台上传到 inputs/；病例编号 ${safe(example.id)}。`;
}

export function usageBound(summary,ceiling) {
  const observed = Number.isFinite(summary?.actualCost) && summary.actualCost >= 0 ? summary.actualCost : 0;
  const reserve = Number.isFinite(summary?.reservedCost) && summary.reservedCost >= 0 ? summary.reservedCost : 0;
  if (!summary || summary.currency!=='CNY' || !Number.isFinite(summary.actualCost) || summary.actualCost < 0
      || summary.unpricedCalls || summary.reservedCalls || summary.uncertainCalls) return Math.max(ceiling, observed + reserve);
  return Math.max(0,summary.actualCost);
}

export async function verifyCampaign({base,manifestPath,startupPath,expectedSha}) {
  const url=new URL(base);
  if (url.protocol!=='http:' || !['127.0.0.1','localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('Local isolated origin required');
  if (git('status','--porcelain')) throw new Error('Commit all source changes before the baseline');
  const head=git('rev-parse','HEAD');
  if (head!==expectedSha || git('rev-parse','@{upstream}')!==head) throw new Error('Baseline must equal the pushed upstream revision');
  const startup=JSON.parse(await fs.readFile(startupPath,'utf8'));
  if (startup.sourceSha!==head || startup.dirty || startup.configurationEvidence!=='resolved configuration verified') throw new Error('Restart the verified local server at the pushed revision');
  if(startup.origin!==url.origin||!startup.instance||startup.budget?.allModelPurposes!==true)throw new Error('Server origin or budget guard differs');
  const live=await fetch(url.origin+'/api/health',{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!live.ok||live.headers.get('x-evimed-benchmark-instance')!==startup.instance)throw new Error('Startup receipt does not identify this live server');
  const remote=git('-c','http.proxy='+String(process.env.HTTPS_PROXY??process.env.https_proxy??'http://127.0.0.1:7890'),'ls-remote','--heads','origin',git('branch','--show-current')).split(/\s+/)[0];
  if(remote!==head)throw new Error('Remote branch is not the benchmark revision');
  for (const [module,digest]of Object.entries(startup.modules)) {
    if(hash(await fs.readFile(path.join(ROOT,'OpenScience',module)))!==digest)throw new Error('Server module bytes differ');
  }
  for(const key of ['memoryEnabled','memoryRecallEnabled','nativeMemoryTurnCommitEnabled','learningEnabled']) {
    if(startup.resolvedConfig?.[key]!==false)throw new Error('Memory/learning must be disabled');
  }
  const bytes=await fs.readFile(manifestPath);const manifest=JSON.parse(bytes);
  if(manifest.version!==1||!Array.isArray(manifest.cases)||!manifest.cases.length)throw new Error('Invalid case manifest');
  if(new Set(manifest.cases.map(row=>row.id)).size!==manifest.cases.length)throw new Error('Duplicate case identities');
  const collectionBytes=await fs.readFile(startup.resolvedConfig.vcrTrialCorpusManifest);
  if(hash(collectionBytes)!==startup.collectionManifestSha256||JSON.parse(collectionBytes).id!==manifest.collection)throw new Error('Frozen collection differs');
  for(const example of manifest.cases) {
    safe(example.id);
    const names=example.files.map(file=>file.name).sort();
    if(JSON.stringify(names)!==JSON.stringify(manifest.task==='retrieval'?['patient.txt']:['patient.txt','trials.txt']))throw new Error('Exact per-task input files required');
    for(const file of example.files) {
      if(!['patient.txt','trials.txt'].includes(file.name)||!path.isAbsolute(file.path)||hash(await fs.readFile(file.path))!==file.sha256)throw new Error('Input whitelist/hash mismatch');
      if(manifest.task==='retrieval'&&file.name!=='patient.txt')throw new Error('Retrieval may not receive annotation candidate IDs');
    }
  }
  return {manifest,startup,freeze:{sourceSha:head,manifestSha256:hash(bytes),
    collectionManifestSha256:hash(collectionBytes),
    alignmentPolicySha256:hash(await fs.readFile(new URL('./alignment-policy.json',import.meta.url))),
    alignmentCodeSha256:hash(await fs.readFile(new URL('./alignment.py',import.meta.url))),
    startupSha256:hash(await fs.readFile(startupPath)),createdAt:new Date().toISOString()}};
}

export async function runCase({base,example,manifest,out,timeoutMs=900000,instance=null,signal=null}) {
  const folder=path.join(out,safe(example.id));await fs.mkdir(folder,{recursive:true,mode:0o700});
  const record={caseId:example.id,task:manifest.task??'matching',startedAt:new Date().toISOString(),status:'starting',requests:[]};
  let account,projectId,sessionId,studyId,projectCreated=false,interrupted=false,captureDeadline=null;
  const deadline=Date.now()+timeoutMs,controller=new AbortController();
  const onSignal=()=>{interrupted=true;controller.abort();};
  for(const event of ['SIGINT','SIGTERM','SIGHUP'])process.on(event,onSignal);
  signal?.addEventListener('abort',onSignal);
  if(signal?.aborted)onSignal();
  let sequence=0;
  const api=async(method,route,body,{allowed=[200,201,202],cleanup=false,capture=false}={})=>{
    if(interrupted&&!cleanup)throw new Error('Campaign interrupted');
    if(!cleanup&&Date.now()>=deadline)throw new Error('Case deadline exceeded');
    if(capture&&Date.now()>=captureDeadline)throw new Error('Partial evidence capture deadline exceeded');
    const timer=AbortSignal.timeout(capture?Math.max(1,Math.min(15000,captureDeadline-Date.now())):cleanup?15000:Math.max(1,Math.min(30000,deadline-Date.now())));
    const response=await fetch(base+route,{method,redirect:'error',signal:cleanup?timer:AbortSignal.any([timer,controller.signal]),
      headers:{'content-type':'application/json',origin:base,...account.headers,'x-evimed-automated':'1',
        ...(projectId?{'x-open-science-project':projectId}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(instance&&response.headers.get('x-evimed-benchmark-instance')!==instance)throw new Error('Benchmark server instance changed');
    const data=await response.json();record.requests.push({sequence:++sequence,method,route,status:response.status});
    if(!allowed.includes(response.status))throw Object.assign(new Error(`${method} ${route}: ${response.status} ${data.code??''}`),{code:data.code});
    return data.data??null;
  };
  const discoverStudy=async(options={})=>{
    if(!projectCreated||!sessionId)return null;
    const home=await api('GET','/api/vcr/studies',undefined,options);
    if(home?.conversationStudiesUnreadable)throw new Error('Conversation study inventory is unreadable');
    const found=(home?.conversationStudies??[]).filter(row=>row.projectId===projectId&&row.originatingSessionId===sessionId);
    if(found.length>1)throw new Error('Ambiguous conversation study ownership');
    if(found[0])studyId=found[0].id;
    record.studyId=studyId??null;return studyId;
  };
  const quiesce=async()=>{
    if(!account||!projectId||!projectCreated)return;
    const held=rows(await api('GET','/api/agent-runs',undefined,{cleanup:true}));
    for(const run of held)if(ACTIVE.has(run.status))await api('POST',`/api/agent-runs/${run.id}/cancel`,{}, {cleanup:true});
    await discoverStudy({cleanup:true});
    if(studyId){
      const jobs=await api('GET',`/api/vcr/studies/${studyId}/jobs`,undefined,{cleanup:true});
      for(const job of jobs.jobs??[])if(!JOB_TERMINAL.has(job.state??job.status))await api('POST',`/api/vcr/studies/${studyId}/jobs/${encodeURIComponent(job.id)}/cancel`,{}, {cleanup:true});
      const until=Date.now()+30000;
      while(true){
        const latest=await api('GET',`/api/vcr/studies/${studyId}/jobs`,undefined,{cleanup:true});
        if(!(latest.jobs??[]).some(job=>!JOB_TERMINAL.has(job.state??job.status)))break;
        if(Date.now()>=until)throw new Error('Owned VCR jobs did not stop');
        await sleep(500);
      }
    }
  };
  const stop=async()=>{await quiesce();if(projectCreated)await api('POST','/api/commands/stop_runtime',{}, {cleanup:true});};
  try {
    if(interrupted)throw new Error('Campaign interrupted before registration');
    account=await openThrowawayAccount({base,send:fetchTransport(base),prefix:'vcrbench',signals:false,stop,
      say:message=>{record.accountEvents??=[];record.accountEvents.push(message);}});
    record.accountId=account.id;
    projectId='vcr-'+safe(example.id)+'-'+randomUUID().slice(0,8);record.projectId=projectId;
    await api('POST','/api/projects',{id:projectId,name:'Matching '+example.id});
    projectCreated=true;
    record.uploads=[];
    for(const file of example.files) {
      const bytes=await fs.readFile(file.path);
      if(hash(bytes)!==file.sha256)throw new Error('Frozen input changed');
      const uploaded=await api('POST','/api/files/upload',{root:'workspace',path:'inputs/'+file.name,data:bytes.toString('base64'),encoding:'base64'});
      record.uploads.push({name:file.name,sha256:file.sha256,sourceId:uploaded?.source?.id??null,vcrInput:uploaded?.vcrInput??null,vcrInputWarning:uploaded?.vcrInputWarning??null});
    }
    sessionId=(await api('POST','/api/runtime/sessions',{})).id;record.sessionId=sessionId;
    await api('PUT',`/api/research-sessions/${sessionId}`,{mode:'open-domain'});
    record.prompt=promptFor(manifest,example);
    record.dispatchAttempted=true;
    const run=await api('POST','/api/agent-runs/dispatch',{sessionId,dispatchId:'vcrbench-'+randomUUID(),text:record.prompt,automated:true,line:'answer'});
    record.runId=run.id;record.status='running';await save(path.join(folder,'case.json'),record);
    let settled=false;
    while(Date.now()<deadline&&!interrupted) {
      const runs=rows(await api('GET','/api/agent-runs'));record.runs=runs;
      if(runs.some(r=>r.automated!==true))throw new Error('An unmarked run entered the campaign');
      await discoverStudy();
      const jobs=studyId?await api('GET',`/api/vcr/studies/${studyId}/jobs`):{jobs:[]};record.jobs=jobs.jobs??[];
      const root=runs.find(r=>r.id===run.id);
      record.rootOutcome=root?.status??null;
      if(root&&!runs.some(r=>ACTIVE.has(r.status))&&record.jobs.some(j=>(j.state??j.status)==='awaiting_budget')){record.status='awaiting_budget';break;}
      if(root&&!runs.some(r=>ACTIVE.has(r.status))&&!record.jobs.some(j=>!JOB_TERMINAL.has(j.state??j.status))) {settled=true;break;}
      await sleep(3000);
    }
    record.status=settled?(['completed','succeeded','done'].includes(record.rootOutcome)?'settled':'run_failed')
      :interrupted?'interrupted':record.status==='awaiting_budget'?'awaiting_budget':'timed_out';
    if(!settled)await quiesce();
    captureDeadline=Date.now()+30000;
    const capturing=!settled||interrupted?{cleanup:true,capture:true}:{};
    record.transcript=await api('GET',`/api/runtime/sessions/${sessionId}/transcript`,undefined,capturing).catch(error=>({error:error.message}));
    if(studyId) {
      let matching=await api('GET',`/api/vcr/studies/${studyId}/matching?direction=patient_to_trial`,undefined,capturing);
      const roster=[...new Set(matching.candidateRoster??[])];
      const selected=matching.opensOnPatient??(roster.length===1?roster[0]:null);
      if(selected&&roster.includes(selected))matching=await api('GET',`/api/vcr/studies/${studyId}/matching?direction=patient_to_trial&candidate=${encodeURIComponent(selected)}`,undefined,capturing);
      else if(roster.length>1)record.patientScopeIssue='multiple_patients_in_one_case';
      record.matching=matching;
      const patient=matching.patientTrials?.subject;
      record.trialDetails=[];
      if(patient)for(const trial of matching.patientTrials?.trials??[]) {
        const detail=await api('GET',`/api/vcr/studies/${studyId}/matching?direction=patient_to_trial&candidate=${encodeURIComponent(patient)}&trial=${encodeURIComponent(trial.id)}`,undefined,capturing);
        record.trialDetails.push({registryId:trial.registryId,id:trial.id,detail});
      }
    }
    record.outputs=await api('GET',`/api/sources/outputs?projectId=${encodeURIComponent(projectId)}`,undefined,capturing);
    record.exportedFiles=[];
    const paths=new Set(['matching-assessment.json',...(record.runs??[]).flatMap(row=>(row.outputFiles??[]).map(file=>typeof file==='string'?file:file.path))]);
    for(const relative of [...paths].filter(value=>typeof value==='string'&&!path.isAbsolute(value)&&!value.split('/').includes('..')).slice(0,20)){
      const exportDeadline=capturing.cleanup?captureDeadline:deadline;
      if((interrupted&&!capturing.cleanup)||Date.now()>=exportDeadline)break;
      const exportTimer=AbortSignal.timeout(Math.max(1,Math.min(15000,exportDeadline-Date.now())));
      record.exportedFiles.push(await downloadArtifact({base,account,projectId,relative,folder,instance,
        signal:capturing.cleanup?exportTimer:AbortSignal.any([controller.signal,exportTimer])}));
    }
    if(record.status==='settled'&&(!studyId||!record.trialDetails?.length))record.status='missing_feature_result';
  }catch(error){record.status='failed';record.error={message:error.message,code:error.code??null};
    if(!account&&error.account){record.accountId=error.account;record.cleanup={deleted:false,reason:'registration_outcome_uncertain'};}}
  finally {
    if(account) {
      // Poll/dispatch failures can bypass the normal export block. Preserve
      // the partial product evidence before shutting down its real kernel.
      if(sessionId&&record.dispatchAttempted&&!record.transcript){
        await quiesce().catch(error=>{record.partialQuiesceError=error.message;});
        captureDeadline=Date.now()+15000;
        const capture={cleanup:true,capture:true};
        record.transcript=await api('GET',`/api/runtime/sessions/${sessionId}/transcript`,undefined,capture).catch(error=>({error:error.message}));
        if(studyId)record.partialMatching=await api('GET',`/api/vcr/studies/${studyId}/matching?direction=patient_to_trial`,undefined,capture).catch(error=>({error:error.message}));
        record.partialOutputs=await api('GET',`/api/sources/outputs?projectId=${encodeURIComponent(projectId)}`,undefined,capture).catch(error=>({error:error.message}));
        if(Date.now()<captureDeadline){
          record.partialFiles=[await downloadArtifact({base,account,projectId,relative:'matching-assessment.json',folder,instance,
            signal:AbortSignal.timeout(Math.max(1,captureDeadline-Date.now()))}).catch(error=>({error:error.message}))];
        }
      }
      await stop().catch(error=>{record.stopError=error.message;});
      record.usage=await api('GET','/api/account/usage',undefined,{cleanup:true}).catch(()=>null);
      record.cleanup=record.stopError&&record.dispatchAttempted?{deleted:false,reason:record.stopError}:await account.close();
      if(!record.cleanup.deleted)record.status='cleanup_failed';
    }
    if(interrupted&&record.status!=='cleanup_failed')record.status='interrupted';
    record.finishedAt=new Date().toISOString();await save(path.join(folder,'case.json'),record);
    for(const event of ['SIGINT','SIGTERM','SIGHUP'])process.off(event,onSignal);
    signal?.removeEventListener('abort',onSignal);
  }
  return record;
}

export async function main() {
  const {values}=parseArgs({options:Object.fromEntries(['base','manifest','startup','sha','out','limit','ids','budget','case-budget','timeout','reference','gold'].map(key=>[key,{type:'string'}]))});
  for(const key of ['base','manifest','startup','sha','out'])if(!values[key])throw new Error(`Required --${key}`);
  const base=values.base.replace(/\/$/,'');const out=path.resolve(values.out);
  const checked=await verifyCampaign({base:base+'/',manifestPath:values.manifest,startupPath:values.startup,expectedSha:values.sha});
  const limit=values.limit?Number(values.limit):checked.manifest.cases.length;
  const budget=Number(values.budget??200),ceiling=Number(values['case-budget']??5);
  if(!Number.isSafeInteger(limit)||limit<1||!Number.isFinite(budget)||budget<=0||!Number.isFinite(ceiling)||ceiling<=0
      ||checked.startup.resolvedConfig.userDailySpendLimit!==ceiling||checked.startup.budget.totalLimit!==budget
      ||checked.startup.budget.accountLimit!==ceiling)throw new Error('Invalid frozen budget/limit');
  const ids=values.ids?new Set(values.ids.split(',')):null;
  const selected=checked.manifest.cases.filter(c=>!ids||ids.has(c.id)).slice(0,limit);
  if(!selected.length||(ids&&selected.length!==ids.size))throw new Error('Unknown case selection');
  await fs.mkdir(out,{recursive:false,mode:0o700});
  const summary={...checked.freeze,task:checked.manifest.task??'matching',budgetCny:budget,perAccountCeilingCny:ceiling,
    planned:selected.map(c=>c.id),cases:[],spentBoundCny:0,status:'running'};
  if(summary.task==='matching'){
    if(!values.reference||!values.gold)throw new Error('Bind reference and target hashes before inference');
    summary.referenceSha256=hash(await fs.readFile(values.reference));summary.goldSha256=hash(await fs.readFile(values.gold));
  }
  if(summary.task==='retrieval'){
    if(!values.gold)throw new Error('Bind retrieval judgments before inference');
    summary.goldSha256=hash(await fs.readFile(values.gold));
  }
  await save(path.join(out,'FROZEN.json'),summary);
  const campaignAbort=new AbortController();const interrupt=()=>campaignAbort.abort();
  for(const event of ['SIGINT','SIGTERM','SIGHUP'])process.on(event,interrupt);
  try{
  for(const example of selected) {
    if(campaignAbort.signal.aborted){summary.status='interrupted';break;}
    if(summary.spentBoundCny+ceiling>budget){summary.status='budget_exhausted';break;}
    if(git('rev-parse','HEAD')!==values.sha||git('status','--porcelain'))throw new Error('Source changed during campaign');
    // Reserve the account's enforced maximum before a model request can be made.
    summary.spentBoundCny+=ceiling;summary.activeCase=example.id;await save(path.join(out,'summary.json'),summary);
    const result=await runCase({base,example,manifest:checked.manifest,out,timeoutMs:Number(values.timeout??900000),instance:checked.startup.instance,signal:campaignAbort.signal});
    const bound=usageBound(result.usage,ceiling);
    summary.spentBoundCny+=bound-ceiling;summary.activeCase=null;
    summary.cases.push({id:example.id,status:result.status,runId:result.runId,studyId:result.studyId,usage:result.usage,cleanup:result.cleanup});
    await save(path.join(out,'summary.json'),summary);
    console.log(JSON.stringify({case:example.id,status:result.status,completed:summary.cases.length,total:selected.length,costBoundCny:summary.spentBoundCny}));
    if(result.status==='interrupted'){summary.status='interrupted';break;}
    if(result.accountId&&result.cleanup?.deleted!==true){summary.status='stopped';break;}
  }
  }finally{for(const event of ['SIGINT','SIGTERM','SIGHUP'])process.off(event,interrupt);}
  if(summary.status==='running')summary.status=summary.cases.every(row=>row.status==='settled')?'finished':'completed_with_findings';
  summary.finishedAt=new Date().toISOString();await save(path.join(out,'summary.json'),summary);
  if(summary.status!=='finished')process.exitCode=1;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
