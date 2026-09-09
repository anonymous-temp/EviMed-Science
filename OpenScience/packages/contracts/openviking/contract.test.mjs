// What must still be true of OpenViking before its pin may move.
//
// Every fixture here was recorded off a running v0.4.19, not written by hand.
// That distinction has cost us before: an authored wire fixture certified a
// shape the server never produced, and the audit that depended on it passed
// for weeks while the real response drifted.
//
// The client is exercised against those responses through a real HTTP server,
// so a parse that only works on a hand-shaped object fails here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";

import { OpenVikingClient, openVikingUserId, parseMemoryUri } from "../../../apps/server/src/openVikingClient.mjs";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const versions = await readJson("../../../deps-version.json");
const provenance = await readJson("./fixtures/provenance.json");
const healthFixture = await readJson("./fixtures/health.json");
const findFixture = await readJson("./fixtures/find.json");
const unauthenticatedFixture = await readJson("./fixtures/find-unauthenticated.json");

/** Serve the recorded responses over real HTTP, and record what was asked. */
async function withServer(routes, run) {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const route = routes[request.url] ?? routes.default;
      seen.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: body ? JSON.parse(body) : null,
      });
      response.writeHead(route.status ?? 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(route.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run({ port, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function client(port) {
  return new OpenVikingClient({
    openVikingUrl: `http://127.0.0.1:${port}`,
    openVikingApiKey: "recorded-against-a-real-server",
    openVikingAccount: "evimed",
    openVikingRequestTimeoutMs: 5_000,
  });
}

test("the recorded fixtures came off the version this repository pins", () => {
  assert.equal(provenance.dependencyVersion, versions.openviking.version);
  assert.equal(healthFixture.version, `v${versions.openviking.version}`);
  assert.equal(
    provenance.imageRef,
    `${versions.openviking.image}:${versions.openviking.imageTag}`,
    "the fixtures name an image the deployment does not pull",
  );
  // The tag really does carry a `v` the package version does not; a compose
  // file naming the unprefixed tag fails at pull, which is how this was found.
  assert.equal(versions.openviking.imageTag, `v${versions.openviking.version}`);
});

test("health reports the version and the auth mode the deployment relies on", async () => {
  await withServer({ "/health": { body: healthFixture } }, async ({ port }) => {
    const status = await client(port).status();
    assert.deepEqual(status, {
      configured: true,
      connected: true,
      code: null,
      version: `v${versions.openviking.version}`,
    });
  });
  // Trusted mode is not incidental: it is what lets this control plane assert
  // the caller's identity while holding the only credential.
  assert.equal(healthFixture.auth_mode, "trusted");
});

test("a recorded search parses into the nominations the recall is built from", async () => {
  await withServer({ "/api/v1/search/find": { body: findFixture } }, async ({ port, seen }) => {
    const hits = await client(port).find("usr_alice", "列净类药物对肾功能下降有什么影响？", {
      targets: [`viking://user/${openVikingUserId("usr_alice")}/memories/evimed/user`],
      limit: 3,
      peerId: "prj_kidney",
    });

    assert.equal(hits.length, findFixture.result.memories.length);
    for (const [position, hit] of hits.entries()) {
      const recorded = findFixture.result.memories[position];
      assert.equal(hit.uri, recorded.uri);
      assert.equal(hit.score, recorded.score);
      assert.ok(hit.content.length > 0, "a hit with no readable text cannot become a recall");
      // The URI is the metadata carrier, so every hit must name a record.
      const parsed = parseMemoryUri(hit.uri);
      assert.ok(parsed, `${hit.uri} did not parse back into a record`);
      assert.ok(parsed.recordId.length > 0);
    }

    const [request] = seen;
    assert.equal(request.method, "POST");
    assert.equal(request.body.context_type, "memory");
    assert.equal(request.body.read_content, true);
    assert.equal(request.headers["x-openviking-account"], "evimed");
    assert.equal(request.headers["x-openviking-user"], openVikingUserId("usr_alice"));
    assert.ok(!("x-openviking-role" in request.headers));
  });
});

test("every hit field the client reads is present in the recorded response", () => {
  // A rename upstream is the failure this catches: the client would silently
  // score every hit 0 and recall in an arbitrary order.
  for (const memory of findFixture.result.memories) {
    for (const field of ["uri", "score", "level", "context_type"]) {
      assert.ok(field in memory, `the wire no longer carries ${field}`);
    }
    assert.ok("content" in memory || "abstract" in memory);
    assert.equal(memory.context_type, "memory");
  }
  assert.ok(Array.isArray(findFixture.result.memories));
  for (const bucket of ["resources", "skills"]) {
    assert.ok(bucket in findFixture.result, `find no longer separates ${bucket} from memories`);
  }
});

test("trusted mode refuses a request that carries no key, whatever the headers say", async () => {
  // Recorded, not assumed. The multi-tenant guide reads as though the key is
  // needed only to assert a role; the server requires it on every call once a
  // root key is configured, and a deployment that believed the guide would
  // come up with recall failing and readiness green.
  assert.equal(unauthenticatedFixture.error.code, "UNAUTHENTICATED");
  assert.match(unauthenticatedFixture.error.message, /Missing API Key in trusted mode/);
  assert.ok(provenance.observations.some((line) => line.includes("EVERY request")));

  await withServer(
    { "/api/v1/search/find": { status: 401, body: unauthenticatedFixture } },
    async ({ port }) => {
      await assert.rejects(
        () => client(port).find("usr_alice", "q", {}),
        (error) => error.code === "memory_index_auth_failed",
      );
    },
  );
});

test("recall needs an embedder and not a language model, which is why none is configured", () => {
  // A write returns semantic_status "skipped" with vector_status "complete"
  // when no VLM is set: the directory summaries are absent and the record is
  // still retrievable. That is what keeps this deployment off the model
  // gateway entirely, so it is asserted rather than remembered.
  assert.equal(provenance.configuration.vlm, "not configured");
  assert.ok(provenance.observations.some((line) => line.includes("vector_status 'complete'")));
  assert.equal(provenance.configuration["memory.extraction_enabled"], false,
    "the server's own extractor must stay off; our evidence-gated distiller is the only writer of methods");
});
