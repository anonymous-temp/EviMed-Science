import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openResearchDb, researchDbCaFor } from '../src/researchDbTransport.mjs';

test('transport pins the approved DNS answer and requires certificate validation', async () => {
  let options;
  class Client { constructor(value) { options = value; } async connect() {} async end() {} on() {} }
  const connection = { host: 'db.example.org', port: 5432, database: 'data', username: 'reader', password: 'secret' };
  const result = await openResearchDb(connection, 'db.example.org:5432=8.8.8.8', { Client, resolve: async () => [{ family: 4, address: '8.8.8.8' }] });
  assert.equal(options.host, 'db.example.org'); assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(typeof options.stream, 'function'); assert.equal(options.connectionTimeoutMillis, 5000);
  await result.close();
});

test('the connection closes if the server sends too many protocol bytes', async () => {
  let client;
  class Client {
    constructor() { client = this; this.connection = new EventEmitter(); this.connection.stream = new EventEmitter();
      this.connection.stream.destroy = () => { this.destroyed = true; }; }
    async connect() { this.connection.emit('sslconnect'); } async end() {} on() {}
  }
  const connection = { host: 'db.example.org', port: 5432, database: 'data', username: 'reader', password: 'secret' };
  const opened = await openResearchDb(connection, 'db.example.org:5432=8.8.8.8', { Client, resolve: async () => [{ family: 4, address: '8.8.8.8' }] });
  client.connection.stream.emit('data', Buffer.alloc(24 * 1024 * 1024));
  assert.equal(client.destroyed, undefined);
  client.connection.stream.emit('data', Buffer.alloc(1));
  assert.equal(client.destroyed, true); await opened.close();
});

const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const here = { host: 'db.example.org', port: 5432, database: 'data', username: 'reader', password: 'secret' };

