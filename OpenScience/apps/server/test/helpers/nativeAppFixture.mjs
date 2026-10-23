// The native memory engine wired into the real app, for the tests of its routes: a stub engine, a local-auth account on PostgreSQL,
// and the logged-in headers. `nativeAppIntegration()` returns the `skip` options and the `fixture` factory.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { OpenVikingClient } from "../../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../../src/openVikingSessions.mjs";
import { migrateResearchMemory } from "../../src/researchMemoryPersistence.mjs";
import { createWebApiApp } from "../../src/server.mjs";
import { startOpenVikingStub } from "./openVikingStub.mjs";

const PASSWORD = "test-only-native-password";

export function nativeAppIntegration() {
  const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
    assert.match(url.pathname, /evimed_test/);
  }
  const options = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

  /** @param {import("node:test").TestContext} t @param {(input: any) => any} [extract] */
  async function fixture(t, extract = undefined) {
    const stub = await startOpenVikingStub(t, extract ? { extract } : {});
    const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
    const openVikingSessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
    const dataDir = await mkdtemp(path.join("/tmp", "evimed-native-app-"));
    const app = createWebApiApp({
      dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
      stateStore: "postgres", requireSharedStateStore: true, databaseUrl, ovNativeMemoryEnabled: true, openVikingSessions,
    });
    await migrateResearchMemory(app.store.database);
    const username = `native${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const user = await app.store.createUser(username, PASSWORD, "Native fixture");
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    t.after(async () => {
      await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
    const engineUser = openVikingSessions.engineUser(user.id);
    return { app, base, headers, user, stub, engineUser, sessions: openVikingSessions, seed: (/** @type {string} */ rel, /** @type {string} */ text, /** @type {any} */ extra) => stub.seedMemory(engineUser, rel, text, extra) };
  }
  return { options, fixture };
}
