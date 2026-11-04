// 「你给的数据」 means a number in the person's own message or a table they supplied, and nothing a model chose (live check 2026-11-04).
//
// The win-ratio, Bayesian and dose-finding cards gave the word to a follow-up of 24 months, a dropout of 5%, a correlation of 0.3 and 'at most 30
// patients' that the model had written into the scenario. Code now lays the scenario's numbers against the person's messages when the job starts
// (`vcrPersonStated`), the record is frozen with the job and filed on the result, and each premise reads it (`personWord`). A result with no record
// reads as it read: the fixtures of the earlier releases are those.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { personWord, vcrNumericLeaves, vcrPersonStated } from "../src/vcrPersonStated.mjs";
import { presentBayesianDesigns } from "../src/vcrBayesianDesign.mjs";
import { presentConfirmatoryDesigns } from "../src/vcrConfirmatory.mjs";
import { presentDoseDesigns } from "../src/vcrDoseFinding.mjs";
import { presentWinRatioDesigns } from "../src/vcrWinRatio.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";

const fixture = (directory, name) => JSON.parse(readFileSync(new URL(`./fixtures/${directory}/${name}.json`, import.meta.url), "utf8"));
const NODE = (row) => `result:${row.id}@${row.version}`;
const cardOf = (present, kind, directory, name, personStated) => {
  const base = fixture(directory, name);
  const result = { ...base, id: "res_1", version: 1, kind, subjectId: "x", createdAt: "2026-11-04T00:00:00Z", supersededBy: null, reviewState: "ai_set",
    diagnostics: { ...base.diagnostics, ...(personStated ? { personStated } : {}) } };
  return present({ allResults: [result], stale: [] }, { nodeOf: NODE })[0];
};
const sourceOf = (card, key) => card.premises.find((row) => row.key === key)?.source;

test("a scenario's numbers are laid against the person's messages: a number is theirs when it is written there, a fraction also as a percentage, and a digit of another number is nothing", () => {
  const scenario = { design: { nTreat: 250, followup: 24, dropoutAnnual: 0.05, maxPatients: 30 }, truth: { death: { controlRisk: 0.15, hazardRatio: 0.75 }, correlation: 0.3, effects: [0.8, 0.9] } };
  const stated = vcrPersonStated(scenario, ["随访 24 个月，年脱落 5%，每组 250 人，风险比 0.75，对照组死亡率 15%，共 30 例以内，2024 年入组，效应 0.8"]);
  assert.deepEqual(stated, { schema: 1, readable: true, paths: ["design.nTreat", "design.followup", "design.dropoutAnnual", "design.maxPatients", "truth.death.controlRisk", "truth.death.hazardRatio", "truth.effects[0]"] },
    "0.3 is not the 30, 0.9 is nowhere, and 24 is not 2024");
  assert.deepEqual(vcrPersonStated({ design: { dropoutAnnual: 0.05 } }, ["脱落 5"]).paths, [], "a bare 5 is not 5%");
  assert.deepEqual(vcrPersonStated({ design: { dropoutAnnual: 0.05 } }, ["脱落 0.05"]).paths, ["design.dropoutAnnual"], "and 0.05 is");
  assert.deepEqual(vcrPersonStated({ design: { a: 0.125 } }, ["12.5 %"]).paths, ["design.a"], "a percentage with a space");
  // 0 and 1 are what a design needs to exist, whatever digit the message has
  assert.deepEqual(vcrPersonStated({ truth: { hazardRatio: 1, effect: 0 }, design: { allocation: 1 } }, ["1:1 随机，效应 0，HR 1"]).paths, []);
  // several messages are one text; a message that is not text is nothing
  assert.deepEqual(vcrPersonStated({ design: { followup: 24, nTreat: 80 } }, ["随访 24 个月", 5, null, "每组 80 人"]).paths, ["design.followup", "design.nTreat"]);
  assert.deepEqual(vcrNumericLeaves({ a: [1, { b: 2 }], c: "x", d: Number.NaN }), [{ path: "a[0]", value: 1 }, { path: "a[1].b", value: 2 }]);
});

test("no message, no strong word: a conversation that could not be read records that, and every stated number reads 假设", () => {
  const scenario = { design: { followup: 24 } };
  for (const messages of [null, undefined, [], ["", "  "]]) assert.deepEqual(vcrPersonStated(scenario, messages), { schema: 1, readable: false, paths: [] });
  assert.equal(personWord({ schema: 1, readable: false, paths: [] }, "design.followup", "given"), "assumed");
});

