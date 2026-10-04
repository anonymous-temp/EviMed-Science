// Every write body the browser builds is exactly a route's allow-list.
//
// `apps/web/src/lib/vcrBodies.ts` builds the JSON the client posts; this test
// posts each builder's output to the REAL `createVcrRoutes` and asserts the
// route accepted it. Until the review of 2026-09-29 the budget dialog sent
// `{ limitCny }` to a route that takes `{ cpuSeconds, jobId }`, the decision
// card sent `goal` where the route reads `question`, the review call sent
// `subject` where it reads `nodes` — and every one of those buttons answered
// 400 `vcr_payload_invalid` in a browser while the web tests, which mocked the
// client, stayed green. Here nothing is mocked between the builder and the
// route's own validation; only what happens AFTER validation (the hooks) is a
// stub that says yes.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createVcrRoutes } from "../src/vcrRoutes.mjs";
import {
  assessmentBody, assumptionBody, budgetBody, cancelBody, contactBody, decisionBody, definitionCompareBody, definitionSaveBody, definitionUseBody, exportBody,
  jobBody, memberBody, packBindBody, reviewBody, runBody, studyCreateBody, studyPatchBody,
} from "../../web/src/lib/vcrBodies.ts";

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

const OWNER = "owner";
const study = { id: "std_1", userId: OWNER, projectId: "prj_1", name: "EV-201", dataTier: "T0", intendedUse: "exploratory", status: "active", budget: {}, steps: {} };
const config = { vcrEnabled: true, vcrAudience: "all", operatorUsers: [], vcrPreviewUsers: [] };

/** The routes with real validation and hooks that accept whatever survived it. */
function harness() {
  const vcrStore = {
    async rolesOf() { return ["lead"]; },
    async members() { return []; },
    async saveAssumption(/** @type {any} */ input) { return { id: "asm_1", version: 2, key: input.key }; },
    async modelAssessments() { return [{ key: "pfs_projection", modelName: "weibull", modelVersion: "1.2" }]; },
    async saveModelAssessment(/** @type {any} */ input) { return { id: "mia_1", key: input.record.key, version: 2, risk: null, riskRule: null }; },
    async addReview(/** @type {any} */ input) { return { id: "rvw_1", ...input }; },
    async addDecision(/** @type {any} */ input) { return { id: "dec_1", ...input }; },
    async exportRow() { return { id: "exp_1" }; },
  };
  const service = {
    allows: () => true,
    isOperator: () => false,
    store: vcrStore,
    async requireStudy() { return study; },
    async studyView() { return { ...study }; },
    async tab() { return {}; },
    async listStudies() { return { studies: [] }; },
    async createStudy(/** @type {any} */ _user, /** @type {any} */ input) { return { id: "std_2", projectId: "prj_2", name: input.name ?? "x", requested: [], sessionId: null, bound: false }; },
    async updateStudy(/** @type {any} */ _user, /** @type {string} */ _id, /** @type {any} */ patch) { return { ...study, ...patch }; },
    async deleteStudy() { return { id: study.id, projectId: "prj_1", deleted: true }; },
    async modelLibrary() { return { models: [] }; },
    async adoptModel() { return { id: "mdl_1" }; },
    async precedents() { return { precedents: [] }; },
  };
  const seen = /** @type {any[]} */ ([]);
  const routes = createVcrRoutes({
    store: /** @type {any} */ ({ async ensureSessionUser() { return { user: { id: OWNER } }; }, async assertCsrf() {} }),
    vcrStore, service, config, maxJsonBytes: 65_536,
    projects: { create: async () => ({ id: "prj_2", name: "x" }), bindSession: async () => ({ sessionId: "ses_1", bound: true }), latestSessionId: async () => null },
    orchestrator: {
      async runStep() { seen.push("run"); return { sessionId: "ses_1", runId: "run_1" }; },
      async requestExport() { seen.push("export"); return { export: { id: "exp_1" }, sessionId: "ses_1", runId: "run_1" }; },
      async recomputeAfterChange() { return null; },
    },
    jobs: {
      async enqueue(/** @type {any} */ input) { seen.push(["enqueue", input.kind]); return { job: { id: "job_1", state: "queued" }, created: true }; },
      async cancel() { seen.push("cancel"); return { id: "job_1", state: "canceled" }; },
      async confirmBudget(/** @type {any} */ _studyId, /** @type {any} */ input) { seen.push(["budget", input.jobId ?? null, input.cpuSeconds]); return { released: [], budget: null }; },
      async budgetOf() { return null; },
      async get() { return { id: "job_1" }; },
      async listForStudy() { return []; },
    },
    // `VcrMembers.add({ actor, studyId, userId, role })`: one object, as the route calls it.
    members: {
      async add(/** @type {any} */ input) { seen.push(["member", input.role]); return { userId: input.userId, role: input.role }; },
      async remove() { return { removed: true }; },
    },
    matching: { async contactReferral(/** @type {any} */ _user, /** @type {any} */ _study, /** @type {string} */ id) { seen.push(["contact", id]); return { id, state: "contacted" }; } },
    knowledge: {
      async bindPack(/** @type {any} */ _study, /** @type {string} */ packId) { seen.push(["bind", packId]); return { binding: {}, pack: {} }; },
      async saveFromStudy(/** @type {any} */ _study, /** @type {any} */ input) { seen.push(["save", input.populationId]); return { definitionId: "dfn_1", version: 1 }; },
      async useInStudy(/** @type {any} */ _study, /** @type {any} */ input) { seen.push(["use", input.definitionId]); return { definitionId: input.definitionId, version: 1, populationId: "pop_1", renamed: [], unmatched: [] }; },
      async compareVersions(/** @type {any} */ _study, /** @type {any} */ _user, /** @type {any} */ input) { seen.push(["compare", input.versionA, input.versionB]); return { job: { id: "job_1" }, created: true }; },
    },
  });
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const send = async (method, path, body) => {
    const res = response();
    try {
      await routes(request(method, path, body), res);
    } catch (error) {
      const refused = /** @type {any} */ (error);
      return { status: refused.status ?? 500, code: refused.code ?? null, message: String(refused.message ?? "") };
    }
    return { status: res.status, code: null, message: "" };
  };
  return { send, seen };
}