test('an operator CA file for the host replaces the built-in authorities for that host and no other', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-db-ca-'));
  try {
    writeFileSync(path.join(dir, 'db.example.org.pem'), CERTIFICATE);
    const optionsOf = [];
    class Client { constructor(value) { optionsOf.push(value); } async connect() {} async end() {} on() {} }
    const policy = 'db.example.org:5432=8.8.8.8,other.example.org:5432=8.8.4.4';
    const resolve = async name => [{ family: 4, address: name === 'db.example.org' ? '8.8.8.8' : '8.8.4.4' }];
    await (await openResearchDb({ ...here, host: 'DB.example.org' }, policy, { Client, resolve, caDir: dir })).close();
    await (await openResearchDb({ ...here, host: 'other.example.org' }, policy, { Client, resolve, caDir: dir })).close();
    await (await openResearchDb(here, policy, { Client, resolve, caDir: '' })).close();
    assert.deepEqual(optionsOf[0].ssl, { rejectUnauthorized: true, ca: CERTIFICATE }, 'the host with a file trusts that file');
    assert.equal(optionsOf[0].host, 'db.example.org', 'the connection is made to the lower-case name');
    assert.deepEqual(optionsOf[1].ssl, { rejectUnauthorized: true }, 'a host with no file keeps the public authorities');
    assert.deepEqual(optionsOf[2].ssl, { rejectUnauthorized: true }, 'no directory configured, no file read');
    // The file is read at each connection: the operator's renewal takes effect without a restart.
    writeFileSync(path.join(dir, 'db.example.org.pem'), CERTIFICATE.replace('fake', 'renewed'));
    await (await openResearchDb(here, policy, { Client, resolve, caDir: dir })).close();
    assert.match(optionsOf[3].ssl.ca, /renewed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a CA file that is not a certificate, is a link or is too large is a failed TLS setup, never a fall-back to the public authorities', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-db-ca-bad-'));
  try {
    class Client { constructor() { throw new Error('a client must not be built'); } }
    const policy = 'db.example.org:5432=8.8.8.8';
    const resolve = async () => [{ family: 4, address: '8.8.8.8' }];
    const file = path.join(dir, 'db.example.org.pem');
    for (const prepare of [
      () => writeFileSync(file, 'this is not a certificate'),
      () => writeFileSync(file, ''),
      () => { rmSync(file); writeFileSync(file, `${CERTIFICATE}${'#'.repeat(70_000)}`); },
      () => { rmSync(file); writeFileSync(path.join(dir, 'real.pem'), CERTIFICATE); symlinkSync(path.join(dir, 'real.pem'), file); },
    ]) {
      prepare();
      await assert.rejects(openResearchDb(here, policy, { Client, resolve, caDir: dir }), { code: 'research_db_tls_failed' });
    }
    assert.equal(researchDbCaFor(path.join(dir, 'absent'), 'db.example.org'), null, 'a missing directory is no file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed connection is a certificate, a login or a network problem, and says which', async () => {
  const policy = 'db.example.org:5432=8.8.8.8';
  const resolve = async () => [{ family: 4, address: '8.8.8.8' }];
  const failWith = error => class { async connect() { throw error; } async end() {} on() {} };
  const code = (value, extra = {}) => Object.assign(new Error(extra.message ?? 'x'), { code: value });
  const cases = [
    // The server answered and refused the account or the database name.
    [code('28P01', { message: 'password authentication failed for user "reader"' }), 'research_db_login_failed'],
    [code('28000', { message: 'no pg_hba.conf entry for host' }), 'research_db_login_failed'],
    [code('3D000', { message: 'database "nope" does not exist' }), 'research_db_login_failed'],
    // The certificate did not verify, or the server has no TLS at all.
    [code('DEPTH_ZERO_SELF_SIGNED_CERT', { message: 'self-signed certificate' }), 'research_db_tls_failed'],
    [code('SELF_SIGNED_CERT_IN_CHAIN'), 'research_db_tls_failed'],
    [code('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'research_db_tls_failed'],
    [code('CERT_HAS_EXPIRED'), 'research_db_tls_failed'],
    [code('ERR_TLS_CERT_ALTNAME_INVALID', { message: "Hostname/IP does not match certificate's altnames" }), 'research_db_tls_failed'],
    [new Error('The server does not support SSL connections'), 'research_db_tls_failed'],
    // Nothing answered.
    [code('ECONNREFUSED'), 'research_db_unreachable'],
    [code('ETIMEDOUT'), 'research_db_unreachable'],
    [code('EHOSTUNREACH'), 'research_db_unreachable'],
    [new Error('Connection terminated due to connection timeout'), 'research_db_unreachable'],
    // Anything else keeps the general answer.
    [code('53300', { message: 'too many connections for role' }), 'research_db_unavailable'],
    [new Error('something nobody planned for'), 'research_db_unavailable'],
  ];
  for (const [error, expected] of cases) {
    await assert.rejects(openResearchDb(here, policy, { Client: failWith(error), resolve }), { code: expected }, `${error.code ?? error.message}`);
  }
  // No text of the failure, no host, no user name and no password reaches the answer.
  const refused = await openResearchDb(here, policy, { Client: failWith(code('28P01', { message: 'password authentication failed for user "reader" secret' })), resolve }).catch(error => error);
  assert(!JSON.stringify([refused.message, refused.code]).match(/reader|secret|db\.example/));
});

test('the connection end and the wire cap are the configured ones', async () => {
  let client;
  class Client {
    constructor() { client = this; this.connection = new EventEmitter(); this.connection.stream = new EventEmitter();
      this.connection.stream.destroy = () => { this.destroyed = true; }; }
    async connect() { this.connection.emit('sslconnect'); } async end() {} on() {}
  }
  const opened = await openResearchDb(here, 'db.example.org:5432=8.8.8.8', { Client, resolve: async () => [{ family: 4, address: '8.8.8.8' }], limits: { connectionMs: 5000, wireBytes: 1000 } });
  client.connection.stream.emit('data', Buffer.alloc(1000));
  assert.equal(client.destroyed, undefined);
  client.connection.stream.emit('data', Buffer.alloc(1));
  assert.equal(client.destroyed, true); await opened.close();
});
