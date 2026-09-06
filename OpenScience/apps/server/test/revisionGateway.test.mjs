import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import { createRevisionGatewayHandler } from "../src/revisionGateway.mjs";
import { RuntimeManager, issueEviMedWorkloadToken } from "../src/runtimeManager.mjs";

async function withGateway(fn) {
  const project = { id: "project-1", userId: "user-1" };
  let tokenChecks = 0;
  const consumed = [];
  const handler = createRevisionGatewayHandler({
    runtimeManager: {
      async assertActiveEviMedWorkloadToken(token) {
        tokenChecks += 1;
        if (token !== "current-token") throw new Error("invalid token");
        return { userId: "user-1", projectId: "project-1", runtimeGeneration: "runtime-generation-1" };
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
    assert.deepEqual(consumed, [{ ...body, runtimeGeneration: "runtime-generation-1" }]);
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

test("runtime generation survives token rotation and changes when the runtime is replaced", async () => {
  const root = await mkdtemp("/tmp/evimed-revision-generation-");
  try {
    const secret = randomBytes(32).toString("hex");
    const project = { userId: "user-1", id: "project-1" };
    const manager = new RuntimeManager({ evimedWorkloadSigningSecret: secret });
    const tokenFile = `${root}/workload.token`;
    const issue = () => issueEviMedWorkloadToken({ secret, userId: project.userId, projectId: project.id });
    const first = issue();
    await writeFile(tokenFile, first, { mode: 0o600 });
    manager.runtimes.set(manager.key(project), { workloadTokenFile: tokenFile, modelGatewayTokenJti: "runtime-generation-1" });
    assert.equal((await manager.assertActiveEviMedWorkloadToken(first)).runtimeGeneration, "runtime-generation-1");

    const rotated = issue();
    await writeFile(tokenFile, rotated, { mode: 0o600 });
    assert.equal((await manager.assertActiveEviMedWorkloadToken(rotated)).runtimeGeneration, "runtime-generation-1");
    manager.runtimes.set(manager.key(project), { workloadTokenFile: tokenFile, modelGatewayTokenJti: "runtime-generation-2" });
    assert.equal((await manager.assertActiveEviMedWorkloadToken(rotated)).runtimeGeneration, "runtime-generation-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
