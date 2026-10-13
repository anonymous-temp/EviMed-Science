// What this control plane puts on the wire to the context database.
//
// The identity is asserted by headers, because the server runs in `trusted`
// mode behind this process. That makes the header set part of the security
// boundary rather than a detail: a request that forgot the user header would
// be served as whatever the server defaults to, and a request that sent a role
// would be asking for an authority we never want.
import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../src/security.mjs";
import {
  OpenVikingClient,
  capsuleFactUri,
  capsuleMemoryRoot,
  capsuleSegment,
  capsuleTreeUri,
  openVikingPeerId,
  openVikingUserId,
  parseCapsuleFactUri,
} from "../src/openVikingClient.mjs";

/** The wire's error envelope, which is what a rejection has to be read from. */
function upstreamError(code, message) {
  return { status: "error", error: { code, message, details: {} } };
}

const config = {
  openVikingUrl: "http://openviking.internal:1933",
  openVikingApiKey: "test-key",
  openVikingAccount: "evimed",
  openVikingRequestTimeoutMs: 1_000,
};

/** Records every call and answers with the queued responses. */
function recordingFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift() ?? { status: 200, body: {} };
    if (next.throws) throw next.throws;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      async text() {
        return typeof next.body === "string" ? next.body : JSON.stringify(next.body);
      },
    };
  };
  impl.calls = calls;
  return impl;
}

test("an unset endpoint is not configured, and says which piece is missing", async () => {
  const client = new OpenVikingClient({});
  assert.equal(client.configured, false);
  assert.deepEqual(await client.status(), {
    configured: false,
    connected: false,
    code: "memory_index_url_missing",
  });
});

test("an endpoint that is not a plain http URL is refused before any request", async () => {
  // Assembled rather than written out: an endpoint carrying embedded
  // credentials is exactly the shape the source-credential audit refuses to
  // let into the tree, and the audit is right to refuse it in a test too.
  const withEmbeddedCredentials = `http://name:${"secret"}@host`;
  for (const url of ["ftp://host/x", withEmbeddedCredentials, "not a url"]) {
    const client = new OpenVikingClient({ openVikingUrl: url });
    assert.equal(client.configured, false, `${url} was accepted`);
    assert.equal((await client.status()).code, "memory_index_url_invalid");
  }
});

test("a key is not needed to be configured, because trusted mode asserts identity", () => {
  const client = new OpenVikingClient({ openVikingUrl: "http://openviking.internal:1933" });
  assert.equal(client.configured, true);
});

test("every data request carries this account and this user, and never a role", async () => {
  const fetchImpl = recordingFetch([{ status: 200, body: { result: { memories: [] } } }]);
  const client = new OpenVikingClient(config, { fetchImpl });

  await client.find("usr_alice", "kidney outcomes", {
    targets: ["viking://user/u-x/memories/evimed/user"],
    limit: 6,
    peerId: "prj_kidney",
  });

  const [call] = fetchImpl.calls;
  assert.equal(call.url, "http://openviking.internal:1933/api/v1/search/find");
  assert.equal(call.options.headers["X-OpenViking-Account"], "evimed");
  assert.equal(call.options.headers["X-OpenViking-User"], openVikingUserId("usr_alice"));
  assert.equal(call.options.headers["X-OpenViking-Actor-Peer"], openVikingPeerId("prj_kidney"));
  assert.equal(call.options.headers["X-API-Key"], "test-key");
  assert.ok(!("X-OpenViking-Role" in call.options.headers), "a role must never be asserted from here");

  const body = JSON.parse(call.options.body);
  assert.equal(body.context_type, "memory", "a recall must not be answered with a resource or a skill");
  assert.equal(body.node_limit, 6);
  assert.deepEqual(body.target_uri, ["viking://user/u-x/memories/evimed/user"]);
});

