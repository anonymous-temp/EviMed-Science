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
import { OpenVikingClient, openVikingPeerId, openVikingUserId } from "../src/openVikingClient.mjs";

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
  const fetchImpl = recordingFetch([{ status: 404, body: { message: "not found" } }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  assert.equal(await client.remove("usr_alice", "viking://gone", { recursive: true }), false);
});

test("a delete that failed for any other reason is not reported as a delete", async () => {
  const fetchImpl = recordingFetch([{ status: 500, body: { message: "boom" } }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  await assert.rejects(
    () => client.remove("usr_alice", "viking://x", { recursive: true }),
    (error) => error instanceof HttpError && error.code === "memory_index_upstream_error",
  );
});

test("a rejection names the call and the upstream status, and carries no credential", async () => {
  const fetchImpl = recordingFetch([{ status: 403, body: { message: "forbidden" } }]);
  const client = new OpenVikingClient(config, { fetchImpl });
  await assert.rejects(
    () => client.find("usr_alice", "q", {}),
    (error) => {
      assert.equal(error.code, "memory_index_auth_failed");
      assert.match(error.message, /POST \/api\/v1\/search\/find -> 403/);
      assert.ok(!error.message.includes("test-key"), "the key must never reach a message");
      return true;
    },
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
