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
import { VCR_EXPORT_KINDS, VCR_EXPORT_KIND_LABELS_ZH, VCR_MODEL_DOCUMENT_KINDS, VCR_MODEL_DOCUMENT_SECTIONS } from "@evimed/domain";
import {
  VCR_GATEWAY_OPERATIONS, VCR_GATEWAY_PATH, VCR_GATEWAY_WINDOW_LIMITS, createVcrGatewayHandler, vcrGatewayProviderUrl,
  vcrGatewayRoutePattern, vcrRuntimeWrite,
} from "../src/vcrGateway.mjs";
import { VCR_READ_WHATS, VCR_WRITE_WHATS, VcrService } from "../src/vcrService.mjs";
import { vcrReportModel } from "../src/vcrRender.mjs";
import { HttpError } from "../src/security.mjs";

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
/** Three designs of one study, the way a conversation names them: 2:1 fixed, 1:1 fixed and 1:1 with an interim look. */
const DESIGN_A = { id: "scn_a", version: 1, label: "A 2:1 固定设计", design: "two_arm_fixed", endpointType: "time_to_event",
  configuration: { design: { nTreat: 120, nControl: 60, allocation: 0.6667 }, truth: { hazardRatio: 0.7 } } };
const DESIGN_B = { id: "scn_b", version: 2, label: "B 1:1 固定设计", design: "two_arm_fixed", endpointType: "time_to_event",
  configuration: { design: { nTreat: 90, nControl: 90, allocation: 0.5 }, truth: { hazardRatio: 0.7 } } };
const DESIGN_C = { id: "scn_c", version: 3, label: "C 1:1 序贯设计", design: "group_sequential", endpointType: "time_to_event",
  configuration: { design: { nTreat: 90, nControl: 90, allocation: 0.5, informationRates: [0.5, 1] }, truth: { hazardRatio: 0.7 } } };

