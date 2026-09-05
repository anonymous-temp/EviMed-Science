import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenListClient } from "../src/openListClient.mjs";

test("OpenList calls only the pinned list, get and link contracts", async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/fs/list") res.end(JSON.stringify({ code: 200, data: { content: [
      { name: "论文.pdf", size: 1200, is_dir: false, modified: "2026-09-06T00:00:00Z", hash_info: { sha256: "a".repeat(64) } },
      { name: "资料", size: 0, is_dir: true, modified: "2026-09-06T00:00:00Z" },
    ], total: 2 } }));
    else if (req.url === "/api/fs/get") res.end(JSON.stringify({ code: 200, data: { name: "论文.pdf", size: 1200, raw_url: "https://storage.example/file" } }));
    else res.end(JSON.stringify({ code: 200, data: { url: "https://storage.example/file", header: { Referer: "https://storage.example" } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new OpenListClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test-only-openlist-token" });

  const listed = await client.list("/research", { page: 1, perPage: 100, refresh: true });
  assert.equal(listed.entries[0].path, "/research/论文.pdf");
  assert.equal(listed.entries[0].providerHash, "sha256:" + "a".repeat(64));
  assert.equal(listed.entries[1].entryType, "dir");
  assert.equal(listed.nextCursor, null);
  assert.equal((await client.get("/research/论文.pdf")).name, "论文.pdf");
  assert.equal((await client.link("/research/论文.pdf")).url, "https://storage.example/file");
  assert.deepEqual(calls.map((call) => call.url), ["/api/fs/list", "/api/fs/get", "/api/fs/link"]);
  assert.equal(calls.every((call) => call.authorization === "test-only-openlist-token"), true);
});

test("OpenList application errors and oversized responses fail closed", async (t) => {
  let oversized = false;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(oversized ? JSON.stringify({ code: 200, data: { content: [{ name: "x".repeat(4096) }] } })
      : JSON.stringify({ code: 500, message: "driver unavailable" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new OpenListClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test-token", maxResponseBytes: 1024 });
  await assert.rejects(() => client.list("/"), (error) => error.code === "openlist_request_failed");
  oversized = true;
  await assert.rejects(() => client.list("/"), (error) => error.code === "openlist_response_too_large");
});
