/**
 * The engine protocol's contract (integration contract 2026-09-29 §3): one
 * scenario schema per method, the two stages of inputs, the results, the null
 * predicate, the replicate floor and the canonical bytes.
 *
 * The engine's R twin (`R/protocol.R`) runs the same fixture file
 * (`fixtures/vcr-engine-jobs.json`) in case N00; a verdict changed here without
 * the fixture changing is a verdict the engine has not been asked about.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  ALL_ERROR_CODES,
  VCR_DESIGN_SUPPORT,
  VCR_ENDPOINT_TYPES,
  VCR_ENGINE_METHODS,
  VCR_ENGINE_METHOD_IDS,
  VCR_ENGINE_PROTOCOL_VERSION,
  VCR_JOB_KINDS,
  VCR_JOB_METHODS,
  VCR_MAX_REPLICATES,
  VCR_MODEL_TIERS,
  VCR_OBSERVED_ONLY_METHODS,
  VCR_PATIENT_LEVEL_JOB_KINDS,
  VCR_PATTERNS,
  VCR_PROTOCOL_ISSUE_CODES,
  VCR_SCENARIO_SCHEMAS,
  VCR_TRIAL_DESIGNS,
  canonicalScenarioJson,
  replicateFloor,
  replicatesForMcse,
  validateCallerInputs,
  validateCounts,
  validateEngineJob,
  validateEngineResult,
  validateScenario,
  vcrIsNullScenario,
  vcrLocationIsValid,
  vcrReplicateFloorFor,
  vcrResultOutputPayload,
} from "@evimed/domain";

/** JSON-safe deep copy: the fixture is JSON, and a job is never anything else. @template T @param {T} value @returns {T} */
const clone = (value) => JSON.parse(JSON.stringify(value));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/vcr-engine-jobs.json", import.meta.url), "utf8"));
/** @param {readonly { code: string, field: string }[]} issues */
const keys = (issues) => issues.map((issue) => `${issue.code}@${issue.field}`).sort();
const validJob = () => clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "design.simulate").job);

// --- the fixture the engine also runs ---------------------------------------

test("every valid job of the fixture validates clean, and the walk proves it walked", () => {
  assert.ok(fixture.valid.length >= 30, `only ${fixture.valid.length} valid jobs`);
  const methods = new Set(fixture.valid.map((/** @type {any} */ item) => item.job.method));
  assert.deepEqual([...methods].sort(), [...VCR_ENGINE_METHOD_IDS].sort(), "every method has at least one valid job");
  for (const item of fixture.valid) assert.deepEqual(validateEngineJob(item.job), [], item.name);
});

test("every invalid job of the fixture is refused with each issue it says it names", () => {
  assert.ok(fixture.invalid.length >= 150, `only ${fixture.invalid.length} invalid jobs`);
  for (const item of fixture.invalid) {
    const got = keys(validateEngineJob(item.job));
    assert.ok(got.length > 0, `${item.name}: a job that should be refused validated`);
    for (const expected of item.expected) assert.ok(got.includes(expected), `${item.name}: expected ${expected}, got ${got.join(" | ")}`);
  }
  const codes = new Set(fixture.invalid.flatMap((/** @type {any} */ item) => item.expected.map((/** @type {string} */ e) => e.split("@")[0])));
  for (const code of ["scenario_field_unknown", "scenario_field_missing", "scenario_value_invalid", "endpoint_not_supported", "design_not_supported",
    "kind_method_mismatch", "input_location_invalid", "input_hash_missing", "input_source_not_individual", "rule_expression_forbidden", "patient_input_required"]) {
    assert.ok(codes.has(code), `the fixture never exercises ${code}`);
  }
});

test("every valid result of the fixture validates clean and every invalid one is refused as named", () => {
  assert.ok(fixture.validResults.length >= 6 && fixture.invalidResults.length >= 35);
  for (const item of fixture.validResults) assert.deepEqual(validateEngineResult(item.result), [], item.name);
  for (const item of fixture.invalidResults) {
    const got = keys(validateEngineResult(item.result));
    for (const expected of item.expected) assert.ok(got.includes(expected), `${item.name}: expected ${expected}, got ${got.join(" | ")}`);
  }
});

