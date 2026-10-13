// The memory page's routes for an account on the native engine: the same paths and, wherever the engine allows, the same
// shapes as the legacy path, served from the engine's files. The real routes over HTTP, a real PostgreSQL, a stub engine.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createMemoryRoutes } from "../src/memoryRoutes.mjs";
import { NativeMemoryOverlay } from "../src/nativeMemoryOverlay.mjs";
import { NativeMemoryStore, nativeFileId } from "../src/nativeMemoryStore.mjs";
import { NativeMemoryWorker } from "../src/nativeMemoryWorker.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";
import { HttpError, sendJson } from "../src/security.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const config = { ovNativeMemoryEnabled: true, memoryEnabled: true, memoryContextLimit: 8, memoryContextMaxChars: 20_000, maxJsonBytes: 1_000_000 };

/** @type {ControlPlaneDatabase} */
let database;
const users = [];
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await migrateResearchMemory(database);
});
after(async () => {
  if (!url) return;
  for (const id of users) await database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]);
  await database.close();
});

async function fixture(t, { nativeConfigured = true, extract = () => ({}) } = {}) {
  const userId = `nr_${randomUUID().slice(0, 8)}`;
  users.push(userId);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Native routes test','development')", [userId]);
  const stub = await startOpenVikingStub(t, { extract });
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const overlay = new NativeMemoryOverlay({ database });
  const researchMemory = new ResearchMemoryStore(config, { database });
  const nativeMemory = nativeConfigured ? new NativeMemoryStore({ sessions, overlay }) : new NativeMemoryStore({ sessions: { configured: false }, overlay });
  const worker = new NativeMemoryWorker({ config, researchMemory, sessions, overlay });
  const audits = [];
  const routes = createMemoryRoutes({
    config, researchMemory, nativeMemory, feedbackEvents: null,
    store: { ensureUser: async () => ({ id: userId }), requireProject: async (_user, id) => { if (id === "p_missing") throw new HttpError(404, "project_not_found", "x"); return { id }; } },
    context: async () => ({ user: { id: userId, name: "Native routes test" }, project: { id: "p1" } }),
    audit: async (_ctx, action, outcome, detail) => { audits.push({ action, outcome, detail }); },
    recordFeedback: async () => {}, decodeRouteComponent: (value) => decodeURIComponent(value),
  });
  const server = createServer((req, res) => {
    routes(req, res).then((handled) => { if (!handled) sendJson(res, 404, { error: { code: "not_found" } }); })
      .catch((error) => sendJson(res, error?.status ?? 500, { error: { code: error?.code ?? "internal", message: String(error?.message ?? "") } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body = undefined) => {
    const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const engineUser = sessions.engineUser(userId);
  await sessions.register(userId);
  return { userId, stub, sessions, overlay, researchMemory, call, audits, worker, engineUser, seed: (rel, text, extra) => stub.seedMemory(engineUser, rel, text, extra) };
}

test("the list, the profile and the settings say which engine they are from and keep the legacy shape", options, async (t) => {
  const { call, seed } = await fixture(t);
  const uri = seed("preferences/language.md", "Replies in Simplified Chinese.", { type: "preferences" });
  seed("profile.md", "# Profile\n- A nurse in a paediatric ward", { type: "profile" });
  const settings = await call("GET", "/api/memory/settings");
  assert.equal(settings.json.data.engine, "native");
  assert.equal(settings.json.data.learningPaused, false);
  const profile = await call("GET", "/api/memory/profile");
  assert.equal(profile.status, 200);
  const data = profile.json.data;
  assert.equal(data.engine, "native");
  assert.deepEqual(Object.keys(data.groups).sort(), ["correction", "decision", "follow_up", "preference", "profile", "project_fact"]);
  assert.equal(data.groups.preference[0].uri, uri);
  for (const field of ["id", "scope", "scopeId", "kind", "key", "value", "summary", "origin", "status", "version", "createdAt", "updatedAt", "revisions", "engine", "nativeType", "uri", "contentHash"]) {
    assert.ok(field in data.groups.preference[0], `a record carries ${field}`);
  }
  assert.equal(data.groups.profile[0].document.uri.endsWith("/memories/profile.md"), true);
  assert.deepEqual(data.pending, []);
  const listed = await call("GET", "/api/memory/records?kind=preference");
  assert.deepEqual(listed.json.data.map((record) => record.uri), [uri]);
  const found = await call("GET", "/api/memory/search?q=Chinese");
  assert.equal(found.json.data.items.length, 1);
});

test("an edit under the version, a stale edit, a field a memory file has no place for, and a delete", options, async (t) => {
  const { call, seed, sessions, userId, audits } = await fixture(t);
  const uri = seed("preferences/format.md", "Short answers.", { type: "preferences" });
  const record = (await call("GET", "/api/memory/records")).json.data[0];
  const id = encodeURIComponent(record.id);
  const edited = await call("PATCH", `/api/memory/records/${id}`, { value: "Short answers, then detail.", expectedVersion: record.version });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.data.value, "Short answers, then detail.");
  assert.equal(await sessions.read(userId, uri), "Short answers, then detail.");
  const stale = await call("PATCH", `/api/memory/records/${id}`, { value: "lost", expectedVersion: record.version });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "memory_conflict");
  const noPlace = await call("PATCH", `/api/memory/records/${id}`, { importance: 0.9, expectedVersion: edited.json.data.version });
  assert.equal(noPlace.status, 400);
  assert.equal(noPlace.json.error.code, "memory_engine_unsupported");
  const noVersion = await call("PATCH", `/api/memory/records/${id}`, { value: "x" });
  assert.equal(noVersion.json.error.code, "memory_version_invalid");
  const deleted = await call("DELETE", `/api/memory/records/${id}`);
  assert.equal(deleted.json.data, true);
  assert.equal(await sessions.read(userId, uri), null);
  assert.deepEqual(audits.map((entry) => entry.action), ["memory.record.update", "memory.record.delete"]);
  assert.equal((await call("DELETE", "/api/memory/records/nm_000000000000000000000000")).status, 404);
  assert.equal((await call("PATCH", "/api/memory/records/not-a-native-id", { value: "x", expectedVersion: 1 })).status, 404);
});

test("forget with an undo, and the one-click undo of an engine addition", options, async (t) => {
  const { call, seed, sessions, userId, stub, worker, engineUser } = await fixture(t, {
    extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/dates.md`, memory_type: "preferences", after: "Dates as YYYY-MM-DD." }] }),
  });
  const uri = seed("preferences/old.md", "Metric units.", { type: "preferences" });
  const record = (await call("GET", "/api/memory/records")).json.data[0];
  const forgotten = await call("PATCH", `/api/memory/records/${encodeURIComponent(record.id)}`, { status: "archived", expectedVersion: record.version });
  assert.equal(forgotten.json.data.status, "archived");
  assert.equal(await sessions.read(userId, uri), null);
  const restored = await call("POST", `/api/memory/records/${encodeURIComponent(record.id)}/undo`, { expectedVersion: forgotten.json.data.version });
  assert.equal(restored.json.data.undone, "restored");
  assert.equal(await sessions.read(userId, uri), "Metric units.");
  // An engine addition shows under 「刚记住了」, with the version its undo names.
  const session = "dsh-session_ffffffffffffffffffffffffffffffff";
  stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, messages: [{ role: "user", parts: [{ type: "text", text: "dates as YYYY-MM-DD" }] }], archives: 0, commitCount: 0 });
  stub.commitSession(engineUser, session);
  await worker.scanArchives(userId);
  await worker.processCommits({ userId });
  const changes = (await call("GET", `/api/memory/changes?since=2026-01-01T00:00:00.000Z&sessionId=${session.slice(4)}`)).json.data;
  assert.equal(changes.length, 1);
  assert.deepEqual(Object.keys(changes[0]).sort(), ["change", "changedAt", "id", "key", "kind", "scope", "scopeId", "status", "summary", "version"]);
  const undone = await call("POST", `/api/memory/records/${encodeURIComponent(changes[0].id)}/undo`, { expectedVersion: changes[0].version });
  assert.equal(undone.json.data.undone, "removed");
  assert.equal((await call("GET", "/api/memory/records")).json.data.length, 1);
});

test("remember from the page: pending at once, the memory when the engine has written it", options, async (t) => {
  const { call, userId, worker } = await fixture(t, {
    extract: ({ user, messages }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/dose-units.md`, memory_type: "preferences", after: String(messages[0].parts?.[0]?.text ?? messages[0].content).replace("请记住：", "") }] }),
  });
  const remembered = await call("POST", "/api/memory/remember", { text: "Use mg/kg for paediatric doses" });
  assert.equal(remembered.status, 200);
  assert.equal(remembered.json.data.pending.state, "pending");
  assert.equal((await call("GET", "/api/memory/profile")).json.data.pending.length, 1);
  // (The stub extracts at once; the real engine takes about twelve seconds, which is what the pending list is for.)
  await worker.processCommits({ userId });
  const after = await call("GET", "/api/memory/profile");
  assert.equal(after.json.data.pending.length, 0);
  assert.equal(after.json.data.records[0].value, "Use mg/kg for paediatric doses");
  assert.equal((await call("POST", "/api/memory/remember", { text: "x", extra: 1 })).json.error.code, "memory_payload_invalid");
  assert.equal((await call("POST", "/api/memory/remember", { text: "a", projectId: "p_missing" })).status, 404);
});

