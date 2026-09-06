import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

test("the actual upload path creates one durable source manifest and ingest job", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-source-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
    sourceIngestionEnabled: true, sourceIngestionPollMs: 100, sourceIngestionLeaseMs: 1000 });
  const username = `source${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    user = await app.store.createUser(username, "test-only-source-password", "Source fixture");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const address = await app.listen(0, "127.0.0.1");
    listening = true;
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "test-only-source-password" }) });
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0],
      "x-open-science-csrf": auth.data.csrfToken, "x-open-science-project": project.id };
    const content = "研究方案：比较两种证据综合方法。";
    const upload = async (file) => fetch(`${base}/api/files/upload`, { method: "POST", headers,
      body: JSON.stringify({ root: "base", path: `knowledge-base/${file}`, data: content, encoding: "utf8" }) });

    const first = await upload("研究方案.txt");
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.ok(["queued", "parsing", "complete"].includes(firstBody.data.source.payload.status));
    assert.equal(firstBody.data.source.payload.docType, "research-protocol");

    const duplicate = await upload("研究方案-copy.txt");
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).data.duplicate, true);

    let sources = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const inventory = await fetch(`${base}/api/sources?projectId=${encodeURIComponent(project.id)}`, { headers });
      assert.equal(inventory.status, 200);
      sources = (await inventory.json()).data.items;
      if (sources[0]?.payload.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(sources.length, 1);
    assert.equal(sources[0].payload.paths.length, 2);
    assert.equal(sources[0].payload.status, "complete");
    assert.equal(sources[0].payload.coverage.percent, 100);
    assert.match(await readFile(path.join(project.baseDir, sources[0].payload.outputs.artifactPath), "utf8"), /比较两种证据综合方法/);
    const jobs = await app.store.database.query("SELECT kind,status FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest'", [user.id]);
    assert.equal(jobs.rowCount, 1);
    assert.equal(jobs.rows[0].status, "succeeded");
    if (process.platform === "linux") {
      const removal = await fetch(`${base}/api/sources/${sources[0].id}`, { method: "DELETE", headers,
        body: JSON.stringify({ expectedRevision: sources[0].revision }) });
      assert.equal(removal.status, 200);
      const deleted = (await removal.json()).data;
      let finished;
      for (let attempt = 0; attempt < 30; attempt++) {
        finished = await app.sourceService.get(user.id, sources[0].id, { includeDeleted: true });
        if (finished.payload.deletion.status === "complete") break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(finished.payload.deletion.status, "complete");
      await assert.rejects(stat(path.join(project.baseDir, sources[0].payload.outputs.artifactPath)), { code: "ENOENT" });
      assert.equal(await readFile(path.join(project.baseDir, "knowledge-base/研究方案.txt"), "utf8"), content);
      assert.equal(await readFile(path.join(project.baseDir, "knowledge-base/研究方案-copy.txt"), "utf8"), content);
      const repeat = await fetch(`${base}/api/sources/${sources[0].id}`, { method: "DELETE", headers,
        body: JSON.stringify({ expectedRevision: sources[0].revision }) });
      assert.equal(repeat.status, 200);
      assert.equal((await repeat.json()).data.payload.deletion.jobId, deleted.payload.deletion.jobId);
    }
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    if (listening) await app.close();
    else await app.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("concurrent source registration preserves every path and assigns unique family versions", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-source-concurrency-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
    databasePoolMax: 1, sourceIngestionEnabled: false });
  const username = `source${randomUUID().slice(0, 8)}`;
  let user;
  try {
    user = await app.store.createUser(username, "test-only-source-password", "Source concurrency fixture");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const manifest = (values = {}) => ({ projectId: project.id, connector: { type: "upload", id: "library" },
      path: "knowledge-base/paper.txt", size: 7, mtime: "2026-09-06T00:00:00.000Z", mimeType: "text/plain",
      sha256: "a".repeat(64), ...values });
    const same = await Promise.all([
      app.sourceService.register(user.id, manifest()),
      app.sourceService.register(user.id, manifest({ path: "knowledge-base/paper-copy.txt" })),
    ]);
    const exact = await app.sourceService.get(user.id, same[0].source.id);
    assert.deepEqual(exact.payload.paths.sort(), ["knowledge-base/paper-copy.txt", "knowledge-base/paper.txt"]);

    const versions = await Promise.all([
      app.sourceService.register(user.id, manifest({ path: "knowledge-base/family.txt", sha256: "b".repeat(64) })),
      app.sourceService.register(user.id, manifest({ path: "knowledge-base/family.txt", sha256: "c".repeat(64) })),
    ]);
    assert.deepEqual(versions.map((item) => item.source.payload.version).sort((a, b) => a - b), [1, 2]);
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
