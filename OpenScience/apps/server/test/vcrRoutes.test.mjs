// The 虚拟临研 routes' plumbing against doubles: bounded metric labels, the
// module invisible when it is off or not open to the account, another
// account's study reading as one that never existed, ids in a path held to
// their shape, a role checked per operation, an action whose worker is not
// composed answering 503 by name — and export never withheld for want of a
// review.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { VCR_ROUTE_ERROR_CODES, createVcrRoutes, vcrRoutePattern } from "../src/vcrRoutes.mjs";
import { vcrAudienceAllows } from "../src/vcrService.mjs";
import { HttpError } from "../src/security.mjs";

/** @param {string} method @param {string} url @param {unknown} [body] */
function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { "content-type": "application/json" } });
}

function response() {
  return {
    status: 0, body: "",
    writeHead(/** @type {number} */ status) { this.status = status; return this; },
    end(/** @type {string} */ chunk = "") { this.body = String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}

const config = { vcrEnabled: true, vcrAudience: "all", operatorUsers: [], vcrPreviewUsers: [] };
const study = { id: "std_1", userId: "reader", projectId: "prj_1", name: "EV-201", dataTier: "T0",
  intendedUse: "exploratory", status: "active", budget: {}, steps: {} };

function fixture(overrides = {}) {
  /** @type {any[]} */
  const calls = [];
  const store = {
    async ensureSessionUser() { return { user: { id: "reader" } }; },
    async assertCsrf(/** @type {any} */ _req, /** @type {string} */ pathname) { calls.push(["csrf", pathname]); },
    async rolesOf(_studyId, userId) { return userId === "reader" ? ["lead"] : []; },
    async members() { return [{ userId: "reader", role: "lead" }]; },
    async saveAssumption(input) { calls.push(["assumption", input.key, input.reviewState]); return { id: "asm_1", version: 4, ...input }; },
    async addReview(input) { calls.push(["review", input.kind]); return { id: "rvw_1", ...input }; },
    async addDecision(input) { calls.push(["decision"]); return { id: "dec_1", ...input }; },
    async exportRow(_studyId, id) { return id === "exp_1" ? { id: "exp_1", kind: "study_package", state: "ready" } : null; },
  };
  const service = {
    allows: (/** @type {any} */ user) => vcrAudienceAllows(config, user),
    isOperator: () => false,
    async listStudies() { calls.push(["list"]); return { studies: [] }; },
    async requireStudy(user, id) {
      if (id !== study.id || String(user.id) !== study.userId) {
        throw new HttpError(404, "vcr_study_not_found", "Study not found.");
      }
      return study;
    },
    async studyView(user, id) { await this.requireStudy(user, id); return { ...study, projectId: "prj_1" }; },
    async tab(user, id, tab) { await this.requireStudy(user, id); calls.push(["tab", tab]); return { tab }; },
    async createStudy() { throw new Error("must not be reached without a project hook"); },
    async updateStudy(_user, _id, patch) { calls.push(["update", Object.keys(patch).join(",")]); return { ...study, ...patch }; },
    async deleteStudy() { return { id: study.id, projectId: "prj_1", deleted: true }; },
    async modelLibrary() { calls.push(["models"]); return { models: [], methods: [] }; },
    async adoptModel(_user, input) { calls.push(["adopt", input.name]); return { id: "mdl_1", name: input.name }; },
    async precedents() { calls.push(["precedents"]); return { precedents: [], available: false }; },
  };
  return { calls, store, service, routes: createVcrRoutes({ store, service, config, maxJsonBytes: 65_536, ...overrides }) };
}

test("a 虚拟临研 path's metric label folds every id, so a dashboard row is a route", () => {
  for (const [path, label] of [
    ["/api/vcr", "/api/vcr"],
    ["/api/vcr/studies", "/api/vcr/studies"],
    ["/api/vcr/studies/std_abc", "/api/vcr/studies/:id"],
    ["/api/vcr/studies/std_abc/trial", "/api/vcr/studies/:id/trial"],
    ["/api/vcr/studies/std_abc/jobs", "/api/vcr/studies/:id/jobs"],
    ["/api/vcr/studies/std_abc/jobs/job_1", "/api/vcr/studies/:id/jobs/:item"],
    ["/api/vcr/studies/std_abc/jobs/job_1/cancel", "/api/vcr/studies/:id/jobs/:item/cancel"],
    ["/api/vcr/studies/std_abc/referrals/ref_1/contact", "/api/vcr/studies/:id/referrals/:item/contact"],
    ["/api/vcr/studies/std_abc/whatever-this-is", "/api/vcr/studies/:id/:route"],
    ["/api/vcr/models", "/api/vcr/models"],
    ["/api/vcr/precedents", "/api/vcr/precedents"],
    ["/api/vcr/other", "/api/vcr/:route"],
  ]) assert.equal(vcrRoutePattern(path), label, path);
});

test("the CSRF check is repeated, a path id is held to its shape, and creation without its hook is a named 503", async () => {
  const { calls, routes } = fixture();
  const res = response();
  assert.equal(await routes(request("GET", "/api/vcr/studies"), res), true);
  assert.deepEqual(calls, [["csrf", "/api/vcr/studies"], ["list"]]);
  assert.deepEqual(res.json(), { data: { studies: [] } });
  await assert.rejects(routes(request("GET", "/api/vcr/studies/..%2F..%2Fetc"), response()), { status: 404, code: "not_found" });
  await assert.rejects(routes(request("GET", "/api/vcr/studies/%E0%A4%A"), response()), { status: 400, code: "vcr_path_invalid" });
  await assert.rejects(routes(request("POST", "/api/vcr/studies", { name: "EV-201" }), response()), { status: 503, code: "vcr_unavailable" });
  await assert.rejects(routes(request("PUT", "/api/vcr/studies"), response()), { status: 404, code: "not_found" });
});

test("off, or open only to operators, the whole module answers 404 by name", async () => {
  const off = createVcrRoutes({ store: {}, service: {}, config: { ...config, vcrEnabled: false }, maxJsonBytes: 1_024 });
  await assert.rejects(off(request("GET", "/api/vcr/studies"), response()), { status: 404, code: "vcr_not_enabled" });
  assert.equal(await off(request("GET", "/api/other"), response()), false, "a path outside the module is not this router's");

  const operatorsOnly = { ...config, vcrAudience: "operators", operatorUsers: ["someone-else"] };
  const { store, service } = fixture();
  const routes = createVcrRoutes({
    store, service: { ...service, allows: (/** @type {any} */ user) => vcrAudienceAllows(operatorsOnly, user) },
    config: operatorsOnly, maxJsonBytes: 1_024,
  });
  await assert.rejects(routes(request("GET", "/api/vcr/studies"), response()), { status: 404, code: "vcr_not_enabled" });
});

test("another account's study reads as one that never existed", async () => {
  const { store, service } = fixture();
  const routes = createVcrRoutes({
    store: { ...store, async ensureSessionUser() { return { user: { id: "stranger" } }; } },
    service, config, maxJsonBytes: 1_024,
  });
  await assert.rejects(routes(request("GET", "/api/vcr/studies/std_1"), response()), { status: 404, code: "vcr_study_not_found" });
});

test("a payload field the route does not take is refused by name, and every vocabulary is closed", async () => {
  const { routes } = fixture();
  await assert.rejects(routes(request("PATCH", "/api/vcr/studies/std_1", { nickname: "x" }), response()),
    { status: 400, code: "vcr_payload_invalid" });
  await assert.rejects(routes(request("PATCH", "/api/vcr/studies/std_1", { dataTier: "T9" }), response()),
    { status: 400, code: "vcr_tier_invalid" });
  await assert.rejects(routes(request("PATCH", "/api/vcr/studies/std_1", { intendedUse: "anything" }), response()),
    { status: 400, code: "vcr_intended_use_invalid" });
  await assert.rejects(routes(request("PATCH", "/api/vcr/studies/std_1", { status: "deleted" }), response()),
    { status: 400, code: "vcr_status_invalid" });
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/run", { step: "nothing" }), response()),
    { status: 400, code: "vcr_step_invalid" });
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/export", { kind: "pdf" }), response()),
    { status: 400, code: "vcr_export_kind_invalid" });
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/jobs", { kind: "compute_everything" }), response()),
    { status: 400, code: "vcr_job_kind_invalid" });
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/reviews", { kind: "vibes", nodes: ["result:res_1@1"] }), response()),
    { status: 400, code: "vcr_review_kind_invalid" });
  await assert.rejects(routes(request("GET", "/api/vcr/studies/std_1/nonsense"), response()), { status: 404, code: "not_found" });
});

