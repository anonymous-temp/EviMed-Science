// The confirmatory designs on the trial page (algorithm round T2-T6, 2026-11-03): the engine's result of a design_confirmatory job, read
// into the card the trial tab shows. The fixtures are real results of the engine (tests/numeric/N66-N68 hold their numbers to references).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cellLabel, presentConfirmatoryDesigns, vcrConfirmatorySubjectId } from "../src/vcrConfirmatory.mjs";
import { maxComboNotes } from "../src/vcrViewsTabs.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";
import { VCR_RESULT_KINDS } from "../src/vcrStore.mjs";
import { measureLabel } from "../src/vcrViewsKit.mjs";
import { VCR_RESULT_KIND_TABS } from "@evimed/domain";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-confirmatory/${name}.json`, import.meta.url), "utf8"));
const card = (name, patch = {}) => {
  const result = { ...fixture(name), id: "res_1", version: 1, kind: "design_confirmatory", subjectId: "cd:x", createdAt: "2026-11-03T00:00:00Z", supersededBy: null, reviewState: "ai_set", ...patch };
  return presentConfirmatoryDesigns({ allResults: [result], stale: [] }, { nodeOf: (row) => `result:${row.id}@${row.version}` })[0];
};

test("a finished design_confirmatory job reaches the trial tab: filed under its own kind, on the trial tab, with a key per design and endpoint", () => {
  assert.equal(vcrResultKindFor("design_confirmatory"), "design_confirmatory");
  assert.ok(VCR_RESULT_KINDS.includes("design_confirmatory"));
  assert.equal(VCR_RESULT_KIND_TABS.design_confirmatory, "trial");
  assert.equal(vcrConfirmatorySubjectId({ design: { kind: "sample_size_reestimation" }, endpoint: { type: "time_to_event" } }), "cd:sample_size_reestimation:time_to_event");
  assert.equal(vcrConfirmatorySubjectId({ design: { kind: "count_endpoint" } }), "cd:count_endpoint:count", "a count endpoint names no endpoint type");
});

test("every card says the question it answers, in Chinese, and no back-office key reaches a label", () => {
  const questions = { futility: "中期发现没戏就停，能省多少人", ssr: "效应没把握，中期加样，功效和平均要多少人", enrichment: "标志物阳性只占一部分，中期收窄入组，功效如何", count: "每年发作次数这类计数终点，需要多少人" };
  for (const [name, question] of Object.entries(questions)) {
    const each = card(name);
    assert.equal(each.question, question, name);
    assert.ok(each.title && each.headline.length > 0, name);
    for (const entry of each.headline) assert.match(entry.label, /[一-龥]/, `${name}: ${entry.key}`);
    for (const column of each.table?.columns ?? []) assert.match(column.label, /[一-龥]/, `${name}: ${column.key}`);
  }
  assert.match(card("multi").question, /几个剂量加一个对照/);
  // the cell names the engine uses are worded, and the per-look and per-arm ones too
  for (const name of ["stop_efficacy_2", "stop_futility_1", "selected_arm_3", "reject_arm_1", "increase_probability"]) assert.ok(cellLabel(name), name);
  assert.equal(measureLabel("stop_efficacy_2"), "第 2 次分析达标而停止的概率");
});

test("a re-estimation sits beside the fixed and the group-sequential design, row by row, with the Monte-Carlo error of its own numbers", () => {
  const each = card("ssr");
  assert.equal(each.endpoint, "事件时间终点");
  const groups = new Set(each.table.columns.map((column) => column.group));
  assert.deepEqual([...groups], ["本设计", "固定设计", "成组序贯"]);
  assert.deepEqual(each.table.rows.map((row) => row.label), ["无效应", "设想的效应", "计划的效应"], "the null is always a row");
  const planned = each.table.rows[2];
  assert.equal(planned.cells.power.unit, "%");
  assert.ok(planned.cells.power.mcse > 0, "a simulated number carries its error");
  assert.equal(planned.cells.fixed_power.mcse, null, "a closed-form baseline carries none");
  assert.ok(Math.abs(planned.cells.fixed_power.value - 90) < 0.5 && Math.abs(planned.cells.gs_power.value - 90) < 0.5, "both baselines are sized for the planned effect");
  assert.deepEqual(each.table.rows.map((row) => row.iterations), [20000, 5000, 5000]);
  assert.equal(each.baselines.length, 2);
  assert.equal(each.limited, null);
});

test("a default the person did not state is a premise of the card, and the null that was added says so", () => {
  const each = card("ssr");
  const labels = each.premises.map((row) => row.label);
  assert.ok(labels.includes("计划的效应（风险比）") && labels.includes("对照组中位时间"));
  assert.ok(each.premises.filter((row) => row.decisive).length <= 5);
  assert.ok(each.premises.some((row) => row.label === "零假设一行" && row.source === "default"));
  assert.ok(each.premises.some((row) => row.label === "计划样本量" && row.source === "default"));
  assert.ok(each.premises.every((row) => !/design\.|truth\.|analysis\./.test(`${row.label}${row.value}`)), "no key reaches a premise");
});

test("a futility design shows its boundaries and the probability of stopping at each look; a count design shows a size", () => {
  const futility = card("futility");
  assert.equal(futility.looks.length, 3);
  assert.ok(futility.looks[0].efficacyBound > futility.looks[2].efficacyBound, "the efficacy boundary falls over the looks");
  assert.equal(futility.looks[2].futilityBound, null, "the last look has no futility boundary");
  assert.ok(futility.looks[0].efficacyStop.value >= 0 && futility.looks[0].futilityStop.unit === "%");
  assert.equal(futility.table.rows[0].label, "无效应");
  const count = card("count");
  assert.equal(count.table, null);
  assert.ok(count.headline.some((entry) => entry.key === "required_total"));
  assert.ok(count.baselines.length > 0);
});

test("a multi-arm design is read against a trial per arm, and the arm it kept is a probability", () => {
  const each = card("multi");
  assert.deepEqual(each.baselines.map((row) => row.key), ["fixedMultiArm", "separateTrials"]);
  const row = each.table.rows.find((entry) => entry.label === "设想的效应");
  assert.ok(row.cells.correct_selection_probability.value > 0);
  assert.equal(each.table.rows[0].cells.correct_selection_probability, null, "with no effect there is no best arm to select");
  const kept = [1, 2, 3].map((arm) => row.cells[`selected_arm_${arm}`].value);
  assert.ok(Math.max(...kept) === kept[2], "the arm with the largest effect is kept most often");
});

test("a stopped run says so and keeps its numbers", () => {
  const stopped = fixture("ssr");
  stopped.conclusion = "limited";
  stopped.diagnostics = { ...stopped.diagnostics, issues: [{ code: "cpu_budget_exhausted" }] };
  const each = card("ssr", stopped);
  assert.match(each.limited, /只算完了一部分模拟/);
  assert.ok(each.table.rows.length > 0);
});

test("a superseded result is not a card, and the newest of a key comes first", () => {
  const rows = [
    { ...fixture("ssr"), id: "old", version: 1, kind: "design_confirmatory", createdAt: "2026-11-02T00:00:00Z", supersededBy: "new" },
    { ...fixture("ssr"), id: "new", version: 2, kind: "design_confirmatory", createdAt: "2026-11-03T00:00:00Z", supersededBy: null },
    { ...fixture("futility"), id: "other", version: 1, kind: "design_confirmatory", createdAt: "2026-11-01T00:00:00Z", supersededBy: null },
    { id: "x", kind: "trial_scenario" },
  ];
  const cards = presentConfirmatoryDesigns({ allResults: rows, stale: [] }, { nodeOf: (row) => `result:${row.id}@${row.version}` });
  assert.deepEqual(cards.map((each) => each.id), ["new", "other"]);
});

test("a non-inferiority margin is a premise of the trial page, in the words of its endpoint", () => {
  const row = (endpointType, configuration) => vcrPremises("trial", { endpointType, designKind: "two_arm_fixed", configuration, diagnostics: {}, cards: [], bound: [], appliedDefaults: [] }).find((premise) => premise.key === "margin");
  assert.equal(row("time_to_event", { hypothesis: { kind: "non_inferiority", margin: 1.3 }, truth: { hazardRatio: 1, controlMedian: 12 } }).value, "风险比不超过 1.3");
  assert.equal(row("binary", { hypothesis: { kind: "non_inferiority", margin: 0.1 }, truth: { controlRate: 0.8, treatmentRate: 0.8 } }).value, "率差不低于 −10%");
  assert.equal(row("continuous", { hypothesis: { kind: "non_inferiority", margin: 0.3 }, truth: { effect: 0 } }).value, "均数差不低于 −0.3");
  assert.equal(row("continuous", { truth: { effect: 0.3 } }), undefined, "a superiority design has none");
});

test("MaxCombo's table notes carry the log-rank power and the strong null, with their errors, as information", () => {
  const measures = [
    { name: "power_logrank", value: 0.451, mcse: 0.007 },
    { name: "type_one_error_strong_null", value: 0.0022, mcse: 0.0003 },
    { name: "type_one_error_strong_null_logrank", value: 0.0003, mcse: 0.0001 },
  ];
  const notes = maxComboNotes([{ code: "A", dominated: false, _stages: { simulation: { measures, diagnostics: { strongNull: { breaks: 6, ratios: [1.667, 1], alpha: 0.025, timeUnit: "months" } } } } }]);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /方案 A：同样的模拟里，log-rank 检验的功效是 45\.1%（±0\.7）/);
  assert.match(notes[1], /前 6 个月的风险比为 1\.67、之后与对照相同/);
  assert.match(notes[1], /MaxCombo 判为试验组更优的概率是 0\.22%（±0\.03）.*log-rank 是 0\.03%（±0\.01）/);
  assert.match(notes[1], /名义水平 2\.5%/);
  assert.deepEqual(maxComboNotes([{ code: "B", dominated: false, _stages: { simulation: { measures: [], diagnostics: {} } } }]), []);
});
