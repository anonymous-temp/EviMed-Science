#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const testRoot = new URL("../../apps/server/test/", import.meta.url);

/** Auth's legacy schema-reset test must run in a different database. */
export function productIntegrationTests() {
  return readdirSync(testRoot)
    .filter((name) => name.endsWith(".integration.test.mjs") && name !== "postgresStore.integration.test.mjs")
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
