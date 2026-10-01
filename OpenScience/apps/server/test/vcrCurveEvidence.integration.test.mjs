import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { VcrStore } from '../src/vcrStore.mjs';
import { VcrEvidenceStore } from '../src/vcrEvidenceStore.mjs';
import { VcrDataStore } from '../src/vcrDataStore.mjs';
import { VcrAccess } from '../src/vcrAccess.mjs';
import { VcrJobs, vcrScenarioHash } from '../src/vcrJobs.mjs';
import { vcrComputedOutputHash } from '../src/vcrEngineClient.mjs';
import { createVcrCurveEvidence } from '../src/vcrCurveEvidence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options={skip:!url && 'A local PostgreSQL is required.'};
let isolated,database,store,study,root,curves,jobs,receipt;
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L1sAAAAASUVORK5CYII=','base64');
const points={curve:[{time:0,surv:1},{time:12,surv:0.5}],riskTable:[{time:0,atRisk:100},{time:12,atRisk:50}]};
const submitted=[];
const engine={configured:()=>true, async submit(job){submitted.push(job);return {jobId:job.jobId,accepted:true};},async status(){return {state:'succeeded',cpuSeconds:1};},
  async result(id){const job=submitted.find(item=>item.jobId===id);const result={jobId:id,protocolVersion:1,status:'succeeded',method:job.method,methodVersion:job.methodVersion,
    scenarioHash:vcrScenarioHash(job.scenario),seed:job.seed,replicates:job.replicates??null,conclusion:'estimable',counts:{realPatients:0,events:null,effectiveSampleSize:null,generatedRecords:0,reconstructedPseudoPatients:100},
    measures:[],diagnostics:{},tables:[],manifest:{engineVersion:'1.0.0',rVersion:'R test transport',packageLockHash:'b'.repeat(64),startedAt:'2026-09-28T00:00:00Z',finishedAt:'2026-09-28T00:00:01Z',cpuSeconds:1}};
    result.manifest.outputHash=vcrComputedOutputHash(result);return {result,signed:true};}};
before(async()=>{
  if(!url)return;isolated=await createGeoTestDatabase(url,'curveproof');database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:5,databaseConnectionTimeoutMs:5000});
  store=new VcrStore({database});await store.ready();study=await store.createStudy({userId:'alice',projectId:'curves',name:'Curve provenance'});
  root=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-curve-proof-'));await fs.writeFile(path.join(root,'source.png'),image);
  curves=createVcrCurveEvidence({store:new VcrEvidenceStore({database}),studyStore:store,access:new VcrAccess({store:new VcrDataStore({database})}),resolveProject:async()=>({workspaceDir:root})});
  jobs=new VcrJobs({store,engine,config:{vcrJobCpuSeconds:60,vcrStudyCpuBudget:1200,vcrMaxConcurrentJobs:1,vcrLeaseMs:900000}});jobs.curveVerifier=curves.curveVerifier;
  receipt=await curves.recordSelection({studyId:study.id,principal:'alice',imageArtifactId:'source.png',points});
});
after(async()=>{await database?.close();await isolated?.drop();if(root)await fs.rm(root,{recursive:true,force:true});});
const enqueue=(key,principal='alice',scenario={provenance:{receiptId:receipt.id}})=>jobs.enqueue({studyId:study.id,userId:'alice',principal,kind:'reconstruct_km',scenario,cpuSecondsLimit:60,idempotencyKey:key});
test('G7 origin strings cannot enqueue; image changes and revoked queued actors stop before engine submission',options,async()=>{
  await assert.rejects(enqueue('forged','alice',{...points,provenance:{kind:'digitizer',tool:'Model invented'}}),{code:'vcr_curve_provenance_unavailable'});
  const queued=await enqueue('changed');const [claim]=await jobs.claim({limit:1});assert.ok(claim);
  await fs.writeFile(path.join(root,'source.png'),Buffer.concat([image,Buffer.from('changed')]));
  await jobs.advance(claim);assert.equal((await jobs.get(study.id,queued.job.id)).state,'failed');assert.equal(submitted.length,0);
  await fs.writeFile(path.join(root,'source.png'),image);
  await database.query("INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES($1,'delegate','lead')",[study.id]);
  const delegated=await enqueue('delegate','delegate');const [next]=await jobs.claim({limit:1});
  await database.query("DELETE FROM evimed_vcr.members WHERE study_id=$1 AND user_id='delegate'",[study.id]);
  await jobs.advance(next);assert.equal((await jobs.get(study.id,delegated.job.id)).state,'failed');assert.equal(submitted.length,0);
});
test('a verified receipt reaches the engine transport with immutable points and scoped lineage',options,async()=>{
  const queued=await enqueue('valid');const [claim]=await jobs.claim({limit:1});await jobs.advance(claim);
  assert.equal(submitted.length,1);assert.deepEqual(submitted[0].scenario.curve,points.curve);
  assert.equal(submitted[0].scenario.provenance.kind,'human_click');assert.equal(submitted[0].scenario.provenance.receiptId,undefined);
  assert.ok(submitted[0].inputs.some(input=>input.id===`evidence:${receipt.id}@1`));
  await jobs.advance(claim);assert.equal((await jobs.get(study.id,queued.job.id)).state,'succeeded');
});
test('malformed caller inputs retain a named queue refusal before any engine call',options,async()=>{
  const before=submitted.length;
  for(const value of [null,5,'not-an-input']) {
    await assert.rejects(jobs.enqueue({studyId:study.id,userId:'alice',principal:'alice',kind:'reconstruct_km',
      scenario:{provenance:{receiptId:receipt.id}},inputs:[value]}),{code:'vcr_job_scenario_invalid'});
  }
  assert.equal(submitted.length,before);
});