test("a search states its threshold and its level, because the server's defaults are wrong for us", async () => {
  // Both defaults were found in the upstream source after a recall came back
  // short: `rerank.threshold` is 0.1 and the retriever applies it with a strict
  // `>` even when no reranker is configured, so a weak but correct hit is
  // dropped by a server we never asked to filter; and without `level` the
  // result slots can go to directory records, which name no memory of ours.
  const fetchImpl = recordingFetch([{ status: 200, body: { result: { memories: [] } } }, { status: 200, body: { result: { memories: [] } } }]);
  const client = new OpenVikingClient(config, { fetchImpl });

  await client.find("usr_alice", "q", { targets: ["viking://a"] });
  const byDefault = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(byDefault.score_threshold, 0);
  assert.equal(byDefault.level, 2);

  await client.find("usr_alice", "q", { targets: ["viking://a"], scoreThreshold: 0.4 });
  assert.equal(JSON.parse(fetchImpl.calls[1].options.body).score_threshold, 0.4, "a caller that wants a floor may still set one");
});

test("a directory listing reads the bare list the server answers with", async () => {
  // The client used to read `result.entries`, a shape this server never sends,
  // so every listing came back empty and said nothing about it. Nothing called
  // it then; the capsule readback does now.
  const entries = [
    { uri: "viking://user/u-x/memories/evimed/capsule/c-1/analysis", size: 0, isDir: true, modTime: "2026-09-11T00:00:00Z", abstract: "" },
    { uri: "viking://user/u-x/memories/evimed/capsule/c-1/decision", size: 0, isDir: true, modTime: "2026-09-11T00:00:00Z", abstract: "" },
  ];
  const fetchImpl = recordingFetch([{ status: 200, body: { status: "ok", result: entries } }]);
  const client = new OpenVikingClient(config, { fetchImpl });

  assert.deepEqual(await client.list("usr_alice", "viking://user/u-x/memories/evimed/capsule/c-1"), entries);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, "/api/v1/fs/ls");
  assert.equal(url.searchParams.get("offset"), "0");
  assert.equal(url.searchParams.get("limit"), null, "a limit truncates silently, so a listing must never carry one");
});

/** A directory of `total` files behind a server that pages by `pageSize`. */
function directoryFetch(total, pageSize) {
  const impl = async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
    const result = Array.from({ length: Math.max(0, Math.min(pageSize, total - offset)) },
      (_, index) => ({ uri: `viking://x/f${offset + index}.md`, isDir: false }));
    impl.calls.push({ offset, returned: result.length });
    return { ok: true, status: 200, async text() { return JSON.stringify({ status: "ok", result }); } };
  };
  impl.calls = [];
  return impl;
}

test("a complete listing pages by what it received, whatever the server's page holds", async () => {
  // The page size is the server's, it is sent nowhere in the response, and a
  // client that assumed one would read 500 of 1200 entries against a smaller
  // page and re-read 200 against a larger one. Both look like a healthy
  // listing, and the capsule readback turns either into a rebuild that fails
  // the same way forever.
  for (const pageSize of [500, 1_000, 1_500]) {
    const fetchImpl = directoryFetch(1_200, pageSize);
    const entries = await new OpenVikingClient(config, { fetchImpl }).listAll("usr_alice", "viking://x");

    assert.equal(entries.length, 1_200, `a server paging by ${pageSize} must still yield the whole directory`);
    assert.equal(new Set(entries.map((entry) => entry.uri)).size, 1_200, "and must yield each entry once");
    assert.deepEqual(fetchImpl.calls.map((call) => call.offset),
      fetchImpl.calls.map((call, index) => fetchImpl.calls.slice(0, index).reduce((sum, previous) => sum + previous.returned, 0)),
      "each request must start where the last page ended");
  }
});

