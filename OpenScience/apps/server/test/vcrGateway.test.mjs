// The runtime's channel into a 虚拟临研 study: the token decides the account
// and the study, the fields are closed, a write refuses item by item and never
// fails the batch, and a number is not writable at all.
//
// The last one is the whole of principle 1 at this seam: a model that could
// write a count or a measure could write a result nobody computed.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  VCR_GATEWAY_OPERATIONS, VCR_GATEWAY_PATH, VCR_GATEWAY_WINDOW_LIMITS, createVcrGatewayHandler, vcrGatewayProviderUrl,
  vcrGatewayRoutePattern, vcrRuntimeWrite,
} from "../src/vcrGateway.mjs";
import { VCR_READ_WHATS, VCR_WRITE_WHATS, VcrService } from "../src/vcrService.mjs";
import { vcrReportModel } from "../src/vcrRender.mjs";

/** The one saved result the fixture's study has. */
async function vcrStoreResults() {
  return [{ kind: "trial_scenario", id: "res_1", conclusion: "estimable",
    counts: { realPatients: null, events: 138, effectiveSampleSize: null, generatedRecords: 2000 },
    measures: [{ name: "power", value: 0.71, simulated: true, mcse: 0.003 }], diagnostics: {}, version: 1 }];
}

/** @param {string} url @param {unknown} body @param {Record<string, string>} [headers] */
function request(url, body, headers = { authorization: "Bearer token" }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method: "POST", url, headers });
}