test("the word of a premise: a result with no record reads as it read, a record decides, and a row of several numbers is the person's only when every one is", () => {
  assert.equal(personWord(undefined, "a", "given"), "given");
  assert.equal(personWord(null, "a", "assumed"), "assumed");
  assert.equal(personWord({ other: 1 }, "a", "given"), "given", "a record of another shape is no record");
  const record = { schema: 1, readable: true, paths: ["design.followup", "design.nTreat"] };
  assert.equal(personWord(record, "design.followup", "assumed"), "given");
  assert.equal(personWord(record, "design.maxPatients", "given"), "assumed", "the model's number, whatever the page used to say");
  assert.equal(personWord(record, ["design.followup", "design.nTreat"], "assumed"), "given");
  assert.equal(personWord(record, ["design.followup", "design.cohortSize"], "given"), "assumed", "one number the model chose beside one the person said");
  assert.equal(personWord(record, [], "given"), "assumed", "a row with no number of the scenario's is not a statement");
});

test("a win-ratio card: the follow-up, the dropout and the correlation the model chose are premises; what the person wrote stays 你给的数据; an old result reads as it read", () => {
  const read = (name, record) => cardOf(presentWinRatioDesigns, "design_win_ratio", "vcr-win-ratio", name, record);
  const record = (paths, readable = true) => ({ schema: 1, readable, paths });
  assert.deepEqual([sourceOf(read("power"), "followup"), sourceOf(read("power"), "dropout")], ["given", "given"], "no record: as before");
  assert.deepEqual([sourceOf(read("two_levels"), "level_link")], ["given"], "the correlation too, as before");
  assert.deepEqual([sourceOf(read("power", record([])), "followup"), sourceOf(read("power", record([])), "dropout")], ["assumed", "assumed"]);
  assert.equal(sourceOf(read("two_levels", record([])), "level_link"), "assumed", "0.3 is the model's");
  assert.deepEqual([sourceOf(read("power", record(["design.followup"])), "followup"), sourceOf(read("power", record(["design.followup"])), "dropout")], ["given", "assumed"]);
  assert.equal(sourceOf(read("two_levels", record(["truth.correlation"])), "level_link"), "given");
  assert.equal(sourceOf(read("power", record([], false)), "followup"), "assumed", "unreadable: never the strong word");
  // a row of several numbers is the person's only when every one is
  assert.equal(sourceOf(read("power", record([])), "death"), "assumed");
  const death = ["truth.death.hazardRatio", "truth.death.controlRisk"];
  assert.equal(sourceOf(read("power", record(death)), "death"), "given");
  assert.equal(sourceOf(read("power", record(death.slice(0, 1))), "death"), "assumed");
  assert.notEqual(sourceOf(read("power", record(["truth.events.rateRatio"])), "events"), "given");
});

test("a dose-finding card: the most people the model chose and the margin it picked are premises; the ones the person wrote are theirs", () => {
  const read = (name, record) => cardOf(presentDoseDesigns, "design_dose", "vcr-dose", name, record);
  assert.equal(sourceOf(read("compare"), "size"), "given", "no record: as before");
  assert.equal(sourceOf(read("compare", { schema: 1, readable: true, paths: [] }), "size"), "assumed");
  assert.equal(sourceOf(read("compare", { schema: 1, readable: true, paths: ["design.maxPatients"] }), "size"), "assumed", "the cohort size beside it is the model's");
  assert.equal(sourceOf(read("compare", { schema: 1, readable: true, paths: ["design.maxPatients", "design.cohortSize"] }), "size"), "given");
  assert.equal(sourceOf(read("compare", { schema: 1, readable: false, paths: [] }), "size"), "assumed");
  assert.equal(sourceOf(read("selection"), "margin"), "given");
  assert.equal(sourceOf(read("selection", { schema: 1, readable: true, paths: [] }), "margin"), "assumed");
  assert.equal(sourceOf(read("selection", { schema: 1, readable: true, paths: ["design.margin"] }), "margin"), "given");
  // what the engine took, nobody said
  assert.equal(sourceOf(read("selection", { schema: 1, readable: true, paths: ["design.margin", "design.targetProbability"] }), "right"), "default");
});