const config = { vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:8788/internal/models/v1" };
const runtimeManager = { assertActiveModelGatewayToken: (/** @type {string} */ token) => {
  if (token !== "token") throw new Error("bad token");
  return { userId: "u1", projectId: "prj_1" };
} };

/** @param {Record<string, any>} [overrides] */
function fixture(overrides = {}) {
  /** @type {any[]} */
  const calls = [];
  /** The definitions the store was asked to save, whole. @type {any[]} */
  const definitions = [];
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
    async saveDefinition(input) { calls.push(["definition", input.reviewState]); definitions.push(input); return { id: "def_1", version: 1 }; },
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
    // The objects a computation can be for: one comparator, no population, patient set, design or grid until a test gives some.
    async comparatorDesigns() { return [{ id: "cmp_1", version: 1, route: "external_control" }]; },
    async populations() { return []; },
    async patientSets() { return []; },
    async latestDesignGrid() { return null; },
    async models() { return [{ id: "mdl_ref", name: "reference-time-to-event", version: "1.0.0" }]; },
    async saveModelAssessment(input) { calls.push(["assessment", input.record.key, input.record.risk, input.record.influence]); return { id: "mia_1", version: 1 }; },
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
  return { calls, definitions, vcr, handler: createVcrGatewayHandler(config, runtimeManager, { vcr }) };
}

test("the gateway's address is derived from the model gateway's, and is empty when the module is off", () => {
  assert.equal(vcrGatewayProviderUrl(config), "http://127.0.0.1:8788/internal/vcr/v1");
  assert.equal(vcrGatewayProviderUrl({ ...config, vcrEnabled: false }), "");
  assert.equal(vcrGatewayProviderUrl({ vcrEnabled: true, modelGatewayInternalUrl: "not a url" }), "");
  assert.equal(VCR_GATEWAY_PATH, "/internal/vcr/v1");
  assert.deepEqual([...VCR_GATEWAY_OPERATIONS], ["read", "write", "simulate", "digitize"]);
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

test("a definition that states nothing is refused in place: the step reads done from the row, so an empty card must not stand for the question", async () => {
  const { calls, handler } = fixture();
  /** @param {Record<string, any>} data */
  const write = async (data) => {
    const res = response();
    await handler(request("/internal/vcr/v1/write", { what: "definition", data }), res);
    return res.json().data;
  };
  for (const empty of [{}, { pico: {}, estimand: {} }, { pico: { population: "  ", intervention: "" }, estimand: { intercurrentEvents: [] }, fieldSources: { endpointType: "AI 设定" } }]) {
    const refused = await write(empty);
    assert.deepEqual(refused.ids, [], JSON.stringify(empty));
    assert.deepEqual(refused.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["pico", "vcr_write_value_invalid"]], JSON.stringify(empty));
    assert.match(refused.issues[0].message, /pico\.population/, "it says what to write, and when to ask instead");
  }
  assert.equal(calls.some((call) => call[0] === "definition"), false, "nothing was saved");
  // Any one stated part is a definition: who is studied, what is given, or an estimand attribute.
  for (const stated of [{ pico: { population: "二线 NSCLC" } }, { pico: { intervention: "EV 单药" } }, { estimand: { summary: "风险比" } }, { endpointType: "binary", pico: { outcome: "PFS" } }]) {
    assert.equal((await write(stated)).ids.length, 1, JSON.stringify(stated));
  }
});

test("a definition carries the study's name and question to the store, which is what names a draft study", async () => {
  const { definitions, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", { what: "definition", data: { title: "二线 NSCLC 单臂", question: "单臂 II 期加外部对照行不行？", pico: { population: "二线 NSCLC" } } }), res);
  assert.equal(res.json().data.ids.length, 1);
  assert.equal(definitions.at(-1).title, "二线 NSCLC 单臂");
  assert.equal(definitions.at(-1).question, "单臂 II 期加外部对照行不行？");
  // Neither is required: a definition without them leaves the naming to the store's fallback.
  await handler(request("/internal/vcr/v1/write", { what: "definition", data: { pico: { population: "二线 NSCLC" } } }), response());
  assert.equal(definitions.at(-1).title, null);
  assert.equal(definitions.at(-1).question, null);
});

test("a definition's name and question are held to their length and to being text; a definition with neither is as before", async () => {
  /** @type {any[]} */
  const saved = [];
  const { handler } = fixture({ store: { ...fixture().vcr.store, async saveDefinition(/** @type {any} */ input) { saved.push(input); return { id: "def_1", version: saved.length }; } } });
  const write = async (/** @type {Record<string, any>} */ data) => { const res = response(); await handler(request("/internal/vcr/v1/write", { what: "definition", data }), res); return res.json().data; };
  const pico = { population: "二线 NSCLC", intervention: "EV 单药" };
  const named = await write({ pico, title: "二线肺癌 EV 的样本量", question: "单臂 II 期加外部对照行不行，还是必须做随机？" });
  assert.equal(named.ok, true);
  assert.deepEqual([saved[0].title, saved[0].question], ["二线肺癌 EV 的样本量", "单臂 II 期加外部对照行不行，还是必须做随机？"]);
  assert.equal((await write({ pico })).ok, true, "a definition with neither is as before");
  assert.deepEqual([saved[1].title, saved[1].question], [null, null]);
  const long = await write({ pico, title: "字".repeat(61) });
  assert.equal(long.ok, false);
  assert.equal(long.issues[0].field, "title");
  assert.equal(saved.length, 2, "a title past its length is refused in place and nothing is saved");
  const sentence = await write({ pico, question: "问".repeat(2001) });
  assert.equal(sentence.issues[0].field, "question");
  assert.equal((await write({ pico, title: 7 })).issues[0].field, "title");
});

test("「从方案出发查覆盖」: a real population written from the protocol takes the criteria the snapshot can answer as its rules, says which it could not, and the cohort is then asked for with no scenario of its own", async () => {
  /** @type {any[]} */
  const saved = [];
  /** @type {any[]} */
  const queued = [];
  const criteria = [
    { id: "c1", ordinal: 1, kind: "inclusion", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 }, applicability: null },
    { id: "c2", ordinal: 2, kind: "inclusion", requirement: { op: "compare", variable: "ecog", comparator: "lte", value: 1 }, applicability: null },
    { id: "c3", ordinal: 3, kind: "exclusion", requirement: { op: "absent", variable: "brain_metastases" }, applicability: null },
  ];
  const store = { ...fixture().vcr.store,
    async one() { return { 1: 1 }; },
    async criteria() { return criteria; },
    async savePopulation(/** @type {any} */ input) { saved.push(input); return { id: "pop_cov", version: 1 }; },
    async populations() { return saved.length ? [{ id: "pop_cov", version: 1, kind: "real", name: "按方案条件查覆盖", snapshotId: "snp_1", definition: saved[0].definition }] : []; },
  };
  const jobs = { async enqueue(/** @type {any} */ input) { queued.push(input); return { job: { id: "job_cov", state: "queued", progress: {} }, created: true }; },
    async get() { return null; }, async cancel() { return { job: { id: "job_cov", state: "canceled" }, canceled: true }; } };
  const dataPlaneSeam = { async runtimeProfile() { return { available: true, fieldMap: [
    { column: "AGE", alias: "age", parameter: null, concept: "Age", unit: "years", identifier: false },
    { column: "ECOGBL", alias: "ecog", parameter: null, concept: "ECOG", unit: null, identifier: false },
    { column: "USUBJID", alias: null, parameter: null, concept: "Subject", unit: null, identifier: true }] }; } };
  const { handler } = fixture({ store, jobs, dataPlaneSeam });
  const write = async (/** @type {Record<string, any>} */ data) => { const res = response(); await handler(request("/internal/vcr/v1/write", { what: "population", data }), res); return res.json().data; };

  const written = await write({ kind: "real", fromProtocol: true, snapshotId: "snp_1" });
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.deepEqual(saved[0].definition, { rules: [
    { name: "I1", rule: { op: "compare", column: "age", comparator: "gte", value: 18 }, unknownAs: "exclude" },
    { name: "I2", rule: { op: "compare", column: "ecog", comparator: "lte", value: 1 }, unknownAs: "exclude" }] });
  assert.equal(saved[0].name, "按方案条件查覆盖");
  assert.deepEqual(saved[0].profile.coverage.notEvaluated, [{ code: "E1", why: "要看有没有这类事件或诊断的记录，受试者级的列判断不了" }], "kept with the population for the page");
  assert.equal(saved[0].snapshotId, "snp_1");
  assert.deepEqual(saved[0].allowedUses, []);
  assert.deepEqual(written.results[0].coverage, { evaluated: ["I1", "I2"], notEvaluated: [{ code: "E1", why: "要看有没有这类事件或诊断的记录，受试者级的列判断不了" }] });

  // the cohort is asked for with nothing but the population: its rules and its snapshot are its own
  const start = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "start", kind: "build_cohort", subjectId: "pop_cov" }), start);
  assert.equal(start.status, 200, start.body);
  assert.deepEqual(queued[0].scenario, saved[0].definition);
  assert.deepEqual(queued[0].inputs, [{ kind: "snapshot", id: "snp_1" }]);
  assert.equal(queued[0].detail.subjectId, "pop_cov");
  assert.equal(queued[0].detail.resultKind, "population");

  // refusals, each by name and each writing nothing
  const before = saved.length;
  assert.equal((await write({ kind: "real", fromProtocol: true })).issues[0].field, "snapshotId");
  assert.equal((await write({ kind: "scenario", fromProtocol: true, snapshotId: "snp_1" })).issues[0].field, "fromProtocol");
  assert.equal((await write({ fromProtocol: true, snapshotId: "snp_1", definition: { rules: [] } })).issues[0].field, "fromProtocol");
  assert.equal((await write({ fromProtocol: "yes", snapshotId: "snp_1" })).issues[0].field, "fromProtocol");
  const noneAnswerable = fixture({ store: { ...store, async criteria() { return [criteria[2]]; } }, dataPlaneSeam });
  const refused = response();
  await noneAnswerable.handler(request("/internal/vcr/v1/write", { what: "population", data: { fromProtocol: true, snapshotId: "snp_1" } }), refused);
  assert.match(refused.json().data.issues[0].message, /方案里没有一条条件能在这份数据上按列判断：E1（/);
  const noProtocol = fixture({ store: { ...store, async criteria() { return []; } }, dataPlaneSeam });
  const none = response();
  await noProtocol.handler(request("/internal/vcr/v1/write", { what: "population", data: { fromProtocol: true, snapshotId: "snp_1" } }), none);
  assert.match(none.json().data.issues[0].message, /还没有结构化的入排条件/);
  assert.equal(saved.length, before, "nothing was saved by a refusal");
  // a cohort with no scenario and no real population behind it says what to write
  const lonely = fixture({ jobs });
  const answer = response();
  await lonely.handler(request("/internal/vcr/v1/simulate", { action: "start", kind: "build_cohort", subjectId: "pop_none" }), answer);
  assert.equal(answer.status, 400);
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

/**
 * A study with one run out for one export: the orchestrator's answer to "which
 * export is this run for", and the export rows the store holds.
 * @param {{ kind: string, rows?: Array<Record<string, any>>, manager?: Record<string, any> }} input
 */
function exportRunFixture({ kind, rows = [], manager = runtimeManager }) {
  /** @type {Array<[string, any]>} */
  const asked = [];
  const held = new Map([{ id: "exp_wanted", kind, state: "queued", cover: {} }, ...rows].map((row) => [row.id, row]));
  const made = fixture({
    orchestrator: {
      async exportDispatch(/** @type {string} */ studyId, /** @type {any} */ caller) {
        asked.push([studyId, caller]);
        return { key: "run:export:exp_wanted", exportId: "exp_wanted", dispatchId: "vcr-run-export-exp_wanted-1", runId: "run_1" };
      },
    },
  });
  made.vcr.store.exportRow = async (/** @type {string} */ _studyId, /** @type {string} */ id) => held.get(id) ?? null;
  made.vcr.store.exports = async () => [...held.values()];
  return { ...made, asked, held, handler: createVcrGatewayHandler(config, manager, { vcr: made.vcr }) };
}

/** @param {(request: any, response: any) => Promise<unknown>} handler @param {Record<string, any>} data */
async function writeReport(handler, data) {
  const res = response();
  await handler(request("/internal/vcr/v1/write", { what: "report", data }), res);
  assert.equal(res.status, 200, res.body);
  return res.json().data;
}

test("a run sent out for an export fills that export and no other, whichever of the six documents it is", async () => {
  for (const kind of VCR_EXPORT_KINDS) {
    const { calls, handler } = exportRunFixture({ kind });
    // The two model documents take their words by named section; every other document takes one body.
    const section = VCR_MODEL_DOCUMENT_KINDS.includes(kind) ? { section: VCR_MODEL_DOCUMENT_SECTIONS[kind].prose[0] } : {};
    const written = await writeReport(handler, { kind, template: "方法与局限。", ...section });
    assert.deepEqual([written.ok, written.ids], [true, ["exp_wanted"]], kind);
    // No kind typed is the same export: the dispatch says which, the run does not have to.
    const unnamed = await writeReport(handler, { template: "方法与局限。", ...section });
    assert.deepEqual([unnamed.ok, unnamed.ids], [true, ["exp_wanted"]], kind);
    assert.deepEqual(calls.filter((call) => call[0] === "export"), [], `no export is made for a run that already has one (${kind})`);
    assert.deepEqual(calls.filter((call) => call[0] === "updateExport").map((call) => call[1]), ["exp_wanted", "exp_wanted"]);
  }
});

test("a report that names another document than the one its run was sent for is refused by name, and nothing is made or saved", async () => {
  for (const kind of VCR_EXPORT_KINDS) {
    for (const typed of VCR_EXPORT_KINDS.filter((other) => other !== kind)) {
      // An open export of the typed kind is what the write used to land in; with none, it used to make one.
      const { calls, handler } = exportRunFixture({ kind, rows: [{ id: "exp_other", kind: typed, state: "queued", cover: {} }] });
      const refused = await writeReport(handler, { kind: typed, template: "方法与局限。" });
      assert.deepEqual([refused.ok, refused.ids], [false, []], `${typed} into a run for ${kind}`);
      assert.deepEqual(refused.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["kind", "vcr_write_value_invalid"]]);
      const labels = /** @type {Record<string, string>} */ (VCR_EXPORT_KIND_LABELS_ZH);
      const message = refused.issues[0].message;
      assert.ok(message.includes(`「${labels[kind]}」`) && message.includes(`「${labels[typed]}」`), "both documents are named in words");
      assert.ok(message.includes(`kind 写 ${kind}`), "and the message says what to write instead");
      assert.deepEqual(calls.filter((call) => ["export", "updateExport"].includes(call[0])), [], "no row is made and no row is written");
    }
  }
});

