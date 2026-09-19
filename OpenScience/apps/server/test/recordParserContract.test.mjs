import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SAMPLE_TEXT, assertNoSecret, contractSamplePdf, recordParserContract } from "../../../scripts/ops/record-parser-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const KEY = "sk-test-only-recorder-key-0123456789";

async function fakeParser(t, { echoKey = false } = {}) {
  const seen = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null });
    const answer = request.url === "/health"
      ? [200, { status: "healthy", environment: "test" }]
      : request.headers.authorization === `Bearer ${KEY}` ? [200, { content: echoKey ? `leaked ${KEY}` : SAMPLE_TEXT }] : [401, { error_code: "invalid_api_key" }];
    response.writeHead(answer[0], { "content-type": "application/json; charset=UTF-8", "x-quota-cost": "1", "x-internal": "not recorded" });
    response.end(JSON.stringify({ code: answer[0], message: "m", uuid: "U", timestamp: 1, elapsed_ms: 1, data: answer[1] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, seen };
}

async function scratch(t) {
  const dir = await mkdtemp("/tmp/evimed-parser-contract-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(path.join(repoRoot, "packages/contracts/evimed-extract/fixtures/provenance.json"), path.join(dir, "provenance.json"));
  return dir;
}

test("the contract sample is one well-formed PDF page whose text layer carries the sample sentence", () => {
  const pdf = contractSamplePdf();
  assert.deepEqual(pdf, contractSamplePdf(), "deterministic, so two recordings differ only where the service did");
  const source = pdf.toString("ascii");
  assert.match(source, /^%PDF-1\.4\n/);
  assert.ok(source.includes(`(${SAMPLE_TEXT}) Tj`));
  const start = Number(source.match(/startxref\n(\d+)/)[1]);
  assert.ok(source.slice(start).startsWith("xref\n0 6\n"));
  const entries = source.slice(start).split("\n").slice(3, 8);
  entries.forEach((entry, index) => assert.ok(source.slice(Number(entry.slice(0, 10))).startsWith(`${index + 1} 0 obj\n`)));
});

test("without a key only the answers that need none are recorded, verbatim", async (t) => {
  const { baseUrl, seen } = await fakeParser(t);
  const outDir = await scratch(t);
  const recorded = await recordParserContract({ baseUrl, outDir, now: () => new Date("2026-09-20T00:00:00.000Z") });
  assert.deepEqual(recorded, [{ name: "health.json", status: 200 }, { name: "extract-missing-file.json", status: 401 }]);
  assert.ok(seen.every((request) => request.authorization === null));
  const provenance = JSON.parse(await readFile(path.join(outDir, "provenance.json"), "utf8"));
  assert.equal(provenance.observedAt, "2026-09-20T00:00:00.000Z");
  assert.deepEqual(provenance.fixtures["health.json"].headers, { "content-type": "application/json; charset=UTF-8", "x-quota-cost": "1" },
    "only the headers the client reads are kept");
});

test("with a key the authenticated samples are recorded, and the key is written nowhere", async (t) => {
  const { baseUrl, seen } = await fakeParser(t);
  const outDir = await scratch(t);
  const recorded = await recordParserContract({ baseUrl, token: KEY, outDir });
  assert.deepEqual(recorded.map((row) => row.name), [
    "health.json", "extract-missing-file.json", "extract-success.json", "parse-success.json",
    "extract-unsupported-format.json", "extract-checksum-failed.json", "extract-unauthorized.json",
  ]);
  assert.equal(recorded.find((row) => row.name === "extract-unauthorized.json").status, 401, "the refusal sample uses a key the service never issued");
  assert.equal(seen.filter((request) => request.authorization === `Bearer ${KEY}`).length, 4);
  for (const name of await readdir(outDir)) {
    assert.equal((await readFile(path.join(outDir, name), "utf8")).includes(KEY), false, `${name} contains the key`);
  }
});

test("a server that echoes the key gets nothing written", async (t) => {
  const { baseUrl } = await fakeParser(t, { echoKey: true });
  const outDir = await scratch(t);
  const before = await readFile(path.join(outDir, "provenance.json"), "utf8");
  await assert.rejects(recordParserContract({ baseUrl, token: KEY, outDir }), /contains the key/);
  assert.equal(await readFile(path.join(outDir, "provenance.json"), "utf8"), before);
  assert.deepEqual((await readdir(outDir)).sort(), ["provenance.json"]);
  assert.throws(() => assertNoSecret("abc", Buffer.from("xxabcxx")));
  assert.doesNotThrow(() => assertNoSecret("", Buffer.from("anything")));
});
