// The study owner's own conversation and page read the exact head counts of the owner's own study (owner ruling 2026-11-04, gap G22):
// "eight people" is eight, in what the model is told and in what the owner's page shows. Everyone else keeps the small-cell
// suppression: a member of the study, a programme run, a publication, a review input and any caller that does not say.
//
// Each changed path is held from both sides: the owner reads the number, the other reader does not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { VCR_MEMBER_ROLES, roleAllows } from "@evimed/domain";
import { VcrDataPlane } from "../src/vcrDataPlane.mjs";
import { createVcrGatewayHandler } from "../src/vcrGateway.mjs";
import { presentLongitudinal } from "../src/vcrLongitudinalPresentation.mjs";
import { createVcrRoutes } from "../src/vcrRoutes.mjs";
import { VcrService } from "../src/vcrService.mjs";

const AT = "2026-11-04T00:00:00.000Z";
const OWNER = "u1";
const MEMBER = "u2";
const study = { id: "std_1", userId: OWNER, projectId: "prj_1", name: "EV-201", question: "q", dataTier: "T1", intendedUse: "exploratory",
  status: "active", steps: {}, budget: {}, outcomeSeal: {}, scope: "project", conversationSessionId: "sess_1" };
const config = { vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:1/x" };

/** A result of eight real people with three events: both are under the floor of ten. */
const resultRow = {
  id: "res_1", studyId: "std_1", executionId: "exe_1", kind: "comparator", subjectId: null, version: 1, conclusion: "limited", notEstimableRule: null,
  counts: { realPatients: 8, events: 3, effectiveSampleSize: null, generatedRecords: 2000 }, measures: [{ name: "hr", value: 0.61, simulated: false }],
  diagnostics: { arms: [{ arm: "试验", n: 8, events: 3 }, { arm: "对照", n: 400, events: 90 }] },
  tables: [], intendedUse: "exploratory", useDowngrade: null, reviewState: "ai_set", supersededBy: null, createdAt: AT,
};

/** @param {any} [packages] */
function service(packages = {}) {
  const store = { async results() { return [resultRow]; }, async staleMarks() { return []; } };
  return new VcrService({ store: /** @type {any} */ (store), config: { vcrEnabled: true, vcrAudience: "all" }, ...packages });
}

/** @param {unknown} value @param {number[]} [out] */
function numbersIn(value, out = []) {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => numbersIn(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => numbersIn(item, out));
  return out;
}

// ---------------------------------------------------------------------------
// The service's one boundary
// ---------------------------------------------------------------------------

test("forModel: the owner's view prints the head counts, any other caller is suppressed, and the plane addresses go for both", () => {
  const boundary = service();
  const payload = { counts: { realPatients: 8, events: 3, generatedRecords: 2000 }, location: "derived/std_1/a.csv", inputHashes: ["a".repeat(64)],
    arms: [{ arm: "试验", n: 8 }, { arm: "对照", n: 400 }] };
  const owner = boundary.forModel(payload, { ownerView: true });
  assert.deepEqual(owner.counts, { realPatients: 8, events: 3, generatedRecords: 2000 }, "eight is eight");
  assert.deepEqual(owner.arms, [{ arm: "试验", n: 8 }, { arm: "对照", n: 400 }]);
  assert.equal("suppressed" in owner.counts, false);
  assert.equal("location" in owner, false, "an address in the data plane is never told, even to its owner");
  assert.equal("inputHashes" in owner, false);

  for (const hidden of [boundary.forModel(payload), boundary.forModel(payload, { ownerView: false }), boundary.forModel(payload, { projection: "report_model" })]) {
    assert.equal(hidden.counts.realPatients, null);
    assert.deepEqual(hidden.counts.suppressed.sort(), ["events", "realPatients"]);
    assert.ok(hidden.arms.every((/** @type {any} */ arm) => arm.n === null), "the small arm and the next-smallest are hidden together");
    assert.equal("location" in hidden, false);
  }
});

test("forModel: a walker the owner never needed cannot refuse the owner's read; the plane-address boundary still can", () => {
  const boundary = service();
  let deep = { counts: { realPatients: 8 } };
  for (let level = 0; level < 250; level += 1) deep = /** @type {any} */ ({ inner: deep });
  assert.throws(() => boundary.forModel(deep), { code: "vcr_gateway_unavailable" }, "the small-cell walker refuses a payload nested past its depth");
  let node = /** @type {any} */ (boundary.forModel(deep, { ownerView: true }));
  while (node.inner) node = node.inner;
  assert.equal(node.counts.realPatients, 8, "the owner's read was not refused for it");

  /** @type {any} */
  const cyclic = { counts: { realPatients: 8 } };
  cyclic.self = cyclic;
  assert.throws(() => boundary.forModel(cyclic, { ownerView: true }), { code: "vcr_gateway_unavailable", message: /数据平面地址/ },
    "a payload whose addresses cannot all be taken out is still not passed on");
});

test("runtimeRead: the owner reads the result's exact counts; the same read without the flag is suppressed", async () => {
  const owner = await service().runtimeRead(study, "results", {}, { ownerView: true });
  assert.deepEqual(owner.results[0].counts.realPatients, 8);
  assert.equal(owner.results[0].counts.events, 3);
  assert.equal(owner.results[0].diagnostics.arms.find((/** @type {any} */ arm) => arm.arm === "试验").n, 8);
  for (const hidden of [await service().runtimeRead(study, "results", {}), await service().runtimeRead(study, "results", {}, { ownerView: false })]) {
    assert.equal(hidden.results[0].counts.realPatients, null);
    assert.equal(hidden.results[0].diagnostics.arms.find((/** @type {any} */ arm) => arm.arm === "试验").n, null);
    assert.deepEqual(numbersIn(hidden).filter((value) => value === 8 || value === 3), []);
  }
});

test("runtimeRead: the profile read tells the data plane to print its counts for the owner only", async () => {
  /** @type {any[]} */
  const asked = [];
  const profile = service({ dataPlane: { async runtimeProfile(/** @type {any} */ _study, /** @type {any} */ _filter, /** @type {any} */ options) {
    asked.push(options ?? null); return { available: true, columns: [] };
  } } });
  await profile.runtimeRead(study, "snapshot_profile", { snapshotId: "snp_1" }, { ownerView: true });
  await profile.runtimeRead(study, "snapshot_profile", { snapshotId: "snp_1" });
  assert.deepEqual(asked, [{ exact: true }, { exact: false }]);
});

test("the data plane's profile for a model: a table of eight people has its row and fill counts for the owner and not for anyone else", async () => {
  const column = { name: "AGE", inferredType: "integer", filled: 3, rows: 8, densityCompleteness: 0.375, distinct: 3, vocabulary: { values: [], suppressedValues: 0 } };
  const file = { id: "fil_1", role: "data", name: "cohort.csv", format: "csv", rowCount: 8, columnCount: 1, profile: { tables: [{ name: "cohort", rows: 8, columns: [column] }] } };
  const source = { id: "src_1", name: "cohort", valueSource: "real", status: "ready", fieldMapState: "confirmed", fieldMapHash: "h", fieldMap: { columns: [] } };
  const plane = new VcrDataPlane({ store: /** @type {any} */ ({ async sourceInStudy() { return source; }, async listSourceFiles() { return [file]; } }), config: {} });
  const exact = await plane.sourceProfileForModel({ studyId: "std_1", sourceId: "src_1", exact: true });
  assert.equal(exact.files[0].rowCount, 8);
  assert.deepEqual([exact.files[0].columns[0].filled, exact.files[0].columns[0].rows], [3, 8]);
  for (const entry of [{ studyId: "std_1", sourceId: "src_1" }, { studyId: "std_1", sourceId: "src_1", exact: false }]) {
    const hidden = await plane.sourceProfileForModel(entry);
    assert.equal(hidden.files[0].rowCount, null);
    assert.deepEqual([hidden.files[0].columns[0].filled, hidden.files[0].columns[0].rows], [null, null]);
  }
});

// ---------------------------------------------------------------------------
// The gateway: who is asking
// ---------------------------------------------------------------------------

/** @param {string} url @param {unknown} body @param {Record<string, string>} headers */
function gatewayRequest(url, body, headers) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url, headers: { authorization: "Bearer token", ...headers } });
}
function gatewayResponse() {
  return { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; },
    end(/** @type {string} */ chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } };
}

