#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const testRoot = new URL("../../apps/server/test/", import.meta.url);

/**
 * Integration tests that need more than a PostgreSQL: the vcr engine's R
 * library and Python service, which the durable-state job does not have. They
 * run in the workflow's `vcr-seam` job, where a missing R is a red job — here,
 * without R, they would skip and read as green. A walk assertion
 * (`vcrCiWorkflow.test.mjs`) fails if another integration test starts R or the
 * service and is not named here.
 */
export const ENGINE_BACKED_INTEGRATION_TESTS = Object.freeze([
  "vcrEngineContract.integration.test.mjs",
  "vcrIntake.integration.test.mjs",
  "resultReplayLifecycle.integration.test.mjs",
]);

/** Auth's legacy schema-reset test must run in a different database. */
export function productIntegrationTests() {
  return readdirSync(testRoot)
    .filter((name) => name.endsWith(".integration.test.mjs") && name !== "postgresStore.integration.test.mjs"
      && !ENGINE_BACKED_INTEGRATION_TESTS.includes(name))
    .sort().map((name) => fileURLToPath(new URL(name, testRoot)));
}

/** Each suite may count, reset or lease across its schema; never share that state with another file. */
export async function runProductIntegrationTests({ databaseUrl, tests = productIntegrationTests(), execute = spawnSync, createClient = null }) {
  let url;
  try { url = new URL(databaseUrl ?? ""); }
  catch { throw new Error("Product integration requires a valid test database URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/^\/evimed_test[a-z0-9_]*$/.test(url.pathname)) {
    throw new Error("Product integration requires an explicitly configured loopback test database.");
  }
  const inventory = new Set(productIntegrationTests());
  if (!tests.length || new Set(tests).size !== tests.length || tests.some(file => !inventory.has(file))) throw new Error("Invalid product integration inventory.");
  const { Client } = createRequire(new URL("../../apps/server/package.json", import.meta.url))("pg");
  const admin = createClient ? createClient(url.href) : new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const results = [];
  try {
    await admin.connect();
    for (const file of tests) {
      const filename = path.basename(file);
      const prefix = filename === "extensionPreparationWorker.integration.test.mjs" ? "evimed_test_extension_worker" : "evimed_test_product";
      const name = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      await admin.query(`CREATE DATABASE "${name}"`);
      try {
        const isolated = new URL(url); isolated.pathname = `/${name}`;
        const result = execute(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=180000", file], {
          stdio: "inherit", env: { ...process.env, OPEN_SCIENCE_TEST_POSTGRES_URL: isolated.href }, timeout: 210000,
        });
        results.push({ file: filename, exitCode: result.status ?? 1 });
      } finally { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    }
  } finally { await admin.end(); }
  return results;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const results = await runProductIntegrationTests({ databaseUrl: process.env.OPEN_SCIENCE_TEST_POSTGRES_URL });
  process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
}
