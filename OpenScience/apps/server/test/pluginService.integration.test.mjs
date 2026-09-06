import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { PluginService, projectPluginId } from '../src/pluginService.mjs';
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (databaseUrl) { const url = new URL(databaseUrl); assert.ok(['localhost','127.0.0.1'].includes(url.hostname)); assert.match(url.pathname,/evimed_test/); }
const options = { skip: !databaseUrl && 'Dedicated local PostgreSQL required' };
let db, service, owner, other, project, second;
before(async () => {
  if (!databaseUrl) return;
  db = new ControlPlaneDatabase({databaseUrl,databasePoolMax:8,databaseConnectionTimeoutMs:2000});
  await db.migrate();
  owner = `plugin_${randomUUID()}`; other = `plugin_${randomUUID()}`;
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Plugin','development'),($2,'Other','development')",[owner,other]);
  project = {id:'one',userId:owner}; second = {id:'two',userId:owner};
  for (const p of [project,second,{id:'one',userId:other}]) await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Project',1000000)",[p.userId,p.id]);
  service = new PluginService(db);
});
after(async()=>{if(db){await db.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[owner,other]]);await db.close();}});

test('project-scoped CAS, atomic job and saved history survive restarts and configuration rollback', options, async()=>{
  const saved = await service.save(owner,project,{expectedRevision:0,enabled:true,settings:{timeoutMs:4000}});
  assert.equal(saved.desired.revision,1); assert.equal(saved.phase,'pending'); assert.equal(saved.effective,null);
  await assert.rejects(service.save(owner,project,{expectedRevision:0,enabled:false,settings:{timeoutMs:4000}}),{status:409});
  assert.equal((await service.get(owner,second)).desired.revision,0);
  await assert.rejects(service.get(other,project),{status:404});
  assert.equal((await service.get(other,{id:'one',userId:other})).desired.revision,0);
  await service.save(owner,project,{expectedRevision:1,enabled:false,settings:{timeoutMs:5000}});
  await service.rollback(owner,project,{expectedRevision:2,targetRevision:1});
  const restarted = new PluginService(db);
  assert.deepEqual((await restarted.get(owner,project)).desired,{revision:3,enabled:true,settings:{timeoutMs:4000}});
  assert.deepEqual((await restarted.history(owner,project)).items.map(x=>x.revision),[3,2,1]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE user_id=$1 AND kind='plugin-apply'",[owner])).rows[0].n,3);
  for(let n=0;n<3;n++)await service.get(owner,project);
  assert.equal((await service.history(owner,project)).items.length,3);
});

test('enqueue failure rolls back configuration, history and observation together', options, async()=>{
  const broken = new PluginService(db,{jobs:{enqueue:async()=>{throw new Error('injected outbox failure');}}});
  await assert.rejects(broken.save(owner,second,{expectedRevision:0,enabled:true,settings:{timeoutMs:4000}}),/outbox/);
  assert.equal((await service.get(owner,second)).desired.revision,0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_product.revisions WHERE user_id=$1 AND id=$2",[owner,projectPluginId(second.id)])).rows[0].n,0);
});

test('shared admission excludes apply until kernel acknowledgement and rejects a new prompt during apply', options, async()=>{
  let entered, release;
  const enteredPromise=new Promise(r=>{entered=r;}); const released=new Promise(r=>{release=r;});
  const admission=service.withAdmission(project,async()=>{entered();await released;});
  await enteredPromise;
  const check=await db.transaction(c=>c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`plugin-project:${owner}:one`]));
  assert.equal(check.rows[0].acquired,false); release(); await admission;
  await db.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`plugin-project:${owner}:one`]);
    await assert.rejects(service.withAdmission(project,async()=>assert.fail('must not dispatch')),{code:'plugin_apply_in_progress'});
  });
});

