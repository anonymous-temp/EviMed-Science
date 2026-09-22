import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DocumentParserClient, normalizeDoi } from "../src/documentParserClient.mjs";

const REVISION = "evimed-extract@0.5.0";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PDF = Buffer.from("%PDF-1.4\n% a synthetic document\n");

/** The envelope the service writes (`write_response`), status and all. */
function envelope(code, data, message = code === 200 ? "success" : "error") {
  return JSON.stringify({ code, message, uuid: "C78339AE-7D25-4948-8826-2641556A5A06", timestamp: 1789810626, elapsed_ms: 12, data });
}

/**
 * A scripted parser: each request takes the next answer off the list. The
 * multipart body is decoded with the platform's own parser, so a field the
 * client forgot — or named differently — fails here the way it would there.
 */
async function withParser(t, answers) {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let form = null;
    if (String(request.headers["content-type"] ?? "").startsWith("multipart/form-data")) {
      form = await new Response(body, { headers: { "content-type": request.headers["content-type"] } }).formData();
    }
    seen.push({ method: request.method, url: request.url, headers: request.headers, form });
    const answer = answers.shift() ?? { status: 599, body: "{}" };
    if (answer.hang) return;
    response.writeHead(answer.status, { "content-type": "application/json; charset=UTF-8", ...(answer.headers ?? {}) });
    response.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, seen };
}

/** A client whose waits are recorded instead of slept. */
function client(baseUrl, options = {}) {
  const waits = [];
  const instance = new DocumentParserClient({ baseUrl, revision: REVISION, sleep: async (ms) => { waits.push(ms); }, ...options });
  return Object.assign(instance, { waits });
}

