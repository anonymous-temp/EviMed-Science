// The external memory API on an account whose memory is the native engine's, through the real app (2026-10-24).
//
// `agentMemoryNative.test.mjs` drives the routes with doubles that count what they were asked. This file runs the same promises with
// nothing doubled but the engine's wire (the in-process OpenViking stub): a real key minted over the session, the real stores, the real
// native memory store. A call an integrator makes with its bearer key reads the engine's files, a forget removes the file from the
// engine and its undo puts it back, and an episode is refused by name before any subject account is made.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { AGENT_KEY_SCOPES } from "../src/agentApiKeys.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PASSWORD = "test-only-agent-native-password";
const API = "/api/agent-memory/v1";

/** @param {import("node:test").TestContext} t */
async function fixture(t) {
  const stub = await startOpenVikingStub(t);
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-agent-native-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl, ovNativeMemoryEnabled: true, openVikingSessions: sessions,
    agentMemoryApiEnabled: true,
  });
  // The fixture's account must not be the one the first migration of a fresh database marks `legacy`.
  await migrateResearchMemory(app.store.database);
  const username = `agentnative${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const user = await app.store.createUser(username, PASSWORD, "Agent native fixture");
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
  const auth = await login.json();
  const session = { "content-type": "application/json", cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "", "x-open-science-csrf": auth.data.csrfToken };
  const minted = await fetch(`${base}/api/agent-keys`, { method: "POST", headers: session,
    body: JSON.stringify({ name: "native integration", scopes: [...AGENT_KEY_SCOPES], subjects: true }) });
  assert.equal(minted.status, 201);
  const key = (await minted.json()).data;
  const bearer = { "content-type": "application/json", authorization: `Bearer ${key.key ?? key.token ?? key.secret}` };
  return { app, base, bearer, user, stub, sessions, engineUser: sessions.engineUser(user.id),
    seed: (/** @type {string} */ rel, /** @type {string} */ text, /** @type {any} */ extra) => stub.seedMemory(sessions.engineUser(user.id), rel, text, extra) };
}

test("a key reads the engine's files as records and as a recall, and says which engine answered", options, async (t) => {
  const { base, bearer, seed } = await fixture(t);
  seed("preferences/citation.md", "Use AMA citations for every reference.", { type: "preferences" });
  seed("preferences/units.md", "Metric units only.", { type: "preferences" });

  const listed = await fetch(`${base}${API}/records`, { headers: bearer });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("x-memory-engine"), "native");
  const items = (await listed.json()).data;
  assert.equal(items.length, 2, JSON.stringify(items));
  assert.ok(items.every((item) => item.engine === "native"), "every row is a file of the engine");

  const recalled = await fetch(`${base}${API}/recall`, { method: "POST", headers: bearer, body: JSON.stringify({ query: "AMA citations", methods: "none" }) });
  assert.equal(recalled.status, 200);
  const found = (await recalled.json()).data;
  assert.ok(found.items.some((item) => /AMA citations/.test(item.content ?? item.text ?? "")), JSON.stringify(found.items));
  assert.equal(found.engine, "native");
});

test("a forget through the key removes the file from the engine, and the undo it names puts the file back", options, async (t) => {
  const { base, bearer, user, sessions, seed } = await fixture(t);
  const uri = seed("preferences/citation.md", "Use AMA citations for every reference.", { type: "preferences" });
  const [record] = (await (await fetch(`${base}${API}/records`, { headers: bearer })).json()).data;

  const forgotten = await fetch(`${base}${API}/records/${encodeURIComponent(record.id)}/forget`, { method: "POST", headers: bearer, body: JSON.stringify({ expectedVersion: record.version }) });
  assert.equal(forgotten.status, 200, await forgotten.clone().text());
  assert.equal(forgotten.headers.get("x-memory-engine"), "native");
  const answer = (await forgotten.json()).data;
  assert.equal(answer.status, "archived");
  assert.equal(await sessions.read(user.id, uri), null, "the file left the engine, not a PostgreSQL copy");
  const gone = (await (await fetch(`${base}${API}/records`, { headers: bearer })).json()).data;
  assert.equal(gone.length, 0, "an archived record is not listed");

  const undone = await fetch(`${base}${API}/records/${encodeURIComponent(record.id)}/undo`, { method: "POST", headers: bearer, body: JSON.stringify({ expectedVersion: answer.version }) });
  assert.equal(undone.status, 200, await undone.clone().text());
  assert.equal(await sessions.read(user.id, uri), "Use AMA citations for every reference.", "the file is back, as the person's own words");
});

test("an episode is refused by name for a native account, for the institution and for a subject, and no subject account is made", options, async (t) => {
  const { app, base, bearer, user } = await fixture(t);
  const body = JSON.stringify({ projectId: "default", messages: [{ role: "user", text: "我吃素" }] });
  const own = await fetch(`${base}${API}/episodes`, { method: "POST", headers: bearer, body });
  assert.equal(own.status, 400);
  assert.equal((await own.json()).code, "memory_engine_unsupported");

  const subject = await fetch(`${base}${API}/episodes`, { method: "POST", headers: { ...bearer, "x-subject": "doctor-1" }, body });
  assert.equal(subject.status, 400);
  assert.equal((await subject.json()).code, "memory_engine_unsupported");
  const made = await app.store.database.query("SELECT count(*)::integer AS n FROM evimed_agent.subjects WHERE owner_user_id=$1", [user.id]);
  assert.equal(made.rows[0].n, 0, "the refused call made no account for the subject");
});