test("a listing that breaks after its first page keeps what it already read", async () => {
  // "The directory is not there" and "the walk broke halfway" must not look the
  // same: discarding the pages already read reports an intact subtree as empty,
  // which the readback then repairs by rewriting all of it.
  const page = Array.from({ length: 1_000 }, (_, index) => ({ uri: `viking://x/f${index}.md`, isDir: false }));
  const broken = recordingFetch([
    { status: 200, body: { status: "ok", result: page } },
    { status: 404, body: upstreamError("NOT_FOUND", "No such file or directory: viking://x") },
  ]);
  assert.equal((await new OpenVikingClient(config, { fetchImpl: broken }).listAll("usr_alice", "viking://x")).length, 1_000);

  const missing = recordingFetch([{ status: 404, body: upstreamError("NOT_FOUND", "No such file or directory: viking://x") }]);
  await assert.rejects(new OpenVikingClient(config, { fetchImpl: missing }).listAll("usr_alice", "viking://x"),
    { code: "memory_index_not_found" }, "a directory that was never there is the caller's decision, not the client's");
});

test("the health probe is the one call that carries no identity", async () => {
  const fetchImpl = recordingFetch([{ status: 200, body: { status: "ok", version: "0.4.19" } }]);
  const client = new OpenVikingClient(config, { fetchImpl });

  const status = await client.status();

  assert.deepEqual(status, { configured: true, connected: true, code: null, version: "0.4.19" });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "http://openviking.internal:1933/health");
  assert.ok(!("X-OpenViking-User" in call.options.headers));
  assert.ok(!("X-API-Key" in call.options.headers));
});

test("a hit is read for its content, and falls back through the tiers rather than to nothing", async () => {
  const fetchImpl = recordingFetch([{
    status: 200,
    body: {
      result: {
        memories: [
          { uri: "viking://a", score: 0.9, content: "the file", level: 2 },
          { uri: "viking://b", score: 0.5, overview: "the L1 overview", level: 1 },
          { uri: "viking://c", score: 0.2, abstract: "the L0 abstract", level: 0 },
        ],
      },
    },
  }]);
  const client = new OpenVikingClient(config, { fetchImpl });

  const hits = await client.find("usr_alice", "q", {});

  assert.deepEqual(hits.map((row) => row.content), ["the file", "the L1 overview", "the L0 abstract"]);
  assert.deepEqual(hits.map((row) => row.score), [0.9, 0.5, 0.2]);
});

test("a delete sends its target as query parameters, because a body is refused", async () => {
  // Found against a running server: `DELETE /api/v1/fs` reads `uri` and
  // `recursive` from the query string and answers 400 to a JSON body. The
  // route sits on the privacy path — it is how a deleted project stops being
  // recallable — so the shape is pinned rather than remembered.
  const fetchImpl = recordingFetch([{ status: 200, body: { status: "ok", result: { estimated_deleted_count: 3 } } }]);
  const client = new OpenVikingClient(config, { fetchImpl });

  await client.remove("usr_alice", "viking://user/u-x/memories/evimed/project/p-y", { recursive: true });

  const [call] = fetchImpl.calls;
  assert.equal(call.options.method, "DELETE");
  assert.equal(call.options.body, undefined, "a body here is a 400");
  const url = new URL(call.url);
  assert.equal(url.pathname, "/api/v1/fs");
  assert.equal(url.searchParams.get("uri"), "viking://user/u-x/memories/evimed/project/p-y");
  assert.equal(url.searchParams.get("recursive"), "true");
});

