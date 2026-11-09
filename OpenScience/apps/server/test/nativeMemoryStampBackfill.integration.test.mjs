import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { NativeMemoryOverlay } from '../src/nativeMemoryOverlay.mjs';
import { backfillProjectStamps } from '../src/nativeMemoryPersistence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'nativememorystamps');
  let database;
  t.after(async () => { await database?.close(); await isolated.drop(); });
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  const overlay = new NativeMemoryOverlay({ database }); await overlay.migrate();
  const userId = 'stamp-owner';
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Stamp fixture','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes,created_at) VALUES($1,'p1','P',1048576,'2026-10-01 00:00:00+00')", [userId]);
  return { database, overlay, userId };
}

test('a session bound before the stamp existed keeps working: the writer and the reader adopt the project stamp', options, async t => {
  const f = await fixture(t);
  await f.database.query("INSERT INTO evimed_memory.native_sessions(user_id,engine_session,project_id,project_created_at) VALUES($1,'dsh-old','p1',NULL)", [f.userId]);
  await f.overlay.assertSessionScope(f.userId, 'dsh-old', 'p1');
  assert.ok((await f.database.query("SELECT project_created_at FROM evimed_memory.native_sessions WHERE engine_session='dsh-old'")).rows[0].project_created_at);
  await f.database.query("INSERT INTO evimed_memory.native_sessions(user_id,engine_session,project_id,project_created_at) VALUES($1,'dsh-old2','p1',NULL)", [f.userId]);
  await f.overlay.noteSession(f.userId, 'dsh-old2', 'p1');
  assert.ok((await f.database.query("SELECT project_created_at FROM evimed_memory.native_sessions WHERE engine_session='dsh-old2'")).rows[0].project_created_at);
  await assert.rejects(f.overlay.noteSession(f.userId, 'dsh-old2', 'other'), { code: 'memory_scope_denied' });
});

test('the backfill stamps rows from their project, is idempotent and leaves a mismatched project alone', options, async t => {
  const f = await fixture(t);
  await f.database.query("INSERT INTO evimed_memory.native_sessions(user_id,engine_session,project_id,project_created_at,created_at) VALUES($1,'a','p1',NULL,'2026-10-02 00:00:00+00'),($1,'b','gone',NULL,'2026-10-02 00:00:00+00'),($1,'c','p1',NULL,'2026-09-01 00:00:00+00')", [f.userId]);
  await f.database.query("INSERT INTO evimed_memory.native_commits(user_id,archive_uri,engine_session,project_id,origin,created_at) VALUES($1,'viking://user/x/sessions/a/history/archive_001','a','p1','gateway','2026-10-02 00:00:00+00')", [f.userId]);
  await backfillProjectStamps(f.database); await backfillProjectStamps(f.database);
  const rows = (await f.database.query("SELECT engine_session,project_created_at FROM evimed_memory.native_sessions ORDER BY engine_session")).rows;
  assert.ok(rows[0].project_created_at); assert.equal(rows[1].project_created_at, null); assert.equal(rows[2].project_created_at, null, 'a row older than the project incarnation is not claimed by it');
  assert.ok((await f.database.query("SELECT project_created_at FROM evimed_memory.native_commits")).rows[0].project_created_at);
});
