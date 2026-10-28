import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, chmodSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import pg from 'pg';
import { openResearchDb } from '../src/researchDbTransport.mjs';
import { listResearchTables, snapshotResearchTable } from '../src/researchDbSnapshot.mjs';

const enabled = process.env.OPEN_SCIENCE_TEST_RESEARCH_TLS === '1';
const run = (name, args) => execFileSync(name, args, { stdio: 'ignore' });

test('real TLS verifies the original hostname while the approved address is pinned', { skip: !enabled && 'Set OPEN_SCIENCE_TEST_RESEARCH_TLS=1 and install PostgreSQL tools', timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-db-tls-'));
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  let running = false;
  try {
    const cluster = path.join(dir, 'cluster');
    run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'fixture_admin']);
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(cluster, 'server.key'),
      '-out', path.join(cluster, 'server.crt'), '-days', '1', '-subj', '/CN=db.example.org', '-addext', 'subjectAltName=DNS:db.example.org']);
    chmodSync(path.join(cluster, 'server.key'), 0o600);
    appendFileSync(path.join(cluster, 'postgresql.conf'), `\nssl=on\nlisten_addresses='127.0.0.1'\nport=${port}\n`);
    run('pg_ctl', ['-D', cluster, '-l', path.join(dir, 'postgres.log'), '-w', 'start']); running = true;
    const ca = readFileSync(path.join(cluster, 'server.crt'));
    const admin = new pg.Client({ host: '127.0.0.1', port, database: 'postgres', user: 'fixture_admin', ssl: { rejectUnauthorized: false } });
    await admin.connect();
    await admin.query('CREATE ROLE fixture_reader LOGIN');
    await admin.query('CREATE TABLE fixture_table (id integer)');
    await admin.query('INSERT INTO fixture_table VALUES (7)');
    await admin.query('GRANT SELECT ON fixture_table TO fixture_reader'); await admin.end();
    class FixtureClient extends pg.Client {
      constructor(options) {
        const baseStream = options.stream;
        super({ ...options, ssl: { rejectUnauthorized: true, ca }, stream: () => {
          const socket = baseStream();
          // The real approved address is public. This test-only transport redirects its socket to the isolated local fixture.
          socket.connect = (targetPort) => net.Socket.prototype.connect.call(socket, targetPort, '127.0.0.1');
          return socket;
        } });
      }
    }
    const resolver = async () => [{ family: 4, address: '8.8.8.8' }];
    const settings = { host: 'db.example.org', port, database: 'postgres', username: 'fixture_reader', password: 'fixture' };
    const transport = await openResearchDb(settings, `db.example.org:${port}=8.8.8.8`, { Client: FixtureClient, resolve: resolver });
    try {
      const result = await snapshotResearchTable(transport.client, { schema: 'public', table: 'fixture_table', columns: ['id'] });
      assert.deepEqual(result.rows, [['7']]);
      assert.deepEqual((await listResearchTables(transport.client)).tables.map(table => `${table.schema}.${table.table}`), ['public.fixture_table']);
    } finally { await transport.close(); }
    await assert.rejects(openResearchDb({ ...settings, host: 'wrong.example.org' }, `wrong.example.org:${port}=8.8.8.8`, { Client: FixtureClient, resolve: resolver }), { code: 'research_db_unavailable' });
  } finally {
    if (running) run('pg_ctl', ['-D', path.join(dir, 'cluster'), '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
});
