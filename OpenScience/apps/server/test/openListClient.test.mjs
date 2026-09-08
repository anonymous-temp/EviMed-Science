import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenListClient } from "../src/openListClient.mjs";
import { openListSourceInput } from "../src/openListSourceConnector.mjs";

test("OpenList calls only the pinned list, get and link contracts", async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null });
    if (req.url === "/p/research/%E8%AE%BA%E6%96%87.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": "7" });
      res.end("pdfdata");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/fs/list") res.end(JSON.stringify({ code: 200, data: { content: [
      { name: "论文.pdf", size: 1200, is_dir: false, modified: "2026-09-06T00:00:00Z", hash_info: { sha256: "a".repeat(64) } },
      { name: "资料", size: 0, is_dir: true, modified: "2026-09-06T00:00:00Z" },
    ], total: 2 } }));
    else if (req.url === "/api/fs/get") res.end(JSON.stringify({ code: 200, data: { name: "论文.pdf", size: 1200,
      modified: "2026-09-06T00:00:00Z", hash_info: { sha256: "a".repeat(64) }, raw_url: "https://storage.example/file" } }));
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
  assert.equal((await client.stat("/research/论文.pdf")).providerHash, "sha256:" + "a".repeat(64));
  assert.equal((await client.read("/research/论文.pdf")).toString(), "pdfdata");
  assert.deepEqual(calls.map((call) => call.url), ["/api/fs/list", "/api/fs/get", "/api/fs/link", "/api/fs/get", "/api/fs/link", "/p/research/%E8%AE%BA%E6%96%87.pdf"]);
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

/** @param {any[]} responses */
function fixture(responses) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const payload = responses[Math.min(requests.length - 1, responses.length - 1)];
    const text = JSON.stringify(payload);
    return { ok: true, headers: new Headers({ "content-length": String(Buffer.byteLength(text)) }),
      body: new Blob([text]).stream() };
  };
  return { requests, client: new OpenListClient({ baseUrl: "http://openlist.local", token: "t", fetchImpl }) };
}

const file = (name, hashInfo) => ({ name, size: 11, modified: "2026-09-06T00:00:00.000Z", is_dir: false, hash_info: hashInfo });

test("a directory page carries the provider hash the folder sync compares against", async () => {
  const { client, requests } = fixture([{ code: 200, data: { total: 2, content: [
    file("one.pdf", { sha256: "A".repeat(64) }), { name: "sub", size: 0, is_dir: true },
  ] } }]);
  const page = await client.list("/tenants/user-one/papers", { page: 1, perPage: 100 });
  assert.deepEqual(requests[0].body, { path: "/tenants/user-one/papers", page: 1, per_page: 100, refresh: false });
  assert.equal(requests[0].url, "http://openlist.local/api/fs/list");
  assert.deepEqual(page.entries[0], { path: "/tenants/user-one/papers/one.pdf", name: "one.pdf", size: 11,
    mtime: "2026-09-06T00:00:00.000Z", entryType: "file", providerHash: `sha256:${"a".repeat(64)}` });
  assert.equal(page.entries[1].entryType, "dir");
  assert.equal(page.entries[1].providerHash, null);
  assert.equal(page.nextCursor, null, "a fully covered directory ends the walk");
});

test("paging stops exactly when the reported total is covered", async () => {
  const { client } = fixture([{ code: 200, data: { total: 250, content: Array.from({ length: 100 }, (_, index) => file(`p${index}.pdf`, { sha256: "b".repeat(64) })) } }]);
  assert.equal((await client.list("/papers", { page: 1, perPage: 100 })).nextCursor, "2");
  assert.equal((await client.list("/papers", { page: 2, perPage: 100 })).nextCursor, "3");
  assert.equal((await client.list("/papers", { page: 3, perPage: 100 })).nextCursor, null);
});

test("a storage without SHA-256 is reported honestly instead of being guessed", async () => {
  const { client } = fixture([{ code: 200, data: { total: 2, content: [
    file("legacy.pdf", { md5: "c".repeat(32) }), file("bare.pdf", null),
  ] } }]);
  const page = await client.list("/papers", {});
  assert.equal(page.entries[0].providerHash, `md5:${"c".repeat(32)}`);
  assert.equal(page.entries[1].providerHash, null);
  for (const entry of page.entries) {
    assert.throws(() => openListSourceInput("project-one", entry), { code: "openlist_sha256_required" },
      "a file we cannot content-address must never enter the ledger");
  }
});

test("an oversized or malformed listing is refused, never truncated silently", async () => {
  const { client } = fixture([{ code: 200, data: { total: 1, content: [file("a.pdf", null), file("b.pdf", null)] } }]);
  await assert.rejects(client.list("/papers", { page: 1, perPage: 1 }), { code: "openlist_response_invalid" });
  const bad = fixture([{ code: 200, data: { total: 1, content: [{ name: "../escape.pdf", size: 1, is_dir: false }] } }]);
  await assert.rejects(bad.client.list("/papers", {}), { code: "openlist_response_invalid" });
  await assert.rejects(client.list("/papers", { page: 0 }), { code: "openlist_page_invalid" });
});

test("one entry maps to one source manifest, so import and sync share a version family", () => {
  const entry = { path: "/papers/one.pdf", name: "one.pdf", size: 11, mtime: "2026-09-06T00:00:00.000Z",
    entryType: "file", providerHash: `sha256:${"A".repeat(64)}` };
  const input = openListSourceInput("project-one", entry);
  assert.deepEqual(input, { projectId: "project-one", connector: { type: "openlist", id: "/papers/one.pdf" },
    path: "openlist/papers/one.pdf", size: 11, mtime: "2026-09-06T00:00:00.000Z",
    mimeType: "application/octet-stream", sha256: "a".repeat(64), providerHash: `sha256:${"A".repeat(64)}` });
  assert.equal(openListSourceInput("project-one", { ...entry, mtime: null }, { now: () => new Date("2026-09-07T00:00:00.000Z") }).mtime,
    "2026-09-07T00:00:00.000Z");
});
