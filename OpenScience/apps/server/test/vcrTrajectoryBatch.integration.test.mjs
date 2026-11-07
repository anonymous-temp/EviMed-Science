import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';
import { VcrOrchestrator } from '../src/vcrOrchestrator.mjs';
import { studyPseudonymKey, pseudonymOf } from '../src/vcrDataPlane.mjs';

const options = {skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required'};
const permission = {status:'approved',dataClass:'synthetic',purpose:'vcr',destinations:['https://forecast.example.org'],reference:'authored fixture',retention:'none',training:'disabled',humanReview:'disabled'};
const endpoint = {code:'HbA1c',type:'continuous',unit:'%'};
const id = n => `P${String(n).padStart(3,'0')}`;
let database,isolated,root,vcr,study,source,snapshot,history,handler,indexOf;
const providerConfig = (extra = {}) => ({id:'partner',url:'https://forecast.example.org/predict',model:'synthetic',version:'1',enabled:true,
  protocol:'evimed-event-history-v1',batchSize:10,inputCodes:['HbA1c'],idempotencySupported:true,...extra});
const writeProviders = extra => fs.writeFile(path.join(root,'providers.json'),JSON.stringify({providers:[providerConfig(extra)]}));
const mapping = () => ({inputId:`${snapshot.id}:1`,subjectColumn:'PATIENT',codeColumn:'CODE',valueColumn:'VALUE',unitColumn:'UNIT',occurredColumn:'AT',availableColumn:'AVAILABLE',basis:'dictionary_stated'});

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'vcrtraj');
  database = new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  root = await fs.mkdtemp(path.join(os.tmpdir(),'vcr-trajectory-'));
  await fs.writeFile(path.join(root,'providers.json'),JSON.stringify({providers:[]}));
  vcr = composeVcr({config:{vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:root,vcrForecastProvidersFile:path.join(root,'providers.json')},productDatabase:database,
    fetchImpl:(url,init) => handler(url,init)});
  vcr.orchestrator = new VcrOrchestrator({store:vcr.store,jobs:vcr.jobs,config:{},dispatchRun:null});
  await vcr.store.ready();
  study = await vcr.store.createStudy({userId:'owner',projectId:'synthetic-trajectory',name:'Synthetic batch',question:'HbA1c batch forecast',dataTier:'T0'});
  source = await vcr.dataPlane.registerSource({userId:'owner',studyId:study.id,name:'Authored synthetic batch',allowedUses:['vcr'],valueSource:'synthetic'});
  // 100 people: P000-P059 valid; P060-P064 valid (the provider will return an unusable row); P065-P079 only a weight; P080-P089 only a
  // unit that cannot become percent; P090-P099 valid (their provider batch fails).
  const rows = ['PATIENT,AT,AVAILABLE,CODE,VALUE,UNIT'];
  for (let i = 0; i < 100; i++) {
    if (i >= 65 && i < 80) rows.push(`${id(i)},2025-12-01,2025-12-02,Weight,70,kg`);
    else if (i >= 80 && i < 90) rows.push(`${id(i)},2025-12-01,2025-12-02,HbA1c,53,mmol/mol`);
    else rows.push(`${id(i)},2025-12-01,2025-12-02,HbA1c,${6+i/50},%`);
  }
  // a lab after the origin and a medication recorded after it, for every person
  for (let i = 0; i < 100; i += 7) rows.push(`${id(i)},2026-01-20,2026-01-21,HbA1c,11.1,%`);
  await vcr.dataPlane.storeUpload({actor:'owner',studyId:study.id,sourceId:source.id,name:'events.csv',stream:streamOf(rows.join('\n'))});
  const mapped = await vcr.dataPlane.proposeFieldMap({actor:'owner',studyId:study.id,sourceId:source.id,columns:[
    {table:'events.csv',column:'PATIENT',role:'subject_key',identifier:true},
    {table:'events.csv',column:'AT',role:'visit_date',timeKind:'occurred_at',type:'date'},
    {table:'events.csv',column:'AVAILABLE',role:'other',timeKind:'visible_at',type:'date'},
    {table:'events.csv',column:'CODE',role:'other',type:'text'},
    {table:'events.csv',column:'VALUE',role:'other',type:'number'},
    {table:'events.csv',column:'UNIT',role:'other',type:'text'},
  ]});
  assert.deepEqual(mapped.entryIssues,[]);
  await vcr.dataPlane.confirmFieldMap({actor:'owner',studyId:study.id,sourceId:source.id,hash:mapped.hash});
  snapshot = (await vcr.dataPlane.freezeSnapshot({userId:'owner',studyId:study.id,sourceId:source.id})).snapshot;
  await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission});
  history = await vcr.longitudinal.freezeHistory(study,{snapshotId:snapshot.id,asOf:'2026-01-01',mappings:[mapping()]},'owner');
  // subject keys are study pseudonyms; the fixture knows each person by number
  const key = await studyPseudonymKey(root,study.id);
  indexOf = new Map(Array.from({length:100},(_,i) => [pseudonymOf(key,id(i)),i]));
});
after(async () => {await database?.close();await isolated?.drop();if(root)await fs.rm(root,{recursive:true,force:true});});

