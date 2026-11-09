// Review F01/F02 (plan R01/R02): a comparison against what was observed takes its provenance class and its authorization lineage from
// EVERY participating record, the outcome history included. Synthetic forecasts + a real outcome seen for one person at minCell 5.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';
import { presentLongitudinal } from '../src/vcrLongitudinalPresentation.mjs';

const options = {skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required'};
let database,isolated,root,vcr,study;
const SECRET_VALUE = '9.12345';

/** @param {string} name @param {'synthetic'|'observed'} valueSource @param {string[]} rows CSV lines after the header */
async function seedSource(name,valueSource,rows) {
  const source = await vcr.dataPlane.registerSource({userId:'owner',studyId:study.id,name,allowedUses:['vcr'],valueSource});
  await vcr.dataPlane.storeUpload({actor:'owner',studyId:study.id,sourceId:source.id,name:'events.csv',
    stream:streamOf(['PATIENT,AT,AVAILABLE,HBA1C',...rows].join('\n'))});
  const mapped = await vcr.dataPlane.proposeFieldMap({actor:'owner',studyId:study.id,sourceId:source.id,columns:[
    {table:'events.csv',column:'PATIENT',role:'subject_key',identifier:true},
    {table:'events.csv',column:'AT',role:'visit_date',timeKind:'occurred_at',type:'date'},
    {table:'events.csv',column:'AVAILABLE',role:'other',timeKind:'visible_at',type:'date'},
    {table:'events.csv',column:'HBA1C',role:'measurement',parameter:'HBA1C',unit:'%',type:'number'}]});
  await vcr.dataPlane.confirmFieldMap({actor:'owner',studyId:study.id,sourceId:source.id,hash:mapped.hash});
  const {snapshot} = await vcr.dataPlane.freezeSnapshot({userId:'owner',studyId:study.id,sourceId:source.id});
  return {source,snapshot,mappings:[{inputId:`${snapshot.id}:1`,subjectColumn:'USUBJID',code:'HbA1c',valueColumn:'HBA1C',unit:'%',
    occurredColumn:'AT',availableColumn:'AVAILABLE',basis:'dictionary_stated'}]};
}
/** @param {number} n */
const people = n => Array.from({length:n},(_,i) => `P-${i}`);
/** @param {string} historyId @param {string} origin @param {number[]} horizons */
const forecast = (historyId,origin,horizons) => ({schema:1,historyId,origin,subjectKeyMode:'source_identifier',
  endpoint:{code:'HbA1c',type:'continuous',unit:'%'},horizonsDays:horizons,model:{name:'synthetic-model',version:'1'},
  rows:people(12).flatMap(subjectKey => horizons.map(horizonDays => ({subjectKey,horizonDays,point:7})))});

/** Synthetic forecasts, one real outcome for ONE person. @returns {Promise<{comparison:any,outcomeSource:any,stored:any}>} */
async function runMixedComparison() {
  const synthetic = await seedSource('Synthetic forecasts source','synthetic',people(12).flatMap(p => [`${p},2025-12-01,2025-12-01,7`,`${p},2026-01-01,2026-01-01,7`]));
  const real = await seedSource('Real outcome source','observed',[`P-0,2026-01-31,2026-01-31,${SECRET_VALUE}`]);
  const h1 = await vcr.longitudinal.freezeHistory(study,{snapshotId:synthetic.snapshot.id,asOf:'2026-01-01',mappings:synthetic.mappings},'owner');
  const h2 = await vcr.longitudinal.freezeHistory(study,{snapshotId:synthetic.snapshot.id,asOf:'2026-01-11',mappings:synthetic.mappings},'owner');
  const outcomes = await vcr.longitudinal.freezeHistory(study,{snapshotId:real.snapshot.id,asOf:'2026-02-01',mappings:real.mappings},'owner');
  assert.equal(h1.summary.dataClass,'synthetic');
  assert.equal(outcomes.summary.dataClass,'patient');
  const older = await vcr.longitudinal.importPrediction(study,forecast(h1.id,h1.summary.origin,[30]),'owner');
  const newer = await vcr.longitudinal.importPrediction(study,forecast(h2.id,h2.summary.origin,[20]),'owner');
  assert.equal(older.summary.dataClass,'synthetic');
  const queued = await vcr.longitudinal.prepare(study,{kind:'compare_forecasts',
    scenario:{predictionId:older.id,otherPredictionId:newer.id,outcomeHistoryId:outcomes.id,mode:'update',bootstrap:0}},'owner');
  for (const job of await vcr.jobs.claim()) await vcr.jobs.advance(job);
  const finished = await vcr.jobs.get(study.id,queued.job.id);
  assert.equal(finished.state,'succeeded',JSON.stringify(finished));
  const stored = await vcr.jobs.resultOf(study.id,queued.job.id);
  return {comparison:stored.diagnostics.longitudinal,outcomeSource:real.source,stored};
}

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'vcrprov');
  database = new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  root = await fs.mkdtemp(path.join(os.tmpdir(),'vcr-provenance-'));
  await fs.writeFile(path.join(root,'providers.json'),JSON.stringify({providers:[]}));
  vcr = composeVcr({config:{vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:root,vcrForecastProvidersFile:path.join(root,'providers.json')},productDatabase:database});
  await vcr.store.ready();
  study = await vcr.store.createStudy({userId:'owner',projectId:'provenance',name:'Mixed provenance',question:'HbA1c',dataTier:'T0'});
});
after(async () => {await database?.close();await isolated?.drop();if(root)await fs.rm(root,{recursive:true,force:true});});

test('F01 synthetic forecasts + one real outcome: the comparison is not synthetic and the value is never visible (computation, page, model read)',options,async () => {
  const {comparison} = await runMixedComparison();
  assert.equal(comparison.summary.dataClass,'patient','the outer class is the strictest of both forecasts and the outcome');
  assert.equal(comparison.summary.observed.dataClass,'patient');
  const group = comparison.summary.observed.groups[0];
  assert.equal(group.pairedPredictions,12);
  assert.equal(group.observed,null,'a cell of one real person is withheld at minCell 5');
  assert.equal(group.observedMean,null);
  const page = presentLongitudinal(await vcr.longitudinal.view(study,{all:true}),{page:true,minCell:5});
  const model = await vcr.service.runtimeRead(study,'longitudinal');
  const report = await vcr.service.runtimeRead(study,'report_model').catch(() => ({}));
  for (const shown of [comparison.summary,page,model,report]) {
    const text = JSON.stringify(shown);
    assert.ok(!text.includes(SECRET_VALUE),'the real observed value never appears');
    assert.ok(!text.includes('2.12345'),'nor an error computed from it');
  }
  assert.equal(JSON.stringify(model).includes('"observed":1'),false);
});

test('F02 the comparison keeps the outcome source in its lineage: withdrawing that source denies a read of the comparison',options,async () => {
  const {comparison,outcomeSource} = await runMixedComparison();
  const row = await vcr.longitudinal.artifacts.record(study.id,comparison.id);
  assert.ok(row.source_ids.includes(outcomeSource.id),'the outcome source is in the saved lineage');
  assert.ok(row.snapshot_ids.length >= 2 && row.bindings.length >= 2);
  await vcr.longitudinal.artifacts.read(study,comparison.id,'owner');
  await vcr.store.query("UPDATE evimed_vcr.sources SET status='withdrawn' WHERE id=$1",[outcomeSource.id]);
  await assert.rejects(() => vcr.longitudinal.artifacts.read(study,comparison.id,'owner'),error => /withdrawn/.test(String(error.code)) && error.status === 403);
});
