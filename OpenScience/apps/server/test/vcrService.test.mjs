// 「虚拟临床研究」's switch, its deterministic read-model rules, and the first
// catalogue it seeds — all without a database.
//
// The rules held here are the ones a page must never ask a model about: which
// comparator routes a data tier can reach, which design is dominated on the
// team's own comparison goal, and how the four counts are read apart.
import assert from "node:assert/strict";
import test from "node:test";
import {
  VcrService, VCR_READ_WHATS, VCR_REFERENCE_INPUTS, VCR_REFERENCE_MODELS, VCR_WRITE_WHATS, seedVcrCatalogue, vcrAudienceAllows, vcrCountBand,
  vcrDominatedScenarios, vcrPatientScenarioKeys, vcrReadiness, vcrReferenceModelInputs, vcrRouteOptions, VCR_UNSUPPORTED_COMPARATOR_ROUTES,
} from "../src/vcrService.mjs";
import {
  VCR_COUNT_KEYS, VCR_ENDPOINT_TYPES, VCR_ENGINE_METHODS, VCR_ROUTE_MIN_TIER, VCR_SCENARIO_SCHEMAS, VCR_TABS, intendedUseCeiling, missingModelEvidence, validateScenario,
} from "@evimed/domain";

test("AC-01 the module is invisible unless it is on and open to this account", () => {
  const off = { vcrEnabled: false, vcrAudience: "all" };
  assert.equal(vcrAudienceAllows(off, { id: "u1" }), false);
  const everyone = { vcrEnabled: true, vcrAudience: "all" };
  assert.equal(vcrAudienceAllows(everyone, { id: "u1" }), true);
  const operators = { vcrEnabled: true, vcrAudience: "operators", operatorUsers: ["ops"], vcrPreviewUsers: ["preview"] };
  assert.equal(vcrAudienceAllows(operators, { id: "ops" }), true);
  assert.equal(vcrAudienceAllows(operators, { id: "preview" }), true);
  assert.equal(vcrAudienceAllows(operators, { id: "someone" }), false);
  assert.equal(vcrAudienceAllows(operators, null), false);
});

test("AC-01 the study page has exactly seven tabs, and the runtime's vocabularies are closed", () => {
  assert.deepEqual([...VCR_TABS], ["overview", "population", "patients", "comparator", "trial", "matching", "data"]);
  assert.equal(VCR_TABS.length, 7, "the design spec caps a page at seven tabs");
  // The two vocabularies a run may name. Numbers are on neither write list.
  for (const forbidden of ["results", "counts", "measures", "execution"]) {
    assert.equal(VCR_WRITE_WHATS.includes(forbidden), false, forbidden);
  }
  assert.ok(VCR_READ_WHATS.includes("results"), "a run reads results, it does not write them");
});

test("which comparator routes a data tier can reach is deterministic, not a model's opinion", () => {
  const t0 = vcrRouteOptions("T0");
  assert.deepEqual(t0.filter((option) => option.available).map((option) => option.route),
    ["literature_control", "hybrid_control"]);
  const t2 = vcrRouteOptions("T2");
  assert.deepEqual(t2.filter((option) => option.available).map((option) => option.route),
    ["external_control", "literature_control", "hybrid_control"]);
  const t3 = vcrRouteOptions("T3");
  assert.deepEqual(t3.filter((option) => !option.available).map((option) => option.route), ["model_comparator"], "T3 reaches every route the engine can compute");
  // The model-prediction comparator is listed and never offered, at any tier.
  for (const tier of ["T0", "T1", "T2", "T3"]) {
    const model = vcrRouteOptions(tier).find((option) => option.route === "model_comparator");
    assert.deepEqual([model?.supported, model?.available], [false, false], tier);
  }
  assert.deepEqual([...VCR_UNSUPPORTED_COMPARATOR_ROUTES], ["model_comparator"]);
  // The table is the domain's, not this module's second copy of it.
  for (const option of t0) assert.equal(option.minimumTier, VCR_ROUTE_MIN_TIER[option.route]);
});

