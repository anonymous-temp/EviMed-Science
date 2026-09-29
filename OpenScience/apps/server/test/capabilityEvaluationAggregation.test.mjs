import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readEvaluations } from "../../../scripts/build/generate-capability-manifests.mjs";

async function fixture(records, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-eval-observations-"));
  try {
    await fs.mkdir(path.join(root, "evals"));
    await fs.writeFile(path.join(root, "evals/acceptance-ledger.json"), JSON.stringify({ capabilities: [] }));
    for (const [name, record] of Object.entries(records)) {
      const directory = path.join(root, "evals/fixture/results", name);
      await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "run.json"), JSON.stringify(record));
    }
    await fn(await readEvaluations(root));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const record = (status, observedAt, extra = {}) => ({ capability: "meta-analysis", brief: "case-a", project: "p", base: "https://example.test", runId: "same-run", observedAt,
  outcome: { status, durationMs: 120000 }, ...extra });

test("reattaching pending and completed observations counts one real execution and keeps terminal evidence", async () => fixture({
  "z-pending": record("running", "2026-09-29T04:00:00Z"),
  "a-final": record("succeeded", "2026-09-29T02:00:00Z"),
  "b-run2": record("succeeded", "2026-09-29T03:00:00Z"),
}, (evaluations) => {
  assert.deepEqual(evaluations.get("meta-analysis"), { runs: 1, delivered: 1, typicalMinutes: 2 });
}));

test("terminal observations use actual completion time, not directory sort or a later stale snapshot", async () => fixture({
  "z-success": record("succeeded", "2026-09-29T05:00:00Z", { outcome: { status: "succeeded", durationMs: 120000, finishedAt: "2026-09-29T01:00:00Z" } }),
  "a-failed": record("failed", "2026-09-29T03:00:00Z", { outcome: { status: "failed", finishedAt: "2026-09-29T02:00:00Z" } }),
}, (evaluations) => { assert.deepEqual(evaluations.get("meta-analysis"), { runs: 1, delivered: 0, typicalMinutes: null }); }));

test("different executions, capabilities, cases, projects and deployments remain distinct", async () => fixture({
  a: record("succeeded", "2026-09-29T01:00:00Z"),
  b: record("succeeded", "2026-09-29T01:00:00Z", { runId: "another-run" }),
  c: record("failed", "2026-09-29T01:00:00Z", { brief: "case-b" }),
  d: record("running", "2026-09-29T01:00:00Z", { project: "other-project" }),
  e: record("failed", "2026-09-29T01:00:00Z", { base: "https://another.test" }),
  f: record("succeeded", "2026-09-29T01:00:00Z", { capability: "geo-content" }),
}, (evaluations) => {
  assert.equal(evaluations.get("meta-analysis").runs, 5);
  assert.equal(evaluations.get("meta-analysis").delivered, 2);
  assert.equal(evaluations.get("geo-content").runs, 1);
}));

test("legacy watcher timestamps resolve observations; missing execution identity never fabricates another run", async () => fixture({
  a: record("succeeded", undefined, { dispatchedAt: "2026-09-29T01:00:00Z" }),
  b: record("failed", undefined, { dispatchedAt: "2026-09-29T02:00:00Z" }),
  c: record("succeeded", "2026-09-29T03:00:00Z", { runId: null }),
}, (evaluations) => { assert.deepEqual(evaluations.get("meta-analysis"), { runs: 1, delivered: 0, typicalMinutes: null }); }));

test("equally dated conflicting terminal evidence cannot win a success from filename order", async () => fixture({
  a: record("failed", "2026-09-29T01:00:00Z"),
  z: record("succeeded", "2026-09-29T01:00:00Z"),
}, (evaluations) => { assert.equal(evaluations.get("meta-analysis").delivered, 0); }));
