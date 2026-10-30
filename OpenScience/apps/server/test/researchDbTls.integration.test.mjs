import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import test from 'node:test';
import pg from 'pg';
import { openResearchDb } from '../src/researchDbTransport.mjs';
import { listResearchTables, snapshotResearchTable } from '../src/researchDbSnapshot.mjs';

// A real PostgreSQL, a real certificate, the production transport. It needs the server tools and openssl:
//   OPEN_SCIENCE_TEST_RESEARCH_TLS=1  (and, if they are not on PATH, OPEN_SCIENCE_TEST_PG_BIN=<directory of initdb and pg_ctl>)
// If the PostgreSQL build has OpenSSL the server terminates TLS itself. A build without it (the portable one the dev box
// uses) cannot, so a TLS terminator in this file stands in front of it: it answers the SSLRequest, handshakes with the same
// certificate and forwards the decrypted bytes. What is under test is our client either way -- the verification of the
// chain and of the name, the operator's CA file, and what each failure is called.
const enabled = process.env.OPEN_SCIENCE_TEST_RESEARCH_TLS === '1';
const bin = name => (process.env.OPEN_SCIENCE_TEST_PG_BIN ? path.join(process.env.OPEN_SCIENCE_TEST_PG_BIN, name) : name);
const run = (name, args) => execFileSync(name === 'openssl' ? name : bin(name), args, { stdio: 'ignore' });
const freePort = async () => {
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {net.AddressInfo} */ (reserve.address()); await new Promise(resolve => reserve.close(resolve));
  return port;
};