test("the four counts are read apart, and the two optional ones only appear when their route was used", () => {
  const band = vcrCountBand({ realPatients: 300, events: 138, generatedRecords: 0 });
  assert.deepEqual(Object.keys(band).sort(), [...VCR_COUNT_KEYS].sort());
  assert.equal(band.effectiveSampleSize, null, "a count nobody took is null, never 0");
  const weighted = vcrCountBand({ realPatients: 300, events: 138, effectiveSampleSize: 186, generatedRecords: 0,
    reconstructedPseudoPatients: 412 });
  assert.equal(weighted.reconstructedPseudoPatients, 412);
  assert.equal(weighted.realPatients, 300, "a reconstructed pseudo-patient is never folded into a real one");
});

test("a design is dominated only when the team's own goal makes it decidable, and a tie does not dominate", () => {
  const measures = (/** @type {Record<string, number>} */ values) => ({
    result: { measures: Object.entries(values).map(([name, value]) => ({ name, value })) },
  });
  const scenarios = [
    { id: "A", label: "单臂 + 文献对照", ...measures({ power: 0.61, duration_months: 30, cost: 1_200 }) },
    { id: "B", label: "2:1 随机", ...measures({ power: 0.71, duration_months: 26, cost: 1_000 }) },
    { id: "C", label: "1:1 随机加期中", ...measures({ power: 0.71, duration_months: 26, cost: 1_000 }) },
  ];
  // With no goal written down the platform orders nothing.
  assert.deepEqual(vcrDominatedScenarios(scenarios, {}), []);
  const goal = { measures: [{ name: "power", direction: "higher" }, { name: "duration_months", direction: "lower" }, { name: "cost", direction: "lower" }] };
  const dominated = vcrDominatedScenarios(scenarios, goal);
  assert.deepEqual(dominated.map((entry) => entry.id), ["A"], "A is worse on all three");
  assert.ok(["B", "C"].includes(dominated[0].dominatedBy));
  // B and C are equal on everything: neither dominates the other.
  assert.deepEqual(vcrDominatedScenarios(scenarios.slice(1), goal), []);
  // A measure one design does not report leaves the comparison undecidable.
  const partial = [...scenarios.slice(1), { id: "D", label: "自适应", ...measures({ power: 0.8 }) }];
  assert.deepEqual(vcrDominatedScenarios(partial, goal).map((entry) => entry.id), []);
});

test("AC-34 the intended use a result may claim follows from the tiers of the models it used", () => {
  assert.equal(intendedUseCeiling([]), "submission_preparation", "no model, no model ceiling");
  assert.equal(intendedUseCeiling(["scenario"]), "exploratory");
  assert.equal(intendedUseCeiling(["validated", "literature"]), "design_support", "the weakest model decides");
  assert.equal(intendedUseCeiling(["data"]), "specified_analysis");
  // And the evidence a model's own risk demands is separate from its tier.
  assert.deepEqual([...missingModelEvidence("none", ["code_verification", "seed_reproducible"])], []);
  assert.deepEqual([...missingModelEvidence("medium", ["code_verification", "seed_reproducible"])],
    ["input_traceable", "sensitivity_analysis", "external_validation", "model_locked", "model_analysis_plan"]);
});

test("the first catalogue seeds every engine method, the three reference simulators and the trajectory model, idempotently", async () => {
  /** @type {any[]} */
  const methods = [];
  /** @type {any[]} */
  const models = [];
  const store = {
    async ready() { return true; },
    async saveMethod(input) { methods.push(input); return { id: `mth_${methods.length}` }; },
    async saveModel(input) { models.push(input); return { id: `mdl_${models.length}` }; },
  };
  const seeded = await seedVcrCatalogue({ store });
  assert.equal(seeded.methods, Object.keys(VCR_ENGINE_METHODS).length);
  assert.equal(seeded.models, VCR_REFERENCE_MODELS.length);
  assert.deepEqual(VCR_REFERENCE_MODELS.map((model) => model.name), ["reference-continuous", "reference-binary", "reference-time-to-event", "reference-longitudinal"]);
  assert.equal(seeded.engineMismatch, null, "no engine, nothing to compare against");
  // The methods are the domain's list, at the versions the domain pins.
  assert.deepEqual(methods.map((method) => method.method).sort(), Object.keys(VCR_ENGINE_METHODS).sort());
  for (const method of methods) assert.equal(method.version, VCR_ENGINE_METHODS[method.method].version);
  assert.ok(methods.every(method => !Object.hasOwn(method, 'numericTests') && !Object.hasOwn(method, 'assumptions')),
    'A catalogue restart must not erase trusted release evidence.');
  // The simulators are scenario-tier by construction: they answer 「under
  // these assumptions」 and carry no claim about any real population.
  assert.deepEqual(models.map((model) => model.name), VCR_REFERENCE_MODELS.map((model) => model.name));
  for (const model of models) {
    assert.equal(model.tier, "scenario");
    assert.equal(model.risk, "none");
    assert.deepEqual([...missingModelEvidence(model.risk, model.evidence)], [], "a reference simulator carries what its risk asks for");
    assert.match(String(model.applicability.population), /情景推演/);
    assert.ok(model.card.knownLimits.length > 0 && model.card.retirement, "a model card states its limits and its retirement rule");
  }
});

