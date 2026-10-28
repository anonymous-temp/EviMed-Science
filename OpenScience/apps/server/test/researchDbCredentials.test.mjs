import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchDbCredentials, researchDbCredentialsForTest } from '../src/researchDbCredentials.mjs';

test('no deployment environment enables the research database using test overrides', () => {
  const input = { testOnly: true, database: {}, testKey: 'independent fixture key with 32 bytes' };
  for (const environment of ['production', 'development', undefined, '']) {
    assert.equal(researchDbCredentialsForTest({ ...input, environment }), null);
  }
  assert(researchDbCredentialsForTest({ ...input, environment: 'test' }) instanceof ResearchDbCredentials);
  assert.equal(researchDbCredentialsForTest({ ...input, environment: 'test', testOnly: false }), null);
});

test('connection credentials are encrypted and bound to their user and project', async () => {
  let stored;
  const db = { async query(sql, values) {
    if (sql.startsWith('INSERT INTO evimed_control.research_db_connections')) { stored = values; return { rows: [] }; }
    if (sql.startsWith('SELECT count')) return { rows: [{ n: 0 }] };
    if (sql.startsWith('SELECT ciphertext')) return { rows: stored ? [{ ciphertext: stored[3], nonce: stored[4], tag: stored[5], key_id: stored[6] }] : [] };
    return { rows: [] };
  }, async transaction(fn) { return fn(this); } };
  const credentials = new ResearchDbCredentials(db, { activeId: 'v1', keys: { v1: 'test encryption secret with at least 32 bytes' } });
  const connection = { host: 'db.example.org', port: 5432, database: 'research', username: 'reader', password: 'secret-password' };
  const id = await credentials.save('user1', 'project1', connection, 'credential-request-1');
  assert.equal(stored[3].includes(Buffer.from(connection.password)), false);
  assert.deepEqual(await credentials.open('user1', 'project1', id), connection);
  await assert.rejects(credentials.open('other', 'project1', id));
  await assert.rejects(credentials.open('user1', 'project2', id));
});
