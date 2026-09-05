import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";

test("the real app exposes an account-scoped inbox decision journey", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-inbox-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl, memOsEngineUrl: "", requireMemoryIndex: false });
  const username = `inbox${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    user = await app.store.createUser(username, "test-only-inbox-password", "Inbox fixture");
    const item = await app.notificationService.create(user.id, { noticeType: "review", title: "Review evidence",
      body: "Choose whether to keep this candidate.", actions: [{ id: "adopt", label: "Adopt" }] });
    const address = await app.listen(0, "127.0.0.1");
    listening = true;
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "test-only-inbox-password" }) });
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0],
      "x-open-science-csrf": auth.data.csrfToken };
    const inbox = await fetch(`${base}/api/inbox?unresolved=true`, { headers });
    assert.equal(inbox.status, 200);
    assert.deepEqual((await inbox.json()).data.items.map((entry) => entry.id), [item.id]);
    const resolved = await fetch(`${base}/api/inbox/${item.id}/resolve`, { method: "POST", headers,
      body: JSON.stringify({ actionId: "adopt", expectedRevision: item.revision }) });
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).data.resolution.actionId, "adopt");
    assert.equal((await fetch(`${base}/api/inbox`)).status, 401);
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    if (listening) await app.close();
    else await app.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