test("the seven tabs are the only tabs, and each is served by the service", async () => {
  const { calls, routes } = fixture();
  for (const tab of ["overview", "population", "patients", "comparator", "trial", "matching", "data"]) {
    const res = response();
    assert.equal(await routes(request("GET", `/api/vcr/studies/std_1/${tab}`), res), true);
    assert.deepEqual(res.json(), { data: { tab } });
  }
  assert.deepEqual(calls.filter((call) => call[0] === "tab").map((call) => call[1]),
    ["overview", "population", "patients", "comparator", "trial", "matching", "data"]);
});

test("an action whose worker is not composed answers 503 by name, not 500", async () => {
  const { routes } = fixture();
  for (const [method, path, body] of [
    ["POST", "/api/vcr/studies/std_1/run", { step: "definition" }],
    ["POST", "/api/vcr/studies/std_1/jobs", { kind: "design_simulation", scenario: {} }],
    ["GET", "/api/vcr/studies/std_1/jobs", undefined],
    ["POST", "/api/vcr/studies/std_1/jobs/job_1/cancel", {}],
    ["POST", "/api/vcr/studies/std_1/budget", { cpuSeconds: 600 }],
    ["POST", "/api/vcr/studies/std_1/export", { kind: "study_package" }],
    ["POST", "/api/vcr/studies/std_1/members", { userId: "u2", role: "viewer" }],
    ["POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", { note: "" }],
  ]) {
    await assert.rejects(routes(request(String(method), String(path), body), response()),
      { status: 503, code: "vcr_unavailable" }, `${method} ${path}`);
  }
});

