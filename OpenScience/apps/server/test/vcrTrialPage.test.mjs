// What the trial page is about when it holds several designs, and what a Simon two-stage design says (live check 2026-11-04).
//
// A page of four or more designs read its first sentence from the first three and its premises from the last; the designs were all called
// 「试验方案 n」; a Simon design's row had no number; and the composite win-ratio question's first sentence gave the single-endpoint sizes.
// The fixtures are real results of the engine (the Simon one is `design_analytic` at 1.2.0 on the Simon scenario of the engine fixture).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { vcrResultEntry } from "../src/vcrResultEntry.mjs";
import { describeDesign } from "../src/vcrViews.mjs";
import { presentTrialTab } from "../src/vcrViewsTabs.mjs";

const NOW = new Date("2026-11-04T09:00:00.000Z");
const study = { id: "std_1", userId: "u", projectId: "p", name: "n", question: "q", dataTier: "T0", intendedUse: "exploratory", status: "active", steps: {} };
const emptyBundle = () => ({
  now: NOW, study, definition: null, results: [], stale: [], reviews: [], jobs: [], budget: null, assumptions: [], members: [], exports: [], decisions: [],
  roles: ["lead"], scenarios: [], comparators: [], comparator: null, populations: [], patientSets: [], grid: null, forecasts: [], models: [],
  executions: new Map(), protocol: null, criteria: [], forecastResults: [], edges: [], evidence: { available: true, precedents: [], items: [] },
  dataPlane: { available: false }, assumptionVersions: new Map(), match: null,
});
const fixture = (directory, name) => JSON.parse(readFileSync(new URL(`./fixtures/${directory}/${name}.json`, import.meta.url), "utf8"));

/** A design of a conversation (its label is the number the platform gave it) with the closed form's result filed under it. */
function design(index, { kind = "two_arm_fixed", endpoint = "time_to_event", configuration = {}, events = 500 + index * 10, total = 800 + index * 10 } = {}) {
  const id = `scn_${index}`;
  const at = `2026-11-04T08:${String(10 + index).padStart(2, "0")}:00.000Z`;
  return {
    scenario: { id, version: index, label: `试验方案 ${index}`, design: kind, endpointType: endpoint, configuration: { design: { kind }, endpoint: { type: endpoint }, ...configuration }, assumptionIds: [], resultId: `res_${index}` },
    result: { id: `res_${index}`, version: 1, kind: "trial_scenario", subjectId: id, conclusion: "estimable", reviewState: "ai_set", counts: {}, diagnostics: {}, executionId: `ex_${index}`,
      measures: [{ name: "required_events", value: events, source: "calculated" }, { name: "required_total", value: total, source: "calculated" }], createdAt: at },
  };
}
function bundleOf(designs, extra = {}) {
  const executions = new Map(designs.map(({ result }) => [result.executionId, { id: result.executionId, jobId: `job_${result.executionId}`, method: "design.analytic", seed: 7, replicates: null, cpuSeconds: 1, scenarioHash: "f".repeat(64) }]));
  const results = designs.map(({ result }) => result);
  return { ...emptyBundle(), scenarios: designs.map(({ scenario }) => scenario), results: [...results].reverse(), allResults: [...results].reverse(), executions, ...extra };
}
const five = () => [
  design(1, { configuration: { hypothesis: { kind: "non_inferiority", margin: 1.3 }, truth: { hazardRatio: 1, controlMedian: 12 } }, events: 500, total: 820 }),
  design(2, { configuration: { truth: { hazardRatio: 0.75, controlMedian: 12 } }, events: 508, total: 828 }),
  design(3, { kind: "group_sequential", configuration: { design: { kind: "group_sequential", informationRates: [0.5, 1] }, truth: { hazardRatio: 0.7, controlMedian: 12 } }, events: 331, total: 540 }),
  design(4, { configuration: { truth: { hazardRatio: 0.8, controlMedian: 12 } }, events: 845, total: 1350 }),
  design(5, { configuration: { truth: { hazardRatio: 0.85, controlMedian: 12 } }, events: 1592, total: 2500 }),
];