test("the engine's generated snapshot carries exactly the live schemas, patterns and tables", () => {
  const url = new URL("../../../../项目代码/vcr-engine/R/domain-snapshot.json", import.meta.url);
  if (!existsSync(url)) return;
  const snapshot = JSON.parse(readFileSync(url, "utf8"));
  const plain = (/** @type {any} */ value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(snapshot.scenarioSchemas, plain(VCR_SCENARIO_SCHEMAS), "regenerate it: node 项目代码/vcr-engine/tests/helpers/emit-domain-snapshot.mjs");
  assert.deepEqual(snapshot.designSupport, plain(VCR_DESIGN_SUPPORT));
  assert.deepEqual(snapshot.patterns, plain(VCR_PATTERNS));
  assert.deepEqual(snapshot.jobMethods, plain(VCR_JOB_METHODS));
  assert.deepEqual(snapshot.observedOnlyMethods, [...VCR_OBSERVED_ONLY_METHODS]);
  assert.equal(snapshot.maxReplicates, VCR_MAX_REPLICATES);
  for (const [id, spec] of Object.entries(VCR_ENGINE_METHODS)) assert.equal(snapshot.methods[id].modelTier, spec.modelTier, id);
});

// --- the tables -------------------------------------------------------------

test("every method has one scenario schema, every kind one method, and both tables are total", () => {
  assert.deepEqual(Object.keys(VCR_SCENARIO_SCHEMAS).sort(), [...VCR_ENGINE_METHOD_IDS].sort());
  assert.equal(VCR_ENGINE_METHOD_IDS.length, 24);
  assert.deepEqual(Object.keys(VCR_JOB_METHODS).sort(), [...VCR_JOB_KINDS].sort());
  assert.equal(new Set(Object.values(VCR_JOB_METHODS)).size, VCR_JOB_KINDS.length, "no two kinds run one method");
  for (const kind of VCR_PATIENT_LEVEL_JOB_KINDS) assert.ok(VCR_JOB_KINDS.includes(kind), kind);
  for (const method of VCR_OBSERVED_ONLY_METHODS) assert.ok(VCR_ENGINE_METHOD_IDS.includes(method), method);
  for (const spec of Object.values(VCR_ENGINE_METHODS)) assert.ok(spec.modelTier === null || VCR_MODEL_TIERS.includes(spec.modelTier));
});

test("a schema is data both languages can read: JSON-safe, frozen, and every node has a known type", () => {
  const types = new Set(["number", "integer", "boolean", "string", "array", "object", "variant", "map", "matrix", "rules", "rule"]);
  let nodes = 0;
  /** @param {any} node @param {string} where */
  const walk = (node, where) => {
    if (node === null || typeof node !== "object") return;
    assert.ok(Object.isFrozen(node), `${where} is not frozen`);
    if (typeof node.t === "string") {
      nodes += 1;
      assert.ok(types.has(node.t), `${where}: unknown node type ${node.t}`);
    }
    for (const [key, child] of Object.entries(node)) {
      assert.notEqual(child, undefined, `${where}.${key} is undefined, which JSON drops`);
      assert.notEqual(typeof child, "function", `${where}.${key} is a function`);
      walk(child, `${where}.${key}`);
    }
  };
  for (const [method, schema] of Object.entries(VCR_SCENARIO_SCHEMAS)) walk(schema, method);
  assert.ok(nodes > 400, `only ${nodes} schema nodes were walked`);
  assert.deepEqual(JSON.parse(JSON.stringify(VCR_SCENARIO_SCHEMAS)), JSON.parse(JSON.stringify(VCR_SCENARIO_SCHEMAS)));
});

test("the design table names real designs, endpoints and methods, and nothing the engine cannot run", () => {
  for (const [method, table] of Object.entries(VCR_DESIGN_SUPPORT)) {
    assert.ok(VCR_ENGINE_METHOD_IDS.includes(method), method);
    for (const [design, endpoints] of Object.entries(table)) {
      assert.ok(VCR_TRIAL_DESIGNS.includes(design), `${method}: ${design}`);
      for (const endpoint of endpoints) assert.ok(VCR_ENDPOINT_TYPES.includes(endpoint), `${method}: ${endpoint}`);
    }
  }
  // These designs have distinct binary implementations, never two-arm fallbacks.
  for (const design of ["single_arm", "single_arm_external", "simon_two_stage"]) {
    assert.deepEqual(VCR_DESIGN_SUPPORT["design.simulate"][/** @type {'single_arm' | 'single_arm_external' | 'simon_two_stage'} */ (design)], ["binary"], design);
  }
  assert.deepEqual(VCR_DESIGN_SUPPORT["design.simulate"].group_sequential, ["time_to_event"]);
});

// --- the scenario schema, directly -------------------------------------------

test("an unknown key is refused by its path, wherever it hides", () => {
  const job = validJob();
  job.scenario.accrual.dropoutRate = 0.1;
  job.scenario.truth.extra = { deeper: 1 };
  job.scenario.notes = "x";
  assert.deepEqual(keys(validateEngineJob(job)), [
    "scenario_field_unknown@scenario.accrual.dropoutRate",
    "scenario_field_unknown@scenario.notes",
    "scenario_field_unknown@scenario.truth.extra",
  ]);
});

test("the ranges are the ones the engine's arithmetic needs", () => {
  const job = validJob();
  const check = (/** @type {(scenario: any) => void} */ change) => { const j = clone(job); change(j.scenario); return keys(validateEngineJob(j)); };
  assert.deepEqual(check((s) => { s.truth.hazardRatio = 0; }), ["scenario_value_invalid@scenario.truth.hazardRatio"]);
  assert.deepEqual(check((s) => { s.analysis = { alpha: 1 }; }), ["scenario_value_invalid@scenario.analysis.alpha"]);
  assert.deepEqual(check((s) => { s.analysis = { alpha: 0.05, sided: 2 }; }), []);
  assert.deepEqual(check((s) => { s.analysis = { sided: 3 }; }), ["scenario_value_invalid@scenario.analysis.sided"]);
  assert.deepEqual(check((s) => { s.accrual = { dropoutAnnual: 1 }; }), ["scenario_value_invalid@scenario.accrual.dropoutAnnual"]);
  assert.deepEqual(check((s) => { s.design.nTreat = 0; }), ["scenario_value_invalid@scenario.design.nTreat"]);
  assert.deepEqual(check((s) => { s.design.nTreat = 1.5; }), ["scenario_value_invalid@scenario.design.nTreat"]);
  // allocation strictly inside (0, 1), power inside (0, 1), sd above zero.
  const analytic = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "design.analytic").job);
  analytic.scenario.design.allocation = 1;
  analytic.scenario.analysis.power = 1;
  assert.deepEqual(keys(validateEngineJob(analytic)), ["scenario_value_invalid@scenario.analysis.power", "scenario_value_invalid@scenario.design.allocation"]);
  const continuous = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "design.simulate" && item.job.scenario.endpoint.type === "continuous").job);
  continuous.scenario.truth.sd = 0;
  assert.deepEqual(keys(validateEngineJob(continuous)), ["scenario_value_invalid@scenario.truth.sd"]);
});

