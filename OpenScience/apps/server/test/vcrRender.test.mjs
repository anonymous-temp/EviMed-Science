// 「虚拟临研」's report numbers: rendered from results, never typed.
//
// This is the whole of AC-20 as a mechanism rather than as a check. A template
// carries references; the platform resolves them against the study's saved
// results; a reference that has nothing behind it renders 「未计算」 and says
// so. A number a run typed anyway is reported, not silently kept.
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_NUMBER_FORMATS, VCR_UNCOMPUTED, renderVcrNumbers, vcrFormatValue, vcrReadPath, vcrReportModel, vcrTypedNumbers,
} from "../src/vcrRender.mjs";
import { proseNumbers, resultNumbers, vcrStudyPackageFindings } from "@evimed/domain";

const results = {
  conclusion: "estimable",
  counts: { realPatients: 1284, events: 138, effectiveSampleSize: 186, generatedRecords: 3_600_000 },
  measures: [
    { name: "power", value: 0.812, simulated: true, mcse: 0.0031, interval: { kind: "monte_carlo", low: 0.806, high: 0.818 } },
    { name: "hazard_ratio", value: 0.69, simulated: false, interval: { kind: "confidence", low: 0.52, high: 0.91 } },
    { name: "type_one_error", value: 0.0249, simulated: true },
  ],
  assumptions: [{ key: "control_median_pfs", name: "对照组中位 PFS", value: 4.1, unit: "月" }],
};

test("a path reads dotted keys, array indices and a measure by name", () => {
  assert.equal(vcrReadPath(results, "counts.realPatients"), 1284);
  assert.equal(vcrReadPath(results, "measures[1].value"), 0.69);
  assert.equal(vcrReadPath(results, "measure(power).value"), 0.812);
  assert.equal(vcrReadPath(results, "assumptions[0].value"), 4.1);
  assert.equal(vcrReadPath(results, "counts.nothingHere"), undefined);
  assert.equal(vcrReadPath(results, "measure(absent).value"), undefined);
});

test("every format renders, and a named interval never prints bare", () => {
  assert.deepEqual(VCR_NUMBER_FORMATS.includes("ci") && VCR_NUMBER_FORMATS.includes("pm"), true);
  assert.equal(vcrFormatValue(0.812, "pct1").text, "81.2%");
  assert.equal(vcrFormatValue(1284, "thousands").text, "1,284");
  assert.equal(vcrFormatValue(4.1, "months").text, "4.1 个月");
  assert.equal(vcrFormatValue(results.measures[1], "ci").text, "置信区间 0.520～0.910");
  assert.equal(vcrFormatValue(results.measures[0], "pm").text, "0.812（蒙特卡洛标准误 0.0031）");
  // An interval whose kind is not one of the four is not printed as if it were.
  const unnamed = vcrFormatValue({ interval: { kind: "", low: 1, high: 2 } }, "ci");
  assert.equal(unnamed.ok, false);
  assert.equal(unnamed.reason, "interval_kind_unnamed");
});

test("AC-28 a simulated measure printed without a Monte-Carlo standard error is refused, not rounded over", () => {
  const rendered = vcrFormatValue(results.measures[2], "pm");
  assert.equal(rendered.ok, false);
  assert.equal(rendered.reason, "mcse_missing");
  // The point value still prints: the report keeps what was computed and the
  // finding names what is missing (principle 19).
  assert.equal(rendered.text, "0.025");
});

