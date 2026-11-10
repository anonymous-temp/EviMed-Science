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
  // D4 (2026-11-07): a number the person wrote and the model bound nothing for is theirs by its notation, so 30 patients reads as written
  // beside the bound 30 months; the bound one keeps the model's reading of its meaning.
  assert.equal(personWord(record,'design.nTreat','given'),'given');
  assert.equal(personWord(record,'followupMonths','given'),'assumed');
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
  // Matching is by notation (D4): 30% is 0.3 wherever the scenario puts it, and a number absent from the messages is the model's.
  assert.equal(personWord(record,'truth.treatmentRate','given'),'given');
  assert.equal(personWord(record,'design.dropout','given'),'given');
  assert.equal(personWord(record,'design.nTreat','given'),'given');
  assert.equal(personWord(record,'truth.controlRate','given'),'assumed','bound by the model: its reading stays an assumption');
  assert.equal(personWord(vcrPersonStated({truth:{controlRate:0.31}},[human(text)]),'truth.controlRate','given'),'assumed');
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

test('no sources sent: numbers in the original human messages are recognised in code, wherever they stand in a long message (live D4)', () => {
  const filler = '背景说明：'.repeat(80);
  const text = `${filler}单侧显著性水平 2.5%，风险比 0.75，对照组中位生存 12 个月，入组 12 个月随访 18 个月，每年脱落率为 0。`;
  assert.ok(text.indexOf('2.5%') > 160);
  const scenario = {analysis:{alpha:0.025},truth:{hazardRatio:0.75,controlMedian:12},accrual:{followup:18},design:{nTreat:367}};
  const record = vcrPersonStated(scenario,[human('先问别的',3),human(text,12)]);
  for (const path of ['analysis.alpha','truth.hazardRatio','truth.controlMedian','accrual.followup']) assert.equal(personWord(record,path,'assumed'),'given',path);
  assert.equal(personWord(record,'design.nTreat','assumed'),'assumed','a number nobody wrote');
  assert.equal(personWord(record,['truth.hazardRatio','design.nTreat'],'assumed'),'assumed','a row is the person\'s only when every number is');
  assert.deepEqual(record.paths,[],'no model binding was sent');
  assert.equal(personWord(vcrPersonStated(scenario,null),'truth.hazardRatio','assumed'),'assumed','no readable original: never the strong word');
  assert.equal(personWord(vcrPersonStated({truth:{controlMedian:1200}},[human('median 1,200 days')]),'truth.controlMedian','assumed'),'given');
  assert.equal(personWord(vcrPersonStated({a:0.3},[human('对照30人')]),'a','assumed'),'assumed','a bare count is not a fraction');
});

test('live D4 (phase 3): the level and the accrual the person wrote are theirs on the premises, a percentage is its fraction exactly, and a time converts only exactly', () => {
  // Conversation a: 「单侧 α=2.5%」 and 「入组期 12 个月」, 「随访 18 到 30 个月」; conversation e (315 characters): 「入组期大约 18 个月，之后至少再随访 12 个月」,
  // 「单侧 α 0.025」. Both pages read 显著性水平 and 入组与随访 as 假设: the two rows never asked whose the numbers were.
  const a = '两臂生存期试验，II 期提示 HR 约 0.75，对照组中位生存期大约 12 个月，入组期 12 个月。单侧 α=2.5%，想要 90% 把握度。每组 150 到 250 人、随访 18 到 30 个月这个范围里，帮我找满足要求的最小设计。';
  const e = `${'我们科室在准备一项多中心随机对照试验的方案。'.repeat(5)}预计入组期大约 18 个月，之后至少再随访 12 个月，两组按 1:1 随机分配，预计脱落率在 10% 左右。统计上我们打算用分层 log-rank 检验，单侧 α 0.025，把握度 85%。对照组的中位无进展生存期大约是 4.2 个月，而我们预计新方案能把中位无进展生存期提高到 6.0 个月。`;
  const premises = (/** @type {string} */ text, /** @type {Record<string, any>} */ configuration) => Object.fromEntries(vcrPremises("trial", {
    endpointType: "time_to_event", designKind: "two_arm_fixed", diagnostics: {}, cards: [], bound: [], appliedDefaults: [],
    personStated: vcrPersonStated(configuration, [human(text)]), configuration }).map((row) => [row.key, row.source]));
  const design = (/** @type {Record<string, any>} */ over) => ({ design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, analysis: { alpha: 0.025, power: 0.9, sided: 1 }, ...over });
  const fromA = premises(a, design({ truth: { hazardRatio: 0.75, controlMedian: 12 }, accrual: { duration: 12, followup: 18 } }));
  assert.deepEqual([fromA.effect, fromA.control, fromA.accrual, fromA.alpha], ["given", "given", "given", "given"]);
  const fromE = premises(e, design({ truth: { hazardRatio: 0.7, controlMedian: 4.2 }, accrual: { duration: 18, followup: 12, dropoutAnnual: 0.1 } }));
  assert.deepEqual([fromE.control, fromE.accrual, fromE.alpha, fromE.dropout], ["given", "given", "given", "given"]);
  assert.equal(fromE.effect, "assumed", "0.7 is the model's reading of 4.2 against 6.0, written nowhere");
  // A follow-up the person did not write keeps the row an assumption.
  assert.equal(premises(a, design({ truth: { hazardRatio: 0.75 }, accrual: { duration: 12, followup: 24 } })).accrual, "assumed");
  // A percentage is its fraction exactly, however the binary fraction rounds (1.1 / 100 is 0.011000000000000001).
  for (const [text, value] of [['脱落率 1.1%', 0.011], ['显著性 4.13%', 0.0413], ['有效率 0.7%', 0.007], ['百分之 2.2', 0.022]]) {
    assert.equal(personWord(vcrPersonStated({ x: value }, [human(text)]), 'x', 'assumed'), 'given', text);
  }
  assert.equal(personWord(vcrPersonStated({ x: 0.0114 }, [human('脱落率 1.1%')]), 'x', 'assumed'), 'assumed', 'never a near number');
  // A time written in another unit is the person's when the table converts it exactly, and only for the scenario's times.
  const years = vcrPersonStated({ accrual: { duration: 18, followup: 24 }, design: { nTreat: 24 } }, [human('入组 1.5 年，随访 2 年，每月入组 20 人')]);
  assert.equal(personWord(years, ['accrual.duration', 'accrual.followup'], 'assumed'), 'given');
  assert.equal(personWord(years, 'design.nTreat', 'assumed'), 'assumed', '2 years is no sample size');
  const weeks = vcrPersonStated({ timeUnit: 'days', truth: { controlMedian: 84 } }, [human('对照组中位 12 周')]);
  assert.equal(personWord(weeks, 'truth.controlMedian', 'assumed'), 'given');
  assert.equal(personWord(vcrPersonStated({ truth: { controlMedian: 2.76 } }, [human('对照组中位 12 周')]), 'truth.controlMedian', 'assumed'), 'assumed', 'weeks to months is not exact');
  assert.equal(personWord(vcrPersonStated({ timeUnit: 'days', accrual: { followup: 7 } }, [human('患者 1 周岁以上')]), 'accrual.followup', 'assumed'), 'assumed', 'an age is no time');
  assert.equal(personWord(vcrPersonStated({ timeUnit: 'days', accrual: { followup: 7 } }, [human('随访 1 周')]), 'accrual.followup', 'assumed'), 'given');
});
