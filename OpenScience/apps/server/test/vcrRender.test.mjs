// 「虚拟临床研究」's report numbers: rendered from results, never typed.
//
// This is the whole of AC-20 as a mechanism rather than as a check. A template
// carries references; the platform resolves them against the study's saved
// results; a reference that has nothing behind it renders 「未计算」 and says
// so. A number a run typed anyway is reported, not silently kept.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  VCR_NUMBER_FORMATS, VCR_UNCOMPUTED, VCR_UNIT_FORMATS, renderVcrNumbers, vcrFormatValue, vcrReadPath, vcrReportModel, vcrResolvePath,
  vcrTypedNumbers,
} from "../src/vcrRender.mjs";
import { VCR_SCENARIO_SCHEMAS, proseNumbers, resultNumbers, vcrStudyPackageFindings } from "@evimed/domain";

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

test("AC-20 a number typed into the template does not reach the rendered report: it reads 「未计算」 where it stood", () => {
  const { text, typed, issues } = renderVcrNumbers("方案 B 的功效为 71.2%，共 1,284 人，事件 138 起；真实患者 {{n:counts.realPatients|thousands}} 人。", results);
  assert.deepEqual(typed, ["71.2", "1,284", "138"]);
  assert.doesNotMatch(text.replace("真实患者 1,284 人", ""), /\d/, "no digit the words typed is in what a reader gets; the only digits are the rendered reference's");
  assert.equal(text, `方案 B 的功效为 ${VCR_UNCOMPUTED}%，共 ${VCR_UNCOMPUTED} 人，事件 ${VCR_UNCOMPUTED} 起；真实患者 1,284 人。`, "the rendered reference is untouched, and so is the sentence");
  assert.deepEqual(issues.map((issue) => issue.code), ["vcr_number_typed"]);
  assert.match(issues[0].message, /未计算/, "the run is told what the report says in the number's place");
});

test("AC-20 what a report may say in digits without a reference is closed: a year, an ordinal, a date, a locator, a quoted source", () => {
  const prose = "2026 年 9 月 29 日起，第 35 页图 3 表 2 运行 #25；快照 2026-09-29T10:00:00Z；方案入选「年龄 ≥ 18 岁」“ECOG 0–1”，第 3 节。";
  const { text, typed, issues } = renderVcrNumbers(prose, results);
  assert.deepEqual(typed, []);
  assert.equal(text, prose, "nothing was replaced");
  assert.deepEqual(issues, []);
  // The same digits outside those forms are a statement of the study.
  assert.deepEqual(renderVcrNumbers("年龄 ≥ 18 岁，第 40 例", results).typed, ["18", "40"]);
});

