import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { RuntimeManager, issueEviMedWorkloadToken } from "../src/runtimeManager.mjs";
import { createCapsuleGatewayHandler } from "../src/capsuleGateway.mjs";

async function fixture(t) {
  const dir = await mkdtemp("/tmp/evimed-capsule-gateway-");
  const secret = randomBytes(32).toString("hex");
  const project = { userId: "owner", id: "project-one" };
  const manager = new RuntimeManager({ evimedWorkloadSigningSecret: secret });
  const issue = (input = {}) => issueEviMedWorkloadToken({ secret, userId: project.userId, projectId: project.id, ...input });
  const token = issue();
  const tokenFile = `${dir}/workload.token`;
  await writeFile(tokenFile, token, { mode: 0o600 });
  const runtime = { workloadTokenFile: tokenFile };
  manager.runtimes.set(manager.key(project), runtime);
  const calls = [];
  const service = {
    recall: async (userId, input) => { calls.push({ action: "recall", userId, input }); return { items: [], contextOnly: true }; },
    note: async (userId, projectId, input) => { calls.push({ action: "note", userId, projectId, input }); return { status: "candidate" }; },
  };
  let exists = true;
  let authorize;
  const authorized = new Promise((resolve) => { authorize = resolve; });
  const store = { userById: async () => exists ? { id: project.userId } : null,
    requireProject: async (user, id) => { assert.equal(user.id, project.userId); assert.equal(id, project.id); authorize(); return project; } };
  const handler = createCapsuleGatewayHandler({ runtimeManager: manager, store, service });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/internal/capsules/v1`;
  const request = (action, body, credential = token) => fetch(`${base}/${action}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body),
  });
  return { base, authorized, manager, project, runtime, tokenFile, token, issue, calls, request, removeUser: () => { exists = false; } };
}

test("runtime capsule gateway derives identity only from an active signed workload", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("recall", { query: "methods" }, "invalid")).status, 401);
  assert.equal((await f.request("recall", { query: "methods" }, f.issue({ userId: "other" }))).status, 401);
  assert.equal((await f.request("recall", { query: "methods", projectId: "other" })).status, 400);
  const response = await f.request("recall", { query: "methods", factKinds: ["preference"], scope: "all", since: null });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).contextOnly, true);
  assert.equal(f.calls[0].userId, "owner");
  assert.equal(f.calls[0].input.projectId, "project-one");
  assert.deepEqual(f.calls[0].input.factKinds, ["preference"]);
});

test("capsule credentials stop working on expiry, rotation, runtime stop or account deletion", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("recall", { query: "x" }, f.issue({ nowSeconds: Math.floor(Date.now() / 1000) - 400 }))).status, 401);
  const rotated = f.issue();
  await writeFile(f.tokenFile, rotated);
  assert.equal((await f.request("recall", { query: "x" })).status, 401);
  assert.equal((await f.request("recall", { query: "x" }, rotated)).status, 200);
  f.removeUser();
  assert.equal((await f.request("recall", { query: "x" }, rotated)).status, 401);
  f.manager.runtimes.clear();
  await assert.rejects(f.manager.assertActiveEviMedWorkloadToken(rotated), { code: "evimed_workload_token_invalid" });
});

test("runtime notes are review candidates and reject authority fields and oversized input", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("note", { factKind: "preference", content: "Remember methods", origin: "explicit" })).status, 200);
  assert.equal(f.calls[0].input.origin, "inferred");
  assert.equal((await f.request("note", { factKind: "preference", content: "x", status: "approved" })).status, 400);
  assert.equal((await f.request("note", { content: "x".repeat(70000) })).status, 413);
  assert.equal((await f.request("delete", {})).status, 404);
});


test("an authorized slow request is revoked before memory mutation after runtime stop", async (t) => {
  const f = await fixture(t);
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(`${f.base}/note`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode); });
    request.on("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("Request timed out")));
    request.flushHeaders();
  });
  await f.authorized;
  f.manager.runtimes.clear();
  request.end(JSON.stringify({ factKind: "preference", content: "Late unauthorized note" }));
  assert.equal(await response, 401);
  assert.equal(f.calls.length, 0);
});