/** The smallest scenario each patient generator takes, to hold one key at a time against the real validator. */
const GENERATOR_BASE = /** @type {Record<string, Record<string, any>>} */ ({
  continuous: { design: { nTreat: 100 }, endpoint: { type: "continuous" }, truth: { effect: 0.5 } },
  binary: { design: { nTreat: 100 }, endpoint: { type: "binary" }, truth: { controlRate: 0.3, treatmentRate: 0.45 } },
  time_to_event: { design: { nTreat: 100 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 6 } },
});

/**
 * Whether the domain's own validator reads `top.sub` for one endpoint's patient
 * generator: the key is set (under each accrual variant in turn) and the answer
 * is whether it comes back as a field the engine does not read. A value of the
 * wrong type is beside the point — the question is the key.
 * @param {string} endpointType @param {string} key
 */
function generatorReads(endpointType, key) {
  const [top, sub] = key.split(".");
  return (top === "accrual" && sub !== "kind" ? ["uniform", "piecewise"] : [null]).some((variant) => {
    const scenario = structuredClone(GENERATOR_BASE[endpointType]);
    scenario[top] = { ...(scenario[top] ?? {}), ...(variant ? { kind: variant } : {}), [sub]: sub === "kind" ? "uniform" : 1 };
    const unknown = validateScenario(`patients.${endpointType}`, scenario)
      .filter((issue) => issue.code === "scenario_field_unknown").map((issue) => issue.field);
    return !unknown.includes(`scenario.${top}`) && !unknown.includes(`scenario.${top}.${sub}`);
  });
}

test("a reference simulator's card lists exactly the inputs its endpoint's schema reads: no follow-up or dropout for an endpoint that has none", () => {
  // one simulator per endpoint family; the trajectory model is a fourth, read through its own schema (the next test)
  const perEndpoint = VCR_REFERENCE_MODELS.filter((model) => model.name !== "reference-longitudinal");
  assert.deepEqual(perEndpoint.map((model) => model.endpointType).sort(), [...VCR_ENDPOINT_TYPES].sort(), "one simulator per endpoint family");
  const tabled = VCR_REFERENCE_INPUTS.flatMap((input) => input.keys);
  assert.equal(new Set(tabled).size, tabled.length, "a key belongs to one row");
  for (const model of perEndpoint) {
    const endpoint = model.endpointType;
    assert.equal(model.card.interface, `vcr-engine patients.${endpoint}`, "the card is read through its own method's schema");
    // The oracle is the validator a job is refused by, not the helper that built the card.
    for (const input of VCR_REFERENCE_INPUTS) {
      const read = input.keys.filter((key) => generatorReads(endpoint, key));
      assert.equal(model.card.inputs.includes(input.label), read.length > 0,
        `${model.name}: 「${input.label}」 is ${read.length ? "read by" : "refused by"} the ${endpoint} schema`);
    }
    assert.deepEqual([...model.card.inputs], [...vcrReferenceModelInputs(endpoint)]);
    // And nothing the schema reads is left off the card: a key the engine starts reading needs a row.
    const keys = vcrPatientScenarioKeys(endpoint);
    assert.ok(keys.length >= 6 && keys.includes("design.nTreat"), `${endpoint}: the walk found the schema's keys`);
    for (const key of keys) {
      assert.ok(generatorReads(endpoint, key), `${endpoint}: ${key} is not a key the validator reads`);
      assert.ok(tabled.includes(key), `${endpoint}: the schema reads ${key} and no card row names it`);
    }
  }
  for (const key of tabled) {
    assert.ok(perEndpoint.some((model) => generatorReads(model.endpointType, key)), `${key} is in the table and no generator reads it`);
  }
  // What the pilot's run was refused for: `accrual` on a binary set, offered by the binary card.
  const followUp = /脱落|入组|随访/;
  const card = (/** @type {string} */ endpoint) => perEndpoint.find((model) => model.endpointType === endpoint)?.card.inputs ?? [];
  assert.equal(card("binary").some((label) => followUp.test(label)), false);
  assert.equal(card("continuous").some((label) => followUp.test(label)), false);
  assert.equal(card("time_to_event").filter((label) => followUp.test(label)).length, 3);
  assert.equal(generatorReads("binary", "accrual.dropoutAnnual"), false, "the validator refuses what the old card offered");
  assert.equal(generatorReads("time_to_event", "accrual.dropoutAnnual"), true);
});

