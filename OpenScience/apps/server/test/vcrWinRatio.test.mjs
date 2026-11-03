// The win-ratio design on the trial page (algorithm round T9, 2026-11-03): the engine's result of a design_win_ratio job, read into the card the
// trial tab shows. The fixtures are real results of the engine (tests/numeric/N87 hold their numbers to references).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cellLabel, presentWinRatioDesigns, vcrWinRatioSubjectId } from "../src/vcrWinRatio.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";
import { VCR_RESULT_KINDS } from "../src/vcrStore.mjs";
import { measureLabel } from "../src/vcrViewsKit.mjs";
import { VCR_RESULT_KIND_TABS } from "@evimed/domain";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-win-ratio/${name}.json`, import.meta.url), "utf8"));
const card = (name, patch = {}) => {
  const result = { ...fixture(name), id: "res_1", version: 1, kind: "design_win_ratio", subjectId: "wr:x", createdAt: "2026-11-03T00:00:00Z", supersededBy: null, reviewState: "ai_set", ...patch };
  return presentWinRatioDesigns({ allResults: [result], stale: [] }, { nodeOf: (row) => `result:${row.id}@${row.version}` })[0];
};

test("a finished design_win_ratio job reaches the trial tab: its own kind, the trial tab, a key made of the scenario", () => {
  assert.equal(vcrResultKindFor("design_win_ratio"), "design_win_ratio");
  assert.ok(VCR_RESULT_KINDS.includes("design_win_ratio"));
  assert.equal(VCR_RESULT_KIND_TABS.design_win_ratio, "trial");
  const scenario = { design: { nTreat: 250, followup: 24 }, truth: { death: { controlRisk: 0.15, hazardRatio: 0.75 }, score: { shift: 4 } } };
  const a = vcrWinRatioSubjectId(scenario);
  assert.match(a, /^wr:[0-9a-f]{10}$/);
  assert.equal(a, vcrWinRatioSubjectId({ truth: { score: { shift: 4 }, death: { hazardRatio: 0.75, controlRisk: 0.15 } }, design: { followup: 24, nTreat: 250 } }), "the same scenario, keys in another order, is one question");
  assert.notEqual(a, vcrWinRatioSubjectId({ ...scenario, design: { nTreat: 300, followup: 24 } }), "another size is another result");
  assert.notEqual(a, vcrWinRatioSubjectId({ ...scenario, truth: { ...scenario.truth, score: { shift: 5 } } }), "another effect is another result");
});

test("a size: the power, the win ratio with the win difference and the ties beside it, and where the pairs were decided", () => {
  const each = card("power");
  assert.equal(each.form, "win_ratio");
  assert.equal(each.title, "死亡、事件次数、评分的分层比较（胜率比）");
  assert.match(each.question, /判出有效的把握有多大/);
  assert.match(each.question, /平局占多少/);
  assert.equal(each.size, null);
  assert.deepEqual(each.arms, { treat: 250, control: 250 });
  assert.deepEqual(each.headline.map((entry) => entry.key), ["power", "win_ratio", "win_difference", "tie_proportion"]);
  const power = each.headline[0].value;
  assert.equal(power.unit, "%");
  assert.ok(power.mcse > 0 && power.value > 40 && power.value < 80, "a simulated probability in percent, with its error");
  assert.equal(power.source, "synthetic");
  const ratio = each.headline[1].value;
  assert.ok(ratio.value > 1.1 && ratio.value < 1.5 && ratio.mcse > 0, "the win ratio is a plain number with its error");
  assert.equal(each.headline[1].label, "胜率比（赢的对数 ÷ 输的对数）");
  assert.deepEqual(each.table.rows.map((row) => row.label), ["第 1 层：死亡", "第 2 层：事件次数", "第 3 层：评分", "合计"]);
  const total = each.table.rows[3].cells;
  assert.ok(Math.abs(total.win_proportion.value + total.loss_proportion.value + total.tie_proportion.value - 100) < 1e-6, "wins, losses and ties add up to every pair");
  let rest = 100;
  for (const row of each.table.rows.slice(0, 3)) {
    rest -= row.cells.win_proportion.value + row.cells.loss_proportion.value;
    assert.ok(Math.abs(row.cells.tie_proportion.value - rest) < 1e-6, `${row.key}: what is still tied after the level`);
  }
  assert.ok(Math.abs(rest - total.tie_proportion.value) < 1e-6, "the last level leaves the tie share of the total");
  assert.equal(each.limited, null);
});

test("a power wanted: the size per arm is the headline, said to be found by simulation, and the power at it is the next number", () => {
  const each = card("size");
  assert.match(each.question, /要有 90% 的把握判出有效，每组需要多少人/);
  assert.deepEqual(each.size, { perArm: 189, total: 378, powerWanted: 90, verified: true });
  assert.deepEqual(each.headline.map((entry) => entry.key), ["required_per_arm", "power", "win_ratio", "win_difference", "tie_proportion"]);
  assert.equal(each.headline[0].value.value, 189);
  assert.equal(each.headline[0].label, "每组所需患者数");
  assert.equal(each.headline[1].value.mcse > 0, true);
});

test("two levels only: the card names two levels, and the premises carry no events line", () => {
  const each = card("two_levels");
  assert.equal(each.title, "死亡、评分的分层比较（胜率比）");
  assert.deepEqual(each.table.rows.map((row) => row.key), ["death", "score", "total"]);
  assert.ok(!each.premises.some((row) => row.key === "events"));
  const death = each.premises.find((row) => row.key === "death");
  assert.match(death.value, /中位生存 40 个月/);
  assert.match(death.value, /0\.8 倍/);
});

test("the premises: five decisive lines at most, defaults marked, the method said, no back-office word", () => {
  const each = card("power");
  const decisive = each.premises.filter((row) => row.decisive).map((row) => row.key);
  assert.deepEqual(decisive, ["followup", "death", "events", "score", "level_link"]);
  assert.equal(each.premises.find((row) => row.key === "level_link").source, "default", "a correlation nobody stated is a default");
  assert.equal(each.premises.find((row) => row.key === "followup").source, "given");
  assert.match(each.premises.find((row) => row.key === "events").value, /每人每月 0\.04 次/);
  assert.match(each.premises.find((row) => row.key === "score").value, /两人相差不超过 5 算平局/);
  assert.match(each.premises.find((row) => row.key === "dropout").value, /每年 5% 的人退出随访/);
  assert.match(each.premises.find((row) => row.key === "test").value, /Finkelstein-Schoenfeld/);
  const everything = JSON.stringify(each);
  assert.doesNotMatch(everything, /hce|winratiosim|simtrial|R\/|diagnostics|design_win_ratio|FDA|批准|认定/i);
});

test("every label is words and a stopped run says so and keeps its numbers", () => {
  const each = card("power");
  for (const entry of each.headline) assert.match(entry.label, /[一-龥]/, entry.key);
  for (const column of each.table.columns) assert.match(column.label, /[一-龥]/, column.key);
  for (const name of ["power", "type_one_error", "win_ratio", "win_difference", "win_odds", "win_proportion", "loss_proportion", "tie_proportion", "required_per_arm"]) assert.ok(cellLabel(name), name);
  assert.equal(measureLabel("tie_proportion"), "平局的对数占比");
  const stopped = card("power", { conclusion: "limited", diagnostics: { ...fixture("power").diagnostics, winRatio: { ...fixture("power").diagnostics.winRatio, trials: 300, trialsRequested: 600 } } });
  assert.match(stopped.limited, /300 次，原定 600 次/);
  assert.ok(stopped.headline[0].value.value > 0);
  const projected = card("size", { diagnostics: { ...fixture("size").diagnostics, winRatio: { ...fixture("size").diagnostics.winRatio, search: { ...fixture("size").diagnostics.winRatio.search, verified: false } } } });
  assert.match(projected.limited, /先导模拟推算/);
});