const respond = (body,rowOf) => new Response(JSON.stringify({schema:1,origin:body.origin,endpoint:body.endpoint,model:'synthetic',version:'1',
  rows:body.subjects.flatMap(key => rowOf(key) ?? [])}));
async function run(request) {
  const queued = await vcr.longitudinal.prepare(study,request,'owner');
  for (const claim of await vcr.jobs.claim()) if (claim.id === queued.job.id) await vcr.jobs.advance(claim);
  return {queued,job:await vcr.jobs.get(study.id,queued.job.id)};
}
const predictRequest = extra => ({kind:'forecast_trajectories',scenario:{historyId:history.id,providerId:'partner',endpoint,horizonsDays:[30],...extra}});

test('A05 through the job queue: 100 people, every one accounted for, results map back to the right person',options,async () => {
  assert.equal(history.summary.subjects,100);
  await writeProviders();
  const failedKeys = [];
  handler = async (_url,init) => {
    const body = JSON.parse(init.body);
    assert.ok(!body.events.some(e => e.occurredAt > '2026-01-01T00:00:00.000Z'),'no post-origin record is sent');
    if (body.subjects.some(k => indexOf.get(k) === 95)) {failedKeys.push(...body.subjects);return new Response('',{status:503});}
    return respond(body,key => {
      const n = indexOf.get(key);
      if (n >= 65 && n < 80) return null;
      return [{subjectKey:key,horizonDays:30,point:6+n/50+.1,sd:.4,uncertainty:'predictive',...(n >= 60 && n < 65 ? {unit:'mg'} : {})}];
    });
  };
  const {queued,job} = await run(predictRequest());
  assert.equal(job.state,'succeeded',JSON.stringify(job));
  const result = await vcr.jobs.resultOf(study.id,queued.job.id);
  const summary = result.diagnostics.longitudinal.summary;
  // the order people are batched in follows their pseudonyms, so the failed batch holds P095 and nine others: expect each person's line from the facts
  assert.equal(failedKeys.length,10);
  const failed = new Set(failedKeys.map(k => indexOf.get(k)));
  const expected = {completed:0,rejected:0,failed:0};
  for (let n = 0; n < 100; n++) expected[n >= 80 && n < 90 ? 'rejected' : failed.has(n) ? 'failed' : n >= 60 && n < 80 ? 'rejected' : 'completed']++;
  assert.deepEqual(summary.accounting,{submitted:100,admitted:90,...expected,unprocessed:0,partial:0});
  assert.equal(expected.failed,10);
  assert.equal(summary.actionContext.label,'factual_forecast');
  assert.ok(summary.premises.some(p => p.key === 'trajectory:interval'));
  assert.ok(!JSON.stringify(summary).includes('P0'),'a summary never holds a person key');
  const page = await vcr.longitudinal.subjectPage(study,result.diagnostics.longitudinal.id,'owner',{status:'failed'});
  assert.equal(page.matching,10);
  assert.deepEqual(new Set(page.lines.map(l => l.subjectKey)),new Set(failedKeys));
  assert.equal(page.lines.every(l => l.reason === 'provider_http_503'),true);
  const completed = await vcr.longitudinal.subjectPage(study,result.diagnostics.longitudinal.id,'owner',{status:'completed',limit:200});
  assert.equal(completed.lines.length,expected.completed);
  for (const line of completed.lines.slice(0,5)) {
    const n = indexOf.get(line.subjectKey);
    assert.ok(Math.abs(completed.trajectories[line.subjectKey][0].point-(6+n/50+.1))<1e-12,'stable subject key: the output is the input person\'s');
  }
  assert.equal((await vcr.longitudinal.subjectPage(study,result.diagnostics.longitudinal.id,'owner',{status:'rejected',reason:'unit_not_convertible'})).matching,10);
});

test('A12: a restarted job reuses finished provider batches and charges nothing twice',options,async () => {
  await writeProviders({version:'1'});
  const seen = [];
  handler = async (_url,init) => {const body = JSON.parse(init.body);seen.push(body.subjects[0]);return respond(body,key => [{subjectKey:key,horizonDays:30,point:7}]);};
  const request = predictRequest({samples:5});
  const first = await run(request);
  assert.equal(first.job.state,'succeeded');
  const before = seen.length;
  const again = await vcr.longitudinal.prepare(study,request,'owner');
  assert.equal(again.job.id,first.queued.job.id,'the same request is the same job');
  assert.equal(seen.length,before);
});

