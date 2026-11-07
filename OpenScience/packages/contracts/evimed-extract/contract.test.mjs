/**
 * The in-house parsing API's contract test (`deps-version.json` → `evimed-extract`).
 *
 * Hidden knowledge: what has to hold before this dependency's pin may move.
 * The parser is the team's own service reached over HTTPS with a key the
 * service issues; nothing of it is built or run here. What this repository
 * owns is the client (`apps/server/src/documentParserClient.mjs`), the revision
 * label that keys the knowledge-base index, and the fixtures that pin the wire.
 *
 * `health.json` was recorded off the running test server; every other fixture is
 * an answer written out from API.md v1.0.0 and marked `documented` in
 * `fixtures/provenance.json` (the new credential answered 401 when this was
 * written, so nothing could be recorded). Each is served over real HTTP to the
 * real client, so a parse that only works on a hand-shaped object fails here;
 * `scripts/ops/record-parser-contract.mjs` replaces the documented ones with
 * recordings once a working key exists, and a test below keeps the two kinds
 * from being confused.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";

import { DocumentParserClient } from "../../../apps/server/src/documentParserClient.mjs";

const root = new URL("../../../", import.meta.url);
const deps = JSON.parse(await readFile(new URL("deps-version.json", root), "utf8"));
const pin = deps["evimed-extract"];
const provenance = JSON.parse(await readFile(new URL("./fixtures/provenance.json", import.meta.url), "utf8"));
/** @param {string} name */
const fixtureBytes = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

/** Serve recorded answers over real HTTP, keyed by `METHOD path`, and record
 *  what the client sent. */