test("Simon's design says its answer in the first sentence and on its row: the stage sizes, the two boundaries, the expected size and the chance of stopping early under the null, the type I error and the power", () => {
  const analytic = fixture("vcr-simon", "analytic");
  const simon = { id: "scn_s", version: 1, label: "试验方案 1", design: "simon_two_stage", endpointType: "binary", resultId: "res_s", assumptionIds: [],
    configuration: { design: { kind: "simon_two_stage", maxN: 60 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, alternativeRate: 0.4 }, analysis: { alpha: 0.05, power: 0.8 } } };
  const result = { ...analytic, id: "res_s", version: 1, kind: "trial_scenario", subjectId: "scn_s", reviewState: "ai_set", executionId: "ex_s", createdAt: "2026-11-04T08:10:00.000Z" };
  const executions = new Map([["ex_s", { id: "ex_s", jobId: "job_s", method: "design.analytic", seed: 7, replicates: null, cpuSeconds: 1, scenarioHash: "f".repeat(64) }]]);
  const tab = presentTrialTab({ ...emptyBundle(), scenarios: [simon], results: [result], allResults: [result], executions });
  assert.equal(tab.headline,
    "方案 A 的 Simon 两阶段最优设计：第一阶段 13 例，应答不超过 3 例就停止；共 43 例，应答超过 12 例才判有效；零假设下期望入组 20.6 例，第一阶段就停止的概率 74.7%；I 类错误 4.96%，功效 80%；总例数最少的设计共 33 例。");
  const [row] = tab.designs;
  assert.equal(row.note, "第一阶段 13 例，应答不超过 3 例就停止；共 43 例，应答超过 12 例才判有效");
  assert.equal(row.measures.sample_size.value, 43);
  assert.ok(Math.abs(row.measures.expected_sample_size_null.value - 20.58) < 0.01 && Math.abs(row.measures.first_stage_stop_probability_null.value - 74.73) < 0.01, "the row is not empty any more");
  assert.equal(row.measures.first_stage_stop_probability_null.unit, "%");
  assert.equal(row.measures.sample_size.source, "calculated");
  assert.deepEqual(tab.columns.map((column) => column.key), ["sample_size", "expected_sample_size_null", "first_stage_stop_probability_null"]);
  assert.equal(row.simon.minimax.n, 33);
  assert.equal(row.simon.optimal.n1, 13);
  // a closed form is not a simulation: nothing says a design was simulated
  assert.ok(!/已模拟/.test(tab.headline));
});

test("a page of more than three designs is about ONE: the first sentence, the premises and the data-generation lines read the same design (the most recent), and the others are a count", () => {
  const tab = presentTrialTab(bundleOf(five()));
  assert.match(tab.headline, /^方案 E（固定样本两组比较，风险比 0\.85） 需要 1,592 例事件、2,500 名患者；页面上另有 4 个方案，各在下面的表里。$/);
  assert.ok(!/方案 [ABCD] /.test(tab.headline), "the first three are not listed");
  const effect = tab.premises.find((row) => row.key === "effect");
  assert.match(String(effect.value), /0\.85/, "the premises are E's");
  assert.ok(tab.ademp.some((line) => /0\.85/.test(line.text)), "so are the data-generation lines");
  // three designs or fewer keep the sentence that compares them
  const three = presentTrialTab(bundleOf(five().slice(0, 3)));
  assert.match(three.headline, /^方案 A 需要 500 例事件、820 名患者；方案 B 需要 508 例事件、828 名患者；方案 C 需要 331 例事件、540 名患者。$/);
});

