// The 项目 tab's overview and a memory's sources, over the real store, on a real database: the card read off a project's
// memories, the project proved the account's before any of them is read, and the documents a memory rests on.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

async function fixture(t) {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-memory-overview-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
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
  return { app, base, account, project };
}

const slot = (projectId, key, value, extra = {}) => ({
  scope: "project", scopeId: projectId, kind: "project_fact", key, value, summary: value,
  origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false, ...extra,
});
const proof = { sourceType: "conversation_message", sourceRef: "sessions/ses_1/messages/m1", quote: "我们课题", observedAt: new Date().toISOString(), weight: 1 };

test("a project's overview is its card, read off its own active memories, for the account that owns the project", options, async (t) => {
  const { app, base, account, project: makeProject } = await fixture(t);
  const me = await account();
  const { user, headers } = me;
  const project = await makeProject(me, "af-2026", "房颤抗凝");
  const other = await makeProject(me, "diabetes-2026", "糖尿病");
  const write = (projectId, key, value, extra) => app.researchMemory.upsertRecord(user.id, slot(projectId, key, value, extra), proof);
  const population = await write(project.id, "project.population", "75 岁以上非瓣膜性房颤患者");
  await write(project.id, "project.field", "心血管");
  await write(project.id, "project.outcome", "大出血", { kind: "decision" });
  await write(project.id, "project.af_cohort.design", "回顾性队列");
  await write(project.id, "project.stage", "已忘记", { status: "archived" });
  await write(other.id, "project.population", "2 型糖尿病患者");

  const read = await fetch(`${base}/api/memory/projects/${project.id}/overview?timeZone=Asia%2FShanghai`, { headers });
  assert.equal(read.status, 200, await read.clone().text());
  const { data } = await read.json();
  assert.deepEqual(data.card.map((entry) => [entry.slot, entry.text]), [["field", "心血管"], ["population", "75 岁以上非瓣膜性房颤患者"], ["outcome", "大出血"]],
    "the slots in the card's order; a key the model made up, a forgotten fact and another project's are not on it");
  assert.equal(data.card.find((entry) => entry.slot === "population").recordId, population.id);
  assert.equal(data.paused, false);
  assert.deepEqual([data.capabilities, data.works], [[], []]);

  // The project's own switch, read from the same settings the header changes.
  await app.researchMemory.updateSettings(user.id, { pausedProjects: [project.id] });
  const paused = (await (await fetch(`${base}/api/memory/projects/${project.id}/overview`, { headers })).json()).data;
  assert.equal(paused.paused, true);
  assert.equal((await (await fetch(`${base}/api/memory/projects/${other.id}/overview`, { headers })).json()).data.paused, false);
});

test("another account's project is a 404 whatever its memories hold, and so is another account's memory's source list", options, async (t) => {
  const { app, base, account, project: makeProject } = await fixture(t);
  const owner = await account();
  const stranger = await account();
  const project = await makeProject(owner, "private-study", "私有研究");
  const record = await app.researchMemory.upsertRecord(owner.user.id, slot(project.id, "project.population", "房颤患者"), proof, {
    sourceLinks: [{ type: "knowledge_source", id: `src_${"a".repeat(32)}`, version: null }, { type: "doi", id: "10.1000/xyz", version: null }],
  });

  assert.equal((await fetch(`${base}/api/memory/projects/${project.id}/overview`, { headers: stranger.headers })).status, 404);
  assert.equal((await fetch(`${base}/api/memory/records/${record.id}/sources`, { headers: stranger.headers })).status, 404);

  const links = (await (await fetch(`${base}/api/memory/records/${record.id}/sources`, { headers: owner.headers })).json()).data;
  assert.deepEqual(links.map((link) => [link.type, link.id.slice(0, 4)]), [["doi", "10.1"], ["knowledge_source", "src_"]]);
  assert.ok(links.every((link) => Object.keys(link).sort().join() === "id,state,type"), "only type, id and state leave");
  assert.equal((await fetch(`${base}/api/memory/records/nope_${randomUUID()}/sources`, { headers: owner.headers })).status, 404);
});