/** Every case: the route, and what the builder makes of a realistic input. */
const CASES = /** @type {Array<[string, string, string, unknown]>} */ ([
  ["create a study from an action card", "POST", "/api/vcr/studies", studyCreateBody({ action: "cohort" })],
  ["create a study with a name, tier and use", "POST", "/api/vcr/studies", studyCreateBody({ name: "EV-201", dataTier: "T1", intendedUse: "design_support", question: "q" })],
  ["pause a study", "PATCH", "/api/vcr/studies/std_1", studyPatchBody({ status: "paused" })],
  ["rename a study", "PATCH", "/api/vcr/studies/std_1", studyPatchBody({ name: "EV-201 v2" })],
  ["run a step", "POST", "/api/vcr/studies/std_1/run", runBody("population")],
  ["queue a job", "POST", "/api/vcr/studies/std_1/jobs", jobBody({ kind: "design_simulation", scenario: { design: {} }, seed: 5, replicates: 1000, cpuSecondsLimit: 600 })],
  ["cancel a job", "POST", "/api/vcr/studies/std_1/jobs/job_1/cancel", cancelBody()],
  ["confirm one waiting job", "POST", "/api/vcr/studies/std_1/budget", budgetBody({ jobId: "job_1" })],
  ["add CPU time", "POST", "/api/vcr/studies/std_1/budget", budgetBody({ cpuSeconds: 1800 })],
  ["add fractional CPU time (rounded up to a whole second)", "POST", "/api/vcr/studies/std_1/budget", budgetBody({ cpuSeconds: 90.4 })],
  ["write a new assumption version", "POST", "/api/vcr/studies/std_1/assumptions",
    assumptionBody({ key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 4.2, unit: "个月", note: "改为最新汇总" })],
  ["edit a model assessment record, clearing a rating and listing criteria with their reasons", "POST", "/api/vcr/studies/std_1/model-assessments",
    assessmentBody({ key: "pfs_projection", questionOfInterest: "对照组的 PFS 能否用", influence: "", consequence: "high", influenceJustification: "与文献并用",
      technicalCriteria: [{ criterion: "重建 QC 通过", rationale: "" }], outcome: "" })],
  ["countersign a version", "POST", "/api/vcr/studies/std_1/reviews", reviewBody({ kind: "statistical", nodes: ["assumption:control_median_pfs@1"], note: "已核对" })],
  ["record a decision with its goal, choice, alternatives and reason", "POST", "/api/vcr/studies/std_1/decisions",
    decisionBody({ question: "成功把握尽量高、样本量尽量少", chosen: { id: "scn_2", code: "B", label: "方案 B" }, alternatives: [{ code: "A" }], rationale: "折中" })],
  ["request evidence through the decision route", "POST", "/api/vcr/studies/std_1/decisions",
    decisionBody({ question: "请求补证 P-0192：申请近 4 周头颅 MRI", chosen: { kind: "evidence_request", subject: "P-0192", criteria: ["E1"] }, rationale: "申请近 4 周头颅 MRI" })],
  ["export a package", "POST", "/api/vcr/studies/std_1/export", exportBody("study_package")],
  ["add a member", "POST", "/api/vcr/studies/std_1/members", memberBody({ userId: "u_stat", role: "statistical_reviewer" })],
  ["confirm one contact", "POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", contactBody({ note: "已电话确认", reason: "符合入组" })],
  ["confirm one contact with no note", "POST", "/api/vcr/studies/std_1/referrals/ref_1/contact", contactBody()],
  ["work from a catalogue pack", "POST", "/api/vcr/studies/std_1/pack", packBindBody("nsclc")],
  ["save a population as a new library definition", "POST", "/api/vcr/studies/std_1/definitions",
    definitionSaveBody({ populationId: "pop_1", name: "  成人 ECOG 0-1  ", text: " 年龄不小于 18 岁、ECOG 0 或 1。 " })],
  ["save a population as the next version of a library definition", "POST", "/api/vcr/studies/std_1/definitions",
    definitionSaveBody({ populationId: "pop_1", text: "加上 ECOG 限制。", definitionId: "dfn_1" })],
  ["use a library definition in the study", "POST", "/api/vcr/studies/std_1/definitions/dfn_1/use", definitionUseBody()],
  ["use one version of a library definition with a column renamed", "POST", "/api/vcr/studies/std_1/definitions/dfn_1/use",
    definitionUseBody({ version: 2, name: "本研究的人群", columnMap: { AGE: "age_years" }, snapshotId: "snp_1" })],
  ["compare two versions of a library definition", "POST", "/api/vcr/studies/std_1/definitions/dfn_1/compare", definitionCompareBody({ versionA: 1, versionB: 2 })],
  ["compare two versions on a named dataset and covariates", "POST", "/api/vcr/studies/std_1/definitions/dfn_1/compare",
    definitionCompareBody({ versionA: 1, versionB: 3, snapshotId: "snp_1", covariates: ["age", "ecog"] })],
]);

