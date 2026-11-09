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
import { readingAs } from '../src/vcrLongitudinalStore.mjs';
import { readModelAnalysisInputs } from '../src/vcrModelDocuments.mjs';

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

test('R02 follow-up: after the outcome source is withdrawn no read path serves a summary whose lineage includes it (list, view, run read, report model, export inputs)',options,async () => {
  const {comparison,outcomeSource} = await runMixedComparison();
  const lineage = await vcr.longitudinal.artifacts.record(study.id,comparison.id);
  const idsOf = (/** @type {any} */ shown) => JSON.stringify([...(shown?.records ?? []),...(shown?.related ?? [])].map((/** @type {any} */ r) => r.id)).concat(JSON.stringify(Object.keys(shown?.byId ?? {})));
  const everyPath = async () => ({
    view: await vcr.longitudinal.view(study,{all:true}),
    page: await vcr.longitudinal.view(study,{},undefined,'owner'),
    store: await vcr.store.longitudinalIndex(study.id,{all:true}),
    run: await vcr.service.runtimeRead(study,'longitudinal'),
    report: (await vcr.service.reportModel(study)).longitudinal,
    exportInputs: (await (await import('../src/vcrModelDocuments.mjs')).readModelAnalysisInputs(vcr.store,study)).longitudinal,
  });
  for (const [path,shown] of Object.entries(await everyPath())) assert.ok(idsOf(shown).includes(comparison.id),`${path} serves it while the grant stands`);
  await vcr.store.query("UPDATE evimed_vcr.sources SET status='withdrawn' WHERE id=$1",[outcomeSource.id]);
  assert.ok(lineage.source_ids.includes(outcomeSource.id));
  for (const [path,shown] of Object.entries(await everyPath())) {
    assert.ok(!idsOf(shown).includes(comparison.id),`${path} no longer lists the comparison`);
    assert.ok(!JSON.stringify(shown).includes(comparison.id),`${path} no longer carries any summary of it`);
  }
});

// Review eng round 2, P1-2: a comparison the live release wrote before the rule (synthetic class, unsuppressed observed block, lineage
// without the outcome history) is read as patient-class with the block withheld, and the startup repair settles it, idempotently.
/** Make a freshly computed comparison look like the live release's: no marker, the exemption, the real outcome unsuppressed, no outcome lineage. */
async function ageIntoLegacy(/** @type {any} */ comparison) {
  const { runForecastCalculation } = await import('../src/vcrForecastCalculation.mjs');
  const row = await vcr.longitudinal.artifacts.record(study.id,comparison.id);
  const read = (/** @type {string} */ id) => vcr.longitudinal.artifacts.read(study,id,'owner');
  const [first,second] = await Promise.all(row.summary.predictionIds.map(read));
  const job = await vcr.store.one(`SELECT j.scenario FROM evimed_vcr.results r JOIN evimed_vcr.executions e ON e.id=r.execution_id JOIN evimed_vcr.jobs j ON j.id=e.job_id
    WHERE r.diagnostics->'longitudinal'->>'id'=$1`,[comparison.id]);
  const outcomes = await read(job.scenario.outcomeHistoryId);
  // what the live release stored: the same block with the exemption applied, so nothing in it was suppressed
  const computed = await runForecastCalculation('forecast.compare_observed',[first.content,second.content,outcomes.content,{seed:1}],{timeoutMs:60000});
  const raw = {...computed,dataClass:'synthetic',groups:computed.groups.map((/** @type {any} */ g) => ({...g,observed:1,observedMean:Number(SECRET_VALUE),olderMean:7,newerMean:7,olderError:2.12345,newerError:2.12345,suppressed:[]}))};
  const { outcomeHistoryId: _marker, ...kept } = row.summary;
  const legacy = {...kept,observed:raw,dataClass:'synthetic'};
  const own = first.row;
  await vcr.store.query(`UPDATE evimed_vcr.longitudinal_artifacts SET summary=$2::jsonb, snapshot_ids=$3::jsonb, source_ids=$4::jsonb, bindings=$5::jsonb WHERE id=$1`,
    [comparison.id,JSON.stringify(legacy),JSON.stringify(own.snapshot_ids),JSON.stringify(own.source_ids),JSON.stringify(own.bindings ?? [])]);
  await vcr.store.query(`UPDATE evimed_vcr.results SET diagnostics=jsonb_set(diagnostics,'{longitudinal,summary}',$2::jsonb) WHERE diagnostics->'longitudinal'->>'id'=$1`,[comparison.id,JSON.stringify(legacy)]);
  return {raw,outcomes};
}