test("pausing learning is the engine's own policy too, and reset empties the engine's memories", options, async (t) => {
  const { call, seed, stub, engineUser, sessions, userId } = await fixture(t);
  const uri = seed("preferences/x.md", "Something.", { type: "preferences" });
  const paused = await call("PUT", "/api/memory/settings", { learningPaused: true });
  assert.equal(paused.json.data.engine, "native");
  assert.equal(stub.users.get(engineUser).learning, false, "the engine does not extract for a paused account");
  assert.ok(stub.users.get(engineUser).memoryTypes.includes("preferences"), "the whole type allowlist travels with every settings change");
  await call("PUT", "/api/memory/settings", { learningPaused: false });
  assert.equal(stub.users.get(engineUser).learning, true);
  const reset = await call("POST", "/api/memory/reset", { confirm: "reset" });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.equal(await sessions.read(userId, uri), null);
  assert.equal((await call("GET", "/api/memory/records")).json.data.length, 0);
});

test("the project tab's card is the project's own project-context memory; a conflict has nothing to settle", options, async (t) => {
  const { call, seed } = await fixture(t);
  seed("projects/trial.md", "# Statin trial\n领域：心血管\n## 目标\n- 比较两种他汀\n## 约束\n- 只用公开数据", { type: "project_context", tags: ["project=p_trial"] });
  const overview = await call("GET", "/api/memory/projects/p_trial/overview");
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.json.data.card.map((entry) => entry.slot), ["field", "goal", "constraints"]);
  const conflict = await call("POST", "/api/memory/conflicts/resolve", { keepId: "a", otherId: "b" });
  assert.equal(conflict.json.error.code, "memory_engine_unsupported");
});

test("an account on the native engine in a deployment that cannot reach the engine is told so, never served the legacy rows", options, async (t) => {
  const { call } = await fixture(t, { nativeConfigured: false });
  const answer = await call("GET", "/api/memory/profile");
  assert.equal(answer.status, 503);
  assert.equal(answer.json.error.code, "memory_engine_unavailable");
});

test("an account on the legacy engine keeps the legacy page, and remember is refused by name", options, async (t) => {
  const { call, researchMemory, userId } = await fixture(t);
  await researchMemory.setMemoryEngine(userId, "legacy");
  const profile = await call("GET", "/api/memory/profile");
  assert.equal(profile.status, 200);
  assert.notEqual(profile.json.data.engine, "native");
  assert.equal((await call("GET", "/api/memory/settings")).json.data.engine, "legacy");
  const remember = await call("POST", "/api/memory/remember", { text: "x" });
  assert.equal(remember.status, 400);
  assert.equal(remember.json.error.code, "memory_engine_unsupported");
  assert.ok(nativeFileId("viking://x"));
});