test("a delete of something already gone is a success, because the index is meant to agree", async () => {
  const fetchImpl = recordingFetch([{ status: 404, body: upstreamError("NOT_FOUND", "File not found: viking://gone") }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  assert.equal(await client.remove("usr_alice", "viking://gone", { recursive: true }), false);
});

test("a delete that failed for any other reason is not reported as a delete", async () => {
  const fetchImpl = recordingFetch([{ status: 500, body: upstreamError("INTERNAL", "boom") }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  await assert.rejects(
    () => client.remove("usr_alice", "viking://x", { recursive: true }),
    (error) => error instanceof HttpError && error.code === "memory_index_upstream_error",
  );
});

test("a rejection names the call and the upstream reason, and carries no credential", async () => {
  // The reason arrives as `{status, error: {code, message, details}}`. Reading a
  // top-level `message` found nothing on that wire, so every rejection said the
  // same generic sentence and an operator had to guess which call had failed.
  const fetchImpl = recordingFetch([{
    status: 403,
    body: upstreamError("PERMISSION_DENIED", "Actor peer cannot access another peer's context."),
  }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  await assert.rejects(
    () => client.find("usr_alice", "q", {}),
    (error) => {
      assert.equal(error.code, "memory_index_auth_failed");
      assert.match(error.message, /POST \/api\/v1\/search\/find -> 403/);
      assert.match(error.message, /PERMISSION_DENIED: Actor peer cannot access another peer's context\./);
      assert.ok(!error.message.includes("test-key"), "the key must never reach a message");
      return true;
    },
  );
});

test("an upstream that says it is unavailable is reported as unavailable", async () => {
  // The same code a refused connection produces, because it is the same
  // outage as far as a recall is concerned, and both are worth retrying.
  const fetchImpl = recordingFetch([{ status: 503, body: upstreamError("UNAVAILABLE", "vector index is not ready") }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  await assert.rejects(
    () => client.find("usr_alice", "q", {}),
    (error) => error.code === "memory_index_unavailable" && /UNAVAILABLE: vector index is not ready/.test(error.message),
  );
});

test("a waiting write that timed out upstream is reported as a timeout, not as a mystery", async () => {
  // 504 means the content was written and its vector is still pending, which is
  // a retry, not a rejection of the request.
  const fetchImpl = recordingFetch([{ status: 504, body: upstreamError("DEADLINE_EXCEEDED", "queue processing exceeded 5.0s") }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  await assert.rejects(
    () => client.write("usr_alice", "viking://x/y.md", "text", { wait: true, timeoutSeconds: 5 }),
    (error) => error.code === "memory_index_timeout" && /DEADLINE_EXCEEDED/.test(error.message),
  );
});

test("a request that never answers becomes a timeout, not a hung recall", async () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const fetchImpl = recordingFetch([{ throws: abort }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  await assert.rejects(
    () => client.find("usr_alice", "q", {}),
    (error) => error instanceof HttpError && error.code === "memory_index_timeout",
  );
});

test("a path segment that is not a safe single segment is refused before it becomes a URI", async () => {
  const { memoryUri } = await import("../src/openVikingClient.mjs");
  for (const recordId of ["../escape", "with/slash", "", "a".repeat(200)]) {
    assert.throws(
      () => memoryUri("usr_alice", { scope: "user", scopeId: "", kind: "preference", recordId }),
      (error) => error instanceof HttpError && error.code === "memory_id_invalid",
      `${JSON.stringify(recordId)} was accepted into a path`,
    );
  }
});

test("a capsule fact round-trips through its URI, including the ids that are not path segments", () => {
  const generation = "2026-09-05 00:00:00+00";
  // Both shapes this system actually stores: a UUID, and a runtime note whose
  // id carries a colon. A third with a slash is included because an id that
  // escaped its segment would be a directory traversal, not a bad name.
  for (const factId of ["7b2f7d5c-6b1a-4a7b-9d0e-0a1b2c3d4e5f", "runtime-note:9f8e7d6c", "with/slash", "colon:and/slash"]) {
    const uri = capsuleFactUri("usr_alice", { accountCreatedAt: generation, capsuleId: "capsule-a", factKind: "analysis", factId, revision: 12 });
    assert.equal(uri.split("/").length, capsuleFactUri("usr_alice", {
      accountCreatedAt: generation, capsuleId: "capsule-a", factKind: "analysis", factId: "x", revision: 1,
    }).split("/").length, `${factId} added a path segment`);
    assert.deepEqual(parseCapsuleFactUri(uri), {
      capsuleSegment: capsuleSegment(generation, "capsule-a"),
      factKind: "analysis",
      factId,
      revision: 12,
    });
    assert.ok(uri.startsWith(`${capsuleMemoryRoot("usr_alice", { accountCreatedAt: generation, capsuleId: "capsule-a" })}/analysis/`));
  }
});

test("a capsule subtree is bound to the account generation, and sits under the user's capsule tree", () => {
  const capsuleId = "capsule-a";
  const first = capsuleMemoryRoot("usr_alice", { accountCreatedAt: "2026-09-05 00:00:00+00", capsuleId });
  const replacement = capsuleMemoryRoot("usr_alice", { accountCreatedAt: "2026-09-09 00:00:00+00", capsuleId });
  assert.notEqual(first, replacement, "a recreated account must not be able to read the previous generation's index");
  for (const root of [first, replacement]) {
    assert.ok(root.startsWith(`${capsuleTreeUri("usr_alice")}/`), "account deletion removes the tree, so every capsule must be inside it");
  }
  assert.notEqual(capsuleTreeUri("usr_alice"), capsuleTreeUri("usr_bob"));
  // Neither the generation nor the capsule id may be read off the path.
  assert.equal(first.includes(capsuleId), false);
  assert.equal(first.includes("2026"), false);
});

test("a capsule path refuses what it cannot encode, and never guesses", () => {
  const generation = "2026-09-05 00:00:00+00";
  const base = { accountCreatedAt: generation, capsuleId: "capsule-a", factKind: "analysis", factId: "fact", revision: 1 };
  const refused = [
    { ...base, factKind: "not_a_kind" },
    { ...base, factId: "" },
    { ...base, factId: "a".repeat(200) },
    { ...base, revision: 0 },
    { ...base, revision: 1.5 },
    { ...base, accountCreatedAt: "" },
    { ...base, capsuleId: "" },
  ];
  for (const input of refused) {
    assert.throws(
      () => capsuleFactUri("usr_alice", input),
      (error) => error instanceof HttpError && error.code === "memory_id_invalid",
      `${JSON.stringify(input)} was accepted into a path`,
    );
  }
});

test("a URI this layout never wrote parses to nothing at all", () => {
  const generation = "2026-09-05 00:00:00+00";
  const mine = capsuleFactUri("usr_alice", { accountCreatedAt: generation, capsuleId: "capsule-a", factKind: "analysis", factId: "fact", revision: 3 });
  const foreign = [
    "viking://user/u-x/memories/evimed/user/analysis/d006.md",
    "viking://user/u-x/memories/evimed/capsule/c-1/analysis/ffact.r3.md",
    "viking://user/u-x/memories/evimed/capsule/c-0123456789abcdef01234567/not_a_kind/fZmFjdA.r3.md",
    "viking://user/u-x/memories/evimed/capsule/c-0123456789abcdef01234567/analysis/fZmFjdA.r0.md",
    "viking://user/u-x/memories/evimed/capsule/c-0123456789abcdef01234567/analysis/f!!!!.r3.md",
    // Base64 that Node would decode by ignoring what it cannot use: the
    // re-encoding check is what makes a leaf we did not write parse to null.
    "viking://user/u-x/memories/evimed/capsule/c-0123456789abcdef01234567/analysis/fZmFjdA_.r3.md",
    mine.replace("/capsule/", "/peers/"),
  ];
  for (const uri of foreign) assert.equal(parseCapsuleFactUri(uri), null, `${uri} was read as a fact of ours`);
  assert.equal(parseCapsuleFactUri(mine)?.factId, "fact");
});

// --- the request primitive the modules built on the engine are written on -------------------------------------------

/** A fetch that answers with real `Response`s, which is what the primitive reads bytes and content types from. */
function responseFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const next = queue.shift() ?? { status: 200, body: {} };
    const body = Buffer.isBuffer(next.body) || typeof next.body === "string" ? next.body : next.body === undefined ? null : JSON.stringify(next.body);
    return new Response(next.status === 204 ? null : body, { status: next.status, headers: { "content-type": next.contentType ?? "application/json" } });
  };
  impl.calls = calls;
  return impl;
}

test("the primitive writes the credential and the identity, and a caller cannot add a header", async () => {
  const fetchImpl = responseFetch([{ status: 200, body: { status: "ok", result: [] } }, { status: 200, body: { status: "ok" } }, { status: 200, body: { status: "ok" } }]);
  const client = new OpenVikingClient(config, { fetchImpl });

  // A platform user id is hashed here; nothing of it reaches the engine.
  await client.request({ path: "/api/v1/fs/tree", query: { uri: "viking://user/x/resources", node_limit: 500, tags: ["a=1", "b=2"], absent: null, missing: undefined }, userId: "usr_alice", headers: { "X-OpenViking-Role": "root" } });
  const first = fetchImpl.calls[0];
  assert.equal(first.options.method, "GET");
  assert.equal(first.options.headers["X-API-Key"], "test-key");
  assert.equal(first.options.headers["X-OpenViking-Account"], "evimed");
  assert.equal(first.options.headers["X-OpenViking-User"], openVikingUserId("usr_alice"));
  assert.ok(!JSON.stringify(first.options.headers).includes("usr_alice"));
  assert.ok(!Object.keys(first.options.headers).some((name) => name.toLowerCase() === "x-openviking-role"), "a caller's header reached the engine");
  // The query is built here: arrays repeat the key, null and undefined are dropped, numbers are sent as text.
  assert.deepEqual(first.url.searchParams.getAll("tags"), ["a=1", "b=2"]);
  assert.equal(first.url.searchParams.get("node_limit"), "500");
  assert.ok(!first.url.searchParams.has("absent") && !first.url.searchParams.has("missing"));
  assert.equal(first.options.body, undefined);

  // An id that is already the engine's is sent as it is.
  await client.request({ method: "POST", path: "/api/v1/skills", openVikingUser: "evimed-engine", body: { data: "x" } });
  assert.equal(fetchImpl.calls[1].options.headers["X-OpenViking-User"], "evimed-engine");
  assert.equal(fetchImpl.calls[1].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].options.body), { data: "x" });

  // No acting user: the key alone, which is what the admin routes want.
  await client.request({ method: "DELETE", path: "/api/v1/admin/accounts/evimed/users/u-0f1e2d3c4b5a69788796a5b4" });
  assert.ok(!("X-OpenViking-User" in fetchImpl.calls[2].options.headers));
  assert.ok(!("X-OpenViking-Account" in fetchImpl.calls[2].options.headers));
  assert.equal(fetchImpl.calls[2].options.headers["X-API-Key"], "test-key");
});

test("the idempotency key is the one header a caller chooses, and only in the engine's own alphabet", async () => {
  const fetchImpl = responseFetch([{ status: 202, body: { status: "ok", result: { task_id: "cmp_1" } } }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  const answer = await client.request({ method: "POST", path: "/api/v1/compile", userId: "usr_alice", idempotencyKey: "evimed-kb-0123456789abcdef", body: { from: [], to: "viking://x" } });
  assert.equal(answer.result.task_id, "cmp_1");
  assert.equal(fetchImpl.calls[0].options.headers["Idempotency-Key"], "evimed-kb-0123456789abcdef");
  for (const key of ["short", "has space 0123456789abcdef", "x".repeat(129), "line\nbreak-0123456789abcdef"]) {
    await assert.rejects(() => client.request({ method: "POST", path: "/api/v1/compile", userId: "usr_alice", idempotencyKey: key, body: {} }),
      (error) => error.code === "memory_index_request_invalid" && error.status === 500);
  }
  assert.equal(fetchImpl.calls.length, 1, "a refused key reached the wire");
});

test("a request that is not a path under the engine's API, or names an impossible user, never leaves the process", async () => {
  const fetchImpl = responseFetch([]);
  const client = new OpenVikingClient(config, { fetchImpl });
  for (const request of [
    { path: "http://elsewhere.example/api/v1/fs/ls" }, { path: "/api/v1/fs/ls?uri=viking://x" }, { path: "/api/v2/anything" }, { path: "/bot/v1/chat" },
    { path: "api/v1/fs/ls" }, { path: "/api/v1/fs/ls", method: "TRACE" }, { path: "/api/v1/fs/ls", responseType: "stream" },
    { path: "/api/v1/fs/ls", openVikingUser: "has space" }, { path: "/api/v1/fs/ls", openVikingUser: "a/b" }, { path: "/api/v1/fs/ls", openVikingUser: ".." },
    { path: "/api/v1/fs/ls", openVikingUser: "a@b@c" },
    // An empty user is a defect, never "no user": without the identity headers the engine would serve its default user.
    { path: "/api/v1/fs/ls", openVikingUser: "" }, { path: "/api/v1/fs/ls", userId: "" },
  ]) {
    await assert.rejects(() => client.request(request), (error) => error.code === "memory_index_request_invalid", JSON.stringify(request));
  }
  assert.equal(fetchImpl.calls.length, 0);
  // `/health`, `/mcp` and anything under `/api/v1/` are the three shapes there are.
  const open = responseFetch([{ status: 200, body: { status: "ok" } }, { status: 200, body: "event: message\ndata: {}\n\n", contentType: "text/event-stream" }]);
  const other = new OpenVikingClient(config, { fetchImpl: open });
  await other.request({ path: "/health", authenticated: false });
  assert.ok(!("X-API-Key" in open.calls[0].options.headers), "the health probe carried the key");
  const stream = await other.request({ method: "POST", path: "/mcp", userId: "usr_alice", body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, responseType: "text" });
  assert.deepEqual(stream, { status: 200, contentType: "text/event-stream", text: "event: message\ndata: {}\n\n" });
  assert.equal(open.calls[1].options.headers.Accept, "application/json, text/event-stream");
});

test("bytes come back as bytes, an empty answer as null, and something that is not JSON is named", async () => {
  const stored = Buffer.from([0x23, 0x20, 0xe9, 0xa1, 0xb5, 0x0a, 0x00, 0xff]);
  const fetchImpl = responseFetch([
    { status: 200, body: stored, contentType: "application/octet-stream" },
    { status: 204 },
    { status: 200, body: "<html>not the engine</html>", contentType: "text/html" },
  ]);
  const client = new OpenVikingClient(config, { fetchImpl });
  const file = await client.request({ path: "/api/v1/content/download", query: { uri: "viking://agent/skills/llm-wiki/SKILL.md" }, openVikingUser: "evimed-engine", responseType: "bytes" });
  assert.equal(file.status, 200);
  assert.equal(file.contentType, "application/octet-stream");
  assert.ok(Buffer.isBuffer(file.bytes) && file.bytes.equals(stored), "the stored bytes were decoded on the way through");
  assert.equal(await client.request({ method: "DELETE", path: "/api/v1/sessions/s1", userId: "usr_alice" }), null);
  await assert.rejects(() => client.request({ path: "/api/v1/fs/ls", userId: "usr_alice" }), (error) => error.code === "memory_index_response_invalid" && error.status === 502);
});

test("every refusal has a name, the engine's own status, code and subject, and nothing of the query or the key", async () => {
  const cases = [
    [400, "INVALID_ARGUMENT", "memory_index_rejected", 502],
    [401, "UNAUTHENTICATED", "memory_index_auth_failed", 502],
    [403, "PERMISSION_DENIED", "memory_index_auth_failed", 502],
    [404, "NOT_FOUND", "memory_index_not_found", 404],
    [409, "ALREADY_EXISTS", "memory_index_conflict", 502],
    [412, "FAILED_PRECONDITION", "memory_index_precondition_failed", 502],
    [413, "RESOURCE_EXHAUSTED", "memory_index_payload_too_large", 502],
    [422, "INVALID_ARGUMENT", "memory_index_rejected", 502],
    [429, "RESOURCE_EXHAUSTED", "memory_index_rate_limited", 502],
    [500, "INTERNAL", "memory_index_upstream_error", 502],
    [503, "UNAVAILABLE", "memory_index_unavailable", 502],
    [504, "DEADLINE_EXCEEDED", "memory_index_timeout", 502],
  ];
  const { OPENVIKING_REQUEST_ERROR_CODES } = await import("../src/openVikingClient.mjs");
  for (const [status, upstreamCode, code, httpStatus] of cases) {
    const fetchImpl = responseFetch([{ status, body: { status: "error", result: null, error: { code: upstreamCode, message: "Account not found: evimed", details: { type: "account", resource: "evimed" } } } }]);
    const client = new OpenVikingClient(config, { fetchImpl });
    await assert.rejects(
      () => client.request({ path: "/api/v1/admin/accounts/evimed/memory-templates/profile", query: { uri: "viking://user/u-secret-subject/memories" }, openVikingUser: "evimed-engine" }),
      (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.code, code, `HTTP ${status}`);
        assert.equal(error.status, httpStatus);
        assert.equal(error.upstreamStatus, status);
        assert.equal(error.upstreamCode, upstreamCode);
        // Two 404s that mean different things — this file is not there, this account is not registered yet — are told
        // apart by what the engine says the refusal was about.
        assert.deepEqual(error.upstreamDetails, { type: "account", resource: "evimed" });
        assert.match(error.message, new RegExp(`^GET /api/v1/admin/accounts/evimed/memory-templates/profile -> ${status}: ${upstreamCode}: Account not found: evimed$`));
        assert.ok(!error.message.includes("u-secret-subject"), "a query's URI reached an error message");
        assert.ok(!error.message.includes("test-key"));
        assert.ok(OPENVIKING_REQUEST_ERROR_CODES.includes(error.code), `${error.code} is not a code the primitive declares`);
        return true;
      },
    );
  }
  // An error body that is not the engine's envelope still names the call.
  const bare = new OpenVikingClient(config, { fetchImpl: responseFetch([{ status: 502, body: "Bad Gateway", contentType: "text/plain" }]) });
  await assert.rejects(() => bare.request({ path: "/api/v1/fs/ls", userId: "usr_alice" }),
    (error) => error.code === "memory_index_upstream_error" && error.upstreamCode === null && error.upstreamDetails === null && /-> 502: The memory index rejected the request\.$/.test(error.message));
});

test("a request waits as long as it was told to, and a client that is not configured asks nothing", async () => {
  const slow = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const client = new OpenVikingClient({ ...config, openVikingRequestTimeoutMs: 60_000 }, { fetchImpl: slow });
  const started = Date.now();
  await assert.rejects(() => client.request({ method: "POST", path: "/api/v1/skills", openVikingUser: "evimed-engine", body: {}, timeoutMs: 40 }), (error) => error.code === "memory_index_timeout" && error.status === 503);
  assert.ok(Date.now() - started < 5_000, "the request waited for the client's default instead of its own deadline");

  let asked = 0;
  const unconfigured = new OpenVikingClient({ openVikingUrl: "", openVikingApiKeyError: "openviking_api_key_file_unavailable" }, { fetchImpl: async () => { asked += 1; return new Response("{}"); } });
  await assert.rejects(() => unconfigured.request({ path: "/api/v1/fs/ls", userId: "usr_alice" }), (error) => error.status === 503 && error.code === "openviking_api_key_file_unavailable");
  assert.equal(asked, 0);
});

test("a delete of something already gone is told from one that deleted, by the count v0.5.0 answers with", async () => {
  // Until v0.5.0 a missing target was a 404; now it is a 200 with a count of zero, and the callers that count what a
  // reconciliation removed would have counted every one.
  const fetchImpl = responseFetch([
    { status: 200, body: { status: "ok", result: { uri: "viking://x/a.md", estimated_deleted_count: 1 } } },
    { status: 200, body: { status: "ok", result: { uri: "viking://x/a.md", estimated_deleted_count: 0 } } },
    { status: 200, body: { status: "ok", result: { uri: "viking://x/a.md" } } },
  ]);
  const client = new OpenVikingClient(config, { fetchImpl });
  assert.equal(await client.remove("usr_alice", "viking://x/a.md"), true);
  assert.equal(await client.remove("usr_alice", "viking://x/a.md"), false);
  assert.equal(await client.remove("usr_alice", "viking://x/a.md"), true, "an answer with no count is a delete that happened, as it always was");
});
