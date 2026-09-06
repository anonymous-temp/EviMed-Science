import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createRevisionGatewayHandler } from "../src/revisionGateway.mjs";

async function withGateway(fn) {
  const project = { id: "project-1", userId: "user-1" };
  let tokenChecks = 0;
  const consumed = [];
  const handler = createRevisionGatewayHandler({
    runtimeManager: {
      async assertActiveEviMedWorkloadToken(token) {
        tokenChecks += 1;
        if (token !== "current-token") throw new Error("invalid token");
        return { userId: "user-1", projectId: "project-1" };
      },
    },
    store: {
      async userById(id) { return id === "user-1" ? { id } : null; },
      async requireProject(_user, id) { assert.equal(id, "project-1"); return project; },
    },
    agentRuns: {
      async consumeRepairAuthorization(actualProject, body) {
        assert.equal(actualProject, project);
        consumed.push(body);
        return { authorized: true };
      },
    },
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try { await fn({ base, consumed, tokenChecks: () => tokenChecks }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("the internal revision gateway consumes only the active workload's bound authorization", async () => {
  await withGateway(async ({ base, consumed, tokenChecks }) => {
    const body = { runId: "kernel-run-1", deliverableId: "review", acceptedDigest: "a".repeat(64) };
    const response = await fetch(`${base}/internal/revisions/v1/authorize`, {
      method: "POST",
      headers: { authorization: "Bearer current-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authorized: true });
    assert.deepEqual(consumed, [body]);
    assert.equal(tokenChecks(), 2, "runtime identity must be revalidated after the request body is read");
  });
});

test("the revision gateway rejects caller-selected ownership and inactive credentials", async () => {
  await withGateway(async ({ base, consumed }) => {
    const invalidBody = await fetch(`${base}/internal/revisions/v1/authorize`, {
      method: "POST",
      headers: { authorization: "Bearer current-token", "content-type": "application/json" },
      body: JSON.stringify({ runId: "kernel-run-1", deliverableId: "review", acceptedDigest: "a".repeat(64), projectId: "other" }),
    });
    assert.equal(invalidBody.status, 400);
    const inactive = await fetch(`${base}/internal/revisions/v1/authorize`, {
      method: "POST",
      headers: { authorization: "Bearer old-token", "content-type": "application/json" },
      body: JSON.stringify({ runId: "kernel-run-1", deliverableId: "review", acceptedDigest: "a".repeat(64) }),
    });
    assert.equal(inactive.status, 401);
    assert.deepEqual(consumed, []);
  });
});
