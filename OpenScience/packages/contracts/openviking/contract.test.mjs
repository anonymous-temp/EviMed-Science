// What must still be true of OpenViking before its pin may move.
//
// Every fixture here was recorded off a running server of the pinned version, not written by hand.
// That distinction has cost us before: an authored wire fixture certified a
// shape the server never produced, and the audit that depended on it passed
// for weeks while the real response drifted.
//
// The client is exercised against those responses through a real HTTP server,
// so a parse that only works on a hand-shaped object fails here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";

import { OpenVikingClient, memoryUri, openVikingUserId, parseMemoryUri, userMemoryRoot } from "../../../apps/server/src/openVikingClient.mjs";
import { OPENVIKING_MEMORY_TYPES, OPENVIKING_SKILL_NAMES, OPENVIKING_SKILLS_ROOT } from "../../../apps/server/src/openVikingLayout.mjs";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const versions = await readJson("../../../deps-version.json");
const provenance = await readJson("./fixtures/provenance.json");
const healthFixture = await readJson("./fixtures/health.json");
const findFixture = await readJson("./fixtures/find.json");
const unauthenticatedFixture = await readJson("./fixtures/find-unauthenticated.json");
const pinnedImage = `${versions.openviking.image}:${versions.openviking.imageTag}`;

/** The platform user the top-level fixtures were recorded as (`live/ovbase/record-client-fixtures.mjs`). */
const RECORDED_USER = "usr_contract_fixture_v050";

/** Serve the recorded responses over real HTTP, and record what was asked. */
async function withServer(routes, run) {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const pathname = new URL(request.url, "http://recorded").pathname;
      const route = routes[request.url] ?? routes[pathname] ?? routes.default;
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
  assert.equal(provenance.imageRef, pinnedImage, "the fixtures name an image the deployment does not pull");
  assert.equal(provenance.imageDigest, versions.openviking.imageDigest);
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
    const hits = await client(port).find(RECORDED_USER, "报告里的证据强度用什么形式呈现？", {
      targets: [`${userMemoryRoot(RECORDED_USER)}/user`],
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
    // The recorded tree is the one this client still writes: a changed hash or layout would address
    // a different directory from the one production already holds.
    assert.equal(hits[0].uri, memoryUri(RECORDED_USER, { scope: "user", scopeId: "", kind: "preference", recordId: "rec1" }));

    const [request] = seen;
    assert.equal(request.method, "POST");
    assert.equal(request.body.context_type, "memory");
    assert.equal(request.body.read_content, true);
    assert.equal(request.headers["x-openviking-account"], "evimed");
    assert.equal(request.headers["x-openviking-user"], openVikingUserId(RECORDED_USER));
    assert.ok(!("x-openviking-role" in request.headers));
    // What the recorder sent is what the client sends now, field for field.
    const recorded = provenance.recordedExchanges.find((exchange) => exchange.file === "find.json");
    assert.deepEqual(Object.keys(request.body).sort(), Object.keys(recorded.requestBody).sort());
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

test("the recorded scores sit on the scale the search floor was set on", async () => {
  // (cosine + 1) / 2 since v0.4.22: the floor of 0.75 is a cosine of 0.5. The relevant record must clear it and the
  // unrelated ones must not, or `OPEN_SCIENCE_MEMORY_SEARCH_MIN_SCORE` has to move with the pin.
  const { loadConfig } = await import("../../../apps/server/src/config.mjs");
  const floor = loadConfig({}).memorySearchMinScore;
  assert.equal(floor, 0.75);
  const [relevant, ...rest] = findFixture.result.memories;
  assert.ok(relevant.score > floor + 0.1, "the relevant record no longer clears the floor with room");
  const recorded = await readJson("./fixtures/provenance.json");
  assert.ok(recorded.observations.some((line) => line.includes("0.623")), "the unrelated score the fixture was trimmed of is recorded");
  assert.ok(rest[rest.length - 1].score < floor, "an unrelated record now clears the floor");
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
        () => client(port).find(RECORDED_USER, "q", {}),
        (error) => error.code === "memory_index_auth_failed" && error.upstreamStatus === 401 && error.upstreamCode === "UNAUTHENTICATED",
      );
    },
  );
});

test("a listing is the bare list of one level, and a missing directory is named", async () => {
  const kinds = await readJson("./fixtures/fs-ls.json");
  const leaves = await readJson("./fixtures/fs-ls-leaves.json");
  const missing = await readJson("./fixtures/fs-ls-missing.json");
  await withServer({ "/api/v1/fs/ls": { body: kinds } }, async ({ port, seen }) => {
    const entries = await client(port).list(RECORDED_USER, `${userMemoryRoot(RECORDED_USER)}/user`);
    assert.deepEqual(entries.map((entry) => entry.uri.split("/").pop()), ["analysis", "note", "preference"]);
    assert.ok(entries.every((entry) => entry.isDir === true), "ls is one level: the kind directories, not their leaves");
    assert.ok(!new URL(seen[0].url, "http://recorded").searchParams.has("limit"), "a limit would truncate the listing silently");
  });
  assert.ok(leaves.result.every((entry) => entry.isDir === false && parseMemoryUri(entry.uri)));
  assert.equal(kinds.has_more, false, "has_more sits beside result, not inside it");
  await withServer({ "/api/v1/fs/ls": { status: 404, body: missing } }, async ({ port }) => {
    await assert.rejects(
      () => client(port).list(RECORDED_USER, `${userMemoryRoot(RECORDED_USER)}/user/absent`),
      (error) => error.code === "memory_index_not_found" && error.status === 404 && error.upstreamCode === "NOT_FOUND",
    );
  });
});