function response() {
  return {
    status: 0, body: "",
    writeHead(/** @type {number} */ status) { this.status = status; return this; },
    end(/** @type {string} */ chunk = "") { this.body = String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}

const study = { id: "std_1", userId: "u1", projectId: "prj_1", name: "EV-201", dataTier: "T0",
  intendedUse: "exploratory", status: "active", steps: {}, budget: {}, outcomeSeal: {} };
const config = { vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:8788/internal/models/v1" };
const runtimeManager = { assertActiveModelGatewayToken: (/** @type {string} */ token) => {
  if (token !== "token") throw new Error("bad token");
  return { userId: "u1", projectId: "prj_1" };
} };

/** @param {Record<string, any>} [overrides] */
function fixture(overrides = {}) {
  /** @type {any[]} */
  const calls = [];
  // What a run reads of a result passes the real service's boundary; a double that answered raw would hide the seam.
  const boundary = new VcrService({ store: /** @type {any} */ ({}), config: {} });
  const service = {
    allows: () => true,
    counters: { reads: 0, writes: 0, writeIssues: 0 },
    forModel: (/** @type {unknown} */ payload) => boundary.forModel(payload),
    async runtimeRead(target, what, filter) { calls.push(["read", what, filter]); return { what, studyId: target.id, items: [] }; },
    async reportModel(target) { return vcrReportModel({ study: target, results: await vcrStoreResults() }); },
    async adoptModel(_user, input) { calls.push(["adopt", input.name]); return { id: "mdl_1" }; },
  };
  const store = {
    async studyByControlProject(userId, projectId) {
      return userId === "u1" && projectId === "prj_1" ? study : null;
    },
    async saveDefinition(input) { calls.push(["definition", input.reviewState]); return { id: "def_1", version: 1 }; },
    async saveAssumption(input) { calls.push(["assumption", input.key, input.reviewState]); return { id: "asm_1", version: 2 }; },
    async saveTrialScenario(input) { calls.push(["scenario", input.design]); return { id: "scn_1", version: 1 }; },
    async saveComparatorDesign(input) { calls.push(["comparator", input.route, input.conclusion]); return { id: "cmp_1", version: 1 }; },
    async savePopulation(input) { calls.push(["population", input.kind]); return { id: "pop_1", version: 1 }; },
    async savePatientSet() { return { id: "pts_1", version: 1 }; },
    async saveDesignGrid() { return { id: "grd_1", version: 1 }; },
    async saveProtocolVersion(input) { calls.push(["protocol", input.criteria.length]); return { id: "prt_1", version: 2, criteria: input.criteria }; },
    async addDecision() { return { id: "dec_1" }; },
    async registerForecast(input) { calls.push(["forecast", input.kind]); return { id: "fct_1", version: 1 }; },
    async setStep(studyId, step, fields) { calls.push(["step", step, JSON.stringify(fields)]); return study; },
    async latestProtocolVersion() { return { id: "prt_1", version: 1, title: "EV-201", usdm: {} }; },
    async latestDefinition() { return { id: "def_1", version: 1, pico: {}, estimand: {}, endpointType: "time_to_event" }; },
    async assumptions() { return []; },
    async results() { return [{ kind: "trial_scenario", id: "res_1", conclusion: "estimable",
      counts: { realPatients: null, events: 138, effectiveSampleSize: null, generatedRecords: 2000 },
      measures: [{ name: "power", value: 0.71, simulated: true, mcse: 0.003 }], diagnostics: {}, version: 1 }]; },
    async reviews() { return []; },
    async staleMarks() { return []; },
    async latestPopulation() { return null; },
    async latestComparatorDesign() { return null; },
    async trialScenarios() { return []; },
    async models() { return []; },
    async exports() { return []; },
    async createExport(input) { calls.push(["export", input.kind]); return { id: "exp_1", kind: input.kind, state: "queued", cover: {} }; },
    async updateExport(id, patch) { calls.push(["updateExport", id, Object.keys(patch).join(","), patch]); return { id, ...patch }; },
  };
  const jobs = {
    async enqueue(input) { calls.push(["enqueue", input.kind, input.idempotencyKey]); return { job: { id: "job_1", state: "queued", progress: {} }, created: true }; },
    async get(_studyId, id) { return id === "job_1" ? { id: "job_1", state: "running", progress: { done: 3, total: 10 }, cpuSecondsUsed: 4, error: null } : null; },
    async cancel() { return { job: { id: "job_1", state: "canceled" }, canceled: true }; },
  };
  const vcr = { service, store, jobs, orchestrator: null, ...overrides };
  return { calls, vcr, handler: createVcrGatewayHandler(config, runtimeManager, { vcr }) };
}

test("the gateway's address is derived from the model gateway's, and is empty when the module is off", () => {
  assert.equal(vcrGatewayProviderUrl(config), "http://127.0.0.1:8788/internal/vcr/v1");
  assert.equal(vcrGatewayProviderUrl({ ...config, vcrEnabled: false }), "");
  assert.equal(vcrGatewayProviderUrl({ vcrEnabled: true, modelGatewayInternalUrl: "not a url" }), "");
  assert.equal(VCR_GATEWAY_PATH, "/internal/vcr/v1");
  assert.deepEqual([...VCR_GATEWAY_OPERATIONS], ["read", "write", "simulate"]);
});

test("a gateway path's metric label folds anything that is not an operation", () => {
  assert.equal(vcrGatewayRoutePattern("/internal/vcr/v1/read"), "/internal/vcr/v1/read");
  assert.equal(vcrGatewayRoutePattern("/internal/vcr/v1/whatever"), "/internal/vcr/v1/:operation");
});

test("the token names the account and the study; there is no id parameter", async () => {
  const { calls, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/read", { what: "study" }), res);
  assert.equal(res.status, 200);
  assert.equal(res.json().data.studyId, "std_1");
  assert.deepEqual(calls[0], ["read", "study", {}]);

  // A body field naming another study is refused as an unknown field, not honoured.
  const other = response();
  await handler(request("/internal/vcr/v1/read", { what: "study", studyId: "std_2" }), other);
  assert.equal(other.status, 400);
  assert.equal(other.json().code, "vcr_request_invalid");
});

test("a missing or invalid token is 401; the module off is a named 503", async () => {
  const { vcr, handler } = fixture();
  const none = response();
  await handler(request("/internal/vcr/v1/read", { what: "study" }, {}), none);
  assert.equal(none.json().code, "vcr_gateway_token_missing");
  const bad = response();
  await handler(request("/internal/vcr/v1/read", { what: "study" }, { authorization: "Bearer nope" }), bad);
  assert.equal(bad.json().code, "vcr_gateway_token_invalid");

  const off = createVcrGatewayHandler({ ...config, vcrEnabled: false }, runtimeManager, { vcr });
  const res = response();
  await handler.call(null, request("/internal/vcr/v1/read", { what: "study" }), response());
  await off(request("/internal/vcr/v1/read", { what: "study" }), res);
  assert.equal(res.status, 503);
  assert.equal(res.json().code, "vcr_disabled");
});

test("a conversation outside a study is a named 404, not an error", async () => {
  const outside = createVcrGatewayHandler(config, {
    assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "other" }),
  }, { vcr: fixture().vcr });
  const res = response();
  await outside(request("/internal/vcr/v1/read", { what: "study" }), res);
  assert.equal(res.status, 404);
  assert.equal(res.json().code, "vcr_no_study");
});

test("read and write vocabularies are closed, and the filter fields are too", async () => {
  const { handler } = fixture();
  for (const [operation, body, code] of [
    ["read", { what: "everything" }, "vcr_read_what_invalid"],
    ["read", { what: "study", filter: { secret: 1 } }, "vcr_read_filter_invalid"],
    ["read", { what: "study", filter: { limit: 500 } }, "vcr_read_filter_invalid"],
    ["write", { what: "results" }, "vcr_write_what_invalid"],
    ["write", { what: "definition", items: [{}], data: {} }, "vcr_write_payload_invalid"],
    ["simulate", { action: "compute" }, "vcr_simulate_action_invalid"],
    ["simulate", { action: "start", kind: "everything" }, "vcr_simulate_payload_invalid"],
    ["simulate", { action: "status" }, "vcr_simulate_payload_invalid"],
  ]) {
    const res = response();
    await handler(request(`/internal/vcr/v1/${operation}`, body), res);
    assert.equal(res.json().code, code, `${operation} ${JSON.stringify(body)}`);
  }
});

test("a runtime write may not write a number, a count or an execution record", async () => {
  const { calls, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", {
    what: "population",
    items: [
      { kind: "literature", name: "文献人群", counts: { realPatients: 400 } },
      { kind: "literature", name: "另一个", measures: [{ name: "orr", value: 0.4 }] },
      { kind: "literature", name: "第三个" },
    ],
  }), res);
  assert.equal(res.status, 200);
  const data = res.json().data;
  assert.equal(data.ok, true, "a refused item never fails the batch");
  assert.deepEqual(data.ids, ["pop_1"], "only the item that wrote no number was written");
  assert.deepEqual(data.issues.map((/** @type {any} */ issue) => [issue.index, issue.field, issue.code]), [
    [0, "counts", "vcr_write_field_forbidden"],
    [1, "measures", "vcr_write_field_forbidden"],
  ]);
  assert.equal(calls.filter((call) => call[0] === "population").length, 1);
});

