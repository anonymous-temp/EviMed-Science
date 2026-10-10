import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { renderVcrNumbers } from '../src/vcrRender.mjs';
import { modelReportDocumentSections } from '../src/vcrModelDocuments.mjs';
import { VcrOrchestrator } from '../src/vcrOrchestrator.mjs';

const options = {skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required'};
let database,isolated,root,vcr,target,history,outcomes,snapshot,mappings,source;
before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'vcrlong');
  database = new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  root = await fs.mkdtemp(path.join(os.tmpdir(),'vcr-longitudinal-'));
  await fs.writeFile(path.join(root,'providers.json'),JSON.stringify({providers:[]}));
  vcr = composeVcr({config:{vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:root,vcrForecastProvidersFile:path.join(root,'providers.json')},productDatabase:database});
  vcr.orchestrator = new VcrOrchestrator({store:vcr.store,jobs:vcr.jobs,config:{},dispatchRun:null});
  await vcr.store.ready();
  target = await vcr.store.createStudy({userId:'owner',projectId:'synthetic-longitudinal',name:'Synthetic longitudinal pilot',question:'HbA1c forecast',dataTier:'T0'});
  source = await vcr.dataPlane.registerSource({userId:'owner',studyId:target.id,name:'Authored synthetic fixture',allowedUses:['vcr'],valueSource:'synthetic'});
  const rows = ['PATIENT,AT,AVAILABLE,HBA1C'];
  for (let i=0;i<40;i++) for (const [at,increment] of [['2025-12-01',0],['2026-01-01',.2],['2026-01-31',.4]]) rows.push(`CANARY-${i},${at},${at},${6+i/20+increment}`);
  await vcr.dataPlane.storeUpload({actor:'owner',studyId:target.id,sourceId:source.id,name:'events.csv',stream:streamOf(rows.join('\n'))});
  const mapped = await vcr.dataPlane.proposeFieldMap({actor:'owner',studyId:target.id,sourceId:source.id,columns:[
    {table:'events.csv',column:'PATIENT',role:'subject_key',identifier:true},
    {table:'events.csv',column:'AT',role:'visit_date',timeKind:'occurred_at',type:'date'},
    {table:'events.csv',column:'AVAILABLE',role:'other',timeKind:'visible_at',type:'date'},
    {table:'events.csv',column:'HBA1C',role:'measurement',parameter:'HBA1C',unit:'%',type:'number'},
  ]});
  assert.deepEqual(mapped.entryIssues,[]);
  await vcr.dataPlane.confirmFieldMap({actor:'owner',studyId:target.id,sourceId:source.id,hash:mapped.hash});
  const frozen = await vcr.dataPlane.freezeSnapshot({userId:'owner',studyId:target.id,sourceId:source.id});
  snapshot = frozen.snapshot;
  mappings = [{inputId:`${snapshot.id}:1`,subjectColumn:'USUBJID',code:'HbA1c',valueColumn:'HBA1C',unit:'%',occurredColumn:'AT',availableColumn:'AVAILABLE',basis:'dictionary_stated'}];
});
after(async () => {await database?.close();await isolated?.drop();if(root)await fs.rm(root,{recursive:true,force:true});});

