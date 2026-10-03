import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { EXTENSION_PRODUCT_KINDS, EXTENSION_JOB_KINDS } from '@evimed/domain';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments, ProductJobs } from '../src/productStore.mjs';
import { PRODUCT_KINDS, PRODUCT_JOB_KINDS, migrateProductStore } from '../src/productPersistence.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) {
  const parsed = new URL(url);
  assert(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname));
  assert.match(parsed.pathname,/evimed_test/);
}
const options = {skip:!url && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured'};
const owner=`ext_${randomUUID()}`,other=`ext_${randomUUID()}`;
let database,documents,jobs;
before(async()=>{
  if(!url)return;
  database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Extension fixture','development'),($2,'Other fixture','development')",[owner,other]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'p1','Extension fixture',1048576)",[owner]);
  documents=new ProductDocuments(database);jobs=new ProductJobs(database);
});
after(async()=>{if(database){await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[owner,other]]);await database.close();}});

test('new extension vocabulary retains all existing product kinds',()=>{
  for(const kind of EXTENSION_PRODUCT_KINDS)assert(PRODUCT_KINDS.includes(kind));
  for(const kind of EXTENSION_JOB_KINDS)assert(PRODUCT_JOB_KINDS.includes(kind));
  for(const kind of ['plugin','method','capsule','source','document-export'])assert(PRODUCT_KINDS.includes(kind));
});
test('upgrading legacy constraints twice preserves citation history and admits every new kind',options,async()=>{
  const citation=await documents.put(owner,'plugin','project:p1:dsh-cite',{enabled:true,settings:{timeoutMs:15000}},{expectedRevision:0,projectId:'p1'});
  await documents.put(owner,'plugin',citation.id,{enabled:false,settings:{timeoutMs:5000}},{expectedRevision:1,projectId:'p1'});
  const historyBefore=await documents.history(owner,'plugin',citation.id);
  const oldKinds=PRODUCT_KINDS.filter(kind=>!EXTENSION_PRODUCT_KINDS.includes(kind));
  const oldJobs=PRODUCT_JOB_KINDS.filter(kind=>!EXTENSION_JOB_KINDS.includes(kind));
  await database.query(`ALTER TABLE evimed_product.documents DROP CONSTRAINT product_documents_kind_check;
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check CHECK(kind IN (${oldKinds.map(k=>`'${k}'`).join(',')}));
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK(kind IN (${oldJobs.map(k=>`'${k}'`).join(',')}));`);
  // Different wrappers exercise actual DDL twice rather than the per-instance promise cache.
  for(let i=0;i<2;i++)await migrateProductStore({transaction:operation=>database.transaction(operation)});
  assert.deepEqual(await documents.history(owner,'plugin',citation.id),historyBefore);
  for(const kind of EXTENSION_PRODUCT_KINDS){
    const saved=await documents.put(owner,kind,`fixture-${kind}`,{fixture:true},{expectedRevision:0});
    assert.equal(saved.revision,1);assert.equal(await documents.get(other,kind,saved.id),null);
  }
  const counts=await database.query("SELECT count(*)::integer AS n FROM evimed_product.schema_migrations WHERE name='2026-10-02-extension-center-kinds-v1'");
  assert.equal(counts.rows[0].n,1);
});
test('extension preparation keeps CAS, idempotency, lease and tenant boundaries',options,async()=>{
  const saved=await documents.put(owner,'skill','skill-fixture',{title:'first'},{expectedRevision:0});
  const results=await Promise.allSettled(['second','third'].map(title=>documents.put(owner,'skill',saved.id,{title},{expectedRevision:1})));
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(results.find(row=>row.status==='rejected').reason.code,'product_revision_conflict');
  const payload={installationId:'fixture-extension-installation'};
  const a=await jobs.enqueue(owner,'extension-prepare',payload,{idempotencyKey:'prepare-fixture',projectId:'p1'});
  const b=await jobs.enqueue(owner,'extension-prepare',payload,{idempotencyKey:'prepare-fixture',projectId:'p1'});
  assert.equal(a.id,b.id);
  const leases=await Promise.all(['a','b'].map(worker=>jobs.claim(['extension-prepare'],worker,{leaseMs:1000})));
  assert.equal(leases.filter(Boolean).length,1);const lease=leases.find(Boolean);
  assert.equal(await jobs.get(other,lease.id),null);
  await jobs.cancel(owner,lease.id);
  await assert.rejects(jobs.finish(owner,lease.id,lease.leaseToken,{}),{code:'product_job_lease_lost'});
});