test("null is a value in canonical JSON, so it is refused rather than read as absent", () => {
  const job = validJob();
  job.scenario.accrual.followup = null;
  assert.deepEqual(keys(validateEngineJob(job)), ["scenario_value_invalid@scenario.accrual.followup"]);
  // The one place a schema says a null bound is the same as no bound.
  const literature = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "population.literature").job);
  assert.equal(literature.scenario.baselineTable[0].max, null);
  assert.deepEqual(validateEngineJob(literature), []);
});

test("thresholds are presets, not scenario keys: a scenario cannot loosen the rule that stops a comparison", () => {
  const weighting = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "comparator.entropy_balance").job);
  for (const key of ["essFloor", "supportCeiling", "smdFloor", "bootstrapReplicates", "conflictBound", "tolerance"]) {
    const job = clone(weighting);
    job.scenario[key] = 1;
    assert.deepEqual(keys(validateEngineJob(job)), [`scenario_field_unknown@scenario.${key}`], key);
  }
});

test("a design × endpoint the engine does not implement is refused for what it is, per grid cell too", () => {
  const job = validJob();
  job.scenario.design.kind = "single_arm";
  assert.ok(keys(validateEngineJob(job)).includes("design_not_supported@scenario.design.kind"));
  const grid = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "design.grid").job);
  grid.scenario.designs[0] = { kind: "simon_two_stage" };
  assert.ok(keys(validateEngineJob(grid)).includes("scenario_value_invalid@designs[0]"));
});

