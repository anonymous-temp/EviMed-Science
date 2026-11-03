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
  execution, scenario: { truth: { hazardRatio: 0.7 } }, checkpoint: { replicatePlan: { floor: 5000, basis: "default", intendedUse: "exploratory", targetMcse: null } }, publicUrl: "https://app.example.org/" });
  assert.deepEqual(record.sections.map((section) => section.id), ["what", "assumptions", "versions", "example", "links"]);
  assert.equal(record.hasExampleTrial, true);
  assert.match(record.markdown, /- 结果：trial_scenario，第 2 版，可估计/);
  assert.match(record.markdown, /- 估计值：-0\.34\n- P 值：0\.0003\n- 是否拒绝零假设（1 是，0 否）：1\n- 事件数：201\n- 样本量：300/);
  assert.match(record.markdown, /- 随机种子：777\n- 重复次数：5,000（备择情景的默认下限 5,000 次）/);
  assert.match(record.markdown, /https:\/\/app\.example\.org\/app\/virtual-research\/std_1\/trial/);
  assert.equal(record.digest, buildResultRecord({ study, result: { kind: "trial_scenario", version: 2, conclusion: "estimable", createdAt: "2026-11-01T10:00:00.000Z",
    diagnostics: { exampleTrial: { replicate: 1, seed: 777, values: { estimate: -0.34, p: 0.0003, reject: 1, events: 201, sampleSize: 300 } } } },
  execution, scenario: { truth: { hazardRatio: 0.7 } }, checkpoint: { replicatePlan: { floor: 5000, basis: "default", intendedUse: "exploratory", targetMcse: null } }, publicUrl: "https://app.example.org/" }).digest, "the same result is the same record");
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

test("P1-6 the record reads a result in the class the page reads it in, and says what it is to be read with", () => {
  const read = (/** @type {Record<string, any>} */ over, /** @type {Record<string, any>} */ extra = {}) => buildResultRecord({ study, execution: { ...execution, method: "comparator.weighted_cox", methodVersion: "1.3.0" },
    result: { kind: "comparator", version: 1, diagnostics: {}, measures: [], ...over }, ...extra }).markdown;
  // 仅基准: a literature curve is a benchmark, whatever its engine conclusion says.
  const curve = read({ conclusion: "estimable", diagnostics: {}, measures: [{ name: "median_survival", value: 12 }] },
    { route: "literature_control", execution: { ...execution, method: "evidence.reconstruct_km", methodVersion: "1.0.0" } });
  assert.match(curve, /- 结果：comparator，第 1 版，仅基准/);
  assert.match(curve, /- 要带着这个读：只重建了文献里的曲线，没有和另一组比较/);
  // An unanchored MAIC is one too (its residual error is a premise of the page, so no limit line repeats it).
  assert.match(read({ conclusion: "limited", diagnostics: { anchored: false } }, { execution: { ...execution, method: "comparator.maic", methodVersion: "1.0.0" } }), /，仅基准/);
  // A weighted imbalance limits the estimate, and the record says which and how far.
  const imbalance = read({ conclusion: "limited", diagnostics: { balanceVerdict: { band: "severe", worst: 0.31, variable: "age" } } });
  assert.match(imbalance, /第 1 版，有限制地估计/);
  assert.match(imbalance, /- 要带着这个读：严重失衡：加权后“age”的标准化差异为 0\.31，超过 0\.25。/);
  // The reasons a comparator's own records give.
  const records = read({ conclusion: "limited", diagnostics: { applicabilityLimits: [{ code: "non_inferiority_unsupported", reason: "不支持非劣效" }] } });
  assert.match(records, /- 要带着这个读：/);
  // An estimate with nothing to be read with has no such line, and a result that is not estimable has the gap list instead.
  const clean = read({ conclusion: "estimable", diagnostics: { balanceVerdict: { band: "balanced", worst: 0.03, variable: "age" } } });
  assert.match(clean, /第 1 版，可估计/);
  assert.doesNotMatch(clean, /要带着这个读/);
  const none = read({ conclusion: "not_estimable", diagnostics: { balanceVerdict: { band: "severe", worst: 0.4, variable: "age" } } });
  assert.match(none, /第 1 版，不可估计/);
  assert.doesNotMatch(none, /要带着这个读/);
  // A result with no conclusion says none.
  assert.match(read({ conclusion: null }), /- 结果：comparator，第 1 版\n/);
});

test("P1-6 the replicate count says what set it, from the plan the job froze (and a job from before the plan says nothing)", () => {
  const record = (/** @type {Record<string, any>} */ plan, /** @type {number} */ replicates, /** @type {unknown} */ scenario = { truth: { hazardRatio: 0.7 } }) => buildResultRecord({ study,
    result: { kind: "trial_scenario", version: 1, conclusion: "estimable", diagnostics: {} }, execution: { ...execution, replicates }, scenario, checkpoint: plan ? { replicatePlan: plan } : {} }).markdown;
  assert.match(record({ floor: 5000, basis: "default", intendedUse: "exploratory", targetMcse: null }, 5000), /- 重复次数：5,000（备择情景的默认下限 5,000 次）/);
  assert.match(record({ floor: 20000, basis: "default", intendedUse: "exploratory", targetMcse: null }, 20000, { endpoint: { type: "time_to_event" }, design: { kind: "two_arm_fixed" }, truth: { hazardRatio: 1 } }), /- 重复次数：20,000（零效应情景的默认下限 20,000 次）/);
  assert.match(record({ floor: 100000, basis: "intended_use", intendedUse: "specified_analysis", targetMcse: null }, 100000, { truth: { hazardRatio: 1 } }), /- 重复次数：100,000（研究用途（[^）]+）下零效应情景的下限 100,000 次）/);
  assert.match(record({ floor: 100000, basis: "borrowing", intendedUse: "exploratory", targetMcse: null }, 100000), /借用外部数据的设计在零效应下的下限 100,000 次/);
  assert.match(record({ floor: 5000, basis: "target_mcse", intendedUse: "exploratory", targetMcse: 0.002 }, 62500), /- 重复次数：62,500（为达到 0\.002 的蒙特卡洛误差而提高（下限 5,000 次））/);
  assert.match(record({ floor: 5000, basis: "asked", intendedUse: "exploratory", targetMcse: null }, 8000), /- 重复次数：8,000（你要求的 8,000 次（下限 5,000 次：你要求的次数））/);
  assert.match(record(null, 5000), /- 重复次数：5,000\n/, "a job from before the plan was frozen says what it ran and not what set it");
});
