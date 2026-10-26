import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { archiveRecruitment, archiveDigest, loadArchive, retireRecruitment, verifyArchiveReadback } from '../vcr-retire-recruitment.mjs';
import { migrateVcr } from '../../../apps/server/src/vcrPersistence.mjs';
import { createGeoTestDatabase } from '../../../apps/server/test/helpers/geoTestDatabase.mjs';
const require = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const { Client } = require('pg');
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured' };
let isolated, client, directory, file, meta, archive;
const database = () => ({ async transaction(work) { await client.query('BEGIN'); try { const result=await work(client); await client.query('COMMIT');return result; } catch(error) { await client.query('ROLLBACK');throw error; } } });
const destructive = () => ({ workersStopped: true, allowDropApprovedTables: true, allowDeleteRetiredMembers: true, expectedDatabase: meta.databaseIdentity });
before(async () => {
  if (!url) return;
  const parsed=new URL(url); assert.ok(['127.0.0.1','localhost','::1'].includes(parsed.hostname));assert.match(parsed.pathname,/evimed_test/);
  isolated=await createGeoTestDatabase(url,'vcrretire');client=new Client({connectionString:isolated.url});await client.connect();
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-retirement-'));await fs.chmod(directory,0o700);file=path.join(directory,'archive.json');
  await migrateVcr(database());
  await client.query(`INSERT INTO evimed_vcr.studies(id,project_id,user_id,name) VALUES ('std_retire','project_retire','owner','Research');
    ALTER TABLE evimed_vcr.members DROP CONSTRAINT members_role_check;
    ALTER TABLE evimed_vcr.members DROP CONSTRAINT vcr_members_active_roles;
    INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES ('std_retire','old_recruiter','recruiter'),('std_retire','old_site','site'),('std_retire','researcher','data_manager');
    CREATE TABLE evimed_vcr.sites(id text PRIMARY KEY,study_id text REFERENCES evimed_vcr.studies(id), contacts jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE evimed_vcr.referrals(id text PRIMARY KEY,study_id text REFERENCES evimed_vcr.studies(id),site_id text REFERENCES evimed_vcr.sites(id),subject_key text NOT NULL,state text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE evimed_vcr.referral_events(id text PRIMARY KEY,referral_id text REFERENCES evimed_vcr.referrals(id),note text NOT NULL);
    CREATE UNIQUE INDEX vcr_referrals_one_active ON evimed_vcr.referrals(subject_key) WHERE state <> 'withdrawn';
    INSERT INTO evimed_vcr.sites(id,study_id,contacts) VALUES('site_old','std_retire','[{"synthetic":"private contact","exact_integer":9007199254740993,"exact_decimal":0.12345678901234567890123456789}]');
    INSERT INTO evimed_vcr.referrals(id,study_id,site_id,subject_key,state) VALUES('ref_old','std_retire','site_old','SYNTHETIC_1','enrolled');
    INSERT INTO evimed_vcr.referral_events VALUES('evt_old','ref_old','synthetic history');
    INSERT INTO evimed_vcr.followup_episodes(id,study_id,user_id,subject_key,kind,observations) VALUES('fup_old','std_retire','owner','SYNTHETIC_1','routine_care','[{"value":42}]');`);
});
after(async () => { await client?.end();await isolated?.close();if(directory)await fs.rm(directory,{recursive:true,force:true}); });
test('startup preserves existing legacy rows and tables; active checks refuse new retired memberships', options, async () => {
  await migrateVcr(database());
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.referrals')).rows[0].n,1);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM evimed_vcr.members WHERE role IN ('site','recruiter')")).rows[0].n,2);
  await assert.rejects(client.query("INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES('std_retire','new','recruiter')"),{code:'23514'});
  assert.equal((await client.query("SELECT convalidated FROM pg_constraint WHERE conname='vcr_members_active_roles'")).rows[0].convalidated,false);
});
test('private archive includes full rows/schema/roles, metadata contains counts only, typed restore/readback succeeds', options, async () => {
  meta=await archiveRecruitment(client,file);archive=await loadArchive(file,meta.sha256);
  assert.equal((await fs.stat(file)).mode & 0o777,0o600);assert.equal((await fs.stat(`${file}.meta.json`)).mode & 0o777,0o600);
  assert.deepEqual(meta.counts,{sites:1,referrals:1,referral_events:1});assert.equal(meta.retiredMembers,2);
  assert.doesNotMatch(JSON.stringify(meta),/private contact|SYNTHETIC_1|old_recruiter/);
  assert.equal(JSON.parse(archive.snapshot.tables.sites.rows[0]).contacts[0].synthetic,'private contact');
  assert.match(archive.snapshot.tables.sites.rows[0], /9007199254740993/);
  assert.match(archive.snapshot.tables.sites.rows[0], /0\.12345678901234567890123456789/);
  const sourceJson = (await client.query('SELECT to_jsonb(t)::text AS row FROM evimed_vcr.sites t')).rows[0].row;
  assert.equal(archive.snapshot.tables.sites.rows[0], sourceJson);
  await client.query('BEGIN');assert.equal(await verifyArchiveReadback(client,archive),true);await client.query('ROLLBACK');
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'vcr_retirement_verify_%'")).rows[0].n,0);
});
test('hash mismatch, broad permissions and missing destructive flags refuse before any deletion', options, async () => {
  await assert.rejects(loadArchive(file,'0'.repeat(64)),{code:'vcr_retirement_archive_hash_mismatch'});
  await fs.chmod(file,0o644);await assert.rejects(loadArchive(file,meta.sha256),{code:'vcr_retirement_archive_permissions'});await fs.chmod(file,0o600);
  await assert.rejects(retireRecruitment(client,archive,{}),{code:'vcr_retirement_destructive_flags_required'});
  await assert.rejects(retireRecruitment(client,archive,{...destructive(),expectedDatabase:'wrong'}),{code:'vcr_retirement_database_confirmation_required'});
});
test('changed rows or another live database client refuse retirement and retain every approved object', options, async () => {
  await client.query("UPDATE evimed_vcr.referral_events SET note='changed' WHERE id='evt_old'");
  await assert.rejects(retireRecruitment(client,archive,destructive()),{code:'vcr_retirement_data_changed'});
  await client.query("UPDATE evimed_vcr.referral_events SET note='synthetic history' WHERE id='evt_old'");
  const peer=new Client({connectionString:isolated.url});await peer.connect();
  try {await assert.rejects(retireRecruitment(client,archive,destructive()),{code:'vcr_retirement_other_database_clients'});}finally {await peer.end();}
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.referral_events')).rows[0].n,1);
});
test('a writer that commits between admission and source locking is detected after the locks', options, async () => {
  let injected = false;
  const interleaved = { async query(sql, params) {
    const result = await client.query(sql, params);
    if (!injected && String(sql).startsWith('LOCK TABLE evimed_vcr."sites"')) {
      injected = true;
      const peer = new Client({ connectionString: isolated.url }); await peer.connect();
      try { await peer.query("UPDATE evimed_vcr.referral_events SET note='late committed event' WHERE id='evt_old'"); }
      finally { await peer.end(); }
    }
    return result;
  } };
  try {
    await assert.rejects(retireRecruitment(interleaved, archive, destructive()), { code: 'vcr_retirement_data_changed' });
    assert.equal(injected, true);
    assert.equal((await client.query("SELECT note FROM evimed_vcr.referral_events WHERE id='evt_old'")).rows[0].note, 'late committed event');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM evimed_vcr.members WHERE role IN ('recruiter','site')")).rows[0].n, 2);
  } finally { await client.query("UPDATE evimed_vcr.referral_events SET note='synthetic history' WHERE id='evt_old'"); }
});
test('an unapproved incoming dependency refuses RESTRICT drop and rolls retired memberships back', options, async()=>{
 await client.query('CREATE TABLE evimed_vcr.unapproved_dependency(referral_id text REFERENCES evimed_vcr.referrals(id))');
 try {
  await assert.rejects(retireRecruitment(client,archive,destructive()),{code:'2BP01'});
  assert.equal((await client.query("SELECT count(*)::int AS n FROM evimed_vcr.members WHERE role IN ('recruiter','site')")).rows[0].n,2);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.referrals')).rows[0].n,1);
 }finally {await client.query('DROP TABLE evimed_vcr.unapproved_dependency');}
});
test('verified retirement drops only approved three tables and member roles; historical followup/research remain', options, async () => {
  const result=await retireRecruitment(client,archive,destructive());assert.equal(result.retired,true);
  for(const table of ['sites','referrals','referral_events'])assert.equal((await client.query('SELECT to_regclass($1) AS t',[`evimed_vcr.${table}`])).rows[0].t,null);
  assert.deepEqual((await client.query('SELECT user_id,role FROM evimed_vcr.members')).rows,[{user_id:'researcher',role:'data_manager'}]);
  assert.equal((await client.query('SELECT observations FROM evimed_vcr.followup_episodes')).rows[0].observations[0].value,42);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.studies')).rows[0].n,1);
  assert.equal((await loadArchive(file,meta.sha256)).snapshotDigest,archiveDigest(archive.snapshot));
  await migrateVcr(database());
  assert.equal((await client.query("SELECT to_regclass('evimed_vcr.referrals') AS t")).rows[0].t,null,'a restart never resurrects retired CRM tables');
});
