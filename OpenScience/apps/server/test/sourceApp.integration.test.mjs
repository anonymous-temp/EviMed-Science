import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  try {
    user = await app.store.createUser(username, "test-only-source-password", "Source fixture");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const address = await app.listen(0, "127.0.0.1");
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
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