test("C2-10 a reference the grammar cannot read never reaches the report raw, whatever its spelling", () => {
  const cases = [
    ["功效 {{n:measure(power).value|PCT1}} 很高。", "capital format"],
    ["功效 {{N:measure(power).value|pct1}} 很高。", "capital N"],
    ["功效 {{n: measure(power).value }} 很高。", "a space inside the path"],
    ["功效 {{n:measure(power).value|pct1} 很高。", "one closing brace"],
    ["功效 {{n:measure(power).value 很高。", "never closed"],
    ["功效 {{ n:measure(power).value|pct1 |x}} 很高。", "two formats"],
  ];
  for (const [template, why] of cases) {
    const { text, issues } = renderVcrNumbers(template, results);
    assert.doesNotMatch(text, /\{\{|n:measure/i, `${why}: a raw reference reached the text: ${text}`);
    assert.match(text, new RegExp(VCR_UNCOMPUTED), why);
    assert.ok(issues.some((issue) => issue.code === "vcr_number_unparsed"), `${why}: ${JSON.stringify(issues.map((issue) => issue.code))}`);
  }
  // The sentence after an unclosed reference is not eaten, and an unparsed one is not counted as a bound one.
  const { text, bindings } = renderVcrNumbers("功效 {{n:measure(power).value 很高，然后继续写结论。", results);
  assert.match(text, /很高，然后继续写结论。/);
  assert.equal(bindings.length, 0);
});

test("a rendered value that itself contains digits or braces is a result, never prose to be scanned again", () => {
  const withText = { ...results, definition: { pico: { population: "{{n:x}} 二线 NSCLC 共 500 例" } } };
  const { text, issues } = renderVcrNumbers("人群：{{n:definition.pico.population|text}}。", withText);
  assert.equal(text, "人群：{{n:x}} 二线 NSCLC 共 500 例。", "the result's own words come out as they are");
  assert.deepEqual(issues, []);
});

test("an unknown format is reported and the raw value still prints", () => {
  const { text, issues } = renderVcrNumbers("功效 {{n:measure(power).value|percent}}。", results);
  assert.equal(issues[0].code, "vcr_number_format_unknown");
  assert.match(text, /功效 0\.812。/);
});

// What the pilot's study held on 2026-10-03, in the engine's own shapes: a
// generated binary set's two arms as `vcr_patient_summary` writes them (a
// percentage that says it is one), a simulated probability (a fraction with no
// unit), a restricted mean with its time unit, a pooled value with its scale.
const recorded = {
  results: { patient_set: { diagnostics: { panels: [{ key: "arms", rows: [
    { label: "试验组事件率", value: { value: 46.08, unit: "%" } },
    { label: "对照组事件率", value: { value: 28.57, unit: "%" } },
    { label: "试验组事件数", value: { value: 100, unit: "例" } },
  ] }] } } },
  measures: [
    { name: "power", value: 0.9012, simulated: true, mcse: 0.0015 },
    { name: "rmst_difference", value: 2.9, simulated: false, unit: "months", interval: { kind: "confidence", low: 1.2, high: 4.6, level: 0.95 } },
    { name: "pooled_estimate", value: 0.31, simulated: false, unit: "identity" },
    { name: "pooled_on_logit", value: -0.8, simulated: false, unit: "logit" },
    { name: "rmst_in_weeks", value: 12, simulated: false, unit: "weeks" },
  ],
  assumptions: [
    { key: "control_event_rate", value: 0.3, unit: null },
    { key: "screen_failure_rate", value: 25, unit: "%", distribution: { family: "point", range: { low: 20, high: 30 } } },
    { key: "control_median_pfs", value: 4.1, unit: "月" },
  ],
};
const eventRate = (/** @type {number} */ row) => `results.patient_set.diagnostics.panels[0].rows[${row}].value.value`;

test("a percentage the result recorded as one is printed as it stands by every percent format; a fraction is still scaled", () => {
  assert.deepEqual(vcrResolvePath(recorded, eventRate(0)), { value: 46.08, unit: "%" }, "the unit travels with the number");
  // The sentence that shipped 「4608.0%、2857.0%」 in Word, PDF and HTML.
  const shipped = renderVcrNumbers(`抽样实现中试验组事件率 {{n:${eventRate(0)}|pct1}}、对照组事件率 {{n:${eventRate(1)}|pct1}}。`, recorded);
  assert.equal(shipped.text, "抽样实现中试验组事件率 46.1%、对照组事件率 28.6%。");
  assert.deepEqual(shipped.issues, []);
  assert.deepEqual(shipped.bindings.map((binding) => [binding.value, binding.unit, binding.rendered]), [[46.08, "%", "46.1%"], [28.57, "%", "28.6%"]],
    "the binding keeps the unit that explains why the value was not scaled");
  for (const [format, expected] of [["pct0", "46%"], ["pct1", "46.1%"], ["pct2", "46.08%"]]) {
    assert.equal(renderVcrNumbers(`{{n:${eventRate(0)}|${format}}}`, recorded).text, expected, format);
  }
  // A fraction — with no unit, as the engine writes a probability, or on the natural scale — is scaled as before.
  assert.equal(renderVcrNumbers("{{n:measure(power).value|pct1}}", recorded).text, "90.1%");
  assert.equal(renderVcrNumbers("{{n:assumptions[0].value|pct1}}", recorded).text, "30.0%");
  assert.equal(renderVcrNumbers("{{n:measure(pooled_estimate).value|pct1}}", recorded).text, "31.0%");
  assert.equal(vcrFormatValue(0.3, "pct1", "proportion").text, "30.0%");
  // A card kept in percent, and the ends of its range, are the card's unit too.
  assert.equal(renderVcrNumbers("{{n:assumptions[1].value|pct0}}（{{n:assumptions[1].distribution.range.low|pct0}}～{{n:assumptions[1].distribution.range.high|pct0}}）", recorded).text,
    "25%（20%～30%）");
  // A percentage per something is a percentage: 「脱落率 10 %/年」 is how the data tab keeps that card.
  assert.equal(vcrFormatValue(10, "pct1", "%/年").text, "10.0%");
  assert.equal(vcrFormatValue(10, "pct0", " ％ ").text, "10%");
  // And the rendered percentage is one the contract's own traceability check finds in the results.
  assert.ok(resultNumbers(recorded).has("46.1") && resultNumbers(recorded).has("28.6"));
});

test("a unit the requested format cannot be true of is a named rendering error and 「未计算」, never a number", () => {
  const cases = [
    ["measure(rmst_difference).value", "pct1", "months"],
    ["measure(rmst_difference).interval.low", "pct1", "months"],
    ["measure(pooled_on_logit).value", "pct2", "logit"],
    ["results.patient_set.diagnostics.panels[0].rows[2].value.value", "pct0", "例"],
    ["assumptions[2].value", "pct1", "月"],
    [eventRate(0), "months", "%"],
    ["measure(rmst_in_weeks).value", "months", "weeks"],
    ["measure(pooled_on_logit).value", "months", "logit"],
  ];
  for (const [path, format, unit] of cases) {
    const { text, issues, bindings } = renderVcrNumbers(`读数 {{n:${path}|${format}}}。`, recorded);
    assert.equal(text, `读数 ${VCR_UNCOMPUTED}。`, `${path}|${format}: a number reached the report`);
    assert.equal(bindings[0].ok, false);
    assert.equal(issues.length, 1, `${path}|${format}`);
    assert.deepEqual({ code: issues[0].code, path: issues[0].path, reason: issues[0].reason, unit: issues[0].unit, format: issues[0].format, severity: issues[0].severity },
      { code: "vcr_number_unbound", path, reason: "unit_mismatch", unit, format, severity: "advisory" });
    assert.ok(issues[0].message.includes(`「${unit}」`) && issues[0].message.includes(format), "the sentence names the unit and the format");
    assert.doesNotMatch(issues[0].message, /结果里没有/, "the field is not missing, and the run is not sent to look for it");
  }
  assert.deepEqual(vcrFormatValue(4.1, "pct1", "月"), { ok: false, text: VCR_UNCOMPUTED, reason: "unit_mismatch" });
  // The same values in a format that states no unit print as they are.
  assert.equal(renderVcrNumbers("{{n:measure(rmst_difference).value|f1}}", recorded).text, "2.9");
  assert.equal(renderVcrNumbers(`{{n:${eventRate(0)}|f2}}`, recorded).text, "46.08");
});

test("the months format answers to the unit too, and a unit speaks only for the value, its error and its bounds", () => {
  assert.deepEqual([...VCR_UNIT_FORMATS], ["pct0", "pct1", "pct2", "months"]);
  assert.ok(VCR_UNIT_FORMATS.every((format) => VCR_NUMBER_FORMATS.includes(format)));
  assert.equal(renderVcrNumbers("{{n:measure(rmst_difference).value|months}}", recorded).text, "2.9 个月");
  assert.equal(renderVcrNumbers("{{n:assumptions[2].value|months}}", recorded).text, "4.1 个月");
  assert.equal(vcrFormatValue(4.1, "months").text, "4.1 个月", "a bare duration with nothing recorded beside it");
  // An interval's level is a number about the interval, not a quantity in the measure's unit.
  assert.deepEqual(vcrResolvePath(recorded, "measure(rmst_difference).interval.level"), { value: 0.95, unit: null });
  assert.equal(renderVcrNumbers("{{n:measure(rmst_difference).interval.level|pct0}}", recorded).text, "95%");
  assert.deepEqual(vcrResolvePath(recorded, "measure(rmst_difference).interval.high"), { value: 4.6, unit: "months" });
  assert.deepEqual(vcrResolvePath(recorded, "measure(power).mcse"), { value: 0.0015, unit: null });
  assert.deepEqual(vcrResolvePath(recorded, "measure(absent).value"), { value: undefined, unit: null });
});

test("every unit the engine writes has a reading: its one percentage says so, and no unit it names is ever scaled as a fraction", async () => {
  const directory = new URL("../../../../项目代码/vcr-engine/R/", import.meta.url);
  const sources = (await readdir(directory)).filter((name) => name.endsWith(".R"));
  assert.ok(sources.includes("summaries.R") && sources.includes("engine.R"), "the engine's sources were read");
  /** @type {Set<string>} */
  const literals = new Set();
  /** @type {string[]} */
  const scaledToPercent = [];
  for (const name of sources) {
    const text = await readFile(new URL(name, directory), "utf8");
    for (const match of text.matchAll(/\bunit\s*=\s*"([^"]*)"/g)) literals.add(match[1]);
    for (const line of text.split("\n")) {
      if (/\bvalue\s*=/.test(line) && /\b100\s*\*|\*\s*100\b/.test(line)) scaledToPercent.push(`${name}: ${line.trim()}`);
    }
  }
  // The walk proves it walked: the three units `vcr_patient_summary` writes are found.
  assert.deepEqual([...literals].sort(), ["%", "例", "月"].sort(), "a unit the engine now writes that the renderer has never been told about");
  assert.ok(scaledToPercent.length >= 1, "the scan found the summary that stores a percentage");
  for (const line of scaledToPercent) assert.match(line, /unit\s*=\s*"%"/, `a value stored as a percentage must say so: ${line}`);
  // Every literal unit: a percentage is printed as it stands, anything else is refused by a percent format.
  for (const unit of literals) {
    const shown = vcrFormatValue(46.08, "pct1", unit);
    assert.deepEqual(shown, unit === "%" ? { ok: true, text: "46.1%" } : { ok: false, text: VCR_UNCOMPUTED, reason: "unit_mismatch" }, unit);
  }
  // The pooling engine writes its scale where a unit goes (`unit = scale`): the natural scale is a plain value, a transformed one is not the quantity.
  const scales = /** @type {any} */ (VCR_SCENARIO_SCHEMAS)["evidence.pool"].fields.scale.values;
  assert.deepEqual([...scales].sort(), ["identity", "log", "logit"]);
  for (const scale of scales) {
    const shown = vcrFormatValue(0.31, "pct1", scale);
    assert.equal(shown.ok, scale === "identity", scale);
    assert.equal(shown.text, scale === "identity" ? "31.0%" : VCR_UNCOMPUTED, scale);
  }
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
