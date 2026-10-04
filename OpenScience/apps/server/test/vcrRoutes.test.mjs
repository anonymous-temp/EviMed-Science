// The 虚拟临研 routes' plumbing: bounded metric labels, the module invisible when
// it is off or not open to the account, another account's study reading as one
// that never existed, ids in a path held to their shape, a role checked per
// operation on EVERY route, an action whose worker is not composed answering
// 503 by name — and export never withheld for want of a review.
//
// The doubles here are shaped like the real things, and the one that matters is
// the platform's store: it has a session and a CSRF check and NOTHING of the
// module's. Until 2026-09-29 the test's store had `rolesOf`, `saveAssumption`
// and `addReview` on it, which the real one has never had — so every write and
// every role check threw on the first real request while this file was green
// (review CS-1). The same routes are driven through the real server against
// PostgreSQL in `vcrComposedApp.integration.test.mjs`.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { VCR_MEMBER_ROLES, roleAllows } from "@evimed/domain";
import { VCR_ROUTE_ABILITIES, VCR_ROUTE_ERROR_CODES, createVcrRoutes, vcrRoutePattern } from "../src/vcrRoutes.mjs";
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
const OWNER = "owner";
const study = { id: "std_1", userId: OWNER, projectId: "prj_1", name: "EV-201", dataTier: "T0",
  intendedUse: "exploratory", status: "active", budget: {}, steps: {} };

/**
 * The platform's store as `server.mjs` hands it to the routes: the session and
 * the CSRF check. Any other property is a call the routes must not make on it.
 * @param {{ calls: any[], who: () => string }} shared
 */
function platformStore(shared) {
  const known = {
    async ensureSessionUser() { return { user: { id: shared.who() } }; },
    async assertCsrf(/** @type {any} */ _req, /** @type {string} */ pathname) { shared.calls.push(["csrf", pathname]); },
  };
  return new Proxy(known, {
    get(target, property) {
      if (property in target) return /** @type {any} */ (target)[property];
      if (typeof property === "symbol" || property === "then") return undefined;
      throw new Error(`the platform's store has no ${String(property)}: a 虚拟临研 data call was made on it`);
    },
  });
}

/**
 * @param {{ who?: string, roles?: Record<string, string[]>, overrides?: Record<string, any>, operators?: string[] }} [options]
 */
function fixture({ who = OWNER, roles = {}, overrides = {}, operators = [] } = {}) {
  /** @type {any[]} */
  const calls = [];
  /** @type {any[]} */
  const audits = [];
  /** Every audit line whole, as the sink receives it. @type {any[]} */
  const auditLines = [];
  let current = who;
  const vcrStore = {
    async rolesOf(/** @type {string} */ _studyId, /** @type {string} */ userId) { calls.push(["vcr.rolesOf", userId]); return roles[userId] ?? []; },
    async members() { calls.push(["vcr.members"]); return [{ userId: OWNER, role: "lead" }]; },
    async saveAssumption(/** @type {any} */ input) { calls.push(["vcr.assumption", input.key, input.reviewState]); return { id: "asm_1", version: 4, ...input }; },
    async addReview(/** @type {any} */ input) { calls.push(["vcr.review", input.kind, input.reviewer]); return { id: "rvw_1", ...input }; },
    async addDecision(/** @type {any} */ input) { calls.push(["vcr.decision", input.decidedBy]); return { id: "dec_1", ...input }; },
    async exportRow(/** @type {string} */ _studyId, /** @type {string} */ id) { calls.push(["vcr.export", id]); return id === "exp_1" ? { id: "exp_1", kind: "study_package", state: "ready" } : null; },
  };
  const service = {
    allows: (/** @type {any} */ user) => vcrAudienceAllows(config, user),
    isOperator: (/** @type {any} */ user) => operators.includes(String(user?.id)),
    async listStudies() { calls.push(["list"]); return { studies: [] }; },
    async requireStudy(/** @type {any} */ user, /** @type {string} */ id) {
      // The service resolves the account's own study, or a study it is a member of.
      const member = String(user.id) === study.userId || (roles[String(user.id)] ?? []).length > 0;
      if (id !== study.id || !member) throw new HttpError(404, "vcr_study_not_found", "Study not found.");
      return study;
    },
    async studyView(/** @type {any} */ user, /** @type {string} */ id) { await this.requireStudy(user, id); return { ...study, projectId: "prj_1" }; },
    async tab(/** @type {any} */ user, /** @type {string} */ id, /** @type {string} */ tab, /** @type {any} */ query) {
      await this.requireStudy(user, id); calls.push(["tab", tab, query?.get?.("view") ?? null]); return { tab };
    },
    async createStudy() { throw new Error("must not be reached without a project hook"); },
    async updateStudy(/** @type {any} */ _user, /** @type {string} */ _id, /** @type {any} */ patch) { calls.push(["update", Object.keys(patch).join(",")]); return { ...study, ...patch }; },
    async deleteStudy() { calls.push(["delete"]); return { id: study.id, projectId: "prj_1", deleted: true }; },
    async modelLibrary() { calls.push(["models"]); return { models: [], methods: [] }; },
    async adoptModel(/** @type {any} */ _user, /** @type {any} */ input) { calls.push(["adopt", input.name]); return { id: "mdl_1", name: input.name }; },
    async precedents() { calls.push(["precedents"]); return { precedents: [], available: false }; },
    // The reader page comes from the service's presenter; the export row it is
    // built from is read from the module's store, as the real service does.
    async exportView(/** @type {any} */ user, /** @type {string} */ id, /** @type {string} */ exportId) {
      const found = await this.requireStudy(user, id);
      const row = await vcrStore.exportRow(found.id, exportId);
      if (!row) throw new HttpError(404, "vcr_export_not_found", "Export not found.");
      return { title: "研究包", runId: null, path: null, document: { status: row.state, sections: [] } };
    },
    store: vcrStore,
  };
  const routes = createVcrRoutes({
    store: /** @type {any} */ (platformStore({ calls, who: () => current })),
    vcrStore, service, config, maxJsonBytes: 65_536,
    audit: async (event, status, details) => { audits.push([event, status, details.code ?? null]); auditLines.push({ event, status, ...details }); },
    // The matching seam's two person-only acts, keyed to the session's account.
    assessments: {
      async overrideJudgment(/** @type {any} */ user, /** @type {any} */ found, /** @type {any} */ input) {
        calls.push(["assessment.override", String(user.id), found.id, input.criterionId, input.state]);
        return { assessmentId: input.assessmentId, criterionId: input.criterionId, overrideState: input.state, overriddenBy: String(user.id) };
      },
      async reviewAssessment(/** @type {any} */ user, /** @type {any} */ found, /** @type {any} */ input) {
        calls.push(["assessment.review", String(user.id), found.id, input.assessmentId]);
        return { id: input.assessmentId, reviewedBy: String(user.id) };
      },
    },
    ...overrides,
  });
  return { calls, audits, auditLines, service, vcrStore, routes, as(/** @type {string} */ id) { current = id; } };
}

