// The owner's case, end to end (2026-10-14, production): one document, read and kept long before the compile existed — no copy in
// the engine, no `wiki:state` row, no compile job of any kind — in a deployment whose threshold is the default. Nothing turns
// readable and nobody presses 「重新整理」, so the worker's periodic pass is what has to notice the project, queue its round, and
// have that round run the way a fresh upload's does: the engine's copy is made first, then the compile is submitted.
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

test("a project whose document predates the sync gets its round queued by the periodic pass, and the round pushes the document and submits the compile", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 120_000,
}, async () => {
  const isolated = await createGeoTestDatabase(databaseUrl, "kcatchup");
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-knowledge-catchup-"));
  const engine = createOpenVikingStub({ compile: () => {} });
  const client = new OpenVikingClient({ openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed", openVikingRequestTimeoutMs: 5000 },
    { fetchImpl: /** @type {any} */ (engine.fetch) });
  // No `knowledgePagesMinSources`: the default is what is being asked about.
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, sourceIngestionEnabled: true, sourceIngestionPollMs: 100, sourceIngestionLeaseMs: 5000,
    memoryIndexProvider: "builtin", ovKnowledgeEnabled: true, openVikingClient: client, knowledgePagesDebounceMs: 0, knowledgePagesPollMs: 100, kbSearchEnabled: false });
  const username = `kc${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    user = await app.store.createUser(username, "test-only-knowledge-password", "Knowledge catch-up fixture");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const address = await app.listen(0, "127.0.0.1");
    listening = true;
    await app.sourceWorker.close();
    await app.knowledgePagesWorker.close();
    await app.sourceSyncWorker.close();
    assert.equal(app.config.knowledgePagesMinSources, 1, "a project with one readable document is compiled by default");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "test-only-knowledge-password" }) });
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": auth.data.csrfToken,
      "x-open-science-project": project.id, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" };
    const api = async (/** @type {string} */ route, /** @type {RequestInit} */ init = {}) => {
      const response = await fetch(`${base}${route}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const query = async (/** @type {string} */ text, /** @type {any[]} */ values = []) => (await app.store.database.query(text, values)).rows;

    // One document, read. (The hooks of a document turning readable are asynchronous; they are let finish, then undone below.)
    const sent = await api("/api/files/upload", { method: "POST", body: JSON.stringify({ root: "base", path: "knowledge-base/one.md", data: "# 一\n\n唯一的一份资料。\n", encoding: "utf8" }) });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const sourceId = sent.body.data.source.id;
    const source = await app.sourceService.get(user.id, sourceId);
    if (source.payload.depth !== "index_only") {
      await app.sourceService.override(user.id, sourceId, { expectedRevision: source.revision, docType: source.payload.docType, depth: "index_only", reason: "Knowledge fixture: text only." });
    }
    for (let round = 0; round < 600; round += 1) {
      if (!(await query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest' AND status IN ('queued','running')", [user.id])).length) break;
      await app.sourceWorker.tick();
    }
    for (let round = 0; round < 100 && !(await query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind='wiki-compile'", [user.id])).length; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Undo everything the document's own hooks did: this is the project as it was before any of them existed.
    await query("DELETE FROM evimed_product.jobs WHERE user_id=$1 AND kind IN ('wiki-compile','ov-resource-sync')", [user.id]);
    await query("DELETE FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND id=$2", [user.id, `wiki:state:${project.id}`]);
    const roots = app.openVikingResources.roots(user.id, project.id);
    for (const uri of engine.list(roots.sources)) engine.remove(uri);
    assert.equal((await query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind IN ('wiki-compile','ov-resource-sync')", [user.id])).length, 0);
    assert.deepEqual(engine.list(roots.sources), [], "the engine holds no copy of the document");
    const statusRoute = `/api/knowledge-pages?projectId=${project.id}`;
    const before = (await api(statusRoute)).body.data;
    assert.deepEqual([before.readable, before.state, before.pending], [1, "idle", 0], "nothing is waiting: the document is readable and no round is asked for");

    // The pass: the worker's own, over the projects the sync's timer reads.
    const summary = await app.knowledgePagesWorker.catchUp();
    assert.equal(summary.scheduled >= 1, true, JSON.stringify(summary));
    const jobs = await query("SELECT kind, status, payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='wiki-compile'", [user.id]);
    assert.deepEqual(jobs.map((job) => [job.status, job.payload.projectId, job.payload.round]), [["queued", project.id, 1]]);
    const queued = (await api(statusRoute)).body.data;
    assert.deepEqual([queued.state, queued.pending, queued.message], ["queued", 1, null]);
    // A second pass changes nothing.
    await app.knowledgePagesWorker.catchUp();
    assert.equal((await query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind='wiki-compile'", [user.id])).length, 1);

    // The round runs as any other: the copy is pushed, then the compile is submitted.
    for (let round = 0; round < 20 && !engine.requests.some((request) => request.path === "/api/v1/compile"); round += 1) {
      await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind='wiki-compile' AND status='queued'", [user.id]);
      await app.knowledgePagesWorker.tick();
    }
    assert.deepEqual(engine.list(roots.sources).map((uri) => uri.split("/").pop()), [`${sourceId}.md`], "the document reached the engine before the compile read it");
    assert.equal(engine.requests.filter((request) => request.path === "/api/v1/compile").length >= 1, true, "the compile was submitted");
  } finally {
    if (user) { try { await app.store.deleteUser(await app.store.userById(user.id)); } catch { /* the next run starts from a fresh account anyway */ } }
    if (listening) await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await isolated.drop();
  }
});
