import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { researchNativeReceiptDigest, researchNativeArtifactDigest } from '@evimed/domain';
import { emptyManifest, withPackage, writeManifest } from '../../scripts/ops/extension-catalogue.mjs';
import { createWebApiApp } from '../../apps/server/src/server.mjs';
import { loadExtensionDeployment } from '../../apps/server/src/extensionDeployment.mjs';
import { createControllerExtensionComposition } from '../../apps/server/src/extensionControllerComposition.mjs';
import { createRuntimeController } from '../../apps/server/src/runtimeControllerServer.mjs';
import { runConversations } from './conversation-driver.mjs';
import { extensionGenerationRoot, extensionMountIdentity } from '../../apps/server/src/extensionGenerationService.mjs';
import path from 'node:path';
import { snapshotSource } from './snapshot.mjs';
import { installBudgetGuard } from './budget-guard.mjs';

const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const image=process.env.VCR_TEST_IMAGE, network=process.env.VCR_TEST_NETWORK, volume=process.env.VCR_TEST_VOLUME;
assert(image && network && volume && process.env.VCR_TEST_DATABASE);
const img=execFileSync('docker',['image','inspect','--format','{{.Id}}',image],{encoding:'utf8'}).trim();
const sourceHash=await snapshotSource('/app/OpenScience');
const caseHash=digest(await fs.readFile(new URL('./conversation-cases.json',import.meta.url)));
const nativeChainHash=digest(await fs.readFile(new URL('./native-chain-cases.json',import.meta.url)));
const completionCaseHash=digest(await fs.readFile(new URL('./completion-cases.json',import.meta.url)));
const postAuditTrialHash=digest(await fs.readFile(new URL('./post-audit-trial.json',import.meta.url)));
const engineImage=process.env.VCR_TEST_ENGINE?execFileSync('docker',['image','inspect','--format','{{.Id}}',process.env.VCR_TEST_ENGINE],{encoding:'utf8'}).trim():null;
await fs.writeFile('/data/snapshot.json',JSON.stringify({schemaVersion:1,sourceHash,caseHash,nativeChainHash,completionCaseHash,postAuditTrialHash,runnerSha256:process.env.VCR_RUNNER_SHA,imageId:img,engineImageId:engineImage})+'\n',{mode:0o600});
const bundleManifest=JSON.parse(execFileSync('docker',['run','--rm','--network','none','--entrypoint','cat',img,'/opt/evimed/research-bundles/manifest.json'],{encoding:'utf8'}));
let manifest=emptyManifest();
for(const receipt of bundleManifest.receipts){
  const bundle={...receipt,receiptDigest:researchNativeReceiptDigest(receipt,digest),adapterRevision:digest('native-adapter-1'),suiteRevision:digest('native-suite-1')};delete bundle.schemaVersion;
  bundle.artifactDigest=researchNativeArtifactDigest(bundle,digest);
  const artifact={coordinate:bundle.coordinate,integrity:bundle.integrity,artifactDigest:bundle.artifactDigest,adapterRevision:bundle.adapterRevision,suiteRevision:bundle.suiteRevision};
  manifest=withPackage(manifest,{catalogue:{id:bundle.id,title:bundle.id,coordinate:bundle.coordinate,executionClass:'managed-native',integrity:bundle.integrity,settingsSchema:{}},nativeBundle:bundle,artifact});
}
writeManifest('/data',manifest);
const secret=randomUUID()+randomUUID();
const options={authMode:'local',devAuth:false,selfRegistrationEnabled:true,localAutoConfig:false,host:'0.0.0.0',port:8787,publicUrl:'http://127.0.0.1:8787',dataDir:'/data',stateStore:'postgres',databaseUrl:process.env.VCR_TEST_DATABASE,runtimeMode:'kernel',runtimeProvider:'docker',runtimeSandboxMode:'docker',runtimeControllerMode:'direct',allowDirectDockerControl:true,runtimeContainerBin:'docker',runtimeContainerImage:img,runtimeRequireImageLocal:true,runtimeDataVolume:volume,runtimeTransport:'unix',runtimeNetworkMode:network,runtimeInternalNetworkName:network,allowRuntimeNetworkEgress:false,modelGatewayInternalUrl:'http://vcr-native-cp:8787/internal/model/v1',modelGatewaySigningSecret:secret,evimedWorkloadSigningSecret:secret,deepseekApiKeyFile:process.env.VCR_RUN_CONVERSATIONS==='1'?'/run/vcr-provider-key':'',deepseekModel:'deepseek-flash',userDailySpendLimit:4,userWeeklySpendLimit:4,userRunSpendLimit:2,maxProjectsPerUser:30,memoryEnabled:false,memoryRecallEnabled:false,nativeMemoryTurnCommitEnabled:false,nativeMemoryConsolidationEnabled:false,nativeMemoryRejectionJudgeEnabled:false,learningEnabled:false,evolutionEnabled:false,autopilotEnabled:false,loopxEnabled:false,runTitlesEnabled:false,webReadEnabled:false,webSearchDeepseekEnabled:false,webSearchBailianEnabled:false,sourceIngestionEnabled:false,kbSearchEnabled:false,vcrEnabled:true,vcrAudience:'all',vcrProviderAgreements:true,vcrProviderAgreementReference:'Synthetic local evaluation only',approvalMode:'never'};
if(process.env.VCR_RUN_CONVERSATIONS==='1') Object.assign(options,{vcrEngineUrl:'http://vcr-native-engine:8000',vcrEngineTokenFile:'/run/engine-token',vcrEngineReceiptKeyFile:'/run/engine-receipt',vcrDataPlaneDir:'/data/vcr-data-plane'});
if(process.env.VCR_BUDGET_REMAINING) {const limit=Number(process.env.VCR_BUDGET_REMAINING);if(!Number.isFinite(limit)||limit<=0||limit>4)throw new Error('Invalid remaining CNY budget');options.userDailySpendLimit=limit;options.userWeeklySpendLimit=limit;}
const app=createWebApiApp(options);let composition,controller,budgetGuard;const observers=[];
try {
  if(process.env.VCR_RUN_CONVERSATIONS==='1')budgetGuard=await installBudgetGuard(app.usageLedger,{file:'/data/conversation-budget.json',limit:options.userDailySpendLimit});
  const deployment=loadExtensionDeployment(app.config);assert.equal(deployment.status,'configured',JSON.stringify({dataDir:app.config.dataDir,errorCode:deployment.errorCode}));
  composition=createControllerExtensionComposition({config:app.config,deployment});assert(composition);
  await composition.ready;
  const originalPrepare=composition.tools.prepare.bind(composition.tools);
  composition.tools.prepare=async (...args)=>{try{return await originalPrepare(...args);}catch(error){console.error('native preparation controller:',error.code,error.message,error.detail);throw error;}};
  controller=createRuntimeController(app.config,{extensionTools:composition.tools});await controller.listen();
  await app.listen(8787,'0.0.0.0');
  if(process.env.VCR_CASE_SUITE==='completion'){
    await fs.writeFile('/data/completion-observations.jsonl','',{mode:0o600});
    const service=app.vcr.completions,report=service.report.bind(service),mark=service.mark.bind(service);
    service.report=code=>{void fs.appendFile('/data/completion-observations.jsonl',JSON.stringify({event:'report',code,at:new Date().toISOString()})+'\n');return report(code);};
    service.mark=async (row,state,code)=>{const value=await mark(row,state,code);await fs.appendFile('/data/completion-observations.jsonl',JSON.stringify({event:'mark',id:row.id,jobId:row.job_id,projectId:row.project_id,state,code:code??null,at:new Date().toISOString()})+'\n');return value;};
    for(const name of ['resolve','inbox','dispatch']){
      const original=service[name].bind(service);
      service[name]=async (...args)=>{try{return await original(...args);}catch(error){await fs.appendFile('/data/completion-observations.jsonl',JSON.stringify({event:'boundary-error',boundary:name,code:error.code??null,message:String(error.message??'').slice(0,200),stack:String(error.stack??'').split('\n').slice(1,7),at:new Date().toISOString()})+'\n');throw error;}};
    }
  }
  for(const name of ['prepareGeneration','replaceGeneration','probeGeneration','restoreGeneration']){
    const original=app.runtimeManager[name].bind(app.runtimeManager);
    app.runtimeManager[name]=async (...args)=>{try{return await original(...args);}catch(error){console.error(`runtime ${name}:`,error.code,error.message);throw error;}};
  }
  const base='http://127.0.0.1:8787';
  const register=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','origin':base},body:JSON.stringify({username:'native_'+randomUUID().replaceAll('-',''),password:'native-test-password-47',name:'Temporary'})});
  const registered=await register.json();assert.equal(register.status,201,JSON.stringify(registered));
  const headers={cookie:register.headers.get('set-cookie').split(';')[0],'x-open-science-csrf':registered.data.csrfToken,'content-type':'application/json'};
  const request=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert(response.ok,JSON.stringify({route,status:response.status,value}));return value.data;};
  const catalogue=await request('/api/extensions/catalogue');assert.equal(catalogue.items.length,5);
  const selected=catalogue.items.find(row=>row.id==='virtual-trial');
  const installed=await request('/api/extensions/installations','POST',{coordinate:selected.coordinate,scope:'project',projectId:'default',idempotencyKey:'native-first'});
  let job;
  for(let n=0;n<90;n++){job=await request('/api/extensions/jobs/'+installed.job.id);if(['succeeded','failed','canceled'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,1000));}
  assert.equal(job?.status,'succeeded',JSON.stringify(job));
  const recorded=await app.extensionService.jobs.get(registered.data.user.id,installed.job.id);
  assert.equal(recorded.result.imageId,img);assert.equal(recorded.result.receiptDigest,manifest.admittedNativeBundles.find(row=>row.id==='virtual-trial').receiptDigest);
  console.log(JSON.stringify({stage:'leased-preparation',status:'passed',image:img}));
  const user={id:registered.data.user.id};
  const project=await app.extensionService.access.project(user,'default');
  try { await app.hostedExtensions.reconcile(user,'default'); } catch(error) { console.error('reconcile diagnostic:',error.code,error.message); throw error; }
  const waitEffective=async expected=>{
    let view,state;
    for(let n=0;n<150;n++){
      view=await request('/api/projects/default/extensions');state=await app.hostedExtensions.generations.current(project);
      const applied=state?.payload.effective?.projection.plugins.filter(row=>row.enabled&&row.compatibility!=='legacy-citation-v1').map(row=>row.extensionId).sort();
      if(state?.payload.phase==='effective'&&JSON.stringify(applied)===JSON.stringify([...expected].sort())&&expected.every(id=>view.selections.some(row=>row.catalogueId===id&&row.effective)))break;
      if(state?.payload.phase==='failed'||state?.payload.phase==='rolled-back')throw new Error(`Apply failed: ${JSON.stringify(state.payload.findings)}`);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.equal(state?.payload.phase,'effective');
    const candidate=state.payload.effective;
    const proof=await app.runtimeManager.probeGeneration(project,candidate);
    const active=proof.inventory.filter(row=>row.enabled&&row.extensionId!=='dsh-cite').map(row=>row.extensionId).sort();
    assert.deepEqual(active,[...expected].sort());
    return view;
  };
  await waitEffective(['virtual-trial']);
  console.log(JSON.stringify({stage:'single-package-proof',status:'passed'}));
  for(const id of ['virtual-cohort','virtual-patient','synthetic-control','virtual-research-suite']){
    const item=catalogue.items.find(row=>row.id===id);
    const added=await request('/api/extensions/installations','POST',{coordinate:item.coordinate,scope:'library',idempotencyKey:`native-${id}`});
    let next;
    for(let n=0;n<90;n++){next=await request('/api/extensions/jobs/'+added.job.id);if(['succeeded','failed','canceled'].includes(next.status))break;await new Promise(resolve=>setTimeout(resolve,1000));}
    assert.equal(next?.status,'succeeded',JSON.stringify(next));
  }
  const library=await request('/api/extensions/installations');
  const desired=['virtual-trial','virtual-cohort','virtual-patient','synthetic-control','virtual-research-suite'];
  let view=await request('/api/projects/default/extensions');
  const rows=desired.map(id=>{const existing=view.selections.find(row=>row.catalogueId===id);const item=existing??library.items.find(row=>row.catalogueId===id);assert(item,`Missing installation ${id}`);return{installationId:existing?.installationId??item.id,enabled:true,settings:{},connectionRefs:[]};});
  await request('/api/projects/default/extensions','PUT',{expectedRevision:view.revision,selections:rows});
  await waitEffective(desired);
  console.log(JSON.stringify({stage:'four-packages-and-suite-proof',status:'passed'}));
  view=await request('/api/projects/default/extensions');
  await request('/api/projects/default/extensions','PUT',{expectedRevision:view.revision,selections:rows.map(row=>({...row,enabled:false}))});
  await waitEffective([]);
  console.log(JSON.stringify({stage:'disable-proof',status:'passed'}));
  view=await request('/api/projects/default/extensions');
  await request('/api/projects/default/extensions','PUT',{expectedRevision:view.revision,selections:rows});
  await waitEffective(desired);
  console.log(JSON.stringify({stage:'reenable-proof',status:'passed'}));
  // Corrupt only the new test generation after its first genuine prepare; the
  // real replacement must reject it and restore/prove the prior runtime.
  const good=(await app.hostedExtensions.generations.current(project)).payload.effective;
  let armed=true,damaged=null;
  const realPrepare=app.runtimeManager.prepareGeneration.bind(app.runtimeManager);
  const realRestore=app.runtimeManager.restoreGeneration.bind(app.runtimeManager);
  app.runtimeManager.prepareGeneration=async (target,candidate)=>{
    const result=await realPrepare(target,candidate);
    if(armed&&candidate.reference?.generationHash!==good.reference.generationHash){
      armed=false;const file=path.join(extensionGenerationRoot(app.config,candidate.reference),'selected','projection.json');
      const bytes=await fs.readFile(file);await fs.chmod(file,0o600);await fs.writeFile(file,'{}');await fs.chmod(file,0o444);damaged={file,bytes};
    }
    return result;
  };
  app.runtimeManager.restoreGeneration=async (...args)=>{
    if(damaged){await fs.chmod(damaged.file,0o600);await fs.writeFile(damaged.file,damaged.bytes);await fs.chmod(damaged.file,0o444);damaged=null;}
    return realRestore(...args);
  };
  view=await request('/api/projects/default/extensions');
  await request('/api/projects/default/extensions','PUT',{expectedRevision:view.revision,selections:rows});
  let rolled;
  for(let n=0;n<150;n++){rolled=await app.hostedExtensions.generations.current(project);if(['rolled-back','failed'].includes(rolled?.payload.phase))break;await new Promise(resolve=>setTimeout(resolve,1000));}
  assert.equal(rolled?.payload.phase,'rolled-back',JSON.stringify(rolled?.payload.findings));
  assert.equal(rolled.payload.effective.reference.generationHash,good.reference.generationHash);
  await app.runtimeManager.probeGeneration(project,good);
  console.log(JSON.stringify({stage:'corrupted-candidate-rollback-proof',status:'passed'}));
  view=await request('/api/projects/default/extensions');
  await request('/api/projects/default/extensions','PUT',{expectedRevision:view.revision,selections:rows});
  await waitEffective(desired);
  if(process.env.VCR_RUN_CONVERSATIONS==='1') {
    await fs.writeFile('/data/conversation-watchdog.jsonl','',{mode:0o600});
    await fs.writeFile('/data/watchdog-target.txt',process.env.VCR_CHAIN_THEN_FORMAL==='1'?'native-chain-results.json':'conversation-results.json',{mode:0o600});
    for(const file of ['live-deadline-watchdog.mjs','live-budget-ledger.mjs','live-usage-ledger.mjs'])observers.push(spawn(process.execPath,[new URL(file,import.meta.url).pathname],{stdio:'ignore'}));
    const budget=async()=>{const result=await app.store.database.query("SELECT coalesce(sum(CASE WHEN status='settled' THEN actual_cost WHEN status='uncertain' THEN coalesce(estimated_cost,reserved_cost) WHEN status='reserved' THEN reserved_cost ELSE 0 END),0) AS total FROM evimed_usage.model_requests",[]);return Number(result.rows[0].total);};
    const caseIds=process.env.VCR_RETEST_IDS?process.env.VCR_RETEST_IDS.split(','):null;
    const readSkills=async(projectId,sessionId)=>{const target=await app.extensionService.access.project(user,projectId),runtime=app.runtimeManager.runtimes.get(app.runtimeManager.key(target));const value=await app.runtimeManager.callKernel(runtime,target,'skills/list',{request:{sessionId}},AbortSignal.timeout(10000));return value.skills.filter(skill=>['virtual-trial','virtual-cohort','virtual-patient','synthetic-control'].includes(skill.name)).map(skill=>({name:skill.name,modelInvocable:skill.modelInvocable}));};
    const afterTurn=process.env.VCR_CASE_SUITE==='completion'?async({projectId,result,call})=>{
      const snapshots=[];
      const observe=async phase=>{
        const target=await app.extensionService.access.project(user,projectId),state=await app.hostedExtensions.generations.current(target),generation=app.runtimeManager.currentGeneration(target);
        const describe=value=>value?{reference:value.reference,identity:value.identity,scope:value.scope,bindings:value.bindings,projection:value.projection,mountIdentity:extensionMountIdentity(value)}:null;
        let fresh=null,freshError=null;
        try{const actor=state?.payload.effective?.scope;if(actor)fresh=(await app.store.database.transaction(client=>app.store.database.withTransactionClient(client,()=>app.hostedExtensions.generations.snapshot({id:actor.actorId,accountCreatedAt:actor.actorAccountCreatedAt},projectId,client)))).manifest;}catch(error){freshError={code:error.code??null,message:String(error.message??'').slice(0,200)};}
        const wanted=await app.runtimeManager.extensionGenerationResolver(target);
        const jobs=await app.store.database.query("SELECT j.id,j.method,j.state,j.created_at,j.finished_at,j.error,j.checkpoint->'conversationOrigin' AS origin,e.id AS execution_id,r.id AS result_id,r.version AS result_version FROM evimed_vcr.jobs j JOIN evimed_vcr.studies s ON s.id=j.study_id LEFT JOIN evimed_vcr.executions e ON e.job_id=j.id LEFT JOIN evimed_vcr.results r ON r.execution_id=e.id WHERE j.user_id=$1 AND s.project_id=$2 ORDER BY j.created_at,j.id",[user.id,projectId]);
        const outbox=await app.store.database.query('SELECT id,job_id,dispatch_id,dispatch_generation,state,attempts,last_error,root_session_id,created_at,updated_at FROM evimed_vcr.conversation_completions WHERE user_id=$1 AND project_id=$2 ORDER BY created_at,id',[user.id,projectId]);
        const continuations=(await app.agentRuns.list(target)).filter(run=>String(run.dispatchId??'').startsWith('vcr-completion-')).map(run=>({id:run.id,dispatchId:run.dispatchId,status:run.status,automated:run.automated}));
        snapshots.push({phase,at:new Date().toISOString(),rootRunId:result.runId,runtimeGeneration:app.runtimeManager.runtimeGeneration(target),generationReference:generation?.reference??null,generationPhase:state?.payload.phase??null,effective:describe(state?.payload.effective),desired:describe(state?.payload.desired),runtime:describe(generation),fresh:describe(fresh),freshError,wantedReference:wanted?.reference??null,jobs:jobs.rows,outbox:outbox.rows,continuations});
        await fs.writeFile('/data/completion-snapshots.json.next',JSON.stringify({schemaVersion:1,projectId,snapshots})+'\n',{mode:0o600});await fs.rename('/data/completion-snapshots.json.next','/data/completion-snapshots.json');
        return {jobs:jobs.rows,outbox:outbox.rows,continuations};
      };
      const first=await observe('root-turn-ended');if(!first.jobs.length)throw new Error('No async job was created');
      await new Promise(resolve=>setTimeout(resolve,15000));await observe('before-stop');
      try{await call('POST','/api/commands/stop_runtime',{},true);}catch(error){snapshots.push({phase:'stop-error',code:error.code??'unknown',message:String(error.message).slice(0,200)});}
      for(let n=0;n<24;n++){await new Promise(resolve=>setTimeout(resolve,5000));const current=await observe(`after-stop-${n}`);if(n>=11&&current.jobs.every(job=>['succeeded','failed','canceled'].includes(job.state))&&current.outbox.length>=current.jobs.length&&current.outbox.every(row=>['delivered','unavailable'].includes(row.state))&&current.continuations.every(run=>!['running','queued','waiting'].includes(run.status)))break;}
    }:process.env.VCR_CASE_SUITE==='post-audit'?async({projectId,result})=>{
      let snapshot=[];
      for(let n=0;n<18;n++){
        const query=await app.store.database.query("SELECT j.id,j.study_id,j.method,j.method_version,j.state,j.scenario,j.scenario_hash,j.seed,j.replicates,j.progress,j.error,j.created_at,j.finished_at,e.id AS execution_id,e.seed AS executed_seed,e.replicates AS executed_replicates,e.output_hash,r.id AS result_id,r.version AS result_version,r.conclusion,r.counts,r.measures,r.diagnostics FROM evimed_vcr.jobs j JOIN evimed_vcr.studies s ON s.id=j.study_id LEFT JOIN evimed_vcr.executions e ON e.job_id=j.id LEFT JOIN evimed_vcr.results r ON r.execution_id=e.id WHERE j.user_id=$1 AND s.project_id=$2 ORDER BY j.created_at,j.id",[user.id,projectId]);
        snapshot=query.rows;if(snapshot.every(job=>['succeeded','failed','canceled'].includes(job.state)))break;
        await new Promise(resolve=>setTimeout(resolve,5000));
      }
      const target='/data/post-audit-jobs.json';let records=[];try{records=JSON.parse(await fs.readFile(target,'utf8')).records;}catch(error){if(error.code!=='ENOENT')throw error;}
      records.push({caseId:result.id,projectId,at:new Date().toISOString(),jobs:snapshot});
      await fs.writeFile(target+'.next',JSON.stringify({schemaVersion:1,records})+'\n',{mode:0o600});await fs.rename(target+'.next',target);
    }:null;
    const installationsForCase=item=>{const ids={'chain-trial':'virtual-trial','chain-cohort':'virtual-cohort','chain-patient':'virtual-patient','chain-control':'synthetic-control'},index=desired.indexOf(ids[item.id]);if(index<0)throw new Error('Invalid isolated native case');return [rows[index].installationId];};
    if(process.env.VCR_CHAIN_THEN_FORMAL==='1') {
      const chains=await runConversations({base,headers,installations:rows.map(row=>row.installationId),output:'/data/native-chain-results.json',budget,budgetLimit:options.userDailySpendLimit,readSkills,suite:'native-chain',installationsForCase});
      for(const item of chains){
        const prefix={'chain-trial':'virtual_trial','chain-cohort':'virtual_cohort','chain-patient':'virtual_patient','chain-control':'synthetic_control'}[item.id];
        const calls=(item.transcript?.messages??[]).flatMap(message=>message.parts??[]).filter(part=>part.type==='tool');
        const success=(name,predicate=()=>true)=>calls.some(call=>call.tool===`${prefix}_${name}`&&!String(call.output??'').startsWith('Error:')&&predicate(call));
        const ok=item.status==='completed'&&success('describe',call=>Boolean(call.input?.method)&&String(call.output).includes(call.input.method)&&/scenarioSchema|scenario_schema/.test(String(call.output)))&&success('start')&&success('read',call=>/"state"\s*:\s*"succeeded"/.test(String(call.output)))&&success('report',call=>/"report"\s*:/.test(String(call.output)));
        if(!ok)throw new Error(`Native chain did not prove describe/start/read/report: ${item.id}`);
      }
      console.log(JSON.stringify({stage:'native-mechanical-chains',status:'passed',count:chains.length}));
      await fs.writeFile('/data/watchdog-target.txt','conversation-results.json',{mode:0o600});
    }
    const results=await runConversations({base,headers,installations:rows.map(row=>row.installationId),output:'/data/conversation-results.json',budget,budgetLimit:options.userDailySpendLimit,caseIds,readSkills,suite:process.env.VCR_CASE_SUITE||'formal',afterTurn,...(process.env.VCR_CASE_SUITE==='native-chain'?{installationsForCase}:{})});
    await Promise.all(observers.map(observer=>observer.exitCode!==null||observer.signalCode!==null?Promise.resolve():new Promise(resolve=>{observer.once('exit',resolve);observer.kill('SIGTERM');})));observers.length=0;
    const usage=await app.store.database.query("SELECT project_id,run_id,session_id,purpose,status,model,observed_model,error_code,created_at,settled_at,actual_cost,estimated_cost,reserved_cost FROM evimed_usage.model_requests ORDER BY created_at,id");
    await fs.writeFile('/data/conversation-usage.json',JSON.stringify({at:new Date().toISOString(),requests:usage.rows})+'\n',{mode:0o600});
    await fs.writeFile('/data/conversation-cost.json',JSON.stringify({at:new Date().toISOString(),totalCny:await budget()})+'\n',{mode:0o600});
    console.log(JSON.stringify({stage:'conversations',total:results.length,completed:results.filter(row=>row.status==='completed').length}));
  }
} finally {for(const observer of observers)observer.kill('SIGTERM');await app.close().catch(()=>{});await budgetGuard?.close().catch(()=>{});await controller?.close().catch(()=>{});await composition?.close().catch(()=>{});await fs.rm('/data/.openscience/extensions-deployment.json',{force:true});}