test("which run is calling is the runtime's reservation, never a field of the request; with no export run out a report opens its own row", async () => {
  /** @type {any[]} */
  const projects = [];
  const reserved = { ...runtimeManager, boundedRuntimeScope: (/** @type {any} */ project) => { projects.push(project); return { runId: "vcr-run-export-exp_wanted-1" }; } };
  const bounded = exportRunFixture({ kind: "simulation_report", manager: reserved });
  await writeReport(bounded.handler, { template: "方法与局限。" });
  assert.deepEqual(projects, [{ userId: "u1", id: "prj_1" }], "the scope asked for is the token's project");
  assert.deepEqual(bounded.asked, [["std_1", { runtimeRunId: "vcr-run-export-exp_wanted-1" }]]);

  // The researcher's own open runtime is reserved for nothing: the study's run slot alone says which export.
  const open = exportRunFixture({ kind: "simulation_report" });
  await writeReport(open.handler, { template: "方法与局限。" });
  assert.deepEqual(open.asked, [["std_1", { runtimeRunId: null }]]);

  // A field of the request cannot say it: the item's fields are closed.
  const forged = await writeReport(open.handler, { template: "方法与局限。", exportId: "exp_other" });
  assert.deepEqual(forged.issues.map((/** @type {any} */ issue) => issue.field), ["exportId"]);

  // No export run out (the researcher's conversation): the write opens a row of the kind it names, as before.
  const { calls, vcr, handler } = fixture({ orchestrator: { exportDispatch: async () => null } });
  vcr.store.exportRow = async () => { throw new Error("an unbound write reads no dispatched export"); };
  const own = await writeReport(handler, { kind: "validation_pack", template: "方法与局限。" });
  assert.deepEqual([own.ok, own.ids], [true, ["exp_1"]]);
  assert.deepEqual(calls.filter((call) => call[0] === "export").map((call) => call[1]), ["validation_pack"]);
});

