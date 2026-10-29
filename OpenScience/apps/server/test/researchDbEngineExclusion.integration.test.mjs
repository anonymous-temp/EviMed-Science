// A table imported from the researcher's own database (`knowledge-base/databases/`, `researchDbImport.mjs`) is a source the
// project's runs read as a file. It is kept out of the knowledge engine and out of the wiki and graph the engine compiles:
// not pushed, not counted toward the threshold of readable documents, not announced as a change, not an input of a
// generation, not added to the personal library. Every one of those is a place that used to take "every readable source".
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { readKnowledgeSourceInputs } from "../src/knowledgeGeneration.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { createOpenVikingStub } from "./helpers/openVikingResourcesStub.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

test("an imported database table is read by the project's runs and by nothing that feeds the engine, the compile or the library", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 120_000,
}, async () => {
  const isolated = await createGeoTestDatabase(databaseUrl, "rdbexclude");
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-research-db-exclude-"));
  const engine = createOpenVikingStub({ compile: () => {} });
  const client = new OpenVikingClient({ openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed", openVikingRequestTimeoutMs: 5000 },
    { fetchImpl: /** @type {any} */ (engine.fetch) });
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, sourceIngestionEnabled: true, sourceIngestionPollMs: 100, sourceIngestionLeaseMs: 5000,
    memoryIndexProvider: "builtin", ovKnowledgeEnabled: true, openVikingClient: client, knowledgePagesDebounceMs: 0, knowledgePagesMinSources: 3, knowledgePagesPollMs: 100,
    kbSearchEnabled: false });
  const username = `rx${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    user = await app.store.createUser(username, "test-only-knowledge-password", "Research database exclusion fixture");
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
      return app.sourceService.get(user.id, source.id);
    };
    const statusRoute = `/api/knowledge-pages?projectId=${project.id}`;
    const one = await upload("one.md", "# 一\n\n第一份资料。\n");
    const two = await upload("two.md", "# 二\n\n第二份资料。\n");
    const pendingBefore = (await api(statusRoute)).body.data.pending;
    const table = await upload("databases/public.cohort-1a2b3c4d.csv", "id,note\r\n1,a\r\n2,b\r\n");
    assert.match(table.payload.paths[0], /^knowledge-base\/databases\/\.evimed-revisions\/[a-f0-9]{64}\/public\.cohort-1a2b3c4d\.csv$/);
    assert.equal(table.payload.status, "complete", "the table is read like any document: the project's runs search and open it");

    // Compile: the table is not a readable document, not a change, and not a generation input.
    const status = (await api(statusRoute)).body.data;
    assert.equal(status.readable, 2, "two documents and a table: the table does not count toward the threshold");
    assert.equal(status.pending, pendingBefore, "the table's becoming readable asked for no round");
    const asked = await api("/api/knowledge-pages/compile", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
    assert.equal(asked.body.data.message, "资料还不够：再加 1 份就会开始整理");
    const inputs = await readKnowledgeSourceInputs({ sources: app.sourceService, ownerId: user.id, projectId: project.id });
    assert.deepEqual(inputs.map((input) => input.receipt.sourceId).sort(), [one.id, two.id].sort(), "a generation's inputs are the documents");

    // Engine: nothing asks for the table, and a convergence leaves the engine without it.
    assert.equal((await app.sourceSync.convergeSource(user.id, table.id)).action, "absent");
    assert.equal((await app.sourceSync.convergeSource(user.id, one.id)).action, "pushed");
    const uriOf = (/** @type {string} */ id) => app.openVikingResources.sourceUri(user.id, project.id, id);
    assert.equal(engine.files.has(uriOf(one.id)), true); assert.equal(engine.files.has(uriOf(table.id)), false);
    const report = await app.sourceSync.reconcileProject(user.id, project.id, { apply: false });
    assert.equal(report.expected, 2, "reconciliation expects the two documents");
    assert.deepEqual(report.extra, []);

    // The library is pushed to the engine too, and shared across projects: the table stays in its project.
    await assert.rejects(app.libraryService.add(user.id, table.id), { code: "library_source_invalid" });

    // What it is still: a source of the project, listed, with an origin of its own.
    const listed = await api(`/api/sources?projectId=${project.id}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.items.find((/** @type {any} */ item) => item.id === table.id).display.origin, "database");
    const reached = await api(`/api/sources/${table.id}?projectId=${project.id}`);
    assert.equal(reached.status, 200);
  } finally {
    if (user) { try { await app.store.deleteUser(await app.store.userById(user.id)); } catch { /* the next run starts from a fresh account anyway */ } }
    if (listening) await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await isolated.drop();
  }
});