/**
 * The gateway for one caller. `who` is the account the runtime token names; `native` is a verified conversation (with the study's own
 * session) or none, which is a programme run on the study's exclusive dispatch.
 * @param {{ who: string, native: boolean, jobs?: any }} options
 */
function gatewayFor({ who, native, jobs = null }) {
  const runtimeManager = { boundedRuntimeScope: () => ({ runId: "dispatch_1" }),
    assertActiveModelGatewayToken: () => ({ userId: who, projectId: "prj_1" }) };
  const store = {
    async studyByControlProject() { return study; },
    async studyByRuntimeDispatch() { return study; },
    async one(/** @type {string} */ sql) { return sql.includes("executions") ? { id: "exe_1" } : { checkpoint: {} }; },
    async allResults() { return [resultRow]; },
    async query() { return { rows: [] }; },
  };
  const defaultJobs = { async get() { return { id: "job_1", state: "succeeded", method: "design.simulate", progress: {}, cpuSecondsUsed: 1, error: null }; } };
  const handler = createVcrGatewayHandler(config, runtimeManager, {
    vcr: { service: service(), store, jobs: jobs ?? defaultJobs },
    resolveInvocation: async () => ({ userId: who, projectId: "prj_1", runId: "run_1", rootSessionId: "sess_1", callId: "call_1" }),
  });
  return async (/** @type {string} */ operation, /** @type {any} */ body) => {
    const res = gatewayResponse();
    await handler(gatewayRequest(`/internal/vcr/v1/${operation}`, body, native ? { "x-evimed-execution-context": "{}" } : {}), res);
    assert.equal(res.status, 200, res.body);
    return res.json().data;
  };
}