test('real intake -> immutable history -> imported prediction -> queued evaluation -> runtime aggregate',options,async () => {
  history = await vcr.longitudinal.freezeHistory(target,{snapshotId:snapshot.id,asOf:'2026-01-01',mappings,split:{mode:'patient',seed:'pilot'}},'owner');
  assert.equal(history.summary.subjects,40);
  assert.equal(history.summary.events,80);
  assert.equal(history.summary.coverage.excluded.future_occurrence,40);
  assert.equal((await vcr.longitudinal.freezeHistory(target,{snapshotId:snapshot.id,asOf:'2026-01-01',mappings,split:{mode:'patient',seed:'pilot'}},'owner')).id,history.id);
  const raw = await vcr.longitudinal.artifacts.read(target,history.id,'owner');
  assert.ok(!JSON.stringify(raw.content).includes('CANARY-'));
  const sourceMapped = await vcr.longitudinal.freezeHistory(target,{snapshotId:snapshot.id,asOf:'2026-01-01',
    mappings:mappings.map(mapping=>({...mapping,subjectColumn:'PATIENT'}))},'owner');
  const sourceMappedContent = await vcr.longitudinal.artifacts.read(target,sourceMapped.id,'owner');
  assert.deepEqual(sourceMappedContent.content.events,raw.content.events);
  assert.equal((await vcr.dataPlane.snapshotProfileForModel({studyId:target.id,snapshotId:snapshot.id,principal:'owner'})).inputProjection.subjectColumn,'USUBJID');
  outcomes = await vcr.longitudinal.freezeHistory(target,{snapshotId:snapshot.id,asOf:'2026-02-01',mappings},'owner');
  const input = {schema:1,historyId:history.id,origin:history.summary.origin,subjectKeyMode:'source_identifier',
    endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[30],model:{name:'synthetic-known-error',version:'1'},
    rows:Array.from({length:40},(_,i) => ({subjectKey:`CANARY-${i}`,horizonDays:30,point:6+i/20+.3,sd:.5,uncertainty:'predictive'}))};
  const predicted = await vcr.longitudinal.importPrediction(target,input,'owner');
  assert.equal(predicted.summary.accepted,40);
  await assert.rejects(() => vcr.longitudinal.importPrediction(target,{...input,horizonsDays:'30'},'owner'),{code:'vcr_forecast_unavailable'});
  const damagedBenchmark = await vcr.longitudinal.importBenchmark(target,{comparisons:[null,{evidenceId:'missing'}]},'owner');
  assert.equal(damagedBenchmark.summary.comparisons,2);
  const queued = await vcr.longitudinal.prepare(target,{kind:'evaluate_forecast',scenario:{predictionId:predicted.id,outcomeHistoryId:outcomes.id,bootstrap:30}},'owner');
  const claims = await vcr.jobs.claim();assert.equal(claims[0].id,queued.job.id);
  await vcr.jobs.advance(claims[0]);
  const finished = await vcr.jobs.get(target.id,queued.job.id);
  assert.equal(finished.state,'succeeded',JSON.stringify(finished));
  const stored = await vcr.jobs.resultOf(target.id,queued.job.id);
  const groups = stored.diagnostics.longitudinal.summary.groups;
  assert.ok(groups[0].subjects > 0);
  assert.equal(stored.diagnostics.longitudinal.summary.validationClass,'engineering_synthetic');
  assert.ok(Math.abs(groups[0].metrics.mae.value-.1)<1e-12);
  const shown = await vcr.service.runtimeRead(target,'longitudinal');
  assert.ok(!JSON.stringify(shown).includes('CANARY-'));
  assert.ok(!JSON.stringify(shown).includes(raw.content.events[0].subjectKey));
  assert.ok(!JSON.stringify(shown).includes(root));
  assert.ok(shown.records.some(r => r.kind === 'evaluation'));
  const linked = await vcr.service.runtimeRead(target,'longitudinal',{id:predicted.id});
  assert.equal(linked.records[0].relatedIds.evaluation,stored.diagnostics.longitudinal.id);
  assert.ok(linked.related.some(r=>r.id===stored.diagnostics.longitudinal.id));
  const evaluations = await vcr.service.runtimeRead(target,'longitudinal',{parentId:predicted.id,kind:'evaluation'});
  assert.equal(evaluations.records[0].id,stored.diagnostics.longitudinal.id);
});

test('other studies cannot select histories; altered bytes decline only the affected read',options,async () => {
  const other = await vcr.store.createStudy({userId:'owner',projectId:'synthetic-other',name:'Other',question:'q',dataTier:'T0'});
  await assert.rejects(() => vcr.longitudinal.artifacts.read(other,history.id,'owner'),{code:'vcr_longitudinal_not_found'});
  const row = await vcr.longitudinal.artifacts.record(target.id,history.id);
  const file = vcr.dataPlane.resolve(row.location),bytes = await fs.readFile(file);
  await fs.writeFile(file,'{}');
  await assert.rejects(() => vcr.longitudinal.artifacts.read(target,history.id,'owner'),{code:'vcr_longitudinal_changed'});
  await fs.writeFile(file,bytes);
  assert.ok((await vcr.longitudinal.view(target)).records.length>0);
});

