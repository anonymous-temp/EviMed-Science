// The Bayesian designs without MCMC on the trial page (algorithm round T8, T10, 2026-11-03): the engine's result of a design_bayesian job, read
// into the card the trial tab shows. The fixtures are real results of the engine (tests/numeric/N84-N86 hold their numbers to references).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_SCENARIO_EXAMPLES } from "@evimed/domain";
import { cellLabel, presentBayesianDesigns, vcrBayesianSubjectId } from "../src/vcrBayesianDesign.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";
import { VCR_RESULT_KINDS } from "../src/vcrStore.mjs";
import { VCR_RESULT_KIND_TABS } from "@evimed/domain";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-bayesian/${name}.json`, import.meta.url), "utf8"));
const card = (name, patch = {}) => {
  const result = { ...fixture(name), id: "res_1", version: 1, kind: "design_bayesian", subjectId: "bayes:x", createdAt: "2026-11-03T00:00:00Z", supersededBy: null, reviewState: "ai_set", ...patch };
  return presentBayesianDesigns({ allResults: [result], stale: [] }, { nodeOf: (row) => `result:${row.id}@${row.version}` })[0];
};

test("a finished design_bayesian job reaches the trial tab: its own kind, the trial tab, a key made of the design and what it was asked about", () => {
  assert.equal(vcrResultKindFor("design_bayesian"), "design_bayesian");
  assert.ok(VCR_RESULT_KINDS.includes("design_bayesian"));
  assert.equal(VCR_RESULT_KIND_TABS.design_bayesian, "trial");
  assert.match(vcrBayesianSubjectId({ design: { kind: "bop2", maxN: 40 }, truth: { nullRate: 0.1, alternativeRate: 0.3 } }), /^bayes:bop2:[0-9a-f]{10}$/);
  assert.match(vcrBayesianSubjectId({ design: { kind: "threshold_calibration" }, endpoint: { type: "binary" } }), /^bayes:threshold_calibration:[0-9a-f]{10}$/);
});

test("the key covers the scenario: the two help examples of one design are two cards, a calibration of another threshold is another, and the same question is one (review RF2 P1-1)", () => {
  const [best, fewest] = VCR_SCENARIO_EXAMPLES["design.bayesian"].filter((example) => example.scenario.design.kind === "bop2").map((example) => example.scenario);
  assert.ok(best && fewest, "the help holds two BOP2 examples");
  assert.notEqual(vcrBayesianSubjectId(best), vcrBayesianSubjectId(fewest), "the objective is part of the question");
  assert.equal(vcrBayesianSubjectId(best), vcrBayesianSubjectId(structuredClone(best)));
  const calibration = { design: { kind: "threshold_calibration", nTreat: 100, nControl: 100, threshold: 0.975 }, endpoint: { type: "normal" } };
  assert.notEqual(vcrBayesianSubjectId(calibration), vcrBayesianSubjectId({ ...calibration, design: { ...calibration.design, threshold: 0.95 } }));
});

test("BOP2 says when to stop at each look and sits beside Simon's design, the saving being the difference of two numbers it carries", () => {
  const each = card("bop2");
  assert.equal(each.form, "bop2");
  assert.match(each.question, /何时停，比 Simon 两阶段设计少多少人/);
  assert.deepEqual(each.looks.map((look) => look.size), [10, 20, 30, 40]);
  assert.match(each.looks[0].rule, /累计有效不超过 0 例则停止（无效）/);
  assert.match(each.looks[3].rule, /有效达到 8 例及以上则成功/);
  const [nullRow, altRow] = each.operating.rows;
  assert.equal(nullRow.role, "null");
  assert.equal(nullRow.cells.success.mcse, null, "an exact number carries no Monte-Carlo error");
  assert.ok(nullRow.cells.success.value <= 5 + 1e-9, "the type I error keeps the level");
  assert.ok(altRow.cells.success.value > 90);
  assert.equal(each.operating.stops.length, 3);
  assert.equal(each.simon.optimal.rule, "第一阶段 10 人，有效不超过 1 例则停止；共 29 人，有效超过 5 例则成功");
  assert.ok(Math.abs(each.simon.optimal.expectedNull.value - 15.01) < 0.01);
  assert.ok(Math.abs(each.simon.saving.value - (each.simon.optimal.expectedNull.value - nullRow.cells.expected.value)) < 1e-9);
  assert.match(each.found, /λ = 0\.91.*γ = 1\.15.*网格上搜索得到/);
  assert.equal(each.premises.find((row) => row.key === "objective").value, "在 I 类错误不超过规定水平的设计里取功效最大的");
  assert.deepEqual(each.premises.filter((row) => row.decisive).map((row) => row.key), ["rates", "looks", "objective"]);
});

test("the objective that asks for the fewest patients is said, and an efficacy stop shows up in the looks", () => {
  const each = card("bop2_fewest");
  assert.match(each.premises.find((row) => row.key === "objective").value, /期望样本量最少/);
  assert.ok(each.looks.some((look) => /提前宣布成功/.test(look.rule)));
  assert.ok(each.operating.rows[1].cells.efficacy, "the chance of an early success is a cell");
  assert.ok(each.simon.saving.value > 0, "this objective saves patients under the null");
  assert.equal(each.reachedPower, true);
});

test("predictive monitoring states the interval of final thresholds that gives the rule", () => {
  const each = card("predictive");
  assert.equal(each.form, "predictive");
  assert.match(each.found, /最终有效达到 \d+ 例及以上则成功；最终后验概率阈值取在 \(\d+(\.\d+)?%，\d+(\.\d+)?%\] 内，得到的规则都一样/);
  assert.deepEqual(each.premises.filter((row) => row.decisive).map((row) => row.key), ["rates", "looks", "futility", "efficacy", "objective"]);
  assert.equal(each.premises.find((row) => row.key === "futility").value, "5%");
  assert.equal(each.premises.find((row) => row.key === "futility").source, "given");
});

test("a calibration puts the stated, the conventional and the calibrated threshold in three rows, in percent, with no error on any", () => {
  const normal = card("normal");
  assert.equal(normal.form, "calibration");
  assert.deepEqual(normal.calibration.rows.map((row) => row.kind), ["calibrated", "stated"]);
  assert.equal(normal.calibration.rows[0].label, "校准后的阈值");
  assert.ok(Math.abs(normal.calibration.rows[0].typeOneError.value - 2.5) < 1e-9, "the continuous case is calibrated to the level exactly");
  assert.ok(normal.calibration.rows[1].typeOneError.value > 2.5, "an optimistic prior inflates the type I error of the conventional-looking threshold");
  assert.equal(normal.calibration.rows[0].threshold.unit, "%");
  assert.equal(normal.calibration.discrete, false);
  const binary = card("binary");
  assert.equal(binary.calibration.discrete, true);
  assert.match(binary.calibration.rows[0].label, /不超过规定水平的最小阈值/);
  assert.match(binary.calibration.note, /阶梯形/);
  assert.ok(binary.calibration.rows[0].typeOneError.value <= 2.5 + 1e-9);
  const ratio = card("hazard_ratio");
  assert.equal(ratio.calibration.endpoint, "事件时间终点（风险比）");
  assert.ok(ratio.premises.some((row) => row.key === "prior" && /无先验信息/.test(row.value)), "a missing prior is said to be flat");
});

test("no label is a back-office key and the headline numbers are worded", () => {
  for (const name of ["bop2", "bop2_fewest", "predictive", "normal", "hazard_ratio", "binary"]) {
    const each = card(name);
    assert.ok(each.title && each.question, name);
    for (const entry of each.headline) assert.match(entry.label, /[一-龥]/, `${name}: ${entry.key}`);
    for (const row of each.premises) assert.match(row.label, /[一-龥]/, `${name}: ${row.key}`);
  }
  for (const name of ["type_one_error", "power", "calibrated_threshold", "expected_sample_size_saving_null"]) assert.ok(cellLabel(name), name);
  assert.doesNotMatch(JSON.stringify(card("bop2")), /FDA|认定|批准|背书|qualif|endors/i);
});
