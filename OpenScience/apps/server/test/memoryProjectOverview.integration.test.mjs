// The 项目 tab's overview and a memory's sources, over the engine's store (its wire doubled by the in-process OpenViking stub) and a real
// database: the card read off a project's own project-context file, the project proved the account's before any of it is read, and the
// documents a memory rests on.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
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

async function fixture(t) {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-memory-overview-"));
  const stub = await startOpenVikingStub(t);
  const openVikingSessions = new OpenVikingSessions(new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" }), { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
    memoryEngineEnabled: true, openVikingSessions,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const created = [];
  t.after(async () => {
    for (const user of created) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  /** A new account and a signed-in browser's headers. */
  const account = async () => {
    const username = `overview${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const password = "test-only-overview-password";
    const user = await app.store.createUser(username, password, "Overview fixture");
    created.push(user);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
    });
    const auth = await login.json();
    return { user, headers: { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken } };
  };
  /** A project of the account's own, made the way the shell makes one. */
  const project = async (who, id, name) => {
    const made = await fetch(`${base}/api/projects`, { method: "POST", headers: who.headers, body: JSON.stringify({ id, name }) });
    assert.equal(made.status, 200, await made.clone().text());
    return { id };
  };
  /** A memory file of an account, written into the engine the way the engine would have. */
  const seed = (user, rel, text, extra) => stub.seedMemory(openVikingSessions.engineUser(user.id), rel, text, extra);
  return { app, base, account, project, seed };
}

test("a project's overview is its card, read off its own project-context memory, for the account that owns the project", options, async (t) => {
  const { app, base, account, project: makeProject, seed } = await fixture(t);
  const me = await account();
  const { user, headers } = me;
  const project = await makeProject(me, "af-2026", "房颤抗凝");
  const other = await makeProject(me, "diabetes-2026", "糖尿病");
  seed(user, "projects/af.md", "# 房颤抗凝\n领域：心血管\n## 范围或对象\n- 75 岁以上非瓣膜性房颤患者\n## 约束\n- 只用公开数据", { type: "project_context", tags: [`project=${project.id}`] });
  seed(user, "projects/diabetes.md", "# 糖尿病\n领域：内分泌\n## 范围或对象\n- 2 型糖尿病患者", { type: "project_context", tags: [`project=${other.id}`] });
  // A fact of the same project is not the card, and a file of no project is nobody's card.
  seed(user, "project_facts/other.md", "- 回顾性队列。", { type: "project_facts", tags: [`project=${project.id}`] });

  const read = await fetch(`${base}/api/memory/projects/${project.id}/overview?timeZone=Asia%2FShanghai`, { headers });
  assert.equal(read.status, 200, await read.clone().text());
  const { data } = await read.json();
  assert.deepEqual(data.card.map((entry) => [entry.slot, entry.text]), [["field", "心血管"], ["subject", "75 岁以上非瓣膜性房颤患者"], ["constraints", "只用公开数据"]],
    "the slots in the card's order, from this project's own file alone");
  assert.equal(data.paused, false);
  assert.deepEqual([data.capabilities, data.works], [[], []]);

  // The project's own switch, read from the same settings the header changes.
  await app.memorySettings.updateSettings(user.id, { pausedProjects: [project.id] });
  const paused = (await (await fetch(`${base}/api/memory/projects/${project.id}/overview`, { headers })).json()).data;
  assert.equal(paused.paused, true);
  assert.equal((await (await fetch(`${base}/api/memory/projects/${other.id}/overview`, { headers })).json()).data.paused, false);
});

test("another account's project is a 404 whatever its memories hold, and so is another account's memory's source list", options, async (t) => {
  const { app, base, account, project: makeProject, seed } = await fixture(t);
  const owner = await account();
  const stranger = await account();
  const project = await makeProject(owner, "private-study", "私有研究");
  const uri = seed(owner.user, "projects/private.md", "# 私有研究\n领域：心血管", { type: "project_context", tags: [`project=${project.id}`] });
  await app.nativeMemory.overlay.setSources(owner.user.id, uri, [{ type: "knowledge_source", id: `src_${"a".repeat(32)}` }, { type: "doi", id: "10.1000/xyz" }]);
  const record = (await (await fetch(`${base}/api/memory/records`, { headers: owner.headers })).json()).data.find((entry) => entry.uri === uri);

  assert.equal((await fetch(`${base}/api/memory/projects/${project.id}/overview`, { headers: stranger.headers })).status, 404);
  assert.equal((await fetch(`${base}/api/memory/records/${encodeURIComponent(record.id)}/sources`, { headers: stranger.headers })).status, 404);

  const links = (await (await fetch(`${base}/api/memory/records/${encodeURIComponent(record.id)}/sources`, { headers: owner.headers })).json()).data;
  assert.deepEqual(links.map((link) => [link.type, link.id.slice(0, 4)]).sort(), [["doi", "10.1"], ["knowledge_source", "src_"]]);
  assert.ok(links.every((link) => Object.keys(link).sort().join() === "id,state,type"), "only type, id and state leave");
  assert.equal((await fetch(`${base}/api/memory/records/nope_${randomUUID()}/sources`, { headers: owner.headers })).status, 404);
});
