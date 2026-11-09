// Plan R11 (same class as F02): a design job made from patient-derived forecasts carries the predictions' lineage, the store judges it on
// every read of the job's result, and a design whose paired people are fewer than the small-cell threshold is refused for a patient class.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';

const options = {skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required'};
let database,isolated,root,vcr,study;

/** @param {string} name @param {'synthetic'|'observed'} valueSource @param {number} n */
async function seedHistory(name,valueSource,n) {
  const source = await vcr.dataPlane.registerSource({userId:'owner',studyId:study.id,name,allowedUses:['vcr'],valueSource});
  const rows = Array.from({length:n},(_,i) => [`P-${i},2025-12-01,2025-12-01,7`,`P-${i},2026-01-01,2026-01-01,7`]).flat();
  await vcr.dataPlane.storeUpload({actor:'owner',studyId:study.id,sourceId:source.id,name:'events.csv',
    stream:streamOf(['PATIENT,AT,AVAILABLE,HBA1C',...rows].join('\n'))});
  const mapped = await vcr.dataPlane.proposeFieldMap({actor:'owner',studyId:study.id,sourceId:source.id,columns:[
    {table:'events.csv',column:'PATIENT',role:'subject_key',identifier:true},
    {table:'events.csv',column:'AT',role:'visit_date',timeKind:'occurred_at',type:'date'},
    {table:'events.csv',column:'AVAILABLE',role:'other',timeKind:'visible_at',type:'date'},
    {table:'events.csv',column:'HBA1C',role:'measurement',parameter:'HBA1C',unit:'%',type:'number'}]});
  await vcr.dataPlane.confirmFieldMap({actor:'owner',studyId:study.id,sourceId:source.id,hash:mapped.hash});
  const {snapshot} = await vcr.dataPlane.freezeSnapshot({userId:'owner',studyId:study.id,sourceId:source.id});
  const history = await vcr.longitudinal.freezeHistory(study,{snapshotId:snapshot.id,asOf:'2026-01-01',mappings:[
    {inputId:`${snapshot.id}:1`,subjectColumn:'USUBJID',code:'HbA1c',valueColumn:'HBA1C',unit:'%',occurredColumn:'AT',availableColumn:'AVAILABLE',basis:'dictionary_stated'}]},'owner');
  return {source,history};
}
/** Two predictions of one history that differ by one unit, for the first `n` people. */
async function predictions(history,n,people) {
  const rows = (point,k) => Array.from({length:k},(_,i) => ({subjectKey:`P-${i}`,horizonDays:30,point:point+i/10,sd:1,uncertainty:'predictive'}));
  const header = {schema:1,historyId:history.id,origin:history.summary.origin,subjectKeyMode:'source_identifier',endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[30]};
  const first = await vcr.longitudinal.importPrediction(study,{...header,model:{name:'m',version:`a${n}${people}`},rows:rows(6,n)},'owner');
  const second = await vcr.longitudinal.importPrediction(study,{...header,model:{name:'m',version:`b${n}${people}`},rows:rows(7,n)},'owner');
  return {first,second};
}
/** What the engine would have written for a design job: an execution and a result row (the engine is not part of this test). */
async function fakeResult(jobId) {
  const id = `exe_${jobId}`;
  await vcr.store.query(`INSERT INTO evimed_vcr.executions (id,job_id,study_id,user_id,method) VALUES ($1,$2,$3,'owner','design.analytic')`,[id,jobId,study.id]);
  await vcr.store.query(`INSERT INTO evimed_vcr.results (id,study_id,execution_id,user_id,kind,subject_id) VALUES ($1,$2,$3,'owner','trial_scenario',$4)`,[`res_${jobId}`,study.id,id,jobId]);
  return `res_${jobId}`;
}

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'vcrdesl');
  database = new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  root = await fs.mkdtemp(path.join(os.tmpdir(),'vcr-design-lineage-'));
  await fs.writeFile(path.join(root,'providers.json'),JSON.stringify({providers:[]}));
  vcr = composeVcr({config:{vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:root,vcrForecastProvidersFile:path.join(root,'providers.json')},productDatabase:database});
  await vcr.store.ready();
  study = await vcr.store.createStudy({userId:'owner',projectId:'design-lineage',name:'Design lineage',question:'HbA1c',dataTier:'T0'});
});
after(async () => {await database?.close();await isolated?.drop();if(root)await fs.rm(root,{recursive:true,force:true});});

