import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { lockVcrLanguageStudyBasis } from '../src/vcrLanguageFence.mjs';

const socket = process.env.VCR_LANGUAGE_TEST_SOCKET;
test('PostgreSQL holds the per-study advisory fence through transaction commit', { skip: !socket && 'isolated test cluster not configured' }, async () => {
  if (!/^\/tmp\/vcr-language-pg\.[A-Za-z0-9]+$/.test(socket)) throw new Error('Dedicated local cluster socket required.');
  const config = { host: socket, port: 55487, database: 'postgres', user: process.env.USER };
  const first = new pg.Client(config), second = new pg.Client(config);
  await first.connect(); await second.connect();
  try {
    const dir = (await first.query('SHOW data_directory')).rows[0].data_directory;
    assert.equal(dir, `${socket}/data`);
    await first.query('DROP SCHEMA IF EXISTS evimed_vcr CASCADE');
    await first.query('CREATE SCHEMA evimed_vcr');
    await first.query('CREATE TABLE evimed_vcr.studies(id text PRIMARY KEY)');
    await first.query("INSERT INTO evimed_vcr.studies VALUES ('std_1')");
    await first.query('BEGIN'); await second.query('BEGIN');
    await lockVcrLanguageStudyBasis(first, 'std_1');
    const attempt = () => second.query("SELECT pg_try_advisory_xact_lock(hashtext('evimed-vcr-language-basis'),hashtext($1)) AS acquired", ['std_1']);
    assert.equal((await attempt()).rows[0].acquired, false);
    await first.query('COMMIT');
    assert.equal((await attempt()).rows[0].acquired, true);
    await second.query('ROLLBACK');
  } finally { await first.query('DROP SCHEMA IF EXISTS evimed_vcr CASCADE').catch(() => {}); await first.end(); await second.end(); }
});
