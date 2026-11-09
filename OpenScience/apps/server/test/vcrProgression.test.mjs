// The virtual-patients page's card of a disease-progression simulation (algorithm round P4): the engine's real results (tests/numeric N99 hold their numbers to
// the closed form) read into the payload the page shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_METHODS, VCR_RESULT_KIND_TABS } from "@evimed/domain";
import { progressionCard, presentProgressions, vcrProgressionSubjectId, vcrProgressionWithDifferences } from "../src/vcrProgression.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";

const fixture = (name) => ({ ...JSON.parse(readFileSync(new URL(`./fixtures/vcr-progression/${name}.json`, import.meta.url), "utf8")), id: "res_1", version: 1, kind: "progression_simulation", createdAt: "2026-11-04T00:00:00Z" });
const strings = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(strings) : node && typeof node === "object" ? Object.values(node).flatMap(strings) : []);

test("a progression simulation is a result of its own kind, read on the patients tab", () => {
  assert.equal(VCR_JOB_METHODS.generate_progression, "patients.progression");
  assert.equal(vcrResultKindFor("generate_progression"), "progression_simulation");
  assert.equal(VCR_RESULT_KIND_TABS.progression_simulation, "patients");
  const scenario = { design: { nTreat: 100 }, treatment: { slowing: { value: 0.25 } } };
  assert.equal(vcrProgressionSubjectId(scenario), vcrProgressionSubjectId(structuredClone(scenario)));
  assert.notEqual(vcrProgressionSubjectId(scenario), vcrProgressionSubjectId({ ...scenario, treatment: { slowing: { value: 0.3 } } }));
});

test("the card says it is population level first, and why", () => {
  const card = progressionCard(fixture("linear-change"));
  assert.equal(card.label, "人群层面，不是对个人的预测");
  // no statistic is typed into every card: the sentence says what the curve is and what it cannot say
  assert.match(card.reason, /不能告诉你某一个人会怎样/);
  assert.doesNotMatch(card.reason, /\d/);
  assert.match(card.question, /减慢 25%/);
});

test("the time is said in Chinese everywhere, the engine's word for it nowhere (review RF2 P2-3)", () => {
  const card = progressionCard(fixture("emax-slope"));
  assert.equal(card.timeUnit, "个月");
  assert.equal(card.expected.value.unit, "points / 个月", "a slope is per month, and the outcome's own unit is the person's word");
  for (const sentence of strings({ ...card, series: null, table: null })) assert.doesNotMatch(sentence, /\bmonths?\b/);
});

test("the curve is exact and the power is simulated, with the closed form beside it", () => {
  const card = progressionCard(fixture("linear-change"));
  assert.equal(card.power.source, "synthetic");
  assert.ok(card.power.mcse > 0 && card.power.unit === "%");
  assert.equal(card.approximation.source, "calculated");
  assert.ok(Math.abs(card.power.value - card.approximation.value) < 4 * card.power.mcse + 1.2, "the simulation agrees with the closed form of the same test");
  assert.deepEqual(card.visits, [0, 6, 12, 18]);
  const last = card.table.rows[3];
  assert.equal(last.control.mean.source, "calculated");
  assert.equal(last.control.mean.unit, "points");
  assert.ok(Math.abs(last.control.mean.value - (3 + 0.12 * 18)) < 1e-6, "the control mean is the baseline plus the slope times the time");
  assert.ok(Math.abs(last.gap.value - 0.12 * 18 * (0.75 - 1)) < 1e-6, "the treated curve is the clock slowed by a quarter");
  assert.equal(card.series.length, 2);
  assert.ok(card.series.every((series) => series.points.length === 4 && series.points[3].low < series.points[3].y && series.points[3].y < series.points[3].high));
});

