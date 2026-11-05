// Source membership is checked independently from model-declared parameter meaning.
// Historical schema-1 records retain their original presentation.
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

const human = (text, messageSeq = 10, sessionId = 'sess_1') => ({text,messageSeq,sessionId});
const binding = (field, value, quote, unit = 'patients', context = 'planned treatment arm sample size') => ({origin:'user',field,value,quote,unit,context});

test('equal numbers with different meanings require distinct explicit parameter bindings', () => {
  const scenario = {design:{nTreat:30,nControl:30},followupMonths:30};
  const text = '随访30个月';
  assert.deepEqual(vcrPersonStated(scenario,[text]).paths,[],'unscoped strings are not authenticated sources');
  const record = vcrPersonStated(scenario,[human(text)],[binding('followupMonths',30,text,'month','follow-up duration')]);
  assert.deepEqual(record.paths,['followupMonths']);
  assert.equal(personWord(record,'design.nTreat','given'),'assumed');
  assert.equal(record.bindings[0].unit,'month');
  assert.equal(record.bindings[0].source.messageSeq,10);
  assert.equal(record.bindings[0].source.sha256.length,64);
  assert.deepEqual(vcrNumericLeaves({a:[1,{b:2}],c:'x',d:NaN}),[{path:'a[0]',value:1},{path:'a[1].b',value:2}]);
});

test('repeated percentages, arms and table columns are never inferred from matching digits', () => {
  const scenario = {truth:{controlRate:0.3,treatmentRate:0.3},design:{dropout:0.3,nTreat:30,nControl:30}};
  const text = '对照组有效率30%，试验组有效率30%，对照30人';
  const record = vcrPersonStated(scenario,[human(text)],[
    binding('truth.controlRate',0.3,'对照组有效率30%','fraction','control arm response'),
    binding('design.nControl',30,'对照30人','patients','control arm planned size'),
  ]);
  assert.deepEqual(record.paths,['truth.controlRate','design.nControl']);
  assert.equal(personWord(record,'truth.treatmentRate','given'),'assumed');
  assert.equal(personWord(record,'design.dropout','given'),'assumed');
  assert.equal(personWord(record,'design.nTreat','given'),'assumed');
});

test('new human instructions supersede old provenance; ambiguous, cross-session or rewritten sources stay assumptions', () => {
  const scenario = {followup:30};
  const source = binding('followup',30,'随访30个月','month','follow-up');
  assert.deepEqual(vcrPersonStated(scenario,[human('随访30个月'),human('改为随访12个月',20)],[source]).paths,[]);
  const text = '随访30个月';
  for (const bad of [{...source,sessionId:'other'}, {...source,messageSeq:9}, {...source,unit:''}, {...source,context:''}, {...source,value:12}, {...source,quote:'rewritten 30 months'}, {...source,quote:'随访'}]) {
    assert.deepEqual(vcrPersonStated(scenario,[human(text)],[bad]).paths,[]);
  }
  assert.deepEqual(vcrPersonStated(scenario,[human(text)],[source,source]).paths,[],'duplicate field is ambiguous');
  assert.deepEqual(vcrPersonStated(scenario,[human(text)],[{...source,origin:'model_predicted'}]).paths,[]);
  for (const messages of [null,undefined,[],['preview']]) {
    assert.deepEqual(vcrPersonStated(scenario,messages),{schema:2,readable:false,paths:[],bindings:[]});
  }
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
  // the curve is the person's when every dose's rate is written in their message (live check: 「毒性大概 5%、10%、20%…」 was shown as the model's)
  const curve = read("compare").premises.find((row) => row.key === "curve").value.split(" / ").length;
  const all = Array.from({ length: curve }, (_unused, index) => `truth.toxicity[${index}]`);
  assert.equal(sourceOf(read("compare"), "curve"), "assumed", "no record: as before");
  assert.equal(sourceOf(read("compare", { schema: 1, readable: true, paths: all }), "curve"), "given");
  assert.equal(sourceOf(read("compare", { schema: 1, readable: true, paths: all.slice(1) }), "curve"), "assumed", "one dose the model filled in");
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

test('a fraction requires its decimal literal or an actual percentage token, never a bare count', () => {
  const scenario = {controlRate:0.3};
  const source = quote => binding('controlRate',0.3,quote,'fraction','control event rate');
  for (const quote of ['对照组招募30人','control recruited 30 patients']) {
    assert.deepEqual(vcrPersonStated(scenario,[human(quote)],[source(quote)]).paths,[]);
  }
  for (const quote of ['对照有效率30%','有效率30％','risk 30 percent','有效率百分之30','risk 0.3']) {
    assert.deepEqual(vcrPersonStated(scenario,[human(quote)],[source(quote)]).paths,['controlRate']);
  }
});

test('source-checked model interpretation stays assumed and inspectable on result premises', () => {
  const quote = '对照组招募24人';
  const record = vcrPersonStated({design:{followup:24}},[human(quote)],[binding('design.followup',24,quote,'month','follow-up duration')]);
  assert.equal(record.bindings.length,1,'source membership does not prove the asserted unit or meaning');
  assert.equal(personWord(record,'design.followup','given'),'assumed');
  const card = cardOf(presentWinRatioDesigns,'design_win_ratio','vcr-win-ratio','power',record);
  assert.equal(sourceOf(card,'followup'),'assumed');
  const detail = card.premises.find(row => row.key === 'person-mapping:design.followup');
  assert.equal(detail.decisive,false);
  assert.match(detail.reason,/原文来源已核对，参数含义由模型对应/);
  assert.match(detail.reason,/对照组招募24人/);
  assert.match(detail.reason,/month/);
  assert.equal(detail.value,'follow-up duration');
});
