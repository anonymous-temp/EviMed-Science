#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
]);

/** Auth's legacy schema-reset test must run in a different database. */
export function productIntegrationTests() {
  return readdirSync(testRoot)
    .filter((name) => name.endsWith(".integration.test.mjs") && name !== "postgresStore.integration.test.mjs"
      && !ENGINE_BACKED_INTEGRATION_TESTS.includes(name))
    .sort().map((name) => fileURLToPath(new URL(name, testRoot)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let url;
  try { url = new URL(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? ""); }
  catch { throw new Error("Product integration requires a valid test database URL."); }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) || !url.pathname.includes("evimed_test")) {
    throw new Error("Product integration requires an explicitly configured loopback test database.");
  }
  const tests = productIntegrationTests();
  if (tests.length === 0) throw new Error("No product integration tests were found.");
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], { stdio: "inherit", env: process.env });
  process.exitCode = result.status ?? 1;
}
