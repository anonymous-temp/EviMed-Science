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
    // This fixture exercises upload, parsing, indexing and deletion. Structured
    // understanding has a separate bounded-runtime integration fixture.
    await app.sourceWorker.close();
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
    const registered = await app.sourceService.get(user.id, firstBody.data.source.id);
    await app.sourceService.override(user.id, registered.id, { expectedRevision: registered.revision,
      docType: registered.payload.docType, depth: "index_only", reason: "Parser and source-file lifecycle fixture." });
    await app.sourceWorker.tick(); // Retire the superseded initial-depth job.
    await app.sourceWorker.tick(); // Consume the explicitly selected index job.

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
    assert.equal(jobs.rowCount, 2, "one admission per explicitly selected generation");
    assert.ok(jobs.rows.every(job => job.status === "succeeded"));
    const processed = await app.sourceService.get(user.id, sources[0].id);
    const privateRun = { id: "fixture-run", sessionId: "fixture-session", dispatchId: "fixture-dispatch",
      workspaceName: "private-workspace", artifactDirectory: "private-derived-directory" };
    const seeded = await app.sourceService.documents.put(user.id, "source", processed.id, {
      ...processed.payload, analysis: { ...processed.payload.analysis, run: privateRun }, pendingRunCancellations: [privateRun],
    }, { expectedRevision: processed.revision, projectId: project.id });
    const duplicateProcessed = await upload("研究方案-copy.txt");
    assert.equal(duplicateProcessed.status, 200);
    const publicDuplicate = await duplicateProcessed.json();
    assert.equal(publicDuplicate.data.duplicate, true);
    assert.equal(publicDuplicate.data.source.payload.analysis.run.id, "fixture-run");
    for (const privateValue of ["private-workspace", "private-derived-directory", "pendingRunCancellations", "artifactDirectory", "workspaceName"]) {
      assert.equal(JSON.stringify(publicDuplicate).includes(privateValue), false, privateValue);
    }
    sources[0] = await app.sourceService.documents.put(user.id, "source", processed.id, processed.payload,
      { expectedRevision: seeded.revision, projectId: project.id });
    if (process.platform === "linux") {
      const removal = await fetch(`${base}/api/sources/${sources[0].id}`, { method: "DELETE", headers,
        body: JSON.stringify({ expectedRevision: sources[0].revision }) });
      assert.equal(removal.status, 200);
      const deleted = (await removal.json()).data;
      await app.sourceWorker.tick();
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

/** A signed-in client of a fresh app, with the worker stopped so a test drives it. */
async function signedIn(overrides = {}) {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-source-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
    sourceIngestionEnabled: true, sourceIngestionPollMs: 100, sourceIngestionLeaseMs: 1000, ...overrides });
  const username = `source${randomUUID().slice(0, 8)}`;
  const user = await app.store.createUser(username, "test-only-source-password", "Source fixture");
  const project = await app.store.defaultProject(await app.store.userById(user.id));
  const address = await app.listen(0, "127.0.0.1");
  await app.sourceWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "test-only-source-password" }) });
  const auth = await login.json();
  const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0],
    "x-open-science-csrf": auth.data.csrfToken, "x-open-science-project": project.id };
  const close = async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { app, user, project, base, headers, close };
}