/** Answer the SSLRequest with `S`, handshake as `db.example.org`, and forward to the PostgreSQL that has no TLS of its own. */
function terminator({ key, cert, upstreamPort }) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.once('data', first => {
      if (first.length < 8 || first.readInt32BE(4) !== 80877103) { socket.destroy(); return; }
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
      const upstream = net.connect(upstreamPort, '127.0.0.1');
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      secure.on('error', () => upstream.destroy()); upstream.on('error', () => secure.destroy());
      secure.pipe(upstream); upstream.pipe(secure);
    });
  });
  return { server, closeAll: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

test('real TLS verifies the chain and the original hostname, the operator\'s CA file is what is trusted, and each failure is named',
  { skip: !enabled && 'Set OPEN_SCIENCE_TEST_RESEARCH_TLS=1 and install the PostgreSQL server tools and openssl', timeout: 90000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'research-db-tls-'));
    const cluster = path.join(dir, 'cluster'), caDir = path.join(dir, 'ca'), emptyCaDir = path.join(dir, 'no-ca');
    mkdirSync(caDir); mkdirSync(emptyCaDir);
    const pgPort = await freePort();
    let running = false, front = null;
    try {
      run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'fixture_admin']);
      run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'server.key'),
        '-out', path.join(dir, 'server.crt'), '-days', '1', '-subj', '/CN=db.example.org', '-addext', 'subjectAltName=DNS:db.example.org']);
      chmodSync(path.join(dir, 'server.key'), 0o600);
      // The administrator needs no password; the reader must give one, so a wrong one is a login the server refuses.
      writeFileSync(path.join(cluster, 'pg_hba.conf'), 'local all all trust\nhost all fixture_admin 127.0.0.1/32 trust\nhost all fixture_reader 127.0.0.1/32 scram-sha-256\n');
      let serverTls = false;
      copyFileSync(path.join(dir, 'server.crt'), path.join(cluster, 'server.crt')); copyFileSync(path.join(dir, 'server.key'), path.join(cluster, 'server.key'));
      chmodSync(path.join(cluster, 'server.key'), 0o600);
      appendFileSync(path.join(cluster, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${pgPort}\nssl=on\n`);
      try { run('pg_ctl', ['-D', cluster, '-l', path.join(dir, 'postgres.log'), '-w', 'start']); serverTls = true; }
      catch {
        // This build has no OpenSSL: start it without TLS and put the terminator in front.
        writeFileSync(path.join(cluster, 'postgresql.auto.conf'), 'ssl=off\n');
        run('pg_ctl', ['-D', cluster, '-l', path.join(dir, 'postgres.log'), '-w', 'start']);
      }
      running = true;
      const admin = new pg.Client({ host: '127.0.0.1', port: pgPort, database: 'postgres', user: 'fixture_admin', ssl: serverTls ? { rejectUnauthorized: false } : false });
      await admin.connect();
      await admin.query("CREATE ROLE fixture_reader LOGIN PASSWORD 'fixture'");
      await admin.query('CREATE TABLE fixture_table (id integer, note text)');
      await admin.query("INSERT INTO fixture_table VALUES (7, 'seven')");
      await admin.query('GRANT SELECT ON fixture_table TO fixture_reader'); await admin.end();
      let tlsPort = pgPort;
      if (!serverTls) {
        tlsPort = await freePort();
        front = terminator({ key: readFileSync(path.join(dir, 'server.key')), cert: readFileSync(path.join(dir, 'server.crt')), upstreamPort: pgPort });
        await new Promise(resolve => front.server.listen(tlsPort, '127.0.0.1', resolve));
      }
      let target = tlsPort;
      /** The production client, with its socket sent to the fixture: the approved address is public, the fixture is local. */
      class FixtureClient extends pg.Client {
        constructor(options) {
          const baseStream = options.stream;
          super({ ...options, stream: () => {
            const socket = baseStream();
            socket.connect = () => net.Socket.prototype.connect.call(socket, target, '127.0.0.1');
            return socket;
          } });
        }
      }
      const resolve = async () => [{ family: 4, address: '8.8.8.8' }];
      const settings = { host: 'db.example.org', port: tlsPort, database: 'postgres', username: 'fixture_reader', password: 'fixture' };
      const policy = host => `${host}:${tlsPort}=8.8.8.8`;
      const open = (connection, options = {}) => openResearchDb(connection, policy(connection.host.toLowerCase()), { Client: FixtureClient, resolve, ...options });
      writeFileSync(path.join(caDir, 'db.example.org.pem'), readFileSync(path.join(dir, 'server.crt')));
      writeFileSync(path.join(caDir, 'wrong.example.org.pem'), readFileSync(path.join(dir, 'server.crt')));

      // The operator's CA file for the host is trusted: the table is read, and the original host name is what is verified.
      const transport = await open(settings, { caDir });
      try {
        const result = await snapshotResearchTable(transport.client, { schema: 'public', table: 'fixture_table', columns: ['id', 'note'] });
        assert.deepEqual(result.rows, [['7', 'seven']]);
        assert.deepEqual((await listResearchTables(transport.client)).tables.map(table => `${table.schema}.${table.table}`), ['public.fixture_table']);
      } finally { await transport.close(); }
      // The host typed in capitals is the same host: the allowlist and the CA file are matched in lower case.
      await (await open({ ...settings, host: 'DB.Example.ORG' }, { caDir })).close();
      // A self-signed certificate no authority vouches for is refused when the operator has not placed it...
      await assert.rejects(open(settings, { caDir: emptyCaDir }), { code: 'research_db_tls_failed' });
      await assert.rejects(open(settings), { code: 'research_db_tls_failed' });
      // ...a certificate for another name is refused though its chain is trusted...
      await assert.rejects(open({ ...settings, host: 'wrong.example.org' }, { caDir }), { code: 'research_db_tls_failed' });
      // ...and a CA file replaces the public authorities for its host, it does not add to them.
      writeFileSync(path.join(caDir, 'db.example.org.pem'), '-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----\n');
      await assert.rejects(open(settings, { caDir }), { code: 'research_db_tls_failed' });
      writeFileSync(path.join(caDir, 'db.example.org.pem'), readFileSync(path.join(dir, 'server.crt')));
      // The server answered and refused the login: not a certificate and not a network problem.
      await assert.rejects(open({ ...settings, password: 'wrong' }, { caDir }), { code: 'research_db_login_failed' });
      await assert.rejects(open({ ...settings, database: 'no_such_database' }, { caDir }), { code: 'research_db_login_failed' });
      // A server that does not speak TLS at all.
      if (!serverTls) {
        target = pgPort;
        await assert.rejects(open(settings, { caDir }), { code: 'research_db_tls_failed' });
      }
      // Nothing listening: a network problem.
      target = await freePort();
      await assert.rejects(open(settings, { caDir }), { code: 'research_db_unreachable' });
    } finally {
      await front?.closeAll();
      if (running) run('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']);
      rmSync(dir, { recursive: true, force: true });
    }
  });
