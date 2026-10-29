import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResearchDbCredentials, researchDbCredentialsForTest, researchDbCredentialsFromConfig } from '../src/researchDbCredentials.mjs';

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
    if (sql.startsWith('SELECT ciphertext')) return { rows: stored ? [{ ciphertext: stored[4], nonce: stored[5], tag: stored[6], key_id: stored[7] }] : [] };
    return { rows: [] };
  }, async transaction(fn) { return fn(this); } };
  const credentials = new ResearchDbCredentials(db, { activeId: 'v1', keys: { v1: 'test encryption secret with at least 32 bytes' } });
  const connection = { host: 'db.example.org', port: 5432, database: 'research', username: 'reader', password: 'secret-password' };
  const id = await credentials.save('user1', 'project1', connection, 'credential-request-1');
  assert.equal(stored[4].includes(Buffer.from(connection.password)), false);
  assert.equal(stored[3], 'db.example.org/research', 'the label is the host and the database name, with neither the user name nor the password');
  assert.deepEqual(await credentials.open('user1', 'project1', id), connection);
  await assert.rejects(credentials.open('other', 'project1', id));
  await assert.rejects(credentials.open('user1', 'project2', id));
});

test('the configured connector needs a database, an allowlist and a readable keyring, and says once why it stays off', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-db-factory-'));
  try {
    const bytes = randomBytes(32), id = createHash('sha256').update(bytes).digest('hex'), file = path.join(dir, 'keys');
    writeFileSync(file, JSON.stringify({ activeId: id, keys: { [id]: bytes.toString('base64') } }), { mode: 0o600 });
    const reports = [], allow = 'db.example.org:5432=8.8.8.8';
    const base = { environment: 'production', testOnly: undefined, testKey: undefined, database: {}, keyringFile: file, allow, report: code => reports.push(code) };
    const credentials = researchDbCredentialsFromConfig(base);
    assert(credentials instanceof ResearchDbCredentials); assert.equal(credentials.activeId, id); assert.deepEqual(reports, []);
    // Neither half alone: nothing configured is silent, a keyring without an allowlist or an unreadable keyring says why.
    assert.equal(researchDbCredentialsFromConfig({ ...base, keyringFile: '' }), null); assert.deepEqual(reports, []);
    assert.equal(researchDbCredentialsFromConfig({ ...base, database: null }), null);
    assert.equal(researchDbCredentialsFromConfig({ ...base, allow: '  ' }), null); assert.deepEqual(reports, ['research_db_allowlist_missing']);
    assert.equal(researchDbCredentialsFromConfig({ ...base, keyringFile: path.join(dir, 'absent') }), null);
    assert.deepEqual(reports, ['research_db_allowlist_missing', 'research_db_keyring_unavailable']);
    assert(!reports.join().includes(dir), 'a report names a code, never a path');
    // The isolated test injection is unchanged and wins only under NODE_ENV=test.
    const injection = { testOnly: true, testKey: 'independent fixture key with 32 bytes' };
    assert.equal(researchDbCredentialsFromConfig({ ...base, ...injection, environment: 'test' }).activeId, 'test-v1');
    assert.equal(researchDbCredentialsFromConfig({ ...base, ...injection, environment: 'production' }).activeId, id);
    assert.equal(researchDbCredentialsFromConfig({ ...base, ...injection, environment: 'production', keyringFile: '' }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a host is kept in lower case, so it is matched, resolved and verified as one name', async () => {
  let stored;
  const db = { async query(sql, values) {
    if (sql.startsWith('INSERT INTO evimed_control.research_db_connections')) { stored = values; return { rows: [] }; }
    if (sql.startsWith('SELECT count')) return { rows: [{ n: 0 }] };
    if (sql.startsWith('SELECT ciphertext')) return { rows: stored ? [{ ciphertext: stored[4], nonce: stored[5], tag: stored[6], key_id: stored[7] }] : [] };
    return { rows: [] };
  }, async transaction(fn) { return fn(this); } };
  const credentials = new ResearchDbCredentials(db, { activeId: 'v1', keys: { v1: 'test encryption secret with at least 32 bytes' } });
  const id = await credentials.save('user1', 'project1', { host: 'DB.Example.ORG', port: 5432, database: 'research', username: 'reader', password: 'secret-password' }, 'credential-request-1');
  assert.equal(stored[3], 'db.example.org/research');
  assert.equal((await credentials.open('user1', 'project1', id)).host, 'db.example.org');
});

test('the number of saved connections a project keeps is the configured one', async () => {
  let saved = 0;
  const db = { async query(sql) {
    if (sql.startsWith('INSERT INTO evimed_control.research_db_connections')) saved += 1;
    if (sql.startsWith('SELECT count')) return { rows: [{ n: saved }] };
    return { rows: [] };
  }, async transaction(fn) { return fn(this); } };
  const credentials = new ResearchDbCredentials(db, { activeId: 'v1', keys: { v1: 'test encryption secret with at least 32 bytes' } }, { maxConnections: 2 });
  const connection = { host: 'db.example.org', port: 5432, database: 'research', username: 'reader', password: 'secret-password' };
  await credentials.save('u', 'p', connection, 'credential-request-1'); await credentials.save('u', 'p', connection, 'credential-request-2');
  await assert.rejects(credentials.save('u', 'p', connection, 'credential-request-3'), { code: 'research_db_connection_limit' });
  assert.equal(researchDbCredentialsFromConfig({ environment: 'test', testOnly: true, database: db, testKey: 'independent fixture key with 32 bytes', keyringFile: '', allow: '', maxConnections: 7 }).maxConnections, 7);
});