/** Drive the stopped worker until the source reaches a settled state. */
async function settle(app, userId, sourceId) {
  let current;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await app.sourceWorker.tick();
    current = await app.sourceService.get(userId, sourceId);
    if (["complete", "needs_attention", "failed"].includes(current.payload.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return current;
}

test("the page's own upload command makes a source, and a format the knowledge base cannot read is never written", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const { user, project, base, headers, close } = await signedIn();
  try {
    // FilesPage uploads through /api/commands/upload_file. Until 2026-09-20 that
    // command wrote the file and registered nothing, so no upload from the page
    // ever became a source.
    const command = (filename, data = "笔记内容") => fetch(`${base}/api/commands/upload_file`, { method: "POST", headers,
      body: JSON.stringify({ root: "base", filename, data, encoding: "utf8" }) });
    const note = await command("knowledge-base/房颤笔记.md");
    assert.equal(note.status, 200);
    const inventory = await (await fetch(`${base}/api/sources?projectId=${encodeURIComponent(project.id)}`, { headers })).json();
    assert.deepEqual(inventory.data.items.map((item) => item.payload.paths), [["knowledge-base/房颤笔记.md"]]);

    const recording = await command("knowledge-base/查房录音.mp3");
    assert.equal(recording.status, 415);
    assert.equal((await recording.json()).code, "source_media_unsupported");
    await assert.rejects(stat(path.join(project.baseDir, "knowledge-base/查房录音.mp3")), { code: "ENOENT" });

    const data = await fetch(`${base}/api/files/upload`, { method: "POST", headers,
      body: JSON.stringify({ root: "base", path: "knowledge-base/cohort.sav", data: "x", encoding: "utf8" }) });
    assert.equal(data.status, 415);
    assert.equal((await data.json()).code, "source_format_unsupported");
    await assert.rejects(stat(path.join(project.baseDir, "knowledge-base/cohort.sav")), { code: "ENOENT" });

    // Outside the knowledge base the workspace takes any file, as before.
    const elsewhere = await command("analysis/cohort.sav");
    assert.equal(elsewhere.status, 200);
    const after = await (await fetch(`${base}/api/sources?projectId=${encodeURIComponent(project.id)}`, { headers })).json();
    assert.equal(after.data.items.length, 1);
    assert.equal(user.id.length > 0, true);
  } finally { await close(); }
});

test("a parsed document keeps its checked metadata, its page map and a paged index.md", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const content = "第一页：房颤患者的抗凝治疗。\r\n第二页：利伐沙班 15 mg 每日一次。";
  const seen = [];
  const documentParserFetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers.authorization });
    return new Response(JSON.stringify({ code: 200, message: "success", uuid: "U-1", timestamp: 1, elapsed_ms: 5, data: {
      title: "房颤抗凝治疗专家共识", authors: ["王五"], abstract: "", doi: "10.1234/afib.2024.1", content,
      pages: [{ index: 1, start: 0, end: 16, status: "ok" }, { index: 2, start: 16, end: content.length, status: "ok" }],
    } }), { status: 200, headers: { "x-quota-cost": "1", "x-quota-remaining": "41" } });
  };
  const sourceMetadataFetch = async () => new Response(JSON.stringify({ message: { title: ["房颤抗凝治疗专家共识"] } }), { status: 200 });
  const { app, user, project, base, headers, close } = await signedIn({
    documentParserUrl: "http://parser.test", documentParserToken: "sk-test-only", documentParserFetch, sourceMetadataFetch,
  });
  try {
    const bytes = Buffer.from("%PDF-1.4\nsynthetic\n");
    const uploaded = await fetch(`${base}/api/files/upload`, { method: "POST", headers,
      body: JSON.stringify({ root: "base", path: "knowledge-base/房颤共识.pdf", data: bytes.toString("base64"), encoding: "base64" }) });
    assert.equal(uploaded.status, 200);
    const registered = (await uploaded.json()).data.source;
    const source = await app.sourceService.get(user.id, registered.id);
    // Index only: this fixture is about the parse, not the understanding run.
    await app.sourceService.override(user.id, source.id, { expectedRevision: source.revision, docType: source.payload.docType,
      depth: "index_only", reason: "Parse and page-map fixture." });
    const done = await settle(app, user.id, source.id);
    assert.equal(done.payload.status, "complete");
    assert.deepEqual(seen.map((request) => [new URL(request.url).pathname, request.authorization]),
      [["/api/v1/extract/text/file", "Bearer sk-test-only"]]);
    assert.equal(done.payload.metadata.title, "房颤抗凝治疗专家共识");
    assert.equal(done.payload.metadata.doi, "10.1234/afib.2024.1");
    assert.equal(done.payload.metadata.doiCheck.status, "verified");
    assert.equal(done.payload.analysis.pageCount, 2);
    assert.equal(done.payload.extractor.quota.remaining, 41);
    const capture = await app.sourceService.loadCapture(user.id, done);
    // The CRLF inside page one is folded by the capture, and the page map moved with it.
    assert.deepEqual(capture.pageMap, [{ page: 1, start: 0, end: 15, status: "ok" }, { page: 2, start: 15, end: content.length - 1, status: "ok" }]);
    assert.equal(capture.input.text.slice(15), "第二页：利伐沙班 15 mg 每日一次。");
    const index = await readFile(path.join(project.baseDir, done.payload.outputs.artifactPath), "utf8");
    assert.match(index, /^# 房颤抗凝治疗专家共识$/m);
    assert.match(index, /^DOI: 10\.1234\/afib\.2024\.1$/m);
    assert.match(index, /^<!-- page 1 -->\n第一页：房颤患者的抗凝治疗。\n<!-- page 2 -->\n第二页：利伐沙班 15 mg 每日一次。$/m);
  } finally { await close(); }
});
