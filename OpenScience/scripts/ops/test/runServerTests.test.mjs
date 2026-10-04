// `pnpm test:server` never runs two integration files against one database.
//
// Integration files reset, count and lease across the schema of the PostgreSQL
// they are given, so two at once deadlock. CI runs them one per database
// (`scripts/ops/test-product-state.mjs`); `pnpm test:server` with
// OPEN_SCIENCE_TEST_POSTGRES_URL set used to hand them all to one parallel
// `node --test`.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { partitionServerTests, runServerTests } from "../../test/runServerTests.mjs";

const files = ["agentRuns.test.mjs", "pluginService.integration.test.mjs", "server.test.mjs", "sourceApp.integration.test.mjs", "helpers", "notATest.mjs"];

test("without a database every test file runs in the one parallel run, as before", () => {
  assert.deepEqual(partitionServerTests(files, { database: false }), {
    parallel: ["agentRuns.test.mjs", "pluginService.integration.test.mjs", "server.test.mjs", "sourceApp.integration.test.mjs"], serial: [],
  });
});

test("with a database the integration files leave the parallel run and go one at a time", () => {
  assert.deepEqual(partitionServerTests(files, { database: true }), {
    parallel: ["agentRuns.test.mjs", "server.test.mjs"], serial: ["pluginService.integration.test.mjs", "sourceApp.integration.test.mjs"],
  });
});

test("the real server tests are all in one run or the other, never both and never neither", () => {
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/server/test");
  const names = readdirSync(directory);
  for (const database of [false, true]) {
    const { parallel, serial } = partitionServerTests(names, { database });
    const together = [...parallel, ...serial];
    assert.equal(new Set(together).size, together.length, "no file twice");
    assert.deepEqual(together.sort(), names.filter((name) => name.endsWith(".test.mjs")).sort());
  }
});

test("the serial run is one `--test-concurrency=1` invocation after the parallel one, and the extra arguments reach both", () => {
  /** @type {{ args: string[], env: any }[]} */
  const runs = [];
  const execute = (/** @type {string} */ _bin, /** @type {string[]} */ args, /** @type {any} */ options) => { runs.push({ args, env: options.env }); return { status: 0 }; };
  assert.equal(runServerTests(["--test-name-pattern=metrics"], { execute: /** @type {any} */ (execute), env: { OPEN_SCIENCE_TEST_POSTGRES_URL: "postgresql://postgres@127.0.0.1/evimed_test_product" } }), 0);
  assert.equal(runs.length, 2);
  assert.ok(!runs[0].args.includes("--test-concurrency=1"));
  assert.ok(!runs[0].args.some((arg) => arg.endsWith(".integration.test.mjs")), "no integration file in the parallel run");
  assert.ok(runs[1].args.includes("--test-concurrency=1"));
  assert.ok(runs[1].args.filter((arg) => arg.startsWith("test/")).every((arg) => arg.endsWith(".integration.test.mjs")));
  for (const run of runs) assert.ok(run.args.includes("--test-name-pattern=metrics"));
  // Without a database: one run.
  runs.length = 0;
  runServerTests([], { execute: /** @type {any} */ (execute), env: {} });
  assert.equal(runs.length, 1);
});

test("a failing run is the exit status, whichever of the two it was", () => {
  for (const [first, second] of [[1, 0], [0, 1], [0, 0]]) {
    const statuses = [first, second];
    const execute = () => ({ status: statuses.shift() });
    assert.equal(runServerTests([], { execute: /** @type {any} */ (execute), env: { OPEN_SCIENCE_TEST_POSTGRES_URL: "postgresql://x" } }), first || second);
  }
});

test("the durable-state runner says it is serial, one database per file", () => {
  const header = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../test-product-state.mjs"), "utf8").slice(0, 1_500);
  assert.match(header, /Serial by construction/);
  assert.match(header, /one at a time, each alone in a PostgreSQL database/);
});
