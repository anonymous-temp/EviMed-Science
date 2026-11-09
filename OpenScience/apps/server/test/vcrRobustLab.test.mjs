// The robust design search on the page, in the reply and in the exported lab section (plan R34): scenarios side by side, no single optimum.
import assert from "node:assert/strict";
import test from "node:test";
import { vcrCampaignManifest, vcrCampaignInitialState, vcrCampaignAdvance, vcrCampaignRecord } from "@evimed/domain";
import { presentCampaign, VcrExperiments } from "../src/vcrExperiments.mjs";
import { renderLabSection } from "../src/vcrLabReport.mjs";
import { vcrReportModel } from "../src/vcrRender.mjs";

const ID = "c".repeat(64);
const BASE = { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 },
  accrual: { kind: "uniform", duration: 12, followup: 12, dropoutAnnual: 0.05 }, analysis: { method: "logrank", alpha: 0.025, sided: 1 } };
const truth = (hazardRatio) => ({ hazardRatio, controlMedian: 12 });
const input = (truths) => ({
  question: "各种疗效假设下的最小样本量",
  objective: { measure: "expected_sample_size", direction: "minimize", truth: "base" },
  constraints: [{ measure: "power", op: ">=", bound: 0.8, kind: "design", truth: "base" }, { measure: "type_one_error", op: "<=", bound: 0.025, kind: "error_control", truth: "null" }],
  space: { method: "design.simulate", scenario: BASE, truths,
    variables: [{ path: "design.nTreat", values: [80, 160, 320] }, { path: "design.nControl", values: [80, 160, 320] }] },
  stages: { screening: { replicates: 500 }, final: { count: 3 } }, budget: { maxCandidates: 9, cpuSeconds: 36000, modelCalls: 0 },
});
const THREE = [{ name: "optimistic", truth: truth(0.6) }, { name: "base", truth: truth(0.7) }, { name: "pessimistic", truth: truth(0.8) }, { name: "null", truth: truth(1) }];

function engine(unit) {
  const n = unit.scenario.design.nTreat + unit.scenario.design.nControl;
  const hr = unit.scenario.truth.hazardRatio;
  const reps = unit.stage === "screening" ? 500 : 20000;
  const p = hr === 1 ? 0.02 : Math.min(0.999, 1 - Math.exp(-n * (1 - hr) ** 2 / 4));
  const k = Math.round(p * reps) / reps;
  const extra = unit.stage === "screening" ? { precision: "screening" } : {};
  return { jobId: `job_${unit.key}`, resultId: `res_${unit.key}`, state: "succeeded", replicates: reps, seed: unit.seed, drawSignature: `draws:${unit.candidate}`, cpuSeconds: 1, queueSeconds: 0, wallSeconds: 1,
    measures: [{ name: hr === 1 ? "type_one_error" : "power", value: k, mcse: Math.sqrt(k * (1 - k) / reps), simulated: true, source: "synthetic", ...extra },
      { name: "expected_sample_size", value: n, mcse: 0, simulated: true, source: "synthetic", ...extra },
      ...(hr === 1 ? [] : [{ name: "duration_months", value: 24 + 100 / n, mcse: 0.1, simulated: true, source: "synthetic", ...extra }])] };
}
function stoppedRow(truths) {
  const manifest = vcrCampaignManifest(input(truths)).manifest;
  let state = vcrCampaignInitialState(manifest);
  for (let i = 0; i < 300; i++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity: ID });
    state = next;
    if (action.type !== "evaluate") break;
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: action.unit.key } }, action.unit, engine(action.unit));
  }
  return { id: "cmp_robust", study_id: "std_1", kind: "campaign", status: "stopped", identity: ID, manifest, state, created_at: new Date("2026-11-09T00:00:00Z"), updated_at: new Date("2026-11-09T00:01:00Z") };
}