test('P1-2 a legacy comparison is read as patient-class with its observed block withheld, before any repair',options,async () => {
  const {comparison} = await runMixedComparison();
  const {raw} = await ageIntoLegacy(comparison);
  assert.equal(raw.groups[0].observedMean !== null,true,'the aged row really holds an unsuppressed real value (the premise of the finding)');
  const secret = String(raw.groups[0].observedMean);
  const page = presentLongitudinal(await vcr.longitudinal.view(study,{all:true}),{page:true,minCell:5});
  const model = await vcr.service.runtimeRead(study,'longitudinal');
  for (const shown of [page,model]) {
    const text = JSON.stringify(shown);
    assert.ok(!text.includes(secret),'the real observed value is not served from a legacy row');
    const mine = [...(shown.records ?? []),...(shown.related ?? [])].find((/** @type {any} */ r) => r.id === comparison.id);
    if (mine) { assert.equal(mine.summary.dataClass,'patient'); assert.equal(mine.summary.observed,null); }
  }
});

test('P1-2 the repair adds the outcome history to the lineage, recomputes the observed block with suppression, and is idempotent',options,async () => {
  const {comparison,outcomeSource} = await runMixedComparison();
  await ageIntoLegacy(comparison);
  assert.equal((await vcr.longitudinal.artifacts.record(study.id,comparison.id)).source_ids.includes(outcomeSource.id),false);
  const first = await vcr.longitudinal.repairComparisons();
  assert.ok(first.repaired >= 1 && first.recomputed >= 1,JSON.stringify(first));
  const row = await vcr.longitudinal.artifacts.record(study.id,comparison.id);
  assert.ok(row.source_ids.includes(outcomeSource.id),'F02: the outcome source is in the lineage');
  assert.equal(row.summary.dataClass,'patient','F01: the strictest class');
  assert.equal(row.summary.observed.groups[0].observed,null,'F01: the real cell of one person is withheld again');
  assert.equal(row.summary.observed.groups[0].observedMean,null);
  const stored = await vcr.jobs.resultOf(study.id,(await vcr.store.one(`SELECT j.id FROM evimed_vcr.results r JOIN evimed_vcr.executions e ON e.id=r.execution_id JOIN evimed_vcr.jobs j ON j.id=e.job_id WHERE r.diagnostics->'longitudinal'->>'id'=$1`,[comparison.id])).id);
  assert.equal(stored.diagnostics.longitudinal.summary.dataClass,'patient','the job\'s stored result carries the repaired summary');
  // withdrawing the outcome grant now denies it
  await vcr.store.query("UPDATE evimed_vcr.sources SET status='withdrawn' WHERE id=$1",[outcomeSource.id]);
  await assert.rejects(() => vcr.longitudinal.artifacts.read(study,comparison.id,'owner'),error => error.status === 403);
  // a second run finds nothing to do, and the rows a new write produced are left as they are
  const before = JSON.stringify((await vcr.store.rows("SELECT id,summary,snapshot_ids,source_ids,bindings FROM evimed_vcr.longitudinal_artifacts WHERE kind='comparison' ORDER BY id")));
  const second = await vcr.longitudinal.repairComparisons();
  assert.equal(second.repaired,0,JSON.stringify(second));
  assert.equal(JSON.stringify((await vcr.store.rows("SELECT id,summary,snapshot_ids,source_ids,bindings FROM evimed_vcr.longitudinal_artifacts WHERE kind='comparison' ORDER BY id"))),before);
});

// Review eng round 2, P2-2: lineage is judged as the requesting person on every person-facing read, as the owner only for platform-internal
// reads. A clinical reviewer holds `export` but not `read_patient_level`: what the page withholds from her, her report and export do too.
test('P2-2 report model, export inputs, run read and index judge the lineage as the requesting person',options,async () => {
  const {comparison} = await runMixedComparison();
  await vcr.store.query(`INSERT INTO evimed_vcr.members (study_id,user_id,role,invited_by) VALUES ($1,'reviewer','clinical_reviewer','owner') ON CONFLICT DO NOTHING`,[study.id]);
  const ids = (/** @type {any} */ shown) => JSON.stringify(shown ?? null).includes(comparison.id);
  const everyPath = async () => ({
    report: (await vcr.service.reportModel(study)).longitudinal,
    exportInputs: (await readModelAnalysisInputs(vcr.store,study)).longitudinal,
    index: await vcr.store.longitudinalIndex(study.id,{all:true}),
  });
  for (const [name,shown] of Object.entries(await everyPath())) assert.ok(ids(shown),`${name}: the owner (and any platform-internal read) is served it`);
  for (const [name,shown] of Object.entries(await readingAs('reviewer',everyPath))) assert.ok(!ids(shown),`${name}: the reviewer without patient-level access is not served it`);
  for (const [name,shown] of Object.entries(await readingAs('owner',everyPath))) assert.ok(ids(shown),`${name}: the owner as requester is served it`);
});
