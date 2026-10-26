import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrGatewayHandler } from '../src/vcrGateway.mjs';
import { createVcrModelSources } from '../src/vcrModelSources.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const run = promisify(execFile);
const engineRequired = process.env.VCR_ENGINE_TESTS === 'required';
const hasR = spawnSync('Rscript',['-e', 'lib <- Sys.getenv("VCR_R_LIBS", ""); if(nzchar(lib)) .libPaths(c(lib, .libPaths())); quit(status=if(all(vapply(c("jsonlite","digest","survival"),requireNamespace,logical(1),quietly=TRUE)))0 else 1)']).status===0;
const options = { skip: !engineRequired && (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? 'Owned local PostgreSQL is required' : !hasR && 'Local R with jsonlite/digest/survival is required') };
let database, isolated, root, vcr, study, source;
const origin = { userId:'science_owner', projectId:'science_project', rootSessionId:'science_session', sessionId:'science_session', runId:'science_run', callId:'science_call' };
const text = 'Adults receiving standard care were evaluated at 12 months. Logistic equation: logit(p) = -3 + 0.02 * age in years, without centering.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const engineRoot = fileURLToPath(new URL('../../../../项目代码/vcr-engine', import.meta.url));
before(async () => {
  if(options.skip) return;
  assert.ok(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'Owned local PostgreSQL is required');
  assert.ok(hasR, 'Rscript with jsonlite/digest/survival in VCR_R_LIBS or the default library is required');
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrscience');
  database = new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:6,databaseConnectionTimeoutMs:2000});
  root = await fs.mkdtemp(path.join(os.tmpdir(),'vcr-science-'));
  vcr = composeVcr({productDatabase:database,config:{vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:root,vcrStudyCpuBudget:12000,vcrJobCpuSeconds:60,vcrMaxConcurrentJobs:1}});
  await vcr.store.ready();study = await vcr.store.taskContext(origin);
  source = {id:`src_${'b'.repeat(32)}`,userId:origin.userId,projectId:origin.projectId,payload:{title:'Synthetic published equation fixture',generation:1,status:'ready',analysis:{textSha256:hash(text)}}};
  const sources = {get:async(user,id)=>{assert.equal(user,origin.userId);assert.equal(id,source.id);return source;},loadCapture:async()=>({input:{text}}),getUnderstanding:async()=>null,getMaterials:async()=>null};
  vcr.service.packages.modelSources = createVcrModelSources({sources});
  // The actual local R numerical process; authenticated transport/signature is represented by this owned fixture.
  const outputs = new Map();
  vcr.jobs.engine = {configured:()=>true,submit:async job=>{
    const out=path.join(root,'engine',job.jobId);await fs.mkdir(out,{recursive:true});const file=path.join(out,'job.json');await fs.writeFile(file,JSON.stringify(job));
    await run('Rscript',[path.join(engineRoot,'service/run_job.R'),file,out],{env:{...process.env,VCR_ENGINE_ROOT:engineRoot,VCR_ENGINE_DATA_ROOT:root,VCR_ENGINE_CORES:'1'},timeout:30000});
    outputs.set(job.jobId,{out,result:JSON.parse(await fs.readFile(path.join(out,'result.json'),'utf8'))});return{accepted:true,jobId:job.jobId};
  },status:async id=>({state:outputs.get(id).result.status,progress:{done:1,total:1}}),result:async id=>({result:outputs.get(id).result,signed:true}),
  downloadTable:async(id,name,{destination,sha256})=>{const data=await fs.readFile(path.join(outputs.get(id).out,`${name}.csv`));assert.equal(hash(data),sha256);await fs.writeFile(destination,data);}};
});
after(async()=>{await database?.close();await isolated?.drop();if(root)await fs.rm(root,{recursive:true,force:true});});
async function invoke(body) {
  const handler=createVcrGatewayHandler({vcrEnabled:true},{assertActiveModelGatewayToken:()=>({userId:origin.userId,projectId:origin.projectId})},{vcr,resolveInvocation:async()=>origin});
  const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method:'POST',url:'/internal/vcr/v1/simulate',headers:{authorization:'Bearer owned-test','x-evimed-execution-context':'owned-test'}});
  let status,answer;await handler(req,{writeHead:code=>{status=code;},end:bytes=>{answer=JSON.parse(bytes);}});return{status,answer};
}
async function finish(jobId) {
  const [job]=await vcr.jobs.claim();assert.equal(job.id,jobId);await vcr.jobs.advance(job);await vcr.jobs.advance(job);
  const saved=await vcr.jobs.get(study.id,jobId);assert.equal(saved.state,'succeeded',JSON.stringify(saved.error));
  return vcr.jobs.resultOf(study.id,jobId);
}
test('source adoption → native population-bound prediction → saved patient/comparator → model-bound design uses actual R results',options,async()=>{
  const definition={n:40,population:{variables:[{name:'age',family:'normal',mean:50,sd:5}]}};
  const population=await vcr.store.savePopulation({studyId:study.id,userId:origin.userId,name:'Frozen generated adults',kind:'scenario',definition});
  const generated=await invoke({action:'start',kind:'generate_population',subjectId:population.id,scenario:definition});assert.equal(generated.status,200,JSON.stringify(generated.answer));
  const popResult=await finish(generated.answer.data.jobId);assert.equal(popResult.counts.generatedRecords,40);
  const preview=await vcr.service.modelSourcePreview({id:origin.userId},study.id,source.id);
  const occurrence=value=>preview.parameters.find(row=>row.value===value).id;
  const card={literatureSource:preview,executionProfile:'model.prognostic_apply',equation:{sourceCondition:'standard_care',endpoint:{type:'binary',horizon:12,timeUnit:'months'},model:{family:'logistic',intercept:0,terms:[{column:'age',coefficient:0,transform:'identity',unit:'years',center:0,scale:1}]}},parameterBindings:[{field:'model.intercept',candidateId:occurrence(-3)},{field:'model.terms.0.coefficient',coefficientScale:'linear_predictor',candidateId:occurrence(0.02)},{field:'endpoint.horizon',candidateId:occurrence(12)}],semanticBindings:['endpoint','population','sourceCondition','model.terms.0'].map(field=>({field,quote:text,start:0,end:text.length}))};
  const adopted=await vcr.service.adoptModel({id:origin.userId},{studyId:study.id,name:'Source equation',version:'1.0.0',card,applicability:{endpoints:['binary']}});
  const model=(await vcr.store.models(origin.userId)).find(row=>row.id===adopted.id);
  assert.equal(model.card.registrationState,'source_bound_equation');
  await assert.rejects(vcr.service.adoptModel({id:origin.userId},{studyId:study.id,name:'Source equation',version:'1.0.0',card}),{code:'vcr_model_exists'});
  assert.equal((await vcr.store.models(origin.userId)).find(row=>row.id===model.id).card.executionSpec.scenario.model.intercept,-3);
  const scenario={...model.card.executionSpec.scenario,inputUnits:{age:'years'}};
  const patients=await vcr.store.savePatientSet({studyId:study.id,userId:origin.userId,populationId:population.id,modelId:model.id,modelVersion:model.version,scenario});
  const body={action:'start',kind:'apply_prognostic_model',subjectId:patients.id,modelId:model.id,modelVersion:model.version,scenario};
  assert.equal((await invoke({...body,modelVersion:'stale'})).status,409);
  const started=await invoke(body);assert.equal(started.status,200,JSON.stringify(started.answer));
  const prediction=await finish(started.answer.data.jobId);
  assert.equal(prediction.kind,'patient_set');assert.equal(prediction.subjectId,patients.id);assert.equal(prediction.counts.realPatients,0);assert.equal(prediction.counts.generatedRecords,40);
  assert.equal(prediction.diagnostics.sourceModel.source.textSha256,hash(text));assert.equal(prediction.diagnostics.populationSelection.populationId,population.id);
  assert.equal((await vcr.store.patientSets(study.id)).find(row=>row.id===patients.id).resultId,prediction.id);
  const comparator=await vcr.store.saveComparatorDesign({studyId:study.id,userId:origin.userId,route:'model_comparator',estimand:'ATT',configuration:{populationId:population.id,modelId:model.id,modelVersion:model.version,endpoint:scenario.endpoint}});
  const compare=await invoke({...body,subjectId:comparator.id});assert.equal(compare.status,200,JSON.stringify(compare.answer));const benchmark=await finish(compare.answer.data.jobId);
  assert.equal(benchmark.kind,'comparator');assert.equal(benchmark.counts.realPatients,0);assert.equal(benchmark.diagnostics.causalEffectIdentified,false);
  const target=prediction.measures.find(row=>row.name==='predicted_population_mean').value;
  const configuration={modelResultId:prediction.id,modelResultVersion:prediction.version,endpoint:scenario.endpoint,design:{kind:'two_arm_fixed'},truth:{controlRate:0.99,treatmentRate:0.4},analysis:{alpha:0.05,power:0.8,sided:2}};
  const design=await vcr.store.saveTrialScenario({studyId:study.id,userId:origin.userId,label:'Prediction baseline',design:'two_arm_fixed',endpointType:'binary',configuration});
  const designed=await invoke({action:'start',kind:'design_analytic',subjectId:design.id,scenario:configuration});assert.equal(designed.status,200,JSON.stringify(designed.answer));
  const frozen=await vcr.store.one('SELECT id,scenario FROM evimed_vcr.jobs WHERE id=$1',[designed.answer.data.jobId]);assert.equal(frozen.scenario.truth.controlRate,target);assert.equal(frozen.scenario.truth.treatmentRate,0.4);
  const result=await finish(frozen.id);assert.equal(result.subjectId,design.id);assert.equal(result.diagnostics.modelDesign.resultId,prediction.id);assert.equal(result.diagnostics.modelDesign.assurance,false);
  await assert.rejects(vcr.service.modelExecution({id:'foreign'},study,model.id,'apply_prognostic_model',scenario));
  source.payload.generation=2;assert.equal((await invoke(body)).status,409);
});
test('observed snapshot months cannot be relabeled as predictor years, and canonical event tables retain their actual time units',options,async()=>{
  const owner={id:origin.userId};const observed=await vcr.dataPlane.registerSource({studyId:study.id,userId:origin.userId,name:'Synthetic observed-unit fixture'});
  const csv='participant,age,time,status,arm\n'+Array.from({length:20},(_,i)=>`S${i},${i<10?600:300},${i+1},${i%2},control`).join('\n')+'\n';
  await vcr.dataPlane.storeUpload({actor:origin.userId,studyId:study.id,sourceId:observed.id,name:'observed.csv',stream:Readable.from([Buffer.from(csv)])});
  const columns=[{table:'observed.csv',column:'participant',role:'subject_key'},{table:'observed.csv',column:'age',role:'covariate',alias:'age',unit:'months'},
    {table:'observed.csv',column:'time',role:'outcome_time',parameter:'OS',unit:'months'},{table:'observed.csv',column:'status',role:'outcome_event',parameter:'OS',codes:{event:['1'],censored:['0']}},
    {table:'observed.csv',column:'arm',role:'arm',codes:{treated:['treatment'],control:['control']}}];
  const proposed=await vcr.dataPlane.proposeFieldMap({actor:origin.userId,studyId:study.id,sourceId:observed.id,columns});await vcr.dataPlane.confirmFieldMap({actor:origin.userId,studyId:study.id,sourceId:observed.id,hash:proposed.hash});
  const frozen=await vcr.dataPlane.freezeSnapshot({userId:origin.userId,studyId:study.id,sourceId:observed.id});
  const model=(await vcr.store.models(origin.userId)).find(row=>row.name==='Source equation');
  source.payload.generation=1;
  const scenario={...model.card.executionSpec.scenario,inputId:`${frozen.snapshot.id}:subject`,idColumn:'USUBJID',inputUnits:{age:'years'}};
  const population=await vcr.store.savePopulation({studyId:study.id,userId:origin.userId,name:'Selected older baseline',kind:'real',snapshotId:frozen.snapshot.id,definition:{rules:[{name:'older',rule:{op:'compare',column:'age',comparator:'gte',value:500}}]}});
  const subject=await vcr.store.savePatientSet({studyId:study.id,userId:origin.userId,populationId:population.id,modelId:model.id,modelVersion:model.version,scenario});
  const native=await invoke({action:'start',kind:'apply_prognostic_model',subjectId:subject.id,modelId:model.id,modelVersion:model.version,scenario});assert.equal(native.status,200,JSON.stringify(native.answer));
  const job={job:{id:native.answer.data.jobId}};
  const queued=await vcr.store.one('SELECT scenario,inputs FROM evimed_vcr.jobs WHERE id=$1',[job.job.id]);assert.equal(queued.scenario.inputUnits.age,'months');assert.ok(queued.inputs.every(input=>!input.columnUnits));
  const result=await finish(job.job.id);assert.equal(result.conclusion,'not_estimable');assert.equal(result.diagnostics.validPredictions,0);assert.equal(result.measures.length,0);assert.equal(result.counts.realPatients,10);assert.equal(result.diagnostics.cohort.startingRows,20);assert.equal(result.diagnostics.cohort.keptRows,10);assert.equal(result.subjectId,subject.id);
  const standalone=await invoke({action:'start',kind:'apply_prognostic_model',modelId:model.id,modelVersion:model.version,scenario,inputs:[{kind:'snapshot',id:frozen.snapshot.id}]});assert.equal(standalone.status,200,JSON.stringify(standalone.answer));
  const standaloneResult=await finish(standalone.answer.data.jobId);assert.equal(standaloneResult.kind,'model_prediction');assert.equal(standaloneResult.counts.realPatients,20);assert.ok(standaloneResult.tables.find(table=>table.name==='prognostic-predictions').location.startsWith('derived/'));
  const fitScenario={inputId:`${frozen.snapshot.id}:events`,idColumn:'USUBJID',timeColumn:'AVAL',statusColumn:'CNSR',statusEncoding:'censor',distribution:'exponential',timeUnit:'months',horizons:[6,12],parameterColumn:'PARAMCD',parameterValue:'OS'};
  const fit=await vcr.jobs.enqueue({studyId:study.id,userId:owner.id,kind:'fit_survival_model',scenario:fitScenario,inputs:[{kind:'snapshot',id:frozen.snapshot.id}]});
  const fitted=await finish(fit.job.id);assert.equal(fitted.counts.realPatients,20);assert.equal(fitted.diagnostics.timeUnit,'months');
  await assert.rejects(vcr.jobs.enqueue({studyId:study.id,userId:owner.id,kind:'fit_survival_model',scenario:{...fitScenario,timeUnit:'years'},inputs:[{kind:'snapshot',id:frozen.snapshot.id}]}),{code:'vcr_model_not_applicable'});
});