async function withServer(routes, run) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
      const route = routes[`${request.method} ${request.url}`];
      if (!route) { response.writeHead(404); response.end(); return; }
      response.writeHead(route.status, route.headers);
      response.end(route.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run({ baseUrl: `http://127.0.0.1:${server.address().port}`, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A recorded answer as the server gave it. @param {string} name */
async function recorded(name) {
  const entry = provenance.fixtures[name];
  assert.ok(entry, `${name} is not listed in provenance.json`);
  return { status: entry.status, headers: entry.headers, body: await fixtureBytes(name) };
}

test("the pin is defined once, with the contract version and the documentation it was read from", () => {
  assert.ok(pin, "evimed-extract is missing from deps-version.json");
  assert.match(pin.version, /^\d+\.\d+\.\d+$/, "a pin is an exact contract version");
  assert.match(pin.docsCommit, /^[0-9a-f]{7,40}$/);
  assert.equal(pin.revision, `evimed-extract@${pin.version}`, "the index revision names the contract it was parsed under");
  assert.equal(pin.contractDir, "packages/contracts/evimed-extract");
  assert.equal(pin.testServer, undefined, "the partner's test server address is not published");
  assert.match(String(pin.recordedAgainst ?? ""), /test environment/, "the pin says what the fixtures were recorded against");
  assert.ok(String(pin.notes ?? "").length > 40, "a pin carries the reason it is what it is");
  assert.equal(deps.mineru, undefined, "MinerU was deleted with the switch; nothing may pin it");
});

test("the fixtures were recorded against the contract this pin names", () => {
  assert.equal(provenance.contractVersion, pin.version);
  assert.equal(provenance.docsCommit, pin.docsCommit);
  assert.equal(JSON.stringify(provenance).match(/https?:\/\/\d+\.\d+\.\d+\.\d+/), null, "no server address is written into the repository");
  // The walk must prove it walked: the recording and the documented answers all exist.
  assert.ok(Object.keys(provenance.fixtures).length >= 8);
  assert.ok("health.json" in provenance.fixtures && "engine-a-pdf-success.json" in provenance.fixtures);
  for (const [name, entry] of Object.entries(provenance.fixtures)) {
    if (name !== "health.json") assert.equal(typeof entry.documented, "boolean", `${name} says whether it is a documented answer or a recording`);
  }
});

test("every derived copy of the revision and the address equals the pin", async () => {
  const read = (file) => readFile(new URL(file, root), "utf8");
  const config = await read("apps/server/src/config.mjs");
  assert.match(config, /depsVersions\["evimed-extract"\]\?\.revision/, "the code default must be read from the pin, not retyped");
  const overlay = await read("deploy/web/docker-compose.ingestion.yml");
  assert.equal(overlay.match(/OPEN_SCIENCE_DOCUMENT_PARSER_REVISION: \$\{OPEN_SCIENCE_DOCUMENT_PARSER_REVISION:-([^}]+)\}/)?.[1], pin.revision);
  // No default address: a deployment names its parser service.
  assert.match(overlay, /OPEN_SCIENCE_DOCUMENT_PARSER_URL: \$\{OPEN_SCIENCE_DOCUMENT_PARSER_URL:-\}/);
  const example = await read("deploy/web/.env.example");
  assert.equal(example.match(/^OPEN_SCIENCE_DOCUMENT_PARSER_REVISION=(.+)$/m)?.[1], pin.revision);
  assert.equal(example.match(/^OPEN_SCIENCE_DOCUMENT_PARSER_URL=(.*)$/m)?.[1], "");
});

test("health, as the deployed build answers it, reads as healthy", async () => {
  const route = await recorded("health.json");
  await withServer({ "GET /health": route }, async ({ baseUrl, seen }) => {
    const client = new DocumentParserClient({ baseUrl, token: "never-sent-to-health", revision: pin.revision });
    const health = await client.health();
    assert.equal(health.configured, true);
    assert.equal(health.status, "healthy");
    assert.equal(health.revision, pin.revision);
    assert.equal(seen[0].headers.authorization, undefined, "the health route takes no credential and is sent none");
  });
});

const PDF = Buffer.from("%PDF-1.4\n");
const ROUTE_A = "POST /api/v1/parse/engine-a/file";
const ROUTE_B = "POST /api/v1/parse/engine-b/file";
/** @param {string} baseUrl @param {Record<string, unknown>} [options] */
const clientFor = (baseUrl, options = {}) => new DocumentParserClient({ baseUrl, token: "replay", revision: pin.revision, sleep: async () => {}, ...options });
/** @param {string} name */
const body = async (name) => JSON.parse((await fixtureBytes(name)).toString("utf8"));

test("the documented engine-A answer becomes protocol v1 with its page map, diagnosis and the route and header the API asks for", async () => {
  await withServer({ [ROUTE_A]: await recorded("engine-a-pdf-success.json") }, async ({ baseUrl, seen }) => {
    const result = await clientFor(baseUrl).parseBytes({ bytes: PDF, filename: "sample.pdf", mediaType: "application/pdf" });
    const data = (await body("engine-a-pdf-success.json")).data;
    assert.equal(result.text, String(data.content).replace(/^\[Page \d+\]\n/gm, ""), "the text is the content without the service's page lines");
    assert.deepEqual(result.pageMap.map((page) => [page.page, page.status]), [[1, "ok"], [2, "empty"]], "page 2 carries the service's own empty-page warning");
    assert.equal(result.text.slice(result.pageMap[0].start, result.pageMap[0].end).trim(), "文档正文第一页。");
    assert.equal(result.extractor.endpoint, "engine-a");
    assert.equal(result.extractor.parseInfo.pageCount, 2);
    assert.equal(seen[0].headers.authorization, "Bearer replay");
    const form = seen[0].body.toString("utf8");
    for (const field of ["file", "checksum", "filename", "extract_metadata"]) assert.ok(form.includes(`name="${field}"`), `the upload names ${field}`);
  });
});

test("the documented metadata answer is read, and a null metadata (a failed analysis) still delivers the text", async () => {
  await withServer({ [ROUTE_A]: await recorded("engine-a-metadata-success.json") }, async ({ baseUrl }) => {
    const result = await clientFor(baseUrl).parseBytes({ bytes: PDF, filename: "sample.pdf" });
    assert.deepEqual(result.metadata, { title: "某项临床研究" });
    assert.equal(result.extractor.metadataStatus, "succeeded");
  });
  const failed = await body("engine-a-metadata-success.json");
  failed.data.metadata = null;
  failed.data.metadata_status = "failed";
  failed.data.metadata_error = "metadata_timeout";
  await withServer({ [ROUTE_A]: { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(failed) } }, async ({ baseUrl }) => {
    const result = await clientFor(baseUrl).parseBytes({ bytes: PDF, filename: "sample.pdf" });
    assert.equal(result.text, failed.data.content);
    assert.equal("metadata" in result, false);
  });
});

test("engine B is its own route, and its answer (null format, no parse_info, no markers) is read", async () => {
  await withServer({ [ROUTE_B]: await recorded("engine-b-success.json") }, async ({ baseUrl, seen }) => {
    const result = await clientFor(baseUrl, { engine: "engine-b" }).parseBytes({ bytes: PDF, filename: "sample.pdf" });
    assert.equal(result.text, "引擎 B 的正文。");
    assert.equal(result.extractor.endpoint, "engine-b");
    assert.equal("pageMap" in result, false);
    assert.equal(seen.length, 1);
  });
});

for (const [name, route, check] of [
  ["error-invalid-api-key.json", ROUTE_A, (error) => error.code === "source_parser_auth_failed" && error.status === 502],
  ["error-insufficient-scope.json", ROUTE_A, (error) => error.code === "source_parser_scope_denied"],
  ["error-quota-exhausted.json", ROUTE_A, (error) => error.code === "source_parser_quota_exhausted" && error.status === 503],
]) {
  test(`the documented ${name} is classified by its status and named`, async () => {
    await withServer({ [route]: await recorded(name) }, async ({ baseUrl, seen }) => {
      await assert.rejects(clientFor(baseUrl).parseBytes({ bytes: PDF, filename: "sample.pdf" }), check);
      assert.ok(seen.length <= 2, "a refused request is final (one more only for the metadata scope)");
    });
  });
}

test("the documented empty-content answer is a document with no text, not a failure", async () => {
  await withServer({ [ROUTE_A]: await recorded("error-empty-content.json") }, async ({ baseUrl }) => {
    const result = await clientFor(baseUrl).parseBytes({ bytes: PDF, filename: "scan.pdf" });
    assert.equal(result.text, "");
    assert.equal(result.units[0].status, "no_content");
  });
});

test("the routes the service retired on 2026-10-27 answer 404 and are named, not retried", async () => {
  await withServer({}, async ({ baseUrl, seen }) => {
    const parser = clientFor(baseUrl);
    await assert.rejects(parser.parseBytes({ bytes: PDF, filename: "sample.pdf" }), (error) => error.code === "source_parser_route_missing");
    assert.equal(seen.length, 1);
    assert.equal(parser.status().route, "missing");
  });
});
