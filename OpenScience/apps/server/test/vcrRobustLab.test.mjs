// The robust design search on the page, in the reply and in the exported lab section (plan R34): scenarios side by side, no single optimum.
import assert from "node:assert/strict";
import test from "node:test";
import { vcrCampaignManifest, vcrCampaignInitialState, vcrCampaignAdvance, vcrCampaignRecord } from "@evimed/domain";
import { presentCampaign, presentRobust, VcrExperiments } from "../src/vcrExperiments.mjs";
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
  assert.match(text, /只看基准情形，按目标（期望样本量最少），满足全部约束的方案：/, "the base-case pick is the objective's, worded by it (review P0-2)");
  assert.doesNotMatch(text, /满足约束且最省/);
});

test("review S4: a design that held in every scenario is never said to be unfit elsewhere, and a pick whose error control is undecided says so", () => {
  const scenarioRow = (key, acceptable, guard, n) => ({ key, index: Number(key.slice(1)), complete: true, eligible: guard !== "fail", referenceOnly: false, guard, acceptable, oc: {}, scenarios: {},
    worstCase: { value: 0.82, mcse: 0.01, scenario: "base" }, regret: null, expectedPower: null, n: { value: n, mcse: 0 }, duration: null, pareto: false, nearOptimal: false });
  const robust = (rows, cheapestAcceptable, cheapestUnderBase) => ({ scenarios: [{ name: "base", weight: null }, { name: "pessimistic", weight: null }], rows, measures: { n: "expected_sample_size" },
    rule: { floor: 0.8, confidence: 0.95, tolerance: { power: 0.02, relative: 0.1 } }, cheapestAcceptable, cheapestUnderBase, sameDesign: cheapestAcceptable === cheapestUnderBase,
    inconclusive: [], weighted: false, criteria: [], pareto: [], nearOptimal: [], acceptable: [], maximin: null, minimaxRegret: null });
  const manifest = { objective: { truth: "base", measure: "expected_sample_size", direction: "minimize" } };
  const candidates = [{ key: "c1", index: 0 }, { key: "c2", index: 1 }];
  // A (300 people): inconclusive type I error, passes the power floor everywhere. B (400): passes everything and is feasible at the base case.
  const rows = [scenarioRow("c1", "pass", "inconclusive", 300), scenarioRow("c2", "pass", "pass", 400)];
  const said = presentRobust(manifest, robust(rows, "c1", "c2"), candidates).statement;
  assert.match(said, /它在每个假设下也都达标/, "B passed in every scenario: it is not said to be unfit elsewhere");
  assert.doesNotMatch(said, /未必够用/);
  assert.match(said, /第 1 个（它的错误率或安全性约束还无法确定）/, "the cheaper pick's undecided error control is said beside it");
  const failing = presentRobust(manifest, robust([scenarioRow("c1", "pass", "pass", 300), scenarioRow("c2", "fail", "pass", 400)], "c1", "c2"), candidates).statement;
  assert.match(failing, /它在别的假设下未必够用/, "a base pick that did not hold elsewhere is still said so");
});

test("review S9: a search over progression simulations names the chance by its uncertainty mode, never 功效 (page, tags, rule and export)", () => {
  const row = stoppedRow(THREE);
  row.manifest.space.method = "patients.progression";
  row.manifest.space.scenario = { ...row.manifest.space.scenario, model: { family: "beta_logit", uncertainty: "new_study" } };
  const view = presentCampaign(row);
  const label = "考虑研究之间差异后的预期把握度";
  assert.equal(view.powerQuantity, "expected_power_over_studies");
  assert.equal(view.robust.powerLabel, label);
  assert.equal(view.constraints.find((c) => c.measure === "power").label, label);
  assert.match(view.robust.statement, new RegExp(`“${label}”`));
  assert.equal(view.robust.tagText.maximin, `最差情形“${label}”最高`);
  assert.doesNotMatch(`${view.robust.statement}${view.robust.choiceRule}${JSON.stringify(view.robust.tagText)}`, /功效/);
  const lab = [{ ...view, bestSettings: [], finalists: [] }];
  assert.match(renderLabSection({ ...vcrReportModel({ study: { id: "std_1", name: "x", question: "", dataTier: "T0", intendedUse: "exploratory" }, results: [] }), lab }).markdown, new RegExp(`“optimistic”下的“${label}”`));
});
