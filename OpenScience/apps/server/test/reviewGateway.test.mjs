// The review gateway: the workload token names the project, fields are an
// allowlist, and the three operations do what they say (reviewGateway.mjs).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createReviewGatewayHandler } from "../src/reviewGateway.mjs";

/** @param {{ enabled?: boolean, service?: any }} [options] */
async function gateway({ enabled = true, service = null } = {}) {
  /** @type {any[]} */
  const calls = [];
  const fake = service ?? {
    enabled: true,
    async startDeliverableReview(/** @type {any} */ owner, /** @type {any} */ input) { calls.push(["start", owner, input]); return { reviewId: "rv_0123456789abcdef01234567", status: "running" }; },
    async reviewStatus(/** @type {any} */ owner, /** @type {string} */ id) { calls.push(["status", owner, id]); return id === "rv_0123456789abcdef01234567" ? { reviewId: id, status: "done", findings: [] } : null; },
    async recordResponses(/** @type {any} */ owner, /** @type {any} */ body) { calls.push(["responses", owner, body]); return { recorded: 1, refused: [] }; },
  };
  /** @type {any[]} */
  const failures = [];
  const handler = createReviewGatewayHandler({
    runtimeManager: {
      async assertActiveEviMedWorkloadToken(/** @type {string} */ token) {
        if (token !== "good-token") throw new Error("inactive");
        return { userId: "u1", projectId: "p1", runtimeGeneration: "g1" };
      },
    },
    service: fake,
    config: { reviewEnabled: enabled },
  });
  const server = createServer((req, res) => { void handler(req, res, (failure) => failures.push(failure)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  /** @param {string} method @param {string} path @param {any} [body] @param {string} [token] */
  const request = async (method, path, body, token = "good-token") => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { calls, failures, request, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

test("a review is started, asked after and answered, all under the token's own project", async () => {
  const g = await gateway();
  try {
    const started = await g.request("POST", "/internal/review/v1/deliverables", {
      deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis",
      runId: "native_abc", sessionId: "s1", attempt: 2, acceptance: ["写明检索日期"],
    });
    assert.equal(started.status, 202);
    assert.equal(started.body.reviewId, "rv_0123456789abcdef01234567");
    assert.deepEqual(g.calls[0][1], { userId: "u1", projectId: "p1" }, "the project is the token's, never the body's");
    assert.equal(g.calls[0][2].attempt, 2);
    const state = await g.request("GET", "/internal/review/v1/deliverables/rv_0123456789abcdef01234567");
    assert.equal(state.status, 200);
    assert.equal(state.body.status, "done");
    const answered = await g.request("POST", "/internal/review/v1/responses", { reviewId: "rv_0123456789abcdef01234567", answers: [{ id: "F01", response: "fixed" }] });
    assert.deepEqual(answered.body, { recorded: 1, refused: [] });
  } finally {
    await g.close();
  }
});

test("what the gateway refuses, it refuses by name", async () => {
  const g = await gateway();
  try {
    assert.equal((await g.request("POST", "/internal/review/v1/deliverables", { deliverableId: "d1", contractKind: "clinical-evidence-report" }, "bad")).body.error.code, "evimed_workload_token_invalid");
    assert.equal((await g.request("POST", "/internal/review/v1/deliverables", { deliverableId: "d1", contractKind: "clinical-evidence-report", projectId: "someone-else" })).body.error.code, "review_request_invalid",
      "a field outside the allowlist is refused, not ignored");
    assert.equal((await g.request("POST", "/internal/review/v1/deliverables", { deliverableId: "../etc", contractKind: "clinical-evidence-report" })).body.error.code, "review_request_invalid");
    assert.equal((await g.request("POST", "/internal/review/v1/deliverables", { deliverableId: "d1", contractKind: "poem" })).body.error.code, "review_request_invalid");
    assert.equal((await g.request("POST", "/internal/review/v1/deliverables", { deliverableId: "d1", contractKind: "clinical-evidence-report", acceptance: Array(11).fill("x") })).body.error.code, "review_request_invalid");
    assert.equal((await g.request("GET", "/internal/review/v1/deliverables/rv_ffffffffffffffffffffffff")).status, 404);
    assert.equal((await g.request("GET", "/internal/review/v1/deliverables/not-an-id")).body.error.code, "review_not_found");
    assert.equal((await g.request("GET", "/internal/review/v1/other")).status, 404);
    assert.equal(g.calls.filter((entry) => entry[0] === "start").length, 0, "nothing refused reached the service");
  } finally {
    await g.close();
  }
});

test("off is one answer, whoever asks", async () => {
  const g = await gateway({ enabled: false });
  try {
    const refused = await g.request("POST", "/internal/review/v1/deliverables", { deliverableId: "d1", contractKind: "clinical-evidence-report" });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, "review_disabled");
  } finally {
    await g.close();
  }
});
