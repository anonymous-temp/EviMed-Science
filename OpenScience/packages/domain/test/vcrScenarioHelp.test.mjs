// What a model is given to write a scenario from is a rendering of the schemas the validator enforces. These tests hold
// the two together: a key the validator reads is in the help, a key it refuses is not, and an example is a scenario the
// validator accepts. The oracle is the validator itself, run on probes, not a second reading of the schema.
import assert from "node:assert/strict";
import test from "node:test";

import {
  VCR_DESIGN_SUPPORT,
  VCR_ENGINE_METHOD_IDS,
  VCR_JOB_KINDS,
  VCR_JOB_METHODS,
  VCR_RUN_SCENARIO_FIELDS,
  VCR_SCENARIO_EXAMPLES,
  VCR_SCENARIO_SCHEMAS,
  validateScenario,
  vcrScenarioChildKeys,
  vcrScenarioHelp,
  vcrScenarioParentOf,
  vcrScenarioRows,
  whenHolds,
} from "@evimed/domain";

/** @type {any} */
const help = vcrScenarioHelp();
/** A JSON-safe deep copy. @template T @param {T} value @returns {T} */
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Keys no method reads anywhere, spelled the way a model that guessed would spell them. */
const INVENTED = ["months", "dropoutRate", "dropout", "isNull", "notes", "extra", "accrualMonths", "enrolment", "sampleSize"];

test("the help covers every kind and every method, and the walk proves it walked", () => {
  assert.deepEqual(Object.keys(help.kinds), [...VCR_JOB_KINDS]);
  assert.deepEqual(Object.keys(help.methods), [...VCR_ENGINE_METHOD_IDS]);
  for (const [kind, entry] of Object.entries(help.kinds)) assert.equal(/** @type {any} */ (entry).method, /** @type {any} */ (VCR_JOB_METHODS)[kind], kind);
  const rows = Object.values(help.methods).reduce((total, method) => total + /** @type {any} */ (method).rows.length, 0);
  assert.ok(rows > 500, `only ${rows} rows were rendered`);
  for (const [method, entry] of Object.entries(help.methods)) {
    assert.ok(/** @type {any} */ (entry).examples.length >= 1, `${method} has no example`);
  }
});

test("every example is a scenario its method's validator accepts", () => {
  assert.deepEqual(Object.keys(VCR_SCENARIO_EXAMPLES).sort(), [...VCR_ENGINE_METHOD_IDS].sort(), "one list of examples per method");
  for (const [method, examples] of Object.entries(VCR_SCENARIO_EXAMPLES)) {
    for (const example of examples) {
      assert.deepEqual(validateScenario(method, example.scenario), [], `${method}: ${example.label}`);
    }
  }
});

test("the incident: accrual reads duration, followup and dropoutAnnual with their units, and nothing called months", () => {
  const rows = vcrScenarioRows("design.analytic").rows;
  const accrual = rows.filter((row) => row.path.startsWith("accrual."));
  assert.deepEqual(accrual.map((row) => row.path), ["accrual.duration", "accrual.followup", "accrual.dropoutAnnual"]);
  const [duration, followup, dropout] = accrual;
  assert.equal(duration.unit, "time units");
  assert.equal(duration.required, true);
  assert.equal(followup.unit, "time units");
  assert.equal(dropout.unit, "proportion per 12 time units");
  assert.equal(dropout.default, 0);
  assert.deepEqual([dropout.min, dropout.lt], [0, 1]);
  assert.deepEqual(rows.find((row) => row.path === "accrual")?.when, [{ path: "endpoint.type", in: ["time_to_event"] }], "accrual belongs to the time-to-event endpoint");
  // The simulated generators read a variant: uniform and piecewise accrual.
  const simulated = vcrScenarioRows("design.simulate").rows.filter((row) => row.path.startsWith("accrual."));
  assert.deepEqual(simulated.map((row) => row.path), ["accrual.kind", "accrual.duration", "accrual.followup", "accrual.dropoutAnnual", "accrual.maxFollowup",
    "accrual.breaks", "accrual.rates", "accrual.tail"]);
  assert.deepEqual(simulated.find((row) => row.path === "accrual.breaks")?.variant, { on: "accrual.kind", is: ["piecewise"], default: "uniform" });
  assert.equal(simulated.find((row) => row.path === "accrual.followup")?.variant, undefined, "shared by both variants, so it carries no variant");
  // No method reads a key by any of the names a guess would use.
  for (const [method, entry] of Object.entries(help.methods)) {
    for (const row of /** @type {any} */ (entry).rows) {
      const last = row.path.split(".").pop();
      assert.ok(!INVENTED.includes(last), `${method} lists ${row.path}`);
    }
  }
});