/** What each row of the trajectory model's card says, and the keys of the `patients.longitudinal` schema it stands for. */
const LONGITUDINAL_INPUTS = /** @type {const} */ ([
  ["两组人数", ["design.nTreat", "design.nControl"]],
  ["随访时间表", ["visits"]],
  ["基线水平与对照组的变化速度", ["truth.intercept", "truth.slope"]],
  ["处理效应（每个时间单位变化速度的差）", ["truth.effect"]],
  ["个体间的差异（截距与斜率的标准差及相关）", ["truth.randomEffects"]],
  ["残差标准差", ["truth.sd"]],
  ["每次随访前退出的概率", ["dropoutPerVisit"]],
  ["协变量效应（取自已存人群）", ["truth.covariateEffects"]],
]);

test("the trajectory model's card lists exactly the inputs its own schema reads, and says what it is not", () => {
  const model = VCR_REFERENCE_MODELS.find((entry) => entry.name === "reference-longitudinal");
  assert.ok(model, "the catalogue has the trajectory model");
  assert.equal(model.tier, "scenario");
  assert.equal(model.risk, "none");
  assert.equal(model.card.interface, "vcr-engine patients.longitudinal", "the card is read through its own method's schema");
  assert.deepEqual([...model.applicability.endpoints], ["continuous"]);
  assert.deepEqual([...model.card.inputs], LONGITUDINAL_INPUTS.map(([label]) => label));
  // Every key the schema reads (two levels deep, as the card table does) is on some row, and every row names a key the validator reads.
  const schema = /** @type {Record<string, any>} */ (VCR_SCENARIO_SCHEMAS)["patients.longitudinal"];
  const read = /** @type {string[]} */ ([]);
  for (const [top, field] of Object.entries(/** @type {Record<string, any>} */ (schema.fields))) {
    if (top === "endpoint") continue;
    if (field.t === "object") for (const key of Object.keys(field.fields)) read.push(`${top}.${key}`);
    else read.push(top);
  }
  const named = LONGITUDINAL_INPUTS.flatMap(([, keys]) => keys);
  for (const key of read) assert.ok(named.includes(key), `the schema reads ${key} and no card row names it`);
  for (const key of named) assert.ok(read.includes(key), `a card row names ${key}, which the schema does not read`);
  assert.ok(model.card.knownLimits.some((/** @type {string} */ limit) => /不可用于个体层面的预测/.test(limit)), "it is not an individual prediction");
  assert.ok(model.card.knownLimits.some((/** @type {string} */ limit) => /完全随机缺失/.test(limit)), "it says its dropout is random");
});

test("a catalogue the engine does not match is a notice, never a block", async () => {
  const store = { async ready() { return true; }, async saveMethod() { return {}; }, async saveModel() { return {}; } };
  const engine = {
    configured: () => true,
    async health() { return { ok: true, methods: ["design.simulate", "something.else"] }; },
  };
  const seeded = await seedVcrCatalogue({ store, engine });
  assert.ok(seeded.engineMismatch.some((line) => line.includes("引擎有目录没有：something.else")));
  assert.ok(seeded.engineMismatch.some((line) => line.includes("目录有引擎没有：comparator.rmst")));

  // An engine that cannot be reached is reported and the seeding still stands.
  /** @type {string[]} */
  const reported = [];
  const unreachable = await seedVcrCatalogue({
    store, report: (code) => reported.push(code),
    engine: { configured: () => true, async health() { const error = new Error("down"); /** @type {any} */ (error).code = "vcr_engine_unreachable"; throw error; } },
  });
  assert.equal(unreachable.engineMismatch, null);
  assert.deepEqual(reported, ["vcr_engine_unreachable"]);
});

