import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {composeVcr} from '../src/vcrComposition.mjs';
import {VcrJobs} from '../src/vcrJobs.mjs';
import {createVcrLanguageAdmission} from '../src/vcrLanguageAdmission.mjs';
import {createVcrLanguageUnitExecutor,createVcrLanguageBatchExecutor} from '../src/vcrLanguageExecutor.mjs';
import {createVcrLanguageSourceLoader,createVcrLanguageSourceVerifier} from '../src/vcrLanguageVerifier.mjs';
import {freezeVcrLanguageUnit} from '../src/vcrLanguageUnit.mjs';
import {languageCriteriaByKey,languageCriterionHash} from '../src/vcrMatchingSnapshot.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
import {streamOf} from './helpers/vcrIntakeData.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'';

test('isolated real job queue runs one candidate language unit with fake provider and exact source fencing', {skip:!url&&'isolated test database not configured',timeout:30000},async()=>{
  const isolated=await createGeoTestDatabase(url,'vcrlanguagequeue');
  const db=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:6,databaseConnectionTimeoutMs:2000});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-language-queue-'));
  try {
    const config={vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:dir,deepseekBaseUrl:'https://api.deepseek.com',deepseekApiKey:'fixture',deepseekModel:'deepseek-flash',vcrProviderAgreements:true,vcrJobCpuSeconds:60,vcrStudyCpuBudget:1200};
    const vcr=composeVcr({config,productDatabase:db});await vcr.store.ready();
    const study=await vcr.store.createStudy({userId:'owner',projectId:'p1',name:'synthetic',question:'q',dataTier:'T0'});
    const source=await vcr.dataPlane.registerSource({userId:'owner',studyId:study.id,name:'notes'});
    const text='Synthetic age 62.';
    const file=(await vcr.dataPlane.storeUpload({actor:'owner',studyId:study.id,sourceId:source.id,name:'note.txt',role:'document',subject:'synthetic-subject',stream:streamOf(text)})).file;
    const candidate=await vcr.candidateStore.saveCandidateTrial({studyId:study.id,userId:'owner',max:10,trial:{registry:'clinicaltrials.gov',registryId:'NCT00000001',recordHash:'c'.repeat(64),eligibilityText:'Eligibility',locations:{}},criteria:[{kind:'inclusion',criterionType:'other',sourceText:'Eligibility',requirement:{op:'language',key:'eligible',text:'Eligibility'},applicability:null,sourceLocator:{},evidenceNeeded:[]}]});
    const unit={studyId:study.id,userId:'owner',subjectKey:file.detail.subjectKey,candidateTrialId:candidate.trial.id,criterionKey:'eligible',axis:'requirement',recordHash:'c'.repeat(64),criterionHash:languageCriterionHash(languageCriteriaByKey(candidate.criteria).get('eligible'),'eligible'),expectedJudgmentId:null,evaluatorVersion:'v1',promptVersion:'p1',model:'deepseek-flash',thinking:'disabled',outputLimit:1000,documents:[{id:file.id,sourceId:source.id,sourceHash:createHash('sha256').update(text).digest('hex'),projectionHash:null,projectionId:null}]};
    const events=[];const ledger={reserveModel:async()=>{events.push('reserve');return{id:'r1'};},settleModel:async()=>events.push('settle')};
    const transport=()=>({handoff:Promise.resolve(),response:Promise.resolve({status:200,body:Buffer.from(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"state":"unknown","evidence":[]}'}}],usage:{prompt_tokens:10,completion_tokens:2}}))})});
    const unitExecutor=createVcrLanguageUnitExecutor({candidateStore:vcr.candidateStore,loadSources:createVcrLanguageSourceLoader({dataPlane:vcr.dataPlane,matchStore:vcr.matchStore}),verifySources:createVcrLanguageSourceVerifier({dataPlane:vcr.dataPlane,matchStore:vcr.matchStore}),config,usageLedger:ledger,transport});
    const jobs=new VcrJobs({store:vcr.store,config,localExecutors:{'matching.language':createVcrLanguageBatchExecutor({unitExecutor,store:vcr.store})}});
    // Permission changes after facts were read must invalidate the frozen basis
    // before any late assessment can be written.
    const originalFacts=vcr.matchStore.listFacts.bind(vcr.matchStore);
    let factsEntered,factsRelease;const factsReady=new Promise(resolve=>{factsEntered=resolve;}),factsGate=new Promise(resolve=>{factsRelease=resolve;});
    let blockFacts=true;
    vcr.matchStore.listFacts=async args=>{const value=await originalFacts(args);if(blockFacts){blockFacts=false;factsEntered();await factsGate;}return value;};
    const sourceRace=vcr.patientTrials.evaluate(study,{subjectKeys:[file.detail.subjectKey],trialIds:[candidate.trial.id]});
    await factsReady;
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'revoked'}});
    factsRelease();const staleSource=await sourceRace;
    assert.equal(staleSource.evaluated.length,0);assert.equal(staleSource.unavailable[0].code,'vcr_matching_input_changed');
    vcr.matchStore.listFacts=originalFacts;
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'default'}});
    // A human answer landing after evaluation read must fence the late assessment.
    const originalLatest=vcr.candidateStore.latestLanguageJudgments.bind(vcr.candidateStore);
    let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    let blockOnce=true;
    vcr.candidateStore.latestLanguageJudgments=async args=>{const value=await originalLatest(args);if(blockOnce){blockOnce=false;entered();await gate;}return value;};
    const pendingEvaluation=vcr.patientTrials.evaluate(study,{subjectKeys:[file.detail.subjectKey],trialIds:[candidate.trial.id]});
    await ready;
    const human=await vcr.candidateStore.saveLanguageJudgment({studyId:study.id,userId:'owner',subjectKey:file.detail.subjectKey,candidateTrialId:candidate.trial.id,criterionKey:'eligible',state:'unknown',evidence:[]});
    release();const stale=await pendingEvaluation;
    assert.equal(stale.evaluated.length,0);assert.equal(stale.unavailable[0].code,'vcr_matching_input_changed');
    vcr.candidateStore.latestLanguageJudgments=originalLatest;
    await db.query('DELETE FROM evimed_vcr.language_judgments WHERE id=$1',[human.id]);
    const previous=await vcr.patientTrials.evaluate(study,{subjectKeys:[file.detail.subjectKey],trialIds:[candidate.trial.id]});
    assert.equal(previous.evaluated.length,1);
    const previousId=previous.evaluated[0].assessmentId;
    const basisBefore=await vcr.candidateStore.studyBasisEpoch(study.id);
    await assert.rejects(db.transaction(client=>db.withTransactionClient(client,async()=>{
      await vcr.dataStore.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'revoked'}});
      throw new Error('force rollback');
    })),/force rollback/);
    assert.equal(await vcr.candidateStore.studyBasisEpoch(study.id),basisBefore);
    assert.equal((await vcr.candidateStore.getAssessment(previousId,study.id)).invalidatedAt,null,'permission, epoch and invalidation roll back together');

    const deps={candidateStore:vcr.candidateStore,matchStore:vcr.matchStore,dataPlane:vcr.dataPlane,jobs};
    await assert.rejects(createVcrLanguageAdmission({...deps,config}).start(study,[{subjectKey:file.detail.subjectKey,candidateTrialId:candidate.trial.id}]),error=>error.code==='vcr_language_unavailable');
    const pairs=[{subjectKey:file.detail.subjectKey,candidateTrialId:candidate.trial.id}];
    await assert.rejects(createVcrLanguageAdmission({...deps,config:{...config,vcrLanguageExperimentalEnabled:true,vcrLanguageRunLimitCny:1e-12}}).start(study,pairs),error=>error.code==='usage_budget_exceeded');
    const admission=createVcrLanguageAdmission({...deps,config:{...config,vcrLanguageExperimentalEnabled:true,vcrLanguageRunLimitCny:2}});
    const admitted=await admission.start(study,pairs);
    assert.equal(admitted.estimate.units,1);assert.deepEqual(admitted.unavailable,[]);
    const job=admitted.job;
    const repeated=await admission.start(study,pairs);assert.equal(repeated.job.id,job.id);assert.equal(repeated.alreadyRunning,true);
    const frozen=(await db.query('SELECT scenario FROM evimed_vcr.jobs WHERE id=$1',[job.id])).rows[0].scenario.units[0];
    const [claimed]=await jobs.claim({workerId:'worker1',lane:'slow'});assert.equal(claimed.id,job.id);
    const finished=await jobs.advance(claimed);assert.equal(finished.state,'succeeded');
    const judgments=await vcr.candidateStore.latestLanguageJudgments({studyId:study.id,candidateTrialId:candidate.trial.id,subjectKey:file.detail.subjectKey});
    assert.equal(judgments.eligible.state,'unknown');assert.deepEqual(events,['reserve','settle']);
    assert.ok((await vcr.candidateStore.getAssessment(previousId,study.id)).invalidatedAt,'historical assessment is retained with invalidation');
    assert.equal((await vcr.candidateStore.latestAssessments({studyId:study.id,subjectKey:file.detail.subjectKey})).has(candidate.trial.id),false,'stale assessment is not ranked as current');
    await db.query(`INSERT INTO evimed_vcr.jobs(id,study_id,user_id,kind,method,state,lease_owner,lease_until,attempts,scenario)
      VALUES ('resume1',$1,'owner','match_language','matching.language','running','worker2',clock_timestamp()+interval '5 minutes',1,jsonb_build_object('unitHashes',jsonb_build_array($2::text)))`,[study.id,freezeVcrLanguageUnit(frozen).unitHash]);
    const resumed=await unitExecutor({unit:frozen,jobId:'resume1',leaseOwner:'worker2',leaseAttempt:1,projectId:'p1',runLimit:2});
    assert.equal(resumed.alreadyCommitted,true);assert.deepEqual(events,['reserve','settle'],'a completed unit is not sent or charged twice');
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'revoked'}});
    await assert.rejects(unitExecutor({unit:frozen,jobId:'resume1',leaseOwner:'worker2',leaseAttempt:1,projectId:'p1',runLimit:2}),error=>error.code==='vcr_language_replan_required');

  } finally {await db.close();await isolated.drop();await fs.rm(dir,{recursive:true,force:true});}
});