test('A13: a revoked source keeps what was computed; a changed model version is a new prediction and the old one stays readable',options,async () => {
  await writeProviders({version:'1',batchSize:20});
  let revoked = false;
  handler = async (_url,init) => {
    const body = JSON.parse(init.body);
    // the operator revokes the source once the first batch has come back
    if (!revoked) {revoked = true;await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'revoked'}});}
    return respond(body,key => [{subjectKey:key,horizonDays:30,point:7,sd:.2,uncertainty:'predictive'}]);
  };
  const {queued,job} = await run(predictRequest({samples:3}));
  await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission});
  assert.equal(job.state,'succeeded',JSON.stringify(job));
  const result = await vcr.jobs.resultOf(study.id,queued.job.id);
  const summary = result.diagnostics.longitudinal.summary;
  assert.ok(summary.accounting.completed > 0 && summary.accounting.unprocessed > 0,JSON.stringify(summary.accounting));
  assert.equal(summary.accounting.submitted,summary.accounting.completed+summary.accounting.rejected+summary.accounting.failed+summary.accounting.unprocessed);
  const first = result.diagnostics.longitudinal.id;

  // a new provider version pins a new job; the earlier prediction is untouched
  await writeProviders({version:'2'});
  handler = async (_url,init) => respond(JSON.parse(init.body),key => [{subjectKey:key,horizonDays:30,point:7.5,sd:.2,uncertainty:'predictive'}]);
  const next = await run(predictRequest({samples:3,priorPredictionId:first}));
  assert.equal(next.job.state,'succeeded',JSON.stringify(next.job));
  const nextResult = await vcr.jobs.resultOf(study.id,next.queued.job.id);
  assert.equal(nextResult.diagnostics.longitudinal.summary.versionNumber,2);
  assert.equal(nextResult.diagnostics.longitudinal.summary.priorPredictionId,first);
  const old = await vcr.longitudinal.artifacts.read(study,first,'owner');
  assert.equal(old.row.kind,'prediction');
  const listing = await vcr.longitudinal.view(study,{kind:'prediction',limit:50});
  assert.ok(listing.records.some(r => r.id === first) && listing.records.some(r => r.id === nextResult.diagnostics.longitudinal.id));
});

test('A06: a deployable forecast and a logged-action replay are different records, and a revoked read is refused for a foreign actor',options,async () => {
  await writeProviders({version:'2',actionCodes:['Metformin'],actionUnits:{Metformin:'mg'},requiresActions:false});
  handler = async (_url,init) => respond(JSON.parse(init.body),key => [{subjectKey:key,horizonDays:30,point:7}]);
  const {job,queued} = await run(predictRequest({predictionMode:'conditional_forecast',actions:[{code:'Metformin',at:{value:1,unit:'weeks'},dose:{value:1,unit:'g'}}]}));
  assert.equal(job.state,'succeeded',JSON.stringify(job));
  const summary = (await vcr.jobs.resultOf(study.id,queued.job.id)).diagnostics.longitudinal.summary;
  assert.equal(summary.actionContext.deployable,true);
  assert.ok(summary.premises.some(p => p.key === 'trajectory:conditional' && p.decisive));
  await assert.rejects(() => vcr.longitudinal.prepare(study,predictRequest({actions:[{code:'Metformin',at:{value:1,unit:'days'}}]}),'owner'),{code:'vcr_job_scenario_invalid'});
  await assert.rejects(() => vcr.longitudinal.subjectPage(study,summary.historyId,'owner'),{code:'vcr_forecast_unavailable'});
});