test("AC-33 everything a run writes is labelled ai_set; nothing it writes is labelled reviewed", async () => {
  const { calls, handler } = fixture();
  await handler(request("/internal/vcr/v1/write", { what: "definition", data: { pico: { population: "二线 NSCLC" }, endpointType: "binary" } }), response());
  await handler(request("/internal/vcr/v1/write", { what: "assumption", items: [{ key: "dropout_rate", pointValue: 0.15 }] }), response());
  const states = calls.filter((call) => ["definition", "assumption"].includes(call[0])).map((call) => call[call.length - 1]);
  assert.deepEqual(states, ["ai_set", "ai_set"]);

  const text = await readFile(new URL("../src/vcrGateway.mjs", import.meta.url), "utf8");
  assert.ok(text.includes('reviewState: "ai_set"'), "the scan found the write path it is asserting about");
  assert.equal(text.includes('reviewState: "reviewed"'), false, "a run cannot countersign its own work");
});

test("a write refuses item by item, with the field named, and writes the rest", async () => {
  const { calls, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", {
    what: "trial_scenario",
    items: [
      { label: "A", design: "two_arm_fixed", endpointType: "time_to_event" },
      { label: "B", design: "platform", endpointType: "time_to_event" },
      { label: "C", design: "single_arm", endpointType: "ordinal" },
    ],
  }), res);
  const data = res.json().data;
  assert.equal(data.ok, true);
  assert.equal(data.ids.length, 1);
  assert.deepEqual(data.issues.map((/** @type {any} */ issue) => [issue.index, issue.field]), [[1, "design"], [2, "endpointType"]]);
  assert.deepEqual(calls.filter((call) => call[0] === "scenario"), [["scenario", "two_arm_fixed"]]);
});