test("a run whose export is gone is told so, and its report is not filed anywhere else", async () => {
  const { calls, held, handler } = exportRunFixture({ kind: "study_package" });
  held.delete("exp_wanted");
  const refused = await writeReport(handler, { kind: "study_package", template: "方法与局限。" });
  assert.deepEqual([refused.ok, refused.ids], [false, []]);
  assert.deepEqual(refused.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["kind", "vcr_write_refused"]]);
  assert.deepEqual(calls.filter((call) => ["export", "updateExport"].includes(call[0])), []);
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

test("the comparator-effect kinds start through the gateway; a time-to-event MAIC names its comparator by a reconstruction result, never by rows", async () => {
  /** @type {any[]} */
  const queued = [];
  const jobs = {
    async enqueue(/** @type {any} */ input) { queued.push(input); return { job: { id: "job_9", state: "queued", progress: {} }, created: true }; },
    async get() { return null; }, async cancel() { return { job: { id: "job_9", state: "canceled" }, canceled: true }; },
  };
  const { handler } = fixture({ jobs });
  const start = async (/** @type {Record<string, any>} */ body) => { const res = response(); await handler(request("/internal/vcr/v1/simulate", { action: "start", ...body }), res); return res; };
  // every kind the domain declares is accepted by name, with the snapshot as its only data input
  for (const kind of ["weighted_cox_comparator", "aipw_comparator", "covariate_set_comparator"]) {
    const res = await start({ kind, scenario: { covariates: ["age"] }, inputs: [{ kind: "snapshot", id: "snp_1" }] });
    assert.equal(res.status, 200, `${kind}: ${res.body}`);
    assert.equal(queued.at(-1).kind, kind);
    assert.equal(queued.at(-1).derived, undefined, `${kind} takes no reference`);
    assert.deepEqual(queued.at(-1).inputs, [{ kind: "snapshot", id: "snp_1" }]);
  }
  // a reference is accepted for the one kind that reads a reconstruction, and reaches the queue as a reference beside the scenario
  const ok = await start({ kind: "maic_time_to_event_comparator", scenario: { covariates: ["age"], targets: { age: 60 } }, inputs: [{ kind: "snapshot", id: "snp_1" }], reconstructionResultId: "res_7" });
  assert.equal(ok.status, 200, ok.body);
  const sent = queued.at(-1);
  assert.deepEqual(sent.derived, [{ resultId: "res_7", table: "reconstructed-ipd", bindTo: "pseudoIpdInputId" }]);
  assert.equal(sent.scenario.pseudoIpdInputId, undefined, "the input's name is written by the queue, not the gateway");
  assert.notEqual(sent.internal, true, "a runtime request is not the orchestrator's");
  // the same request is the same job; another reconstruction is another job
  const again = await start({ kind: "maic_time_to_event_comparator", scenario: { covariates: ["age"], targets: { age: 60 } }, inputs: [{ kind: "snapshot", id: "snp_1" }], reconstructionResultId: "res_7" });
  assert.equal(again.status, 200);
  const other = await start({ kind: "maic_time_to_event_comparator", scenario: { covariates: ["age"], targets: { age: 60 } }, inputs: [{ kind: "snapshot", id: "snp_1" }], reconstructionResultId: "res_8" });
  assert.equal(queued.at(-2).idempotencyKey, sent.idempotencyKey);
  assert.notEqual(queued.at(-1).idempotencyKey, sent.idempotencyKey);
  assert.equal(other.status, 200);
  const before = queued.length;
  // refused by name, and never queued: no reference for the MAIC, a reference for any other kind, a malformed id, rows typed into the inputs
  for (const [body, code] of /** @type {Array<[Record<string, any>, string]>} */ ([
    [{ kind: "maic_time_to_event_comparator", scenario: {}, inputs: [{ kind: "snapshot", id: "snp_1" }] }, "vcr_simulate_payload_invalid"],
    [{ kind: "weighted_cox_comparator", scenario: {}, reconstructionResultId: "res_7" }, "vcr_simulate_payload_invalid"],
    [{ kind: "maic_time_to_event_comparator", scenario: {}, reconstructionResultId: "../etc" }, "vcr_simulate_payload_invalid"],
    [{ kind: "maic_time_to_event_comparator", scenario: {}, reconstructionResultId: 7 }, "vcr_simulate_payload_invalid"],
    [{ kind: "maic_time_to_event_comparator", scenario: {}, reconstructionResultId: "res_7", pseudoRows: [{ time: 1, status: 1 }] }, "vcr_request_invalid"],
  ])) {
    const res = await start(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.body}`);
    assert.equal(res.json().code, code, res.body);
  }
  assert.equal(queued.length, before, "a refused request never reaches the queue");
});

// --- robustness methods ---
test("the robustness kinds start through the gateway; none of them takes a reconstruction reference, and a stated table is refused by name", async () => {
  /** @type {any[]} */
  const queued = [];
  const jobs = {
    async enqueue(/** @type {any} */ input) { queued.push(input); return { job: { id: "job_10", state: "queued", progress: {} }, created: true }; },
    async get() { return null; }, async cancel() { return { job: { id: "job_10", state: "canceled" }, canceled: true }; },
  };
  const { handler } = fixture({ jobs });
  const start = async (/** @type {Record<string, any>} */ body) => { const res = response(); await handler(request("/internal/vcr/v1/simulate", { action: "start", ...body }), res); return res; };
  // the data is named as the snapshot and nothing else: columns come by grant alone
  const tipping = { endpoint: { type: "binary" }, design: { kind: "two_arm" }, outcomeColumn: "response", analysis: { method: "fisher_exact" } };
  for (const [kind, scenario, inputs] of /** @type {Array<[string, Record<string, any>, any[]]>} */ ([
    ["tipping_point", tipping, [{ kind: "snapshot", id: "snp_1" }]],
    ["negative_control_comparator", { covariates: ["age"], controls: [{ name: "fracture", column: "nc_fracture" }] }, [{ kind: "snapshot", id: "snp_1" }]],
    ["prognostic_adjustment_comparator", { endpoint: { type: "binary" }, prognosticScoreColumn: "score", outcomeColumn: "y" }, [{ kind: "snapshot", id: "snp_1" }]],
  ])) {
    const res = await start({ kind, scenario, inputs });
    assert.equal(res.status, 200, `${kind}: ${res.body}`);
    assert.equal(queued.at(-1).kind, kind);
    assert.equal(queued.at(-1).derived, undefined, `${kind} takes no reference`);
    assert.deepEqual(queued.at(-1).inputs, inputs);
    assert.notEqual(queued.at(-1).internal, true, "a runtime request is not the orchestrator's");
  }
  const before = queued.length;
  for (const kind of ["tipping_point", "negative_control_comparator", "prognostic_adjustment_comparator"]) {
    const res = await start({ kind, scenario: {}, reconstructionResultId: "res_7" });
    assert.equal(res.status, 400, `${kind}: ${res.body}`);
    assert.equal(res.json().code, "vcr_simulate_payload_invalid");
  }
  assert.equal(queued.length, before, "a refused request never reaches the queue");
});
// --- end robustness methods ---

test("a refused scenario tells the run where it was refused as a code and a path, so its tool can name the keys read there — and nothing of the engine's own words", async () => {
  /** @param {Record<string, any>} [extra] */
  const refusing = (extra = {}) => {
    const error = Object.assign(new HttpError(400, "vcr_job_scenario_invalid", "作业不符合引擎协议：scenario.accrual.months（scenario_field_unknown）。"), {
      issues: [
        { code: "scenario_field_unknown", field: "scenario.accrual.months", detail: "The engine does not read \"months\" here." },
        { code: "scenario_field_missing", field: "scenario.accrual.duration", detail: "duration is required." },
        { code: "Not A Code", field: "scenario.x" }, { code: "scenario_value_invalid", field: "" }, { code: "scenario_value_invalid" }, "text",
      ], ...extra });
    return fixture({ jobs: { async enqueue() { throw error; } }, store: { ...fixture().vcr.store,
      async trialScenarios() { return [DESIGN_A]; }, async patientSets() { return [{ id: "pts_1", version: 1, name: "虚拟患者" }]; } } });
  };
  const send = async (/** @type {any} */ handler, /** @type {string} */ kind) => {
    const res = response();
    await handler(request("/internal/vcr/v1/simulate", { action: "start", kind, subjectId: kind === "design_analytic" ? "scn_a" : "pts_1", scenario: { accrual: { months: 24 } } }), res);
    return res;
  };
  const analytic = await send(refusing().handler, "design_analytic");
  assert.equal(analytic.status, 400);
  assert.equal(analytic.json().code, "vcr_request_invalid");
  assert.deepEqual(analytic.json().issues, [{ code: "scenario_field_unknown", field: "scenario.accrual.months" }, { code: "scenario_field_missing", field: "scenario.accrual.duration" }],
    "a code and a path each; the engine's sentences, malformed entries and anything that is not a finding are not passed on");
  assert.doesNotMatch(analytic.body, /does not read|is required/);
  // The generators answer in their own code, with the alternatives, and the findings ride along.
  const patients = await send(refusing().handler, "generate_patients");
  assert.equal(patients.json().code, "vcr_simulate_payload_invalid");
  assert.equal(patients.json().alternatives.length, 3);
  assert.deepEqual(patients.json().issues.map((/** @type {any} */ issue) => issue.field), ["scenario.accrual.months", "scenario.accrual.duration"]);
  // A refusal with no findings sends none, and a failure that is not a refusal never invents any.
  const plain = fixture({ jobs: { async enqueue() { throw new HttpError(400, "vcr_job_scenario_invalid", "no fields"); } },
    store: { ...fixture().vcr.store, async trialScenarios() { return [DESIGN_A]; } } });
  assert.equal("issues" in (await send(plain.handler, "design_analytic")).json(), false);
});

test("simulate is start / status / cancel, and a job over budget says so plainly", async () => {
  const { calls, handler, vcr } = fixture({ store: { ...fixture().vcr.store, async trialScenarios() { return [DESIGN_A]; } } });
  void vcr;
  const started = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "start", kind: "design_simulation", scenario: { design: { kind: "two_arm_fixed" } } }), started);
  assert.deepEqual(started.json().data, { action: "start", jobId: "job_1", state: "queued", progress: {},
    subject: { kind: "trial_scenario", id: "scn_a", version: 1 } }, "the one design the scenario fits is the one it is about");
  assert.ok(calls.some((call) => call[0] === "enqueue" && call[1] === "design_simulation"));

  const status = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "status", jobId: "job_1" }), status);
  assert.equal(status.json().data.state, "running");
  assert.deepEqual(status.json().data.progress, { done: 3, total: 10 });

  const missing = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "status", jobId: "job_absent" }), missing);
  assert.equal(missing.json().code, "vcr_job_not_found");

  const overBudget = createVcrGatewayHandler(config, runtimeManager, {
    vcr: { ...fixture().vcr, store: { ...fixture().vcr.store, async trialScenarios() { return [DESIGN_A]; } },
      jobs: { async enqueue() { return { job: { id: "job_2", state: "awaiting_budget", progress: {} }, created: true }; } } },
  });
  const waiting = response();
  await overBudget(request("/internal/vcr/v1/simulate", { action: "start", kind: "design_simulation" }), waiting);
  assert.equal(waiting.json().data.awaitingBudget, true);
  assert.match(waiting.json().data.message, /预算/);
  assert.match(waiting.json().data.message, /不必等它/, "a run is told the job is not coming, so it does not wait or poll");

  // The status of a job that waits for a person says the same: a run that asks again is not left to read a bare state.
  const polled = createVcrGatewayHandler(config, runtimeManager, {
    vcr: { ...fixture().vcr, jobs: { ...fixture().vcr.jobs, async get() { return { id: "job_2", state: "awaiting_budget", progress: {}, cpuSecondsUsed: 0, error: null }; } } },
  });
  const again = response();
  await polled(request("/internal/vcr/v1/simulate", { action: "status", jobId: "job_2" }), again);
  assert.equal(again.json().data.state, "awaiting_budget");
  assert.equal(again.json().data.awaitingBudget, true);
  assert.match(again.json().data.message, /只有研究者确认后才会继续/);
});

test("a design's computation names the trial scenario it is for: its result is filed under it, the programme is told the stage is taken, and the scenario's earlier versions are replaced", async () => {
  /** @type {any[]} */
  const queued = [];
  /** @type {any[]} */
  const noted = [];
  const jobs = {
    async enqueue(/** @type {any} */ input) { queued.push(input); return { job: { id: `job_${queued.length}`, kind: input.kind, state: "queued", progress: {} }, created: true }; },
    async get() { return null; }, async cancel() { return { job: { id: "job_x", state: "canceled" }, canceled: true }; },
  };
  const olderB = { ...DESIGN_B, id: "scn_b0", version: 1 };
  const orchestrator = { async noteRuntimeJob(/** @type {any} */ studyRow, /** @type {any} */ subject, /** @type {any} */ job) { noted.push([studyRow.id, subject, job.id]); } };
  const { handler } = fixture({ jobs, orchestrator, store: { ...fixture().vcr.store, async trialScenarios() { return [DESIGN_C, DESIGN_B, DESIGN_A, olderB]; } } });
  const start = async (/** @type {Record<string, any>} */ body) => { const res = response(); await handler(request("/internal/vcr/v1/simulate", { action: "start", ...body }), res); return res; };

  const analytic = await start({ kind: "design_analytic", subjectId: "scn_b", scenario: { design: { kind: "two_arm_fixed", allocation: 0.5 } } });
  assert.equal(analytic.status, 200, analytic.body);
  assert.deepEqual(analytic.json().data.subject, { kind: "trial_scenario", id: "scn_b", version: 2 });
  assert.deepEqual(queued[0].detail, { subjectId: "scn_b", origin: "runtime", resultKind: "trial_scenario", node: "trial_scenario:scn_b@2", step: "trial",
    stage: "analytic", supersedes: ["scn_b0"] }, "the subject, where the result lands, the stage it is, and the earlier version of the same design it replaces");
  assert.match(queued[0].idempotencyKey, /design_analytic:scn_b:/, "the same scenario asked for another design is another job");
  assert.deepEqual(noted[0].slice(0, 1), ["std_1"]);
  assert.equal(noted[0][1].node, "trial_scenario:scn_b@2");
  assert.equal(noted[0][2], "job_1");

  // the simulation of the same design is the next stage of the same result, not another result
  await start({ kind: "design_simulation", subjectId: "scn_b", scenario: { design: { kind: "two_arm_fixed", allocation: 0.5 } } });
  assert.equal(queued[1].detail.stage, "simulation");
  assert.equal(queued[1].detail.subjectId, "scn_b");
  // and the other designs are other subjects
  await start({ kind: "design_simulation", subjectId: "scn_a", scenario: {} });
  assert.equal(queued[2].detail.subjectId, "scn_a");
  assert.deepEqual(queued[2].detail.supersedes, []);
});

test("a computation that names no object is attached to the one design its scenario fits, and refused by name when it fits several or none", async () => {
  /** @type {any[]} */
  const queued = [];
  const jobs = {
    async enqueue(/** @type {any} */ input) { queued.push(input); return { job: { id: `job_${queued.length}`, kind: input.kind, state: "queued", progress: {} }, created: true }; },
    async get() { return null; }, async cancel() { return { job: { id: "job_x", state: "canceled" }, canceled: true }; },
  };
  const { handler } = fixture({ jobs, store: { ...fixture().vcr.store, async trialScenarios() { return [DESIGN_C, DESIGN_B, DESIGN_A]; } } });
  const start = async (/** @type {Record<string, any>} */ body) => { const res = response(); await handler(request("/internal/vcr/v1/simulate", { action: "start", ...body }), res); return res; };

  // 1:1 allocation with a fixed design is B and only B
  const fitsOne = await start({ kind: "design_simulation", scenario: { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "time_to_event" } } });
  assert.equal(fitsOne.status, 200, fitsOne.body);
  assert.equal(queued.at(-1).detail.subjectId, "scn_b");
  // 2:1 is A
  await start({ kind: "design_analytic", scenario: { design: { kind: "two_arm_fixed", allocation: 0.6667 } } });
  assert.equal(queued.at(-1).detail.subjectId, "scn_a");

  const before = queued.length;
  // a scenario that fits B and C equally well is not a choice the gateway makes
  const several = await start({ kind: "design_simulation", scenario: { design: { allocation: 0.5 } } });
  assert.equal(several.status, 400);
  assert.equal(several.json().code, "vcr_simulate_subject_required");
  for (const id of ["scn_b", "scn_c"]) assert.match(several.json().error, new RegExp(id), "the answer lists the designs the study holds");
  assert.match(several.json().error, /不替你选/);
  // a scenario that fits none names what the study holds
  const none = await start({ kind: "design_simulation", scenario: { design: { kind: "single_arm" } } });
  assert.equal(none.json().code, "vcr_simulate_subject_required");
  assert.match(none.json().error, /scn_a/);
  assert.equal(queued.length, before, "a refused computation never reaches the queue");

  // an id that is not one of the study's designs
  const stranger = await start({ kind: "design_simulation", subjectId: "scn_of_another_study", scenario: {} });
  assert.equal(stranger.status, 400);
  assert.equal(stranger.json().code, "vcr_simulate_subject_unknown");
  assert.match(stranger.json().error, /scn_a/);
  // a study with no design at all is told to write one first
  const empty = fixture({ jobs });
  const nothing = response();
  await empty.handler(request("/internal/vcr/v1/simulate", { action: "start", kind: "design_simulation", scenario: {} }), nothing);
  assert.equal(nothing.json().code, "vcr_simulate_subject_required");
  assert.match(nothing.json().error, /vcr_write what="trial_scenario"/);
});

test("every kind of object a computation can be for is named the same way; a computation that is not about an object is not asked for one", async () => {
  /** @type {any[]} */
  const queued = [];
  const jobs = {
    async enqueue(/** @type {any} */ input) { queued.push(input); return { job: { id: `job_${queued.length}`, kind: input.kind, state: "queued", progress: {} }, created: true }; },
    async get() { return null; }, async cancel() { return { job: { id: "job_x", state: "canceled" }, canceled: true }; },
  };
  const store = { ...fixture().vcr.store,
    async populations() { return [{ id: "pop_2", version: 2, kind: "scenario", name: "情景人群" }, { id: "pop_1", version: 1, kind: "scenario", name: "情景人群" }]; },
    async patientSets() { return [{ id: "pts_1", version: 1, name: "虚拟患者" }]; },
    async latestDesignGrid() { return { id: "grd_1", version: 1 }; } };
  const { handler } = fixture({ jobs, store });
  const start = async (/** @type {Record<string, any>} */ body) => { const res = response(); await handler(request("/internal/vcr/v1/simulate", { action: "start", ...body }), res); return res; };
  const expected = /** @type {Array<[string, string, string, string[]]>} */ ([
    ["generate_population", "pop_2", "population", ["pop_1"]],
    ["generate_patients", "pts_1", "patient_set", []],
    ["design_grid", "grd_1", "design_grid", []],
    ["weighted_cox_comparator", "cmp_1", "comparator", []],
  ]);
  for (const [kind, subject, resultKind, supersedes] of expected) {
    const res = await start({ kind, scenario: {}, inputs: kind === "weighted_cox_comparator" ? [{ kind: "snapshot", id: "snp_1" }] : [] });
    assert.equal(res.status, 200, `${kind}: ${res.body}`);
    assert.equal(queued.at(-1).detail.subjectId, subject, `${kind} is attached to the one object of its kind that is current`);
    assert.equal(queued.at(-1).detail.resultKind, resultKind);
    assert.deepEqual(queued.at(-1).detail.supersedes, supersedes);
  }
  // What a generated table is kept for — the next computation and the researcher's download: the queue stores it in the data plane.
  assert.deepEqual(queued.find((job) => job.kind === "generate_population").detail.keepTables, ["population"]);
  assert.deepEqual(queued.find((job) => job.kind === "generate_patients").detail.keepTables, ["virtual-patients"]);
  assert.equal(queued.find((job) => job.kind === "design_grid").detail.keepTables, undefined);
  // A literature population is not the scenario population: the job's kind has to be the population's.
  const literature = await start({ kind: "literature_population", scenario: {} });
  assert.equal(literature.json().code, "vcr_simulate_subject_required");
  // Evidence pooling and an accrual forecast are about no object of these five.
  const accrual = await start({ kind: "accrual_forecast", scenario: {} });
  assert.notEqual(accrual.json().code, "vcr_simulate_subject_required");
});

test("digitize hands a calibration to the digitizer for the token's own study and answers a receipt, a refusal, or a named error", async () => {
  /** @type {any[]} */
  const seen = [];
  let answer = /** @type {any} */ ({ id: "crv_" + "a".repeat(32), origin: "digitizer", createdAt: "2026-10-04T00:00:00.000Z", digitization: { statedBy: "run", curves: [] } });
  const curves = { async recordDigitization(/** @type {any} */ input) { seen.push(input); if (answer instanceof Error) throw answer; return answer; } };
  const { vcr } = fixture();
  const handler = createVcrGatewayHandler(config, runtimeManager, { vcr: { ...vcr, evidence: { curves } } });
  const body = { imageArtifactId: "sources/fig.png", calibration: { x: { min: 0, max: 48, unit: "months" }, y: { min: 0, max: 1, scale: "fraction" } },
    arms: [{ riskTable: [{ time: 0, atRisk: 100 }, { time: 24, atRisk: 50 }] }] };

  const ok = response();
  await handler(request("/internal/vcr/v1/digitize", body), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json().data, { state: "digitized", receiptId: "crv_" + "a".repeat(32), origin: "digitizer", createdAt: "2026-10-04T00:00:00.000Z", digitization: { statedBy: "run", curves: [] } });
  // The token decides the study and the account; the body names neither, and the whole body is the digitizer's to close.
  assert.deepEqual(seen[0], { studyId: "std_1", principal: "u1", request: body });

  answer = { refused: { reason: "plot_area_ambiguous", message: "two plot areas", candidates: [{ left: 1, top: 2, right: 300, bottom: 400 }] } };
  const refused = response();
  await handler(request("/internal/vcr/v1/digitize", body), refused);
  assert.equal(refused.status, 200);
  assert.equal(refused.json().data.state, "refused");
  assert.equal(refused.json().data.reason, "plot_area_ambiguous");
  assert.deepEqual(refused.json().data.candidates, [{ left: 1, top: 2, right: 300, bottom: 400 }]);

  const named = async (/** @type {number} */ status, /** @type {string} */ code) => {
    answer = Object.assign(new Error("x"), { status, code, name: "HttpError" });
    const { HttpError } = await import("../src/security.mjs");
    answer = new HttpError(status, code, "x");
    const res = response();
    await handler(request("/internal/vcr/v1/digitize", body), res);
    return [res.status, res.json().code];
  };
  assert.deepEqual(await named(400, "vcr_curve_calibration_invalid"), [400, "vcr_curve_calibration_invalid"]);
  assert.deepEqual(await named(503, "vcr_curve_digitizer_unavailable"), [503, "vcr_curve_digitizer_unavailable"]);
  assert.deepEqual(await named(409, "vcr_curve_source_changed"), [409, "vcr_curve_source_changed"]);
  assert.deepEqual(await named(504, "vcr_intake_timeout"), [504, "vcr_intake_timeout"]);
  assert.deepEqual(await named(400, "something_else"), [400, "vcr_request_invalid"]);
});

test("digitize without a digitizer composed is a named 503, and its rate limit is its own", async () => {
  const { handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/digitize", { imageArtifactId: "a.png" }), res);
  assert.equal(res.status, 503);
  assert.equal(res.json().code, "vcr_curve_digitizer_unavailable");
  assert.equal(VCR_GATEWAY_WINDOW_LIMITS.digitize, 12);
  let limited = null;
  for (let call = 0; call <= VCR_GATEWAY_WINDOW_LIMITS.digitize; call += 1) {
    const next = response();
    await handler(request("/internal/vcr/v1/digitize", { imageArtifactId: "a.png" }), next);
    if (next.status === 429) { limited = next.json().code; break; }
  }
  assert.equal(limited, "vcr_gateway_rate_limited");
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
  const normal = response(); await handler(request('/internal/vcr/v1/write', { what: 'definition', items: [{ pico: { population: '二线 NSCLC' }, estimand: {} }] }), normal);
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

/** A complete assessment record as a run writes one. @param {Record<string, any>} [more] */
const assessmentItem = (more = {}) => ({
  key: "survival_projection", modelName: "reference-time-to-event", modelVersion: "1.0.0",
  questionOfInterest: "外部对照的生存基准能否用", contextOfUse: "生成对照臂的事件时间分布",
  influence: "medium", influenceJustification: "与文献对照一起使用", consequence: "high", consequenceJustification: "错判会让无效疗法进入关键试验",
  riskJustification: "后果为高", impact: "low", impactJustification: "做法已有讨论",
  technicalCriteria: ["重建曲线通过质控", { criterion: "校准斜率落在预设区间", rationale: "与风险相称" }], appropriateness: "覆盖终点",
  ...more,
});

test("a model assessment is written as the next version of its key, with the risk derived by the platform and never typed", async () => {
  const { calls, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", { what: "model_assessment", data: assessmentItem() }), res);
  const done = res.json().data;
  assert.deepEqual([done.ok, done.ids, done.issues], [true, ["mia_1"], []], JSON.stringify(done));
  assert.deepEqual(calls.find((call) => call[0] === "assessment"), ["assessment", "survival_projection", undefined, "medium"],
    "the gateway carries the two ratings and no risk; the store derives it (the integration suite holds that half)");

  // The risk is not a field: a run that types one is told, and nothing is written.
  const typed = response();
  await handler(request("/internal/vcr/v1/write", { what: "model_assessment", data: assessmentItem({ risk: "low" }) }), typed);
  assert.deepEqual([typed.json().data.ok, typed.json().data.issues.map((/** @type {any} */ issue) => [issue.field, issue.code])], [false, [["risk", "vcr_write_field_forbidden"]]]);
  // A rating outside the three words, a key that is not a token and a model with no name are each refused by name.
  const bad = response();
  await handler(request("/internal/vcr/v1/write", { what: "model_assessment", items: [
    assessmentItem({ influence: "severe" }), assessmentItem({ key: "Not A Key" }), assessmentItem({ modelName: undefined }),
    assessmentItem({ technicalCriteria: [{ rationale: "没有标准" }] }),
  ] }), bad);
  assert.deepEqual(bad.json().data.issues.map((/** @type {any} */ issue) => issue.field), ["influence", "key", "modelName", "technicalCriteria[0]"]);
  assert.equal(calls.filter((call) => call[0] === "assessment").length, 1, "none of the four refused items was written");
});

test("a half-filled assessment record is stored as it stands, with every gap named as a notice and a missing model named, never refused", async () => {
  const { calls, handler } = fixture();
  const res = response();
  await handler(request("/internal/vcr/v1/write", { what: "model_assessment", data: assessmentItem({
    modelName: "private-model", influenceJustification: undefined, technicalCriteria: undefined, appropriateness: undefined } ) }), res);
  const done = res.json().data;
  assert.deepEqual([done.ok, done.ids], [true, ["mia_1"]], "stored");
  assert.ok(calls.some((call) => call[0] === "assessment"));
  assert.ok(done.issues.some((/** @type {any} */ issue) => issue.code === "vcr_model_not_found" && issue.field === "modelName"), "the library does not hold it, and the run is told");
  assert.deepEqual(done.issues.filter((/** @type {any} */ issue) => issue.code === "vcr_model_assessment_incomplete").map((/** @type {any} */ issue) => issue.field).sort(),
    ["appropriateness", "influence", "technicalCriteria"], "each gap, by the field it is in");
});

test("the two model documents take a run's words by named section only; the platform's tables cannot be written over, and every other kind is unchanged", async () => {
  for (const kind of VCR_MODEL_DOCUMENT_KINDS) {
    const { calls, handler } = exportRunFixture({ kind });
    const prose = VCR_MODEL_DOCUMENT_SECTIONS[kind].prose;
    for (const section of prose) {
      const written = await writeReport(handler, { kind, section, template: "一段文字。" });
      assert.deepEqual([written.ok, written.ids], [true, ["exp_wanted"]], `${kind}/${section}`);
    }
    const refused = [];
    // A section that is the platform's own, one nobody has, and a body with no section at all.
    for (const data of [{ section: "appendices" }, { section: "assessment_table" }, {}]) refused.push(await writeReport(handler, { kind, template: "改写表格。", ...data }));
    for (const one of refused) {
      assert.deepEqual([one.ok, one.ids], [false, []], kind);
      assert.deepEqual(one.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["section", "vcr_report_section_invalid"]]);
      assert.ok(one.issues[0].message.includes(prose[0]), "and the sections that are a run's are named");
    }
    assert.equal(calls.filter((call) => call[0] === "updateExport").length, prose.length, "only the allowed sections reached the export");
  }
  // The other four documents keep one free-form body, section or not.
  for (const kind of VCR_EXPORT_KINDS.filter((entry) => !VCR_MODEL_DOCUMENT_KINDS.includes(entry))) {
    const { handler } = exportRunFixture({ kind });
    const written = await writeReport(handler, { kind, section: "任何一节", template: "方法与局限。" });
    assert.deepEqual([written.ok, written.ids], [true, ["exp_wanted"]], kind);
  }
});

test("the report of a model document is rendered against the model built for that document, with the plan's block in it", async () => {
  /** @type {any[]} */
  const asked = [];
  const { vcr, handler } = exportRunFixture({ kind: "model_analysis_plan" });
  vcr.service.reportModel = async (/** @type {any} */ target, /** @type {any} */ options) => {
    asked.push(options);
    return { study: target, modelAnalysis: { results: [{ measures: [{ name: "power", value: 0.8, simulated: false }] }] } };
  };
  const written = await writeReport(handler, { kind: "model_analysis_plan", section: "methods", template: "功效 {{n:modelAnalysis.results[0].measures[0].value|f1}}。" });
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.deepEqual(asked, [{ kind: "model_analysis_plan" }], "the model is built for the export's kind, which the dispatch names");
});

test("a model written by a run keeps the notices its card earned: the run hears what the contract of its call shape still lacks", async () => {
  const { handler, vcr } = fixture();
  vcr.service.adoptModel = async () => ({ id: "mdl_9", issues: [
    { code: "interface_field_missing", field: "applicability.horizon", text: "事件历史 → 未来轨迹接口的模型卡缺「最长推演时间（数值与单位）」" },
  ] });
  const res = response();
  await handler(request("/internal/vcr/v1/write", { what: "model", data: { name: "event-model", card: { interfaceShape: "event_history_to_trajectories" } } }), res);
  const done = res.json().data;
  assert.deepEqual([done.ok, done.ids], [true, ["mdl_9"]], "the model is kept");
  assert.deepEqual(done.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["applicability.horizon", "vcr_model_card_incomplete"]]);
});