test("AC-33 a person's edit to an assumption is recorded as reviewed, not as AI-set", async () => {
  const { calls, routes } = fixture();
  const res = response();
  assert.equal(await routes(request("POST", "/api/vcr/studies/std_1/assumptions",
    { key: "dropout_rate", name: "脱落率", pointValue: 0.15, sourceKind: "expert_set" }), res), true);
  assert.equal(res.status, 201);
  assert.deepEqual(calls.find((call) => call[0] === "assumption"), ["assumption", "dropout_rate", "reviewed"]);
});

test("AC-16 editing an assumption asks the orchestrator what has to be recomputed", async () => {
  /** @type {any[]} */
  const recomputes = [];
  const { routes } = fixture({
    orchestrator: { async recomputeAfterChange(input) { recomputes.push(input); return { light: [], heavy: [] }; } },
  });
  await routes(request("POST", "/api/vcr/studies/std_1/assumptions", { key: "dropout_rate", pointValue: 0.15 }), response());
  assert.equal(recomputes.length, 1);
  assert.equal(recomputes[0].studyId, "std_1");
  assert.equal(recomputes[0].reason, "assumption_changed");
  assert.deepEqual(recomputes[0].changed, ["assumption:dropout_rate@4"],
    "an assumption's lineage identity is its key: every version of 脱落率 is one thing with a history");
});