test("an assumption from the literature has to point at an extracted value with a locator", async () => {
  const { handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", {
    what: "assumption",
    items: [{ key: "control_median_pfs", pointValue: 4.1, sourceKind: "external_evidence" }],
  }), res);
  const data = res.json().data;
  assert.equal(data.ok, false);
  assert.equal(data.issues[0].code, "vcr_write_value_invalid");
  assert.match(data.issues[0].message, /evidenceIds/);
  assert.equal(/AC-\d+|方案 §/.test(JSON.stringify(data.issues)), false, "what a run is told carries no plan or acceptance identifiers");
});

test("a comparator is a route and an estimand; whether it is estimable is the engine's answer, never the run's", async () => {
  const { calls, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", {
    what: "comparator",
    items: [
      { route: "external_control", estimand: "ATT" },
      { route: "external_control", estimand: "ATT", conclusion: "not_estimable", gapList: [{ field: "concomitant_therapy", missingFor: 0.62 }] },
    ],
  }), res);
  const data = res.json().data;
  assert.equal(data.ok, true);
  assert.deepEqual(calls.filter((call) => call[0] === "comparator"), [["comparator", "external_control", null]]);
  assert.deepEqual(data.issues.map((/** @type {any} */ issue) => [issue.index, issue.field, issue.code]), [[1, "conclusion", "vcr_write_field_forbidden"]],
    "a conclusion is not a field of the write at all, and the gap list beside it is a result field");
});

test("a run may ask for a step and leave a note; it cannot declare one finished, and says so by being refused", async () => {
  const { calls, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", { what: "step", items: [
    { step: "trial", requested: true, note: "在等作业" },
    { step: "trial", requested: true, status: "done" },
  ] }), res);
  const written = calls.filter((call) => call[0] === "step");
  assert.equal(written.length, 1);
  assert.equal(written[0][1], "trial");
  assert.deepEqual(Object.keys(JSON.parse(written[0][2])).sort(), ["note", "requested"]);
  assert.deepEqual(res.json().data.issues.map((/** @type {any} */ issue) => [issue.index, issue.field]), [[1, "status"]],
    "status is read from the data, and a run that sends one is told, not quietly ignored");
});

test("AC-20 a report the run writes is rendered by the platform, and its typed numbers come back as issues", async () => {
  const { calls, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", {
    what: "report",
    data: { kind: "study_package", template: "功效为 {{n:results.trial_scenario.measures[0].value|pct1}}，事件 999 起。" },
  }), res);
  const data = res.json().data;
  assert.equal(data.ok, true);
  assert.ok(calls.some((call) => call[0] === "export" && call[1] === "study_package"));
  assert.ok(calls.some((call) => call[0] === "updateExport"));
  assert.deepEqual(data.issues.map((/** @type {any} */ issue) => issue.code), ["vcr_number_typed"]);
  const stored = calls.find((call) => call[0] === "updateExport");
  assert.ok(stored, "the rendered report is kept on the export row");
  assert.equal(/2\.4|71\.0%|0\.71/.test(JSON.stringify(data)), false, "what the run is told carries no rendered number");
  // The typed number is not in the report a reader gets: the words say 「未计算」 where the run typed it.
  const report = stored[3].cover.report;
  assert.equal(report.rendered.includes("999"), false, "the typed number was removed from the stored report");
  assert.match(report.rendered, /事件 未计算 起/);
  assert.equal(report.rendered.includes("{{n:"), false);
});

test("C2-10 a reference the renderer cannot parse is an issue and never reaches the stored report raw", async () => {
  const { calls, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", {
    what: "report",
    data: { kind: "study_package", template: "功效为 {{n:results.trial_scenario.measures[0].value|PCT1}}，把握 {{N:measure(power)}}。" },
  }), res);
  const data = res.json().data;
  assert.deepEqual(data.issues.map((/** @type {any} */ issue) => issue.code), ["vcr_number_unparsed", "vcr_number_unparsed"]);
  const rendered = calls.find((call) => call[0] === "updateExport")?.[3].cover.report.rendered;
  assert.equal(rendered, "功效为 未计算，把握 未计算。");
});

