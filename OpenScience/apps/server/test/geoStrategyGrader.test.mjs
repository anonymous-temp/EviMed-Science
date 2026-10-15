// The deterministic grader of `evals/geo-strategy` (briefs 005–008): the platform's own functions over a stored strategy file.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { gradeStrategyFile } from "../../../evals/geo-strategy/check-actions.mjs";

const gaps = [
  { gapId: "GAP-01", groupId: "g1", pool: "P4", class: "只讲获益不讲安全", handoff: "content", rank: 1, judgment: "红旗覆盖不全" },
  { gapId: "GAP-02", groupId: "g2", pool: "P2", class: "丢条件", handoff: "content", rank: 2, judgment: "没提停药后的条件" },
  { gapId: "GAP-03", groupId: "g3", pool: "P1", class: "讲错", handoff: "EC", rank: 3, judgment: "讲错" },
  { gapId: "GAP-04", groupId: "g4", pool: "P2", class: "信源弱", handoff: "monitor_only", judgment: "只监测" },
];
const actions = [
  { gapId: "GAP-01", what: { layer: "qa", channel: "wechat_mp" }, engines: ["deepseek"], promise: "coverage_complete", metricId: "M-15", basis: "红旗覆盖 58/87" },
  { gapId: "GAP-02", what: { layer: "popular", channel: "media_market" }, promise: "raise_mention", metricId: "M-01", basis: "样本不足，沿用方法" },
  { gapId: "GAP-03", reason: "由纠错稿处理" },
];

test("a strategy whose every gap is answered, whose metrics are the pools' and whose numbers have their basis passes all four cases", () => {
  const graded = gradeStrategyFile({ gaps, actions });
  assert.deepEqual(graded.cases, { everyGapAnswered: true, metricInPool: true, noTargetWithoutBasis: true, nothingDroppedUndecided: true });
  assert.deepEqual(graded.counts, { gaps: 4, actions: 3 });
});

test("each case fails on its own defect and names it", () => {
  const without = gradeStrategyFile({ gaps, actions: actions.slice(0, 1) });
  assert.equal(without.cases.everyGapAnswered, false);
  assert.deepEqual(without.notices.filter((notice) => notice.code === "gap_without_action").map((notice) => notice.gapId), ["GAP-02", "GAP-03"], "the monitor-only gap needs none");
  const metric = gradeStrategyFile({ gaps, actions: [{ ...actions[0], metricId: "M-01" }, ...actions.slice(1)] });
  assert.equal(metric.cases.metricInPool, false, "M-01 is not P4's metric");
  const typed = gradeStrategyFile({ gaps, actions: [{ ...actions[0], target: 80, basis: undefined }, ...actions.slice(1)] });
  assert.equal(typed.cases.noTargetWithoutBasis, false);
  const dropped = gradeStrategyFile({ gaps: [{ ...gaps[0], zzzNotAField: 1 }, ...gaps.slice(1)], actions });
  assert.equal(dropped.cases.nothingDroppedUndecided, false);
  assert.deepEqual(dropped.dropped, ["gaps[0].zzzNotAField"]);
});

test("the two stored production runs predate actions: nothing of theirs is dropped undecided, and no gap of theirs was answered", async () => {
  const root = new URL("../../../evals/geo-strategy/results/", import.meta.url).pathname;
  let graded = 0;
  for (const run of await readdir(root)) {
    const file = path.join(root, run, "deliverable/deliverables/geo-strategy/strategy.json");
    let text;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    const result = gradeStrategyFile(JSON.parse(text));
    assert.equal(result.cases.nothingDroppedUndecided, true, `${run}: ${result.dropped.join(", ")}`);
    assert.equal(result.cases.everyGapAnswered, false, `${run} has no actions[]`);
    graded += 1;
  }
  assert.ok(graded >= 2, `expected both stored runs, graded ${graded}`);
});