test("a grid's cells are scenarios of their own, and the grid has a size", () => {
  const grid = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "design.grid").job);
  grid.scenario.truths[1] = { riskDifference: 0.2 };
  assert.deepEqual(keys(validateEngineJob(grid)), ["scenario_value_invalid@truths[1]"], "treatmentRate and riskDifference together contradict");
  grid.scenario.truths = Array.from({ length: 21 }, () => ({ treatmentRate: 0.4 }));
  grid.scenario.designs = Array.from({ length: 21 }, () => ({ nTreat: 50 }));
  assert.ok(keys(validateEngineJob(grid)).includes("scenario_value_invalid@designs"));
});

test("a precision that needs more replicates than the cap is refused at the door", () => {
  const job = validJob();
  job.scenario.targetMcse = 0.0005;
  assert.deepEqual(keys(validateEngineJob(job)), ["scenario_value_invalid@scenario.targetMcse"]);
  // Under the null the precision is asked of alpha, which needs far fewer.
  job.scenario.truth = { hazardRatio: 1, controlMedian: 12 };
  assert.deepEqual(validateEngineJob(job), [], "0.0005 at alpha 0.025 is 97,500 replicates");
  job.replicates = VCR_MAX_REPLICATES + 1;
  assert.deepEqual(keys(validateEngineJob(job)), ["replicates_invalid@replicates"]);
});

test("validateScenario answers alone, with a path and the inputs the job carries", () => {
  assert.deepEqual(validateScenario("design.guess", {}).map((issue) => issue.code), ["method_unknown"]);
  assert.deepEqual(validateScenario("profile.snapshot", []).map((issue) => issue.code), ["scenario_value_invalid"]);
  assert.deepEqual(validateScenario("profile.snapshot", null).map((issue) => issue.code), ["scenario_missing"]);
  assert.deepEqual(validateScenario("profile.snapshot", { a: 1 }, { path: "s" }).map((issue) => issue.field), ["s.a"]);
  const quality = { trainingInputId: "a@1", syntheticInputId: "b@1" };
  assert.deepEqual(validateScenario("population.quality", quality, { inputIds: ["a@1", "b@1"] }), []);
  assert.deepEqual(keys(validateScenario("population.quality", quality, { inputIds: ["a@1"] })), ["scenario_value_invalid@scenario.syntheticInputId"]);
});

// --- the job's own fields, kinds and methods ----------------------------------

test("a kind runs its own method, and only a method that exists", () => {
  const job = validJob();
  assert.deepEqual(keys(validateEngineJob({ ...job, method: "comparator.maic" })).filter((k) => k.startsWith("kind_")), ["kind_method_mismatch@method"]);
  assert.ok(keys(validateEngineJob({ ...job, method: "design.guess" })).includes("method_unknown@method"));
  assert.ok(!keys(validateEngineJob({ ...job, method: "design.guess" })).some((k) => k.startsWith("kind_method")), "one refusal, not two");
});

test("a job carries the version its numbers are validated at, and only fields the protocol has", () => {
  const job = validJob();
  delete job.methodVersion;
  assert.deepEqual(keys(validateEngineJob(job)), ["method_version_missing@methodVersion"]);
  assert.deepEqual(keys(validateEngineJob({ ...validJob(), dropoutOverride: 0.5 })), ["job_field_unknown@dropoutOverride"]);
  assert.deepEqual(keys(validateEngineJob({ ...validJob(), scenario: [] })), ["scenario_value_invalid@scenario"]);
  assert.deepEqual(keys(validateEngineJob({ ...validJob(), jobId: ["job_1"] })), ["job_id_invalid@jobId"]);
});

// --- inputs: a caller names, the control plane resolves ------------------------

