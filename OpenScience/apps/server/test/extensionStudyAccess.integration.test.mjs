import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionOperationService } from '../src/extensionOperationService.mjs';
import { test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ExtensionAccess } from '../src/extensionAccess.mjs';
import { VcrStore } from '../src/vcrStore.mjs';
import { VcrDataStore } from '../src/vcrDataStore.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
test('real study roles retain original actor and revocation serializes with extension writes', { skip: !url }, async () => {
  const isolated = await createGeoTestDatabase(url, 'extstudy');
  const db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5000 });
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'extension-study-operations-'));
  try {
    await db.migrate();
    const studies = new VcrStore({ database: db }), members = new VcrDataStore({ database: db });
    await studies.ready();
    await db.query("INSERT INTO evimed_control.users(id,name,auth_type) SELECT id,id,'development' FROM unnest($1::text[]) id", [['owner','lead','viewer','data','site','foreign']]);
    await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('owner','shared','Shared',1048576),('foreign','ordinary','Ordinary',1048576)");
    const study = await studies.createStudy({ userId: 'owner', projectId: 'shared', name: 'Shared' });
    for (const [userId, role] of [['lead','lead'],['viewer','viewer'],['data','data_manager'],['site','site']]) await members.addMember({ studyId: study.id, userId, role });
    const store = { database: db, userById: async id => ({ id }), requireProject: async (actor,id) => {
      const row = (await db.query('SELECT id,user_id FROM evimed_control.projects WHERE user_id=$1 AND id=$2', [actor.id,id])).rows[0];
      if (!row) throw Object.assign(new Error('Absent'), { status: 404 });
      return { id: row.id, userId: row.user_id };
    } };
    const access = new ExtensionAccess({ store, studyAccess: async (actor,id,{client}) => {
      const current = await studies.studyByControlProject(actor.id,id,client);
      if (!current) return null;
      const authority=await members.membershipAuthority(current.id,actor.id,client);return { ownerId: current.userId, roles: current.userId === actor.id ? ['lead'] : authority.roles,epoch:current.userId===actor.id?null:authority.epoch };
    } });
    for (const id of ['owner','lead','viewer','data']) assert.equal((await access.project({id},'shared')).userId,'owner');
    for (const id of ['viewer','data','site']) await assert.rejects(access.project({id},'shared',{manage:true}), { status:403 });
    await access.project({id:'data'},'shared',{ability:'write'});
    await assert.rejects(access.project({id:'viewer'},'shared',{ability:'write'}),{status:403});
    await assert.rejects(access.project({id:'site'},'shared'),{status:403});
    await assert.rejects(access.project({id:'foreign'},'shared'),{status:404});
    assert.equal((await access.project({id:'foreign'},'ordinary',{manage:true})).userId,'foreign');
    await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('viewer','shared','Own Shared',1048576)");
    assert.equal((await access.project({id:'viewer'},'shared',{manage:true})).userId,'viewer');
    await db.query("DELETE FROM evimed_control.projects WHERE user_id='viewer' AND id='shared'");
    const other = await studies.createStudy({userId:'foreign',projectId:'shared',name:'Other Shared'});
    await members.addMember({studyId:other.id,userId:'viewer',role:'viewer'});
    await assert.rejects(access.project({id:'viewer'},'shared'),{status:404});
    await members.removeMember({studyId:other.id,userId:'viewer',role:'viewer'});
    const generations={extensions:{access},operationIdentity:async(actor,id,_descriptor,runtime,operation)=>{
      const project=await access.project(actor,id,{ability:operation==='doc_write'?'write':'read'});
      const accountCreatedAt=(await db.query('SELECT created_at::text epoch FROM evimed_control.users WHERE id=$1',[actor.id])).rows[0].epoch;
      const ownerAccountCreatedAt=(await db.query('SELECT created_at::text epoch FROM evimed_control.users WHERE id=$1',[project.userId])).rows[0].epoch;
      const projectCreatedAt=(await db.query('SELECT created_at::text epoch FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[project.userId,id])).rows[0].epoch;
      return {userId:actor.id,ownerId:project.userId,accountCreatedAt,ownerAccountCreatedAt,membershipEpoch:project.extensionMembershipEpoch??null,projectId:id,projectCreatedAt,runtimeGeneration:runtime,
        extensionGenerationHash:'a'.repeat(64),descriptorId:'fixture',artifactDigest:'sha256:'+'b'.repeat(64),installationId:'fixture-install',installationRevision:1};
    }};
    const operations=new ExtensionOperationService({database:db,dataDir:root,signingSecret:'local-owned-study-test-signing-secret-32',generations,
      resolveInvocation:async(auth,_invocation,request)=>({userId:auth.userId,projectId:auth.projectId,runtimeGeneration:auth.runtimeGeneration,invocationId:auth.invocation,allowedOperations:[request.operation]}),
      resources:{snapshot:async(_scope,id)=>({resourceId:id,format:'pdf',dataClass:'public',bytes:Buffer.from('safe public synthetic fixture')})},controller:{admissionAvailable:async()=>true}});
    const auth={userId:'viewer',projectId:'shared',runtimeGeneration:'fixture-runtime',invocation:'original'};
    const request={operation:'doc_read',resourceId:'public-fixture'};
    const first=await operations.submit(auth,{descriptorId:'fixture',request,idempotencyKey:'first'});
    const original=await operations.jobs.get('owner',first.jobId);
    await members.removeMember({studyId:study.id,userId:'viewer',role:'viewer'});
    await assert.rejects(operations.status(auth,first.jobId));
    await members.addMember({studyId:study.id,userId:'viewer',role:'viewer'});
    await assert.rejects(operations.status(auth,first.jobId),{status:403});
    await assert.rejects(operations.markDispatch(original),{status:403});
    const fresh=await operations.submit({...auth,invocation:'renewed'},{descriptorId:'fixture',request,idempotencyKey:'second'});
    assert.notEqual((await operations.jobs.get('owner',fresh.jobId)).payload.scope.membershipEpoch,original.payload.scope.membershipEpoch);
    let release, acquired;
    const held = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { acquired = resolve; });
    const authorization = db.transaction(client => db.withTransactionClient(client, async () => {
      await access.project({id:'lead'},'shared',{manage:true,client}); acquired(); await held;
    }));
    await ready;
    let removed = false;
    const revocation = members.removeMember({studyId:study.id,userId:'lead',role:'lead'}).then(() => { removed=true; });
    // A separate client proves the revoke is waiting on the real held study row.
    for (let i=0;i<100;i++) {
      const waiting = (await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n;
      if (waiting) break;
      await new Promise(resolve=>setTimeout(resolve,5));
      if (i===99) assert.fail('revocation did not wait for authorization');
    }
    assert.equal(removed,false); release(); await authorization; await revocation;
    await assert.rejects(access.project({id:'lead'},'shared',{manage:true}),{status:404});
    assert.equal((await access.project({id:'viewer'},'shared')).userId,'owner');
  } catch(error) { process.stderr.write(String(error.stack)+"\n"); throw error; } finally { await db.close(); await isolated.drop();await fs.rm(root,{recursive:true,force:true}); }
});
