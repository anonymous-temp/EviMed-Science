import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

test("the actual app delivers a persisted capsule create, activate and recall workflow", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-capsule-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl });
  const username = `capsule${randomUUID().slice(0, 8)}`;
  let user;
  try {
    user = await app.store.createUser(username, "test-only-capsule-password", "Capsule fixture");
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "test-only-capsule-password" }) });
    assert.equal(login.status, 200);
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
    const create = await fetch(`${base}/api/capsules`, { method: "POST", headers, body: JSON.stringify({ title: "Research preferences" }) });
    assert.equal(create.status, 201);
    const capsule = (await create.json()).data;
    const entry = await fetch(`${base}/api/capsules/${capsule.id}/entries`, { method: "POST", headers,
      body: JSON.stringify({ factKind: "method_preference", layer: "methods", content: "Preserve confidence intervals." }) });
    assert.equal(entry.status, 201);
    assert.equal((await fetch(`${base}/api/capsules/${capsule.id}/activate`, { method: "POST", headers, body: JSON.stringify({ mode: "own" }) })).status, 200);
    const recall = await fetch(`${base}/api/capsules/recall`, { method: "POST", headers, body: JSON.stringify({ query: "confidence" }) });
    const recalled = (await recall.json()).data;
    assert.equal(recalled.items.length, 1);
    assert.equal(recalled.items[0].contextOnly, true);
    assert.equal((await fetch(`${base}/api/capsules`)).status, 401);
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