test("a caller names patient-level data only as a snapshot id, and never says where the file is", () => {
  assert.deepEqual(validateCallerInputs([{ kind: "snapshot", id: "snp_1" }, { kind: "assumption", id: "asm_dropout@2", hash: null, value: { key: "dropout" } }]), []);
  assert.deepEqual(validateCallerInputs(undefined), []);
  const forbidden = (/** @type {any} */ input) => validateCallerInputs([input]).map((issue) => `${issue.code}@${issue.field}`);
  assert.deepEqual(forbidden({ kind: "snapshot", id: "snp_1", location: "../../etc/passwd" }), ["input_location_forbidden@inputs[0].location"]);
  assert.deepEqual(forbidden({ kind: "snapshot", id: "snp_1", hash: "a".repeat(64) }), ["input_location_forbidden@inputs[0].hash"]);
  assert.deepEqual(forbidden({ kind: "snapshot", id: "snp_1", shape: "subject" }), ["input_location_forbidden@inputs[0].shape"]);
  assert.deepEqual(forbidden({ kind: "snapshot", id: "snp_1", valueSource: "observed" }), ["input_location_forbidden@inputs[0].valueSource"]);
  assert.deepEqual(forbidden({ kind: "analysis_table", id: "snp_1:subject" }), ["input_location_forbidden@inputs[0].kind"]);
  assert.deepEqual(forbidden({ kind: "snapshot", id: "snp_1", note: "x" }), ["input_field_unknown@inputs[0].note"]);
  assert.deepEqual(forbidden({ kind: "assumption", id: "asm_dropout" }), ["input_version_missing@inputs[0].id"]);
  assert.deepEqual(forbidden({ kind: "spreadsheet", id: "x" }), ["input_kind_unknown@inputs[0].kind"]);
  assert.deepEqual(validateCallerInputs({}).map((issue) => issue.code), ["inputs_missing"]);
});

test("a patient-level kind must name the snapshot it is granted, at the caller's stage", () => {
  assert.deepEqual(validateCallerInputs([{ kind: "assumption", id: "asm_1@1" }], { kind: "weight_comparator" }).map((issue) => issue.code), ["snapshot_required"]);
  assert.deepEqual(validateCallerInputs(undefined, { kind: "rmst" }).map((issue) => issue.code), ["snapshot_required"]);
  assert.deepEqual(validateCallerInputs([{ kind: "snapshot", id: "snp_1" }], { kind: "weight_comparator" }), []);
  assert.deepEqual(validateCallerInputs([], { kind: "design_simulation" }), [], "a computation with no patients needs no snapshot");
  assert.deepEqual(validateCallerInputs([], { kind: "not_a_kind" }), []);
});

test("the engine reads only a location relative to the data plane, with the hash of exactly that file", () => {
  for (const location of ["std_1/snp_1/subject.csv", "a", "a/b/c/d", "std_1/snp_1/x.parquet", "a_b.c@d:e+f=g,h-i"]) assert.equal(vcrLocationIsValid(location), true, location);
  for (const location of ["", "/a", "../x", "a/../b", "a/./b", "a//b", "a/b/", ".hidden", "a/.hidden", "a\\b", "a b", "a\nb", "x".repeat(513), Array.from({ length: 9 }, () => "a").join("/"), 5, null]) {
    assert.equal(vcrLocationIsValid(location), false, JSON.stringify(location));
  }
  const table = (/** @type {any} */ over) => ({ kind: "analysis_table", id: "snp_1:subject", shape: "subject", location: "std_1/snp_1/s.csv", hash: "a".repeat(64), valueSource: "observed", ...over });
  const weighting = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "comparator.entropy_balance").job);
  const withInput = (/** @type {any} */ over) => keys(validateEngineJob({ ...weighting, inputs: [table(over)] }));
  assert.deepEqual(withInput({}), []);
  assert.deepEqual(withInput({ hash: undefined }), ["input_hash_missing@inputs[0].hash"]);
  assert.deepEqual(withInput({ valueSource: undefined }), ["input_value_source_missing@inputs[0].valueSource"]);
  assert.deepEqual(withInput({ location: "../x" }), ["input_location_invalid@inputs[0].location"]);
  assert.deepEqual(withInput({ shape: "wide" }), ["input_shape_invalid@inputs[0].shape"]);
});

test("a method that weighs real patients refuses a row that is not one", () => {
  const weighting = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "comparator.entropy_balance").job);
  for (const source of ["synthetic", "aggregate", "predicted", "reconstructed", "assumed"]) {
    weighting.inputs[0].valueSource = source;
    assert.deepEqual(keys(validateEngineJob(weighting)), ["input_source_not_individual@inputs[0].valueSource"], source);
  }
  // A real person's row stays one when a value in it was extracted from text,
  // calculated from other fields or imputed (contract §3.2, amended).
  for (const source of ["observed", "extracted", "calculated", "imputed"]) {
    weighting.inputs[0].valueSource = source;
    assert.deepEqual(keys(validateEngineJob(weighting)), [], source);
  }
  // The same rows are fine for a method that is not a comparison of patients.
  const profile = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "profile.snapshot").job);
  profile.inputs[0].valueSource = "synthetic";
  assert.deepEqual(validateEngineJob(profile), []);
});

// --- results -----------------------------------------------------------------

