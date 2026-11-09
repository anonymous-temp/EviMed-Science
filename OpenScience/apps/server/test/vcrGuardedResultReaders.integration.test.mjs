// Plan G3 (same class as R02/R11): every reader of the results table that stands outside the store goes through the store's lineage check,
// so a result made from patient-derived forecasts whose source grant was withdrawn is not published, not summarised in the study's knowledge
// page and not folded into a later stage. (A reconstruction offered for use takes the same call; it needs a curve receipt to seed and is held
// by the shared method here.)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrPublications } from '../src/vcrPublications.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';

const options = {skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required'};
const LEAD = {id:'owner',name:'李研究'};
let database,isolated,root,vcr,study;

async function seedHistory(name,n) {
  const source = await vcr.dataPlane.registerSource({userId:'owner',studyId:study.id,name,allowedUses:['vcr'],valueSource:'observed'});
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
async function design(history,tag) {
  const rows = (point) => Array.from({length:12},(_,i) => ({subjectKey:`P-${i}`,horizonDays:30,point:point+i/10,sd:1,uncertainty:'predictive'}));
  const header = {schema:1,historyId:history.id,origin:history.summary.origin,subjectKeyMode:'source_identifier',endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:[30]};
  const first = await vcr.longitudinal.importPrediction(study,{...header,model:{name:'m',version:`a${tag}`},rows:rows(6)},'owner');
  const second = await vcr.longitudinal.importPrediction(study,{...header,model:{name:'m',version:`b${tag}`},rows:rows(7)},'owner');
  const made = await vcr.longitudinal.enqueueDesign(study,{predictionId:first.id,controlPredictionId:second.id,horizonDays:30},'owner');
  assert.equal(made.available,true,JSON.stringify(made));
  return made.jobId;
}
/** The execution and result row the engine would have written for the job. */
async function fakeResult(jobId,kind,subject = `${kind}:${jobId}`,diagnostics = {}) {
  await vcr.store.query(`INSERT INTO evimed_vcr.executions (id,job_id,study_id,user_id,method) VALUES ($1,$2,$3,'owner','design.analytic')`,[`exe_${jobId}`,jobId,study.id]);
  await vcr.store.query(`INSERT INTO evimed_vcr.results (id,study_id,execution_id,user_id,kind,subject_id,measures,counts,diagnostics) VALUES ($1,$2,$3,'owner',$4,$5,'[]','{}',$6::jsonb)`,
    [`res_${jobId}`,study.id,`exe_${jobId}`,kind,subject,JSON.stringify(diagnostics)]);
  return `res_${jobId}`;
}

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'vcrguard');
  database = new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  root = await fs.mkdtemp(path.join(os.tmpdir(),'vcr-guard-readers-'));
  await fs.writeFile(path.join(root,'providers.json'),JSON.stringify({providers:[]}));
  vcr = composeVcr({config:{vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:root,vcrForecastProvidersFile:path.join(root,'providers.json'),vcrPublicSimulationsEnabled:true},productDatabase:database});
  await vcr.store.ready();
  study = await vcr.store.createStudy({userId:'owner',projectId:'guard-readers',name:'Guarded readers',question:'HbA1c',dataTier:'T0'});
});
after(async () => {await database?.close();await isolated?.drop();if(root)await fs.rm(root,{recursive:true,force:true});});

test('a withdrawn source leaves a result out of the publication, the knowledge page and a later stage; the other results are untouched',options,async () => {
  const {source,history} = await seedHistory('Observed source',14);
  const jobId = await design(history,'g');
  const resultId = await fakeResult(jobId,'trial_scenario');
  const comparisonJob = await design(history,'h');
  const comparisonId = await fakeResult(comparisonJob,'definition_comparison','defcmp:def_1:1:2',{comparison:{cohortSizeA:20,cohortSizeB:21}});
  // an unrelated result with no lineage
  await vcr.store.query(`INSERT INTO evimed_vcr.results (id,study_id,user_id,kind,subject_id,measures,counts) VALUES ('res_plain',$1,'owner','population','pop_1','[]','{}')`,[study.id]);
  const exportRow = (id) => vcr.store.createExport({studyId:study.id,userId:'owner',kind:'simulation_report',cover:{results:{
    study:{id:study.id,name:study.name,question:'q',dataTier:'T0',intendedUse:'exploratory'},intendedUse:'exploratory',counts:{},measures:[],
    results:{trial_scenario:{id}},scenarioResults:{},assumptions:[],review:{records:[]},stale:[],seal:{required:false}},
    reports:[{section:'main',template:'一次模拟。'}],reviewed:false}});
  const publications = createVcrPublications({store:vcr.store,service:vcr.service,matchStore:vcr.matchStore});

  // before the withdrawal everything is served
  assert.ok((await vcr.knowledge.studyKnowledge(study)).comparisons.some(c => c.id === comparisonId));
  const ok = await publications.publish(LEAD,study,{exportId:(await exportRow(resultId)).id,title:'模拟一',summary:''});
  assert.equal(ok.existing,false);
  assert.equal((await vcr.store.resultsInLineage(study.id,[{id:resultId},{id:'res_plain'}])).length,2);

  await vcr.store.query("UPDATE evimed_vcr.sources SET status='withdrawn' WHERE id=$1",[source.id]);

  assert.ok(!(await vcr.knowledge.studyKnowledge(study)).comparisons.some(c => c.id === comparisonId),'the knowledge page does not summarise it');
  await assert.rejects(publications.publish(LEAD,study,{exportId:(await exportRow(resultId)).id,title:'模拟二',summary:''}),(error) => error.code === 'vcr_publication_source_withdrawn');
  assert.deepEqual((await vcr.store.resultsInLineage(study.id,[{id:resultId},{id:'res_plain'}])).map(r => r.id),['res_plain']);
  // a report that names only the unrelated result is still published
  const plain = await vcr.store.createExport({studyId:study.id,userId:'owner',kind:'simulation_report',cover:{results:{
    study:{id:study.id,name:study.name,question:'q',dataTier:'T0',intendedUse:'exploratory'},intendedUse:'exploratory',counts:{},measures:[],
    results:{population:{id:'res_plain'}},scenarioResults:{},assumptions:[],review:{records:[]},stale:[],seal:{required:false}},
    reports:[{section:'main',template:'另一次模拟。'}],reviewed:false}});
  assert.equal((await publications.publish(LEAD,study,{exportId:plain.id,title:'模拟三',summary:''})).existing,false);
});
