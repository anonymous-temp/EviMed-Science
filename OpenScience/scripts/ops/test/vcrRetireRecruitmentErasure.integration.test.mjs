import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { migrateVcr } from '../../../apps/server/src/vcrPersistence.mjs';
import { deleteVcrUserRows } from '../../../apps/server/src/vcrStoreBase.mjs';
import { createGeoTestDatabase } from '../../../apps/server/test/helpers/geoTestDatabase.mjs';
import { archiveRecruitment, forgetErased, loadArchive, restoreRecruitment, retireRecruitment } from '../vcr-retire-recruitment.mjs';
const require = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const { Client } = require('pg');
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured' };
let previousPassphrase, previousPassphraseFile;
before(() => {
  previousPassphrase=process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE;
  previousPassphraseFile=process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE;
  delete process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE;
  process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE=randomBytes(32).toString('base64');
});
after(() => {
  if(previousPassphrase===undefined)delete process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE;else process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE=previousPassphrase;
  if(previousPassphraseFile!==undefined)process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE=previousPassphraseFile;
});

async function fixture(work) {
  const endpoint=new URL(url);assert.equal(endpoint.hostname,'127.0.0.1');assert.equal(endpoint.port,'58473');assert.equal(endpoint.username,'vcr_test');assert.match(endpoint.pathname,/^\/evimed_test/);
  const isolated=await createGeoTestDatabase(url,'retireerasure');
  const client=new Client({connectionString:isolated.url,statement_timeout:10000,lock_timeout:3000});
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'retire-erasure-')));
  await fs.chmod(directory,0o700);
  const database={async transaction(fn){await client.query('BEGIN');try{const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}}};
  try {
    await client.connect();await isolated.close();
    await client.query(await fs.readFile(new URL('./fixtures/vcr-production-base-1a799c2db.sql',import.meta.url),'utf8'));
    await client.query(`INSERT INTO evimed_vcr.studies(id,project_id,user_id,name) VALUES('std_erasure','project_erasure','owner','Synthetic');
      INSERT INTO evimed_vcr.sources(id,study_id,user_id,name) VALUES('src_erasure','std_erasure','owner','Synthetic');
      INSERT INTO evimed_vcr.sites(id,study_id,user_id,name,contacts) VALUES('site_erased','std_erasure','site_author','Synthetic','[{"name":"synthetic erased site contact"}]');
      INSERT INTO evimed_vcr.referrals(id,study_id,site_id,user_id,subject_key) VALUES('ref_owner','std_erasure','site_erased','owner','SUBJECT_RETAINED');
      ALTER TABLE evimed_vcr.referrals ADD COLUMN legacy_observation jsonb NOT NULL DEFAULT '{"integer":9007199254740993,"decimal":0.12345678901234567890123456789}';
      INSERT INTO evimed_vcr.referral_events(id,referral_id,user_id,to_state,note) VALUES('event_owner','ref_owner','owner','candidate','synthetic retained event');
      INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES('std_erasure','old_recruiter','recruiter'),('std_erasure','other_site','site');
      INSERT INTO evimed_vcr.grants(id,source_id,study_id,user_id,grantee,role,revoked_at) VALUES
        ('grant_erased','src_erasure','std_erasure','owner','old_recruiter','recruiter',now()),
        ('grant_other','src_erasure','std_erasure','owner','other_site','site',now());`);
    await migrateVcr(database);
    const capture=async name=>{const file=path.join(directory,`${name}.enc`);const meta=await archiveRecruitment(client,file);return {meta,archive:await loadArchive(file,meta.sha256)};};
    const reseal=async archive=>{const file=path.join(directory,'resealed.enc');const meta=await forgetErased(client,archive,file);return {meta,archive:await loadArchive(file,meta.sha256)};};
    const flags=meta=>({workersStopped:true,allowDropApprovedTables:true,allowDeleteRetiredMembers:true,allowRestoreApprovedTables:true,expectedDatabase:meta.databaseIdentity});
    await work({client,database,capture,reseal,flags});
  } finally {await client.end();await isolated.drop();await fs.rm(directory,{recursive:true,force:true});}
}
function retainedReferral(archive) {
  assert.deepEqual(archive.snapshot.tables.sites.rows,[]);
  assert.equal(archive.snapshot.tables.referrals.rows.length,1);
  const row=archive.snapshot.tables.referrals.rows[0];
  assert.equal(JSON.parse(row).site_id,null);
  assert.match(row,/9007199254740993/);assert.match(row,/0\.12345678901234567890123456789/);
  assert.equal(archive.snapshot.tables.referral_events.rows.length,1);
  assert.doesNotMatch(JSON.stringify(archive.snapshot),/site_author|synthetic erased site contact/);
}
async function restoredReferral(client) {
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.sites')).rows[0].n,0);
  const row=(await client.query('SELECT site_id,legacy_observation::text AS exact FROM evimed_vcr.referrals')).rows[0];
  assert.equal(row.site_id,null);assert.match(row.exact,/9007199254740993/);assert.match(row.exact,/0\.12345678901234567890123456789/);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.referral_events')).rows[0].n,1);
}