test("a result echoes its job, states its conclusion, and every number says where it came from", () => {
  const result = () => clone(fixture.validResults[0].result);
  const bad = (/** @type {(r: any) => void} */ change) => { const r = result(); change(r); return keys(validateEngineResult(r)); };
  assert.deepEqual(validateEngineResult(result()), []);
  assert.deepEqual(bad((r) => { delete r.measures[0].source; }), ["measure_source_missing@measures[0].source"]);
  assert.deepEqual(bad((r) => { r.measures[0].source = "guess"; }), ["measure_source_invalid@measures[0].source"]);
  assert.deepEqual(bad((r) => { r.conclusion = "sound"; }), ["conclusion_unknown@conclusion"]);
  assert.deepEqual(bad((r) => { r.measures[0].interval.low = 2; }), ["interval_invalid@measures[0].interval"]);
  assert.deepEqual(bad((r) => { r.manifest.cpuSeconds = -1; }), ["cpu_seconds_invalid@manifest.cpuSeconds"]);
  assert.deepEqual(bad((r) => { r.manifest.outputHash = "0".repeat(64); }), ["output_hash_invalid@manifest.outputHash"]);
  assert.deepEqual(bad((r) => { r.models = [{ tier: "Scenario", risk: "HIGH" }]; }), ["model_risk_invalid@models[0].risk", "model_tier_invalid@models[0].tier"]);
  for (const echo of ["method", "methodVersion", "scenarioHash", "seed", "replicates"]) {
    assert.ok(bad((r) => { delete r[echo]; }).length > 0, `a result without ${echo} validated`);
  }
});

test("the weighted effective sample size never exceeds the real patients, generated records or not", () => {
  assert.deepEqual(validateCounts({ realPatients: 120, events: 80, effectiveSampleSize: 96, generatedRecords: 0 }), []);
  assert.deepEqual(keys(validateCounts({ realPatients: 50, events: 10, effectiveSampleSize: 80, generatedRecords: 0 })), ["ess_above_real@effectiveSampleSize"]);
  assert.deepEqual(keys(validateCounts({ realPatients: 50, effectiveSampleSize: 80 })), ["ess_above_real@effectiveSampleSize"]);
  assert.deepEqual(keys(validateCounts({ realPatients: 0, effectiveSampleSize: 80, generatedRecords: 100 })), ["ess_above_real@effectiveSampleSize"]);
  assert.deepEqual(validateCounts({ realPatients: null, effectiveSampleSize: 80 }), [], "an unknown real count bounds nothing");
  assert.deepEqual(keys(validateCounts({ realPatients: "", events: true, effectiveSampleSize: [], generatedRecords: 12.5 })).filter((k) => k.startsWith("count_invalid")),
    ["count_invalid@effectiveSampleSize", "count_invalid@events", "count_invalid@realPatients"]);
});

// --- canonical bytes and the output hash --------------------------------------

test("canonical bytes: null kept, undefined dropped, {} apart from [], one-element arrays kept, JS key order", () => {
  assert.equal(canonicalScenarioJson({ a: null, b: undefined, c: 1 }), '{"a":null,"c":1}');
  assert.equal(canonicalScenarioJson({ a: {}, b: [] }), '{"a":{},"b":[]}');
  assert.equal(canonicalScenarioJson({ byTimes: [10], cov: ["age"] }), '{"byTimes":[10],"cov":["age"]}');
  // An integer-like key is written before every other key, in numeric order: what JSON.stringify does
  // to the object built from the sorted keys, and what R's writer reproduces.
  assert.equal(canonicalScenarioJson({ b: 1, 10: 2, a: 3, 9: 4 }), '{"9":4,"10":2,"a":3,"b":1}');
  assert.equal(canonicalScenarioJson(JSON.parse('{"__proto__":1,"a":2}')), '{"__proto__":1,"a":2}', "a __proto__ key is data, and stays");
  assert.equal(canonicalScenarioJson({ n: [1e-7, 1e21, 0.1 + 0.2, -0] }), '{"n":[1e-7,1e+21,0.30000000000000004,0]}');
  assert.equal(canonicalScenarioJson({ followup: Number.POSITIVE_INFINITY }), '{"followup":null}');
});