test('deleting a project cascades plugin configurations, history, state and jobs', options, async()=>{
  await service.save(owner,second,{expectedRevision:0,enabled:false,settings:{timeoutMs:4000}});
  await db.query('DELETE FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[owner,second.id]);
  for(const table of ['documents','revisions','plugin_application_state']) assert.equal((await db.query(`SELECT count(*)::int AS n FROM evimed_product.${table} WHERE user_id=$1 AND id=$2`,[owner,projectPluginId(second.id)])).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE user_id=$1 AND project_id=$2",[owner,second.id])).rows[0].n,0);
});

test('leased worker defers busy work, applies, verifies rollback and recovers last-known-good after restart', options, async()=>{
  const {PluginApplyWorker}=await import('../src/pluginApplyWorker.mjs');
  await db.query("UPDATE evimed_product.jobs SET status='canceled',lease_token=NULL,lease_expires_at=NULL WHERE kind='plugin-apply'");
  const p={id:'worker',userId:owner};
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Worker',1000000)",[owner,p.id]);
  let current={revision:0,enabled:true,settings:{timeoutMs:15000}};let generation='initial';let busy=true;let starts=0;let failRevision=null;
  const runtime={runtimeGeneration:()=>generation,runtimePluginConfig:()=>current,pluginRuntimeBusy:async()=>busy,
    replacePluginRuntime:async(_p,config)=>{starts++;current=config;generation=`generation-${starts}`;},
    probePlugin:async(_p,config)=>{if(config.revision===failRevision)throw Error('probe failed');return{generation};},stop:async()=>{generation=null;}};
  const worker=new PluginApplyWorker({service,runtime,resolveProject:async()=>p,ledgerBusy:async()=>false});
  const due=()=>db.query("UPDATE evimed_product.jobs SET run_after=now()-interval '1 second' WHERE user_id=$1 AND kind='plugin-apply'",[owner]);
  await service.save(owner,p,{expectedRevision:0,enabled:false,settings:{timeoutMs:4000}});
  await worker.tick();assert.equal(starts,0);assert.equal((await service.get(owner,p)).phase,'pending');
  busy=false;await due();await worker.tick();
  assert.equal((await service.get(owner,p)).phase,'effective');assert.equal((await service.get(owner,p)).effective.revision,1);
  await service.save(owner,p,{expectedRevision:1,enabled:true,settings:{timeoutMs:5000}});failRevision=2;
  const restarted=new PluginApplyWorker({service:new PluginService(db),runtime,resolveProject:async()=>p,ledgerBusy:async()=>false});
  await restarted.tick();const failed=await service.get(owner,p);
  assert.equal(failed.phase,'rolled_back');assert.equal(failed.desired.revision,2);assert.equal(failed.effective.revision,1);assert.equal(current.revision,1);
  assert.deepEqual((await service.history(owner,p)).items.map(x=>x.revision),[2,1]);
  failRevision=null;await service.retry(owner,p);await restarted.tick();assert.equal((await service.get(owner,p)).effective.revision,2);
  await worker.close();await restarted.close();
});

test('an unacknowledged native prompt survives API restart and fences configuration apply', options, async()=>{
  await assert.rejects(service.withAdmission(project,async()=>{throw Error('connection dropped after send');},{prompt:true}),/connection dropped/);
  assert.equal(await new PluginService(db).hasPendingPrompts(project),true);
  await service.clearPromptAdmissions(project);
  assert.equal(await service.hasPendingPrompts(project),false);
});

test('nested runtime and prompt admission reuse one database connection without exhausting the pool', options, async()=>{
  const limited = new ControlPlaneDatabase({databaseUrl,databasePoolMax:1,databaseConnectionTimeoutMs:1000});
  const nested = new PluginService(limited);
  try {
    const result = await nested.withAdmission(project,()=>nested.withAdmission(project,()=>nested.get(owner,project),{prompt:true}));
    assert.equal(result.desired.revision,3);
    assert.equal(await nested.hasPendingPrompts(project),false);
  }finally{await limited.close();}
});

test('a project without a runtime stays saved until first launch is really probed, and a new generation is unverified', options, async()=>{
  const {PluginApplyWorker}=await import('../src/pluginApplyWorker.mjs');
  await db.query("UPDATE evimed_product.jobs SET status='canceled',lease_token=NULL,lease_expires_at=NULL WHERE kind='plugin-apply'");
  const p={id:'first-launch',userId:owner};await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'First launch',1000000)",[owner,p.id]);
  const scoped=new PluginService(db);let generation=null;let current=null;let probes=0;let starts=0;
  const runtime={runtimeGeneration:()=>generation,runtimePluginConfig:()=>current,pluginRuntimeBusy:async()=>false,
    replacePluginRuntime:async(_p,config)=>{starts++;current=config;generation=`launch-${starts}`;},
    probePlugin:async()=>{probes++;return{generation};},stop:async()=>{generation=null;}};
  scoped.runtimeGeneration=()=>generation;
  const worker=new PluginApplyWorker({service:scoped,runtime,resolveProject:async()=>p,ledgerBusy:async()=>false});
  await scoped.save(owner,p,{expectedRevision:0,enabled:true,settings:{timeoutMs:4000}});await worker.tick();
  assert.equal((await scoped.get(owner,p)).phase,'saved');assert.equal(probes,0);assert.equal(starts,0);
  generation='first';current=(await scoped.get(owner,p)).desired;await scoped.runtimeStarted(p);
  await db.query("UPDATE evimed_product.jobs SET run_after=now()-interval '1 second' WHERE user_id=$1 AND project_id=$2",[owner,p.id]);
  await worker.tick();assert.ok(probes>0);assert.equal((await scoped.get(owner,p)).effective.revision,1);
  generation=null;assert.equal((await scoped.get(owner,p)).effective,null);assert.equal((await scoped.get(owner,p)).phase,'saved');
  generation='another';assert.equal((await scoped.get(owner,p)).effective,null);
  await worker.close();
});

test('desired revision or lease loss while probing cannot publish stale effective state', options, async()=>{
  const {PluginApplyWorker}=await import('../src/pluginApplyWorker.mjs');
  for(const failure of ['revision','lease']){
    await db.query("UPDATE evimed_product.jobs SET status='canceled',lease_token=NULL,lease_expires_at=NULL WHERE kind='plugin-apply'");
    const p={id:`race-${failure}`,userId:owner};await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Race',1000000)",[owner,p.id]);
    const scoped=new PluginService(db);let generation='baseline';let current={revision:0,enabled:true,settings:{timeoutMs:15000}};
    const runtime={runtimeGeneration:()=>generation,runtimePluginConfig:()=>current,pluginRuntimeBusy:async()=>false,
      replacePluginRuntime:async(_p,config)=>{current=config;generation='candidate';},
      probePlugin:async(_p,config)=>{
        if(config.revision===1){
          if(failure==='revision')await scoped.save(owner,p,{expectedRevision:1,enabled:false,settings:{timeoutMs:5000}});
          else await db.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND project_id=$2 AND status='running'",[owner,p.id]);
        }
        return{generation};
      },stop:async()=>{generation=null;}};
    const worker=new PluginApplyWorker({service:scoped,runtime,resolveProject:async()=>p,ledgerBusy:async()=>false});
    await scoped.save(owner,p,{expectedRevision:0,enabled:true,settings:{timeoutMs:4000}});await worker.tick();
    const result=await scoped.get(owner,p);assert.equal(result.effective,null);assert.equal(result.desired.revision,failure==='revision'?2:1);
    assert.notEqual(result.phase,'effective');await worker.close();
  }
});

test('concurrent plugin retry and lease completion acquire job then document without a deadlock', { ...options, timeout: 10000 }, async()=>{
  await db.query("UPDATE evimed_product.jobs SET status='canceled',lease_token=NULL,lease_expires_at=NULL WHERE kind='plugin-apply'");
  const p={id:'retry-finish-order',userId:owner};
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Retry and finish',1000000)",[owner,p.id]);
  await service.save(owner,p,{expectedRevision:0,enabled:true,settings:{timeoutMs:4000}});
  const leased=await service.jobs.claim(['plugin-apply'],'retry-finish-worker',{leaseMs:30000});
  let enteredRetry,releaseRetry,enteredCompletion;
  const retryReachedEnqueue=new Promise(resolve=>{enteredRetry=resolve;});
  const resumeRetry=new Promise(resolve=>{releaseRetry=resolve;});
  const completionOwnsJob=new Promise(resolve=>{enteredCompletion=resolve;});
  const gated=new PluginService(db,{jobs:{enqueue:async(...args)=>{
    enteredRetry();await resumeRetry;return service.jobs.enqueue(...args);
  }}});
  const retry=gated.retry(owner,p);
  // Attach handlers before either operation can reject during deadlock detection.
  const outcomesPromise=Promise.allSettled([retry,(async()=>{
    await retryReachedEnqueue;
    return service.jobs.finishWithLease(owner,leased.id,leased.leaseToken,{phase:'effective'},async client=>{
      enteredCompletion();
      await client.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='plugin' AND id=$2 FOR UPDATE",[owner,projectPluginId(p.id)]);
      await client.query("UPDATE evimed_product.plugin_application_state SET phase='effective' WHERE user_id=$1 AND id=$2",[owner,projectPluginId(p.id)]);
    });
  })()]);
  await completionOwnsJob;releaseRetry();
  const outcomes=await outcomesPromise;
  assert.deepEqual(outcomes.map(outcome=>outcome.status==='fulfilled'?'fulfilled':outcome.reason.code),['fulfilled','fulfilled']);
  assert.equal((await service.jobs.get(owner,leased.id)).status,'queued');
  assert.equal((await service.get(owner,p)).phase,'pending');
  assert.equal((await service.history(owner,p)).items.length,1);
});

test('a save during retry revision discovery rolls back stale job rearming', { ...options, timeout: 10000 }, async()=>{
  await db.query("UPDATE evimed_product.jobs SET status='canceled',lease_token=NULL,lease_expires_at=NULL WHERE kind='plugin-apply'");
  const p={id:'retry-save-order',userId:owner};
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Retry and save',1000000)",[owner,p.id]);
  await service.save(owner,p,{expectedRevision:0,enabled:true,settings:{timeoutMs:4000}});
  const leased=await service.jobs.claim(['plugin-apply'],'retry-save-worker',{leaseMs:30000});
  await service.jobs.fail(owner,leased.id,leased.leaseToken,{code:'fixture_failure',message:'Fixture failed apply.'});
  let enteredRetry,releaseRetry;
  const retryReachedEnqueue=new Promise(resolve=>{enteredRetry=resolve;});
  const resumeRetry=new Promise(resolve=>{releaseRetry=resolve;});
  const gated=new PluginService(db,{jobs:{enqueue:async(...args)=>{
    enteredRetry();await resumeRetry;return service.jobs.enqueue(...args);
  }}});
  const retry=gated.retry(owner,p).then(value=>({value}),error=>({error}));
  await retryReachedEnqueue;
  try { await service.save(owner,p,{expectedRevision:1,enabled:false,settings:{timeoutMs:5000}}); }
  finally { releaseRetry(); }
  const result=await retry;
  assert.equal(result.error?.code,'product_revision_conflict');
  assert.equal((await service.jobs.get(owner,leased.id)).status,'failed','stale rearm must roll back inside the transaction');
  assert.deepEqual((await service.get(owner,p)).desired,{revision:2,enabled:false,settings:{timeoutMs:5000}});
  assert.equal((await service.get(owner,p)).phase,'pending');
  assert.deepEqual((await service.history(owner,p)).items.map(item=>item.revision),[2,1]);
});
