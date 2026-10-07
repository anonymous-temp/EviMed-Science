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
 * A test that never ends must fail by name, in minutes. On 2026-10-04 a release
 * candidate's job ran out its whole 75 minutes on one test: it froze `Date.now`
 * and reached a wait loop that only the clock ends. `node --test` has no
 * default timeout, so both runs carry `--test-timeout` (per test,
 * `OPEN_SCIENCE_TEST_TIMEOUT_MS`, five minutes unless set; a test's own
 * `timeout` option still wins, so the engine-backed ones keep theirs).
 *
 * They no longer carry `--test-force-exit`. Beside `--test-timeout` it ended a
 * file part-way through, at random, and reported the tests it had run as the
 * whole file: on 2026-10-07 `evolutionCore.test.mjs` ran 16, 23, 25, 33 or 38 of
 * its 38 tests on Node 22.22 and 24.18, every run green, and a full local run
 * counted 13 fewer tests than the same tree without the flag. A file whose event
 * loop stays busy after its tests is caught instead by a bound on the whole run
 * (`OPEN_SCIENCE_TEST_RUN_TIMEOUT_MS`, 45 minutes unless set): the run is killed
 * and fails with that said, and the per-test timeout has already named any test
 * that did not end. Without the flag the full server suite ends on its own today.
 *
 * @module runServerTests
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = new URL("../../apps/server/test/", import.meta.url);

/** How long one test may run before it is cancelled and reported by name. */
export const DEFAULT_TEST_TIMEOUT_MS = 300_000;
/** How long one `node --test` run may take before it is killed and fails. */
export const DEFAULT_RUN_TIMEOUT_MS = 2_700_000;

/** @param {string | undefined} raw @param {number} fallback */
const positiveInteger = (raw, fallback) => {
  const configured = Number(raw);
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
};

/**
 * The flags that keep a hung test from holding the run.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function hangGuardFlags(env) {
  return [`--test-timeout=${positiveInteger(env.OPEN_SCIENCE_TEST_TIMEOUT_MS, DEFAULT_TEST_TIMEOUT_MS)}`];
}

/** @param {Record<string, string | undefined>} env */
export function runTimeoutMs(env) {
  return positiveInteger(env.OPEN_SCIENCE_TEST_RUN_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS);
}

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
  const timeout = runTimeoutMs(env);
  const run = (flags, names) => {
    const result = execute(process.execPath, ["--import", guard, "--test", ...hangGuardFlags(env), ...flags, ...args, ...names.map((name) => `test/${name}`)],
      { stdio: "inherit", cwd, env, timeout, killSignal: "SIGKILL" });
    if (result.status === null) {
      console.error(`server tests: the run did not end within ${Math.round(timeout / 60_000)} minutes and was stopped — a test file kept its event loop busy after its tests (any test that itself did not end is named above).`);
    }
    return result.status ?? 1;
  };
  const statuses = [run([], parallel)];
  if (serial.length) statuses.push(run(["--test-concurrency=1"], serial));
  return statuses.find((status) => status !== 0) ?? 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = runServerTests(process.argv.slice(2));
}