test("the source of every stated number is a premise, in the page's words", () => {
  const card = progressionCard(fixture("linear-change"));
  const byKey = Object.fromEntries(card.premises.map((premise) => [premise.key, premise]));
  assert.equal(byKey["progression:model.amplitude"].source, "literature");
  assert.equal(byKey["progression:model.amplitude"].reason, "case", "the citation travels");
  assert.equal(byKey["progression:baseline.sd"].source, "given", "an estimate from the person's own data is theirs");
  assert.equal(byKey["progression:treatment.slowing"].source, "assumed");
  assert.equal(byKey["progression:treatment.slowing"].value, "25%");
  assert.ok(byKey["progression:alpha"].source === "default" && byKey["progression:clock"]);
  assert.ok(card.premises.filter((premise) => premise.decisive).length <= 5);
});

test("with no slowing the same number is the type I error, and the question changes", () => {
  const card = progressionCard(fixture("null"));
  assert.equal(card.powerName, "没有真实效应时误判有效的概率");
  assert.match(card.question, /误判有效/);
  assert.ok(Math.abs(card.power.value - 5) < 4 * card.power.mcse + 0.5, "the level of the test");
  assert.ok(card.table.rows.every((row) => Math.abs(row.gap.value) < 1e-9));
});

test("the cards of the tab are the current results, newest first, and no back-office word is in a sentence", () => {
  const bundle = { allResults: [fixture("linear-change"), { ...fixture("emax-slope"), id: "res_2", createdAt: "2026-11-05T00:00:00Z" }, { ...fixture("null"), id: "res_3", supersededBy: "res_4" }], stale: [] };
  const cards = presentProgressions(bundle, { nodeOf: (result) => `result:${result.id}` });
  assert.deepEqual(cards.map((card) => card.id), ["res_2", "res_1"]);
  assert.match(cards[0].title, /Emax/);
  assert.match(cards[0].question, /斜率/);
  for (const card of cards) {
    for (const word of strings({ title: card.title, question: card.question, label: card.label, reason: card.reason, premises: card.premises.map((p) => [p.label, p.value]) })) assert.ok(!/[a-z]+_[a-z_]+/.test(word), word);
  }
});

test("the Alzheimer model (beta_logit) says what it rests on: the person's hypothesis, the published parameters, no regulatory status, a group within its range", () => {
  const card = progressionCard(fixture("alzheimer-beta-logit"));
  assert.match(card.title, /阿尔茨海默病 ADAS-cog 11/);
  assert.equal(card.label, "人群层面，不是对个人的预测");
  assert.match(card.question, /第 78 周/);
  assert.ok(card.question.length < 40, "the card's question is one short sentence; the effect lives in the premise");
  assert.equal(card.power.source, "synthetic");
  assert.ok(card.power.mcse > 0);
  assert.equal(card.approximation, null, "the model has no closed-form power, and the card claims none");
  assert.equal(card.expected.value.source, "calculated");
  assert.ok(card.expected.value.value < 0, "a drug that helps lowers the ADAS-cog change");
  assert.equal(card.timeUnit, "周");
  assert.equal(card.table.rows.length, 9);
  assert.equal(card.table.rows[0].control.mean.unit, "分", "ADAS-cog points, in the page's word");
  assert.equal(card.expected.value.unit, "分");
  assert.ok(Math.abs(card.table.rows[0].gap.value) < 1e-12, "the arms start alike");
  const decisive = card.premises.filter((premise) => premise.decisive).map((premise) => premise.key);
  // R27: the external validation of the placebo progression is the fifth decisive premise of every Alzheimer page
  assert.deepEqual(decisive, ["progression:ad:effect", "progression:ad:parameters", "progression:ad:scope", "progression:ad:mmse", "credibility:validation"]);
  const byKey = Object.fromEntries(card.premises.map((premise) => [premise.key, premise]));
  assert.match(byKey["progression:ad:effect"].value, /你设定的假设，不是对某个药物疗效的预测/);
  assert.match(byKey["progression:ad:effect"].value, /减慢 30%/);
  assert.equal(byKey["progression:ad:effect"].source, "assumed");
  assert.equal(byKey["progression:ad:parameters"].value, "参数直接用 CAMD 模型（Rogers 等，2012）公开的原值，没有按你的数据重新估计。");
  assert.doesNotMatch(byKey["progression:ad:parameters"].value, /表 \d|图 \d|EMA/, "the reproduction detail is a folded row, never in the decisive sentence");
  assert.match(byKey["progression:ad:reproduction"].value, /表 7、表 9、表 11 一致，与表 10 和图 15、图 16 不一致/);
  assert.equal(byKey["progression:ad:reproduction"].decisive, false);
  assert.equal(byKey["progression:ad:regulatory"].decisive, false);
  assert.match(byKey["progression:ad:regulatory"].value, /不适用于这里的计算/);
  assert.match(byKey["progression:ad:scope"].value, /不是对某一个人的预测/);
  assert.match(byKey["progression:ad:scope"].value, /第 130 周，超过两年的部分是外推/);
  assert.equal(byKey["progression:ad:mmse"].source, "default");
  assert.match(byKey["progression:ad:mmse"].value, /16–26 分/);
  assert.ok(byKey["progression:ad:uncertainty"] && byKey["progression:ad:dropout"] && byKey["progression:ad:analysis"] && !byKey["progression:ad:uncertainty"].decisive);
  for (const word of strings({ title: card.title, question: card.question, label: card.label, reason: card.reason, premises: card.premises.map((p) => [p.label, p.value]) })) {
    assert.ok(!/[a-z]+_[a-z_]+/.test(word), word);
    assert.doesNotMatch(word, /adsim|parameterSet|posterior_draws|「|」/);
  }
});