test('the DSH write path freezes inputs from metadata, and missing cloud service leaves other work usable',options,async () => {
  const answer = await vcrRuntimeWrite({study:target,store:vcr.store,service:vcr.service,what:'history',
    items:[{snapshotId:snapshot.id,asOf:'2026-01-01',mappings}],orchestrator:null,report:()=>{}});
  assert.equal(answer.ids.length,1,JSON.stringify(answer));
  await assert.rejects(() => vcr.longitudinal.prepare(target,{kind:'forecast_trajectories',scenario:{historyId:history.id,
    providerId:'not-configured',endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[30]}},'owner'),{code:'vcr_forecast_provider_unavailable'});
  assert.ok((await vcr.longitudinal.view(target)).records.some(r => r.kind === 'evaluation'));
});

test('paired design uses the common subjects and keeps predictive variance; evidence numbers remain report references',options,async () => {
  const raw = await vcr.longitudinal.artifacts.read(target,history.id,'owner');
  const subjects = [...new Set(raw.content.events.map(e=>e.subjectKey))];
  const header = {schema:1,historyId:history.id,origin:history.summary.origin,endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[30]};
  const first = await vcr.longitudinal.importPrediction(target,{...header,rows:subjects.slice(0,3).map((subjectKey,i)=>({subjectKey,horizonDays:30,point:6+i,sd:1,uncertainty:'predictive'}))},'owner');
  const second = await vcr.longitudinal.importPrediction(target,{...header,rows:subjects.slice(0,2).map((subjectKey,i)=>({subjectKey,horizonDays:30,point:7+i,sd:1,uncertainty:'predictive'}))},'owner');
  const design = await vcr.longitudinal.enqueueDesign(target,{predictionId:first.id,controlPredictionId:second.id,horizonDays:30},'owner');
  assert.equal(design.available,true);
  const job = await vcr.store.one('SELECT * FROM evimed_vcr.jobs WHERE id=$1',[design.jobId]);
  assert.equal(job.scenario.truth.effect,-1);
  assert.ok(Math.abs(job.scenario.truth.sd-Math.sqrt(1.5))<1e-12);
  assert.equal(job.method,'design.analytic');
  const model = await vcr.service.reportModelFromStore(target,vcr.store);
  assert.ok(model.longitudinal.records.some(r=>r.kind==='evaluation'));
  const index = model.longitudinal.records.findIndex(r=>r.kind==='evaluation');
  const bound = renderVcrNumbers(`平均绝对误差 {{n:longitudinal.records[${index}].summary.groups[0].metrics.mae.value|f2}}`,model);
  assert.equal(bound.bindings[0].ok,true);
  assert.ok(bound.text.includes('0.10'));
  await vcr.jobs.cancel(target.id,design.jobId,{actor:'owner'});
});

test('a heldout prognostic correlation reaches the existing PROCOVA design with its provenance',options,async()=>{
  const header = {schema:1,historyId:history.id,origin:history.summary.origin,subjectKeyMode:'source_identifier',endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[30],model:{name:'noisy-synthetic',version:'1'}};
  const rows = Array.from({length:40},(_,i)=>({subjectKey:`CANARY-${i}`,horizonDays:30,point:6+i/20+.3+.1*Math.sin(i),sd:.5,uncertainty:'predictive'}));
  const predicted = await vcr.longitudinal.importPrediction(target,{...header,rows},'owner');
  const control = await vcr.longitudinal.importPrediction(target,{...header,rows:rows.map(r=>({...r,point:r.point+.3}))},'owner');
  const queued = await vcr.longitudinal.prepare(target,{kind:'evaluate_forecast',scenario:{predictionId:predicted.id,outcomeHistoryId:outcomes.id,bootstrap:0}},'owner');
  const claims = await vcr.jobs.claim({limit:10});
  // An earlier design is intentionally waiting for an external statistical engine.
  await vcr.jobs.advance(claims.find(job=>job.id===queued.job.id));
  const result = await vcr.jobs.resultOf(target.id,queued.job.id);
  const design = await vcr.longitudinal.enqueueDesign(target,{predictionId:predicted.id,controlPredictionId:control.id,horizonDays:30,
    prognosticEvaluationId:result.diagnostics.longitudinal.id,randomizationAt:'2026-03-01',lambda:.8},'owner');
  assert.equal(design.available,true);
  const job = await vcr.store.one('SELECT * FROM evimed_vcr.jobs WHERE id=$1',[design.jobId]);
  assert.equal(job.kind,'procova');assert.ok(job.scenario.prognostic.rho>0 && job.scenario.prognostic.rho<1);
  assert.equal(job.checkpoint.validation.dataClass,'synthetic');assert.equal(job.scenario.prognostic.lambda,.8);
});

