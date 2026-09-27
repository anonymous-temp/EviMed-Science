// Whether the learning loop is turning, as numbers (build spec §13; audit
// 2026-09-26, L-G5): until this existed the loop's counters were names in
// comments, and M5's 「学习看板四个计数都不为零」 could not be checked.
import assert from "node:assert/strict";
import test from "node:test";

import { LearningMetrics, learningLedgerCounts, learningMetricFamilies, learningSummary } from "../src/learningMetrics.mjs";

/** A database that answers the three reads by what they select, and records who asked. */
function ledger({ usageFails = false } = {}) {
  /** @type {{sql: string, values: any[]}[]} */
  const queries = [];
  return {
    queries,
    async query(/** @type {string} */ sql, /** @type {any[]} */ values) {
      queries.push({ sql, values });
      if (sql.includes("FROM evimed_product.documents")) {
        return { rows: [
          { record_type: "learned-method", status: "approved", n: 2, loaded: 9, invoked: 3, succeeded: 8, read: 1 },
          { record_type: "learned-method", status: "retired", n: 1, loaded: 0, invoked: 0, succeeded: 0, read: 0 },
          { record_type: "handbook-candidate", status: "candidate", n: 2, loaded: 0, invoked: 0, succeeded: 0, read: 0 },
        ] };
      }
      if (sql.includes("FROM evimed_product.jobs")) {
        return { rows: [
          { trigger: "repair_accepted", status: "succeeded", n: 2, operation: "handbook" },
          { trigger: "repair_accepted", status: "succeeded", n: 1, operation: "amend" },
          { trigger: "delivered", status: "succeeded", n: 3, operation: "no_change" },
          { trigger: "delivered", status: "queued", n: 1, operation: "" },
          { trigger: "correction", status: "failed", n: 1, operation: "" },
          { trigger: "something-new", status: "succeeded", n: 1, operation: "publish" },
        ] };
      }
      if (sql.includes("FROM evimed_usage.model_requests")) {
        if (usageFails) throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
        return { rows: [{ settled: "1.25", open: "0.5" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test("the durable counts come from the ledger in closed vocabularies, across every account or one", async () => {
  const database = ledger();
  const counts = await learningLedgerCounts(database, { now: new Date("2026-09-27T00:00:00.000Z") });
  assert.deepEqual(counts.methods, { candidate: 0, approved: 2, retired: 1 });
  assert.deepEqual(counts.uses, { loaded: 9, invoked: 3, succeeded: 8, read: 1 });
  assert.equal(counts.handbookCandidates, 2, "the reviewer's lessons are counted apart from the researcher's methods");
  assert.equal(counts.lessons.delivered.queued, 1);
  assert.equal(counts.lessons.delivered.succeeded, 3);
  assert.equal(counts.lessons.other.succeeded, 1, "a trigger nobody named is `other`, never a new label");
  assert.deepEqual(counts.results, { create: 0, amend: 1, merge: 0, no_change: 3, handbook: 2, other: 1 });
  assert.deepEqual(counts.spend, { settled: 1.25, open: 0.5 });
  assert.ok(database.queries.every((query) => query.values.includes(null)), "no account named is every account");

  const scoped = ledger();
  await learningLedgerCounts(scoped, { userId: "u1" });
  assert.ok(scoped.queries.every((query) => query.values.includes("u1")), "one account's counts are read as that account's");

  const noUsage = await learningLedgerCounts(ledger({ usageFails: true }));
  assert.equal(noUsage.spend, null, "a usage schema this deployment never made costs the spend, not the rest");
  assert.equal(noUsage.methods.approved, 2);
});

test("an account's summary for its method list says what the loop did for it", async () => {
  const summary = await learningSummary(ledger(), "u1");
  assert.deepEqual(summary.methods, { candidate: 0, approved: 2, retired: 1 });
  assert.deepEqual(summary.lessons, {
    byTrigger: { repair_accepted: 3, delivered: 4, correction: 1, other: 1 },
    succeeded: 7, failed: 1,
  });
  assert.equal(summary.spend24hCny, 1.25);
  assert.equal(summary.handbookCandidates, 2);
});

test("launches and runs count what they carried, and the families expose all of it", async () => {
  const counters = new LearningMetrics();
  counters.observeMount({ methods: 2, bytes: 1_500 });
  counters.observeMount({ methods: 0, bytes: 0 });
  counters.observeRun({ loaded: 2, invoked: 1 });
  counters.observeRun({ loaded: 0, invoked: 0 });
  const counts = await learningLedgerCounts(ledger());
  const families = learningMetricFamilies(true, counts, counters);
  const byName = new Map(families.map((family) => [family.name, family]));
  for (const name of [
    "open_science_learning_enabled", "open_science_learning_ledger_up", "open_science_learning_methods",
    "open_science_learning_handbook_candidates", "open_science_learning_method_uses", "open_science_learning_distill_jobs",
    "open_science_learning_distill_results", "open_science_learning_spend_cny", "open_science_learning_mounts_total",
    "open_science_learning_mounted_methods_total", "open_science_learning_mounted_bytes_total",
    "open_science_learning_runs_with_methods_total", "open_science_learning_run_methods_total",
  ]) assert.ok(byName.has(name), `${name} is exposed`);
  assert.deepEqual(byName.get("open_science_learning_mounts_total")?.series.map((sample) => sample.value), [1, 1]);
  assert.equal(byName.get("open_science_learning_mounted_bytes_total")?.series[0].value, 1_500);
  assert.deepEqual(byName.get("open_science_learning_run_methods_total")?.series.map((sample) => sample.value), [2, 1]);
  assert.equal(byName.get("open_science_learning_runs_with_methods_total")?.series[0].value, 1, "a run that carried nothing is not counted");
  // Every label is from a closed set.
  for (const family of families) {
    for (const sample of family.series) {
      for (const [key, value] of Object.entries(sample.labels ?? {})) {
        assert.match(String(value), /^[a-z0-9_]+$/, `${family.name} ${key}=${value}`);
      }
    }
  }
  // A ledger that could not be read says so, and the process counters stand.
  const down = new Map(learningMetricFamilies(true, null, counters).map((family) => [family.name, family]));
  assert.equal(down.get("open_science_learning_ledger_up")?.series[0].value, 0);
  assert.ok(!down.has("open_science_learning_methods"));
  assert.ok(down.has("open_science_learning_mounts_total"));
  // Off is one line.
  assert.deepEqual(learningMetricFamilies(false, null, counters).map((family) => family.name), ["open_science_learning_enabled"]);
});