test("the gateway: the owner's conversation reads the exact counts; a member's conversation and a programme run on the same study do not", async () => {
  const owner = await gatewayFor({ who: OWNER, native: true })("read", { what: "results" });
  assert.equal(owner.results[0].counts.realPatients, 8);
  assert.equal(owner.results[0].diagnostics.arms[0].n, 8);
  const member = await gatewayFor({ who: MEMBER, native: true })("read", { what: "results" });
  assert.equal(member.results[0].counts.realPatients, null, "a member of the study reads it suppressed");
  const programme = await gatewayFor({ who: OWNER, native: false })("read", { what: "results" });
  assert.equal(programme.results[0].counts.realPatients, null, "a programme run is the platform's step, whose prose members read");
  for (const hidden of [member, programme]) assert.deepEqual(numbersIn(hidden).filter((value) => value === 8 || value === 3), []);
});

test("the gateway: a job's status answer prints its counts for the owner's conversation only", async () => {
  const status = { action: "status", jobId: "job_1" };
  const owner = await gatewayFor({ who: OWNER, native: true })("simulate", status);
  assert.equal(owner.result.counts.realPatients, 8);
  const member = await gatewayFor({ who: MEMBER, native: true })("simulate", status);
  assert.equal(member.result.counts.realPatients, null);
  const programme = await gatewayFor({ who: OWNER, native: false })("simulate", status);
  assert.equal(programme.result.counts.realPatients, null);
});

// ---------------------------------------------------------------------------
// The owner's page, and what leaves the study
// ---------------------------------------------------------------------------

const GROUP_RECORD = { id: "vlf_1", kind: "evaluation", summary: { dataClass: "patient", groups: [{ horizonDays: 30, subjects: 8, events: 3, metrics: { brier: { value: 0.2 } } }] } };

