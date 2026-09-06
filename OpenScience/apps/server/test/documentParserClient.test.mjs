import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DocumentParserClient } from "../src/documentParserClient.mjs";

test("plain text has a bounded local fallback with complete chunk coverage", async () => {
  const root = await mkdtemp(path.join("/tmp", "evimed-parser-client-"));
  try {
    const file = path.join(root, "研究笔记.txt");
    await writeFile(file, `${"中文研究内容。".repeat(900)}\n\n结论段。`, "utf8");
    const client = new DocumentParserClient({ baseUrl: "", maxTextBytes: 64 * 1024, chunkChars: 2048 });
    const result = await client.parse({ path: file, mimeType: "text/plain", sha256: "a".repeat(64), sourceId: "source-one" });
    assert.equal(result.extractor.parser, "fallback");
    assert.ok(result.units.length > 1);
    assert.equal(result.units.every((unit) => unit.status === "extracted" && unit.unitType === "chunk"), true);
    assert.match(result.summary, /中文研究内容/);
    assert.equal(result.text.includes("结论段"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an empty source is preserved as empty text rather than an invented source sentence", async t => {
  const root = await mkdtemp(path.join("/tmp", "evimed-empty-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "empty.txt"); await writeFile(file, "");
  const result = await new DocumentParserClient().parse({ path: file, mimeType: "text/plain", sha256: "a".repeat(64), sourceId: "empty" });
  assert.equal(result.text, ""); assert.equal(result.units[0].status, "no_content");
});

test("the configured parser uses the bounded MinerU service contract", async (t) => {
  let request = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    request = { url: req.url, method: req.method, authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      protocolVersion: 1,
      extractor: { name: "mineru", version: "3.4.5", parser: "mineru" },
      units: [{ id: "page-1", unitType: "page", status: "extracted", itemIds: ["fact-1"] }],
      summary: "MinerU parsed a Chinese formula document.",
      facts: [{ id: "fact-1", content: "E = mc^2", provenance: { unitId: "page-1", span: "E = mc^2" } }],
      methods: [], text: "# Document\n\nE = mc^2",
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new DocumentParserClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "test-only-parser-token" });
  const result = await client.parse({ path: "/data/users/user/project/论文.pdf", mimeType: "application/pdf",
    sha256: "b".repeat(64), sourceId: "source-two" });
  assert.equal(result.extractor.name, "mineru");
  assert.deepEqual(request, {
    url: "/v1/parse", method: "POST", authorization: "Bearer test-only-parser-token",
    body: { path: "/data/users/user/project/论文.pdf", mimeType: "application/pdf", sha256: "b".repeat(64), sourceId: "source-two" },
  });
});

test("an invalid or oversized parser response fails closed", async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ protocolVersion: 1, units: [], summary: "x".repeat(5000) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new DocumentParserClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, maxResponseBytes: 1024 });
  await assert.rejects(() => client.parse({ path: "/data/file.pdf", mimeType: "application/pdf", sha256: "c".repeat(64), sourceId: "source-three" }),
    (error) => error.code === "source_parser_response_too_large");
});