test("the output payload is measures, counts, conclusion, rule and table hashes — nothing of the bookkeeping", () => {
  const result = clone(fixture.validResults[0].result);
  const payload = JSON.parse(vcrResultOutputPayload(result));
  assert.deepEqual(Object.keys(payload).sort(), ["conclusion", "counts", "measures", "notEstimableRule", "tables"]);
  assert.deepEqual(payload.tables, [{ name: "replicates", sha256: result.tables[0].sha256 }], "a table is its name and hash, not its location or rows");
  const noise = clone(result);
  noise.manifest.startedAt = "later";
  noise.tables[0].location = "elsewhere.csv";
  noise.diagnostics = { anything: 1 };
  assert.equal(vcrResultOutputPayload(noise), vcrResultOutputPayload(result));
  assert.equal(JSON.parse(vcrResultOutputPayload({})).conclusion, null, "an absent conclusion is null, not dropped");
  const changed = clone(result);
  changed.measures[0].value += 1e-12;
  assert.notEqual(vcrResultOutputPayload(changed), vcrResultOutputPayload(result));
});

// --- replicates and the null scenario ------------------------------------------

test("the replicate floor under the null asks its precision of alpha, not of 0.5 (D-8)", () => {
  assert.equal(replicatesForMcse({ measure: "proportion", target: 0.001, p: 0.025 }), 24_375);
  assert.equal(replicateFloor({ isNull: true }), 20_000);
  assert.equal(replicateFloor({ isNull: true, targetMcse: 0.001, alpha: 0.025 }), 24_375, "the plan's number");
  assert.equal(replicateFloor({ isNull: true, targetMcse: 0.001 }), 24_375, "alpha defaults to 0.025");
  assert.equal(replicateFloor({ isNull: true, targetMcse: 0.001, alpha: 0.05 }), 47_500);
  assert.equal(replicateFloor({ isNull: false, targetMcse: 0.001 }), 250_000, "an alternative is measured at its worst case");
  assert.equal(replicateFloor({ isNull: true, targetMcse: 0.001, p: 0.5 }), 250_000, "an explicit p still wins");
  assert.equal(replicateFloor({ isNull: true, targetMcse: 0.0011, alpha: 0.025 }), 20_145);
});

test("one null predicate: the flag wins, otherwise the effect decides, and an effect nobody stated is not null", () => {
  const ep = (/** @type {string} */ type) => ({ type });
  assert.equal(vcrIsNullScenario({ endpoint: ep("continuous"), truth: { effect: 0 } }), true);
  assert.equal(vcrIsNullScenario({ endpoint: ep("continuous"), truth: { effect: 0.2 } }), false);
  assert.equal(vcrIsNullScenario({ endpoint: ep("time_to_event"), truth: { hazardRatio: 1 } }), true);
  assert.equal(vcrIsNullScenario({ endpoint: ep("time_to_event"), truth: { hazardRatio: 0.7 } }), false);
  assert.equal(vcrIsNullScenario({ endpoint: ep("binary"), truth: { controlRate: 0.3, treatmentRate: 0.3 } }), true);
  assert.equal(vcrIsNullScenario({ endpoint: ep("binary"), truth: { controlRate: 0.3, riskDifference: 0 } }), true);
  assert.equal(vcrIsNullScenario({ endpoint: ep("binary"), truth: { controlRate: 0.3, oddsRatio: 1 } }), true);
  assert.equal(vcrIsNullScenario({ endpoint: ep("binary"), truth: { controlRate: 0.3, oddsRatio: 2 } }), false);
  assert.equal(vcrIsNullScenario({ endpoint: ep("continuous"), truth: { effect: 0.5, null: true } }), true, "an explicit flag wins");
  assert.equal(vcrIsNullScenario({ endpoint: ep("continuous"), truth: { effect: 0, null: false } }), false);
  assert.equal(vcrIsNullScenario({ endpoint: ep("continuous"), truth: {} }), false);
  assert.equal(vcrIsNullScenario({ endpoint: ep("continuous"), truth: { effect: 1e-9 } }), false, "the tolerance is 1e-12");
  assert.equal(vcrIsNullScenario({ endpoint: ep("binary"), truth: { controlRate: 0.3, treatmentRate: 0.3 + 1e-9 } }), false, "an absolute tolerance, not all.equal's 1.5e-8");
  assert.equal(vcrIsNullScenario({ endpoint: ep("binary"), truth: { controlRate: 0.3, treatmentRate: 0.3 + 1e-13 } }), true);
  assert.equal(vcrIsNullScenario({ endpoint: ep("time_to_event"), truth: { hazardRatio: 1 - 5e-13 } }), true);
  assert.equal(vcrIsNullScenario({}), false);
  assert.equal(vcrIsNullScenario(null), false);
  // The floor of a whole scenario reads its null predicate and alpha from itself.
  const scenario = { endpoint: ep("time_to_event"), truth: { hazardRatio: 1 }, analysis: { alpha: 0.05 }, targetMcse: 0.001 };
  assert.equal(vcrReplicateFloorFor(scenario), 47_500);
  assert.equal(vcrReplicateFloorFor({ ...scenario, truth: { hazardRatio: 0.7 } }), 250_000);
  assert.equal(vcrReplicateFloorFor({ endpoint: ep("time_to_event"), truth: { hazardRatio: 0.7 } }), 5_000);
});