test("a Bayesian card: the sizes, the thresholds and the margin are the person's only when written in their messages", () => {
  const read = (name, record) => cardOf(presentBayesianDesigns, "design_bayesian", "vcr-bayesian", name, record);
  const none = { schema: 1, readable: true, paths: [] };
  assert.deepEqual([sourceOf(read("bop2"), "looks"), sourceOf(read("bop2"), "rates")], ["given", "assumed"], "no record: as before");
  assert.deepEqual([sourceOf(read("bop2", none), "looks"), sourceOf(read("bop2", none), "rates")], ["assumed", "assumed"]);
  assert.equal(sourceOf(read("bop2", { ...none, paths: ["design.lookEvery"] }), "looks"), "given");
  assert.equal(sourceOf(read("bop2", { ...none, paths: ["truth.nullRate", "truth.alternativeRate"] }), "rates"), "given");
  assert.deepEqual(["alpha", "size", "endpoint"].map((key) => sourceOf(read("binary"), key)), ["given", "given", "given"], "no record: as before");
  assert.deepEqual(["alpha", "size", "endpoint"].map((key) => sourceOf(read("binary", none), key)), ["assumed", "assumed", "assumed"]);
  assert.deepEqual(["alpha", "size"].map((key) => sourceOf(read("binary", { ...none, paths: ["analysis.alpha", "design.nTreat", "design.nControl"] }), key)), ["given", "given"]);
  assert.deepEqual(["futility", "efficacy"].map((key) => sourceOf(read("predictive", none), key)), ["assumed", "assumed"]);
  assert.equal(sourceOf(read("predictive", { ...none, paths: ["design.predictive.futility"] }), "futility"), "given");
  assert.equal(sourceOf(read("hazard_ratio", none), "margin"), "assumed");
  assert.deepEqual(read("bop2", none).premises.map((row) => row.key), read("bop2").premises.map((row) => row.key), "the same premises, other words");
});

test("a confirmatory card: a planned effect the model chose is 假设, the one the person wrote is 你给的数据, and an old result keeps 假设", () => {
  const read = (name, record) => cardOf(presentConfirmatoryDesigns, "design_confirmatory", "vcr-confirmatory", name, record);
  const effect = (card) => card.premises.find((row) => row.key === "effect")?.source;
  assert.equal(effect(read("ssr-people", undefined)), "assumed", "no record: as before");
  assert.equal(effect(read("ssr-people", { schema: 1, readable: true, paths: [] })), "assumed");
  assert.equal(effect(read("ssr-people", { schema: 1, readable: true, paths: ["truth.plannedEffect"] })), "given");
  const control = (card) => card.premises.find((row) => row.key === "control")?.source;
  assert.equal(control(read("ssr-people", { schema: 1, readable: true, paths: ["truth.plannedEffect", "truth.controlMedian"] })), "given");
  assert.equal(control(read("ssr-people", { schema: 1, readable: true, paths: ["truth.plannedEffect"] })), "assumed");
  const accrual = (card) => card.premises.find((row) => row.key === "accrual")?.source;
  assert.equal(accrual(read("ssr-people", { schema: 1, readable: true, paths: ["accrual.duration"] })), "assumed", "the follow-up is the model's");
  assert.equal(accrual(read("ssr-people", { schema: 1, readable: true, paths: ["accrual.duration", "accrual.followup"] })), "given");
});

test("a fixed design's premises: the hazard ratio and the margin the person wrote are theirs, the control median the model chose is not", () => {
  const input = (personStated) => ({ endpointType: "time_to_event", designKind: "two_arm_fixed", diagnostics: {}, cards: [], bound: [], appliedDefaults: [], personStated,
    configuration: { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, hypothesis: { kind: "non_inferiority", margin: 1.3 }, truth: { hazardRatio: 0.9, controlMedian: 12 }, accrual: { duration: 18, followup: 12, dropoutAnnual: 0.05 }, analysis: { alpha: 0.025, power: 0.9 } } });
  const sources = (personStated) => Object.fromEntries(vcrPremises("trial", input(personStated)).map((row) => [row.key, row.source]));
  const before = sources(undefined);
  assert.equal(before.effect, "assumed");
  assert.equal(before.control, "assumed");
  const record = sources({ schema: 1, readable: true, paths: ["truth.hazardRatio", "hypothesis.margin"] });
  assert.equal(record.effect, "given");
  assert.equal(record.margin, "given");
  assert.equal(record.control, "assumed", "12 months is the model's");
  assert.equal(sources({ schema: 1, readable: false, paths: [] }).effect, "assumed");
});