test("an entry range outside mild to moderate disease is said to be an extrapolation, and the curve claims no 95% band (review stats P2-6, P2-7)", () => {
  const base = fixture("alzheimer-beta-logit");
  const moved = structuredClone(base);
  moved.diagnostics.progression.population = { ...moved.diagnostics.progression.population, mmseRange: [5, 12] };
  const scope = progressionCard(moved).premises.find((premise) => premise.key === "progression:ad:scope");
  assert.match(scope.value, /基线 MMSE 5–12 分超出了轻中度的范围（约 10–26 分）/);
  const within = progressionCard(base).premises.find((premise) => premise.key === "progression:ad:scope");
  assert.doesNotMatch(within.value, /超出了轻中度的范围/, "16–26 is mild to moderate");
  const card = progressionCard(base);
  const lines = JSON.stringify(card).match(/"bandKind":"[a-z_]+"/g) ?? [];
  assert.deepEqual(lines, [], "mean ± 1.96 SD of a bounded score is not drawn as a 95% prediction band");
});

test("the live case: twelve Alzheimer runs are twelve cards, each titled by what it compared, its arm sizes and its study variation", () => {
  // Live D3 (2026-11-07, conversation c): the patients page listed 8 of 12 runs (a cap of eight dropped the oldest -- the no-drug and the
  // symptomatic run), all under one title.
  const base = fixture("alzheimer-beta-logit");
  /** @param {string} id @param {{ drug: "none" | "symptomatic" | "dm", perArm: number, uncertainty?: string, at: number }} run */
  const run = (id, { drug, perArm, uncertainty = "new_study", at }) => {
    const row = structuredClone(base);
    const progression = row.diagnostics.progression;
    row.id = id;
    row.createdAt = new Date(Date.UTC(2026, 10, 7, 21, 10, at)).toISOString();
    progression.uncertainty = uncertainty;
    progression.isNull = drug === "none";
    progression.treatment = { ...progression.treatment, symptomaticLogitEmax: drug === "symptomatic" ? -0.166 : 0, diseaseModifyingFraction: drug === "dm" ? 0.3 : 0 };
    progression.given = drug === "symptomatic" ? [{ key: "treatment.symptomatic.pointsAt", value: -2, basis: "assumed", atWeek: 12, referenceAdas: 25 }]
      : drug === "dm" ? [{ key: "treatment.diseaseModifying.fraction", value: 0.3, basis: "assumed" }] : [];
    progression.observed = progression.observed.map((entry, index) => index === 0
      ? { ...entry, control: { ...entry.control, value: perArm }, treated: { ...entry.treated, value: perArm } } : entry);
    row.counts = { ...row.counts, generatedRecords: progression.trials * 2 * perArm };
    return row;
  };
  const runs = [
    run("res_none", { drug: "none", perArm: 200, at: 1 }), run("res_sym", { drug: "symptomatic", perArm: 200, at: 2 }), run("res_dm", { drug: "dm", perArm: 200, at: 3 }),
    ...[800, 950, 1000, 1200, 1700, 1800].map((perArm, index) => run(`res_dm${perArm}`, { drug: "dm", perArm, at: 10 + index })),
    ...[800, 1000, 1200].map((perArm, index) => run(`res_typ${perArm}`, { drug: "dm", perArm, uncertainty: "typical_study", at: 20 + index })),
  ];
  const cards = presentProgressions({ allResults: runs, stale: [] }, { nodeOf: (result) => `result:${result.id}` });
  assert.equal(cards.length, 12, "every current run is a card");
  assert.equal(new Set(cards.map((card) => card.title)).size, 12, cards.map((card) => card.title).join("\n"));
  const titleOf = (/** @type {string} */ id) => cards.find((card) => card.id === id)?.title;
  assert.equal(titleOf("res_none"), "阿尔茨海默病 ADAS-cog 11 进展：两组都不用药，每组 200 人（含研究之间的差异）");
  assert.equal(titleOf("res_sym"), "阿尔茨海默病 ADAS-cog 11 进展：对症药物（第 12 周少 2 分）对比不用药，每组 200 人（含研究之间的差异）");
  assert.equal(titleOf("res_dm1000"), "阿尔茨海默病 ADAS-cog 11 进展：疾病修饰药物（减慢 30%）对比不用药，每组 1000 人（含研究之间的差异）");
  assert.equal(titleOf("res_typ1000"), "阿尔茨海默病 ADAS-cog 11 进展：疾病修饰药物（减慢 30%）对比不用药，每组 1000 人（同一个典型研究）");
  // The other families say their own slowing and size.
  assert.equal(progressionCard(fixture("linear-change")).title, "线性进展：进展减慢 25%，共 300 人");
  assert.match(progressionCard(fixture("null")).title, /治疗不改变进展/);
});