test("a link that names a design is the page's subject: the first sentence and the premises follow it, whichever design is the newest", () => {
  const asked = presentTrialTab({ ...bundleOf(five()), askedObject: "scn_2" });
  assert.match(asked.headline, /^方案 B（固定样本两组比较，风险比 0\.75） 需要 508 例事件、828 名患者；页面上另有 4 个方案/);
  assert.match(String(asked.premises.find((row) => row.key === "effect").value), /0\.75/);
  assert.ok(asked.ademp.some((line) => /0\.75/.test(line.text)));
  // an object the page does not hold is no subject: the most recent, as without a link
  const strange = presentTrialTab({ ...bundleOf(five()), askedObject: "scn_nobody" });
  assert.match(strange.headline, /^方案 E/);
  // the link to the tab names it, and only for a shape the page can use
  assert.match(vcrResultEntry({ studyId: "std_1", tab: "trial", publicUrl: "https://x.example", object: "scn_2" }).url, /\/trial\?object=scn_2$/);
  assert.match(vcrResultEntry({ studyId: "std_1", tab: "trial", publicUrl: "https://x.example", object: "cd:sample_size_reestimation:time_to_event:0123456789" }).url, /object=cd%3Asample_size_reestimation/);
  assert.equal(vcrResultEntry({ studyId: "std_1", tab: "trial", publicUrl: "https://x.example", object: "a b/../c" }).url, "https://x.example/app/virtual-research/std_1/trial");
  assert.equal(vcrResultEntry({ studyId: "std_1", tab: "data", publicUrl: "https://x.example", object: "scn_2" }).url, "https://x.example/app/virtual-research/std_1/data", "no other tab reads one");
});

test("designs are named from what they are, not from the number the platform gave them", () => {
  const tab = presentTrialTab(bundleOf(five()));
  assert.deepEqual(tab.designs.map((row) => row.name), ["非劣效，界值 1.3", "固定样本两组比较，风险比 0.75", "成组序贯，2 次分析，风险比 0.7", "固定样本两组比较，风险比 0.8", "固定样本两组比较，风险比 0.85"]);
  assert.ok(tab.designs.every((row) => !/^试验方案/.test(row.name)));
  assert.equal(describeDesign({ design: "two_arm_fixed", endpointType: "binary", configuration: { hypothesis: { kind: "non_inferiority", margin: 0.1 }, truth: { controlRate: 0.8 } } }), "非劣效，界值 10%");
  assert.equal(describeDesign({ design: "two_arm_fixed", endpointType: "binary", configuration: { truth: { controlRate: 0.3, treatmentRate: 0.45 } } }), "固定样本两组比较，30% 对 45%");
  assert.equal(describeDesign({ design: "bogus", configuration: {} }), null, "nothing to name it by");
  // a label somebody wrote stays as it was written
  const written = design(1, { configuration: { truth: { hazardRatio: 0.75 } } });
  written.scenario.label = "保守假设";
  assert.equal(presentTrialTab(bundleOf([written])).designs[0].name, "保守假设");
});

test("the composite's number comes first, with the single-endpoint sizes as the baselines they are (the page of a win-ratio question)", () => {
  const winRatio = { ...fixture("vcr-win-ratio", "size"), id: "res_wr", version: 1, kind: "design_win_ratio", subjectId: "wr:0123456789", createdAt: "2026-11-04T09:00:00.000Z", supersededBy: null, reviewState: "ai_set" };
  const bundle = bundleOf(five().slice(0, 2), { results: [winRatio], allResults: [winRatio, ...bundleOf(five().slice(0, 2)).allResults] });
  const tab = presentTrialTab(bundle);
  assert.equal(tab.winRatioDesigns.length, 1);
  const title = tab.winRatioDesigns[0].title;
  assert.ok(tab.headline.startsWith(`${title}：`), tab.headline);
  assert.ok(/需要 \d|每组|所需/.test(tab.headline.split("。作为对照")[0]), "the composite's own size or power");
  assert.match(tab.headline, /。作为对照，方案 A 需要 500 例事件、820 名患者；方案 B 需要 508 例事件、828 名患者。$/);
  assert.deepEqual(tab.premises, tab.winRatioDesigns[0].premises, "the premises are the composite's, not the single-endpoint design's");
  assert.ok(!tab.ademp.some((line) => line.key === "generation"), "no data-generation line of a design the page is no longer about");
  // asked for a single-endpoint design by a link, the page is about that one again
  const asked = presentTrialTab({ ...bundle, askedObject: "scn_2" });
  assert.match(asked.headline, /^方案 B（/);
  // and asked for the composite by its subject key
  const composite = presentTrialTab({ ...bundle, results: [], allResults: [{ ...winRatio, createdAt: "2026-11-01T00:00:00.000Z" }, ...bundleOf(five().slice(0, 2)).allResults], askedObject: "wr:0123456789" });
  assert.ok(composite.headline.startsWith(`${title}：`));
});
