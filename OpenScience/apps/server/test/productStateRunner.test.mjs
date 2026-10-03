import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { productIntegrationTests, runProductIntegrationTests } from '../../../scripts/ops/test-product-state.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const databaseUrl = 'postgresql://fixture@127.0.0.1/evimed_test_product';
const file = name => productIntegrationTests().find(value => path.basename(value) === name);
function fixture() {
  const queries = [], invocations = [];
  let closed = false;
  return {
    queries, invocations, closed: () => closed,
    createClient: () => ({ connect: async () => {}, query: async sql => { queries.push(sql); }, end: async () => { closed = true; } }),
    execute: (command, args, options) => { invocations.push({ command, args, options }); return { status: invocations.length === 2 ? 1 : 0 }; },
  };
}

test('product suites receive separate databases and failed files still release only their owned database', async () => {
  const f = fixture();
  const tests = [file('extensionGenerationService.integration.test.mjs'), file('extensionPreparationWorker.integration.test.mjs'), file('productStore.integration.test.mjs')];
  const results = await runProductIntegrationTests({ databaseUrl, tests, createClient: f.createClient, execute: f.execute });
  assert.deepEqual(results.map(row => row.exitCode), [0, 1, 0]);
  const names = f.invocations.map(row => new URL(row.options.env.OPEN_SCIENCE_TEST_POSTGRES_URL).pathname.slice(1));
  assert.equal(new Set(names).size, 3);
  assert.match(names[0], /^evimed_test_product_[a-f0-9]{12}$/);
  assert.ok((names[0] + "_extgenroles_" + "a".repeat(8)).length <= 63, "nested generation fixture stays within the PostgreSQL identifier limit");
  assert.match(names[1], /^evimed_test_extension_worker_[a-f0-9]{12}$/);
  assert.match(names[2], /^evimed_test_product_[a-f0-9]{12}$/);
  assert.deepEqual(f.queries, names.flatMap(name => [`CREATE DATABASE "${name}"`, `DROP DATABASE "${name}" WITH (FORCE)`]));
  for (const row of f.invocations) { assert.equal(row.options.timeout, 210000); assert(row.args.includes('--test-concurrency=1')); }
  assert(f.closed());
});

test('foreign URLs and arbitrary test programs are refused before connecting', async () => {
  const createClient = () => assert.fail('untrusted inputs must not open an administrative connection');
  for (const url of ['postgresql://fixture@example.org/evimed_test', 'postgresql://fixture@127.0.0.1/production',
    'postgresql://fixture@127.0.0.1/evimed_test?host=example.invalid',
    'postgresql://fixture@127.0.0.1/evimed_test?sslkey=/unowned/private.key',
    'postgresql://fixture@127.0.0.1/evimed_test#untrusted', 'https://127.0.0.1/evimed_test']) {
    await assert.rejects(runProductIntegrationTests({ databaseUrl: url, createClient }));
  }
  await assert.rejects(runProductIntegrationTests({ databaseUrl, tests: ['/tmp/unowned.test.mjs'], createClient }));
});

test('a start failure closes the child database and administrator connection', async () => {
  const f = fixture();
  await assert.rejects(runProductIntegrationTests({ databaseUrl, tests: [file('productStore.integration.test.mjs')], createClient: f.createClient,
    execute: () => { throw new Error('fixture spawn failure'); } }), /fixture spawn failure/);
  assert.equal(f.queries.length, 2); assert.match(f.queries[1], /^DROP DATABASE "evimed_test_product_[a-f0-9]{12}" WITH \(FORCE\)$/);
  assert(f.closed());
});

test('failed creation never drops an existing database', async () => {
  const queries = []; let ended = false;
  await assert.rejects(runProductIntegrationTests({ databaseUrl, tests: [file('productStore.integration.test.mjs')],
    createClient: () => ({ connect: async () => {}, query: async sql => { queries.push(sql); throw new Error('creation refused'); }, end: async () => { ended = true; } }),
    execute: () => assert.fail('no child may start after failed creation') }), /creation refused/);
  assert.equal(queries.length, 1); assert(queries[0].startsWith('CREATE DATABASE')); assert(ended);
});

test('the shared isolated-database helper rejects hidden endpoint and TLS-file parameters before connecting', async () => {
  for (const suffix of ['?host=example.invalid', '?sslkey=/unowned/private.key', '#untrusted']) {
    await assert.rejects(createGeoTestDatabase(databaseUrl + suffix, 'guard'), /parameters cannot override/);
  }
  await assert.rejects(createGeoTestDatabase('https://127.0.0.1/evimed_test', 'guard'), /parameters cannot override/);
});

test('the shared helper closes its administrator after failed creation without dropping unconfirmed state', async t => {
  const queries = []; let ended = false;
  t.mock.method(pg.Client.prototype, 'connect', async () => {});
  t.mock.method(pg.Client.prototype, 'query', async sql => { queries.push(sql); throw new Error('fixture create refused'); });
  t.mock.method(pg.Client.prototype, 'end', async () => { ended = true; });
  await assert.rejects(createGeoTestDatabase(databaseUrl, 'guard'), /fixture create refused/);
  assert.equal(queries.length, 1); assert(queries[0].startsWith('CREATE DATABASE')); assert(ended);
});