test("C2-7 a design grid's comparison goal names the measures it compares; a result-shaped `measures` is still refused", async () => {
  const grid = { dimensions: { designs: [{ label: "A", kind: "two_arm_fixed", nTreat: 100, nControl: 100 }] }, truthScenarios: [{ label: "零效应" }] };
  const { handler } = fixture();
  const named = response();
  await handler(request("/internal/vcr/v1/write", { what: "design_grid", data: { ...grid,
    comparisonGoal: { text: "功效尽量高", measures: [{ name: "power", direction: "higher" }, "type_one_error"] } } }), named);
  assert.equal(named.json().data.ok, true, JSON.stringify(named.json().data.issues));
  assert.deepEqual(named.json().data.ids, ["grd_1"], "the grid was written");
  // Anything that carries a number is a result, at that path as anywhere.
  for (const measures of [[{ name: "power", value: 0.9 }], [{ name: "power", direction: "higher", mcse: 0.01 }], { power: 0.9 }, [{ name: "power", interval: { low: 1, high: 2 } }]]) {
    const refused = response();
    await handler(request("/internal/vcr/v1/write", { what: "design_grid", data: { ...grid, comparisonGoal: { text: "x", measures } } }), refused);
    assert.equal(refused.json().data.ok, false, JSON.stringify(measures));
    assert.equal(refused.json().data.issues[0].code, "vcr_write_field_forbidden");
    assert.equal(refused.json().data.issues[0].field, "comparisonGoal.measures");
  }
  // And a `measures` anywhere else in the object is as forbidden as ever.
  const elsewhere = response();
  await handler(request("/internal/vcr/v1/write", { what: "design_grid", data: { ...grid, dimensions: { ...grid.dimensions, measures: [{ name: "power", direction: "higher" }] } } }), elsewhere);
  assert.equal(elsewhere.json().data.ok, false);
  assert.equal(elsewhere.json().data.issues[0].field, "dimensions.measures");
});

test("a pooling start tells the run every study it left out, not the first twenty", async () => {
  const refused = Array.from({ length: 45 }, (_, at) => ({ id: `evd_${at}`, reasons: ["quote_not_verified"] }));
  const { handler } = fixture({ evidence: { async poolParameter() { return { status: "no_evidence", parameter: "median_time", jobs: [], refused }; } } });
  const res = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "start", kind: "pool_evidence", scenario: { parameter: "median_time", endpointKey: "pfs" } }), res);
  const data = res.json().data;
  assert.equal(data.state, "not_started");
  assert.equal(data.refused.length, 45, "the whole list, with each study's reason");
  assert.equal(data.refusedCount, 45);
  assert.deepEqual(data.refused[44], { id: "evd_44", reasons: ["quote_not_verified"] });
});

test("simulate is start / status / cancel, and a job over budget says so plainly", async () => {
  const { calls, handler } = fixture();
  const started = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "start", kind: "design_simulation", scenario: { design: { kind: "two_arm_fixed" } } }), started);
  assert.deepEqual(started.json().data, { action: "start", jobId: "job_1", state: "queued", progress: {} });
  assert.ok(calls.some((call) => call[0] === "enqueue" && call[1] === "design_simulation"));

  const status = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "status", jobId: "job_1" }), status);
  assert.equal(status.json().data.state, "running");
  assert.deepEqual(status.json().data.progress, { done: 3, total: 10 });

  const missing = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "status", jobId: "job_absent" }), missing);
  assert.equal(missing.json().code, "vcr_job_not_found");

  const overBudget = createVcrGatewayHandler(config, runtimeManager, {
    vcr: { ...fixture().vcr, jobs: { async enqueue() { return { job: { id: "job_2", state: "awaiting_budget", progress: {} }, created: true }; } } },
  });
  const waiting = response();
  await overBudget(request("/internal/vcr/v1/simulate", { action: "start", kind: "design_simulation" }), waiting);
  assert.equal(waiting.json().data.awaitingBudget, true);
  assert.match(waiting.json().data.message, /预算/);
});