test('history updates preserve splits and perturbations are new reproducible versions',options,async()=>{
  const updated = await vcr.longitudinal.freezeHistory(target,{snapshotId:snapshot.id,asOf:'2026-02-01',mappings,priorHistoryId:history.id},'owner');
  assert.equal(updated.summary.events,120);
  assert.equal(updated.summary.coverage.excluded.duplicate,80);
  assert.equal(updated.summary.split.hash,history.summary.split.hash);
  const windowed = await vcr.longitudinal.freezeHistory(target,{snapshotId:snapshot.id,asOf:'2026-01-01',mappings,perturbation:{historyFrom:'2026-01-01'}},'owner');
  assert.equal(windowed.summary.events,40);
  assert.equal(windowed.summary.excludedByPerturbation,40);
  assert.notEqual(windowed.id,history.id);
});

test('provider rollouts produce a new queued prediction instead of returning the old version from cache',options,async()=>{
  const provider = {id:'partner',url:'https://forecast.example.org/predict',model:'synthetic',version:'1',enabled:true,protocol:'evimed-event-history-v1'};
  const request = {kind:'forecast_trajectories',scenario:{historyId:history.id,providerId:'partner',endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[30]}};
  await fs.writeFile(path.join(root,'providers.json'),JSON.stringify({providers:[provider]}));
  const first = await vcr.longitudinal.prepare(target,request,'owner');
  const repeated = await vcr.longitudinal.prepare(target,request,'owner');
  assert.equal(repeated.job.id,first.job.id);
  await fs.writeFile(path.join(root,'providers.json'),JSON.stringify({providers:[{...provider,version:'2'}]}));
  const next = await vcr.longitudinal.prepare(target,request,'owner');
  assert.notEqual(next.job.id,first.job.id);
  assert.equal(next.created,true);
});

test('a table with imputed columns preserves the observed endpoint as observed',options,async()=>{
  const measured = await vcr.dataPlane.registerSource({userId:'owner',studyId:target.id,name:'Authored mixed-provenance fixture',valueSource:'observed'});
  await vcr.dataPlane.storeUpload({actor:'owner',studyId:target.id,sourceId:measured.id,name:'mixed.csv',
    stream:streamOf('PERSON,AT,HBA1C,IMPUTED\nfixture-person,2026-01-01,7,8\n')});
  const map = await vcr.dataPlane.proposeFieldMap({actor:'owner',studyId:target.id,sourceId:measured.id,columns:[
    {table:'mixed.csv',column:'PERSON',role:'subject_key',identifier:true},
    {table:'mixed.csv',column:'AT',role:'visit_date',timeKind:'visible_at',type:'date'},
    {table:'mixed.csv',column:'HBA1C',role:'measurement',parameter:'HBA1C',unit:'%',type:'number',valueSource:'observed'},
    {table:'mixed.csv',column:'IMPUTED',role:'covariate',type:'number',valueSource:'imputed'},
  ]});
  await vcr.dataPlane.confirmFieldMap({actor:'owner',studyId:target.id,sourceId:measured.id,hash:map.hash});
  const {snapshot:held} = await vcr.dataPlane.freezeSnapshot({userId:'owner',studyId:target.id,sourceId:measured.id});
  const version = await vcr.longitudinal.freezeHistory(target,{snapshotId:held.id,asOf:'2026-01-01',mappings:[
    {inputId:`${held.id}:1`,subjectColumn:'PERSON',code:'HbA1c',valueColumn:'HBA1C',unit:'%',occurredColumn:'AT',availableColumn:'AT'},
    {inputId:`${held.id}:1`,subjectColumn:'PERSON',code:'covariate',valueColumn:'IMPUTED',unit:'score',occurredColumn:'AT',availableColumn:'AT'},
  ]},'owner');
  const read = await vcr.longitudinal.artifacts.read(target,version.id,'owner');
  assert.equal(read.content.events.find(event=>event.code==='HbA1c').valueSource,'observed');
  assert.equal(read.content.events.find(event=>event.code==='covariate').valueSource,'imputed');
  const mixed = await vcr.longitudinal.freezeHistory(target,{snapshotId:snapshot.id,asOf:'2026-02-01',mappings,priorHistoryId:version.id},'owner');
  assert.equal(mixed.summary.dataClass,'patient','a later synthetic source does not relabel earlier patient observations');
});