test("a campaign that compares effect scenarios reads back as a robust table with no design marked best", () => {
  const view = presentCampaign(stoppedRow(THREE));
  const robust = view.robust;
  assert.ok(robust, "the view carries the robust reading");
  assert.deepEqual(robust.scenarios.map((s) => s.name), ["optimistic", "base", "pessimistic"]);
  assert.equal(robust.weighted, false);
  assert.ok(robust.rows.length >= 1 && robust.rows.every((row) => row.complete));
  const row = robust.rows[0];
  assert.deepEqual(row.scenarios.map((s) => s.name).sort(), ["base", "null", "optimistic", "pessimistic"]);
  const base = row.scenarios.find((s) => s.name === "base");
  assert.ok(base.power.value > 0 && base.power.mcse > 0 && base.power.unit === "%", "power with its MCSE, in percent");
  assert.ok(base.oc.find((oc) => oc.measure === "exposure").value > 0, "exposure is people times follow-up");
  assert.ok(row.worstCase.value <= base.power.value && row.maxRegret.value >= 0);
  assert.ok(row.tags.every((tag) => Object.hasOwn(robust.tagText, tag)));
  assert.match(robust.statement, /^在这些假设下（“optimistic”、“base”、“pessimistic”）：/);
  assert.match(robust.choiceRule, /同一批随机数/);
  assert.match(robust.choiceRule, /没有给各假设的权重|你没有给各假设的权重/);
  // no sentence of the page says best or optimum
  assert.doesNotMatch(JSON.stringify({ statement: robust.statement, choiceRule: robust.choiceRule, tagText: robust.tagText }), /最优(的|设计|方案)|最佳|最好/);
  assert.match(view.premises.find((p) => p.key === "campaign:conditional").value, /结论可能不同/);
});

test("the cheapest design acceptable in every scenario and the cheapest under the base case are two named designs, and may differ", () => {
  const view = presentCampaign(stoppedRow(THREE));
  const { cheapestAcceptable, cheapestUnderBase, sameDesign } = view.robust;
  assert.ok(cheapestUnderBase, "a design is feasible under the base case");
  if (cheapestAcceptable) {
    assert.ok(cheapestAcceptable.n.value >= cheapestUnderBase.n.value, "being acceptable everywhere never costs less than being feasible at the base case");
    assert.equal(sameDesign, cheapestAcceptable.key === cheapestUnderBase.key);
    assert.match(view.robust.statement, /每个假设下功效都确认不低于 80% 的最省方案是第 \d+ 个/);
  } else assert.match(view.robust.statement, /没有方案在每个假设下/);
});

test("a campaign with one effect scenario has no robust reading", () => {
  const view = presentCampaign(stoppedRow([{ name: "base", truth: truth(0.7) }, { name: "null", truth: truth(1) }]));
  assert.equal(view.robust, null);
});

test("weights the person stated give an expected power; none stated gives none", () => {
  const weighted = presentCampaign(stoppedRow([{ name: "optimistic", truth: truth(0.6), weight: 1 }, { name: "base", truth: truth(0.7), weight: 2 }, { name: "pessimistic", truth: truth(0.8), weight: 1 }, { name: "null", truth: truth(1) }]));
  assert.equal(weighted.robust.weighted, true);
  assert.ok(weighted.robust.rows[0].expectedPower.value > 0);
  assert.match(weighted.robust.choiceRule, /按权重平均的功效/);
  assert.equal(presentCampaign(stoppedRow(THREE)).robust.rows[0].expectedPower, null);
});

test("the study's lab block carries the robust reading and the exported section prints it with every number rendered, and no optimum", async () => {
  const row = stoppedRow(THREE);
  const experiments = new VcrExperiments({ store: { rows: async () => [row], one: async () => null }, jobs: null });
  const lab = await experiments.reportBlock({ id: "std_1" });
  assert.equal(lab.length, 1);
  assert.ok(lab[0].robust && lab[0].robust.rows.every((r) => r.index >= 1 && Object.keys(r.design).length));
  const model = { ...vcrReportModel({ study: { id: "std_1", name: "EV-301", question: "", dataTier: "T0", intendedUse: "exploratory" }, results: [] }), lab };
  const section = renderLabSection(model);
  assert.deepEqual(section.issues, [], "every reference resolved");
  const text = section.markdown;
  assert.match(text, /#### 稳健性比较/);
  assert.match(text, /在这些假设下（“optimistic”、“base”、“pessimistic”）：/);
  assert.match(text, /\| 候选 \| 设置 \| “optimistic”下的功效 \| “base”下的功效 \| “pessimistic”下的功效 \| 最差情形功效 \| 最大遗憾 \| 样本量 \| 所属集合 \|/);
  assert.match(text, /\d+\.\d%（模拟误差 ±\d+\.\d%）/, "each power is printed with its error");
  assert.doesNotMatch(text, /最优(的|设计|方案)|最佳/);
  assert.doesNotMatch(text, /未计算/, "no reference was left unresolved");
  assert.match(text, /在这些假设下满足约束且最省的设计|只看基准情形、满足约束且最省的设计/);
});