test("a derived record costs an embedding and no model call, with a language model configured", async () => {
  // The engine has a `vlm` since v0.5.0 — extraction, summaries and Compile use it — and every model call it makes is
  // the platform's money. A write under `memories/` is not one of them: the recall index stays as cheap as it was.
  const written = await readJson("./fixtures/content-write.json");
  assert.equal(written.result.semantic_status, "skipped");
  assert.equal(written.result.overview_status, "skipped");
  assert.equal(written.result.vector_status, "complete");
  assert.equal(written.result.queue_status.Semantic.processed, 0);
  assert.equal(written.result.queue_status.Embedding.processed, 1);
  assert.match(String(provenance.configuration.vlm), /deepseek-flash/);
  assert.equal(provenance.configuration["memory.extraction_enabled"], true);
  await withServer({ "/api/v1/content/write": { body: written } }, async ({ port, seen }) => {
    await client(port).write(RECORDED_USER, written.result.uri, "偏好 / 报告呈现", { wait: true, timeoutSeconds: 20 });
    const recorded = provenance.recordedExchanges.find((exchange) => exchange.file === "content-write.json");
    assert.deepEqual(Object.keys(seen[0].body).sort(), Object.keys(recorded.requestBody).sort());
    assert.equal(seen[0].body.mode, "replace");
  });
});

test("a delete says whether there was anything to delete, at this version with a count and no 404", async () => {
  const deleted = await readJson("./fixtures/fs-delete.json");
  const gone = await readJson("./fixtures/fs-delete-missing.json");
  assert.equal(deleted.result.estimated_deleted_count, 1);
  assert.equal(gone.result.estimated_deleted_count, 0);
  const exchange = provenance.recordedExchanges.find((entry) => entry.file === "fs-delete-missing.json");
  assert.equal(exchange.status, 200, "a delete of something already gone was a 404 until v0.5.0");
  await withServer({ "/api/v1/fs": { body: deleted } }, async ({ port, seen }) => {
    assert.equal(await client(port).remove(RECORDED_USER, deleted.result.uri), true);
    assert.equal(seen[0].body, null, "the route reads its target from the query and refuses a body");
    assert.equal(new URL(seen[0].url, "http://recorded").searchParams.get("uri"), deleted.result.uri);
  });
  await withServer({ "/api/v1/fs": { body: gone } }, async ({ port }) => {
    assert.equal(await client(port).remove(RECORDED_USER, gone.result.uri), false);
  });
});

test("the two recorded sets are whole, name the pinned image and carry no credential", async () => {
  const memoryIndex = await readJson("./fixtures/memory/_index.json");
  const memoryFiles = (await readdir(new URL("./fixtures/memory/", import.meta.url))).filter((name) => name.endsWith(".json") && !["_index.json", "provenance.json"].includes(name));
  const listed = (Array.isArray(memoryIndex) ? memoryIndex : memoryIndex.fixtures ?? Object.values(memoryIndex)).map((entry) => entry.file ?? entry);
  assert.deepEqual([...listed].sort(), [...memoryFiles].sort(), "the memory index and the directory disagree");
  for (const name of memoryFiles) {
    const fixture = await readJson(`./fixtures/memory/${name}`);
    assert.equal(fixture.recordedFrom, pinnedImage, `${name} was recorded off another image`);
    assert.ok(Number.isInteger(fixture.status) && fixture.request?.path, `${name} is not an exchange`);
    const key = fixture.request.headers?.["X-API-Key"];
    assert.ok(key === undefined || key === "recorded-against-a-real-server", `${name} carries a credential`);
  }
  assert.equal((await readJson("./fixtures/memory/provenance.json")).imageDigest, versions.openviking.imageDigest);

  const knowledge = await readJson("./fixtures/knowledge/provenance.json");
  assert.equal(knowledge.recorded_from, pinnedImage);
  const knowledgeFiles = (await readdir(new URL("./fixtures/knowledge/", import.meta.url))).filter((name) => name !== "provenance.json");
  assert.deepEqual(Object.values(knowledge.fixtures).map((entry) => entry.file).sort(), [...knowledgeFiles].sort(), "the knowledge provenance and the directory disagree");
  for (const entry of Object.values(knowledge.fixtures)) {
    const bytes = await readFile(new URL(`./fixtures/knowledge/${entry.file}`, import.meta.url));
    if (entry.binary) assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.binary.sha256);
    else JSON.parse(bytes.toString("utf8"));
  }
});

test("the recorded engine is the one the layout and the pin describe", async () => {
  // A registered user's settings read back the eight types of the mounted template directory — the allowlist of
  // `server.user_config_defaults`, in the order the server sorts them.
  const settings = await readJson("./fixtures/memory/admin-user-settings-get.json");
  assert.deepEqual(settings.response.result.memory_policy.memory_types, [...OPENVIKING_MEMORY_TYPES].sort());
  // The admin routes do not know a trusted user until it is registered, and say so with a 404 the client names.
  assert.equal((await readJson("./fixtures/memory/admin-user-settings-get-unregistered.json")).status, 404);
  assert.equal((await readJson("./fixtures/memory/admin-user-register-again.json")).response.error.code, "ALREADY_EXISTS");
  // The two official skills are installed under the account-shared root, where a compile names them.
  const skills = await readJson("./fixtures/knowledge/skills-list.json");
  const installed = JSON.stringify(skills);
  for (const name of OPENVIKING_SKILL_NAMES) {
    assert.ok(installed.includes(`${OPENVIKING_SKILLS_ROOT}/${name}`), `${name} is not among the recorded installed skills`);
    assert.match(versions.openviking.skills[name].installedSha256, /^[0-9a-f]{64}$/);
  }
  const submitted = await readJson("./fixtures/knowledge/compile-submit.json");
  assert.match(String(submitted.result?.task_id ?? ""), /^cmp_[0-9a-f]{64}$/);
});
