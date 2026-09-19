/**
 * The in-house parsing API's contract test (`deps-version.json` → `evimed-extract`).
 *
 * Hidden knowledge: what has to hold before this dependency's pin may move.
 * The parser is the team's own service reached over HTTPS with a key the
 * service issues; nothing of it is built or run here. What this repository
 * owns is the client (`apps/server/src/documentParserClient.mjs`), the revision
 * label that keys the knowledge-base index, and the fixtures that pin the wire.
 *
 * Every fixture was recorded off the running test server (see
 * `fixtures/provenance.json`), and each is served over real HTTP to the real
 * client, so a parse that only works on a hand-shaped object fails here. The
 * authenticated samples appear once the service key exists and
 * `scripts/ops/record-parser-contract.mjs` has run; until then their replay is
 * skipped with the reason stated, which is not the same as passing.
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
  assert.match(pin.testServer, /^https?:\/\/[^/]+$/);
  assert.ok(String(pin.notes ?? "").length > 40, "a pin carries the reason it is what it is");
  assert.equal(deps.mineru, undefined, "MinerU was deleted with the switch; nothing may pin it");
});

test("the fixtures were recorded against the contract this pin names", () => {
  assert.equal(provenance.contractVersion, pin.version);
  assert.equal(provenance.docsCommit, pin.docsCommit);
  assert.equal(provenance.server, pin.testServer);
  // The walk must prove it walked: two recordings exist from the first day.
  assert.ok(Object.keys(provenance.fixtures).length >= 2);
  assert.ok("health.json" in provenance.fixtures && "extract-missing-file.json" in provenance.fixtures);
});

test("every derived copy of the revision and the address equals the pin", async () => {
  const read = (file) => readFile(new URL(file, root), "utf8");
  const config = await read("apps/server/src/config.mjs");
  assert.match(config, /depsVersions\["evimed-extract"\]\?\.revision/, "the code default must be read from the pin, not retyped");
  const overlay = await read("deploy/web/docker-compose.ingestion.yml");
  assert.equal(overlay.match(/OPEN_SCIENCE_DOCUMENT_PARSER_REVISION: \$\{OPEN_SCIENCE_DOCUMENT_PARSER_REVISION:-([^}]+)\}/)?.[1], pin.revision);
  assert.equal(overlay.match(/OPEN_SCIENCE_DOCUMENT_PARSER_URL: \$\{OPEN_SCIENCE_DOCUMENT_PARSER_URL:-([^}]+)\}/)?.[1], pin.testServer);
  const example = await read("deploy/web/.env.example");
  assert.equal(example.match(/^OPEN_SCIENCE_DOCUMENT_PARSER_REVISION=(.+)$/m)?.[1], pin.revision);
  assert.equal(example.match(/^OPEN_SCIENCE_DOCUMENT_PARSER_URL=(.+)$/m)?.[1], pin.testServer);
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

test("an error answer with no error code is still classified by its status", async () => {
  // The deployed build answers `data: null` — there is no `error_code` to read.
  const route = await recorded("extract-missing-file.json");
  assert.equal(JSON.parse(route.body.toString("utf8")).data, null, "the recording is the no-error-code shape");
  await withServer({ "POST /api/v1/extract/text/file": route }, async ({ baseUrl, seen }) => {
    const client = new DocumentParserClient({ baseUrl, revision: pin.revision, sleep: async () => {} });
    await assert.rejects(
      client.parseBytes({ bytes: Buffer.from("%PDF-1.4\n"), filename: "指南.pdf", mediaType: "application/pdf" }),
      (error) => error.code === "source_parser_rejected" && error.status === 502,
    );
    assert.equal(seen.length, 1, "a 400 is final on the first answer");
    const body = seen[0].body.toString("utf8");
    assert.match(String(seen[0].headers["content-type"]), /^multipart\/form-data; boundary=/);
    for (const field of ["file", "checksum", "filename", "format"]) assert.ok(body.includes(`name="${field}"`), `the upload names ${field}`);
    assert.equal(seen[0].headers.authorization, undefined, "no key configured, no header sent");
  });
});

// The authenticated samples, replayed once recorded. Each lists what the
// client must make of it; a sample absent from provenance.json is skipped
// with its reason rather than passed.
const authenticated = [
  ["extract-success.json", "POST /api/v1/extract/text/file", async (client) => {
    const result = await client.parseBytes({ bytes: Buffer.from("%PDF-1.4\n"), filename: "sample.pdf", mediaType: "application/pdf" });
    const data = JSON.parse((await fixtureBytes("extract-success.json")).toString("utf8")).data;
    assert.equal(result.text, data.content, "the text is the content, untouched");
    assert.equal(result.extractor.endpoint, "extract");
    if (typeof data.title === "string" && data.title.trim()) assert.equal(result.metadata?.title, data.title.trim());
  }],
  ["parse-success.json", "POST /api/v1/parse/file", null],
  ["extract-unsupported-format.json", "POST /api/v1/extract/text/file", async (client) => {
    await assert.rejects(client.parseBytes({ bytes: Buffer.from("%PDF-1.4\n"), filename: "sample.pdf" }),
      (error) => error.code === "source_format_unsupported" && error.status === 415);
  }],
  ["extract-checksum-failed.json", "POST /api/v1/extract/text/file", async (client) => {
    await assert.rejects(client.parseBytes({ bytes: Buffer.from("%PDF-1.4\n"), filename: "sample.pdf" }),
      (error) => error.code === "source_parser_checksum_failed" && error.status === 422);
  }],
  ["extract-unauthorized.json", "POST /api/v1/extract/text/file", async (client) => {
    await assert.rejects(client.parseBytes({ bytes: Buffer.from("%PDF-1.4\n"), filename: "sample.pdf" }),
      (error) => error.code === "source_parser_auth_failed");
  }],
];

for (const [name, route, check] of authenticated) {
  test(`recorded ${name} replays through the client`, async (t) => {
    if (!provenance.fixtures[name]) {
      t.skip("not recorded yet: needs the service-issued key (scripts/ops/record-parser-contract.mjs)");
      return;
    }
    if (!check) {
      // The text-only answer is the fallback's; its shape must still be one
      // the client accepts: a string `content` under `data`.
      const body = JSON.parse((await fixtureBytes(name)).toString("utf8"));
      assert.equal(typeof body.data?.content, "string");
      return;
    }
    const answer = await recorded(name);
    await withServer({ [route]: answer }, async ({ baseUrl }) => {
      await check(new DocumentParserClient({ baseUrl, token: "replay", revision: pin.revision, sleep: async () => {} }));
    });
  });
}
