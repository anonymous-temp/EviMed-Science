// Every recurring job in server.mjs is started from a timer under `void`, so a
// rejection that escapes its chain is an unhandled rejection, and Node makes
// that fatal. On 2026-09-09 the autopilot scheduler's catch rethrew a Postgres
// connection timeout and the whole control plane died mid-run. The schedulers
// are not reachable from a unit test without a live Postgres, so this reads
// the source: each `maintenanceMutation(...)` chain must have a catch, and no
// catch may rethrow.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("no timer-driven maintenance chain rethrows from its catch", async () => {
  const source = await readFile(path.join(here, "../src/server.mjs"), "utf8");
  // The wrapper's own definition, then one assignment per recurring job.
  const chains = [...source.matchAll(/^\s*(\w+) = maintenanceMutation\(([\s\S]*?)\.finally\(/gm)];
  assert.ok(chains.length >= 5, `expected the five recurring jobs, found ${chains.length}`);
  for (const [, name, chain] of chains) {
    assert.match(chain, /\.catch\(/, `${name} has no catch: a rejection there is fatal to the process`);
    assert.doesNotMatch(chain, /throw error/, `${name} rethrows from its catch, which a timer under void turns into a crash`);
  }
});

test("the entrypoint keeps an unhandled rejection off the process", async () => {
  const source = await readFile(path.join(here, "../src/index.mjs"), "utf8");
  assert.match(source, /process\.on\("unhandledRejection"/);
});