test('erasing a different site author before initial capture nulls its nullable FK, preserving owner referrals/events and numeric precision',options,()=>fixture(async({client,database,capture,flags})=>{
  await database.transaction(c=>deleteVcrUserRows(c,'site_author'));
  const {meta,archive}=await capture('initial');retainedReferral(archive);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evimed_vcr.sites')).rows[0].n,1,'capture does not mutate the serving rows');
  await retireRecruitment(client,archive,flags(meta));
  await restoreRecruitment(client,archive,flags(meta));await restoredReferral(client);
  assert.equal((await retireRecruitment(client,archive,flags(meta))).retired,true);
}));
test('erasing a different site author after retirement permits re-seal and real restore without orphaning the retained referral',options,()=>fixture(async({client,database,capture,reseal,flags})=>{
  const original=await capture('original');await retireRecruitment(client,original.archive,flags(original.meta));
  await database.transaction(c=>deleteVcrUserRows(c,'site_author'));
  await assert.rejects(restoreRecruitment(client,original.archive,flags(original.meta)),{code:'vcr_retirement_forget_erased_required'});
  const replacement=await reseal(original.archive);retainedReferral(replacement.archive);
  await restoreRecruitment(client,replacement.archive,flags(replacement.meta));await restoredReferral(client);
  assert.equal((await retireRecruitment(client,replacement.archive,flags(replacement.meta))).retired,true);
}));
test('grant deletion by later account erasure refreshes advisory counts; unrelated grant changes do not poison restore/re-retire equivalence',options,()=>fixture(async({client,database,capture,reseal,flags})=>{
  const original=await capture('original');assert.deepEqual(original.meta.grantRoleCounts,[{role:'recruiter',count:1},{role:'site',count:1}]);
  await retireRecruitment(client,original.archive,flags(original.meta));
  await database.transaction(c=>deleteVcrUserRows(c,'old_recruiter'));
  const replacement=await reseal(original.archive);
  assert.deepEqual(replacement.meta.grantRoleCounts,[{role:'site',count:1}]);
  assert.equal(replacement.meta.grantRoleCountsScope,'advisory_live_database_observation');
  await restoreRecruitment(client,replacement.archive,flags(replacement.meta));
  assert.equal((await client.query("SELECT count(*)::int AS n FROM evimed_vcr.members WHERE user_id='old_recruiter'")).rows[0].n,0);
  // A later permission deletion changes no archived/restored OA row or schema.
  await client.query("DELETE FROM evimed_vcr.grants WHERE id='grant_other'");
  assert.equal((await retireRecruitment(client,replacement.archive,flags(replacement.meta))).retired,true);
}));
