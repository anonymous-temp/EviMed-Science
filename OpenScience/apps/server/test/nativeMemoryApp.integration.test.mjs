// The native memory engine wired into the real app: the page reads the engine's files, a deleted project and a deleted account
// take what the engine holds of them, the export carries the engine's pack, the map draws the engine's memories, and the
// readiness report says how many accounts it looked at when it says no account is on both paths.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PASSWORD = "test-only-native-password";

async function fixture(t, { native = true } = {}) {
  const stub = await startOpenVikingStub(t);
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const openVikingSessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-native-app-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl, ovNativeMemoryEnabled: native, openVikingSessions,
  });
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
  return { app, base, headers, user, stub, engineUser, sessions: openVikingSessions, seed: (rel, text, extra) => stub.seedMemory(engineUser, rel, text, extra) };
}

test("a new account takes the deployment's default engine, and the page reads the engine's files", options, async (t) => {
  const { app, base, headers, user, seed } = await fixture(t);
  assert.equal(await app.researchMemory.memoryEngine(user.id), "native");
  seed("preferences/tone.md", "Plain language, no flattery.", { type: "preferences" });
  const profile = await (await fetch(`${base}/api/memory/profile`, { headers })).json();
  assert.equal(profile.data.engine, "native");
  assert.equal(profile.data.groups.preference.length, 1);
  assert.equal((await (await fetch(`${base}/api/memory/settings`, { headers })).json()).data.engine, "native");
  // The run-end extraction and the dispatch's profile give nothing to a native account: the engine does both.
  assert.equal((await app.residentProfiles.forDispatch(user.id, "default", null, { })).block ?? "", "");
});

test("the map draws a native account from the engine's files, with the same document", options, async (t) => {
  const { base, headers, seed } = await fixture(t);
  seed("preferences/tone.md", "Plain language, no flattery.", { type: "preferences" });
  seed("profile.md", "# Profile\n- A hospital pharmacist", { type: "profile" });
  const map = await (await fetch(`${base}/api/memory/map?include=summary,nodes`, { headers })).json();
  assert.equal(map.data.summary.memories, 2, JSON.stringify(map.data.summary));
  assert.ok(map.data.nodes.some((node) => node.type === "memory"));
});

test("deleting a project takes the engine's memories tagged with it and its conversations; the account's own stay", options, async (t) => {
  const { app, base, headers, user, stub, engineUser, seed, sessions } = await fixture(t);
  const projectId = "project-native-delete";
  assert.equal((await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ id: projectId, name: "Native deletion" }) })).status, 200);
  const tagged = seed("projects/mine.md", "# Mine\n## 目标\n- x", { type: "project_context", tags: [`project=${projectId}`] });
  const other = seed("project_facts/other.md", "Another project's fact.", { type: "project_facts", tags: ["project=another"] });
  const personal = seed("preferences/tone.md", "Plain.", { type: "preferences" });
  await app.nativeMemory.overlay.noteSession(user.id, "dsh-session_1", projectId);
  stub.sessions.set(`${engineUser}/dsh-session_1`, { id: "dsh-session_1", user: engineUser, messages: [], archives: 0, commitCount: 0 });
  stub.files.set(`viking://user/${engineUser}/sessions/dsh-session_1/history/archive_001/messages.jsonl`, "{}");
  assert.equal((await fetch(`${base}/api/projects/${projectId}`, { method: "DELETE", headers, body: JSON.stringify({ confirm: projectId }) })).status, 200);
  assert.equal(await sessions.read(user.id, tagged), null);
  assert.ok(await sessions.read(user.id, other));
  assert.ok(await sessions.read(user.id, personal));
  assert.equal(stub.sessions.has(`${engineUser}/dsh-session_1`), false, "the project's conversation left the engine");
});

test("the export carries the engine's pack, and deleting the account erases what the engine holds of it", options, async (t) => {
  const { base, headers, user, stub, engineUser, seed } = await fixture(t);
  seed("preferences/tone.md", "Plain.", { type: "preferences" });
  const exported = await fetch(`${base}/api/account/export`, { headers });
  assert.equal(exported.status, 200);
  const tar = gunzipSync(Buffer.from(await exported.arrayBuffer()));
  assert.ok(tar.includes(Buffer.from("memory/native-memory.zip")), "the archive names the pack");
  assert.ok(tar.includes(Buffer.from("PK-stub-pack:1")), "and holds what the engine exported");
  const deleted = await fetch(`${base}/api/account`, { method: "DELETE", headers, body: JSON.stringify({ confirm: user.id, password: PASSWORD }) });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal(stub.users.has(engineUser), false, "the engine no longer knows the account");
  assert.ok(![...stub.files.keys()].some((uri) => uri.startsWith(`viking://user/${engineUser}/`)), "and holds none of its files");
});

test("readiness says how many accounts the path walk looked at", options, async (t) => {
  const { base, headers } = await fixture(t);
  const ready = await (await fetch(`${base}/api/ready`, { headers })).json();
  const memory = (ready.data?.checks ?? ready.checks ?? ready.data ?? {}).memory;
  assert.ok(memory?.native?.enginePaths, JSON.stringify(ready).slice(0, 400));
  assert.ok(memory.native.enginePaths.examined.native + memory.native.enginePaths.examined.undecided >= 1, "the walk looked at the account (one nothing has asked about yet is undecided)");
  assert.equal(memory.native.enginePaths.both, 0);
});

test("with the native engine off, an account is on the legacy path and the page says so", options, async (t) => {
  const { app, base, headers, user } = await fixture(t, { native: false });
  assert.equal(await app.researchMemory.memoryEngine(user.id), "legacy");
  const profile = await (await fetch(`${base}/api/memory/profile`, { headers })).json();
  assert.notEqual(profile.data.engine, "native");
  assert.equal((await fetch(`${base}/api/memory/remember`, { method: "POST", headers, body: JSON.stringify({ text: "x" }) })).status, 400);
});