test("AC-20 every number in a rendered report comes from a result field", () => {
  const template = [
    "方案 B 的功效为 {{n:measure(power).value|pct1}}（{{n:measure(power)|pm}}）。",
    "风险比 {{n:measure(hazard_ratio).value|f2}}，{{n:measure(hazard_ratio)|ci}}。",
    "真实患者 {{n:counts.realPatients|thousands}} 人，事件 {{n:counts.events|int}} 起。",
  ].join("\n");
  const { text, bindings, issues, typed } = renderVcrNumbers(template, results);
  assert.equal(typed.length, 0, "the template typed no number of its own");
  assert.deepEqual(issues, []);
  assert.equal(bindings.length, 6);
  assert.ok(bindings.every((binding) => binding.ok));
  assert.match(text, /功效为 81\.2%（0\.812（蒙特卡洛标准误 0\.0031））/);
  assert.match(text, /风险比 0\.69，置信区间 0\.520～0\.910/);
  assert.match(text, /真实患者 1,284 人，事件 138 起/);

  // And the rendered text passes the domain's own traceability check, which is
  // the point: the contract can never fail a report the platform rendered.
  const files = new Map([["study-package.md", text], ["results.json", JSON.stringify(results)]]);
  const findings = vcrStudyPackageFindings({ files });
  assert.deepEqual(findings.issues.filter((issue) => issue.check === "vcr-number-provenance"), []);
  assert.equal(findings.metrics.vcrNumbersTraced, findings.metrics.vcrNumbersInProse);
});

test("AC-20 a number nobody computed renders 「未计算」 and is reported, never a zero", () => {
  const { text, issues } = renderVcrNumbers("期望样本量 {{n:measure(expected_sample_size).value|int}} 例。", results);
  assert.match(text, new RegExp(`期望样本量 ${VCR_UNCOMPUTED} 例`));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "vcr_number_unbound");
  assert.equal(issues[0].severity, "advisory", "a gap in the results is a finding, never a block");
  assert.doesNotMatch(text, /\b0\b/, "an uncomputed number never renders as zero");
});

test("AC-20 a number typed into the template is reported; a year, a page and a small ordinal are not", () => {
  assert.deepEqual(vcrTypedNumbers("2026 年第 3 节第 12 页，方案 B 的功效为 71.2%。"), ["71.2"]);
  assert.deepEqual(vcrTypedNumbers("功效为 {{n:measure(power).value|pct1}}。"), []);
  const { issues } = renderVcrNumbers("功效为 71.2%。", results);
  assert.deepEqual(issues.map((issue) => issue.code), ["vcr_number_typed"]);
  assert.equal(issues[0].severity, "advisory");
});

test("an unknown format is reported and the raw value still prints", () => {
  const { text, issues } = renderVcrNumbers("功效 {{n:measure(power).value|percent}}。", results);
  assert.equal(issues[0].code, "vcr_number_format_unknown");
  assert.match(text, /功效 0\.812。/);
});

test("the report model carries the four counts apart, with null for what was never counted", () => {
  const model = vcrReportModel({
    study: { id: "std_1", name: "EV-201", question: "能不能用外部对照", dataTier: "T0", intendedUse: "design_support" },
    definition: { version: 2, pico: { population: "二线 NSCLC" }, estimand: {}, endpointType: "time_to_event" },
    assumptions: [{ key: "control_median_pfs", name: "对照组中位 PFS", version: 3, pointValue: 4.1, unit: "月",
      sourceKind: "external_evidence", valueSource: "aggregate", reviewState: "ai_set", sources: [{ quote: "…", locator: { page: 4 } }] }],
    results: [{ kind: "trial_scenario", id: "res_1", conclusion: "estimable",
      counts: { realPatients: null, events: 138, effectiveSampleSize: null, generatedRecords: 3_600_000 },
      measures: results.measures, diagnostics: {}, intendedUse: "design_support" }],
    population: { kind: "literature", counts: { realPatients: null }, waterfall: [], quality: {} },
    reviews: [], staleMarks: [], models: [], scenarios: [], comparator: { estimand: "ATT" },
  });
  assert.deepEqual(Object.keys(model.counts).sort(),
    ["effectiveSampleSize", "events", "generatedRecords", "realPatients"]);
  assert.equal(model.counts.realPatients, null, "no real patient was counted at T0 — null, never 0");
  assert.equal(model.counts.generatedRecords, 3_600_000);
  assert.equal(model.estimand, "ATT");
  assert.equal(model.assumptions[0].valueSourceLabel, "汇总");
  assert.equal(model.qualityReport, null);
  // The domain's own number extraction agrees with the model's numbers, which
  // is what makes the contract's check and the renderer read one document.
  const known = resultNumbers(model);
  for (const raw of proseNumbers("事件 138 起。")) assert.ok(known.has(raw), `${raw} should be traceable`);
});