test("readiness is red only for this module's own invariants; a missing engine is a warning", async () => {
  assert.deepEqual(await vcrReadiness({ config: { vcrEnabled: false }, vcr: null, database: null }), { enabled: false, status: "off" });
  await assert.rejects(vcrReadiness({ config: { vcrEnabled: true }, vcr: null, database: {} }),
    (/** @type {any} */ error) => error.code === "vcr_unavailable");
  await assert.rejects(vcrReadiness({ config: { vcrEnabled: true }, vcr: { service: { async ready() { const error = new Error("x"); /** @type {any} */ (error).code = "42P01"; throw error; } } }, database: {} }),
    (/** @type {any} */ error) => error.code === "vcr_migration_failed");

  const ready = await vcrReadiness({
    config: { vcrEnabled: true, vcrAudience: "operators", vcrDataPlaneDir: "" },
    vcr: { service: { async ready() { return true; }, engineMismatch: null }, engine: { configured: () => false } },
    database: {},
  });
  assert.equal(ready.status, "ok");
  assert.deepEqual(ready.warnings, ["vcr_engine_not_composed", "vcr_data_plane_not_configured"]);
  assert.equal(ready.warning, "vcr_engine_not_composed");
  assert.equal(ready.engineAvailable, false, "no engine composed: the page says the engine is not there");
  // composed and not known to be down is available; composed and down is not
  for (const [state, available] of /** @type {Array<[string | null, boolean]>} */ ([["answering", true], [null, true], ["not_answering", false]])) {
    const reading = await vcrReadiness({ config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: "/plane" },
      vcr: { service: { async ready() { return true; }, engineMismatch: null }, engine: { configured: () => true }, engineProbe: { snapshot: () => (state ? { state, checkedAt: null } : null) } }, database: {} });
    assert.equal(reading.engineAvailable, available, String(state));
  }
});

test('legacy public prediction flags are not presented as a publication capability', async () => {
  const service = new VcrService({ store: {
    trialScenarios: async () => [], latestDesignGrid: async () => null,
    forecasts: async () => [{ id: 'forecast', public: true, prediction: { probability: 0.8 } }],
  }, config: {} });
  const result = await service.runtimeRead({ id: 'study', userId: 'owner' }, 'trial');
  assert.equal(result.forecasts[0].public, undefined);
  assert.equal(result.forecasts[0].prediction.probability, 0.8);
});

// --- the data tier: offered from the frozen data, held to it, never lowered ----------------------

/**
 * A store that answers a page's reads with nothing but the study and what the
 * test says, so the service's own header logic can be read without a database.
 * @param {Record<string, any>} study @param {{ roles?: string[] }} [options]
 */
function studyOnly(study, { roles = [] } = {}) {
  /** @type {Array<[string, Record<string, any>]>} */
  const updates = [];
  const base = {
    async getStudy(/** @type {string} */ userId, /** @type {string} */ id) { return id === study.id && (userId === study.userId || roles.length) ? study : null; },
    async rolesOf() { return roles; },
    async updateStudy(/** @type {string} */ _id, /** @type {Record<string, any>} */ fields) { updates.push(["update", fields]); return { ...study, ...fields }; },
    async setStep() { return study; },
  };
  const plural = /^(results|allResults|staleMarks|reviews|jobs|assumptions|members|exports|decisions|trialScenarios|comparatorDesigns|populations|patientSets|forecasts|models|edges|criteria|rows|assumptionVersions)$/;
  const store = new Proxy(base, { get(target, name) { return name in target ? /** @type {any} */ (target)[name] : async () => (plural.test(String(name)) ? [] : null); } });
  return { store, updates };
}