test('a logged replay reads its actions only from a frozen history whose source may go to the cloud; what it saves carries both lineages (review eng P0-4, stats P2-15)',options,async () => {
  await writeProviders({version:'2',actionCodes:['Metformin'],actionUnits:{Metformin:'mg'},requiresActions:false});
  // a second source: the medication recorded after the origin, with no cloud permission of its own
  const later = await vcr.dataPlane.registerSource({userId:'owner',studyId:study.id,name:'Authored follow-up medication',allowedUses:['vcr'],valueSource:'synthetic'});
  const rows = ['PATIENT,AT,AVAILABLE,CODE,VALUE,UNIT'];
  for (let i = 0; i < 100; i += 2) rows.push(`${id(i)},2026-01-15,2026-01-15,Metformin,500,mg`);
  await vcr.dataPlane.storeUpload({actor:'owner',studyId:study.id,sourceId:later.id,name:'medication.csv',stream:streamOf(rows.join('\n'))});
  const mapped = await vcr.dataPlane.proposeFieldMap({actor:'owner',studyId:study.id,sourceId:later.id,columns:[
    {table:'medication.csv',column:'PATIENT',role:'subject_key',identifier:true},
    {table:'medication.csv',column:'AT',role:'visit_date',timeKind:'occurred_at',type:'date'},
    {table:'medication.csv',column:'AVAILABLE',role:'other',timeKind:'visible_at',type:'date'},
    {table:'medication.csv',column:'CODE',role:'other',type:'text'},
    {table:'medication.csv',column:'VALUE',role:'other',type:'number'},
    {table:'medication.csv',column:'UNIT',role:'other',type:'text'},
  ]});
  await vcr.dataPlane.confirmFieldMap({actor:'owner',studyId:study.id,sourceId:later.id,hash:mapped.hash});
  const laterSnapshot = (await vcr.dataPlane.freezeSnapshot({userId:'owner',studyId:study.id,sourceId:later.id})).snapshot;
  const laterHistory = await vcr.longitudinal.freezeHistory(study,{snapshotId:laterSnapshot.id,asOf:'2026-03-01',
    mappings:[{...mapping(),inputId:`${laterSnapshot.id}:1`,kind:'medication'}]},'owner');
  let sent = 0;
  handler = async (_url,init) => {sent += 1;return respond(JSON.parse(init.body),key => [{subjectKey:key,horizonDays:30,point:7}]);};
  // an explicit mode with the actions taken from the later history is a replay, not a schedule left out (stats P2-15)
  const replay = predictRequest({predictionMode:'conditional_forecast',actionHistoryId:laterHistory.id});
  const refused = await run(replay);
  assert.equal(refused.job.state,'failed',JSON.stringify(refused.job));
  assert.equal(sent,0,'nothing of the later source left without its own cloud permission');
  // a record that is not a frozen history cannot name the actions
  const prediction = (await vcr.longitudinal.view(study,{kind:'prediction',limit:1})).records[0];
  await assert.rejects(() => vcr.longitudinal.prepare(study,predictRequest({actionHistoryId:prediction.id}),'owner'),{code:'vcr_history_required'});
  // with the permission, the replay runs and every record it saved names both sources
  await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:later.id,actor:'owner',permission});
  const ran = await run({...replay,seed:7});
  assert.equal(ran.job.state,'succeeded',JSON.stringify(ran.job));
  assert.ok(sent > 0);
  const saved = (await vcr.jobs.resultOf(study.id,ran.queued.job.id)).diagnostics.longitudinal;
  assert.equal(saved.summary.actionContext.label,'logged_action_replay');
  const held = await vcr.longitudinal.artifacts.read(study,saved.id,'owner');
  assert.deepEqual(new Set(held.row.source_ids),new Set([source.id,later.id]));
  const batches = await vcr.store.rows(`SELECT source_ids FROM evimed_vcr.longitudinal_artifacts WHERE study_id=$1 AND kind='provider_batch' AND summary->>'jobId'=$2`,[study.id,ran.queued.job.id]);
  assert.ok(batches.length && batches.every(row => row.source_ids.includes(later.id)));

  // the replay's accuracy is scored apart from a forecast's, and it is not a design input (review stats P1-6)
  const outcomes = await vcr.longitudinal.freezeHistory(study,{snapshotId:snapshot.id,asOf:'2026-03-01',mappings:[mapping()]},'owner');
  const scored = await run({kind:'evaluate_forecast',scenario:{predictionId:saved.id,outcomeHistoryId:outcomes.id}});
  assert.equal(scored.job.state,'succeeded',JSON.stringify(scored.job));
  const evaluation = (await vcr.jobs.resultOf(study.id,scored.queued.job.id)).diagnostics.longitudinal.summary;
  assert.equal(evaluation.accuracyKind,'logged_action_replay');
  assert.equal(evaluation.actionContext.deployable,false);
  const forecast = (await vcr.longitudinal.view(study,{kind:'prediction',limit:50})).records.find(r => r.summary?.actionContext?.deployable === true);
  assert.ok(forecast,'a deployable forecast of the earlier tests');
  const compared = await run({kind:'compare_forecasts',scenario:{predictionId:forecast.id,otherPredictionId:saved.id}});
  assert.equal(compared.job.state,'succeeded',JSON.stringify(compared.job));
  const comparison = (await vcr.jobs.resultOf(study.id,compared.queued.job.id)).diagnostics.longitudinal.summary;
  assert.deepEqual([comparison.accuracyKind,comparison.actionContexts.map(c => c.deployable)],['logged_action_replay',[true,false]]);
  assert.deepEqual(await vcr.longitudinal.enqueueDesign(study,{predictionId:saved.id,controlPredictionId:forecast.id,horizonDays:30},'owner'),
    {available:false,code:'logged_replay_not_deployable'});
});
