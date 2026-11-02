/**
 * The data-analysis API's own projects, in the real app on a real database: an analysis made through the API is hidden from
 * the person's lists and outside their project ceiling, its inputs are preserved, and `DELETE /analyses/{id}` takes the
 * project, its records and its preserved bytes through the same teardown as `DELETE /api/projects/:id`; an account's deletion
 * takes the bytes of every analysis it kept (REVIEWFIX2 6).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { analysisAccountRoot, analysisSnapshotRoot } from "../src/dataAnalysisArtifacts.mjs";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 60_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const exists = (file) => access(file).then(() => true, () => false);

test("an analysis made through the API is outside the person's projects, is deleted whole by the API, and goes with the account", options, async (t) => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-data-analysis-app-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl, dataAnalysisApiEnabled: true, dataAnalysisMaxPerAccount: 2, maxProjectsPerUser: 2, runTitlesEnabled: false,
  });
  const username = `analysis${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = "test-only-analysis-password";
  const user = await app.store.createUser(username, password, "Analysis fixture");
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  let deleted = false;
  t.after(async () => {
    if (!deleted) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  const session = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": (await login.json()).data.csrfToken };
  const minted = await fetch(`${base}/api/agent-keys`, { method: "POST", headers: session, body: JSON.stringify({ name: "Analysis", scopes: ["analysis.read", "analysis.write"] }) });
  assert.equal(minted.status, 201);
  const key = (await minted.json()).data.key;
  const api = (route, { method = "GET", body } = {}) => fetch(`${base}/api/data-analysis/v1${route}`, {
    method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const first = (await (await api("/analyses", { method: "POST", body: { name: "A", requestId: "a" } })).json()).data;
  const second = (await (await api("/analyses", { method: "POST", body: { name: "B", requestId: "b" } })).json()).data;
  const uploaded = await fetch(`${base}/api/data-analysis/v1/analyses/${first.id}/inputs?filename=data.csv`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/octet-stream" }, body: "x,y\n1,2\n",
  });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const preserved = analysisSnapshotRoot({ dataDir }, user.id, first.id);
  assert.equal(await exists(preserved), true, "the input's bytes are preserved outside the project");

  // The person's own lists and ceiling do not see them: two analyses are kept, and two ordinary projects can still be made.
  const listed = (await (await fetch(`${base}/api/projects`, { headers: session })).json()).data.map((item) => item.id);
  assert.ok(!listed.includes(first.projectId) && !listed.includes(second.projectId), listed.join(","));
  assert.equal((await fetch(`${base}/api/projects`, { method: "POST", headers: session, body: JSON.stringify({ name: "Mine" }) })).status, 200);

  // Their own count is the analyses' cap.
  const refused = await api("/analyses", { method: "POST", body: { name: "C", requestId: "c" } });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "analysis_limit_reached");

  // Deleting one takes its project, its records and its preserved bytes, and nothing of the other.
  const removed = await api(`/analyses/${first.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.deepEqual((await removed.json()).data, { id: first.id, deleted: true });
  assert.equal((await api(`/analyses/${first.id}`)).status, 404);
  assert.equal(await exists(preserved), false);
  await assert.rejects(app.store.requireProject(user, first.projectId), { code: "project_not_found" });
  assert.equal((await api(`/analyses/${second.id}`)).status, 200);
  assert.equal((await api("/analyses", { method: "POST", body: { name: "C", requestId: "c" } })).status, 201, "a deleted analysis frees one");
  assert.equal((await api(`/analyses/${first.id}`, { method: "DELETE" })).status, 404);

  // The account's deletion takes what is left of the preserved bytes, which no project directory holds.
  const kept = analysisSnapshotRoot({ dataDir }, user.id, second.id);
  assert.equal(await exists(analysisAccountRoot({ dataDir }, user.id)), true);
  const gone = await fetch(`${base}/api/account`, { method: "DELETE", headers: session, body: JSON.stringify({ confirm: user.id, password }) });
  assert.equal(gone.status, 200, await gone.clone().text());
  deleted = true;
  assert.equal(await exists(analysisAccountRoot({ dataDir }, user.id)), false);
  assert.equal(await exists(kept), false);
});