const t0Study = { id: "std_tier", userId: "lead", projectId: "prj_tier", name: "EV-201", question: "q", dataTier: "T0", intendedUse: "exploratory", status: "active", steps: {}, budget: {}, outcomeSeal: {} };
/** @param {string} tier */
const planeSupporting = (tier) => ({ async tierSupport() { return { tier, subjects: 240, treatment: tier === "T2", outcomes: tier === "T2" }; } });

test("the study header offers the move its frozen data supports, once, to the lead who may make it — and nothing when the data supports nothing more", async () => {
  /** @param {string} tier @param {Record<string, any>} [study] @param {string[]} [roles] @param {any} [plane] */
  const view = async (tier, study = t0Study, roles = [], plane = planeSupporting(tier)) => {
    const { store } = studyOnly(study, { roles });
    return new VcrService({ store: /** @type {any} */ (store), config: {}, dataPlane: plane }).studyView({ id: roles.length ? "member" : "lead" }, study.id);
  };
  const t1 = (await view("T1")).tierOffer;
  assert.deepEqual([t1.tier, t1.label, t1.unlocks], ["T1", "T1 基线与招募资料", ["用你的数据筛真实队列、做患者匹配与招募"]]);
  assert.deepEqual(t1.basis, { subjects: 240, treatment: false, outcomes: false });
  const t2 = (await view("T2")).tierOffer;
  assert.equal(t2.tier, "T2", "the highest the data supports, in one move");
  assert.deepEqual(t2.unlocks, ["用你的数据筛真实队列、做患者匹配与招募", "走真实外部对照，用真实结局分布做仿真"]);

  // Nothing to offer where the data supports no more than the study already claims — and a rise is never turned into a lowering.
  assert.equal((await view("T0")).tierOffer, null);
  assert.equal((await view("T1", { ...t0Study, dataTier: "T1" })).tierOffer, null);
  assert.equal((await view("T1", { ...t0Study, dataTier: "T2" })).tierOffer, null);
  assert.equal((await view("T2", { ...t0Study, dataTier: "T3" })).tierOffer, null);
  // Roles are unchanged: only the lead (manage_study) is offered an action the route would refuse anyone else.
  for (const role of ["viewer", "data_manager", "statistical_reviewer", "recruiter"]) assert.equal((await view("T1", t0Study, [role])).tierOffer, null, role);
  assert.equal((await view("T1", t0Study, ["lead"])).tierOffer?.tier, "T1");
  // No data plane composed, or one that cannot answer: nothing is offered and nothing breaks.
  assert.equal((await view("T1", t0Study, [], null)).tierOffer, null);
  assert.equal((await view("T1", t0Study, [], { async tierSupport() { throw new Error("plane down"); } })).tierOffer, null);
});

test("a rise in tier needs data that supports it; T3 needs the data that qualifies as T2; a lowering or the same tier is never held to it", async () => {
  /** @param {string} from @param {string} supports @param {string} to */
  const move = async (from, supports, to) => {
    const study = { ...t0Study, dataTier: from };
    const { store, updates } = studyOnly(study);
    const service = new VcrService({ store: /** @type {any} */ (store), config: {}, dataPlane: planeSupporting(supports) });
    return { updated: await service.updateStudy({ id: "lead" }, study.id, { dataTier: to }).catch((/** @type {any} */ error) => error), updates };
  };
  // Refused by name, saying what the data reach and what to do, and nothing is written.
  for (const [from, supports, to, reached] of [["T0", "T0", "T1", "还没有可用的患者级数据"], ["T0", "T1", "T2", "现有数据只到「T1 基线与招募资料」"], ["T1", "T1", "T3", "现有数据只到「T1 基线与招募资料」"], ["T0", "T2", "T3", null]]) {
    const { updated, updates } = await move(from, supports, to);
    if (reached === null) { assert.equal(updated.dataTier, "T3", "T3 is the lead's declaration on data that qualifies as T2"); continue; }
    assert.equal(updated.status, 409, `${from}→${to} on ${supports} data`);
    assert.equal(updated.code, "vcr_tier_unsupported");
    assert.ok(updated.message.includes(reached), updated.message);
    assert.match(updated.message, /定义与证据/);
    assert.deepEqual(updates, [], "nothing was written");
  }
  // Supported: the move is made, as before.
  for (const [from, supports, to] of [["T0", "T1", "T1"], ["T0", "T2", "T2"], ["T0", "T2", "T1"], ["T1", "T2", "T2"], ["T2", "T2", "T3"]]) {
    assert.equal((await move(from, supports, to)).updated.dataTier, to, `${from}→${to} on ${supports} data`);
  }
  // Lowering and staying put are the lead's explicit acts and never need the data.
  for (const [from, to] of [["T2", "T1"], ["T3", "T0"], ["T1", "T0"], ["T1", "T1"], ["T0", "T0"]]) {
    assert.equal((await move(from, "T0", to)).updated.dataTier, to, `${from}→${to} with no data at all`);
  }
  // A patch that does not touch the tier does not ask the plane anything.
  const study = { ...t0Study };
  const { store } = studyOnly(study);
  let asked = 0;
  const service = new VcrService({ store: /** @type {any} */ (store), config: {}, dataPlane: { async tierSupport() { asked += 1; return { tier: "T0" }; } } });
  await service.updateStudy({ id: "lead" }, study.id, { name: "新名字" });
  assert.equal(asked, 0);
  // With no data plane composed a rise is refused like any other the data cannot support.
  const bare = new VcrService({ store: /** @type {any} */ (studyOnly(study).store), config: {} });
  await assert.rejects(bare.updateStudy({ id: "lead" }, study.id, { dataTier: "T1" }), (/** @type {any} */ error) => error.code === "vcr_tier_unsupported");
});