for (const [name, method, path, body] of CASES) {
  test(`the client's body for 「${name}」 is accepted by ${method} ${path}`, async () => {
    const { send } = harness();
    const answer = await send(method, path, body);
    assert.ok(answer.status >= 200 && answer.status < 300, `${name}: ${answer.status} ${answer.code ?? ""} ${answer.message} — body ${JSON.stringify(body)}`);
  });
}

test("a body carries no key the route does not list — the old shapes are refused, so the harness can see the difference", async () => {
  const { send } = harness();
  // What the browser used to send: each one is a write that never landed.
  for (const [path, body] of /** @type {Array<[string, unknown]>} */ ([
    ["/api/vcr/studies/std_1/budget", { limitCny: 500 }],
    ["/api/vcr/studies/std_1/decisions", { goal: "x", chosen: "scn_2" }],
    ["/api/vcr/studies/std_1/reviews", { kind: "statistical", subject: "assumption:x@1" }],
    ["/api/vcr/studies/std_1/assumptions", { id: "asm_1", value: 4 }],
  ])) {
    const answer = await send("POST", path, body);
    assert.equal(answer.status, 400, `${path} ${JSON.stringify(body)}`);
  }
});

test("the budget body is one of two exact shapes and a job id is never sent with CPU time", () => {
  assert.deepEqual(budgetBody({ jobId: "job_1" }), { jobId: "job_1" });
  assert.deepEqual(budgetBody({ cpuSeconds: 600 }), { cpuSeconds: 600 });
  assert.deepEqual(Object.keys(budgetBody({ cpuSeconds: 0.2 })), ["cpuSeconds"]);
  assert.equal(budgetBody({ cpuSeconds: 0.2 }).cpuSeconds, 1, "CPU time is a whole number of seconds, at least one");
});

test("a decision body carries the goal as `question`, trimmed, and nothing the route would refuse", () => {
  const body = decisionBody({ question: "  目标  ", rationale: "理由" });
  assert.deepEqual(Object.keys(body).sort(), ["question", "rationale"]);
  assert.equal(body.question, "目标");
});

test("the settings body cannot carry the compute budget", () => {
  const body = studyPatchBody({ name: "x", status: "active", /** @type {any} */ budget: { limitSeconds: 1 } });
  assert.equal("budget" in body, false);
});