test('new model versions with identical numbers have distinct design jobs and invalidate both document kinds',options,async()=>{
  const raw=await vcr.longitudinal.artifacts.read(target,history.id,'owner');
  const subjects=[...new Set(raw.content.events.map(e=>e.subjectKey))];
  const header={historyId:history.id,origin:history.summary.origin,endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[30,60]};
  const rows=subjects.flatMap((subjectKey,i)=>[30,60].map(horizonDays=>({subjectKey,horizonDays,point:6+i/20,uncertainty:'predictive',samples:[5+i/20,7+i/20]})));
  const first=await vcr.longitudinal.importPrediction(target,{...header,model:{name:'versioned',version:'1'},rows},'owner');
  const control=await vcr.longitudinal.importPrediction(target,{...header,model:{name:'versioned',version:'1'},rows:rows.map(r=>({...r,point:r.point+.3}))},'owner');
  const input={predictionId:first.id,controlPredictionId:control.id,horizonDays:30};
  const job=await vcr.longitudinal.enqueueDesign(target,input,'owner');
  assert.equal((await vcr.longitudinal.enqueueDesign(target,input,'owner')).jobId,job.jobId);
  assert.notEqual((await vcr.longitudinal.enqueueDesign(target,{...input,horizonDays:60},'owner')).jobId,job.jobId);
  const digest=await vcr.orchestrator.inputDigest(target);
  const previousModel=await vcr.service.reportModel(target,{kind:'model_analysis_report'});
  const previousExports=[];
  vcr.orchestrator.queueExport=async()=>({state:'queued'});
  for(const kind of ['study_package','model_analysis_report']) {
    const previous=await vcr.store.createExport({studyId:target.id,userId:'owner',kind,cover:{inputDigest:digest,longitudinalDigest:previousModel.longitudinal.digest,results:previousModel,
      reports:[{section:'results',template:'Previous',rendered:'Previous'}]}});
    previousExports.push(previous);
    assert.equal((await vcr.orchestrator.requestExport({id:'owner'},target,kind)).export.id,previous.id,'unchanged inputs reuse the document');
  }
  const second=await vcr.longitudinal.importPrediction(target,{...header,model:{name:'versioned',version:'2'},rows},'owner');
  assert.notEqual(await vcr.orchestrator.inputDigest(target),digest);
  const later=await vcr.longitudinal.enqueueDesign(target,{...input,predictionId:second.id},'owner');
  assert.notEqual(later.jobId,job.jobId);
  const oldModel=await vcr.service.reportModel(target,{kind:'model_analysis_report'});
  const newest=oldModel.longitudinal.records.find(r=>r.id===second.id);
  assert.ok(newest);assert.equal(oldModel.modelAnalysis.current.data.longitudinal.find(r=>r.id===second.id).model.version,'2');
  const blocks=modelReportDocumentSections(oldModel,[]).flatMap(section=>section.blocks);
  assert.ok(blocks.some(block=>block.type==='table' && block.columns.includes('缺少预测')));
  assert.ok(JSON.stringify(blocks).includes('点估计'));
  assert.ok(!JSON.stringify(blocks).includes('{{n:'));
  for(const previous of previousExports) {
    const requested=await vcr.orchestrator.requestExport({id:'owner'},target,previous.kind);
    assert.notEqual(requested.export.id,previous.id);
  }
  await vcr.store.reportSnapshot(async snapshotStore=>{
    await snapshotStore.longitudinalIndex(target.id,{all:true});
    const concurrent=await vcr.longitudinal.importPrediction(target,{...header,model:{name:'versioned',version:'3'},rows},'owner');
    const frozen=await vcr.service.reportModelFromStore(target,snapshotStore,{kind:'model_analysis_report'});
    assert.ok(!frozen.longitudinal.records.some(r=>r.id===concurrent.id),'the report never mixes an outer-store import into a frozen read');
    assert.deepEqual(frozen.modelAnalysis.longitudinal.records,frozen.longitudinal.records);
  });
});

