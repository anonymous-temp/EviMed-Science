import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {ExtensionService} from '../src/extensionService.mjs';
import {ExtensionAccess} from '../src/extensionAccess.mjs';

const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'';
if(url){const parsed=new URL(url);assert(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname));assert.match(parsed.pathname,/evimed_test/);}
const options={skip:!url&&'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured'};
const a={id:`extension_a_${randomUUID()}`},b={id:`extension_b_${randomUUID()}`};let database,service;
const hash=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const descriptor={id:'bounded-csv',title:'CSV fixture',coordinate:{kind:'npm',name:'example-csv',version:'1.0.0'},executionClass:'isolated-tool',
  integrity:hash('fixed-artifact'),settingsSchema:{rowLimit:{type:'integer',min:1,max:100}}};
const request=key=>({coordinate:descriptor.coordinate,scope:'library',idempotencyKey:key});
before(async()=>{
  if(!url)return;database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'A','development'),($2,'B','development')",[a.id,b.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'p1','P1',1048576),($1,'p2','P2',1048576),($2,'p3','P3',1048576),($1,'p_lock','Lock fixture',1048576)",[a.id,b.id]);
  const access=new ExtensionAccess({store:{requireProject:async(user,id)=>{const rows=await database.query('SELECT id,user_id FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[user.id,id]);if(!rows.rows[0])throw Object.assign(new Error(),{status:404});return{id,userId:user.id};}}});
  service=new ExtensionService(database,{catalogue:[descriptor],access});
});
after(async()=>{if(database){await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[a.id,b.id]]);await database.close();}});

test('installs atomically persist one preparation job under retries and do not certify saved intent',options,async()=>{
  const results=await Promise.all([service.install(a,request('same')),service.install(a,request('same'))]);
  assert.equal(results[0].installation.id,results[1].installation.id);assert.equal(results[0].job.id,results[1].job.id);
  assert.equal(results[0].installation.evidenceState,'source-assessed');assert.equal(results[0].installation.effective,false);
  assert.equal((await service.list(a)).items.length,1);assert.equal((await service.list(b)).items.length,0);
  await assert.rejects(service.install(a,{...request('same'),coordinate:{...descriptor.coordinate,version:'2.0.0'}}),{status:409});
  await assert.rejects(service.get(b,results[0].installation.id),{status:404});
  await assert.rejects(service.getJob(b,results[0].job.id),{status:404});
  await assert.rejects(service.install(a,{...request('forged'),qualified:true}),{status:400});
});
test('project settings CAS keeps precise pins, separate configurations and current connection authority',options,async()=>{
  const added=await service.install(a,request('project'));
  const selected={installationId:added.installation.id,enabled:true,settings:{rowLimit:20},connectionRefs:[]};
  const saved=await service.saveProject(a,'p1',{expectedRevision:0,selections:[selected]});
  assert.equal(saved.revision,1);assert.equal(saved.selections[0].phase,'waiting');assert.equal(saved.selections[0].effective,false);
  assert.equal((await service.project(a,'p2')).selections.length,0);
  const updates=await Promise.allSettled([10,30].map(rowLimit=>service.saveProject(a,'p1',{expectedRevision:1,selections:[{...selected,settings:{rowLimit}}]})));
  assert.equal(updates.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(service.saveProject(b,'p1',{expectedRevision:0,selections:[]}),{status:404});
  await assert.rejects(service.saveProject(a,'p1',{expectedRevision:2,selections:[{...selected,settings:{apiKey:'secret'}}]}),{status:400});
  await assert.rejects(service.saveProject(a,'p1',{expectedRevision:2,selections:[{...selected,connectionRefs:['foreign-ref']}]}),{status:403});
  const disabled=await service.saveProject(a,'p1',{expectedRevision:2,selections:[{...selected,enabled:false}]});
  assert.equal(disabled.selections[0].enabled,false);assert.equal((await service.projectHistory(a,'p1')).items.length,3);
});
test('remove and retry preserve owned histories and cannot adopt a foreign installation or job',options,async()=>{
  const first=await service.install(a,request('retry'));
  await service.cancelJob(a,first.job.id);
  const retried=await service.retry(a,first.installation.id,{expectedRevision:1});
  assert.notEqual(retried.job.id,first.job.id);assert.equal(retried.installation.revision,2);
  await assert.rejects(service.retry(b,first.installation.id,{expectedRevision:2}),{status:404});
  await service.remove(a,first.installation.id,{expectedRevision:2});
  await assert.rejects(service.get(a,first.installation.id),{status:404});
  const history=await service.history(a,first.installation.id);assert.equal(history.items.length,3);
  assert.equal(history.items[0].removed,true);
  const fresh=await service.install(b,request('b-own'));assert.equal(fresh.installation.effective,false);
});
test('project installation saves desired activation atomically without claiming a native generation',options,async()=>{
  const added=await service.install(a,{...request('project-default'),scope:'project',projectId:'p2'});
  const state=await service.project(a,'p2');assert.equal(state.selections.length,1);
  assert.equal(state.selections[0].installationId,added.installation.id);assert.equal(state.selections[0].enabled,true);
  assert.equal(state.effectiveGeneration,null);
});
test('job status exposes neither worker lease authority nor untrusted result/log content',options,async()=>{
  const added=await service.install(a,request('job-projection'));
  const exposed=await service.getJob(a,added.job.id);
  for(const key of ['leaseToken','payload','result','error','userId'])assert.equal(Object.hasOwn(exposed,key),false,key);
});
test('exact-version updates preserve prior pins and reject stale CAS and forged catalogue identity',options,async()=>{
  const added=await service.install(a,request('update'));
  const newer={...descriptor,id:'bounded-csv-v2',coordinate:{...descriptor.coordinate,version:'2.0.0'},integrity:hash('artifact-v2')};
  service.entries.set(newer.id,newer);
  const updated=await service.update(a,added.installation.id,{expectedRevision:1,coordinate:newer.coordinate});
  assert.equal(updated.installation.coordinate.version,'2.0.0');assert.equal(updated.installation.effective,false);
  assert.equal((await service.history(a,added.installation.id)).items[1].coordinate.version,'1.0.0');
  await assert.rejects(service.update(a,added.installation.id,{expectedRevision:1,coordinate:descriptor.coordinate}),{status:409});
  await assert.rejects(service.update(a,added.installation.id,{expectedRevision:2,coordinate:newer.coordinate,qualified:true}),{status:400});
});

async function running(key) {
  const added=await service.install(a,request(key)),leaseToken=randomUUID();
  await database.query("UPDATE evimed_product.jobs SET status='running',attempts=1,worker_id='fixture',lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[added.job.id,leaseToken]);
  return {...added,leaseToken};
}
const acknowledgment=identity=>({...identity,settled:true});
test('running cancellation without an executor refuses instead of publishing a false terminal state',options,async()=>{
  const added=await running('cancel-no-adapter');
  await assert.rejects(service.cancelJob(a,added.job.id),{status:503});
  assert.equal((await service.getJob(a,added.job.id)).status,'running');
});
test('running cancellation waits for joined matching attempt and handles transport, reclaim and completion races',options,async()=>{
  const original=service.cancelPreparation;
  try {
    const failed=await running('cancel-transport');service.cancelPreparation=async()=>{throw new Error('private-secret-transport');};
    await assert.rejects(service.cancelJob(a,failed.job.id),error=>error.status===503&&!error.message.includes('private-secret'));
    assert.equal((await service.getJob(a,failed.job.id)).status,'running');
    const mismatch=await running('cancel-mismatch');service.cancelPreparation=async identity=>({...acknowledgment(identity),leaseToken:'wrong'});
    await assert.rejects(service.cancelJob(a,mismatch.job.id),{status:409});assert.equal((await service.getJob(a,mismatch.job.id)).status,'running');
    const reclaimed=await running('cancel-reclaim');service.cancelPreparation=async identity=>{
      await database.query("UPDATE evimed_product.jobs SET lease_token=$2,attempts=attempts+1 WHERE id=$1",[identity.jobId,randomUUID()]);return acknowledgment(identity);
    };
    await assert.rejects(service.cancelJob(a,reclaimed.job.id),{status:409});assert.equal((await service.getJob(a,reclaimed.job.id)).status,'running');
    const completed=await running('cancel-completed');service.cancelPreparation=async identity=>{
      await service.jobs.finish(a.id,identity.jobId,identity.leaseToken,{});return acknowledgment(identity);
    };
    assert.equal((await service.cancelJob(a,completed.job.id)).status,'succeeded');
    const joined=await running('cancel-joined');let release,entered;
    const ready=new Promise(resolve=>{entered=resolve;}),done=new Promise(resolve=>{release=resolve;});
    service.cancelPreparation=async identity=>{entered();await done;return acknowledgment(identity);};
    const cancel=service.cancelJob(a,joined.job.id);await ready;
    assert.equal((await service.getJob(a,joined.job.id)).status,'running');release();
    assert.equal((await cancel).status,'canceled');
  }finally{service.cancelPreparation=original;}
});
test('reload projects current preparation outcome and recovers job identity without leases or private diagnostics',options,async()=>{
  const added=await running('projection-success');
  await service.jobs.finish(a.id,added.job.id,added.leaseToken,{installationId:added.installation.id,installationRevision:1,integrity:descriptor.integrity,artifactDigest:hash('published'),privatePath:'/secret/cache',apiKey:'canary'});
  const view=await service.get(a,added.installation.id);
  assert.equal(view.prepareJobId,added.job.id);assert.equal(view.phase,'waiting');assert.equal(view.preparation.status,'succeeded');assert.equal(view.effective,false);
  assert.equal(JSON.stringify(view).includes('/secret/cache'),false);assert.equal(JSON.stringify(view).includes('canary'),false);
  const unknown=await running('projection-unverified');await service.jobs.finish(a.id,unknown.job.id,unknown.leaseToken,{});
  const unverified=await service.get(a,unknown.installation.id);assert.equal(unverified.phase,'saved');assert.equal(unverified.preparation.outcome,'unverified');
});
test('reversed project selection orders complete as ordinary CAS competition rather than PostgreSQL deadlock',options,async()=>{
  const extra={...descriptor,id:'lock-second',coordinate:{kind:'npm',name:'example-lock-second',version:'1.0.0'}};service.entries.set(extra.id,extra);
  const first=await service.install(a,request('lock-first'));
  const second=await service.install(a,{...request('lock-second'),coordinate:extra.coordinate});
  const ids=[first.installation.id,second.installation.id].sort(),pick=id=>({installationId:id,enabled:true,settings:{},connectionRefs:[]});
  const original=service.read.bind(service),seen=new Set();let firstId,release,entered;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  service.read=async(user,kind,id,client,...rest)=>{
    const firstRead=kind==='extension-installation'&&!seen.has(client);
    if(firstRead&&firstId===id)release();
    const row=await original(user,kind,id,client,...rest);
    if(firstRead){seen.add(client);if(!firstId){firstId=id;entered();await gate;}else release();}return row;
  };
  try {
    const one=service.saveProject(a,'p_lock',{expectedRevision:0,selections:ids.map(pick)});await ready;
    const two=service.saveProject(a,'p_lock',{expectedRevision:0,selections:[...ids].reverse().map(pick)});
    const outcomes=await Promise.allSettled([one,two]);
    assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
    assert.equal(outcomes.find(row=>row.status==='rejected').reason.code,'product_revision_conflict');
  }finally{release();service.read=original;}
});
test('trusted cancellation joins the owned process before terminal publication and rejects incomplete acknowledgment',options,async()=>{
  const original=service.cancelPreparation,added=await running('cancel-process-join');
  const child=spawn(process.execPath,['-e',"process.on('message',()=>process.exit(0));process.send('ready');"],{stdio:['ignore','ignore','ignore','ipc']});
  try {
    await once(child,'message');assert.equal(child.exitCode,null);
    service.cancelPreparation=async identity=>{
      assert.equal(identity.jobId,added.job.id);assert.equal(identity.leaseToken,added.leaseToken);
      const exit=once(child,'exit');child.send('stop');await exit;return acknowledgment(identity);
    };
    assert.equal((await service.cancelJob(a,added.job.id)).status,'canceled');assert.equal(child.exitCode,0);
    const incomplete=await running('cancel-incomplete');service.cancelPreparation=async()=>({settled:true});
    await assert.rejects(service.cancelJob(a,incomplete.job.id),{status:409});assert.equal((await service.getJob(a,incomplete.job.id)).status,'running');
  } finally {
    service.cancelPreparation=original;
    if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}
  }
});
test('cancellation cannot cancel a replacement installation job or mutate a changed account generation',options,async()=>{
  const original=service.cancelPreparation;
  try {
    const old=await running('cancel-update');let replacement;
    service.cancelPreparation=async identity=>{replacement=await service.retry(a,old.installation.id,{expectedRevision:1});return acknowledgment(identity);};
    assert.equal((await service.cancelJob(a,old.job.id)).status,'canceled');assert.equal((await service.getJob(a,replacement.job.id)).status,'queued');
    assert.equal((await service.get(a,old.installation.id)).prepareJobId,replacement.job.id);
    const changed=await running('cancel-account-change');const created=(await database.query('SELECT created_at::text AS value FROM evimed_control.users WHERE id=$1',[a.id])).rows[0].value;
    service.cancelPreparation=async identity=>{await database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id=$1",[a.id]);return acknowledgment(identity);};
    try{await assert.rejects(service.cancelJob(a,changed.job.id),{status:401});assert.equal((await service.getJob(a,changed.job.id)).status,'running');}
    finally{await database.query('UPDATE evimed_control.users SET created_at=$2::timestamptz WHERE id=$1',[a.id,created]);}
  }finally{service.cancelPreparation=original;}
});
test('role revocation during cancellation is rechecked before terminal mutation',options,async()=>{
  const original=service.cancelPreparation,judge=service.access.projectAccess;let permitted=true;
  service.access.projectAccess=async(_user,id)=>permitted?{project:{id,userId:a.id},role:'owner'}:null;
  try {
    const added=await service.install(a,{...request('cancel-role'),scope:'project',projectId:'p2'}),leaseToken=randomUUID();
    await database.query("UPDATE evimed_product.jobs SET status='running',attempts=1,worker_id='fixture',lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[added.job.id,leaseToken]);
    service.cancelPreparation=async identity=>{permitted=false;return acknowledgment(identity);};
    await assert.rejects(service.cancelJob(a,added.job.id),{status:404});assert.equal((await service.getJob(a,added.job.id)).status,'running');
  }finally{service.cancelPreparation=original;service.access.projectAccess=judge;}
});
test('history pages recover all retained personal and project revisions without duplication',options,async()=>{
  const added=await service.install(a,request('history-paging'));await service.retry(a,added.installation.id,{expectedRevision:1});await service.remove(a,added.installation.id,{expectedRevision:2});
  const first=await service.history(a,added.installation.id,{limit:2});assert.deepEqual(first.items.map(row=>row.revision),[3,2]);
  const second=await service.history(a,added.installation.id,{limit:2,beforeRevision:first.nextBeforeRevision});assert.deepEqual(second.items.map(row=>row.revision),[1]);assert.equal(second.nextBeforeRevision,null);
  const projectFirst=await service.projectHistory(a,'p1',{limit:2});const projectNext=await service.projectHistory(a,'p1',{limit:2,beforeRevision:projectFirst.nextBeforeRevision});
  assert.deepEqual([...projectFirst.items,...projectNext.items].map(row=>row.revision),[3,2,1]);
  await assert.rejects(service.history(a,added.installation.id,{limit:101}),{status:400});
});
test('failed, canceled and obsolete preparation outcomes remain bounded and cannot describe the latest revision as ready',options,async()=>{
  const failed=await running('projection-failed');await service.jobs.fail(a.id,failed.job.id,failed.leaseToken,{code:'extension_contract_invalid',message:'/private/path apiKey-canary'},{retry:false});
  const failure=await service.get(a,failed.installation.id);assert.equal(failure.phase,'failed');assert.equal(failure.preparation.refusalCode,'extension_contract_invalid');
  assert.equal(JSON.stringify(failure).includes('canary'),false);assert.equal(JSON.stringify(failure).includes('/private/path'),false);
  const canceled=await service.install(a,request('projection-canceled'));await service.cancelJob(a,canceled.job.id);
  const canceledView=await service.get(a,canceled.installation.id);assert.equal(canceledView.phase,'saved');assert.equal(canceledView.preparation.status,'canceled');
  const old=await running('projection-obsolete');const latest=await service.retry(a,old.installation.id,{expectedRevision:1});
  await service.jobs.finish(a.id,old.job.id,old.leaseToken,{installationId:old.installation.id,installationRevision:1,integrity:descriptor.integrity,artifactDigest:hash('old-ready')});
  const current=await service.get(a,old.installation.id);assert.equal(current.prepareJobId,latest.job.id);assert.equal(current.preparation.status,'queued');assert.equal(current.phase,'preparing');
});