/** A service whose store keeps what it was asked to save. */
function adoptingService() {
  /** @type {any[]} */
  const saved = [];
  const store = {
    async saveModel(/** @type {any} */ input) { saved.push(input); return { id: "mdl_new", name: input.name, version: input.version, tier: input.tier }; },
    async audit() {},
  };
  return { saved, service: new VcrService({ store: /** @type {any} */ (store), config: { vcrEnabled: true, vcrAudience: "all" } }) };
}

test("a model is adopted as the first call shape unless its card says otherwise, and an unknown shape is refused by name", async () => {
  const { saved, service } = adoptingService();
  const plain = /** @type {any} */ (await service.adoptModel({ id: "u1" }, { name: "fitted-os", version: "1.0.0", card: { inputs: ["年龄"] } }));
  assert.equal(saved[0].card.type, "fitted_prediction_model");
  assert.deepEqual(plain.issues, [], "a first-shape card is asked for nothing new");
  await assert.rejects(service.adoptModel({ id: "u1" }, { name: "x", card: { interfaceShape: "quantum" } }), { code: "vcr_model_invalid" });
  assert.equal(saved.length, 1, "nothing was saved for the unknown shape");
});

test("a model of the event-history shape is kept with the card it arrives with, typed generative, and what the card lacks comes back as notices", async () => {
  const { saved, service } = adoptingService();
  const bare = /** @type {any} */ (await service.adoptModel({ id: "u1" }, { name: "event-model", version: "2.1.0", card: { interfaceShape: "event_history_to_trajectories" } }));
  assert.equal(saved[0].card.type, "generative", "a generator of sampled futures is not a fitted prediction model");
  assert.equal(saved[0].card.interfaceShape, "event_history_to_trajectories");
  assert.equal(bare.id, "mdl_new", "the model is kept: a card with gaps is still a card");
  const fields = bare.issues.map((/** @type {any} */ issue) => issue.field);
  for (const field of ["card.inputs", "card.outputs", "card.history.eventTypes", "applicability.eventTypes", "applicability.horizon", "validation", "card.knownLimits"]) {
    assert.ok(fields.includes(field), `${field} is named`);
  }
  const complete = /** @type {any} */ (await service.adoptModel({ id: "u1" }, {
    name: "event-model", version: "2.2.0",
    card: { interfaceShape: "event_history_to_trajectories", inputs: ["诊断事件"], outputs: "N 条未来轨迹，是预测分布的抽样。",
      history: { eventTypes: ["diagnosis"], fields: ["subject", "event_type", "time"] }, trajectories: { max: 500, absorbing: ["death"] }, knownLimits: ["罕见事件校准较差"] },
    applicability: { eventTypes: ["death"], horizon: { max: 24, unit: "months" } }, validation: { temporal: "时间外验证" },
  }));
  assert.deepEqual(complete.issues, []);
});