/** Every key name any depth of a method's schema carries, gates ignored: an independent walk of the data, not of the rows. @param {any} node @param {Set<string>} out */
function keysIn(node, out) {
  if (!node || typeof node !== "object") return;
  if (node.t === "object") for (const [key, field] of Object.entries(node.fields)) { out.add(key); keysIn(field, out) }
  if (node.t === "variant") {
    out.add(node.on);
    for (const fields of Object.values(node.variants)) for (const [key, field] of Object.entries(/** @type {any} */ (fields))) { out.add(key); keysIn(field, out) }
  }
  if (node.t === "array") keysIn(node.items, out);
}

/** The scenarios whose gates the examples alone do not exercise: a variant, a design, a weighting, an anchoring. */
const EXTRA_CONTEXTS = /** @type {Array<[string, any]>} */ ([
  ["design.simulate", { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlDistribution: { kind: "weibull", shape: 1.2, scale: 14 } },
    accrual: { kind: "piecewise", breaks: [3], rates: [1, 2], tail: 2, followup: 6 } }],
  ["design.simulate", { design: { kind: "group_sequential", nTreat: 100, informationRates: [0.5, 1] }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 } }],
  ["design.simulate", { design: { kind: "single_arm", n: 40 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, responseRate: 0.4 },
    analysis: { method: "exact_binomial", alternative: "greater", alpha: 0.05, sided: 1 } }],
  ["design.simulate", { design: { kind: "simon_two_stage", n1: 10, n: 30, r1: 2, r: 8 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, responseRate: 0.2, alternativeRate: 0.4 },
    analysis: { method: "simon_boundary", alpha: 0.05, sided: 1 } }],
  ["design.simulate", { design: { kind: "single_arm_external", n: 40 }, endpoint: { type: "binary" }, analysis: { method: "stratified_risk_difference", estimand: "ATT" },
    truth: { controlRates: [0.2, 0.3], treatmentRates: [0.4, 0.5] },
    external: { kind: "stratified_beta_binomial", n: 200, targetPrevalence: 0.5, sourcePrevalence: 0.4, parameterInformation: 20, logOddsDrift: 0, sensitivityDrifts: [0.1] } }],
  ["design.simulate", { design: { kind: "two_arm_fixed", nTreat: 50 }, endpoint: { type: "continuous" }, truth: { effect: 0.5 }, analysis: { method: "ancova" } }],
  ["design.analytic", { design: { kind: "group_sequential", informationRates: [0.5, 1] }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { duration: 12, followup: 12 } }],
  ["design.analytic", { design: { kind: "simon_two_stage", maxN: 60 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, alternativeRate: 0.4 } }],
  ["design.analytic", { design: { kind: "single_arm", n: 40 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, responseRate: 0.4 }, analysis: { method: "exact_binomial", alternative: "greater" } }],
  ["design.assurance", { design: { nTreat: 100 }, endpoint: { type: "binary" }, designPrior: { mean: 0.1, sd: 0.05 }, truth: { controlRate: 0.3 } }],
  ["patients.time_to_event", { design: { nTreat: 100 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { kind: "piecewise", breaks: [3], rates: [1, 2] } }],
  ["comparator.weighted_cox", { covariates: ["age"], tau: 24, weighting: "propensity", estimand: "ATE" }],
  ["comparator.weighted_cox", { covariates: ["age"], tau: 24, moments: 2 }],
  ["comparator.maic_time_to_event", { covariates: ["age"], targets: { age: 60 }, anchored: true, treatmentColumn: "arm", aggregateEstimate: -0.2, aggregateSe: 0.1 }],
  ["comparator.maic", { covariates: ["age"], targets: { age: 60 }, anchored: true, aggregateEstimate: -0.2, aggregateSe: 0.1 }],
  ["comparator.covariate_sets", { analysis: "propensity", estimand: "ATE", covariateSets: [{ name: "a", covariates: ["age"] }, { name: "b", covariates: ["sex"] }], endpoint: { type: "binary" } }],
  ["comparator.tipping_point", { endpoint: { type: "binary" }, design: { kind: "single_arm" }, outcomeColumn: "response", analysis: { method: "exact_binomial", nullRate: 0.3 } }],
  ["comparator.negative_control", { controls: [{ name: "a", estimate: 0.1, se: 0.2 }], primary: { name: "p", estimate: 0.2, se: 0.1 }, endpoint: { type: "time_to_event" } }],
  ["population.scenario", { population: { variables: [{ name: "bmi", family: "gamma", shape: 20, mean: 25 }, { name: "x", family: "uniform", min: 0, max: 1 }] } }],
  ["design.grid", { design: { kind: "single_arm", n: 40 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, responseRate: 0.4 }, designs: [{ n: 30 }], truths: [{ responseRate: 0.5 }] }],
]);

