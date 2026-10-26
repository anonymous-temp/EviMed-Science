import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { archiveRecruitment, archiveDigest, forgetErased, loadArchive, retireRecruitment, restoreRecruitment, retirementError, verifyArchiveReadback } from '../vcr-retire-recruitment.mjs';
import { decryptArchiveBuffer } from '../archive-crypto.mjs';
import { migrateVcr } from '../../../apps/server/src/vcrPersistence.mjs';
import { VcrErasureStore } from '../../../apps/server/src/vcrErasureStore.mjs';
import { deleteVcrUserRows } from '../../../apps/server/src/vcrStoreBase.mjs';
import { createGeoTestDatabase } from '../../../apps/server/test/helpers/geoTestDatabase.mjs';
const require = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const { Client } = require('pg');
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured' };
let isolated, client, directory, file, meta, archive, erasure;
const database = () => ({ async transaction(work) { await client.query('BEGIN'); try { const result=await work(client); await client.query('COMMIT');return result; } catch(error) { await client.query('ROLLBACK');throw error; } } });
const destructive = () => ({ workersStopped: true, allowDropApprovedTables: true, allowDeleteRetiredMembers: true, allowRestoreApprovedTables: true, expectedDatabase: meta.databaseIdentity });
const withdraw = subjectKey => erasure.withdrawSubject({ studyId:'std_retire',userId:'owner',actor:'owner',subjectKey });
before(async () => {
  if (!url) return;
  const parsed=new URL(url); assert.equal(parsed.hostname,'127.0.0.1'); assert.equal(parsed.port,'58473'); assert.equal(parsed.username,'vcr_test'); assert.match(parsed.pathname,/^\/evimed_test/);
  isolated=await createGeoTestDatabase(url,'vcrretire');client=new Client({connectionString:isolated.url,lock_timeout:3000,statement_timeout:10000});await client.connect();
  await isolated.close(); // Destructive commands must see only this test connection.
  directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'vcr-retirement-')));await fs.chmod(directory,0o700);file=path.join(directory,'archive.enc');
  process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE=randomBytes(32).toString('base64');
  await client.query(await fs.readFile(new URL('./fixtures/vcr-production-base-1a799c2db.sql',import.meta.url),'utf8'));
  await client.query(`INSERT INTO evimed_vcr.studies(id,project_id,user_id,name) VALUES ('std_retire','project_retire','owner','Research');
    INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES ('std_retire','old_recruiter','recruiter'),('std_retire','old_site','site'),('std_retire','researcher','data_manager'),('std_retire','erased_before','recruiter');
    INSERT INTO evimed_vcr.protocol_versions(id,study_id,user_id,version) VALUES('pro_retire','std_retire','owner',1);
    INSERT INTO evimed_vcr.criteria(id,study_id,protocol_version_id,user_id,ordinal,kind,criterion_type) VALUES('cri_retire','std_retire','pro_retire','owner',1,'inclusion','lab');
    INSERT INTO evimed_vcr.matching_assessments(id,study_id,user_id,subject_key) VALUES('ass_retire','std_retire','owner','SYNTHETIC_1');
    INSERT INTO evimed_vcr.sources(id,study_id,user_id,name) VALUES('src_retire','std_retire','owner','Research data');
    INSERT INTO evimed_vcr.grants(id,source_id,study_id,user_id,grantee,role,revoked_at) VALUES
      ('gr_live','src_retire','std_retire','owner','role:recruiter','recruiter',NULL),('gr_revoked','src_retire','std_retire','owner','role:site','site',now());
    INSERT INTO evimed_vcr.sites(id,study_id,user_id,name,contacts) VALUES('site_old','std_retire','owner','Synthetic site','[{"synthetic":"private contact","exact_integer":9007199254740993,"exact_decimal":0.12345678901234567890123456789}]');
    ALTER TABLE evimed_vcr.sites ADD COLUMN historic_interval interval NOT NULL DEFAULT interval '2 months 3 days 04:05:06.123456';
    INSERT INTO evimed_vcr.referrals(id,study_id,site_id,user_id,subject_key,state,assessment_id,contact_approved_by,screen_fail_criterion_id,screen_fail_reason) VALUES
      ('ref_old','std_retire','site_old','owner','SYNTHETIC_1','contacted','ass_retire','approver',NULL,NULL),
      ('ref_failed','std_retire','site_old','owner','SYNTHETIC_2','screen_failed',NULL,'approver','cri_retire','synthetic failed criterion'),
      ('ref_withdraw','std_retire','site_old','owner','WITHDRAW_BEFORE','contacted',NULL,'approver',NULL,NULL);
    INSERT INTO evimed_vcr.referral_events(id,referral_id,user_id,to_state,note) VALUES
      ('evt_old','ref_old','owner','contacted','synthetic history'),('evt_failed','ref_failed','owner','screen_failed','failed patient private note'),('evt_withdraw','ref_withdraw','owner','contacted','withdrawn private note');
    INSERT INTO evimed_vcr.followup_episodes(id,study_id,user_id,subject_key,kind,observations) VALUES('fup_old','std_retire','owner','SYNTHETIC_1','routine_care','[{"value":42}]');`);
  await migrateVcr(database());
  erasure=new VcrErasureStore({database:database()});
  await database().transaction(c=>deleteVcrUserRows(c,'erased_before'));
});
after(async () => { delete process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE;await client?.end();await isolated?.drop();if(directory)await fs.rm(directory,{recursive:true,force:true}); });
test('production base upgrade preserves OA, mixed legacy roles and historical observations; prevents new legacy roles',options,async()=>{
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.referrals')).rows[0].n,3);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM evimed_vcr.members WHERE role IN ('site','recruiter')")).rows[0].n,2);
  await assert.rejects(client.query("INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES('std_retire','new','recruiter')"),{code:'23514'});
  assert.equal((await client.query("SELECT convalidated FROM pg_constraint WHERE conname='vcr_members_active_roles'")).rows[0].convalidated,false);
});
test('a referral-only subject withdraws before retirement, with a terminal update and no contact/event side effects',options,async()=>{
  const result=await withdraw('WITHDRAW_BEFORE');assert.ok(result);assert.equal(result.counts.files,0);
  assert.equal((await client.query("SELECT state FROM evimed_vcr.referrals WHERE id='ref_withdraw'")).rows[0].state,'withdrawn');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.referral_events')).rows[0].n,3);
  assert.ok(await withdraw('WITHDRAW_BEFORE'));assert.equal(await withdraw('NEVER_HEARD_OF'),null);
});
test('encrypted archive verifies decrypt-back and preserves raw PostgreSQL precision, full DDL, defaults, NOT VALID checks and partial index',options,async()=>{
  await client.query("SET TimeZone='Asia/Shanghai';SET DateStyle='SQL, DMY';SET IntervalStyle='sql_standard'");
  meta=await archiveRecruitment(client,file);archive=await loadArchive(file,meta.sha256);
  assert.deepEqual(meta.settings,{TimeZone:'UTC',DateStyle:'ISO, MDY',IntervalStyle:'postgres'});
  const ciphertext=await fs.readFile(file),plaintext=await decryptArchiveBuffer(ciphertext);
  assert.equal(archiveDigest(ciphertext),meta.sha256);assert.equal(archiveDigest(plaintext),meta.plaintextSha256);
  assert.doesNotMatch(ciphertext.toString('utf8'),/private contact|SYNTHETIC_1|synthetic history/);
  assert.doesNotMatch(plaintext.toString('utf8'),/WITHDRAW_BEFORE|withdrawn private note|erased_before/);
  assert.equal((await fs.stat(file)).mode & 0o777,0o600);assert.equal((await fs.stat(`${file}.meta.json`)).mode & 0o777,0o600);
  assert.deepEqual(meta.counts,{sites:1,referrals:2,referral_events:2});assert.equal(meta.retiredMembers,2);
  assert.doesNotMatch(JSON.stringify(meta),/private contact|SYNTHETIC_1|old_recruiter/);
  assert.match(archive.snapshot.tables.sites.rows[0],/9007199254740993/);assert.match(archive.snapshot.tables.sites.rows[0],/0\.12345678901234567890123456789/);
  await client.query("SET TimeZone='UTC';SET DateStyle='ISO, MDY';SET IntervalStyle='postgres'");
  const sourceJson=(await client.query('SELECT to_jsonb(t)::text AS row FROM evimed_vcr.sites t')).rows[0].row;
  assert.equal(archive.snapshot.tables.sites.rows[0],sourceJson);
  assert.ok(archive.snapshot.tables.referrals.constraints.some(c=>c.name==='vcr_referrals_contact_needs_approval'&&c.definition.endsWith('NOT VALID')));
  assert.ok(archive.snapshot.tables.referrals.indexes.some(i=>i.name==='vcr_referrals_live_subject'&&i.definition.includes('WHERE')));
  await client.query('BEGIN');assert.equal(await verifyArchiveReadback(client,archive),true);await client.query('ROLLBACK');
});
test('authentication, tamper, broad permissions, cross-database and missing flags refuse without mutation',options,async()=>{
  await assert.rejects(loadArchive(file,'0'.repeat(64)),{code:'vcr_retirement_archive_hash_mismatch'});
  await fs.chmod(file,0o644);await assert.rejects(loadArchive(file,meta.sha256),{code:'vcr_retirement_archive_permissions'});await fs.chmod(file,0o600);
  const bytes=await fs.readFile(file);const tampered=Buffer.from(bytes);tampered[tampered.length-1]^=1;
  const bad=path.join(directory,'bad.enc');await fs.writeFile(bad,tampered,{mode:0o600});
  await assert.rejects(loadArchive(bad,archiveDigest(tampered)),{code:'vcr_retirement_archive_authentication_failed'});
  await assert.rejects(retireRecruitment(client,archive,{}),{code:'vcr_retirement_destructive_flags_required'});
  await assert.rejects(retireRecruitment(client,archive,{...destructive(),expectedDatabase:'wrong'}),{code:'vcr_retirement_database_confirmation_required'});
  const other=structuredClone(archive);other.snapshot.identity.database_oid='999999';other.snapshotDigest=archiveDigest(other.snapshot);
  await assert.rejects(retireRecruitment(client,other,{...destructive(),expectedDatabase:archiveDigest(other.snapshot.identity)}),{code:'vcr_retirement_database_changed'});
  const safe=retirementError(Object.assign(new Error('patient value'),{code:'42501',detail:'private row'}));
  assert.deepEqual({code:safe.code,sqlState:safe.sqlState},{code:'vcr_retirement_failed',sqlState:'42501'});assert.equal(safe.message,'vcr_retirement_failed');assert.equal(safe.detail,undefined);
});
test('changes, other clients and unapproved dependencies refuse and roll back; SQLSTATE survives without database messages',options,async()=>{
  await client.query("UPDATE evimed_vcr.referral_events SET note='changed' WHERE id='evt_old'");
  await assert.rejects(retireRecruitment(client,archive,destructive()),{code:'vcr_retirement_data_changed'});
  await client.query("UPDATE evimed_vcr.referral_events SET note='synthetic history' WHERE id='evt_old'");
  const peer=new Client({connectionString:isolated.url});await peer.connect();
  try{await assert.rejects(retireRecruitment(client,archive,destructive()),{code:'vcr_retirement_other_database_clients'});}finally{await peer.end();}
  await client.query('CREATE TABLE evimed_vcr.unapproved_dependency(referral_id text REFERENCES evimed_vcr.referrals(id))');
  try{
    await assert.rejects(retireRecruitment(client,archive,destructive()),{code:'vcr_retirement_failed',sqlState:'2BP01'});
    assert.equal((await client.query("SELECT count(*)::int AS n FROM evimed_vcr.members WHERE role IN ('recruiter','site')")).rows[0].n,2);
  }finally{await client.query('DROP TABLE evimed_vcr.unapproved_dependency');}
});
test('archive capture releases locks before readback; a concurrent first-task studies→members writer finishes without deadlock',options,async()=>{
  const peer=new Client({connectionString:isolated.url,statement_timeout:3000,lock_timeout:2000});await peer.connect();
  let launched=false,writer;
  const wrapped={async query(sql,params){const result=await client.query(sql,params);
    if(!launched&&String(sql).startsWith('LOCK TABLE evimed_vcr.members')){
      launched=true;writer=(async()=>{await peer.query('BEGIN');await peer.query("INSERT INTO evimed_vcr.studies(id,user_id,project_id,name) VALUES('std_concurrent','owner','project_concurrent','Concurrent task')");await peer.query("INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES('std_concurrent','owner','lead')");await peer.query('COMMIT');})();
    }
    if(String(sql)==='COMMIT'&&writer)await writer;
    return result;
  }};
  try{await archiveRecruitment(wrapped,path.join(directory,'concurrent.enc'));assert.equal(launched,true);await writer;}
  finally{await peer.query('ROLLBACK');await peer.end();await client.query("DELETE FROM evimed_vcr.studies WHERE id='std_concurrent'");}
});
test('retire is timezone-independent, idempotent and preserves research; real restore reproduces schema and historical roles without granting new legacy roles',options,async()=>{
  await client.query("SET TimeZone='America/New_York';SET DateStyle='German, DMY';SET IntervalStyle='iso_8601'");
  const result=await retireRecruitment(client,archive,destructive());assert.equal(result.retired,true);assert.equal(result.alreadyRetired,false);
  assert.equal((await retireRecruitment(client,archive,destructive())).alreadyRetired,true);
  assert.equal((await client.query('SELECT observations FROM evimed_vcr.followup_episodes')).rows[0].observations[0].value,42);
  await migrateVcr(database());assert.equal((await client.query("SELECT to_regclass('evimed_vcr.referrals') AS t")).rows[0].t,null);
  assert.equal((await restoreRecruitment(client,archive,destructive())).restored,true);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.referrals')).rows[0].n,2);
  assert.deepEqual((await client.query("SELECT user_id,role FROM evimed_vcr.members WHERE role IN ('recruiter','site') ORDER BY role")).rows,[{user_id:'old_recruiter',role:'recruiter'},{user_id:'old_site',role:'site'}]);
  assert.equal((await client.query("SELECT convalidated FROM pg_constraint WHERE conname='vcr_members_active_roles'")).rows[0].convalidated,false);
  await assert.rejects(client.query("INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES('std_retire','new','site')"),{code:'23514'});
  await assert.rejects(client.query("UPDATE evimed_vcr.members SET detail='{}' WHERE user_id='old_site'"),{code:'23514'});
  assert.equal((await client.query("SELECT convalidated FROM pg_constraint WHERE conname='vcr_referrals_contact_needs_approval'")).rows[0].convalidated,false);
  assert.ok((await client.query("SELECT indexdef FROM pg_indexes WHERE indexname='vcr_referrals_live_subject'")).rows[0].indexdef.includes('WHERE'));
  await assert.rejects(restoreRecruitment(client,archive,destructive()),{code:'vcr_retirement_restore_conflict'});
  await client.query("INSERT INTO evimed_vcr.sites(id,user_id,name) VALUES('default_probe','owner','Default probe')");
  assert.equal((await client.query("SELECT contacts,historic_interval::text AS interval FROM evimed_vcr.sites WHERE id='default_probe'")).rows[0].contacts.length,0);
  await client.query("DELETE FROM evimed_vcr.sites WHERE id='default_probe'");
  assert.equal((await retireRecruitment(client,archive,destructive())).retired,true);
});
test('post-retirement referral-only withdrawal and account erasure require a re-seal before any restore; re-seal cannot resurrect either',options,async()=>{
  assert.ok(await withdraw('SYNTHETIC_2'),'hash-only footprint recognizes an archived-only subject');
  await database().transaction(c=>deleteVcrUserRows(c,'old_site'));
  await assert.rejects(restoreRecruitment(client,archive,destructive()),{code:'vcr_retirement_forget_erased_required'});
  const resealedFile=path.join(directory,'resealed.enc');const resealedMeta=await forgetErased(client,archive,resealedFile);const resealed=await loadArchive(resealedFile,resealedMeta.sha256);
  const text=JSON.stringify(resealed.snapshot);assert.doesNotMatch(text,/SYNTHETIC_2|failed patient private note|old_site/);
  assert.deepEqual(resealedMeta.counts,{sites:1,referrals:1,referral_events:1});assert.equal(resealedMeta.retiredMembers,1);
  await restoreRecruitment(client,resealed,destructive());
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.referrals')).rows[0].n,1);
  assert.equal((await retireRecruitment(client,resealed,destructive())).retired,true);
});