test("presentLongitudinal: exact is the owner's page, and without it a small group shows only its horizon and why", () => {
  const owner = presentLongitudinal({ records: [GROUP_RECORD] }, { exact: true });
  assert.deepEqual(owner.records[0].summary.groups[0], { horizonDays: 30, subjects: 8, events: 3, metrics: { brier: { value: 0.2 } } });
  const hidden = presentLongitudinal({ records: [GROUP_RECORD] }, {});
  assert.equal(hidden.records[0].summary.groups[0].displayReason, "small_cell_suppression");
  assert.equal(hidden.records[0].summary.groups[0].subjects, null);
  assert.equal(presentLongitudinal(GROUP_RECORD, { exact: true }).summary.groups[0].subjects, 8);
});

/** The routes over doubles shaped like the module's: the owner and one member (a viewer) of study `std_1`. */
function routes() {
  const viewer = VCR_MEMBER_ROLES.find((role) => role !== "lead" && roleAllows(role, "read")) ?? "viewer";
  const real = service();
  const records = { async describe() { return { available: false }; } };
  const routed = Object.assign(Object.create(real), {
    allows: () => true, isOperator: () => false,
    async requireStudy(/** @type {any} */ user, /** @type {string} */ id) {
      if (id !== study.id || ![OWNER, MEMBER].includes(String(user.id))) throw new Error("not found");
      return study;
    },
    packages: { ...real.packages, records, longitudinal: { async view() { return { records: [GROUP_RECORD] }; } } },
  });
  const vcrStore = { async rolesOf(/** @type {string} */ _studyId, /** @type {string} */ userId) { return userId === MEMBER ? [viewer] : []; } };
  const jobs = { async get() { return { id: "job_1", state: "succeeded", method: "design.simulate", methodVersion: "1", seed: 1, scenarioHash: "h", checkpoint: {} }; },
    async resultOf() { return resultRow; } };
  let current = OWNER;
  const handler = createVcrRoutes({
    store: /** @type {any} */ ({ async ensureSessionUser() { return { user: { id: current } }; }, async assertCsrf() {} }),
    vcrStore, service: routed, jobs, config, maxJsonBytes: 65_536,
  });
  return async (/** @type {string} */ as, /** @type {string} */ url) => {
    current = as;
    const chunks = /** @type {Buffer[]} */ ([]);
    const res = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
      { status: 0, writeHead(/** @type {number} */ status) { this.status = status; return this; } });
    await handler(Object.assign(Readable.from([]), { method: "GET", url, headers: {} }), res);
    assert.equal(res.status, 200, Buffer.concat(chunks).toString("utf8"));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")).data;
  };
}

test("the page: a job's result prints its counts for the study's owner and hides them from a member reading the same result", async () => {
  const get = routes();
  const url = "/api/vcr/studies/std_1/jobs/job_1/result";
  const owner = await get(OWNER, url);
  assert.equal(owner.result.counts.realPatients, 8);
  assert.equal(owner.result.diagnostics.arms[0].n, 8);
  const member = await get(MEMBER, url);
  assert.equal(member.result.counts.realPatients, null);
  assert.deepEqual(numbersIn(member.result).filter((value) => value === 8 || value === 3), []);
});

test("the page: the forecast evaluation prints its group sizes for the owner, and a member reads the small group as not shown", async () => {
  const get = routes();
  const url = "/api/vcr/studies/std_1/longitudinal";
  const owner = await get(OWNER, url);
  assert.equal(owner.records[0].summary.groups[0].subjects, 8);
  const member = await get(MEMBER, url);
  assert.equal(member.records[0].summary.groups[0].subjects, null);
  assert.equal(member.records[0].summary.groups[0].displayReason, "small_cell_suppression");
});

test("what leaves the study never carries the flag: publications and review inputs call the boundary with no owner view", () => {
  for (const file of ["../src/vcrPublications.mjs", "../src/vcrReview.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(/ownerView/.test(source), false, `${file} must reach the boundary as any other caller does`);
  }
  // and the boundary they call is suppressing by default
  assert.equal(service().forModel({ counts: { realPatients: 8 } }).counts.realPatients, null);
});
