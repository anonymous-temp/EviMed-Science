import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrLanguageSourceLoader, createVcrLanguageSourceVerifier } from '../src/vcrLanguageVerifier.mjs';
import { startVcrLanguageTransport } from '../src/vcrLanguageTransport.mjs';
import { startMeteredVcrLanguageCall } from '../src/vcrLanguageModel.mjs';
import { freezeVcrLanguageUnit } from '../src/vcrLanguageUnit.mjs';
import { languageCriteriaByKey, languageCriterionHash } from '../src/vcrMatchingSnapshot.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';

const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
test('real data-plane verifier rejects revoked permission, added records and withdrawn subjects', {skip:!url && 'isolated test database not configured',timeout:30000}, async()=>{
  const isolated=await createGeoTestDatabase(url,'vcrverify');
  const db=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-language-verify-'));
  try {
    const vcr=composeVcr({config:{vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:dir,deepseekBaseUrl:'https://api.example.org',vcrProviderAgreements:true},productDatabase:db});
    await vcr.store.ready();
    const study=await vcr.store.createStudy({userId:'owner',projectId:'p1',name:'synthetic',question:'q',dataTier:'T0'});
    const source=await vcr.dataPlane.registerSource({userId:'owner',studyId:study.id,name:'notes'});
    const text='Synthetic age 62 🧬.';
    const upload=async(value)=>(await vcr.dataPlane.storeUpload({actor:'owner',studyId:study.id,sourceId:source.id,name:'note.txt',role:'document',subject:'synthetic-subject',stream:streamOf(value)})).file;
    const file=await upload(text), subjectKey=file.detail.subjectKey;
    const verify=createVcrLanguageSourceVerifier({dataPlane:vcr.dataPlane,matchStore:vcr.matchStore});
    const input={studyId:study.id,userId:'owner',subjectKey,documents:[{id:file.id,sourceId:source.id,sourceHash:createHash('sha256').update(text).digest('hex'),projectionHash:null,projectionId:null}],evidence:[]};
    assert.equal(await verify(input),true);
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'revoked'}});
    assert.equal(await verify(input),false);
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'default'}});
    assert.equal(await verify(input),true);
    const candidate=await vcr.candidateStore.saveCandidateTrial({studyId:study.id,userId:'owner',max:10,trial:{registry:'clinicaltrials.gov',registryId:'NCT00000001',recordHash:'c'.repeat(64),eligibilityText:'Eligibility',locations:{}},criteria:[{kind:'inclusion',criterionType:'other',sourceText:'Eligibility',requirement:{op:'language',key:'eligible',text:'Eligibility'},applicability:null,sourceLocator:{},evidenceNeeded:[]}]});
    const criterionHash=languageCriterionHash(languageCriteriaByKey(candidate.criteria).get('eligible'),'eligible');
    const unit={...input,candidateTrialId:candidate.trial.id,criterionKey:'eligible',axis:'requirement',recordHash:'c'.repeat(64),criterionHash,expectedJudgmentId:null,evaluatorVersion:'v1',promptVersion:'p1',model:'deepseek-flash',thinking:'disabled',outputLimit:1000};
    delete unit.evidence;
    await db.query(`INSERT INTO evimed_vcr.jobs(id,study_id,user_id,kind,method,state,lease_owner,lease_until,attempts,scenario)
      VALUES ('job1',$1,'owner','match_extract','matching.language','running','worker1',clock_timestamp()+interval '5 minutes',1,jsonb_build_object('unitHashes',jsonb_build_array($2::text)))`,[study.id,freezeVcrLanguageUnit(unit).unitHash]);
    const loadSources=createVcrLanguageSourceLoader({dataPlane:vcr.dataPlane,matchStore:vcr.matchStore});
    const callDispatch=onAuthorized=>vcr.candidateStore.dispatchLanguageUnit({unit,jobId:'job1',leaseOwner:'worker1',leaseAttempt:1,loadSources,onAuthorized});
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'revoked'}});
    let sent=false;
    await assert.rejects(callDispatch(async()=>{sent=true;}),error=>error.code==='vcr_language_replan_required');
    assert.equal(sent,false,'revoked permission is checked before any transport starts');
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'default'}});
    let started;const transportReady=new Promise(resolve=>{started=resolve;});const controller=new AbortController();
    const req=new EventEmitter();req.end=()=>{};req.destroy=error=>queueMicrotask(()=>req.emit('error',error));
    const metering=[];
    const ledger={reserveModel:async()=>{metering.push('reserve');return{id:'r1'};},markUncertain:async()=>metering.push('uncertain')};
    let modelResult;
    const dispatch=callDispatch(async context=>{
      const call=startMeteredVcrLanguageCall({config:{deepseekBaseUrl:'https://api.deepseek.com',deepseekApiKey:'fixture',production:true},usageLedger:ledger,
        transport:opts=>{const value=startVcrLanguageTransport({...opts,requestImpl:()=>req});started();return value;}},
        {...context,jobId:'job1',projectId:'p1',runLimit:2,signal:controller.signal});
      modelResult=call.result;await call.handoff;return {handed:true};
    });
    await transportReady;
    let revokedDuringDispatch=false;
    const revokeDuringDispatch=vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'revoked'}}).then(()=>{revokedDuringDispatch=true;});
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(revokedDuringDispatch,false,'revocation cannot complete before local body handoff');
    assert.deepEqual(metering,['reserve']);
    req.emit('finish');assert.deepEqual(await dispatch,{handed:true});await revokeDuringDispatch;controller.abort();
    await assert.rejects(modelResult);assert.deepEqual(metering,['reserve','uncertain']);
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'default'}});
    let entered;const ready=new Promise(resolve=>{entered=resolve;});let release;const gate=new Promise(resolve=>{release=resolve;});
    const commit=vcr.candidateStore.commitLanguageUnit({unit,jobId:'job1',leaseOwner:'worker1',leaseAttempt:1,state:'unknown',evidence:[],validateSources:async args=>{const valid=await verify(args);entered();await gate;return valid;}});
    await ready;
    let revoked=false;const revoke=vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'revoked'}}).then(()=>{revoked=true;});
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(revoked,false,'revocation waits while commit holds source basis');
    release();const result=await commit;await revoke;
    assert.equal(result.alreadyCommitted,false);
    await assert.rejects(vcr.candidateStore.commitLanguageUnit({unit,jobId:'job1',leaseOwner:'worker1',leaseAttempt:1,state:'unknown',evidence:[],validateSources:verify}),error=>error.code==='vcr_language_replan_required');
    await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:source.id,actor:'owner',permission:{status:'default'}});

    await upload('A second synthetic note.');assert.equal(await verify(input),false);
    await vcr.dataPlane.withdrawSubject({studyId:study.id,subjectKey,actor:'owner'});assert.equal(await verify(input),false);
  } finally {await db.close();await isolated.drop();await fs.rm(dir,{recursive:true,force:true});}
});
