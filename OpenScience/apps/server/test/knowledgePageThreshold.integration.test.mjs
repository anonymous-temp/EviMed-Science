// A round asked for below the threshold: accepted (the compile route answers 202 and the next document asks for a round by
// itself), closed by the worker, and said in plain words by the status — not left as a bare `below_threshold` that gives the
// person who had just pressed 「重新整理」 nothing to say why no round ran (release 18 acceptance, 2026-10-13).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { createOpenVikingStub } from "./helpers/openVikingResourcesStub.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

test("a manual round below the threshold says how many documents it still takes, in the status and in the answer to the request", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 120_000,
}, async () => {
  // A database of this file's own: the other knowledge suite cancels the queued rounds of every other account in the one it runs in.
  const isolated = await createGeoTestDatabase(databaseUrl, "kthreshold");
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-knowledge-threshold-"));
  const engine = createOpenVikingStub({ compile: () => {} });
  const client = new OpenVikingClient({ openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed", openVikingRequestTimeoutMs: 5000 },
    { fetchImpl: /** @type {any} */ (engine.fetch) });
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, sourceIngestionEnabled: true, sourceIngestionPollMs: 100, sourceIngestionLeaseMs: 5000,
    memoryIndexProvider: "builtin", ovKnowledgeEnabled: true, openVikingClient: client, knowledgePagesDebounceMs: 0, knowledgePagesMinSources: 3, knowledgePagesPollMs: 100,
    kbSearchEnabled: false });
  const username = `kt${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    user = await app.store.createUser(username, "test-only-knowledge-password", "Knowledge threshold fixture");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const address = await app.listen(0, "127.0.0.1");
    listening = true;
    await app.store.database.query(`UPDATE evimed_product.jobs SET status='canceled', finished_at=clock_timestamp()
      WHERE kind IN ('wiki-compile','ov-resource-sync') AND status IN ('queued','running') AND user_id<>$1`, [user.id]);
    await app.sourceWorker.close();
    await app.knowledgePagesWorker.close();
    await app.sourceSyncWorker.close();
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "test-only-knowledge-password" }) });
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": auth.data.csrfToken,
      "x-open-science-project": project.id, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" };
    const api = async (/** @type {string} */ route, /** @type {RequestInit} */ init = {}) => {
      const response = await fetch(`${base}${route}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const ingest = async () => {
      for (let round = 0; round < 600; round += 1) {
        const queued = await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest' AND status IN ('queued','running')", [user.id]);
        if (!queued.rowCount) return;
        await app.sourceWorker.tick();
      }
      assert.fail("the documents were not read");
    };
    const upload = async (/** @type {string} */ name, /** @type {string} */ content) => {
      const sent = await api("/api/files/upload", { method: "POST", body: JSON.stringify({ root: "base", path: `knowledge-base/${name}`, data: content, encoding: "utf8" }) });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const source = await app.sourceService.get(user.id, sent.body.data.source.id);
      if (source.payload.depth !== "index_only") {
        await app.sourceService.override(user.id, source.id, { expectedRevision: source.revision, docType: source.payload.docType, depth: "index_only", reason: "Knowledge fixture: text only." });
      }
      await ingest();
    };
    await upload("one.md", "# 一\n\n第一份资料。\n");
    await upload("two.md", "# 二\n\n第二份资料。\n");
    const statusRoute = `/api/knowledge-pages?projectId=${project.id}`;
    assert.equal((await api(statusRoute)).body.data.readable, 2);

    const asked = await api("/api/knowledge-pages/compile", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
    assert.equal(asked.status, 202);
    assert.equal(asked.body.data.state, "below_threshold");
    assert.equal(asked.body.data.message, "资料还不够：再加 1 份就会开始整理", "the answer to the request says why no round will run");
    // The worker closes the round without running one; the status keeps saying it.
    for (let round = 0; round < 20; round += 1) {
      await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
      await app.knowledgePagesWorker.tick();
      const open = await app.store.database.query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind='wiki-compile' AND status IN ('queued','running')", [user.id]);
      if (!open.rowCount) break;
    }
    const after = (await api(statusRoute)).body.data;
    assert.deepEqual([after.state, after.pages, after.pending, after.message], ["below_threshold", 0, 0, "资料还不够：再加 1 份就会开始整理"]);
    assert.equal(engine.requests.filter((request) => request.path === "/api/v1/compile").length, 0, "no round was submitted to the engine");
    // The third document reaches the threshold: nothing is in the way, and the document asks for a round by itself.
    await upload("three.md", "# 三\n\n第三份资料。\n");
    const reached = (await api(statusRoute)).body.data;
    assert.deepEqual([reached.readable, reached.message], [3, null]);
  } finally {
    if (user) { try { await app.store.deleteUser(await app.store.userById(user.id)); } catch { /* the next run starts from a fresh account anyway */ } }
    if (listening) await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await isolated.drop();
  }
});
