import assert from "node:assert/strict";
import test from "node:test";
import { createLearningRoutes, methodView } from "../src/learningRoutes.mjs";

// The view the memory page reads. Since 2026-09-20 a learned method takes
// effect the night it is learned, so the row says what it does and since when
// rather than what it is still waiting for — the page used to print 「还差：成功
// 用到它的任务还不够…」 under every method, describing a gate that under stock
// configuration never opened.
const document = (payload) => ({
  id: "method-1", projectId: null, revision: 1, createdAt: "2026-09-16T08:00:00.000Z", updatedAt: "2026-09-16T08:00:00.000Z",
  payload: { frontmatter: { name: "证据分层", description: "先分层" }, body: "## 步骤", contentDigest: "sha256:aaa", ...payload },
});

test("a learned method's view lacks nothing, and carries what its row says about itself", () => {
  const view = methodView(document({
    status: "approved", statusChangedAt: "2026-09-16T08:00:00.000Z", provenance: { origin: "inferred" },
    learning: {
      digest: "sha256:aaa", counts: { eligible: 0, loaded: 3, invoked: 0, succeeded: 3, validated: 0, read: 0 },
      observations: [
        { runId: "r1", family: "f1", outcome: "accepted", at: "2026-09-16T08:00:00.000Z" },
        { runId: "r2", family: "f2", outcome: "accepted", at: "2026-09-16T09:00:00.000Z" },
        { runId: "r3", family: "f3", outcome: "accepted", at: "2026-09-16T10:00:00.000Z" },
      ],
      relations: [], evaluations: [], level: 0, lastReadAt: null,
    },
  }));
  assert.equal(view.status, "approved");
  assert.deepEqual(view.promotion.missing, []);
  assert.deepEqual(view.promotion.missingDetails, []);
  assert.equal(view.statusChangedAt, "2026-09-16T08:00:00.000Z", "what 「新」 and 「…起生效」 are read from");
  assert.equal(view.trajectories, 3, "the checkable half of 「从你的 3 次研究学到」");
});

test("a conflict is the one thing a view still reports as missing", () => {
  const view = methodView(document({
    status: "candidate", provenance: { origin: "inferred" },
    learning: {
      digest: "sha256:aaa", counts: { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 },
      observations: [],
      relations: [{ type: "conflicts_with", target: "另一条方法", evidence: "相反要求", proposedBy: "consolidate:job_1" }],
      evaluations: [], level: 0, lastReadAt: null,
    },
  }));
  assert.deepEqual(view.promotion.missingDetails.map((detail) => detail.code), ["conflicts"]);
  assert.equal(view.trajectories, 0);
});

test("a method the researcher wrote lacks nothing and says why", () => {
  const view = methodView(document({ status: "approved", provenance: { origin: "explicit" } }));
  assert.deepEqual(view.promotion.missing, []);
  assert.deepEqual(view.promotion.missingDetails, []);
  assert.match(view.promotion.reasons.join(" "), /explicit origin/);
});

test("the view says which body a method is on, where it was learnt, its steps for that body, and a reason in the reader's words", () => {
  // Audit 2026-09-26: 「更新为第 77 版」 for a method with two bodies (L-G4), the
  // English SKILL.md when opened (M-5), and an English reason naming a
  // retirement mechanism that no longer exists (L-G8).
  const view = methodView({ ...document({
    status: "approved", provenance: { origin: "inferred", sourceProjectId: "meta" }, bodyVersion: 2,
    bodyUpdatedAt: "2026-09-22T00:00:00.000Z", statusReason: "Retired by the paired evaluation when it measures worse.",
    displaySteps: { text: "1. 先核对编号\n2. 再分开说法", contentDigest: "sha256:aaa" },
  }), revision: 77 });
  assert.equal(view.revision, 77, "the concurrency token, never shown as a version");
  assert.equal(view.version, 2);
  assert.equal(view.bodyUpdatedAt, "2026-09-22T00:00:00.000Z");
  assert.equal(view.projectId, "meta", "where it was learnt; the record itself is the account's");
  assert.equal(view.steps, "1. 先核对编号\n2. 再分开说法");
  assert.equal(view.statusReason, "从你自己的研究里学到，已直接生效；用上它的研究若明显更常被退回，会自动停用，你也可以随时停用。");
  // Steps that render another body are not shown for this one.
  assert.equal(methodView(document({ status: "approved", displaySteps: { text: "1. 旧的", contentDigest: "sha256:old" } })).steps, null);
  // A stopped method keeps the reason it was stopped with.
  assert.equal(methodView(document({ status: "retired", statusReason: "在记忆页里停用" })).statusReason, "在记忆页里停用");
  // A method written before the count existed is on its first body.
  assert.equal(methodView(document({ status: "approved" })).version, 1);
});

/** One GET through the real route handler. @param {any} routes @param {string} url */
async function get(routes, url) {
  /** @type {{status: number, body: any}} */
  const response = { status: 0, body: null };
  const res = { writeHead(/** @type {number} */ status) { response.status = status; }, end(/** @type {string} */ text) { response.body = JSON.parse(text); } };
  const handled = await routes({ url, method: "GET", headers: {} }, res);
  assert.equal(handled, true);
  return response;
}

test("the list carries the loop's own counts for the account, and a method's history is its bodies", async () => {
  /** @type {string[]} */
  const summarised = [];
  const routes = createLearningRoutes({
    store: { async ensureSessionUser() { return { user: { id: "u1" } }; }, async assertCsrf() {} },
    maxJsonBytes: 10_000,
    service: {
      async listMethods() { return { items: [document({ status: "approved" })], nextCursor: null }; },
      async history(/** @type {string} */ userId, /** @type {string} */ methodId) {
        return [{ version: 2, revision: 27, contentDigest: "sha256:b", at: "2026-09-22T00:00:00.000Z", title: null, current: true, userId, methodId }];
      },
    },
    summary: async (userId) => { summarised.push(userId); return { methods: { approved: 1, candidate: 0, retired: 0 } }; },
  });
  const listed = await get(routes, "/api/methods");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.items.length, 1);
  assert.deepEqual(listed.body.data.summary, { methods: { approved: 1, candidate: 0, retired: 0 } });
  assert.deepEqual(summarised, ["u1"]);
  const next = await get(routes, "/api/methods?cursor=abc");
  assert.equal(next.body.data.summary, undefined, "once, on the first page");

  const history = await get(routes, `/api/methods/${encodeURIComponent("method:learned:x")}/history`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.data.items.map((/** @type {any} */ item) => [item.version, item.methodId]), [[2, "method:learned:x"]]);

  // A summary that cannot be read costs the summary, never the list.
  const failing = createLearningRoutes({
    store: { async ensureSessionUser() { return { user: { id: "u1" } }; }, async assertCsrf() {} },
    maxJsonBytes: 10_000,
    service: { async listMethods() { return { items: [], nextCursor: null }; } },
    summary: async () => { throw new Error("down"); },
  });
  const degraded = await get(failing, "/api/methods");
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.data.summary, undefined);
});
