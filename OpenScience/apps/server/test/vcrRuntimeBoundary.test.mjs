// The one boundary between the platform's numbers and a model: everything the
// runtime can read passes through the domain's `suppressForModel` exactly once
// (integration contract §4; the review's PA-3, PB-3 and CS-6).
//
// The first build suppressed one shape — a `cells` array — that nothing in the
// system produces. These tests feed the boundary every shape the stores really
// emit (`counts`, `waterfall[]`, `diagnostics.arms[]`, `levels` maps, the
// matching cells) through the real service, for every `what` a run may read and
// for the answer to a simulate status, and assert that no head count below the
// floor survives anywhere in what a model receives — including in a payload
// nested past twelve levels.
import assert from "node:assert/strict";
import test from "node:test";

import { VCR_MIN_CELL_SIZE } from "@evimed/domain";

import { VCR_READ_WHATS, VcrService } from "../src/vcrService.mjs";
import { createVcrGatewayHandler } from "../src/vcrGateway.mjs";
import { Readable } from "node:stream";

const AT = "2026-09-28T00:00:00.000Z";
const study = { id: "std_1", userId: "u1", projectId: "prj_1", name: "EV-201", question: "q", dataTier: "T1", intendedUse: "exploratory",
  status: "active", steps: {}, budget: {}, outcomeSeal: {} };

/** Distinctive small counts: any of them appearing as a number in an answer is a leak (nothing else in a fixture is one of these). */
const SMALL = [5, 6, 7, 8];

/** Every finite number in a payload, at any depth. @param {any} value @param {number[]} [out] */
function numbersIn(value, out = []) {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => numbersIn(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => numbersIn(item, out));
  return out;
}

const counts = { realPatients: 6, events: 8, effectiveSampleSize: null, generatedRecords: 2000 };
const populationRow = {
  id: "pop_1", studyId: "std_1", version: 1, name: "队列", kind: "real", definition: {}, snapshotId: null,
  counts: { realPatients: 412, events: 7 }, waterfall: [{ step: "确诊", kept: 412, excluded: 0 }, { step: "既往治疗", kept: 5, excluded: 407 }],
  profile: { levels: { A: 12, B: 6 } }, quality: {}, allowedUses: [], resultId: null, reviewState: "ai_set", createdAt: AT,
};
const resultRow = {
  id: "res_1", studyId: "std_1", executionId: "exe_1", kind: "comparator", subjectId: null, version: 1, conclusion: "limited", notEstimableRule: null,
  counts, measures: [{ name: "hr", value: 0.61, simulated: false }],
  diagnostics: { arms: [{ arm: "试验", n: 6, events: 8 }, { arm: "对照", n: 400, events: 90 }, { arm: "外部", n: 250, events: 60 }], balance: { levels: { 男: 5, 女: 250 } } },
  tables: [], intendedUse: "exploratory", useDowngrade: null, reviewState: "ai_set", supersededBy: null, createdAt: AT,
};

/** A store double answering every read the service's runtime half makes. */
const store = {
  async latestDefinition() { return { id: "def_1", version: 1, pico: {}, estimand: {}, endpointType: "time_to_event", intendedUse: "exploratory" }; },
  async definitionVersions() { return [{ version: 1, createdAt: AT }]; },
  async staleMarks() { return []; },
  async latestProtocolVersion() { return { id: "prt_1", version: 1 }; },
  async criteria() { return []; },
  async assumptions() { return []; },
  async populations() { return [populationRow]; },
  async latestPopulation() { return populationRow; },
  async patientSets() { return [{ id: "pts_1", studyId: "std_1", counts: { realPatients: 6, generatedRecords: 500 }, scenario: {}, modelId: "reference-time-to-event" }]; },
  async comparatorDesigns() { return [{ id: "cmp_1", route: "external_control", configuration: { note: "x" } }]; },
  async latestComparatorDesign() { return null; },
  async trialScenarios() { return []; },
  async latestDesignGrid() { return { id: "grd_1", cells: [{ label: "A", n: 6, power: 0.8 }, { label: "B", n: 250, power: 0.9 }, { label: "C", n: 300, power: 0.95 }] }; },
  async forecasts() { return []; },
  async results() { return [resultRow]; },
  async jobs() { return [{ id: "job_1", state: "succeeded", progress: { done: 40, total: 40 } }]; },
  async models() { return [{ id: "mdl_1", name: "reference-time-to-event", evidence: [], tier: "scenario" }]; },
  async methods() { return []; },
  async reviews() { return []; },
};

