import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { ResearchDbStaging } from '../src/researchDbStaging.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) { const parsed = new URL(url); assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const relative = () => `knowledge-base/.evimed-revisions/${'a'.repeat(64)}/research-database-${randomUUID()}.json`;
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
    const orphan = relative(), child = `
      const { ControlPlaneDatabase } = await import(${JSON.stringify(pathToFileURL(path.resolve('apps/server/src/controlPlaneDatabase.mjs')).href)});
      const { ResearchDbStaging } = await import(${JSON.stringify(pathToFileURL(path.resolve('apps/server/src/researchDbStaging.mjs')).href)});
      const fs = await import('node:fs/promises'); const path = await import('node:path');
      const db = new ControlPlaneDatabase({databaseUrl:process.env.TEST_DB,databasePoolMax:1,databaseConnectionTimeoutMs:2000});
      const service = new ResearchDbStaging({database:db,store:{}});
      await service.reserve(process.env.TEST_USER,process.env.TEST_PROJECT,process.env.TEST_PATH);
      const target = path.join(process.env.TEST_ROOT,process.env.TEST_PATH); await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target,'orphan'); await fs.writeFile(path.join(path.dirname(target),'.'+path.basename(target)+'.tmp_fixture'),'partial');
      process.exit(71);`;
    const childResult = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, TEST_DB: url,
      TEST_USER: user, TEST_PROJECT: projectId, TEST_PATH: orphan, TEST_ROOT: baseDir }, encoding: 'utf8' });
    assert.equal(childResult.status, 71, childResult.stderr);
    await service.recover(); assert.equal(await readFile(path.join(baseDir, orphan), 'utf8'), 'orphan', 'recent marker is not claimed');
    await service.recover(0);
    await assert.rejects(readFile(path.join(baseDir, orphan)), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(path.dirname(path.join(baseDir, orphan)), `.${path.basename(orphan)}.tmp_fixture`)), { code: 'ENOENT' });

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
    await new ProductDocuments(db).put(user, 'source', `src_${'b'.repeat(32)}`, { paths: [retained] }, { expectedRevision: 0, projectId });
    await service.recover(0); assert.equal(await readFile(retainedFile, 'utf8'), 'reference', 'any source reference prevents deletion');
  } finally { await db.query('DELETE FROM evimed_control.users WHERE id=$1', [user]); await db.close(); await rm(baseDir, { recursive: true, force: true }); }
});