/** @param {any} scenario @returns {string[]} the dotted-and-indexed paths of every plain object in it, the scenario's own as `''` */
function objectPaths(scenario) {
  /** @type {string[]} */
  const out = [];
  /** @param {any} value @param {string} path */
  const walk = (value, path) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return }
    out.push(path);
    for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
  };
  walk(scenario, "");
  return out;
}

/** @param {any} root @param {string} path */
function nodeAt(root, path) {
  let node = root;
  for (const part of path.split(/\.|(?=\[)/).filter(Boolean)) node = part.startsWith("[") ? node[Number(part.slice(1, -1))] : node[part];
  return node;
}

/**
 * Probe the validator at every object of a scenario with every key the method knows, and say where the rows disagree with it.
 * @param {string} method @param {string} label @param {any} context @param {any[]} rows
 * @returns {{ probes: number, mismatches: string[] }}
 */
function disagreements(method, label, context, rows) {
  /** @type {Map<string, any>} */
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const names = new Set(INVENTED);
  keysIn(VCR_SCENARIO_SCHEMAS[/** @type {keyof typeof VCR_SCENARIO_SCHEMAS} */ (method)], names);
  let probes = 0;
  /** @type {string[]} */
  const mismatches = [];
  /** @type {string[]} */
  const opaque = [];
  for (const path of objectPaths(context)) {
    if (opaque.some((prefix) => path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`))) continue;
    const normal = path.replace(/\[\d+\]/g, "[]");
    let row = normal ? (byPath.get(normal) ?? byPath.get(normal.replace(/\[\]$/, ""))) : { type: "object" };
    // An item of a list of objects is a node of named keys; the row that describes it is the list's.
    if (row?.type === "list" && normal.endsWith("[]") && row.items?.type === "object") row = { type: "object" };
    // A map's keys are column names, a rule is a grammar of its own: neither is a node of named keys.
    if (!row || row.type !== "object") {
      if (!(row && ["map", "rule", "rules"].includes(row.type))) mismatches.push(`${method} ${label}: ${path} is not described by the help`);
      opaque.push(path);
      continue;
    }
    const node = nodeAt(context, path);
    // The keys the scenario already carries are probed as they stand; the others are added one at a time.
    for (const key of new Set([...names, ...Object.keys(node)])) {
      const probe = clone(context);
      if (!Object.hasOwn(node, key)) nodeAt(probe, path)[key] = 0;
      const field = `scenario.${path ? `${path}.` : ""}${key}`;
      const refused = validateScenario(method, probe).some((issue) => issue.code === "scenario_field_unknown" && issue.field === field);
      const listed = rows.some((candidate) => {
        if (vcrScenarioParentOf(candidate.path) !== normal || candidate.path.slice(normal ? normal.length + 1 : 0) !== key) return false;
        if (candidate.when && !whenHolds(candidate.when, context)) return false;
        if (candidate.variant) {
          const chosen = node[candidate.variant.on.split(".").pop() ?? ""] ?? candidate.variant.default;
          if (!candidate.variant.is.includes(chosen)) return false;
        }
        return true;
      });
      probes += 1;
      if (refused === listed) mismatches.push(`${method} (${label}) at ${path || "the scenario"}: ${key} is ${refused ? "refused" : "accepted"} by the validator and ${listed ? "listed" : "not listed"} by the help`);
    }
  }
  return { probes, mismatches };
}

test("the help lists exactly the keys the validator accepts and none it refuses, at every object of every example, under every gate", () => {
  /** @type {Array<[string, string, any]>} */
  const contexts = [];
  for (const [method, examples] of Object.entries(VCR_SCENARIO_EXAMPLES)) for (const example of examples) contexts.push([method, example.label, example.scenario]);
  for (const [method, scenario] of EXTRA_CONTEXTS) contexts.push([method, "extra", scenario]);
  let probes = 0;
  /** @type {string[]} */
  const mismatches = [];
  for (const [method, label, context] of contexts) {
    const found = disagreements(method, label, context, vcrScenarioRows(method).rows);
    probes += found.probes;
    mismatches.push(...found.mismatches);
  }
  assert.ok(probes > 5000, `only ${probes} probes ran`);
  assert.deepEqual(mismatches, []);
});

test("the probe can fail: a help that drops a key, keeps a refused one, or forgets a gate is caught", () => {
  const scenario = VCR_SCENARIO_EXAMPLES["design.analytic"][0].scenario;
  const rows = /** @type {any[]} */ (clone(vcrScenarioRows("design.analytic").rows));
  assert.deepEqual(disagreements("design.analytic", "control", scenario, rows).mismatches, []);
  // The key a run guessed, listed as if it were read.
  const guessed = [...rows, { path: "accrual.months", type: "number" }];
  assert.ok(disagreements("design.analytic", "guess", scenario, guessed).mismatches.some((line) => line.includes("accrual") && line.includes("months")));
  // A key the engine reads, left out.
  const dropped = rows.filter((row) => row.path !== "accrual.followup");
  assert.ok(disagreements("design.analytic", "dropped", scenario, dropped).mismatches.some((line) => line.includes("followup")));
  // A gate forgotten: the time-to-event key listed for a binary scenario.
  const binary = VCR_SCENARIO_EXAMPLES["design.analytic"][1].scenario;
  const ungated = rows.map((row) => (row.path === "accrual" ? { ...row, when: undefined } : row));
  assert.ok(disagreements("design.analytic", "ungated", binary, ungated).mismatches.length > 0);
});

test("the cross-field rules are the schema's, counted independently", () => {
  /** @param {any} node @returns {number} */
  const count = (node) => {
    if (!node || typeof node !== "object") return 0;
    let total = (node.exactlyOne?.length ?? 0) + (node.atLeastOne?.length ?? 0) + Object.keys(node.requires ?? {}).length;
    if (node.t === "object") for (const field of Object.values(node.fields)) total += count(field);
    if (node.t === "variant") for (const [name, fields] of Object.entries(node.variants)) {
      total += Object.keys(node.variantGroups?.[name] ?? {}).length ? (node.variantGroups[name].exactlyOne?.length ?? 0) : 0;
      for (const field of Object.values(/** @type {any} */ (fields))) total += count(field);
    }
    if (node.t === "array") total += count(node.items);
    return total;
  };
  let rules = 0;
  for (const method of VCR_ENGINE_METHOD_IDS) {
    const expected = count(VCR_SCENARIO_SCHEMAS[/** @type {keyof typeof VCR_SCENARIO_SCHEMAS} */ (method)]);
    assert.equal(vcrScenarioRows(method).rules.length, expected, method);
    rules += expected;
  }
  assert.ok(rules >= 15, `only ${rules} rules were counted`);
});

test("a design method's help says which designs run on which endpoints, from the validator's own table", () => {
  for (const method of Object.keys(VCR_DESIGN_SUPPORT)) {
    assert.deepEqual(help.methods[method].designs, clone(/** @type {any} */ (VCR_DESIGN_SUPPORT)[method]), method);
    assert.ok(help.methods[method].notes[0].includes("design_not_supported"), method);
  }
  assert.ok(help.methods["design.simulate"].notes.some((/** @type {string} */ note) => note.includes("time_to_event logrank|rmst")));
  assert.equal(help.methods["design.grid"].gridCells, 400);
});

test("the keys read inside a node answer a refusal, and a gate that does not hold leaves a key out", () => {
  assert.deepEqual(vcrScenarioChildKeys(["design.analytic"], "accrual").map((entry) => entry.key), ["duration", "followup", "dropoutAnnual"]);
  assert.deepEqual(vcrScenarioChildKeys(["design.analytic", "design.simulate"], "accrual").map((entry) => entry.key),
    ["duration", "followup", "dropoutAnnual", "kind", "maxFollowup", "breaks", "rates", "tail"]);
  assert.deepEqual(vcrScenarioChildKeys(["design.simulate"], "accrual").find((entry) => entry.key === "breaks")?.variant, ["piecewise"]);
  assert.deepEqual(vcrScenarioChildKeys(["design.analytic"], "accrual", { endpoint: { type: "binary" } }), [], "accrual is not read for a binary endpoint");
  assert.deepEqual(vcrScenarioChildKeys(["design.analytic"], "truth", { endpoint: { type: "binary" }, design: { kind: "two_arm_fixed" } }).map((entry) => entry.key),
    ["controlRate", "treatmentRate", "riskDifference", "oddsRatio"]);
  assert.deepEqual(vcrScenarioChildKeys(["comparator.weighted_cox"], "cohortRules[2]").map((entry) => entry.key), ["name", "rule", "unknownAs"], "a list index reads as the list's item");
  assert.deepEqual(vcrScenarioChildKeys(["design.analytic"], "nowhere"), []);
  assert.equal(vcrScenarioParentOf("cohortRules[2].rule"), "cohortRules[]");
  assert.equal(vcrScenarioParentOf("accrual.months"), "accrual");
  assert.equal(vcrScenarioParentOf("covarites"), "");
});

test("the kinds the platform builds name the keys a run states, and the gateway's refusal uses the same list", () => {
  assert.deepEqual(Object.keys(VCR_RUN_SCENARIO_FIELDS).sort(), ["accrual_forecast", "match_criteria", "pool_evidence"]);
  for (const [kind, fields] of Object.entries(VCR_RUN_SCENARIO_FIELDS)) {
    assert.deepEqual(help.kinds[kind].platformBuilt, [...fields], kind);
  }
  // What a run states of an accrual forecast is a subset of what the method reads.
  const read = new Set(vcrScenarioRows("accrual.poisson_gamma").rows.map((row) => row.path));
  for (const field of VCR_RUN_SCENARIO_FIELDS.accrual_forecast) assert.ok(read.has(field), field);
});