function service(packages = {}) {
  return new VcrService({
    store: /** @type {any} */ (store), config: { vcrEnabled: true, vcrAudience: "all" },
    matching: { async runtimeRead() { return { summaryCells: [{ key: "eligible", n: 6 }, { key: "ineligible", n: 400 }, { key: "pending", n: 90 }], subjects: [] }; } },
    evidence: {
      async runtimeRead() { return { precedents: [], coverage: [{ parameter: "median_time", extracted: 4, verified: 3, refused: 1, precedents: 2 }] }; },
      async evidenceRead() { return { items: [{ id: "evd_1", sampleSize: 6, events: 7 }] }; },
      async registryRecord() { return { record: { values: [{ parameter: "arm_started", value: 6, sampleSize: 8 }] } }; },
    },
    dataPlane: { async runtimeProfile() { return { available: true, columns: [{ name: "sex", levels: { 男: 5, 女: 250 }, filled: 255 }] }; } },
    documents: { async subjectDocuments() { return { available: true, subjects: [{ subjectKey: "P-1", documents: 2 }] }; } },
    ...packages,
  });
}

test("every `what` a run may read leaves through the boundary: no head count below the floor survives in any shape the stores emit", async () => {
  const seen = [];
  for (const what of VCR_READ_WHATS) {
    const answer = await service().runtimeRead(study, what, what === "snapshot_profile" ? { snapshotId: "snp_1" } : { registryId: "NCT02296125" });
    seen.push(what);
    // A public registry record's own figures (`value`, `sampleSize`) are another trial's published numbers, not
    // this study's people; the boundary still reads the record for the keys that count people.
    if (what === "trial_registry_record") continue;
    const small = numbersIn(answer).filter((value) => Number.isInteger(value) && value >= 1 && value < VCR_MIN_CELL_SIZE && SMALL.includes(value));
    // Numbers that are not people (a version, an ordinal) are not in SMALL's set by construction of the fixtures.
    assert.deepEqual(small, [], `${what} carried a small count: ${JSON.stringify(answer).slice(0, 300)}`);
  }
  assert.deepEqual(seen, [...VCR_READ_WHATS], "the walk read every `what`");
});

test("the shapes the stores emit are each suppressed as their own kind of cell", async () => {
  const population = await service().runtimeRead(study, "population");
  const [row] = population.populations;
  assert.equal(row.counts.events, null, "a standalone count is hidden");
  assert.deepEqual(row.counts.suppressed, ["events"], "and the object says which key it hid");
  assert.equal(row.counts.realPatients, 412);
  // A waterfall is a list of sibling cells: the small one is hidden with its neighbour, never alone.
  assert.equal(row.waterfall.some((step) => step.kept === 5), false);
  assert.ok(row.waterfall.every((step) => step.suppressed), "with two cells the small step and the next-smallest are both hidden: a lone hidden cell can be subtracted from the total");
  assert.ok(row.waterfall.every((step) => typeof step.step === "string"), "a hidden cell keeps its identity and loses every number");
  // A `levels` map is sibling cells too.
  assert.equal(row.profile.levels.B, null);
  assert.equal(row.profile.levels.A, null, "12 is hidden with 6: two cells at least, at least the floor");

  const results = await service().runtimeRead(study, "results");
  const arms = results.results[0].diagnostics.arms;
  const small = arms.find((arm) => arm.arm === "试验");
  assert.equal(small.n, null);
  assert.equal(small.events, null);
  assert.deepEqual(small.suppressed.sort(), ["events", "n"]);
  assert.equal(arms.find((arm) => arm.arm === "外部").n, null, "the next-smallest cell is hidden with it, so the small one cannot be got back by subtraction");
  assert.equal(arms.find((arm) => arm.arm === "对照").n, 400, "the largest is shown");
  assert.equal(results.results[0].counts.realPatients, null);
  assert.equal(results.results[0].counts.events, null);
  assert.equal(results.results[0].counts.generatedRecords, 2000, "generated records are not people");
  assert.equal(results.results[0].diagnostics.balance.levels.男, null);
  assert.equal(results.results[0].diagnostics.balance.levels.女, null);

  const grid = (await service().runtimeRead(study, "trial")).grid;
  assert.equal(grid.cells.find((cell) => cell.label === "A").n, null, "a design grid's cell is a cell like any other");
  assert.equal(grid.cells.find((cell) => cell.label === "C").n, 300);
});

test("the matching aggregates arrive as cells and are hidden by the same one boundary", async () => {
  const answer = await service().runtimeRead(study, "matching", {});
  const eligible = answer.summaryCells.find((cell) => cell.key === "eligible");
  assert.equal(eligible.n, null);
  assert.deepEqual(eligible.suppressed, ["n"]);
  assert.equal(answer.summaryCells.find((cell) => cell.key === "pending").n, null, "hidden together with its smallest neighbour");
  assert.equal(answer.summaryCells.find((cell) => cell.key === "ineligible").n, 400);
});

