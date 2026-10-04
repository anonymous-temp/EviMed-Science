#!/usr/bin/env node
/**
 * `pnpm test:server`: the server's test files, with the integration files kept
 * apart from each other when there is a database for them.
 *
 * Hidden knowledge: an `*.integration.test.mjs` file resets, counts and leases
 * across the schema of the PostgreSQL it is given (`OPEN_SCIENCE_TEST_POSTGRES_URL`),
 * so two of them against one database deadlock each other — `node --test` runs
 * files in parallel by default, and a plain `node --test test/*.test.mjs` with
 * the URL set did exactly that. CI never meets it: the durable-state job runs
 * each integration file alone in a database of its own
 * (`scripts/ops/test-product-state.mjs`, serial), and the unit job has no URL,
 * so those files skip.
 *
 * So: with no URL, every file runs in one parallel `node --test`, as before. With
 * one, the integration files leave that run and go through a second one at
 * `--test-concurrency=1`, one file at a time against the database. Everything
 * after `pnpm test:server --` (a name pattern, a reporter) reaches both runs.
 *
 * @module runServerTests
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = new URL("../../apps/server/test/", import.meta.url);

/**
 * Split the server's test files into the parallel run and the serial one.
 * @param {readonly string[]} files names under `apps/server/test`
 * @param {{ database: boolean }} options whether a test database is configured
 * @returns {{ parallel: string[], serial: string[] }}
 */
export function partitionServerTests(files, { database }) {
  const tests = files.filter((name) => name.endsWith(".test.mjs")).sort();
  if (!database) return { parallel: tests, serial: [] };
  const isIntegration = (/** @type {string} */ name) => name.endsWith(".integration.test.mjs");
  return { parallel: tests.filter((name) => !isIntegration(name)), serial: tests.filter(isIntegration) };
}

/** @param {readonly string[]} [args] extra `node --test` arguments */
export function runServerTests(args = [], { execute = spawnSync, env = process.env } = {}) {
  const { parallel, serial } = partitionServerTests(readdirSync(testDirectory), { database: Boolean(env.OPEN_SCIENCE_TEST_POSTGRES_URL) });
  const guard = fileURLToPath(new URL("./localhostProbeGuard.mjs", import.meta.url));
  const cwd = fileURLToPath(new URL("../../apps/server/", import.meta.url));
  /** @param {readonly string[]} flags @param {readonly string[]} names */
  const run = (flags, names) => execute(process.execPath, ["--import", guard, "--test", ...flags, ...args, ...names.map((name) => `test/${name}`)], { stdio: "inherit", cwd, env }).status ?? 1;
  const statuses = [run([], parallel)];
  if (serial.length) statuses.push(run(["--test-concurrency=1"], serial));
  return statuses.find((status) => status !== 0) ?? 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = runServerTests(process.argv.slice(2));
}
