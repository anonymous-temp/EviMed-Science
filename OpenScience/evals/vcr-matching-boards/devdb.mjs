/**
 * The scratch PostgreSQL a runner works in: a local `evimed_test_*` database, created when it is missing, and one runner at a time
 * per database (a session advisory lock), because the job queue hands any claimant any queued job and two runners with different
 * settings must not take each other's.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import { fail } from './board_cases.mjs';

// `pg` lives with the server package, not at the workspace root.
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const pg = require('pg');

export const DEFAULT_DB_NAME = 'evimed_test_vmdev';
const NAME = /^evimed_test_[a-z0-9_]{1,40}$/u;
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The URL of a named scratch database, from the server URL a deployment of tests already uses (`OPEN_SCIENCE_TEST_POSTGRES_URL`)
 * or the local default (port 55433, the current user).
 * @param {{ serverUrl?: string | null, name?: string }} [options]
 */
export function scratchUrl({ serverUrl = null, name = DEFAULT_DB_NAME } = {}) {
  if (!NAME.test(name)) throw fail('A scratch database is named evimed_test_ followed by lowercase letters, digits and underscores.', 'db_name_invalid');
  const url = new URL(serverUrl || `postgres://${encodeURIComponent(os.userInfo().username)}@127.0.0.1:55433/postgres`);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) throw fail('The database URL is a plain postgres URL.', 'db_url_invalid');
  if (!LOCAL.has(url.hostname)) throw fail('A scratch database is local.', 'db_not_local');
  url.pathname = `/${name}`;
  return url.href;
}

/** Create the database when it is missing. Returns whether it was created. @param {string} databaseUrl */
export async function ensureDatabase(databaseUrl) {
  const target = new URL(databaseUrl);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!NAME.test(name) || !LOCAL.has(target.hostname)) throw fail('Only a local evimed_test_* database is created.', 'db_name_invalid');
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.href, application_name: 'vcr-boards-dev-job-admin' });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount) return false;
    await client.query(`CREATE DATABASE "${name}"`);
    return true;
  } finally {
    await client.end();
  }
}

/** Drop a database made for one test. @param {string} databaseUrl */
export async function dropDatabase(databaseUrl) {
  const target = new URL(databaseUrl);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!NAME.test(name) || !LOCAL.has(target.hostname)) throw fail('Only a local evimed_test_* database is dropped.', 'db_name_invalid');
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.href, application_name: 'vcr-boards-dev-job-admin' });
  await client.connect();
  try { await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await client.end(); }
}

/**
 * Hold the runner's lock on a database for as long as the returned handle is open. A second runner on the same database is told so.
 * @param {string} databaseUrl
 * @returns {Promise<{ release: () => Promise<void> }>}
 */
export async function takeRunnerLock(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'vcr-boards-dev-job-lock' });
  await client.connect();
  const locked = await client.query("SELECT pg_try_advisory_lock(hashtext('vcr-boards-dev-job')) AS ok");
  if (!locked.rows[0]?.ok) {
    await client.end();
    throw fail('Another dev_job run is using this database. Run one arm at a time here, or give the second its own --db-name.', 'db_in_use');
  }
  return { release: async () => { try { await client.query("SELECT pg_advisory_unlock(hashtext('vcr-boards-dev-job'))"); } finally { await client.end(); } } };
}