test("the snapshot profile, the evidence read, the registry read and the document listing pass the boundary too", async () => {
  const profile = await service().runtimeRead(study, "snapshot_profile", { snapshotId: "snp_1" });
  assert.equal(profile.columns[0].levels.男, null);
  const evidence = await service().runtimeRead(study, "evidence", {});
  assert.equal(evidence.items[0].events, null);
  assert.equal(evidence.items[0].sampleSize, undefined, "a hidden cell keeps what it is and loses every number, this one included");
  const registry = await service().runtimeRead(study, "trial_registry_record", { registryId: "NCT02296125" });
  assert.equal(registry.record.values[0].value, 6, "a value is not a head count: only the keys that count people are read");
  const counted = await service({ evidence: { async registryRecord() { return { record: { values: [{ parameter: "x", events: 6 }] } }; } } })
    .runtimeRead(study, "trial_registry_record", { registryId: "NCT02296125" });
  assert.equal(counted.record.values[0].events, null, "and a key that does count people is read there as everywhere");
  const documents = await service().runtimeRead(study, "subject_document", {});
  assert.equal(documents.subjects[0].documents, 2, "a document count is not a people count either");
});

test("a payload nested past twelve levels is walked all the way down, and a cycle is refused whole", async () => {
  let deep = { realPatients: 6 };
  for (let level = 0; level < 40; level += 1) deep = { inner: deep };
  const nested = service({ matching: { async runtimeRead() { return deep; } } });
  const answer = await nested.runtimeRead(study, "matching", {});
  let node = answer;
  while (node.inner) node = node.inner;
  assert.equal(node.realPatients, null, "40 levels down, the count is still hidden");
  assert.deepEqual(node.suppressed, ["realPatients"]);

  /** @type {any} */
  const cyclic = { counts: { realPatients: 400 } };
  cyclic.self = cyclic;
  await assert.rejects(() => service({ matching: { async runtimeRead() { return cyclic; } } }).runtimeRead(study, "matching", {}),
    (error) => /** @type {any} */ (error).code === "vcr_gateway_unavailable", "a payload the boundary cannot finish is not passed on unfinished");
});

test("the deployment may raise the floor and never lower it", async () => {
  const raised = new VcrService({ store: /** @type {any} */ (store), config: { vcrMinCellSize: 30 }, });
  assert.equal(raised.minCell, 30);
  assert.equal(new VcrService({ store: /** @type {any} */ (store), config: { vcrMinCellSize: 2 } }).minCell, VCR_MIN_CELL_SIZE);
  assert.equal(new VcrService({ store: /** @type {any} */ (store), config: {} }).minCell, VCR_MIN_CELL_SIZE);
  const answer = await raised.runtimeRead(study, "results");
  assert.equal(answer.results[0].diagnostics.arms.find((arm) => arm.arm === "对照").n, 400);
  assert.equal(answer.results[0].diagnostics.arms.find((arm) => arm.arm === "外部").n, null, "250 is shown at the default floor and hidden by a deployment that raised it above the cell's smallest count");
});

/** A request the gateway handler reads. */
function request(url, body) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url, headers: { authorization: "Bearer token" } });
}
function response() {
  return { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; },
    end(/** @type {string} */ chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } };
}

test("the answer to a simulate status passes the boundary too: a run does not read a small arm of its own simulation", async () => {
  const runtimeManager = { assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "prj_1" }) };
  const jobs = {
    async get() { return { id: "job_1", state: "succeeded", method: "design.simulate", progress: {}, cpuSecondsUsed: 1, error: null }; },
  };
  const gatewayStore = {
    async studyByControlProject() { return study; },
    async one(sql) { return sql.includes("executions") ? { id: "exe_1" } : { checkpoint: {} }; },
    async allResults() { return [resultRow]; },
  };
  const svc = service();
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:1/x" }, runtimeManager,
    { vcr: { service: /** @type {any} */ (svc), store: gatewayStore, jobs } });
  const res = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "status", jobId: "job_1" }), res);
  assert.equal(res.status, 200);
  const result = res.json().data.result;
  assert.equal(result.counts.realPatients, null);
  assert.equal(result.diagnostics.arms.find((arm) => arm.arm === "对照").n, 400);
  const small = numbersIn(res.json()).filter((value) => SMALL.includes(value));
  assert.deepEqual(small, []);
  assert.equal(result.diagnostics.arms.find((arm) => arm.arm === "试验").n, null);
});
