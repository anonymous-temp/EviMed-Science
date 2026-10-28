import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { ResearchDbStaging } from '../src/researchDbStaging.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) { const parsed = new URL(url); assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const folder = `knowledge-base/databases/.evimed-revisions/${'a'.repeat(64)}`;
const relative = () => `${folder}/public.cohort_${randomUUID().slice(0, 8)}-1a2b3c4d.csv`;
const sidecarOf = file => file.replace(/\.csv$/, '.import.json');
test('restart cleanup deletes orphan and temporary bytes but fences live and referenced files', { skip: !url && 'A disposable test database is required', timeout: 30000 }, async () => {
  const db = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  const baseDir = await mkdtemp(path.join(tmpdir(), 'research-stage-'));
  const user = `stage_${randomUUID()}`, projectId = 'stage-project';
  const project = { id: projectId, userId: user, baseDir };
  const store = { async userById(id) { return id === user ? { id } : null; }, async requireProject(actor, id) { assert.equal(actor.id, user); assert.equal(id, projectId); return project; } };
  const service = new ResearchDbStaging({ database: db, store });
  try {
    await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'stage','development')", [user]);
    await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'stage',1000000)", [user, projectId]);
    await migrateProductStore(db); await service.migrate();
    for (const bad of [`${folder}/research-database-${randomUUID()}.json`, `${folder}/../cohort-1a2b3c4d.csv`, `${folder}/.hidden-1a2b3c4d.csv`,
      `${folder}/${'x'.repeat(97)}-1a2b3c4d.csv`, `${folder}/a/b-1a2b3c4d.csv`, `${folder}/cohort-20261028-010203.csv`, `${folder}/cohort-1A2B3C4D.csv`,
      `knowledge-base/.evimed-revisions/${'a'.repeat(64)}/cohort-1a2b3c4d.csv`, `knowledge-base/links/.evimed-revisions/${'a'.repeat(64)}/cohort-1a2b3c4d.csv`,
      `${folder}/a..b-1a2b3c4d.csv`, `${folder}/cohort-1a2b3c4d.import.json`]) await assert.rejects(service.reserve(user, projectId, bad), { code: 'research_db_staging_unavailable' }, bad);
    assert.equal(typeof await service.reserve(user, projectId, `${folder}/患者_队列.v2-1a2b3c4d.csv`), 'string');
    await db.query('DELETE FROM evimed_control.research_db_staging WHERE user_id=$1', [user]);
    const orphan = relative(), child = `
      const { ControlPlaneDatabase } = await import(${JSON.stringify(new URL('../src/controlPlaneDatabase.mjs', import.meta.url).href)});
      const { ResearchDbStaging } = await import(${JSON.stringify(new URL('../src/researchDbStaging.mjs', import.meta.url).href)});
      const fs = await import('node:fs/promises'); const path = await import('node:path');
      const db = new ControlPlaneDatabase({databaseUrl:process.env.TEST_DB,databasePoolMax:1,databaseConnectionTimeoutMs:2000});
      const service = new ResearchDbStaging({database:db,store:{}});
      await service.reserve(process.env.TEST_USER,process.env.TEST_PROJECT,process.env.TEST_PATH);
      const target = path.join(process.env.TEST_ROOT,process.env.TEST_PATH); await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target,'orphan'); await fs.writeFile(path.join(path.dirname(target),'.'+path.basename(target)+'.tmp_fixture'),'partial');
      const note = target.replace(/\\.csv$/, '.import.json');
      await fs.writeFile(note,'{}'); await fs.writeFile(path.join(path.dirname(note),'.'+path.basename(note)+'.tmp_fixture'),'partial');
      await fs.writeFile(path.join(path.dirname(target),'keep-neighbour.csv'),'someone else');
      process.exit(71);`;
    const childResult = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, TEST_DB: url,
      TEST_USER: user, TEST_PROJECT: projectId, TEST_PATH: orphan, TEST_ROOT: baseDir }, encoding: 'utf8' });
    assert.equal(childResult.status, 71, childResult.stderr);
    await service.recover(); assert.equal(await readFile(path.join(baseDir, orphan), 'utf8'), 'orphan', 'recent marker is not claimed');
    await service.recover(0);
    await assert.rejects(readFile(path.join(baseDir, orphan)), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(path.dirname(path.join(baseDir, orphan)), `.${path.basename(orphan)}.tmp_fixture`)), { code: 'ENOENT' });
    // The sidecar written beside the CSV goes with it, and so do its temporary files; a neighbour in the same directory stays.
    await assert.rejects(readFile(path.join(baseDir, sidecarOf(orphan))), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(path.dirname(path.join(baseDir, orphan)), `.${path.basename(sidecarOf(orphan))}.tmp_fixture`)), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(path.dirname(path.join(baseDir, orphan)), 'keep-neighbour.csv'), 'utf8'), 'someone else');

    const live = relative(), liveId = await service.reserve(user, projectId, live), liveFile = path.join(baseDir, live);
    await mkdir(path.dirname(liveFile), { recursive: true }); await writeFile(liveFile, 'active');
    let acquired, release;
    const held = new Promise(resolve => { acquired = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const transaction = db.transaction(async client => {
      await client.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2 FOR SHARE', [user, projectId]);
      await client.query('SELECT id FROM evimed_control.research_db_staging WHERE user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [user, projectId, liveId]);
      acquired(); await gate;
    });
    await held;
    try { await service.recover(0); assert.equal(await readFile(liveFile, 'utf8'), 'active'); }
    finally { release(); await transaction; }
    await service.recover(0); await assert.rejects(readFile(liveFile), { code: 'ENOENT' });

    const failed = relative(), failedId = await service.reserve(user, projectId, failed), failedFile = path.join(baseDir, failed);
    await mkdir(path.dirname(failedFile), { recursive: true }); await writeFile(failedFile, 'retry');
    const originalRemove = service.removeFiles;
    service.removeFiles = async () => { throw new Error('Injected cleanup failure'); };
    await service.recover(0); assert.equal(await readFile(failedFile, 'utf8'), 'retry');
    assert((await db.query('SELECT last_attempt_at FROM evimed_control.research_db_staging WHERE id=$1', [failedId])).rows[0].last_attempt_at);
    service.removeFiles = originalRemove;
    await service.recover(0); await assert.rejects(readFile(failedFile), { code: 'ENOENT' });

    const retained = relative(), retainedFile = path.join(baseDir, retained);
    await service.reserve(user, projectId, retained); await mkdir(path.dirname(retainedFile), { recursive: true }); await writeFile(retainedFile, 'reference');
    await writeFile(path.join(baseDir, sidecarOf(retained)), '{"kept":true}');
    await new ProductDocuments(db).put(user, 'source', `src_${'b'.repeat(32)}`, { paths: [retained] }, { expectedRevision: 0, projectId });
    await service.recover(0); assert.equal(await readFile(retainedFile, 'utf8'), 'reference', 'any source reference prevents deletion');
    assert.equal(await readFile(path.join(baseDir, sidecarOf(retained)), 'utf8'), '{"kept":true}', 'and keeps the sidecar that explains it');
  } finally { await db.query('DELETE FROM evimed_control.users WHERE id=$1', [user]); await db.close(); await rm(baseDir, { recursive: true, force: true }); }
});