// --- the codes the validators can emit are registered ---------------------------

test("every issue code the protocol validators can emit is a registered code with a sentence", () => {
  const dir = new URL("../src/", import.meta.url);
  const sources = ["vcrEngineJob.mjs", "vcrRules.mjs", "vcrScenarioSchemas.mjs"];
  /** @type {Set<string>} */
  const found = new Set();
  for (const name of sources) {
    const text = readFileSync(new URL(name, dir), "utf8");
    for (const match of text.matchAll(/(?:bad|raise|push)\((?:state, |ctx, )?'([a-z_]+)'/g)) found.add(match[1]);
    for (const match of text.matchAll(/code: '([a-z_]+)'/g)) found.add(match[1]);
    for (const match of text.matchAll(/badValueCode: '([a-z_]+)'/g)) found.add(match[1]);
    for (const match of text.matchAll(/\? '(rule_[a-z_]+|scenario_[a-z_]+)' :/g)) found.add(match[1]);
  }
  for (const code of ["cores_invalid", "batch_size_invalid"]) found.add(code);
  assert.ok(found.size >= 60, `only ${found.size} codes were found; the scan did not run`);
  assert.ok(readdirSync(dir).includes("vcrEngineJob.mjs"));
  const unregistered = [...found].filter((code) => !ALL_ERROR_CODES.includes(code)).sort();
  assert.deepEqual(unregistered, [], `emitted but not registered: ${unregistered.join(", ")}`);
  const unlisted = [...found].filter((code) => !VCR_PROTOCOL_ISSUE_CODES.includes(code) && !["method_unknown"].includes(code)).sort();
  assert.deepEqual(unlisted, [], `registered elsewhere but not in VCR_PROTOCOL_ISSUE_CODES: ${unlisted.join(", ")}`);
  assert.equal(VCR_ENGINE_PROTOCOL_VERSION, 1);
});

test("no input carries a key its kind does not allow — a prefix of a reserved key is refused, not read as it", () => {
  // R's `$` matches a list key by its prefix: an `assumption` input carrying
  // `locationX`, `hashX` and `valueSourceX` was read by the engine as a table
  // (merge verification, 2026-09-29). Both validators refuse any key outside
  // the allow-list, by name.
  const smuggled = { kind: "assumption", id: "asm_1@1", locationX: "studies/std_1/sources/src_1/f.csv", hashX: "a".repeat(64), valueSourceX: "observed" };
  assert.deepEqual(keys(validateCallerInputs([smuggled])).sort(),
    ["input_field_unknown@inputs[0].hashX", "input_field_unknown@inputs[0].locationX", "input_field_unknown@inputs[0].valueSourceX"]);
  const job = clone(fixture.valid.find((/** @type {any} */ item) => item.job.method === "profile.snapshot").job);
  job.inputs.push(smuggled);
  assert.deepEqual(keys(validateEngineJob(job)).filter((key) => key.startsWith("input_field_unknown")).sort(),
    ["input_field_unknown@inputs[1].hashX", "input_field_unknown@inputs[1].locationX", "input_field_unknown@inputs[1].valueSourceX"]);
  // A snapshot a caller names is { kind, id } and nothing else, not even a value.
  assert.deepEqual(keys(validateCallerInputs([{ kind: "snapshot", id: "snp_1", value: 1 }])), ["input_field_unknown@inputs[0].value"]);
  // A lineage input may carry its frozen value; a table input its location, hash, shape and source.
  assert.deepEqual(validateCallerInputs([{ kind: "assumption", id: "dropout_rate@2", value: { pointValue: 0.1 } }]), []);
});