test('a design from patient-derived predictions carries their lineage, and the result is not served once a source grant is withdrawn',options,async () => {
  const {source,history} = await seedHistory('Observed source','observed',14);
  const {first,second} = await predictions(history,12,14);
  const design = await vcr.longitudinal.enqueueDesign(study,{predictionId:first.id,controlPredictionId:second.id,horizonDays:30},'owner');
  assert.equal(design.available,true,JSON.stringify(design));
  const job = await vcr.store.one('SELECT * FROM evimed_vcr.jobs WHERE id=$1',[design.jobId]);
  const lineage = job.checkpoint.forecastLineage;
  assert.ok(lineage.sourceIds.includes(source.id),'the predictions\' source is on the job');
  assert.ok(lineage.snapshotIds.length >= 1 && lineage.bindings.length >= 1);
  assert.equal(lineage.dataClass,'patient');
  const resultId = await fakeResult(design.jobId);
  assert.equal((await vcr.store.resultOfJob(study.id,design.jobId))?.id,resultId);
  assert.ok((await vcr.store.results(study.id)).some(r => r.id === resultId));
  assert.equal((await vcr.store.result(study.id,resultId))?.id,resultId);
  await vcr.store.query("UPDATE evimed_vcr.sources SET status='withdrawn' WHERE id=$1",[source.id]);
  assert.equal(await vcr.store.resultOfJob(study.id,design.jobId),null,'the job\'s result is refused');
  assert.equal(await vcr.store.result(study.id,resultId),null);
  assert.equal(await vcr.store.resultForExecution(study.id,`exe_${design.jobId}`),null);
  assert.ok(!(await vcr.store.results(study.id)).some(r => r.id === resultId));
  assert.ok(!(await vcr.store.allResults(study.id)).some(r => r.id === resultId));
  assert.equal(await vcr.store.currentResultOf(study.id,'trial_scenario',design.jobId),null);
  // a result with no forecast lineage is untouched
  await vcr.store.query(`INSERT INTO evimed_vcr.results (id,study_id,user_id,kind) VALUES ('res_plain',$1,'owner','trial_scenario')`,[study.id]);
  assert.equal((await vcr.store.result(study.id,'res_plain'))?.id,'res_plain');
});

test('a design of fewer paired people than the small-cell threshold is refused for a patient class and allowed for a synthetic one',options,async () => {
  const real = await seedHistory('Observed small','observed',14);
  const smallReal = await predictions(real.history,6,14);
  const refused = await vcr.longitudinal.enqueueDesign(study,{predictionId:smallReal.first.id,controlPredictionId:smallReal.second.id,horizonDays:30},'owner');
  assert.deepEqual(refused,{available:false,code:'forecast_design_below_small_cell'});
  assert.equal((await vcr.store.query("SELECT 1 FROM evimed_vcr.jobs WHERE study_id=$1 AND kind='design_analytic' AND idempotency_key LIKE $2",[study.id,`forecast-design:%`])).rows.length >= 1,true,'earlier designs stay');
  const synthetic = await seedHistory('Synthetic small','synthetic',14);
  const smallSynthetic = await predictions(synthetic.history,6,14);
  const allowed = await vcr.longitudinal.enqueueDesign(study,{predictionId:smallSynthetic.first.id,controlPredictionId:smallSynthetic.second.id,horizonDays:30},'owner');
  assert.equal(allowed.available,true,JSON.stringify(allowed));
});