test("live D6: the answer a conversation reads says the difference between the arms at each visit, the card's own 治疗减对照", () => {
  // Phase 3 (2026-11-07, conversation c): the reply's table of 对症−安慰剂 and 疾修−安慰剂 at each visit was subtracted by the model.
  const result = fixture("alzheimer-beta-logit");
  const answered = vcrProgressionWithDifferences(result);
  const card = progressionCard(result);
  const differences = answered.diagnostics.progression.curves.map((/** @type {any} */ curve) => curve.difference);
  assert.equal(differences.length, card.table.rows.length);
  differences.forEach((/** @type {any} */ difference, /** @type {number} */ at) => {
    assert.ok(Math.abs(difference.value - card.table.rows[at].gap.value) < 1e-7, `the page and the answer say one number at visit ${card.table.rows[at].visit}`);
    assert.equal(difference.source, "calculated");
    assert.equal("mcse" in difference, false, "exact in the typical study, like the means");
  });
  assert.ok(Math.abs(differences[0].value) < 1e-12 && differences.at(-1).value < 0);
  assert.equal(result.diagnostics.progression.curves[0].difference, undefined, "the stored result is not changed");
  const other = { kind: "trial_scenario", measures: [], diagnostics: {} };
  assert.equal(vcrProgressionWithDifferences(other), other);
});

