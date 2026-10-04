// A refused workload token says why, in a counter, and the refusal is unchanged.
//
// 53 refusals in the first week of 0.1.7 (2026-09-28..10-04) arrived as one code
// and one 401 whatever the cause, and could not be told apart afterwards: a token
// superseded by a rewrite while its request was in flight, a runtime already going
// down, a forged token. The check is exactly as strict as before — only the
// reason is counted, never the token.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeManager, issueEviMedWorkloadToken } from "../src/runtimeManager.mjs";

const secret = "workload-signing-secret-of-at-least-32-bytes";
const mint = (jti, over = {}) => issueEviMedWorkloadToken({ secret, userId: "u1", projectId: "p1", nowSeconds: Math.floor(Date.now() / 1000), ttlSeconds: 300, jti, ...over });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "os-workload-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "evimed-workload.token");
  const manager = new RuntimeManager({ evimedWorkloadSigningSecret: secret, runtimeProvider: "docker", runtimeMode: "kernel" });
  const runtime = { workloadTokenFile: file, closedByManager: false, exitedAt: null, modelGatewayTokenJti: "jwt_runtime" };
  manager.runtimes.set("u1:p1", runtime);
  return { manager, runtime, file, rewrite: (token) => writeFile(file, `${token}\n`, { mode: 0o600 }) };
}

const refused = (manager, token) => manager.assertActiveEviMedWorkloadToken(token).then(() => null, (error) => ({ status: error.status, code: error.code }));

test("the token the file holds is accepted, and nothing is counted", async (t) => {
  const { manager, rewrite } = await fixture(t);
  const current = mint("jwt_a");
  await rewrite(current);
  const accepted = await manager.assertActiveEviMedWorkloadToken(current);
  assert.equal(accepted.runtimeGeneration, "jwt_runtime");
  assert.deepEqual(manager.statsAll().workloadTokenRefusals, { token: 0, runtime: 0, superseded: 0, unreadable: 0 });
});

test("a valid token superseded by a rewrite is refused as strictly as ever, and counted as superseded", async (t) => {
  const { manager, rewrite } = await fixture(t);
  const first = mint("jwt_a");
  await rewrite(first);
  await manager.assertActiveEviMedWorkloadToken(first);
  await rewrite(mint("jwt_b"));
  // Authentication is unchanged: the previous token, still signed and unexpired, is not the current one.
  assert.deepEqual(await refused(manager, first), { status: 401, code: "evimed_workload_token_invalid" });
  assert.equal(manager.workloadTokenRefusals.superseded, 1);
});

test("a token for a runtime this process does not hold, or one going down, is counted as the runtime", async (t) => {
  const { manager, runtime, rewrite } = await fixture(t);
  const current = mint("jwt_a");
  await rewrite(current);
  assert.deepEqual(await refused(manager, mint("jwt_x", { projectId: "other" })), { status: 401, code: "evimed_workload_token_invalid" });
  runtime.closedByManager = true;
  assert.deepEqual(await refused(manager, current), { status: 401, code: "evimed_workload_token_invalid" });
  assert.equal(manager.workloadTokenRefusals.runtime, 2);
  assert.equal(manager.workloadTokenRefusals.superseded, 0);
});

test("a forged, malformed or expired token is counted as the token, and an unreadable file as unreadable", async (t) => {
  const { manager, file, rewrite } = await fixture(t);
  const current = mint("jwt_a");
  await rewrite(current);
  const forged = `${current.slice(0, -4)}AAAA`;
  for (const bad of [forged, "not-a-token", 42, mint("jwt_old", { nowSeconds: 1_000 })]) {
    assert.deepEqual(await refused(manager, bad), { status: 401, code: "evimed_workload_token_invalid" }, String(bad));
  }
  assert.equal(manager.workloadTokenRefusals.token, 4);
  await rm(file);
  assert.deepEqual(await refused(manager, current), { status: 401, code: "evimed_workload_token_invalid" });
  assert.equal(manager.workloadTokenRefusals.unreadable, 1);
});
