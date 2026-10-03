/** Real isolated product/VCR/credential/usage stores. No native actor/call success or vendor billing is simulated. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from '../../apps/server/test/helpers/geoTestDatabase.mjs';
import { VcrDataStore } from '../../apps/server/src/vcrDataStore.mjs';
import { VcrAccess } from '../../apps/server/src/vcrAccess.mjs';
import { ConnectorCredentialStore } from '../../apps/server/src/connectorCredentials.mjs';
import { ExtensionAccess } from '../../apps/server/src/extensionAccess.mjs';
import { ExtensionConnections } from '../../apps/server/src/extensionConnections.mjs';
import { ExtensionService } from '../../apps/server/src/extensionService.mjs';
import { ProductJobs, ProductDocuments } from '../../apps/server/src/productStore.mjs';
import { UsageLedger } from '../../apps/server/src/usageLedger.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function runLedgerBoundaryControls({ databaseUrl }) {
 const isolated = await createGeoTestDatabase(databaseUrl,'w8ledger'), root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'evimed-saas-ledger-')));
 let database, report, failure=null, cleanupFailed=false;
 try {
  database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:1,databaseConnectionTimeoutMs:1000});await database.migrate();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('owner','Owner','development'),('editor','Data manager','development'),('viewer','Viewer','development'),('other','Other','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('owner','shared','Shared study',1048576),('viewer','own','Viewer own project',1048576),('other','own','Other own project',1048576)");
  const data=new VcrDataStore({database});await data.ready();
  await database.query("INSERT INTO evimed_vcr.studies(id,user_id,project_id,name) VALUES('std_w8','owner','shared','Synthetic role exercise')");
  await database.query("INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES('std_w8','editor','data_manager'),('std_w8','viewer','viewer')");
  const access=new VcrAccess({store:data}), studyRequest={studyId:'std_w8'};
  const viewerRead=await access.judge({actor:'viewer',...studyRequest,ability:'read'}), viewerWrite=await access.judge({actor:'viewer',...studyRequest,ability:'write'});
  assert.equal(viewerRead.allowed,true);assert.equal(viewerWrite.code,'vcr_role_forbids');assert.equal((await access.judge({actor:'viewer',...studyRequest,ability:'manage_members'})).allowed,false);
  assert.equal((await access.judge({actor:'editor',...studyRequest,ability:'write'})).allowed,true);assert.equal((await access.judge({actor:'other',...studyRequest,ability:'read'})).code,'vcr_study_not_found');
  const projectAccess=new ExtensionAccess({projectAccess:async(user,id,{client}={})=>{
   const db=client??database;if(id==='shared') {const member=await db.query("SELECT role FROM evimed_vcr.members WHERE study_id='std_w8' AND user_id=$1",[user.id]);
    if(user.id!=='owner'&&!member.rows.length)return null;return{project:{id:'shared',userId:'owner'},role:user.id==='owner'?'owner':member.rows.some(row=>row.role==='data_manager')?'editor':'viewer'};}
   const own=await db.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[user.id,id]);return own.rowCount?{project:{id,userId:user.id},role:'owner'}:null;
  }});
  const entry={id:'fixture-documents',coordinate:{kind:'npm',name:'fixture-documents',version:'1.0.0'},integrity:'sha256:'+hash('fixture-only-no-admission'),executionClass:'isolated-tool',settingsSchema:{}};
  const extensions=new ExtensionService(database,{access:projectAccess,catalogue:[entry]});
  await assert.rejects(extensions.install({id:'viewer'},{coordinate:entry.coordinate,scope:'project',projectId:'shared',idempotencyKey:'viewer-forbidden'}),{code:'project_not_found'});
  assert.equal((await projectAccess.project({id:'viewer'},'own')).userId,'viewer');
  const observations=[];const observe=(caseId,expected,actual,setup='Synthetic users/projects/study rows; actual access/store code and SQL roles/grants')=>observations.push({caseId,scope:'actual-isolated-pg-authority-and-ledger',setup,expected,actual});
  observe('SAAS-03','Viewer shared read allowed, shared writes/install/manage refused; editor allowed and own project usable',{viewerRead:viewerRead.allowed,viewerWrite:viewerWrite.code,viewerInstall:'project_not_found',editorWrite:true,ownRead:true});
  const credentials=new ConnectorCredentialStore({database,secret:randomUUID()+randomUUID(),config:{}});await credentials.migrate();
  const canary='w8-'+randomUUID()+'@example.invalid';await credentials.set('owner','unpaywall',canary);assert.equal(await credentials.resolveOwn('owner','unpaywall'),canary);assert.equal(await credentials.resolveOwn('other','unpaywall'),null);
  const connections=new ExtensionConnections({credentials,access:projectAccess}), connectionEntry={id:'fixture-source',connectionRequirements:[{kind:'unpaywall',operations:['doi.resolve']}]};
  const reference=(await connections.list({id:'owner'},connectionEntry,'shared')).items[0];assert(reference);
  const viewerOwnerConnection=await connections.authorize({id:'viewer'},reference.id,{project:{id:'shared',userId:'owner'},entry:connectionEntry,operation:'doi.resolve',revision:reference.revision});assert.equal(viewerOwnerConnection,false);
  assert.equal(await connections.authorize({id:'owner'},reference.id,{project:{id:'shared',userId:'owner'},entry:connectionEntry,operation:'doi.resolve',revision:reference.revision}),true);
  const jobs=new ProductJobs(database), documents=new ProductDocuments(database);
  const queued=await jobs.enqueue('owner','extension-execute',{fixture:true,studyId:'std_w8',actorId:'editor'},{idempotencyKey:'before-revocation',projectId:'shared'});
  const running=await jobs.claim(['extension-execute'],'w8-authority-guard');assert.equal(running.id,queued.id);
  await documents.put('owner','extension-resource','completed-public-output',{kind:'fixture-completed-output',digest:'sha256:'+hash('completed permitted public result')},{expectedRevision:0});
  await database.query("DELETE FROM evimed_vcr.members WHERE study_id='std_w8' AND user_id='editor'");
  const after=await access.judge({actor:'editor',...studyRequest,ability:'write'});assert.equal(after.code,'vcr_study_not_found');
  await jobs.fail('owner',running.id,running.leaseToken,{code:after.code,message:'Current membership revoked; no new work.'});
  await credentials.remove('owner','unpaywall');const afterConnection=await connections.authorize({id:'owner'},reference.id,{project:{id:'shared',userId:'owner'},entry:connectionEntry,operation:'doi.resolve',revision:reference.revision});assert.equal(afterConnection,false);
  assert(await documents.get('owner','extension-resource','completed-public-output'));
  observe('SAAS-05','The real access boundary rejects removed membership/current credential; its refusal can settle an owned leased fixture task while completed output remains',{afterMembershipRevocation:after.code,afterCredentialRevocation:afterConnection,jobStatus:(await jobs.get('owner',running.id)).status,completedOutputRetained:true},'Real owner-project leased ProductJobs row with fixture actor metadata; driver explicitly checks current role before settlement. No native execution or integrated worker revocation exercised here');
  await credentials.set('owner','unpaywall',canary);const status=await credentials.status('owner'), discovered=await connections.list({id:'owner'},connectionEntry,'shared');
  const rows=(await database.query('SELECT ciphertext,nonce,tag FROM evimed_control.user_connector_credentials')).rows;
  const surfaces=[JSON.stringify(status),JSON.stringify(discovered),...rows.map(row=>row.ciphertext.toString('utf8'))];assert.equal(surfaces.some(value=>value.includes(canary)),false);
  await fs.writeFile(path.join(root,'public-observation.json'),JSON.stringify({status,discovered}));assert.equal((await fs.readFile(path.join(root,'public-observation.json'),'utf8')).includes(canary),false);
  observe('SAAS-06','Shared read permission cannot borrow the owner connection; real credential encryption/AAD and public metadata cannot expose the synthetic canary',{plaintextScanMatches:0,foreignResolve:null,viewerOwnerConnection,managedOwnerResolutionMatched:true,surfacesScanned:surfaces.length+1},'Synthetic credential canary in existing store; actual account-export/full serving logs/package cache scan still separate');
  const duplicates=await Promise.all(Array.from({length:4},()=>jobs.enqueue('owner','extension-execute',{fixture:true},{idempotencyKey:'same-operation'})));assert.equal(new Set(duplicates.map(job=>job.id)).size,1);
  const otherJob=await jobs.enqueue('other','extension-execute',{fixture:true},{idempotencyKey:'same-operation',projectId:'own'});assert.notEqual(otherJob.id,duplicates[0].id);
  assert.equal(await jobs.get('other',duplicates[0].id),null);
  const usage=new UsageLedger(database), now=new Date();
  const reservation=id=>({id,userId:'owner',projectId:'shared',purpose:'research',model:'controlled-fixture-model',priceVersion:'controlled-contract-only',currency:'CNY',requestFingerprint:hash(id),estimatedCost:0.75,dailyLimit:1,now});
  const limits=await Promise.allSettled([usage.reserveModel(reservation('usage-one')),usage.reserveModel(reservation('usage-two'))]);assert.equal(limits.filter(result=>result.status==='fulfilled').length,1);assert.equal(limits.filter(result=>result.status==='rejected'&&result.reason.code==='usage_budget_exceeded').length,1);
  const reserved=limits.find(result=>result.status==='fulfilled').value, settlement={usage:{cacheHitTokens:1,cacheMissTokens:2,completionTokens:3},actualCost:0,priced:false,providerRequestId:'controlled-fixture-not-a-provider-call'};
  const first=await usage.settleModel('owner',reserved.id,settlement), again=await usage.settleModel('owner',reserved.id,settlement);assert.equal(first.revision,again.revision);
  await assert.rejects(usage.settleModel('other',reserved.id,settlement));
  const otherReservation=await usage.reserveModel({...reservation('usage-other'),userId:'other',projectId:'own'});
  await assert.rejects(usage.settleModel('owner',otherReservation.id,settlement));await usage.settleModel('other',otherReservation.id,settlement);
  const counts=(await database.query("SELECT user_id,count(*)::int AS n FROM evimed_usage.model_requests WHERE status='settled' GROUP BY user_id ORDER BY user_id")).rows;assert.deepEqual(counts,[{user_id:'other',n:1},{user_id:'owner',n:1}]);
  observe('SAAS-14','Concurrent retry creates one job per actor; rolling budget refuses excess; repeat settlement stays one correctly scoped row per actor',{sameJobCount:new Set(duplicates.map(job=>job.id)).size,foreignJobHidden:true,otherRetryIndependent:true,capRejected:1,settledRows:2,settledRowsByActor:counts,settlementRevision:first.revision,actualCost:0,priced:false},'Usage amounts/token counts are explicit controlled-contract inputs, not real provider measurements or offline CPU billing; actual SQL ledger/caps/idempotency exercised');
  report={qualified:false,observations,cleanup:{databaseDropped:true},limitation:'Actual SQL boundary observations; full native/gateway execution, account export/log scan and provider-derived metering still not complete.'};
 }catch(error){failure=error;}finally{try{await database?.close();await isolated.drop();await fs.rm(root,{recursive:true,force:true});}catch{cleanupFailed=true;}}
 if(cleanupFailed)throw new Error('ledger_boundary_cleanup_unconfirmed');if(failure)throw failure;return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try { if (process.argv.length !== 2) throw new Error('no_public_fixture_arguments'); process.stdout.write(JSON.stringify(await runLedgerBoundaryControls({ databaseUrl: process.env.OPEN_SCIENCE_TEST_POSTGRES_URL }))+'\n'); }
 catch(error) { process.stderr.write(JSON.stringify({status:'failed',qualified:false,code:error?.code??'ledger_boundary_failed'})+'\n'); process.exitCode=1; }
}
