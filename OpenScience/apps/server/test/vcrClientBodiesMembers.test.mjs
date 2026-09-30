// The members dialog's and the matching tab's write bodies, posted to the REAL
// `createVcrRoutes` — the same arrangement as `vcrClientBodies.test.mjs`, for
// the writes that file was written before: a member added with the site it
// belongs to, a role removed through `?role=`, a referral moved to 待补证, and
// the composer's 起点, a model adopted from the library page, and the two acts
// a person does on a matching assessment (re-judging a rule, countersigning).
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createVcrRoutes } from "../src/vcrRoutes.mjs";
import { assessmentReviewBody, judgmentBody, memberBody, modelBody, studyPatchBody, transitionBody } from "../../web/src/lib/vcrBodies.ts";

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
  };
}

const OWNER = "owner";
const study = { id: "std_1", userId: OWNER, projectId: "prj_1", name: "EV-201", dataTier: "T0", intendedUse: "exploratory", status: "active", budget: {}, steps: {} };
const config = { vcrEnabled: true, vcrAudience: "all", operatorUsers: [], vcrPreviewUsers: [] };

function harness() {
  const seen = /** @type {any[]} */ ([]);
  const vcrStore = { async rolesOf() { return ["lead"]; }, async members() { return []; } };
  const service = {
    allows: () => true, isOperator: () => false, store: vcrStore,
    async requireStudy() { return study; },
    async updateStudy(/** @type {any} */ _user, /** @type {string} */ _id, /** @type {any} */ patch) { seen.push(["patch", patch]); return { ...study, ...patch }; },
    async adoptModel(/** @type {any} */ _user, /** @type {any} */ input) { seen.push(["adopt", input]); return { id: "mdl_1", name: input.name }; },
    async modelLibrary() { return { models: [], methods: [] }; },
  };
  const routes = createVcrRoutes({
    store: /** @type {any} */ ({ async ensureSessionUser() { return { user: { id: OWNER } }; }, async assertCsrf() {} }),
    vcrStore, service, config, maxJsonBytes: 65_536,
    members: {
      async add(/** @type {any} */ input) { seen.push(["add", input.userId, input.role, input.detail]); return { userId: input.userId, role: input.role }; },
      async remove(/** @type {any} */ input) { seen.push(["remove", input.userId, input.role]); return { removed: true }; },
    },
    assessments: {
      async overrideJudgment(/** @type {any} */ _user, /** @type {any} */ _study, /** @type {any} */ input) { seen.push(["override", input.assessmentId, input.criterionId, input.state, input.note]); return { overrideState: input.state }; },
      async reviewAssessment(/** @type {any} */ _user, /** @type {any} */ _study, /** @type {any} */ input) { seen.push(["review", input.assessmentId]); return { id: input.assessmentId }; },
    },
    matching: {
      async listReferrals() { seen.push(["referrals"]); return { referrals: [] }; },
      async transitionReferral(/** @type {any} */ _user, /** @type {any} */ _study, /** @type {string} */ id, /** @type {any} */ body) {
        seen.push(["transition", id, body]); return { referral: { id, state: body.to }, notices: [] };
      },
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

const ok = (/** @type {{ status: number, code: string | null, message: string }} */ answer, /** @type {string} */ what) =>
  assert.ok(answer.status >= 200 && answer.status < 300, `${what}: ${answer.status} ${answer.code ?? ""} ${answer.message}`);

test("a member is added with exactly { userId, role }, and a site member with the site it belongs to", async () => {
  const { send, seen } = harness();
  ok(await send("POST", "/api/vcr/studies/std_1/members", memberBody({ userId: "u_stat", role: "statistical_reviewer" })), "a reviewer");
  ok(await send("POST", "/api/vcr/studies/std_1/members", memberBody({ userId: "u_site", role: "site", detail: { siteId: "ste_01" } })), "a site member");
  assert.deepEqual(seen, [["add", "u_stat", "statistical_reviewer", {}], ["add", "u_site", "site", { siteId: "ste_01" }]]);
  assert.deepEqual(memberBody({ userId: "u", role: "recruiter" }), { userId: "u", role: "recruiter" }, "no detail key when there is nothing to say");
});

test("a site member with no site is what the route refuses, so the dialog cannot send one", async () => {
  const { send } = harness();
  const answer = await send("POST", "/api/vcr/studies/std_1/members", memberBody({ userId: "u_site", role: "site" }));
  assert.equal(answer.status, 400);
  assert.equal(answer.code, "vcr_payload_invalid");
});

test("one role of one account is removed through DELETE …/members/:userId?role=", async () => {
  const { send, seen } = harness();
  ok(await send("DELETE", "/api/vcr/studies/std_1/members/u_stat?role=statistical_reviewer"), "remove one role");
  assert.deepEqual(seen, [["remove", "u_stat", "statistical_reviewer"]]);
  const refused = await send("DELETE", "/api/vcr/studies/std_1/members/u_stat?role=owner");
  assert.equal(refused.code, "vcr_member_role_invalid");
});

test("the referral moves to 待补证 with the note, and the body is exactly the route's allow-list", async () => {
  const { send, seen } = harness();
  const body = transitionBody({ to: "needs_evidence", note: "E1 申请近 4 周头颅 MRI" });
  assert.deepEqual(body, { to: "needs_evidence", note: "E1 申请近 4 周头颅 MRI" });
  ok(await send("POST", "/api/vcr/studies/std_1/referrals/ref_1/transition", body), "request evidence");
  assert.deepEqual(seen, [["transition", "ref_1", { to: "needs_evidence", note: "E1 申请近 4 周头颅 MRI" }]]);
});

test("the composer's 起点 is accepted by PATCH /studies/:id", async () => {
  const { send, seen } = harness();
  ok(await send("PATCH", "/api/vcr/studies/std_1", studyPatchBody({ action: "trial" })), "起点");
  assert.deepEqual(seen, [["patch", { action: "trial" }]]);
});

test("a model adopted from the library page is exactly the route's allow-list, and names neither a tier nor a population", async () => {
  const { send, seen } = harness();
  const body = modelBody({ name: "  EV-201 对照组 PFS 模型 ", version: "2.1.0", risk: "medium", endpointType: "time_to_event", sources: [" NCT02296125 ", "", "CTR20990001"] });
  assert.deepEqual(body, { name: "EV-201 对照组 PFS 模型", version: "2.1.0", risk: "medium", endpointType: "time_to_event", sources: ["NCT02296125", "CTR20990001"] });
  ok(await send("POST", "/api/vcr/models", body), "adopt a model");
  assert.equal(seen[0][0], "adopt");
  assert.deepEqual(Object.keys(modelBody({ name: "m" })), ["name"], "nothing is sent that nobody set");
  ok(await send("POST", "/api/vcr/models", modelBody({ name: "m" })), "a bare name");
  // A tier or a population is the server's to write; the route refuses one that is sent.
  const refused = await send("POST", "/api/vcr/models", { name: "m", tier: "validated" });
  assert.equal(refused.status, 400);
  assert.equal(refused.code, "vcr_payload_invalid");
});

test("a person's re-judgment and countersignature are the routes' own bodies", async () => {
  const { send, seen } = harness();
  const body = judgmentBody({ state: "not_satisfied", note: "  病历写明有脑转移 " });
  assert.deepEqual(body, { state: "not_satisfied", note: "病历写明有脑转移" });
  ok(await send("POST", "/api/vcr/studies/std_1/assessments/asm_1/judgments/crt_2/override", body), "override");
  ok(await send("POST", "/api/vcr/studies/std_1/assessments/asm_1/judgments/crt_2/override", judgmentBody({ state: "unknown", note: " " })), "override without grounds");
  ok(await send("POST", "/api/vcr/studies/std_1/assessments/asm_1/review", assessmentReviewBody()), "review");
  assert.deepEqual(seen, [["override", "asm_1", "crt_2", "not_satisfied", "病历写明有脑转移"], ["override", "asm_1", "crt_2", "unknown", ""], ["review", "asm_1"]]);
  assert.deepEqual(Object.keys(judgmentBody({ state: "unknown" })), ["state"]);
});

test("the referral ledger is read from GET …/referrals, with the state filter the client can ask for", async () => {
  const { send, seen } = harness();
  ok(await send("GET", "/api/vcr/studies/std_1/referrals"), "the ledger");
  ok(await send("GET", "/api/vcr/studies/std_1/referrals?state=contactable"), "the ledger, one state");
  assert.deepEqual(seen, [["referrals"], ["referrals"]]);
});
