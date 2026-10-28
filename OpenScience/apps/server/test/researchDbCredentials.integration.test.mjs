import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ResearchDbCredentials } from '../src/researchDbCredentials.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) { const parsed = new URL(url); assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
test('concurrent saves cannot exceed the visible project connection limit', { skip: !url && 'A disposable test database is required' }, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 3000 });
  const user = `researchdb_${randomUUID()}`, project = 'fixture';
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'fixture','development')", [user]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'fixture',1000000)", [user, project]);
    const store = new ResearchDbCredentials(database, { activeId: 'v1', keys: { v1: 'fixture-only independent encryption secret' } }); await store.migrate();
    const input = { host: 'db.example.org', port: 5432, database: 'research', username: 'reader', password: 'secret' };
    const requestIds = Array.from({ length: 55 }, () => randomUUID());
    const outcomes = await Promise.allSettled(requestIds.map(requestId => store.save(user, project, input, requestId)));
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 50);
    assert.equal(outcomes.filter(item => item.status === 'rejected' && item.reason?.code === 'research_db_connection_limit').length, 5);
    assert.equal((await store.list(user, project)).length, 50);
    const ids = outcomes.filter(item => item.status === 'fulfilled').map(item => item.value);
    const winning = outcomes.findIndex(item => item.status === 'fulfilled');
    const retries = await Promise.all(Array.from({ length: 5 }, () => store.save(user, project, input, requestIds[winning])));
    assert(retries.every(id => id === outcomes[winning].value));
    await assert.rejects(store.save(user, project, { ...input, password: 'changed' }, requestIds[winning]), { code: 'research_db_request_conflict' });
    const both = new ResearchDbCredentials(database, { activeId: 'v2', keys: { v1: 'fixture-only independent encryption secret', v2: 'a second independent fixture encryption secret' } });
    const newest = new ResearchDbCredentials(database, { activeId: 'v2', keys: { v2: 'a second independent fixture encryption secret' } });
    await assert.rejects(newest.open(user, project, ids[0]), { code: 'research_db_connection_unavailable' });
    await assert.rejects(database.transaction(client => database.withTransactionClient(client, async () => {
      await both.rotate(user, project, ids[0]); throw new Error('Simulated interrupted rotation');
    })));
    assert.deepEqual(await store.open(user, project, ids[0]), input, 'interrupted rotation leaves the old ciphertext readable');
    assert.deepEqual(await both.rotate(user, project, ids[0]), { rotated: true });
    assert.deepEqual(await newest.open(user, project, ids[0]), input, 'rewrapped data opens after the old key is removed');
    assert.deepEqual(await both.open(user, project, ids[1]), input, 'other old-version records remain readable during gradual rotation');
    await both.assertKeyCoverage();
    await assert.rejects(newest.assertKeyCoverage(), { code: 'research_db_keyring_incomplete' });
    const before = (await database.query('SELECT ciphertext FROM evimed_control.research_db_connections WHERE user_id=$1 AND id=$2', [user, ids[1]])).rows[0].ciphertext;
    await database.query('UPDATE evimed_control.research_db_connections SET key_id=NULL WHERE user_id=$1 AND id=$2', [user, ids[1]]);
    await assert.rejects(both.assertKeyCoverage(), { code: 'research_db_keyring_incomplete' });
    assert.deepEqual((await database.query('SELECT ciphertext FROM evimed_control.research_db_connections WHERE user_id=$1 AND id=$2', [user, ids[1]])).rows[0].ciphertext, before);
  } finally { await database.query('DELETE FROM evimed_control.users WHERE id=$1', [user]); await database.close(); }
});