test("a person re-judges a criterion and countersigns an assessment as themselves; a state outside the vocabulary is refused by name", async () => {
  const { calls, routes } = fixture();
  const overridden = response();
  await routes(request("POST", "/api/vcr/studies/std_1/assessments/asm_1/judgments/crt_2/override", { state: "not_satisfied", note: "病历写明曾用过该药" }), overridden);
  assert.equal(overridden.status, 201);
  assert.deepEqual(calls.find((call) => call[0] === "assessment.override")?.slice(1), [OWNER, "std_1", "crt_2", "not_satisfied"]);
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/assessments/asm_1/judgments/crt_2/override", { state: "maybe" }), response()),
    { status: 400, code: "vcr_criterion_state_invalid" });
  const reviewed = response();
  await routes(request("POST", "/api/vcr/studies/std_1/assessments/asm_1/review", {}), reviewed);
  assert.equal(reviewed.status, 201);
  assert.deepEqual(calls.find((call) => call[0] === "assessment.review")?.slice(1), [OWNER, "std_1", "asm_1"]);
});

test("a 虚拟临研 path's metric label folds every id, so a dashboard row is a route", () => {
  for (const [path, label] of [
    ["/api/vcr", "/api/vcr"],
    ["/api/vcr/studies", "/api/vcr/studies"],
    ["/api/vcr/studies/std_abc", "/api/vcr/studies/:id"],
    ["/api/vcr/studies/std_abc/trial", "/api/vcr/studies/:id/trial"],
    ["/api/vcr/studies/std_abc/jobs", "/api/vcr/studies/:id/jobs"],
    ["/api/vcr/studies/std_abc/jobs/job_1", "/api/vcr/studies/:id/jobs/:item"],
    ["/api/vcr/studies/std_abc/jobs/job_1/cancel", "/api/vcr/studies/:id/jobs/:item/cancel"],
    ["/api/vcr/studies/std_abc/members/user_1", "/api/vcr/studies/:id/members/:item"],
    ["/api/vcr/studies/std_abc/referrals", "/api/vcr/studies/:id/referrals"],
    ["/api/vcr/studies/std_abc/referrals/ref_1/contact", "/api/vcr/studies/:id/referrals/:item/contact"],
    ["/api/vcr/studies/std_abc/referrals/ref_1/transition", "/api/vcr/studies/:id/referrals/:item/transition"],
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
  const off = createVcrRoutes({ store: /** @type {any} */ ({}), service: {}, config: { ...config, vcrEnabled: false }, maxJsonBytes: 1_024 });
  await assert.rejects(off(request("GET", "/api/vcr/studies"), response()), { status: 404, code: "vcr_not_enabled" });
  assert.equal(await off(request("GET", "/api/other"), response()), false, "a path outside the module is not this router's");

  const operatorsOnly = { ...config, vcrAudience: "operators", operatorUsers: ["someone-else"] };
  const { service, calls } = fixture();
  const routes = createVcrRoutes({
    store: /** @type {any} */ (platformStore({ calls, who: () => OWNER })),
    service: { ...service, allows: (/** @type {any} */ user) => vcrAudienceAllows(operatorsOnly, user) },
    config: operatorsOnly, maxJsonBytes: 1_024,
  });
  await assert.rejects(routes(request("GET", "/api/vcr/studies"), response()), { status: 404, code: "vcr_not_enabled" });
});

test("another account's study reads as one that never existed, and nothing of it is asked of the module's store", async () => {
  const { routes, as, calls } = fixture();
  as("stranger");
  for (const [method, path, body] of /** @type {[string, string, any][]} */ ([
    ["GET", "/api/vcr/studies/std_1", undefined], ["PATCH", "/api/vcr/studies/std_1", { name: "x" }],
    ["GET", "/api/vcr/studies/std_1/overview", undefined], ["GET", "/api/vcr/studies/std_1/members", undefined],
    ["POST", "/api/vcr/studies/std_1/assumptions", { key: "k" }], ["GET", "/api/vcr/studies/std_1/referrals", undefined],
  ])) {
    await assert.rejects(routes(request(method, path, body), response()), { status: 404, code: "vcr_study_not_found" }, `${method} ${path}`);
  }
  assert.equal(calls.some((call) => String(call[0]).startsWith("vcr.")), false, "the module's store was never consulted for someone who is not in the study");
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
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/members", { userId: "u2", role: "overlord" }), response()),
    { status: 400, code: "vcr_member_role_invalid" });
  await assert.rejects(routes(request("GET", "/api/vcr/studies/std_1/nonsense"), response()), { status: 404, code: "not_found" });
});

test("CS-49 the compute budget is not a study field: PATCH refuses it, and only the audited confirmation changes it", async () => {
  const { routes } = fixture();
  await assert.rejects(routes(request("PATCH", "/api/vcr/studies/std_1", { budget: { cpuSecondsConfirmed: 9_999_999 } }), response()),
    { status: 400, code: "vcr_payload_invalid" });
  /** @type {any[]} */
  const confirmed = [];
  const withJobs = fixture({ overrides: { jobs: { async confirmBudget(/** @type {string} */ id, /** @type {any} */ input) { confirmed.push([id, input.actor, input.cpuSeconds]); return { released: [], budget: {} }; } } } });
  const res = response();
  await withJobs.routes(request("POST", "/api/vcr/studies/std_1/budget", { cpuSeconds: 600 }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(confirmed, [["std_1", OWNER, 600]]);
  assert.deepEqual(withJobs.audits.at(-1)?.slice(0, 2), ["vcr.budget.confirm", "completed"]);
});

test("the seven tabs are the only tabs, each is served by the service, and the query string reaches it", async () => {
  const { calls, routes } = fixture();
  for (const tab of ["overview", "population", "patients", "comparator", "trial", "matching", "data"]) {
    const res = response();
    assert.equal(await routes(request("GET", `/api/vcr/studies/std_1/${tab}${tab === "matching" ? "?view=referral" : ""}`), res), true);
    assert.deepEqual(res.json(), { data: { tab } });
  }
  assert.deepEqual(calls.filter((call) => call[0] === "tab").map((call) => call.slice(1)),
    [["overview", null], ["population", null], ["patients", null], ["comparator", null], ["trial", null], ["matching", "referral"], ["data", null]]);
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
    ["DELETE", "/api/vcr/studies/std_1/members/u2", undefined],
    ["GET", "/api/vcr/studies/std_1/referrals", undefined],
    ["POST", "/api/vcr/studies/std_1/referrals/ref_1/transition", { to: "contactable" }],
    ["POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", { note: "" }],
  ]) {
    await assert.rejects(routes(request(String(method), String(path), body), response()),
      { status: 503, code: "vcr_unavailable" }, `${method} ${path}`);
  }
});

test("CS-1 the data calls go to the module's store, the platform's store answers the session and nothing else", async () => {
  const { calls, routes, audits } = fixture();
  const assumption = response();
  assert.equal(await routes(request("POST", "/api/vcr/studies/std_1/assumptions",
    { key: "dropout_rate", name: "脱落率", pointValue: 0.15, sourceKind: "expert_set" }), assumption), true);
  assert.equal(assumption.status, 201);
  const review = response();
  await routes(request("POST", "/api/vcr/studies/std_1/reviews", { kind: "clinical", nodes: ["result:res_1@1"] }), review);
  assert.equal(review.status, 201);
  await routes(request("POST", "/api/vcr/studies/std_1/decisions", { question: "选哪个设计", chosen: { design: "B" } }), response());
  const exported = response();
  await routes(request("GET", "/api/vcr/studies/std_1/export/exp_1"), exported);
  assert.equal(exported.json().data.document.status, "ready", "the reader page is built from the module's export row");
  await assert.rejects(routes(request("GET", "/api/vcr/studies/std_1/export/exp_missing"), response()), { status: 404, code: "vcr_export_not_found" });
  const members = response();
  await routes(request("GET", "/api/vcr/studies/std_1/members"), members);
  assert.deepEqual(members.json().data.members, [{ userId: OWNER, role: "lead" }]);

  const reached = calls.map((call) => call[0]);
  for (const expected of ["vcr.rolesOf", "vcr.assumption", "vcr.review", "vcr.decision", "vcr.export", "vcr.members"]) {
    assert.ok(reached.includes(expected), `${expected} reached the module's store`);
  }
  assert.deepEqual(calls.find((call) => call[0] === "vcr.review")?.slice(1), ["clinical", OWNER], "the reviewer is the session's account");
  assert.deepEqual(calls.find((call) => call[0] === "vcr.decision")?.slice(1), [OWNER]);
  assert.equal(audits.filter((entry) => entry[1] === "completed").length, 3, "the three writes are audited as completed");
});

test("AC-33 a person's edit to an assumption is recorded as reviewed, not as AI-set", async () => {
  const { calls, routes } = fixture();
  const res = response();
  assert.equal(await routes(request("POST", "/api/vcr/studies/std_1/assumptions",
    { key: "dropout_rate", name: "脱落率", pointValue: 0.15, sourceKind: "expert_set" }), res), true);
  assert.equal(res.status, 201);
  assert.deepEqual(calls.find((call) => call[0] === "vcr.assumption"), ["vcr.assumption", "dropout_rate", "reviewed"]);
});

test("AC-16 editing an assumption asks the orchestrator what has to be recomputed", async () => {
  /** @type {any[]} */
  const recomputes = [];
  const { routes } = fixture({
    overrides: { orchestrator: { async recomputeAfterChange(/** @type {any} */ input) { recomputes.push(input); return { light: [], heavy: [] }; } } },
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
    overrides: {
      exporter: {
        async requestExport(/** @type {any} */ _user, /** @type {any} */ target, /** @type {string} */ kind) {
          exports.push([target.id, kind]);
          return { export: { id: "exp_1", kind, state: "queued" }, runId: null, sessionId: null };
        },
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
  const { routes, as } = fixture({
    roles: { stat: ["statistical_reviewer"] },
    overrides: {
      jobs: { async enqueue() { throw new Error("must not be reached"); } },
      exporter: { async requestExport() { return { export: { id: "exp_1" } }; } },
    },
  });
  as("stat");
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

test("the study lead holds review_any: it countersigns every kind, which no other role's ability carries", async () => {
  const { routes, calls } = fixture();
  for (const kind of ["clinical", "statistical", "data"]) {
    const res = response();
    await routes(request("POST", "/api/vcr/studies/std_1/reviews", { kind, nodes: ["result:res_1@1"] }), res);
    assert.equal(res.status, 201, kind);
  }
  assert.deepEqual(calls.filter((call) => call[0] === "vcr.review").map((call) => call[1]), ["clinical", "statistical", "data"]);
  assert.equal(roleAllows("lead", "review_clinical"), false, "the lead's ability is review_any, not the two kinds");
});

// ------------------------------------------------------------- every route, every role

/**
 * One request per route in the ability table, keyed exactly like it: a route
 * that is added to `VCR_ROUTE_ABILITIES` without a row here fails the walk.
 * @type {Record<string, [string, string, any]>}
 */
const REQUESTS = {
  "GET /studies/:id": ["GET", "/api/vcr/studies/std_1", undefined],
  "GET /studies/:id/:tab": ["GET", "/api/vcr/studies/std_1/overview", undefined],
  "PATCH /studies/:id name,question,action": ["PATCH", "/api/vcr/studies/std_1", { name: "改名" }],
  "PATCH /studies/:id dataTier,intendedUse,status": ["PATCH", "/api/vcr/studies/std_1", { status: "paused" }],
  "DELETE /studies/:id": ["DELETE", "/api/vcr/studies/std_1", undefined],
  "POST /studies/:id/run": ["POST", "/api/vcr/studies/std_1/run", { step: "definition" }],
  "GET /studies/:id/jobs": ["GET", "/api/vcr/studies/std_1/jobs", undefined],
  "GET /studies/:id/jobs/:job": ["GET", "/api/vcr/studies/std_1/jobs/job_1", undefined],
  "POST /studies/:id/jobs": ["POST", "/api/vcr/studies/std_1/jobs", { kind: "design_simulation", scenario: {} }],
  "POST /studies/:id/jobs/:job/cancel": ["POST", "/api/vcr/studies/std_1/jobs/job_1/cancel", {}],
  "POST /studies/:id/budget": ["POST", "/api/vcr/studies/std_1/budget", { cpuSeconds: 600 }],
  "POST /studies/:id/assumptions": ["POST", "/api/vcr/studies/std_1/assumptions", { key: "dropout" }],
  "POST /studies/:id/correction-cases": ["POST", "/api/vcr/studies/std_1/correction-cases", {}],
  "GET /studies/:id/correction-cases/:dataset": ["GET", "/api/vcr/studies/std_1/correction-cases/eds_fixture", undefined],
  "POST /studies/:id/correction-cases/:dataset/replay": ["POST", "/api/vcr/studies/std_1/correction-cases/eds_fixture/replay", {}],
  "GET /studies/:id/curve-extractions": ["GET", "/api/vcr/studies/std_1/curve-extractions", undefined],
  "POST /studies/:id/curve-extractions": ["POST", "/api/vcr/studies/std_1/curve-extractions", { imageArtifactId: "figure.png", points: {} }],
  "POST /studies/:id/reviews clinical": ["POST", "/api/vcr/studies/std_1/reviews", { kind: "clinical", nodes: ["result:res_1@1"] }],
  "POST /studies/:id/reviews statistical": ["POST", "/api/vcr/studies/std_1/reviews", { kind: "statistical", nodes: ["result:res_1@1"] }],
  "POST /studies/:id/reviews data": ["POST", "/api/vcr/studies/std_1/reviews", { kind: "data", nodes: ["result:res_1@1"] }],
  "POST /studies/:id/decisions": ["POST", "/api/vcr/studies/std_1/decisions", { question: "q" }],
  "POST /studies/:id/export": ["POST", "/api/vcr/studies/std_1/export", { kind: "study_package" }],
  "GET /studies/:id/export/:export": ["GET", "/api/vcr/studies/std_1/export/exp_1", undefined],
  "GET /studies/:id/members": ["GET", "/api/vcr/studies/std_1/members", undefined],
  "POST /studies/:id/members": ["POST", "/api/vcr/studies/std_1/members", { userId: "newcomer", role: "viewer" }],
  "DELETE /studies/:id/members/:user": ["DELETE", "/api/vcr/studies/std_1/members/newcomer", undefined],
  "GET /studies/:id/referrals": ["GET", "/api/vcr/studies/std_1/referrals", undefined],
  "POST /studies/:id/referrals/:referral/transition": ["POST", "/api/vcr/studies/std_1/referrals/ref_1/transition", { to: "contactable" }],
  "POST /studies/:id/referrals/:referral/contact": ["POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", {}],
  "POST /studies/:id/assessments/:assessment/judgments/:criterion/override": ["POST", "/api/vcr/studies/std_1/assessments/asm_1/judgments/crt_1/override", { state: "not_satisfied" }],
  "POST /studies/:id/assessments/:assessment/review": ["POST", "/api/vcr/studies/std_1/assessments/asm_1/review", {}],
  "POST /studies/:id/pack": ["POST", "/api/vcr/studies/std_1/pack", { use: "nsclc" }],
  "POST /studies/:id/pack/promote": ["POST", "/api/vcr/studies/std_1/pack/promote", {}],
  "POST /studies/:id/definitions": ["POST", "/api/vcr/studies/std_1/definitions", { populationId: "pop_1", name: "成人 ECOG 0-1", text: "年龄不小于 18 岁、ECOG 0 或 1。" }],
  "POST /studies/:id/definitions/:definition/use": ["POST", "/api/vcr/studies/std_1/definitions/dfn_1/use", { version: 1 }],
  "POST /studies/:id/definitions/:definition/compare": ["POST", "/api/vcr/studies/std_1/definitions/dfn_1/compare", { versionA: 1, versionB: 2 }],
  "POST /models (with a study)": ["POST", "/api/vcr/models", { studyId: "std_1", name: "m" }],
  "POST /studies/:id/data/sources": ["POST", "/api/vcr/studies/std_1/data/sources", { name: "合作方基线" }],
  "POST /studies/:id/data/sources/:source/files": ["POST", "/api/vcr/studies/std_1/data/sources/src_1/files?name=cohort.csv", undefined],
  "DELETE /studies/:id/data/files/:file": ["DELETE", "/api/vcr/studies/std_1/data/files/sfl_1", undefined],
  "POST /studies/:id/data/sources/:source/fieldmap": ["POST", "/api/vcr/studies/std_1/data/sources/src_1/fieldmap", { columns: [] }],
  "POST /studies/:id/data/sources/:source/fieldmap/confirm": ["POST", "/api/vcr/studies/std_1/data/sources/src_1/fieldmap/confirm", { hash: "a".repeat(64) }],
  "POST /studies/:id/data/sources/:source/snapshots": ["POST", "/api/vcr/studies/std_1/data/sources/src_1/snapshots", {}],
  "POST /studies/:id/data/snapshots/:snapshot/tables": ["POST", "/api/vcr/studies/std_1/data/snapshots/snp_1/tables", {}],
  "POST /studies/:id/data/sources/:source/grants": ["POST", "/api/vcr/studies/std_1/data/sources/src_1/grants", { grantee: "role:viewer" }],
  "POST /studies/:id/data/grants/:grant/revoke": ["POST", "/api/vcr/studies/std_1/data/grants/grt_1/revoke", {}],
};

/** Every hook composed and succeeding: a request that reaches one answers 2xx. */
function composedHooks() {
  const ok = async () => ({ ok: true, released: [], removed: 1, job: { id: "job_1" }, created: true, export: { id: "exp_1" } });
  return {
    corrections: { exportDataset: ok, readDataset: ok, replay: ok },
    evidence: { curves: { recordSelection: async () => ({ id: "curve", origin: "human_click" }), receipts: async () => [] } },
    orchestrator: { runStep: ok, recomputeAfterChange: ok },
    jobs: { enqueue: ok, get: async () => ({ id: "job_1" }), listForStudy: async () => [], budgetOf: async () => ({}), cancel: ok, confirmBudget: ok },
    exporter: { requestExport: ok },
    // The disease packs and the definition library: each answers the shape the real one does.
    knowledge: {
      bindPack: ok, promotePack: ok, saveFromStudy: async () => ({ definitionId: "dfn_1", version: 1 }),
      useInStudy: async () => ({ definitionId: "dfn_1", version: 1, populationId: "pop_1", renamed: [], unmatched: [] }),
      compareVersions: ok, listPacks: async () => ({ packs: [] }), getPack: async () => ({ id: "nsclc" }),
      listLibrary: async () => ({ definitions: [] }), getLibraryDefinition: async () => ({ id: "dfn_1" }),
    },
    members: { add: ok, remove: ok, list: async () => [] },
    matching: { contactReferral: ok, transitionReferral: ok, listReferrals: async () => ({ referrals: [] }) },
    // The data plane behind the intake routes, answering the shapes the real one does (what a route may send back is the route's to filter).
    dataPlane: (() => {
      const source = { id: "src_1", name: "合作方基线", ownerParty: "", allowedUses: ["vcr"], visibleWindow: {}, retention: {}, valueSource: "observed", status: "registered", fieldMapState: "none", fieldMapHash: null, createdAt: null };
      const file = { id: "sfl_1", sourceId: "src_1", name: "cohort.csv", role: "data", format: "csv", bytes: 10, sha256: "a".repeat(64), rowCount: 2, columnCount: 2, createdAt: null, profile: {}, detail: {} };
      const snapshot = { id: "snp_1", sourceId: "src_1", version: 1, sha256: "b".repeat(64), rowCount: 2, columnCount: 2, frozenAt: null, valueSource: "observed", fileHashes: [], sealedFields: [], sealedUntil: null, quality: {} };
      return {
        registerSource: async () => source,
        storeUpload: async () => ({ created: true, file }),
        removeUpload: async () => ({ removed: true, fileId: "sfl_1" }),
        proposeFieldMap: async () => ({ source, hash: "a".repeat(64), entryIssues: [], mapIssues: [] }),
        confirmFieldMap: async () => ({ source, checks: {} }),
        freezeSnapshot: async () => ({ snapshot, tables: { registered: [], refused: [], skipped: [], subjects: 0, dropped: {} } }),
        deriveAnalysisTables: async () => ({ registered: [], refused: [], skipped: [], subjects: 0, dropped: {} }),
        createGrant: async () => ({ id: "grt_1" }),
        revokeGrant: async () => ({ id: "grt_1", revokedAt: null }),
      };
    })(),
  };
}

test("CS-7 every route in the ability table is driven as every role, and 403 falls exactly where the role lacks the ability", async () => {
  assert.deepEqual(Object.keys(REQUESTS).sort(), Object.keys(VCR_ROUTE_ABILITIES).sort(),
    "each route in the table has a request here, and each request a row in the table");
  const roleFor = (/** @type {string} */ ability) => ability === "manage_study" ? "manage_members" : ability;
  let asserted = 0;
  for (const role of ["owner-lead", ...VCR_MEMBER_ROLES]) {
    const who = role === "owner-lead" ? OWNER : `as-${role}`;
    const held = role === "owner-lead" ? ["lead"] : [role];
    const { routes, as } = fixture({ roles: { [who]: role === "owner-lead" ? [] : held }, overrides: composedHooks() });
    as(who);
    for (const [key, abilities] of Object.entries(VCR_ROUTE_ABILITIES)) {
      const [method, path, body] = REQUESTS[key];
      const allowed = abilities.some((ability) => held.some((each) => roleAllows(each, roleFor(ability)) || roleAllows(each, ability)));
      const res = response();
      let status = 0;
      try { await routes(request(method, path, body), res); status = res.status; } catch (error) { status = error instanceof HttpError ? error.status : 500; }
      if (allowed) assert.ok(status >= 200 && status < 300, `${role} ${key}: allowed, got ${status}`);
      else assert.equal(status, 403, `${role} ${key}: not allowed (needs ${abilities.join(" or ")}), got ${status}`);
      asserted += 1;
    }
  }
  assert.ok(asserted >= (VCR_MEMBER_ROLES.length + 1) * Object.keys(VCR_ROUTE_ABILITIES).length, "the walk covered the whole grid");
});

test("a site reads no page of the study: its referrals are its own, and the study list does not name it", async () => {
  const { routes, as } = fixture({ roles: { siteuser: ["site"] }, overrides: composedHooks() });
  as("siteuser");
  for (const path of ["/api/vcr/studies/std_1", "/api/vcr/studies/std_1/overview", "/api/vcr/studies/std_1/matching", "/api/vcr/studies/std_1/members",
    "/api/vcr/studies/std_1/jobs", "/api/vcr/studies/std_1/export/exp_1"]) {
    await assert.rejects(routes(request("GET", path), response()), { status: 403, code: "vcr_forbidden" }, path);
  }
  const referrals = response();
  assert.equal(await routes(request("GET", "/api/vcr/studies/std_1/referrals"), referrals), true);
  assert.equal(referrals.status, 200);
});

test("CS-49 renaming is a writer's, changing what the study is is the lead's, and a data manager who tries is told which ability is missing", async () => {
  const { routes, as, calls } = fixture({ roles: { dm: ["data_manager"] } });
  as("dm");
  const renamed = response();
  await routes(request("PATCH", "/api/vcr/studies/std_1", { name: "数据管理改名" }), renamed);
  assert.equal(renamed.status, 200);
  for (const body of [{ dataTier: "T3" }, { intendedUse: "submission_preparation" }, { status: "archived" }, { name: "x", status: "paused" }]) {
    const error = await routes(request("PATCH", "/api/vcr/studies/std_1", body), response()).catch((/** @type {any} */ thrown) => thrown);
    assert.equal(error.status, 403, JSON.stringify(body));
    assert.equal(error.code, "vcr_forbidden");
    assert.match(error.message, /manage_study/);
  }
  await assert.rejects(routes(request("DELETE", "/api/vcr/studies/std_1"), response()), { status: 403, code: "vcr_forbidden" });
  assert.deepEqual(calls.filter((call) => call[0] === "update"), [["update", "name"]], "only the rename reached the service");
  as(OWNER);
  const lead = response();
  await routes(request("PATCH", "/api/vcr/studies/std_1", { dataTier: "T1", intendedUse: "design_support" }), lead);
  assert.equal(lead.status, 200);
});

test("a study's page tells the caller what it may do, from the roles it holds now", async () => {
  const { routes, as } = fixture({ roles: { rec: ["recruiter", "viewer"] } });
  const owner = response();
  await routes(request("GET", "/api/vcr/studies/std_1"), owner);
  assert.deepEqual(owner.json().data.roles, ["lead"]);
  assert.ok(owner.json().data.abilities.includes("manage_study") && owner.json().data.abilities.includes("manage_members"));
  as("rec");
  const recruiter = response();
  await routes(request("GET", "/api/vcr/studies/std_1"), recruiter);
  assert.deepEqual(recruiter.json().data.roles, ["recruiter", "viewer"]);
  assert.ok(recruiter.json().data.abilities.includes("contact_patients"));
  assert.equal(recruiter.json().data.abilities.includes("run"), false);
  assert.equal(recruiter.json().data.abilities.includes("manage_study"), false);
});

// ------------------------------------------------------------- members

test("CW-3 members are added and removed through the members service in its own shape, and the owner stays fixed", async () => {
  /** @type {any[]} */
  const seen = [];
  const { routes } = fixture({
    roles: {},
    overrides: {
      members: {
        async add(/** @type {any} */ input) { seen.push(["add", input]); return { studyId: input.studyId, userId: input.userId, role: input.role }; },
        async remove(/** @type {any} */ input) {
          seen.push(["remove", input]);
          if (input.userId === OWNER) throw new HttpError(409, "vcr_member_owner_fixed", "owner");
          return { removed: true };
        },
      },
    },
  });
  const added = response();
  await routes(request("POST", "/api/vcr/studies/std_1/members", { userId: "u_new", role: "site", detail: { siteId: "ste_1", note: "n" } }), added);
  assert.equal(added.status, 201);
  assert.deepEqual(seen[0], ["add", { actor: OWNER, studyId: "std_1", userId: "u_new", role: "site", detail: { siteId: "ste_1", note: "n" } }]);
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/members", { userId: "u_new", role: "site" }), response()),
    { status: 400, code: "vcr_payload_invalid" }, "a site member names its site");
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/members", { userId: "u_new", role: "viewer", detail: { secret: "x" } }), response()),
    { status: 400, code: "vcr_payload_invalid" }, "a membership carries a site and a note and nothing else");

  const removed = response();
  await routes(request("DELETE", "/api/vcr/studies/std_1/members/u_new?role=viewer"), removed);
  assert.deepEqual(removed.json().data, { removed: 1 });
  assert.deepEqual(seen[1], ["remove", { actor: OWNER, studyId: "std_1", userId: "u_new", role: "viewer" }]);
  await assert.rejects(routes(request("DELETE", `/api/vcr/studies/std_1/members/${OWNER}?role=lead`), response()), { status: 409, code: "vcr_member_owner_fixed" });
  await assert.rejects(routes(request("DELETE", "/api/vcr/studies/std_1/members/u_new?role=overlord"), response()), { status: 400, code: "vcr_member_role_invalid" });
});

test("removing a member without naming a role takes every role that account holds in the study", async () => {
  /** @type {string[]} */
  const removedRoles = [];
  const { routes } = fixture({
    roles: { u_two: ["recruiter", "site"] },
    overrides: { members: { async remove(/** @type {any} */ input) { removedRoles.push(input.role); return { removed: true }; } } },
  });
  const res = response();
  await routes(request("DELETE", "/api/vcr/studies/std_1/members/u_two"), res);
  assert.deepEqual(removedRoles.sort(), ["recruiter", "site"]);
  assert.deepEqual(res.json().data, { removed: 2 });
});

// ------------------------------------------------------------- the first human stop

test("PA-11 the contact route audits what happened: a confirmation, a stop that held, and a failure are three lines", async () => {
  const outcomes = [/** @type {any} */ ({ referral: { id: "ref_1", state: "contacted" }, alreadyContacted: false }),
    new HttpError(409, "vcr_referral_transition_invalid", "cannot"), new HttpError(403, "vcr_contact_role_forbidden", "no"),
    new Error("the database went away")];
  /** @type {any[]} */
  const asked = [];
  const { routes, audits } = fixture({
    overrides: { matching: { async contactReferral(/** @type {any} */ user, /** @type {any} */ target, /** @type {string} */ id, /** @type {any} */ input) {
      asked.push([user.id, target.id, id, input]);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next;
    } } },
  });
  const first = response();
  await routes(request("POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", { note: "已核对", reason: "符合" }), first);
  assert.equal(first.status, 200);
  assert.deepEqual(asked[0], [OWNER, "std_1", "ref_1", { note: "已核对", reason: "符合" }], "the caller is the session's account; the body carries a note and a reason and nothing else");
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", {}), response()), { status: 409 });
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", {}), response()), { status: 403 });
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", {}), response()), { message: "the database went away" });
  assert.deepEqual(audits.filter((entry) => entry[0] === "vcr.referral.contact").map((entry) => [entry[1], entry[2]]), [
    ["completed", "ref_1"], ["refused", "vcr_referral_transition_invalid"], ["refused", "vcr_contact_role_forbidden"], ["failed", "Error"],
  ]);
  // The approver is never a field of the request.
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", { approvedBy: "someone-else" }), response()),
    { status: 400, code: "vcr_payload_invalid" });
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", { contactApprovedBy: "someone-else" }), response()),
    { status: 400, code: "vcr_payload_invalid" });
});

// ------------------------------------------------------------- creation

test("CS-49 a study whose row cannot be made takes the project the request made with it", async () => {
  /** @type {string[]} */
  const removed = [];
  const { routes, service } = fixture({
    overrides: {
      projects: {
        async create(/** @type {any} */ _user, /** @type {string} */ name) { return { id: "prj_new", name }; },
        async bindSession() { return { sessionId: "s", bound: true }; },
        async remove(/** @type {any} */ _user, /** @type {string} */ projectId) { removed.push(projectId); return {}; },
      },
    },
  });
  service.createStudy = async (_user, _input, hooks) => {
    await hooks.createResearcherProject(_user, "EV-201");
    throw new Error("the study row failed");
  };
  await assert.rejects(routes(request("POST", "/api/vcr/studies", { name: "EV-201" }), response()), { message: "the study row failed" });
  assert.deepEqual(removed, ["prj_new"], "no project is left in the sidebar that is not a study");

  service.createStudy = async (_user, _input, hooks) => {
    const project = await hooks.createResearcherProject(_user, "EV-202");
    return { id: "std_new", projectId: project.id };
  };
  const created = response();
  await routes(request("POST", "/api/vcr/studies", { name: "EV-202" }), created);
  assert.equal(created.status, 201);
  assert.deepEqual(removed, ["prj_new"], "a study that was made keeps its project");
});

test("CS-3 a model taken from a study is written by someone who may write in that study", async () => {
  const { routes, as, calls } = fixture({ roles: { viewer: ["viewer"], writer: ["data_manager"] } });
  as("viewer");
  await assert.rejects(routes(request("POST", "/api/vcr/models", { studyId: "std_1", name: "m" }), response()), { status: 403, code: "vcr_forbidden" });
  as("writer");
  const res = response();
  await routes(request("POST", "/api/vcr/models", { studyId: "std_1", name: "m" }), res);
  assert.equal(res.status, 201);
  const own = response();
  as("viewer");
  await routes(request("POST", "/api/vcr/models", { name: "my own" }), own);
  assert.equal(own.status, 201, "a model with no study is the account's own");
  assert.deepEqual(calls.filter((call) => call[0] === "adopt").map((call) => call[1]), ["m", "my own"]);
});

test("every code these routes emit is one this module declares", async () => {
  // Only this file's error codes are double-quoted string literals starting
  // `vcr_` (the geoGateway rule): a code reaches a caller either as a literal
  // at a `throw`, or as a literal argument to one of the small validators, so
  // scanning the literals finds both. The declaration itself is cut out first —
  // scanning it too would find every declared code in the declaration and prove
  // nothing. A walk assertion that proves it walked: a scan that found a
  // handful would be reporting a clean file it never read.
  const text = await readFile(new URL("../src/vcrRoutes.mjs", import.meta.url), "utf8");
  const body = text.replace(/export const VCR_ROUTE_ERROR_CODES = Object\.freeze\(\[[\s\S]*?\]\);/, "");
  assert.notEqual(body, text, "the declaration was found and cut out");
  const literals = new Set([...body.matchAll(/"(vcr_[a-z0-9_]+)"/g)].map((match) => match[1]));
  assert.ok(literals.size >= 15, `only ${literals.size} codes were found; the scan did not run`);
  const undeclared = [...literals].filter((code) => !VCR_ROUTE_ERROR_CODES.includes(code)).sort();
  assert.deepEqual(undeclared, [], `emitted but not declared: ${undeclared.join(", ")}`);

  // The declared codes the routes do not raise themselves are raised by the
  // modules behind them — the service's study and tab lookup, the orchestrator's
  // paused study, the matching stop's referral, the store's model insert — and
  // are declared here because this is the list the page reads and the domain's
  // registry takes verbatim. Naming them keeps that true: a declared code that
  // nobody raises is dropped, not left as decoration.
  const fromElsewhere = ["vcr_study_not_found", "vcr_study_paused", "vcr_tab_not_found", "vcr_referral_not_found", "vcr_model_exists", "vcr_export_not_found",
    "vcr_pack_not_found", "vcr_pack_invalid", "vcr_definition_not_found", "vcr_definition_invalid"];
  for (const code of fromElsewhere) assert.ok(VCR_ROUTE_ERROR_CODES.includes(code), code);
  const neverEmitted = VCR_ROUTE_ERROR_CODES.filter((code) => !literals.has(code) && !fromElsewhere.includes(code));
  assert.deepEqual(neverEmitted, [], `declared but never emitted: ${neverEmitted.join(", ")}`);
});

test('public reviews cannot impersonate trusted AI model identity or completion', async () => {
  const { routes } = fixture();
  for (const key of ['reviewerKind', 'model', 'status', 'provenance', 'platformReviewId']) {
    await assert.rejects(routes(request('POST', '/api/vcr/studies/std_1/reviews', { kind: 'clinical', nodes: ['result:res_1@1'], [key]: 'forged' }), response()),
      { status: 400, code: 'vcr_payload_invalid' });
  }
});

// --- an audit line outlives the study: it never carries a file name ------------------

const PATIENT_FILE = "张三-住院病历 2024.pdf";
const UPLOAD_QUERY = `name=${encodeURIComponent(PATIENT_FILE)}&role=document`;
const UPLOAD_URL = `/api/vcr/studies/std_1/data/sources/src_1/files?${UPLOAD_QUERY}`;

test("an upload's audit line says its role, format, size and hash, and never the file's name — completed, refused or failed", async () => {
  const sha256 = "ab".repeat(32);
  const planeWith = (/** @type {() => Promise<any>} */ storeUpload) => ({ ...composedHooks(), dataPlane: { ...composedHooks().dataPlane, storeUpload } });

  const done = fixture({ overrides: planeWith(async () => ({
    created: true, upload: { role: "document", format: "pdf", bytes: 48_213, sha256 },
    // The stored row is the text it was converted to, under a pseudonymous name.
    file: { id: "sfl_9", sourceId: "src_1", name: "document-1a2b3c4d.txt", role: "document", format: "txt", bytes: 9_000, sha256: "cd".repeat(32), detail: {} },
  })) });
  const ok = response();
  await done.routes(request("POST", UPLOAD_URL), ok);
  assert.equal(ok.status, 201);
  const completed = done.auditLines.find((line) => line.event === "vcr.data.file.upload");
  assert.equal(completed.status, "completed");
  assert.equal(completed.code, "sfl_9");
  assert.equal(completed.detail, `document pdf 48213B sha256:${sha256}`, "what was uploaded in this request, not the stored row's text");

  // A re-save of the same text is the file already held: the audit still says what THIS request uploaded, and without `upload` it falls back to the row's own.
  const row = fixture({ overrides: planeWith(async () => ({ created: false,
    file: { id: "sfl_2", name: "document-0000aaaa.txt", role: "document", format: "txt", bytes: 5, sha256: "ef".repeat(32), detail: { original: { format: "docx" }, originalBytes: 777, originalSha256: "12".repeat(32) } } })) });
  await row.routes(request("POST", UPLOAD_URL), response());
  assert.equal(row.auditLines.find((line) => line.event === "vcr.data.file.upload").detail, `document docx 777B sha256:${"12".repeat(32)}`);

  for (const [thrown, status, code] of [[new HttpError(422, "vcr_document_needs_text", "scan"), "refused", "vcr_document_needs_text"], [new Error("boom"), "failed", "Error"]]) {
    const bad = fixture({ overrides: planeWith(async () => { throw thrown; }) });
    await assert.rejects(bad.routes(request("POST", UPLOAD_URL), response()));
    const line = bad.auditLines.find((entry) => entry.event === "vcr.data.file.upload");
    assert.deepEqual([line.status, line.code], [status, code]);
    assert.equal(line.detail, "std_1 document", "the study it was tried on, and the role");
  }

  // Not one audit line of any of them holds the name, any part of it, or its extension typed as a role.
  for (const world of [done, row]) assert.ok(!JSON.stringify(world.auditLines).includes("张三"), JSON.stringify(world.auditLines));
});

test("what a caller typed as a role or a length never reaches an audit line", async () => {
  const { routes, auditLines } = fixture({ overrides: { ...composedHooks(), dataPlane: { ...composedHooks().dataPlane,
    storeUpload: async () => { throw new HttpError(400, "vcr_payload_invalid", "role is one of: data, dictionary, document."); } } } });
  const url = `/api/vcr/studies/std_1/data/sources/src_1/files?name=a.csv&role=${encodeURIComponent("李四的随访")}`;
  await assert.rejects(routes(Object.assign(request("POST", url), { headers: { "content-type": "application/json", "content-length": "2048" } }), response()));
  const line = auditLines.find((entry) => entry.event === "vcr.data.file.upload");
  assert.equal(line.detail, "std_1 other 2048B declared");
  assert.ok(!JSON.stringify(auditLines).includes("李四"));
});

// --- the packs and the library -------------------------------------------------------

test("the account's packs and library are read as the account's own: the search word is passed, an id is one path part, nothing else is a route", async () => {
  /** @type {any[]} */
  const asked = [];
  const knowledge = {
    listPacks: async (/** @type {string} */ userId, /** @type {string} */ q) => { asked.push(["packs", userId, q]); return { packs: [] }; },
    getPack: async (/** @type {string} */ userId, /** @type {string} */ id) => { asked.push(["pack", userId, id]); return { id }; },
    listLibrary: async (/** @type {string} */ userId, /** @type {string} */ q) => { asked.push(["library", userId, q]); return { definitions: [] }; },
    getLibraryDefinition: async (/** @type {string} */ userId, /** @type {string} */ id) => { asked.push(["definition", userId, id]); return { id }; },
  };
  const { routes } = fixture({ overrides: { knowledge } });
  for (const path of ["/api/vcr/packs?q=%E8%82%BA%E7%99%8C", "/api/vcr/packs/nsclc", "/api/vcr/definitions?q=ecog", "/api/vcr/definitions/dfn_1"]) {
    const res = response();
    assert.equal(await routes(request("GET", path), res), true, path);
    assert.equal(res.status, 200, path);
  }
  assert.deepEqual(asked, [["packs", OWNER, "肺癌"], ["pack", OWNER, "nsclc"], ["library", OWNER, "ecog"], ["definition", OWNER, "dfn_1"]]);
  for (const [method, path] of [["POST", "/api/vcr/packs"], ["DELETE", "/api/vcr/definitions/dfn_1"], ["GET", "/api/vcr/packs/nsclc/extra"]]) {
    await assert.rejects(routes(request(method, path, method === "POST" ? {} : undefined), response()), { status: 404 }, `${method} ${path}`);
  }
  // without the package composed, the routes exist and say it is not available here yet
  const bare = fixture();
  await assert.rejects(bare.routes(request("GET", "/api/vcr/packs"), response()), { status: 503, code: "vcr_unavailable" });
  // a name the account does not hold answers 404 by the package's own refusal, not by a shape of the route
  const missing = fixture({ overrides: { knowledge: { ...knowledge, getLibraryDefinition: async () => { throw new HttpError(404, "vcr_definition_not_found", "Definition not found."); } } } });
  await assert.rejects(missing.routes(request("GET", "/api/vcr/definitions/dfn_other"), response()), { status: 404, code: "vcr_definition_not_found" });
});

test("a draft pack is promoted by the study's lead, or by an operator who can see the study; a viewer who is neither is told which ability is missing", async () => {
  /** @type {any[]} */
  const promoted = [];
  const knowledge = { promotePack: async (/** @type {any} */ _study, /** @type {string} */ reviewer) => { promoted.push(reviewer); return { status: "curated", reviewedBy: reviewer }; } };
  const { routes, as, audits } = fixture({ roles: { viewer1: ["viewer"], opr: ["viewer"] }, operators: ["opr"], overrides: { knowledge } });
  as("viewer1");
  await assert.rejects(routes(request("POST", "/api/vcr/studies/std_1/pack/promote", {}), response()), (/** @type {any} */ error) => error.status === 403 && /manage_study/.test(error.message));
  assert.deepEqual(promoted, []);
  as("opr");
  const byOperator = response();
  await routes(request("POST", "/api/vcr/studies/std_1/pack/promote", {}), byOperator);
  assert.equal(byOperator.status, 200);
  as(OWNER);
  await routes(request("POST", "/api/vcr/studies/std_1/pack/promote", {}), response());
  assert.deepEqual(promoted, ["opr", OWNER], "the reviewer is the account that promoted");
  assert.deepEqual(audits.filter((line) => line[0] === "vcr.pack.promote").map((line) => line[1]), ["refused", "completed", "completed"].slice(1));
  // an operator who cannot see the study at all finds nothing
  const outside = fixture({ operators: ["operator-elsewhere"], overrides: { knowledge } });
  outside.as("operator-elsewhere");
  await assert.rejects(outside.routes(request("POST", "/api/vcr/studies/std_1/pack/promote", {}), response()), { status: 404, code: "vcr_study_not_found" });
});

test("a request to save, use or compare a definition is checked before anything is asked of the package", async () => {
  /** @type {any[]} */
  const reached = [];
  const knowledge = {
    saveFromStudy: async () => { reached.push("save"); return { definitionId: "dfn_1", version: 1 }; },
    useInStudy: async () => { reached.push("use"); return { definitionId: "dfn_1", version: 1 }; },
    compareVersions: async () => { reached.push("compare"); return { job: { id: "job_1" }, created: true }; },
  };
  const { routes } = fixture({ overrides: { knowledge } });
  for (const [path, body] of /** @type {Array<[string, any]>} */ ([
    ["/api/vcr/studies/std_1/definitions", { name: "x", text: "t" }],
    ["/api/vcr/studies/std_1/definitions", { populationId: "pop 1", text: "t" }],
    ["/api/vcr/studies/std_1/definitions", { populationId: "pop_1", text: "t", extra: 1 }],
    ["/api/vcr/studies/std_1/definitions/dfn_1/use", { version: 0 }],
    ["/api/vcr/studies/std_1/definitions/dfn_1/use", { columnMap: [] }],
    ["/api/vcr/studies/std_1/definitions/dfn_1/compare", { versionA: 1 }],
    ["/api/vcr/studies/std_1/definitions/dfn_1/compare", { versionA: 1, versionB: 2, covariates: [1] }],
    ["/api/vcr/studies/std_1/pack", { use: "../x" }],
  ])) {
    await assert.rejects(routes(request("POST", path, body), response()), { status: 400, code: "vcr_payload_invalid" }, `${path} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(reached, []);
});