test("a study whose account the module is not open to answers vcr_disabled", async () => {
  const { vcr } = fixture();
  const handler = createVcrGatewayHandler(config, runtimeManager, { vcr: { ...vcr, service: { ...vcr.service, allows: () => false } } });
  const res = response();
  await handler(request("/internal/vcr/v1/read", { what: "study" }), res);
  assert.equal(res.json().code, "vcr_disabled");
});

test("calls are counted per study, per operation, and too many in a minute is a named 429", async () => {
  const { handler } = fixture();
  assert.equal(VCR_GATEWAY_WINDOW_LIMITS.write, 60);
  let limited = null;
  for (let call = 0; call <= VCR_GATEWAY_WINDOW_LIMITS.write; call += 1) {
    const res = response();
    await handler(request("/internal/vcr/v1/write", { what: "definition", data: {} }), res);
    if (res.status === 429) { limited = res.json().code; break; }
  }
  assert.equal(limited, "vcr_gateway_rate_limited");
});

test("the runtime's copy of the read and write vocabularies is the server's", async () => {
  const python = await readFile(new URL("../../../runtime/mcp/evimed-research/vcr_platform.py", import.meta.url), "utf8");
  /** @param {string} name */
  const tuple = (name) => {
    const match = new RegExp(`${name} = \\(([\\s\\S]*?)\\)`).exec(python);
    assert.ok(match, `${name} is not in vcr_platform.py; the scan did not run`);
    return [...match[1].matchAll(/"([a-z_]+)"/g)].map((entry) => entry[1]);
  };
  assert.deepEqual(tuple("READ_WHATS"), [...VCR_READ_WHATS]);
  assert.deepEqual(tuple("WRITE_WHATS"), [...VCR_WRITE_WHATS]);
});

test("the write path cannot be reached without a study, and an empty write says so", async () => {
  const result = await vcrRuntimeWrite({ store: {}, service: {}, orchestrator: null, study, what: "definition", items: null, data: null });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "vcr_write_empty");
});

test('deferred publication cannot be requested while private forecasts and ordinary study writes remain usable', async () => {
  const { handler, vcr } = fixture();
  const saved = [];
  vcr.store.result = async (_studyId, id) => ({ id, version: 1, measures: [{ name: 'power', value: 0.8 }], counts: {} });
  vcr.store.registerForecast = async value => { saved.push(value); return { id: 'fct_private' }; };
  const res = response();
  await handler(request('/internal/vcr/v1/write', { what: 'forecast', items: [
    { kind: 'trial', resultId: 'res_1', public: true }, { kind: 'trial', resultId: 'res_1' },
  ] }), res);
  assert.equal(res.json().data.ids.length, 1);
  assert.equal(res.json().data.issues[0].field, 'public');
  assert.equal(saved.length, 1); assert.notEqual(saved[0].public, true);
  for (const what of ['soa_item', 'regulatory_contact', 'recruitment_material_publication']) {
    const deferred = response(); await handler(request('/internal/vcr/v1/write', { what, items: [{}] }), deferred);
    assert.equal(deferred.status, 400); assert.equal(deferred.json().code, 'vcr_write_what_invalid');
  }
  const normal = response(); await handler(request('/internal/vcr/v1/write', { what: 'definition', items: [{ pico: {}, estimand: {} }] }), normal);
  assert.equal(normal.json().data.ids.length, 1);
});

test('patient-set requests resolve exactly one registered model version before saving', async () => {
  const { handler, vcr } = fixture();
  const saved = [];
  vcr.store.models = async () => [{ id: 'mdl_v1', name: 'Restricted model', version: '1' }, { id: 'mdl_v2', name: 'Restricted model', version: '2' }];
  vcr.store.savePatientSet = async input => { saved.push(input); return { id: 'patients' }; };
  const res = response();
  await handler(request('/internal/vcr/v1/write', { what: 'patient_set', items: [
    { modelId: 'mdl_v1', modelVersion: '99' }, { modelVersion: '1' }, { modelId: 'Restricted model' },
    { modelId: 'Restricted model', modelVersion: '2' },
  ] }), res);
  assert.equal(res.json().data.ids.length, 1);
  assert.equal(res.json().data.issues.length, 3);
  assert.equal(saved.length, 1); assert.equal(saved[0].modelId, 'mdl_v2'); assert.equal(saved[0].modelVersion, '2');
});