test('trial benchmark imports through DSH and only aligns the preserved arm, contrast and horizon',options,async()=>{
  const quote='Treatment versus control at 84 days: mean difference -0.4 %.';
  const precedent=await vcr.evidenceStore.savePrecedent({userId:'owner',studyId:target.id,
    precedent:{registry:'clinicaltrials.gov',registryId:'NCT00000001',title:'Authored benchmark fixture'},recordText:quote});
  const extraction=await vcr.evidence.addEvidenceItem({userId:'owner',studyId:target.id,item:{registry:'clinicaltrials.gov',registryId:'NCT00000001',
    parameter:'mean_difference',arm:'Treatment versus control',armRole:'contrast',value:-.4,unit:'%',endpointKey:'HbA1c',quote,
    timepoint:{value:84,unit:'days',quote}}});
  const row={evidenceId:extraction.id,trialId:precedent.id,familyId:'fixture-family',split:'test',endpoint:'HbA1c',scale:'mean_difference',unit:'%',
    arm:'Treatment versus control',armRole:'contrast',horizonDays:84,predicted:-.3};
  const written=await vcrRuntimeWrite({study:target,store:vcr.store,service:vcr.service,what:'trial_benchmark',orchestrator:null,
    data:{model:{name:'external',version:'1'},comparisons:[row,{...row,arm:'Control'},{...row,horizonDays:30},{...row,armRole:undefined}]}});
  assert.equal(written.ids.length,1,JSON.stringify(written));
  const benchmark=await vcr.longitudinal.artifacts.read(target,written.ids[0],'owner');
  assert.deepEqual(benchmark.content.comparisons.map(r=>r.issue),[null,'target_identity_mismatch','target_identity_mismatch','target_identity_unknown']);
  const queued=await vcr.longitudinal.prepare(target,{kind:'benchmark_trial_effect',scenario:{benchmarkId:written.ids[0],bootstrap:0}},'owner');
  // Claim only this job after canceling pending designs from earlier cases.
  for(const job of await vcr.jobs.listForStudy(target.id))if(job.id!==queued.job.id && ['queued','running'].includes(job.state))await vcr.jobs.cancel(target.id,job.id,{actor:'owner'});
  for(const job of await vcr.jobs.claim())await vcr.jobs.advance(job);
  const result=await vcr.jobs.resultOf(target.id,queued.job.id);
  assert.equal(result.diagnostics.longitudinal.summary.comparisons,1);
  assert.equal(result.diagnostics.longitudinal.summary.excluded,3);
});

test('over one hundred versions remain pageable with their input history; batch checkpoints stay addressable',options,async()=>{
  for(let i=0;i<105;i++)await vcr.longitudinal.artifacts.save(target,'prediction',{fixture:i},{historyId:history.id,model:{name:'many',version:String(i)},dataClass:'synthetic'},{parentId:history.id});
  const page=await vcr.service.runtimeRead(target,'longitudinal',{limit:20});
  assert.equal(page.records.length,20);assert.equal(page.more,true);assert.equal(page.nextOffset,20);
  assert.ok(page.related.some(r=>r.id===history.id));
  const next=await vcr.service.runtimeRead(target,'longitudinal',{offset:20,limit:20});
  assert.ok(next.records.every(r=>!page.records.some(first=>first.id===r.id)));
  const stable=await vcr.service.runtimeRead(target,'longitudinal',{id:history.id});
  assert.equal(stable.records[0].id,history.id);
  const checkpoints=[];
  for(let i=0;i<3;i++)checkpoints.push(await vcr.longitudinal.artifacts.save(target,'prediction',{batch:i},{jobId:'fixture-job',historyId:history.id,dataClass:'synthetic'},{parentId:history.id}));
  const visible=await vcr.longitudinal.view(target,{kind:'prediction'});
  assert.equal(visible.records.filter(r=>r.summary.jobId==='fixture-job').length,1);
  assert.equal((await vcr.longitudinal.view(target,{id:checkpoints[0].id})).records[0].id,checkpoints[0].id);
  const report=await vcr.service.reportModel(target,{kind:'model_analysis_report'});
  assert.ok(report.longitudinal.records.length>100);
  assert.deepEqual(report.modelAnalysis.longitudinal.records,report.longitudinal.records);
});