test("AC-21 an export is never withheld for want of a review", async () => {
  /** @type {any[]} */
  const exports = [];
  const { routes } = fixture({
    exporter: {
      async requestExport(_user, target, kind) {
        exports.push([target.id, kind]);
        return { export: { id: "exp_1", kind, state: "queued" }, runId: null, sessionId: null };
      },
    },
  });
  const res = response();
  assert.equal(await routes(request("POST", "/api/vcr/studies/std_1/export", { kind: "study_package" }), res), true);
  assert.equal(res.status, 201);
  assert.deepEqual(exports, [["std_1", "study_package"]]);
  assert.equal(res.json().data.export.id, "exp_1");
});

test("a role is checked per operation: a statistical reviewer may countersign and export, not queue compute", async () => {
  const { store, service } = fixture();
  const routes = createVcrRoutes({
    store: { ...store, async rolesOf() { return ["statistical_reviewer"]; } },
    service, config, maxJsonBytes: 65_536,
    jobs: { async enqueue() { throw new Error("must not be reached"); } },
    exporter: { async requestExport() { return { export: { id: "exp_1" } }; } },
  });
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/jobs", { kind: "design_simulation" }), response()),
    { status: 403, code: "vcr_forbidden" });
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/reviews", { kind: "clinical", nodes: ["result:res_1@1"] }), response()),
    { status: 403, code: "vcr_forbidden" }, "a statistical reviewer does not countersign the clinical reading");
  const statistical = response();
  assert.equal(await routes(request("POST", "/api/vcr/studies/std_1/reviews",
    { kind: "statistical", nodes: ["result:res_1@1"], note: "针对运行 #12" }), statistical), true);
  assert.equal(statistical.status, 201);
  const exported = response();
  assert.equal(await routes(request("POST", "/api/vcr/studies/std_1/export", { kind: "study_package" }), exported), true);
});

test("a viewer reads and writes nothing", async () => {
  const { store, service } = fixture();
  const routes = createVcrRoutes({
    store: { ...store, async rolesOf() { return ["viewer"]; } }, service, config, maxJsonBytes: 65_536,
    orchestrator: { async runStep() { throw new Error("must not be reached"); } },
  });
  const res = response();
  assert.equal(await routes(request("GET", "/api/vcr/studies/std_1/overview"), res), true, "a viewer reads");
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/run", { step: "definition" }), response()),
    { status: 403, code: "vcr_forbidden" });
  await assert.rejects(routes(request("PATCH", "/api/vcr/studies/std_1", { name: "改名" }), response()),
    { status: 403, code: "vcr_forbidden" });
});

test("every code these routes emit is one this module declares", async () => {
  // Only this file's error codes are double-quoted string literals starting
  // `vcr_` (the geoGateway rule): a code reaches a caller either as a literal
  // at a `throw`, or as a literal argument to one of the small validators, so
  // scanning the literals finds both. A walk assertion that proves it walked:
  // a scan that found a handful would be reporting a clean file it never read.
  const text = await readFile(new URL("../src/vcrRoutes.mjs", import.meta.url), "utf8");
  const literals = new Set([...text.matchAll(/"(vcr_[a-z0-9_]+)"/g)].map((match) => match[1]));
  assert.ok(literals.size >= 24, `only ${literals.size} codes were found; the scan did not run`);
  const undeclared = [...literals].filter((code) => !VCR_ROUTE_ERROR_CODES.includes(code)).sort();
  assert.deepEqual(undeclared, [], `emitted but not declared: ${undeclared.join(", ")}`);

  // Three of the declared codes are raised by the modules behind the routes —
  // the service's tab lookup, the orchestrator's paused study, the matching
  // package's referral — and are declared here because this is the list the
  // page reads and the domain's registry takes verbatim.
  const fromElsewhere = ["vcr_tab_not_found", "vcr_study_paused", "vcr_referral_not_found"];
  for (const code of fromElsewhere) assert.ok(VCR_ROUTE_ERROR_CODES.includes(code), code);
  const neverEmitted = VCR_ROUTE_ERROR_CODES.filter((code) => !literals.has(code) && !fromElsewhere.includes(code));
  assert.deepEqual(neverEmitted, [], `declared but never emitted: ${neverEmitted.join(", ")}`);
});
