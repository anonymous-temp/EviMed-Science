// A PostgreSQL database of one test file's own, next to the configured test
// database: node runs test files in parallel, and a GEO suite that drops,
// truncates or counts across the schema must never see another suite's rows
// (the measurement suite's pattern, geoMeasure.integration.test.mjs).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Create `<test database>_<label>_<8 hex>` and hand back its URL and the way to
 * drop it. Refuses anything but a local `evimed_test` database.
 * @param {string} databaseUrl the configured OPEN_SCIENCE_TEST_POSTGRES_URL
 * @param {string} label a short lowercase tag naming the suite
 * @returns {Promise<{ url: string, name: string, drop: () => Promise<void> }>}
 */
export async function createGeoTestDatabase(databaseUrl, label) {
  const source = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(source.hostname), "a test database is local");
  const name = `${decodeURIComponent(source.pathname.slice(1))}_${label}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(name, /^evimed_test[a-z0-9_]*$/);
  assert.ok(name.length <= 63, "PostgreSQL names are at most 63 bytes");
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  source.pathname = `/${name}`;
  return {
    url: source.href,
    name,
    async drop() {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
