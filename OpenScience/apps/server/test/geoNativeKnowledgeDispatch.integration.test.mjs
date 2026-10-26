import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoNativeAuthority } from '../src/geoNativeAuthority.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'Disposable PostgreSQL required' };
let isolated, database, store, authority, geo;
const project = { id: 'control', userId: 'owner' }, current = { id: 'run', dispatchId: 'dispatch', sessionId: 'session' }, binding = { agentId: 'geo-insight' };
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'knowledgedispatch');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  store = new GeoStore({ database }); await store.ready();
  geo = await store.createProject({ userId: project.userId, projectId: project.id, engines: ['deepseek'], coverageDays: 90 });
  authority = new GeoNativeAuthority({ store });
});
after(async () => { await database?.close(); await isolated?.drop(); });
async function mark(overrides = {}) {
  const value = { owner: project.userId, geoId: geo.id, kind: 'run', state: 'claimed', dispatchId: current.dispatchId, runId: null, sessionId: null, detail: { capabilityId: binding.agentId, preserved: true }, ...overrides };
  const key = randomUUID();
  await store.query(`INSERT INTO evimed_geo.schedule_marks(geo_project_id,key,user_id,kind,state,dispatch_id,run_id,session_id,detail)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [value.geoId, key, value.owner, value.kind, value.state, value.dispatchId, value.runId, value.sessionId, JSON.stringify(value.detail)]);
  return key;
}

test('actual dispatch UPDATE accepts NULL or matching run/session only and preserves all other detail', options, async () => {
  for (const state of ['claimed', 'running']) for (const associated of [false, true]) {
    await store.query('DELETE FROM evimed_geo.schedule_marks WHERE geo_project_id=$1', [geo.id]);
    const key = await mark({ state, ...(associated ? { runId: current.id, sessionId: current.sessionId } : {}) });
    const proof = { version: 1, requestId: `request-${state}-${associated}` };
    await authority.recordKnowledgeDispatch(project, geo.id, current, binding, proof);
    const marks = await authority.knowledgeDispatchMarks(project, geo.id, current.dispatchId);
    assert.equal(marks.length, 1); assert.deepEqual(marks[0].detail, { capabilityId: binding.agentId, preserved: true, nativeKnowledgeDispatch: proof });
    assert.equal((await store.query('SELECT key FROM evimed_geo.schedule_marks WHERE geo_project_id=$1', [geo.id])).rows[0].key, key);
  }
});

test('wrong state, owner, capability, dispatch, GEO project, kind, run or session never acquire an association', options, async () => {
  const other = await store.createProject({ userId: 'owner', projectId: 'other-control', engines: ['deepseek'], coverageDays: 90 });
  for (const change of [{ state: 'done' }, { owner: 'other-owner' }, { detail: { capabilityId: 'other-agent' } }, { dispatchId: 'other-dispatch' },
    { geoId: other.id }, { kind: 'request' }, { runId: 'other-run' }, { sessionId: 'other-session' }]) {
    await store.query('DELETE FROM evimed_geo.schedule_marks WHERE geo_project_id=ANY($1::text[])', [[geo.id, other.id]]);
    await mark(change);
    await assert.rejects(authority.recordKnowledgeDispatch(project, geo.id, current, binding, { version: 1 }), error => error.status === 409 && error.code === 'knowledge_scope_denied');
    assert.equal((await store.query("SELECT count(*)::integer AS n FROM evimed_geo.schedule_marks WHERE detail ? 'nativeKnowledgeDispatch'")).rows[0].n, 0);
  }
});

test('actual lookup is owner/project/dispatch scoped, leaves duplicates explicit, and excludes terminal or request marks', options, async () => {
  await store.query('DELETE FROM evimed_geo.schedule_marks');
  await mark(); await mark({ state: 'running' });
  for (const change of [{ state: 'done' }, { owner: 'other-owner' }, { dispatchId: 'other-dispatch' }, { kind: 'request' }]) await mark(change);
  assert.equal((await authority.knowledgeDispatchMarks(project, geo.id, current.dispatchId)).length, 2, 'the server must continue unless exactly one association remains');
  assert.deepEqual(await authority.knowledgeDispatchMarks({ ...project, userId: 'stranger' }, geo.id, current.dispatchId), []);
  assert.deepEqual(await authority.knowledgeDispatchMarks(project, 'wrong-geo', current.dispatchId), []);
  assert.deepEqual(await authority.knowledgeDispatchMarks(project, geo.id, 'missing-dispatch'), []);
});