test("plain-text formats are read here, byte for byte, and cost the parser nothing", async (t) => {
  const root = await mkdtemp(path.join("/tmp", "evimed-parser-client-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "研究笔记.txt");
  const text = `${"中文研究内容。".repeat(900)}\r\n\n结论段：利伐沙班 15 mg qd。`;
  await writeFile(file, text, "utf8");
  const result = await new DocumentParserClient({ baseUrl: "http://127.0.0.1:9", chunkChars: 2048 })
    .parse({ path: file, mimeType: "text/plain", sha256: sha(Buffer.from(text, "utf8")), sourceId: "source-one" });
  assert.deepEqual(result.extractor, { name: "plain-text", version: "1.0.0", parser: "local" });
  assert.equal(result.text, text, "the text is the file, including its line endings; the capture normalizes them later");
  assert.ok(result.units.length > 1);
  assert.equal(result.units.every((unit) => unit.status === "extracted" && unit.unitType === "chunk"), true);
  assert.match(result.summary, /中文研究内容/);
  assert.equal(result.protocolVersion, 1);
});

test("a CSV saved as GB18030 is decoded, not stored as replacement characters", async () => {
  // 「利伐沙班」 in GB18030, as Excel writes a CSV on a Chinese Windows machine.
  const bytes = Buffer.concat([Buffer.from("drug,dose\n"), Buffer.from([0xc0, 0xfb, 0xb7, 0xa5, 0xc9, 0xb3, 0xb0, 0xe0]), Buffer.from(",15mg\n")]);
  const result = await new DocumentParserClient().parseBytes({ bytes, filename: "剂量表.csv" });
  assert.equal(result.text, "drug,dose\n利伐沙班,15mg\n");
});

test("an empty source is preserved as empty text rather than an invented sentence", async () => {
  const result = await new DocumentParserClient().parseBytes({ bytes: Buffer.alloc(0), filename: "empty.md" });
  assert.equal(result.text, "");
  assert.equal(result.units[0].status, "no_content");
  assert.equal(result.summary, "The source contains no extractable text.");
});

test("recordings and unknown formats are refused by name, before any byte is read or sent", async (t) => {
  const { baseUrl, seen } = await withParser(t, []);
  const parser = client(baseUrl);
  await assert.rejects(parser.parseBytes({ bytes: PDF, filename: "查房录音.m4a" }), (error) => error.code === "source_media_unsupported" && error.status === 415);
  await assert.rejects(parser.parseBytes({ bytes: PDF, filename: "cohort.sav" }), (error) => error.code === "source_format_unsupported" && error.status === 415);
  // parse() refuses on the name alone: a path that does not even exist.
  await assert.rejects(parser.parse({ path: "/nonexistent/visit.mp4", sha256: "a".repeat(64) }), { code: "source_media_unsupported" });
  assert.equal(seen.length, 0);
});

test("a document the parser must read fails with a stated reason when no parser is configured", async () => {
  await assert.rejects(new DocumentParserClient().parseBytes({ bytes: PDF, filename: "指南.pdf" }),
    (error) => error.code === "source_parser_unconfigured" && error.status === 503);
});

test("bytes that do not hash to their registered digest are refused before upload", async (t) => {
  const { baseUrl, seen } = await withParser(t, []);
  await assert.rejects(client(baseUrl).parseBytes({ bytes: PDF, filename: "a.pdf", sha256: "0".repeat(64) }),
    (error) => error.code === "source_changed" && error.status === 409);
  assert.equal(seen.length, 0);
});

test("the extract endpoint gets the bytes, their checksum, the name and the format, and its answer becomes protocol v1", async (t) => {
  const { baseUrl, seen } = await withParser(t, [{
    status: 200,
    headers: { "x-quota-unit": "credit", "x-quota-cost": "1", "x-quota-remaining": "99" },
    body: envelope(200, {
      title: " 利伐沙班在老年房颤患者中的安全性 ",
      authors: "张三",
      abstract: "本研究评估了……",
      keywords: ["房颤", "抗凝", 7],
      publication_date: "2024-01",
      source: "中华心血管病杂志",
      doi: "https://doi.org/10.1234/ABC.2024.001.",
      content: "第一页正文\n\n第二页正文",
    }),
  }]);
  const parser = client(baseUrl, { token: "sk-test-only" });
  const result = await parser.parseBytes({ bytes: PDF, filename: "房颤指南.PDF", mediaType: "application/pdf" });
  assert.equal(seen.length, 1);
  const [request] = seen;
  assert.equal(request.url, "/api/v1/extract/text/file");
  assert.equal(request.headers.authorization, "Bearer sk-test-only");
  const file = request.form.get("file");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  assert.equal(request.form.get("checksum"), sha(PDF));
  assert.equal(request.form.get("filename"), "房颤指南.PDF");
  assert.equal(request.form.get("format"), "pdf");

  assert.equal(result.protocolVersion, 1);
  assert.equal(result.text, "第一页正文\n\n第二页正文");
  assert.equal(result.summary, "本研究评估了……", "the abstract is the summary when there is one");
  assert.deepEqual(result.metadata, {
    title: "利伐沙班在老年房颤患者中的安全性",
    authors: ["张三"],
    abstract: "本研究评估了……",
    keywords: ["房颤", "抗凝"],
    publicationDate: "2024-01",
    source: "中华心血管病杂志",
    doi: "10.1234/ABC.2024.001",
  });
  assert.deepEqual(result.extractor, {
    name: "evimed-extract", version: REVISION, parser: "api", endpoint: "extract",
    requestId: "C78339AE-7D25-4948-8826-2641556A5A06", quota: { unit: "credit", cost: 1, remaining: 99 },
  });
  assert.deepEqual(result.units, [{ id: "document", unitType: "segment", status: "extracted", itemIds: [] }]);
  assert.deepEqual([result.facts, result.methods], [[], []]);
  assert.equal("pageMap" in result, false, "no pages sent, no page map invented");
});

test("pages light up the page map, converted from the service's code points to our UTF-16 units", async (t) => {
  // 𠀀 is outside the BMP: one code point, two UTF-16 units. Every offset after
  // it moves by one in our units.
  const content = "𠀀页一正文页二正文";
  const { baseUrl } = await withParser(t, [{
    status: 200,
    body: envelope(200, { content, pages: [
      { index: 1, start: 0, end: 5, status: "ok" },
      { index: 2, start: 5, end: 5, status: "ocr_failed" },
      { index: 3, start: 5, end: 9, status: "ok" },
    ] }),
  }]);
  const result = await client(baseUrl).parseBytes({ bytes: PDF, filename: "scan.pdf" });
  assert.deepEqual(result.pageMap, [
    { page: 1, start: 0, end: 6, status: "ok" },
    { page: 2, start: 6, end: 6, status: "ocr_failed" },
    { page: 3, start: 6, end: 10, status: "ok" },
  ]);
  assert.equal(content.slice(6, 10), "页二正文");
  assert.deepEqual(result.units.map((unit) => [unit.id, unit.unitType, unit.status]), [
    ["page-1", "page", "extracted"], ["page-2", "page", "failed"], ["page-3", "page", "extracted"],
  ]);
});

test("a page map that does not fit its text is dropped and the document is kept", async (t) => {
  const { baseUrl } = await withParser(t, [{
    status: 200, body: envelope(200, { content: "短文", pages: [{ index: 1, start: 0, end: 40, status: "ok" }] }),
  }]);
  const result = await client(baseUrl).parseBytes({ bytes: PDF, filename: "a.pdf" });
  assert.equal(result.text, "短文");
  assert.equal("pageMap" in result, false);
  assert.equal(result.extractor.pageMapDropped, "pages_out_of_range");
});

test("an outage is retried with backoff, and a named Retry-After is honoured", async (t) => {
  const { baseUrl, seen } = await withParser(t, [
    { status: 503, headers: { "retry-after": "2" }, body: envelope(503, { error_code: "service_draining" }) },
    { status: 429, body: envelope(429, { error_code: "rate_limited" }) },
    { status: 200, body: envelope(200, { content: "终于解析了" }) },
  ]);
  const parser = client(baseUrl);
  const result = await parser.parseBytes({ bytes: PDF, filename: "a.pdf" });
  assert.equal(result.text, "终于解析了");
  assert.equal(seen.length, 3);
  assert.deepEqual(parser.waits, [2000, 4000], "the service's own wait first, then the second backoff step");
});

test("three failed attempts end on the named failure, not a fourth request", async (t) => {
  const { baseUrl, seen } = await withParser(t, [
    { status: 429, body: envelope(429, null) },
    { status: 429, body: envelope(429, null) },
    { status: 429, body: envelope(429, null) },
  ]);
  await assert.rejects(client(baseUrl).parseBytes({ bytes: PDF, filename: "a.pdf" }), { code: "source_parser_rate_limited" });
  assert.equal(seen.length, 3);
});

test("an exhausted quota is final on the first answer", async (t) => {
  const { baseUrl, seen } = await withParser(t, [{ status: 429, body: envelope(429, { error_code: "quota_exhausted" }) }]);
  await assert.rejects(client(baseUrl).parseBytes({ bytes: PDF, filename: "a.pdf" }),
    (error) => error.code === "source_parser_quota_exhausted" && error.status === 503);
  assert.equal(seen.length, 1);
});

test("a 500 is retried once and then named", async (t) => {
  const bug = envelope(500, null, "'AttributeError' object has no attribute 'message'");
  const { baseUrl, seen } = await withParser(t, [{ status: 500, body: bug }, { status: 500, body: bug }]);
  await assert.rejects(client(baseUrl).parseBytes({ bytes: PDF, filename: "a.pdf" }),
    (error) => error.code === "source_parser_internal_error" && error.status === 502);
  assert.equal(seen.length, 2);
});

test("a metadata failure that survives its retries falls back once to the text-only endpoint", async (t) => {
  const upstream = { status: 502, body: envelope(502, { error_code: "upstream_error" }) };
  const { baseUrl, seen } = await withParser(t, [upstream, upstream, upstream,
    { status: 200, headers: { "x-quota-cost": "1" }, body: envelope(200, { content: "仍然拿到了正文" }) }]);
  const result = await client(baseUrl).parseBytes({ bytes: PDF, filename: "a.pdf" });
  assert.deepEqual(seen.map((request) => request.url), [
    "/api/v1/extract/text/file", "/api/v1/extract/text/file", "/api/v1/extract/text/file", "/api/v1/parse/file",
  ]);
  assert.equal(result.text, "仍然拿到了正文");
  assert.equal(result.extractor.endpoint, "parse");
  assert.equal("metadata" in result, false);
  assert.equal(result.summary, "仍然拿到了正文");
});

for (const [status, errorCode, code, mapped] of [
  [413, "payload_too_large", "source_parser_payload_too_large", 413],
  [415, "unsupported_format", "source_format_unsupported", 415],
  [422, "checksum_failed", "source_parser_checksum_failed", 422],
  [401, "invalid_api_key", "source_parser_auth_failed", 502],
  [403, "insufficient_scope", "source_parser_auth_failed", 502],
  [400, "missing_format", "source_parser_rejected", 502],
]) {
  test(`HTTP ${status} is final on the first answer, as ${code}`, async (t) => {
    const { baseUrl, seen } = await withParser(t, [{ status, body: envelope(status, { error_code: errorCode }) }]);
    const parser = client(baseUrl);
    await assert.rejects(parser.parseBytes({ bytes: PDF, filename: "a.pdf" }), (error) => error.code === code && error.status === mapped);
    assert.equal(seen.length, 1);
    assert.deepEqual(parser.waits, []);
  });
}

test("the whole parse is bounded by the client timeout, retries included", async (t) => {
  const { baseUrl } = await withParser(t, [{ hang: true }]);
  const started = Date.now();
  await assert.rejects(new DocumentParserClient({ baseUrl, timeoutMs: 1000 }).parseBytes({ bytes: PDF, filename: "a.pdf" }),
    (error) => error.code === "source_parser_timeout" && error.status === 503);
  assert.ok(Date.now() - started < 5000);
});

test("a success that is not the envelope, or is larger than the client reads, fails closed", async (t) => {
  const { baseUrl } = await withParser(t, [
    { status: 200, body: JSON.stringify({ code: 200, data: { title: "no content field" } }) },
    { status: 200, body: envelope(200, { content: "x".repeat(4096) }) },
  ]);
  await assert.rejects(client(baseUrl).parseBytes({ bytes: PDF, filename: "a.pdf" }), { code: "source_parser_response_invalid" });
  await assert.rejects(client(baseUrl, { maxResponseBytes: 1024 }).parseBytes({ bytes: PDF, filename: "a.pdf" }),
    { code: "source_parser_response_too_large" });
});

test("parse() reads the resolved file once, never through a link, and checks its digest", async (t) => {
  const root = await mkdtemp(path.join("/tmp", "evimed-parser-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { baseUrl, seen } = await withParser(t, [{ status: 200, body: envelope(200, { content: "PDF 正文" }) }]);
  const file = path.join(root, "论文.pdf");
  await writeFile(file, PDF);
  const result = await client(baseUrl).parse({ path: file, mimeType: "application/pdf", sha256: sha(PDF), sourceId: "src" });
  assert.equal(result.text, "PDF 正文");
  assert.equal(seen[0].form.get("filename"), "论文.pdf");
  const link = path.join(root, "linked.pdf");
  await symlink(file, link);
  await assert.rejects(client(baseUrl).parse({ path: link, sha256: sha(PDF) }), { code: "ELOOP" });
});

test("health reads the service's own answer, and sends it no credential", async (t) => {
  const { baseUrl, seen } = await withParser(t, [
    { status: 200, body: envelope(200, { status: "healthy", environment: "test" }) },
    { status: 503, body: envelope(503, { status: "draining", accepting_requests: false }) },
  ]);
  const parser = client(baseUrl, { token: "sk-never-sent" });
  // `credential` says what a parse sends, `file` or `none` -- never whether the
  // service accepted anything: this service answers without a key.
  assert.deepEqual(await parser.health(), { configured: true, status: "healthy", credential: "file", revision: REVISION, environment: "test" });
  await assert.rejects(parser.health(), { code: "source_parser_draining" });
  assert.equal(seen.every((request) => request.headers.authorization === undefined), true);
  assert.deepEqual(await new DocumentParserClient().health(), { configured: false });
});

test("without a key file a parse sends no Authorization header and still gets its text", async (t) => {
  // The parser team's service answers without a key (measured 2026-09-22);
  // an empty key file must not stop a document from being parsed.
  const { baseUrl, seen } = await withParser(t, [
    { status: 200, body: envelope(200, { content: "EviMed parser probe: aspirin 100 mg daily.\n" }) },
  ]);
  const root = await mkdtemp(path.join("/tmp", "evimed-parser-nokey-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "probe.pdf");
  await writeFile(file, PDF);
  const parser = client(baseUrl);
  const result = await parser.parse({ path: file, mimeType: "application/pdf", sha256: sha(PDF), sourceId: "src" });
  assert.equal(result.text, "EviMed parser probe: aspirin 100 mg daily.\n");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal((await client(baseUrl, { fetchImpl: async () => new Response(envelope(200, { status: "healthy" }), { status: 200 }) }).health()).credential, "none");
});

test("a DOI is kept in its bare form only when it has a DOI's shape", () => {
  assert.equal(normalizeDoi("doi: 10.1056/NEJMoa1009638"), "10.1056/NEJMoa1009638");
  assert.equal(normalizeDoi("https://dx.doi.org/10.1016/S0140-6736(20)30183-5."), "10.1016/S0140-6736(20)30183-5");
  assert.equal(normalizeDoi("not a doi"), undefined);
  assert.equal(normalizeDoi(42), undefined);
});

test("the revision label is required and bounded, so the index key is never empty", () => {
  assert.throws(() => new DocumentParserClient({ revision: "" }), /revision/);
  assert.throws(() => new DocumentParserClient({ revision: "has space" }), /revision/);
  assert.throws(() => new DocumentParserClient({ baseUrl: "http://user:fake@parser.example" }), /URL/);
});
