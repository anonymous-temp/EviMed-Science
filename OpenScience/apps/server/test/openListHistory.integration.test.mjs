import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { signedIn, databaseUrl } from "./helpers/knowledgeBaseApp.mjs";

test("OpenList captures historical originals through HTTP and preserves old bytes after remote replacement", { skip: !databaseUrl }, async () => {
  let bytes = Buffer.from("first original");
  let badDownload = false;
  const hash = () => createHash("sha256").update(bytes).digest("hex");
  const provider = createServer(async (req, res) => {
    if (req.url.startsWith("/p/")) { res.end(badDownload ? "tampered" : bytes); return; }
    const row = { name: "paper.txt", size: bytes.length, modified: "2026-10-24T00:00:00Z", hash_info: { sha256: hash() }, is_dir: false };
    const data = req.url.endsWith("/link") ? { url: "https://unused.invalid/file" }
      : req.url.endsWith("/list") ? { content: [row], total: 1 } : row;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const ctx = await signedIn({ openListUrl: origin, openListToken: "test-only", sourceIngestionEnabled: true });
  const importFile = async () => {
    const response = await fetch(`${ctx.base}/api/sources/openlist/import`, { method: "POST", headers: ctx.headers,
      body: JSON.stringify({ projectId: ctx.project.id, path: "/paper.txt" }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    // A pre-upgrade source registered provider metadata without retaining original bytes.
    const prepare = ctx.app.sourceService.prepareRegistration;
    ctx.app.sourceService.prepareRegistration = null;
    const legacy = await ctx.app.sourceService.register(ctx.user.id, { projectId: ctx.project.id,
      connector: { type: "openlist", id: "/legacy.txt" }, path: "openlist/legacy.txt", size: bytes.length,
      sha256: hash(), providerHash: `sha256:${hash()}`, mtime: "2026-10-24T00:00:00Z", mimeType: "text/plain" });
    ctx.app.sourceService.prepareRegistration = prepare;
    const recovered = await ctx.app.sourceService.register(ctx.user.id, { projectId: ctx.project.id,
      connector: { type: "openlist", id: "/legacy.txt" }, path: "openlist/legacy.txt", size: bytes.length,
      sha256: hash(), providerHash: `sha256:${hash()}`, mtime: "2026-10-24T00:00:00Z", mimeType: "text/plain" });
    assert.equal(recovered.source.id, legacy.source.id);
    assert.match(recovered.source.payload.paths[0], /^knowledge-base\/\.evimed-revisions\//);
    const first = await importFile(); assert.equal(first.status, 201, JSON.stringify(first.body));
    const old = first.body.data.source;
    const oldPath = old.payload.paths[0];
    assert.match(oldPath, /^knowledge-base\/\.evimed-revisions\//);
    assert.equal(await readFile(path.join(ctx.project.baseDir, oldPath), "utf8"), "first original");
    assert.equal((await importFile()).body.data.source.id, old.id);
    bytes = Buffer.from("second original");
    // A historical metadata-only manifest cannot acquire today's changed bytes as its original.
    await assert.rejects(ctx.app.sourceService.register(ctx.user.id, { projectId: ctx.project.id,
      connector: { type: "openlist", id: "/uncaptured-legacy.txt" }, path: "openlist/uncaptured-legacy.txt",
      size: Buffer.byteLength("first original"), sha256: legacy.source.payload.fingerprint.sha256,
      providerHash: `sha256:${legacy.source.payload.fingerprint.sha256}`, mtime: "2026-10-24T00:00:00Z" }),
    { code: "openlist_source_changed" });
    const second = await importFile(); assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.data.source.id, old.id);
    assert.equal(await readFile(path.join(ctx.project.baseDir, oldPath), "utf8"), "first original");
    const historical = await fetch(`${ctx.base}/api/files/download/${encodeURIComponent(oldPath)}`, { headers: ctx.headers });
    assert.equal(historical.status, 200); assert.equal(await historical.text(), "first original");
    const recoveredDownload = await fetch(`${ctx.base}/api/files/download/${encodeURIComponent(recovered.source.payload.paths[0])}`, { headers: ctx.headers });
    assert.equal(recoveredDownload.status, 200); assert.equal(await recoveredDownload.text(), "first original");
    const folder = await ctx.app.sourceService.registerFolder(ctx.user.id, { projectId: ctx.project.id, path: "/folder" });
    let claimed;
    for (let index = 0; index < 20; index++) {
      const job = await ctx.app.sourceWorker.jobs.claim(["ingest"], "openlist-history-test", { leaseMs: 60000 });
      if (!job) break;
      if (job.id === folder.job.id) { claimed = job; break; }
    }
    assert.ok(claimed);
    const synced = await ctx.app.sourceService.consumeFolderSync(claimed);
    assert.equal(synced.registered, 1);
    const savedFolder = await ctx.app.sourceService.documents.get(ctx.user.id, "preferences", folder.folder.id);
    const tracked = savedFolder.payload.entries["/folder/paper.txt"];
    assert.ok(tracked);
    const capturedFolder = await ctx.app.sourceService.get(ctx.user.id, tracked.sourceId);
    assert.equal(await readFile(path.join(ctx.project.baseDir, capturedFolder.payload.paths[0]), "utf8"), "second original");
    badDownload = true; bytes = Buffer.from("third original");
    assert.equal((await importFile()).status, 409);
    badDownload = false; bytes = Buffer.from("second original");
    const currentPath = second.body.data.source.payload.paths[0];
    await writeFile(path.join(ctx.project.baseDir, currentPath), "modified local snapshot");
    const corrupted = await importFile();
    assert.equal(corrupted.status, 409);
    assert.equal(await readFile(path.join(ctx.project.baseDir, currentPath), "utf8"), "modified local snapshot");
    assert.equal(await readFile(path.join(ctx.project.baseDir, oldPath), "utf8"), "first original");
  } finally { await ctx.close(); await new Promise(resolve => provider.close(resolve)); }
});

test("source-bound OpenList files serve captured PDF and Office originals before parsing and after different parsed text", { skip: !databaseUrl, timeout: 30_000 }, async () => {
  let bytes = Buffer.alloc(0); let name = "paper.pdf";
  const provider = createServer(async (req, res) => {
    if (req.url.startsWith("/p/")) { res.end(bytes); return; }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const row = { name, size: bytes.length, modified: "2026-10-27T00:00:00Z", hash_info: { sha256 }, is_dir: false };
    const data = req.url.endsWith("/link") ? { url: "https://unused.invalid/file" } : row;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const parsed = "Parsed index text differs from every preserved original.";
  const ctx = await signedIn({ openListUrl: `http://127.0.0.1:${provider.address().port}`, openListToken: "test-only",
    documentParserFetch: async () => new Response(JSON.stringify({ code: 200, message: "success", uuid: "test", timestamp: 1,
      elapsed_ms: 1, data: { title: "Parsed document", content: parsed, pages: [{ index: 1, start: 0, end: parsed.length, status: "ok" }] } }), { status: 200 }) });
  const assertOriginal = async source => {
    for (const mode of ["read", "preview", "download"]) {
      const response = await fetch(`${ctx.base}/api/sources/${source.id}/file?mode=${mode}`, { headers: ctx.headers });
      assert.equal(response.status, 200); assert.equal(response.headers.get("x-evimed-source-file"), "original");
      if (mode === "read") {
        const file = (await response.json()).data;
        assert.equal(file.path, source.payload.paths[0]); assert.equal(file.representation, "original"); assert.equal(file.encoding, "base64");
        assert.deepEqual(Buffer.from(file.data, "base64"), bytes);
      } else assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
  };
  try {
    let last = null;
    const xlsx = await readFile(new URL("./fixtures/materials/supplement.xlsx", import.meta.url));
    for (const sample of [{ name: "paper.pdf", bytes: Buffer.from("%PDF-1.4\nCaptured original PDF\n%%EOF\n") }, { name: "supplement.xlsx", bytes: xlsx }]) {
      name = sample.name; bytes = sample.bytes;
      const imported = await fetch(`${ctx.base}/api/sources/openlist/import`, { method: "POST", headers: ctx.headers,
        body: JSON.stringify({ projectId: ctx.project.id, path: `/${name}` }) });
      assert.equal(imported.status, 201); const source = (await imported.json()).data.source;
      assert.match(source.payload.paths[0], /^knowledge-base\/\.evimed-revisions\//); assert.equal(source.payload.outputs?.artifactPath, undefined);
      await assertOriginal(source);
      const current = await ctx.app.sourceService.get(ctx.user.id, source.id);
      await ctx.app.sourceService.override(ctx.user.id, source.id, { expectedRevision: current.revision,
        docType: current.payload.docType, depth: "index_only", reason: "Original-file regression fixture." });
      let settled;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await ctx.app.sourceWorker.tick(); settled = await ctx.app.sourceService.get(ctx.user.id, source.id);
        if (settled.payload.status === "complete") break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(settled.payload.status, "complete");
      assert.notEqual(settled.payload.outputs.artifactPath, settled.payload.paths[0]);
      assert.ok((await readFile(path.join(ctx.project.baseDir, settled.payload.outputs.artifactPath), "utf8")).includes(parsed));
      await assertOriginal(settled); last = settled;
    }
    // An old manifest with only a remote locator has no captured-original pointer.
    const legacy = await ctx.app.sourceService.documents.put(ctx.user.id, "source", last.id,
      { ...last.payload, paths: ["openlist/legacy/supplement.xlsx"] }, { projectId: ctx.project.id, expectedRevision: last.revision });
    const parsedBytes = await readFile(path.join(ctx.project.baseDir, legacy.payload.outputs.artifactPath));
    for (const mode of ["read", "preview", "download"]) {
      const response = await fetch(`${ctx.base}/api/sources/${legacy.id}/file?mode=${mode}`, { headers: ctx.headers });
      assert.equal(response.status, 200); assert.equal(response.headers.get("x-evimed-source-file"), "parsed-text");
      if (mode === "read") {
        const file = (await response.json()).data; assert.equal(file.representation, "parsed-text");
        assert.equal(file.path, legacy.payload.outputs.artifactPath); assert.equal(file.encoding, "utf8");
        assert.equal(file.data, parsedBytes.toString("utf8")); assert.notEqual(file.mime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      } else assert.deepEqual(Buffer.from(await response.arrayBuffer()), parsedBytes);
    }
  } finally { await ctx.close(); await new Promise(resolve => provider.close(resolve)); }
});
