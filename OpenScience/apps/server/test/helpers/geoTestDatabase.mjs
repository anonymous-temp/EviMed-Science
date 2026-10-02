// A PostgreSQL database of one test file's own, next to the configured test
// database: node runs test files in parallel, and a GEO suite that drops,
// truncates or counts across the schema must never see another suite's rows
// (the measurement suite's pattern, geoMeasure.integration.test.mjs).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Create a bounded `<test database>_<label>_<8 hex>` name and hand back its URL and the way to
 * drop it. Refuses anything but a local `evimed_test` database.
 * @param {string} databaseUrl the configured OPEN_SCIENCE_TEST_POSTGRES_URL
 * @param {string} label a short lowercase tag naming the suite
 * @returns {Promise<{ url: string, name: string, close: () => Promise<void>, drop: () => Promise<void> }>}
 */
export async function createGeoTestDatabase(databaseUrl, label) {
  const source = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(source.protocol) && !source.search && !source.hash,
    "test database parameters cannot override the endpoint or read TLS files");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(source.hostname), "a test database is local");
  const base = decodeURIComponent(source.pathname.slice(1));
  assert.match(base, /^evimed_test[a-z0-9_]*$/);
  assert.ok(base.length <= 63, "PostgreSQL names are at most 63 bytes");
  assert.match(label, /^[a-z0-9_]+$/);
  // The product runner already isolates each suite. Leave room for another
  // independent suffix when that suite creates a database of its own.
  const name = `${`${base}_${label}`.slice(0, 54)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = new pg.Client({ connectionString: databaseUrl, application_name:`evimed-isolated-${name}` });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (error) {
    try { await admin.end(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Isolated database creation and connection cleanup failed."); }
    throw error;
  }
  source.pathname = `/${name}`;
  let closed=false,closing=null;
  const close=async()=>{
    if(closed)return;if(closing)return closing;
    closing=admin.end().then(()=>{closed=true;}).finally(()=>{closing=null;});return closing;
  };
  return {
    url: source.href,
    name,
    close,
    async drop() {
      // A staged fixture may close its retained admin handle while preserving the DB for a later explicit stage.
      const cleanup=closed?new pg.Client({connectionString:databaseUrl}):admin;
      try {
        if(closed)await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        if(closed)await cleanup.end();else await close();
      }
    },
  };
}
