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

test("a complete listing pages with offset until the page is short", async () => {
  const page = (count, from) => Array.from({ length: count }, (_, index) => ({ uri: `viking://x/f${from + index}.md`, isDir: false }));
  const fetchImpl = recordingFetch([
    { status: 200, body: { status: "ok", result: page(1_000, 0) } },
    { status: 200, body: { status: "ok", result: page(1_000, 1_000) } },
    { status: 200, body: { status: "ok", result: page(7, 2_000) } },
  ]);
  const client = new OpenVikingClient(config, { fetchImpl });

  const entries = await client.listAll("usr_alice", "viking://x");

  assert.equal(entries.length, 2_007);
  assert.deepEqual(
    fetchImpl.calls.map((call) => new URL(call.url).searchParams.get("offset")),
    ["0", "1000", "2000"],
  );
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
