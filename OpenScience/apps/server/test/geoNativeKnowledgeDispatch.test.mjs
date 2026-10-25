import assert from 'node:assert/strict';
import test from 'node:test';
import { GeoNativeAuthority } from '../src/geoNativeAuthority.mjs';

const project = { id: 'control', userId: 'owner' };
const current = { id: 'run', sessionId: 'session', dispatchId: 'dispatch' }, binding = { agentId: 'geo-insight' };
function fixture(rows) {
  const calls = [];
  const authority = new GeoNativeAuthority({ store: { query: async (sql, values) => { calls.push({ sql, values }); return { rows }; } } });
  return { authority, calls };
}

test('dispatch association keeps the exact scoped UPDATE arguments and requires precisely one saved mark', async () => {
  for (const rows of [[], [{ key: 'one' }], [{ key: 'one' }, { key: 'two' }]]) {
    const { authority, calls } = fixture(rows), proof = { version: 1, requestId: 'request' };
    if (rows.length === 1) await authority.recordKnowledgeDispatch(project, 'geo', current, binding, proof);
    else await assert.rejects(authority.recordKnowledgeDispatch(project, 'geo', current, binding, proof), error => error.status === 409 && error.code === 'knowledge_scope_denied' && error.message === 'The module source dispatch is unavailable.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sql.replace(/\s+/g, ' ').trim(), "UPDATE evimed_geo.schedule_marks SET detail=jsonb_set(detail,'{nativeKnowledgeDispatch}',$1::jsonb,true) WHERE geo_project_id=$2 AND user_id=$3 AND kind='run' AND dispatch_id=$4 AND state IN ('claimed','running') AND detail->>'capabilityId'=$5 AND (run_id IS NULL OR run_id=$6) AND (session_id IS NULL OR session_id=$7) RETURNING key");
    assert.deepEqual(calls[0].values, [JSON.stringify(proof), 'geo', project.userId, current.dispatchId, binding.agentId, current.id, current.sessionId]);
  }
});

test('association lookup preserves zero, unique and duplicate rows for the caller to verify inside its run snapshot', async () => {
  for (const rows of [[], [{ run_id: 'run' }], [{ run_id: 'run' }, { run_id: 'other' }]]) {
    const { authority, calls } = fixture(rows);
    assert.equal(await authority.knowledgeDispatchMarks(project, 'geo', 'dispatch'), rows);
    assert.equal(calls[0].sql.replace(/\s+/g, ' ').trim(), "SELECT run_id,session_id,detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND user_id=$2 AND kind='run' AND dispatch_id=$3 AND state IN ('claimed','running')");
    assert.deepEqual(calls[0].values, ['geo', 'owner', 'dispatch']);
  }
});
