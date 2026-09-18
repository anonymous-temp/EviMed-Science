// What a run has spent, as a run record carries it (C3 `usage`).
import assert from "node:assert/strict";
import test from "node:test";

import { runUsageFrom } from "../src/server.mjs";

test("a run's usage is read under its own id and, for a bounded run, its dispatch id, and added", () => {
  const summaries = new Map([
    ["run_1", { requests: 3, inputTokens: 1000, cachedInputTokens: 600, outputTokens: 90, costCny: 0.012 }],
    ["episode-1", { requests: 2, inputTokens: 400, cachedInputTokens: 100, outputTokens: 30, costCny: 0.004 }],
  ]);
  assert.deepEqual(runUsageFrom(summaries, { id: "run_1", dispatchId: "episode-1" }),
    { requests: 5, inputTokens: 1400, cachedInputTokens: 700, outputTokens: 120, costCny: 0.016 });
  assert.deepEqual(runUsageFrom(summaries, { id: "run_1", dispatchId: "run_1" }),
    { requests: 3, inputTokens: 1000, cachedInputTokens: 600, outputTokens: 90, costCny: 0.012 }, "one id is read once");
  assert.equal(runUsageFrom(summaries, { id: "run_unused", dispatchId: null }), null, "nothing attributed is no usage, not a zero");
});

test("a run that began before calls were attributed shows no cost rather than a part of it", () => {
  // The owner's aspirin run started 2026-09-17 23:46 and spent about ¥3.31
  // unattributed; the only attributed call came the next evening. Its sum
  // (¥0.02) is not the run's cost.
  const summaries = new Map([
    ["run_old", { requests: 1, inputTokens: 2192, cachedInputTokens: 0, outputTokens: 4029, costCny: 0.018, firstRequestAt: "2026-09-18T19:05:00.000Z" }],
    ["run_new", { requests: 60, inputTokens: 900000, cachedInputTokens: 800000, outputTokens: 20000, costCny: 0.32, firstRequestAt: "2026-09-18T19:02:03.000Z" }],
  ]);
  assert.equal(runUsageFrom(summaries, { id: "run_old", startedAt: "2026-09-17T23:46:17.000Z" }), null);
  assert.equal(runUsageFrom(summaries, { id: "run_new", startedAt: "2026-09-18T19:01:56.000Z" }).costCny, 0.32);
  assert.equal(runUsageFrom(summaries, { id: "run_new" }).requests, 60, "no start time, nothing to compare");
});