test("R26: a run with intercurrent events carries its estimand table and says which question the analysis answers", () => {
  const row = structuredClone(fixture("alzheimer-beta-logit"));
  const measure = (name, value, mcse) => ({ name, value, mcse, simulated: true, source: "synthetic", unit: "points" });
  row.diagnostics.progression.analysis = { kind: "ancova", data: "on_treatment", visit: 52, alpha: 0.05 };
  row.diagnostics.progression.intercurrent = {
    estimator: "ancova", data: "on_treatment", delta: 0, claimed: "treatment_policy",
    estimands: [
      { strategy: "treatment_policy", truth: measure("estimand_truth", -2.26, 0.012), bias: measure("estimator_bias", -0.87, 0.017), coverage: { name: "ci_coverage", value: 0.862, mcse: 0.005, simulated: true, source: "synthetic" } },
      { strategy: "hypothetical", truth: measure("estimand_truth", -3.1, 0.012), bias: measure("estimator_bias", -0.025, 0.017), coverage: { name: "ci_coverage", value: 0.951, mcse: 0.003, simulated: true, source: "synthetic" } },
    ],
    configuration: { discontinuation: { shareControl: 0.1, shareTreated: 0.3, progressionLogHazardPerSd: 0, retrievedShare: 0.5 }, withdrawal: { treatedHazardRatio: 1, progressionLogHazardPerSd: 0 } },
  };
  const card = progressionCard(row);
  assert.deepEqual(card.estimands.rows.map((entry) => [entry.key, entry.claimed]), [["treatment_policy", true], ["hypothetical", false]]);
  assert.match(card.estimands.rows[0].sentence, /停药之前的数据/, "the on-treatment analysis does not answer the treatment-policy question, and the table says so");
  assert.equal(card.estimands.rows[1].truth.value, -3.1);
  const events = card.premises.find((premise) => premise.key === "progression:ad:events");
  assert.match(events.value, /治疗组约 30%、对照组约 10% 的人停药；停药的人里约 50% 继续留在研究里随访；停不停药与病情无关/);
  const estimand = card.premises.find((premise) => premise.key === "progression:ad:estimand");
  assert.match(estimand.value, /不论是否停药（治疗策略）：真实差值 -2\.26 分，这个分析的偏差 -0\.87/);
  assert.equal(estimand.decisive, true, "the analysis does not answer the question that was claimed");
  const analysis = card.premises.find((premise) => premise.key === "progression:ad:analysis");
  assert.match(analysis.value, /只用停药之前（用药期间）的数据/);
  // the study's question names the strategy: a row says whether this analysis answers it
  const [presented] = presentProgressions({ allResults: [row], stale: [], researchQuestion: { id: "main", version: 1, fields: { intercurrentEvents: [{ event: "因不良反应停药", strategy: "treatment_policy", mechanism: "" }] } } }, { nodeOf: (result) => `result:${result.id}` });
  const asked = presented.premises.find((premise) => premise.key === "question:estimator:treatment_policy");
  assert.match(asked.value, /研究问题要的是“不论是否停药”的效应。这个分析只用了停药之前的数据/);
  // a run without them has none of it
  assert.equal(progressionCard(fixture("alzheimer-beta-logit")).estimands, null);
  assert.equal(progressionCard(fixture("alzheimer-beta-logit")).premises.some((premise) => premise.key === "progression:ad:estimand"), false);
});

test("an effect the person typed reads as their data on the Alzheimer page, a half-typed one and an unchecked one do not (round-2 review P1-1)", () => {
  const withRecord = (personStated) => {
    const result = fixture("alzheimer-beta-logit");
    if (personStated) result.diagnostics.personStated = personStated;
    return Object.fromEntries(progressionCard(result).premises.map((premise) => [premise.key, premise]));
  };
  const both = { schema: 2, readable: true, paths: [], bindings: [], matched: ["treatment.symptomatic.pointsAt.value", "treatment.diseaseModifying.fraction.value"] };
  assert.equal(withRecord(both)["progression:ad:effect"].source, "given");
  assert.equal(withRecord({ ...both, matched: both.matched.slice(0, 1) })["progression:ad:effect"].source, "assumed", "every number of the hypothesis must be theirs");
  assert.equal(withRecord(null)["progression:ad:effect"].source, "assumed");
  assert.equal(withRecord({ schema: 2, readable: false, paths: [], bindings: [] })["progression:ad:effect"].source, "assumed");
  assert.equal(withRecord(both)["progression:ad:dosing"].source, "default", "an engine default stays a default whatever the person wrote");
});
