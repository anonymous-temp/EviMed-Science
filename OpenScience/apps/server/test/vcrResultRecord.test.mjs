// A result as a short record (remediation plan D7): what it lists and what it says when it has nothing to list. No database.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_EXPORT_KINDS, VCR_RESULT_KIND_TABS } from "@evimed/domain";
import { VCR_RECORD_MAX_ASSUMPTIONS, buildResultRecord, scenarioLines } from "../src/vcrResultRecord.mjs";

const study = { id: "std_1", name: "EV-201" };
const execution = { method: "design.simulate", methodVersion: "1.3.0", seed: 777, replicates: 5000, scenarioHash: "a".repeat(64), outputHash: "b".repeat(64), environment: { engineVersion: "1.0.0" }, inputs: [] };

test("D7: the scenario is listed leaf by leaf, a default the researcher never wrote is marked, and one the scenario never held is still listed", () => {
  const lines = scenarioLines({ design: { kind: "two_arm_fixed", nTreat: 150 }, truth: { hazardRatio: 0.7, treatmentHazardRatios: { breaks: [6], ratios: [1, 0.6] } }, accrual: { dropoutAnnual: 0 }, note: "x".repeat(100) },
    [{ path: "accrual.dropoutAnnual", value: 0 }, { path: "analysis.alpha", value: 0.025 }]);
  assert.deepEqual(lines, ["design.kind = two_arm_fixed", "design.nTreat = 150", "truth.hazardRatio = 0.7", "truth.treatmentHazardRatios.breaks = [6]", "truth.treatmentHazardRatios.ratios = [1, 0.6]",
    "accrual.dropoutAnnual = 0（默认）", `note = ${"x".repeat(77)}…`, "analysis.alpha = 0.025（默认）"]);
  assert.deepEqual(scenarioLines(null), []);
});

test("D7: a simulation's record carries its example trial, seed, versions and links; the markdown is the record and the digest is of it", () => {
  const record = buildResultRecord({ study, result: { kind: "trial_scenario", version: 2, conclusion: "estimable", createdAt: "2026-11-01T10:00:00.000Z",
    diagnostics: { exampleTrial: { replicate: 1, seed: 777, values: { estimate: -0.34, p: 0.0003, reject: 1, events: 201, sampleSize: 300 } } } },
  execution, scenario: { truth: { hazardRatio: 0.7 } }, checkpoint: { replicatePlan: { reason: "备择情景的默认下限 5,000 次" } }, publicUrl: "https://app.example.org/" });
  assert.deepEqual(record.sections.map((section) => section.id), ["what", "assumptions", "versions", "example", "links"]);
  assert.equal(record.hasExampleTrial, true);
  assert.match(record.markdown, /- 结果：trial_scenario，第 2 版，可估计/);
  assert.match(record.markdown, /- 估计值：-0\.34\n- P 值：0\.0003\n- 是否拒绝零假设（1 是，0 否）：1\n- 事件数：201\n- 样本量：300/);
  assert.match(record.markdown, /- 随机种子：777\n- 重复次数：5,000（备择情景的默认下限 5,000 次）/);
  assert.match(record.markdown, /https:\/\/app\.example\.org\/app\/virtual-research\/std_1\/trial/);
  assert.equal(record.digest, buildResultRecord({ study, result: { kind: "trial_scenario", version: 2, conclusion: "estimable", createdAt: "2026-11-01T10:00:00.000Z",
    diagnostics: { exampleTrial: { replicate: 1, seed: 777, values: { estimate: -0.34, p: 0.0003, reject: 1, events: 201, sampleSize: 300 } } } },
  execution, scenario: { truth: { hazardRatio: 0.7 } }, checkpoint: { replicatePlan: { reason: "备择情景的默认下限 5,000 次" } }, publicUrl: "https://app.example.org/" }).digest, "the same result is the same record");
});

test("D7: a result that is not a simulation says it has no example trial, and a deployment with no public address links relatively", () => {
  const record = buildResultRecord({ study, result: { kind: "comparator", version: 1, conclusion: "limited", diagnostics: {} }, execution: { ...execution, method: "comparator.weighted_cox", methodVersion: "1.3.0" } });
  assert.equal(record.hasExampleTrial, false);
  assert.match(record.markdown, /这条结果不是 1\.3\.0 以上的仿真，没有示例试验。/);
  assert.match(record.markdown, /- 在“对照”页：\/app\/virtual-research\/std_1\/comparator/);
  assert.match(record.markdown, /- 这条结果没有记下场景/);
  // no execution at all (a result written some other way) is still a record, with what is known
  const bare = buildResultRecord({ study, result: { kind: "population_check", version: 1, diagnostics: {} }, execution: null });
  assert.match(bare.markdown, /- 随机种子：没有记录/);
  assert.match(bare.markdown, /“人群与患者”页/);
});

test("D7: a long scenario is cut at a fixed number of lines and says how many it left out; the domain knows the kind and the tab", () => {
  const scenario = Object.fromEntries(Array.from({ length: VCR_RECORD_MAX_ASSUMPTIONS + 7 }, (_unused, index) => [`k${index}`, index]));
  const record = buildResultRecord({ study, result: { kind: "trial_scenario", version: 1, diagnostics: {} }, execution, scenario });
  const lines = record.sections.find((section) => section.id === "assumptions").lines;
  assert.equal(lines.filter((line) => /^- k\d+ = /.test(line)).length, VCR_RECORD_MAX_ASSUMPTIONS);
  assert.ok(lines.some((line) => line.startsWith("- 还有 7 项没有列出")));
  assert.ok(VCR_EXPORT_KINDS.includes("result_record"));
  assert.equal(VCR_RESULT_KIND_TABS.population_check, "population");
});
