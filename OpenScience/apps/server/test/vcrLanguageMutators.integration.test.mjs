import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { VcrDataStore } from '../src/vcrDataStore.mjs';
import { VcrErasureStore } from '../src/vcrErasureStore.mjs';
import { VcrCandidateTrialStore } from '../src/vcrCandidateTrialStore.mjs';
import { VcrStore } from '../src/vcrStore.mjs';
import { VcrJobs } from '../src/vcrJobs.mjs';
import { freezeVcrLanguageUnit } from '../src/vcrLanguageUnit.mjs';
import { languageCriteriaByKey, languageCriterionHash } from '../src/vcrMatchingSnapshot.mjs';
import { lockVcrLanguageSources, lockVcrLanguageLease, lockVcrLanguageStudyBasis } from '../src/vcrLanguageFence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const dbLockSources=(database,ids)=>database.transaction(client=>lockVcrLanguageSources(client,ids));
test('real permission, membership, candidate and erasure mutations wait on their study or source basis', {skip:!url && 'isolated test database not configured',timeout:30000}, async(t)=>{
  const isolated=await createGeoTestDatabase(url,'vcrlang');
  const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:6,databaseConnectionTimeoutMs:2000});
  const store=new VcrDataStore({database}), erasure=new VcrErasureStore({database}), candidates=new VcrCandidateTrialStore({database});
  const blocker=new pg.Client({connectionString:isolated.url});
  try {
    await store.ready(); await blocker.connect();
    await database.query("INSERT INTO evimed_vcr.studies(id,user_id,project_id,name,question,data_tier,intended_use) VALUES ('s1','u1','p1','test','test','T1','exploratory')");
    const source=await store.createSource({studyId:'s1',userId:'u1',name:'synthetic',allowedUses:['vcr']});
    await database.query("INSERT INTO evimed_vcr.studies(id,user_id,project_id,name,question,data_tier,intended_use) VALUES ('s2','u2','p2','test','test','T1','exploratory')");
    const other=await store.createSource({studyId:'s2',userId:'u2',name:'synthetic2',allowedUses:['vcr']});
    await blocker.query('BEGIN'); await lockVcrLanguageStudyBasis(blocker,'s1'); await lockVcrLanguageSources(blocker,[source.id]);
    const start=performance.now();
    await store.setCloudPermission({studyId:'s2',sourceId:other.id,actor:'u2',permission:null});
    const elapsed=performance.now()-start;
    await blocker.query('COMMIT');
    t.diagnostic(`Synthetic unrelated study/source mutation completed in ${elapsed.toFixed(1)}ms while another basis was held; not a production latency estimate.`);
    await blocker.query('BEGIN');await lockVcrLanguageSources(blocker,[other.id,source.id]);
    let otherLocksDone=false;
    const ordered=dbLockSources(database,[source.id,other.id]).then(()=>{otherLocksDone=true;});
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(otherLocksDone,false);
    await blocker.query('COMMIT');await ordered;assert.equal(otherLocksDone,true,'opposite input orders serialize without deadlock');


    await store.addMember({studyId:'s1',userId:'u2',role:'viewer'});
    const grant=await store.createGrant({sourceId:source.id,studyId:null,userId:'u1',grantee:'u2'});
    const trial={registry:'clinicaltrials.gov',registryId:'NCT00000001',recordHash:'a'.repeat(64),eligibilityText:'Age 18',locations:{}};
    const criterion={kind:'inclusion',criterionType:'demographic',sourceText:'Age 18',requirement:{op:'language',key:'age_text',text:'Age 18'},applicability:null,sourceLocator:{},evidenceNeeded:[]};
    await database.query("INSERT INTO evimed_vcr.jobs(id,study_id,user_id,kind,method,state,lease_owner,lease_until,attempts) VALUES ('job1','s1','u1','match_extract','matching.language','running','worker1',now()+interval '5 minutes',1)");
    await database.query("UPDATE evimed_vcr.jobs SET scenario=jsonb_build_object('unitHashes',jsonb_build_array($1::text)) WHERE id='job1'",['a'.repeat(64)]);
    const jobs=new VcrJobs({store:new VcrStore({database})});
    const checkLease=(attempt,owner='worker1')=>database.transaction(async client=>{
      await lockVcrLanguageStudyBasis(client,'s1');await lockVcrLanguageLease(client,{studyId:'s1',jobId:'job1',userId:'u1',owner,attempt,unitHash:'a'.repeat(64)});
    });
    await checkLease(1);
    await assert.rejects(checkLease(2),error=>error.code==='vcr_language_lease_changed');
    await assert.rejects(checkLease(1,'worker2'),error=>error.code==='vcr_language_lease_changed');
    const operations=[
      ['member',()=>store.removeMember({studyId:'s1',userId:'u2',role:'viewer'})],
      ['permission',()=>store.setCloudPermission({studyId:'s1',sourceId:source.id,actor:'u1',permission:null})],
      ['source status',()=>store.setSourceStatus({sourceId:source.id,status:'profiled'})],
      ['global grant revoke',()=>store.revokeGrant({grantId:grant.id})],
      ['global grant create',()=>store.createGrant({sourceId:source.id,studyId:null,userId:'u1',grantee:'u3'})],
      ['erasure',()=>erasure.eraseDocuments({studyId:'s1',userId:'u1',actor:'u1',fileIds:[]})],
      ['candidate',()=>candidates.saveCandidateTrial({studyId:'s1',userId:'u1',trial,criteria:[criterion],max:10})],
      ['job cancel',()=>jobs.cancel('s1','job1')],
    ];
    for(const [name,operation] of operations){
      await blocker.query('BEGIN');await lockVcrLanguageStudyBasis(blocker,'s1');await lockVcrLanguageSources(blocker,[source.id]);
      let finished=false;const pending=operation().finally(()=>{finished=true;});
      let waiting=false;
      for(let i=0;i<200&&!waiting;i++){
        waiting=(await blocker.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting")).rows[0].waiting;
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,5));
      }
      assert.equal(waiting,true,`${name} waits on the shared basis`);assert.equal(finished,false,name);
      await blocker.query('COMMIT');await pending;
    }
    await assert.rejects(checkLease(1),error=>error.code==='vcr_language_lease_changed');
    const file = (await store.addSourceFile({studyId:'s1',sourceId:source.id,userId:'u1',role:'document',name:'case.txt',format:'txt',location:'s1/case.txt',sha256:'b'.repeat(64),bytes:5})).file;
    await database.query("INSERT INTO evimed_vcr.jobs(id,study_id,user_id,kind,method,state,lease_owner,lease_until,attempts) VALUES ('job2','s1','u1','match_extract','matching.language','running','worker1',now()+interval '5 minutes',1)");
    const candidate=await candidates.getCandidateTrial({studyId:'s1',registryId:'NCT00000001'});
    const criteria=await candidates.listCriteria(candidate.id);
    const binding=languageCriterionHash(languageCriteriaByKey(criteria).get('age_text'),'age_text');
    const unit={studyId:'s1',userId:'u1',subjectKey:'patient1',candidateTrialId:candidate.id,criterionKey:'age_text',axis:'requirement',recordHash:'a'.repeat(64),criterionHash:binding,
      expectedJudgmentId:null,evaluatorVersion:'v1',promptVersion:'p1',model:'deepseek-flash',thinking:'disabled',outputLimit:1000,
      documents:[{id:file.id,sourceId:source.id,sourceHash:'b'.repeat(64),projectionHash:null,projectionId:null}]};
    await database.query("UPDATE evimed_vcr.jobs SET scenario=jsonb_build_object('unitHashes',jsonb_build_array($1::text)) WHERE id='job2'",[freezeVcrLanguageUnit(unit).unitHash]);
    const commit=(overrides={})=>candidates.commitLanguageUnit({unit,jobId:'job2',leaseOwner:'worker1',leaseAttempt:1,state:'unknown',evidence:[],validateSources:async()=>true,...overrides});
    await assert.rejects(commit({validateSources:async()=>false}),error=>error.code==='vcr_language_replan_required');
    const expiring={...unit,subjectKey:'patient2'};
    await database.query("INSERT INTO evimed_vcr.jobs(id,study_id,user_id,kind,method,state,lease_owner,lease_until,attempts,scenario) VALUES ('job3','s1','u1','match_extract','matching.language','running','worker1',clock_timestamp()+interval '50 milliseconds',1,jsonb_build_object('unitHashes',jsonb_build_array($1::text)))",[freezeVcrLanguageUnit(expiring).unitHash]);
    await assert.rejects(candidates.commitLanguageUnit({unit:expiring,jobId:'job3',leaseOwner:'worker1',leaseAttempt:1,state:'unknown',evidence:[],validateSources:async()=>{await new Promise(resolve=>setTimeout(resolve,100));return true;}}),error=>error.code==='vcr_language_lease_changed');
    const concurrent=await Promise.all([commit(),commit()]);
    const written=concurrent.find(row=>!row.alreadyCommitted);
    assert.ok(written);assert.equal(concurrent.filter(row=>row.alreadyCommitted).length,1);
    assert.equal(concurrent[0].id,concurrent[1].id);
    assert.deepEqual(await commit(),{id:written.id,alreadyCommitted:true});
    assert.equal((await database.query('SELECT count(*)::int AS n FROM evimed_vcr.language_judgments WHERE id=$1',[written.id])).rows[0].n,1);
    const newer=await candidates.saveLanguageJudgment({studyId:'s1',userId:'u1',subjectKey:'patient1',candidateTrialId:candidate.id,criterionKey:'age_text',state:'unknown',evidence:[]});
    await database.query("UPDATE evimed_vcr.language_judgments SET created_at=created_at-interval '1 hour' WHERE id=$1",[newer.id]);
    assert.equal((await candidates.latestLanguageJudgments({studyId:'s1',candidateTrialId:candidate.id,subjectKey:'patient1'})).age_text.id,newer.id,'head order is independent of wall-clock regression');
    await assert.rejects(commit(),error=>error.code==='vcr_language_replan_required');
    const refreshed={...unit,expectedJudgmentId:newer.id,promptVersion:'p2'};
    await database.query("UPDATE evimed_vcr.jobs SET scenario=jsonb_build_object('unitHashes',jsonb_build_array($1::text,$2::text)) WHERE id='job2'",[freezeVcrLanguageUnit(unit).unitHash,freezeVcrLanguageUnit(refreshed).unitHash]);
    await candidates.saveCandidateTrial({studyId:'s1',userId:'u1',trial:{...trial,recordHash:'c'.repeat(64)},criteria:[criterion],max:10});
    await assert.rejects(commit({unit:refreshed}),error=>error.code==='vcr_language_replan_required');
    await jobs.cancel('s1','job2');
    await assert.rejects(commit({unit:refreshed}),error=>error.code==='vcr_language_lease_changed');

    // Keep an older answer without this dependency, then erase the current
    // head: the older answer must not silently reappear.
    await database.query('DELETE FROM evimed_vcr.language_judgment_dependencies WHERE judgment_id=$1',[written.id]);
    await database.query('INSERT INTO evimed_vcr.language_judgment_dependencies(study_id,judgment_id,document_id) VALUES ($1,$2,$3)',['s1',newer.id,file.id]);
    const marked=await erasure.markBasisChanged({studyId:'s1',cause:'permission',causeId:'source',documentIds:[file.id]});
    assert.equal(marked.languageJudgments,1,'unquoted context still marks the judgment');
    const erased=await erasure.eraseDocuments({studyId:'s1',userId:'u1',actor:'u1',fileIds:[file.id]});
    assert.equal(erased.counts.judgmentsRemoved,1,'unquoted context still invalidates an unknown');
    assert.equal((await database.query('SELECT 1 FROM evimed_vcr.language_judgments WHERE id=$1',[newer.id])).rowCount,0);
    assert.equal((await candidates.latestLanguageJudgments({studyId:'s1',candidateTrialId:candidate.id,subjectKey:'patient1'})).age_text,undefined,'an erased head never resurrects an older answer');
  } finally {await blocker.query('ROLLBACK').catch(()=>{});await blocker.end();await database.close();await isolated.drop();}
});
