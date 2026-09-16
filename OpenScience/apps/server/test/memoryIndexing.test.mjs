// The capsule index, against an OpenViking that behaves like the recorded one.
//
// The fake below is a fake *server*, not a fake client: every call still goes
// through the real `OpenVikingClient`, so the wire shapes this lane depends on
// are exercised rather than assumed. It reproduces what was probed off
// v0.4.19 — `ls` answers a bare list and pages by `offset`, `DELETE /api/v1/fs`
// refuses a JSON body, a missing target is 404, every request needs the key,
// `find` applies its own 0.1 threshold when the caller does not send one, and
// errors arrive as `{status, error: {code, message}}`.
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryIndexing } from "../src/memoryIndexing.mjs";
import { MemoryIndexWorker } from "../src/memoryIndexWorker.mjs";
import { OpenVikingClient, capsuleFactUri, capsuleMemoryRoot, capsuleTreeUri, parseCapsuleFactUri } from "../src/openVikingClient.mjs";

const generation = "2026-09-05 00:00:00+00";
const apiKey = "index-test-key";

function openVikingFake({ pageSize = 1_000 } = {}) {
  /** @type {Map<string,string>} */
  const files = new Map();
  const calls = [];
  const state = { failure: null };
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  });
  const failed = (status, code, message) => reply(status, { status: "error", error: { code, message, details: {} } });

  const impl = async (url, options = {}) => {
    const target = new URL(url);
    const method = options.method ?? "GET";
    const headers = options.headers ?? {};
    const body = options.body == null ? null : JSON.parse(options.body);
    calls.push({ path: target.pathname, method, params: target.searchParams, body });
    if (target.pathname === "/health") return reply(200, { status: "ok", healthy: true, version: "v0.4.19", auth_mode: "trusted" });
    if (headers["X-API-Key"] !== apiKey) {
      return failed(401, "UNAUTHENTICATED", "Missing API Key in trusted mode with Root API Key enabled.");
    }
    if (state.failure) return failed(state.failure.status, state.failure.code, "The fixture failed this call.");
    if (method === "POST" && target.pathname === "/api/v1/content/write") {
      if (!body?.uri || typeof body.content !== "string") return failed(400, "INVALID_ARGUMENT", "A write needs a uri and content.");
      files.set(body.uri, body.content);
      return reply(200, { status: "ok", result: {
        uri: body.uri, mode: body.mode, written_bytes: body.content.length,
        semantic_status: "skipped", vector_status: body.wait ? "complete" : "queued",
      } });
    }
    if (method === "DELETE" && target.pathname === "/api/v1/fs") {
      if (body != null) return failed(400, "INVALID_ARGUMENT", "A JSON body is not supported here.");
      const uri = target.searchParams.get("uri") ?? "";
      const recursive = target.searchParams.get("recursive") === "true";
      const victims = [...files.keys()].filter((key) => key === uri || (recursive && key.startsWith(`${uri}/`)));
      if (!victims.length) return failed(404, "NOT_FOUND", "No such file or directory.");
      for (const victim of victims) files.delete(victim);
      return reply(200, { status: "ok", result: { uri, estimated_deleted_count: victims.length } });
    }
    if (method === "GET" && target.pathname === "/api/v1/fs/ls") {
      const uri = target.searchParams.get("uri") ?? "";
      const offset = Number(target.searchParams.get("offset") ?? 0);
      const explicit = target.searchParams.get("limit");
      /** @type {Map<string,boolean>} */
      const children = new Map();
      for (const key of files.keys()) {
        if (!key.startsWith(`${uri}/`)) continue;
        const rest = key.slice(uri.length + 1);
        children.set(`${uri}/${rest.split("/")[0]}`, rest.includes("/"));
      }
      if (!children.size) return failed(404, "NOT_FOUND", "No such directory.");
      const entries = [...children].sort(([left], [right]) => left.localeCompare(right))
        .map(([uri_, isDir]) => ({ uri: uri_, size: 1, isDir, modTime: "2026-09-11T00:00:00Z", abstract: "" }));
      // A limit truncates silently and says nothing about what it dropped,
      // which is why the client must never send one.
      return reply(200, { status: "ok", result: entries.slice(offset, offset + (explicit ? Number(explicit) : pageSize)) });
    }
    if (method === "POST" && target.pathname === "/api/v1/search/find") {
      const targets = Array.isArray(body?.target_uri) ? body.target_uri : body?.target_uri ? [body.target_uri] : [];
      // The server's own default, applied by the retriever even with no
      // reranker configured: a caller that sends nothing loses its weak hits.
      const threshold = body?.score_threshold ?? 0.1;
      const terms = String(body?.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const memories = [...files.entries()]
        .filter(([uri]) => targets.some((prefix) => uri.startsWith(`${prefix}/`)))
        .map(([uri, content]) => ({
          uri,
          content,
          score: terms.length ? terms.filter((term) => content.toLowerCase().includes(term)).length / terms.length : 0,
        }))
        .filter((hit) => hit.score > threshold)
        .sort((left, right) => right.score - left.score || left.uri.localeCompare(right.uri))
        .slice(0, Number(body?.node_limit ?? 10))
        .map((hit) => ({
          context_type: "memory", uri: hit.uri, level: 2, score: hit.score, abstract: hit.content.slice(0, 40),
          ...(body?.read_content ? { content: hit.content } : {}),
        }));
      return reply(200, { status: "ok", result: { memories, resources: [], skills: [], total: memories.length } });
    }
    return failed(404, "NOT_FOUND", "No such route.");
  };

  const client = new OpenVikingClient({
    openVikingUrl: "http://openviking.internal:1933",
    openVikingApiKey: apiKey,
    openVikingAccount: "evimed",
    openVikingRequestTimeoutMs: 1_000,
  }, { fetchImpl: impl });
  return { client, files, calls, fail(failure) { state.failure = failure; } };
}

/** Put one fact into the index the way a rebuild would. */
function indexFact(fake, userId, { capsuleId, factKind, factId, revision, content, accountCreatedAt = generation }) {
  fake.files.set(capsuleFactUri(userId, { accountCreatedAt, capsuleId, factKind, factId, revision }), content);
}

test("semantic recall preserves index order but reloads approved current facts from PostgreSQL", async () => {
  const fake = openVikingFake();
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: "stale", revision: 1, content: "kidney prose the index still holds" });
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "decision", factId: "current", revision: 3, content: "kidney prose the index holds" });
  indexFact(fake, "owner", { capsuleId: "capsule-b", factKind: "analysis", factId: "wrong-capsule", revision: 2, content: "kidney prose in a deactivated capsule" });
  const database = {
    async query(sql) {
      if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
      if (sql.includes("kind='preferences'")) return { rows: [{ id: "active-capsules:account", payload: { items: [{ capsuleId: "capsule-a", mode: "own" }] } }] };
      return { rows: [
        { id: "stale", revision: 2, payload: { capsuleId: "capsule-a", status: "approved", content: "new revision" } },
        { id: "current", revision: 3, payload: { capsuleId: "capsule-a", status: "approved", content: "canonical fact" } },
        { id: "wrong-capsule", revision: 2, payload: { capsuleId: "capsule-b", status: "approved", content: "deactivated fact" } },
      ] };
    },
  };
  const indexing = new MemoryIndexing({ database, openViking: fake.client, jobs: {} });
  const results = await indexing.recall("owner", generation,
    [{ capsuleId: "capsule-a", mode: "own" }, { capsuleId: "capsule-b", mode: "read" }], "kidney", 10);
  assert.deepEqual(results.map((item) => item.row.payload.content), ["canonical fact"]);
  assert.equal(results[0].selection.capsuleId, "capsule-a");
  assert.ok(results.every((item) => item.row.id !== "wrong-capsule"));
  const find = fake.calls.find((call) => call.path === "/api/v1/search/find");
  assert.equal(find.body.score_threshold, 0, "the server's 0.1 default would drop weak but correct hits");
  assert.equal(find.body.level, 2, "a directory record names no fact and would waste a result slot");
  assert.deepEqual(find.body.target_uri, [
    capsuleMemoryRoot("owner", { accountCreatedAt: generation, capsuleId: "capsule-a" }),
    capsuleMemoryRoot("owner", { accountCreatedAt: generation, capsuleId: "capsule-b" }),
  ]);
});

test("a deployment may ask the index for a relevance floor, and gets none by default", async () => {
  const fake = openVikingFake();
  const database = {
    async query(sql) {
      if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
      return { rows: [] };
    },
  };
  const selections = [{ capsuleId: "capsule-a", mode: "own" }];
  for (const [scoreThreshold, sent] of [[undefined, 0], [0.25, 0.25]]) {
    await new MemoryIndexing({ database, openViking: fake.client, jobs: {}, scoreThreshold })
      .recall("owner", generation, selections, "kidney", 10);
    assert.equal(fake.calls.filter((call) => call.path === "/api/v1/search/find").at(-1).body.score_threshold, sent);
  }
});

test("a recall from another account generation reaches nothing, because the path is bound to it", async () => {
  const fake = openVikingFake();
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: "fact", revision: 1, content: "kidney outcomes" });
  const database = {
    async query(sql) {
      if (sql.includes("evimed_control.users")) return { rows: [{ generation: "2026-09-09 00:00:00+00" }] };
      if (sql.includes("kind='preferences'")) return { rows: [{ id: "active-capsules:account", payload: { items: [{ capsuleId: "capsule-a", mode: "own" }] } }] };
      return { rows: [{ id: "fact", revision: 1, payload: { capsuleId: "capsule-a", status: "approved", content: "canonical" } }] };
    },
  };
  const indexing = new MemoryIndexing({ database, openViking: fake.client, jobs: {} });
  assert.deepEqual(await indexing.recall("owner", "2026-09-09 00:00:00+00",
    [{ capsuleId: "capsule-a", mode: "own" }], "kidney", 10), []);
});

test("a configured reranker reorders the hydrated candidates, and a failing one changes nothing", async () => {
  const fake = openVikingFake();
  for (const [factId, content] of [["first", "kidney one"], ["second", "kidney two"]]) {
    indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId, revision: 1, content });
  }
  const database = {
    async query(sql) {
      if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
      if (sql.includes("kind='preferences'")) return { rows: [{ id: "active-capsules:account", payload: { items: [{ capsuleId: "capsule-a", mode: "own" }] } }] };
      return { rows: [
        { id: "first", revision: 1, payload: { capsuleId: "capsule-a", status: "approved", content: "first canonical" } },
        { id: "second", revision: 1, payload: { capsuleId: "capsule-a", status: "approved", content: "second canonical" } },
      ] };
    },
  };
  const seen = [];
  const reversing = { configured: true, async order(query, documents) { seen.push({ query, documents }); return documents.map((_, index) => documents.length - 1 - index); } };
  const selections = [{ capsuleId: "capsule-a", mode: "own" }];
  const vector = await new MemoryIndexing({ database, openViking: fake.client, jobs: {} }).recall("owner", generation, selections, "kidney", 10);
  const reranked = await new MemoryIndexing({ database, openViking: fake.client, jobs: {}, rerank: reversing })
    .recall("owner", generation, selections, "kidney", 10);
  assert.deepEqual(reranked.map((item) => item.row.id), [...vector.map((item) => item.row.id)].reverse());
  assert.deepEqual(seen[0].documents, vector.map((item) => item.row.payload.content),
    "the reranker must score the canonical text, not the copy the index holds");

  const throwing = { configured: true, async order() { throw new Error("rerank endpoint down"); } };
  const failed = await new MemoryIndexing({ database, openViking: fake.client, jobs: {}, rerank: throwing })
    .recall("owner", generation, selections, "kidney", 10);
  assert.deepEqual(failed.map((item) => item.row.id), vector.map((item) => item.row.id), "a reranker is an improvement, never a dependency");
});

test("readback compares exact fact and revision pairs read from the paths", async () => {
  const fake = openVikingFake();
  const snapshot = { userId: "owner", generation, capsuleId: "capsule-a",
    entries: [{ id: "runtime-note:ab12", revision: 4, factKind: "analysis", layer: "knowledge", content: "text" }] };
  const indexing = new MemoryIndexing({ database: {}, openViking: fake.client, jobs: {} });

  // A capsule that was never written answers 404 to `ls`. That has to read as
  // an empty index rather than as a transport failure, or rebuild — which calls
  // this before it writes anything — could never be the thing that repairs it.
  await assert.rejects(indexing.readback(snapshot), { code: "memory_index_readback_incomplete" });

  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: "runtime-note:ab12", revision: 3, content: "text" });
  await assert.rejects(indexing.readback(snapshot), { code: "memory_index_readback_mismatch" });

  fake.files.clear();
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "decision", factId: "runtime-note:ab12", revision: 4, content: "text" });
  await assert.rejects(indexing.readback(snapshot), { code: "memory_index_readback_mismatch" }, "a leaf under the wrong kind is an extra");

  fake.files.clear();
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: "runtime-note:ab12", revision: 4, content: "text" });
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: "unknown", revision: 1, content: "text" });
  await assert.rejects(indexing.readback(snapshot), { code: "memory_index_readback_mismatch" });

  fake.files.delete(capsuleFactUri("owner", { accountCreatedAt: generation, capsuleId: "capsule-a", factKind: "analysis", factId: "unknown", revision: 1 }));
  const { found, foreign } = await indexing.readback(snapshot);
  assert.deepEqual(found.map((entry) => [entry.factId, entry.revision]), [["runtime-note:ab12", 4]]);
  assert.equal(foreign, 0);

  fake.files.clear();
  assert.deepEqual(await indexing.readback({ ...snapshot, entries: [] }), { found: [], foreign: 0 },
    "an empty capsule has an empty index, not a missing one");
});

test("readback counts what this layout never wrote instead of rebuilding the capsule over it", async () => {
  // The server materializes artifacts of its own beside the files it is given,
  // and a rewrite cannot remove what it did not write. Raising on one would
  // fail the readback after every rebuild, which re-arms the job, which
  // rebuilds again — a capsule that can never publish. None of it can be
  // delivered either way: a hit is only ever delivered by hydrating the
  // canonical row its path names.
  const fake = openVikingFake();
  const root = capsuleMemoryRoot("owner", { accountCreatedAt: generation, capsuleId: "capsule-a" });
  const snapshot = { userId: "owner", generation, capsuleId: "capsule-a",
    entries: [{ id: "fact-a", revision: 1, factKind: "analysis", layer: "knowledge", content: "text" }] };
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: "fact-a", revision: 1, content: "text" });
  fake.files.set(`${root}/overview.md`, "a directory abstract the server wrote for itself");
  fake.files.set(`${root}/analysis/abstract.md`, "and one inside a kind directory");

  const readback = await new MemoryIndexing({ database: {}, openViking: fake.client, jobs: {} }).readback(snapshot);

  assert.deepEqual(readback.found.map((entry) => entry.factId), ["fact-a"]);
  assert.equal(readback.foreign, 2, "what we did not write is reported, not enforced");
});

test("readback pages a directory with offset, whatever page the server happens to serve", async () => {
  // More facts than one page holds, against two servers whose pages differ.
  // The page size is the server's business and is announced nowhere, so a
  // reader that assumed one would call this capsule incomplete forever against
  // the smaller page, and see duplicate leaves against the larger — and the
  // worker would rebuild it on every reconciliation either way.
  for (const pageSize of [1_000, 400]) {
    const fake = openVikingFake({ pageSize });
    const entries = [];
    for (let index = 0; index <= 1_000; index++) {
      entries.push({ id: `fact-${index}`, revision: 1, factKind: "analysis", layer: "knowledge", content: "text" });
      indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: `fact-${index}`, revision: 1, content: "text" });
    }
    const indexing = new MemoryIndexing({ database: {}, openViking: fake.client, jobs: {} });
    const { found } = await indexing.readback({ userId: "owner", generation, capsuleId: "capsule-a", entries });
    assert.equal(found.length, 1_001, `a server paging by ${pageSize} must still read the whole capsule`);
    const listings = fake.calls.filter((call) => call.path === "/api/v1/fs/ls");
    const leafPages = listings.filter((call) => call.params.get("uri").endsWith("/analysis"));
    assert.deepEqual(leafPages.map((call) => Number(call.params.get("offset"))),
      Array.from({ length: Math.ceil(1_001 / pageSize) + 1 }, (_, page) => Math.min(1_001, page * pageSize)),
      "each request must start where the last page ended, and the walk ends on an empty page");
    assert.ok(listings.every((call) => call.params.get("limit") === null), "a limit truncates silently and hides what it dropped");
  }
});

test("rebuild rewrites the capsule subtree, waits for each write and publishes the fingerprint", async () => {
  const fake = openVikingFake();
  const facts = [
    { id: "runtime-note:ff01", revision: 2, payload: { capsuleId: "capsule-a", status: "approved", factKind: "analysis", layer: "knowledge", content: "kidney outcomes" } },
    { id: "fact-b", revision: 1, payload: { capsuleId: "capsule-a", status: "approved", factKind: "method_preference", layer: "methods", content: "prefers network meta-analysis" } },
  ];
  const published = [];
  const rows = (sql) => {
    if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
    if (sql.includes("kind='capsule'")) return { rows: [{ id: "capsule-a", revision: 2, payload: {}, deleted_at: null }] };
    if (sql.includes("kind='fact'")) return { rows: facts };
    if (sql.includes("memory_index_state")) return { rows: [] };
    return { rows: [] };
  };
  const database = {
    async query(sql) { return rows(sql); },
    pool: { async connect() { return { async query() { return { rows: [] }; }, release() {} }; } },
  };
  const jobs = {
    async finishWithLease(userId, id, leaseToken, result, operation) {
      await operation({ async query(sql, values) { published.push([sql, values]); return rows(sql); } });
      return { status: "succeeded", result };
    },
  };
  // Something an earlier generation of this capsule left behind must not
  // survive the rewrite.
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: "removed", revision: 1, content: "gone" });
  const indexing = new MemoryIndexing({ database, openViking: fake.client, jobs });
  const outcome = await indexing.rebuild({ userId: "owner", id: "job", leaseToken: "lease", payload: { capsuleId: "capsule-a", accountCreatedAt: generation } });

  assert.equal(outcome.result.status, "published");
  assert.equal(outcome.result.entries, 2);
  assert.deepEqual([...fake.files.keys()].map((uri) => parseCapsuleFactUri(uri)).map((entry) => [entry.factId, entry.revision, entry.factKind]).sort(),
    [["fact-b", 1, "method_preference"], ["runtime-note:ff01", 2, "analysis"]].sort());
  assert.equal([...fake.files.values()][0].startsWith("analysis / knowledge\n\n"), true, "the kind and the layer lead the file");
  const writes = fake.calls.filter((call) => call.path === "/api/v1/content/write");
  assert.ok(writes.every((call) => call.body.wait === true && call.body.timeout > 0),
    "a file the server has not embedded yet is invisible to find, so the readback that follows would be a coin toss");
  assert.equal(fake.calls.filter((call) => call.method === "DELETE").length, 1);
  const insert = published.find(([sql]) => sql.includes("INSERT INTO evimed_product.memory_index_state"));
  assert.ok(insert, "a rebuild that published nothing would be rebuilt forever");
  assert.doesNotMatch(insert[0], /engine_memory_ids/);
});

test("a fact that cannot become a path is skipped and counted, not left to empty its capsule", async () => {
  // Nothing stops a fact row being written without a `factKind` — the index is
  // the first thing that needs one, and rows predating it have none. Failing
  // the capsule on one of them is not a safe answer: the rebuild removed the
  // subtree before it discovered the bad row, the worker treats a refused path
  // as terminal, and reconcile re-arms the job, so the capsule would stay empty
  // with nothing said to the researcher.
  const fake = openVikingFake();
  const facts = [
    { id: "fact-a", revision: 1, payload: { capsuleId: "capsule-a", status: "approved", factKind: "analysis", layer: "knowledge", content: "publishable" } },
    { id: "fact-legacy", revision: 1, payload: { capsuleId: "capsule-a", status: "approved", layer: "knowledge", content: "no kind at all" } },
    { id: "fact-alien", revision: 1, payload: { capsuleId: "capsule-a", status: "approved", factKind: "unknown_kind", layer: "knowledge", content: "a kind this system never records" } },
  ];
  const rows = (sql) => {
    if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
    if (sql.includes("kind='capsule'")) return { rows: [{ id: "capsule-a", revision: 1, payload: {}, deleted_at: null }] };
    if (sql.includes("kind='fact'")) return { rows: facts };
    return { rows: [] };
  };
  const database = {
    async query(sql) { return rows(sql); },
    pool: { async connect() { return { async query() { return { rows: [] }; }, release() {} }; } },
  };
  const jobs = { async finishWithLease(userId, id, leaseToken, result, operation) { await operation({ async query(sql) { return rows(sql); } }); return { result }; } };
  const indexing = new MemoryIndexing({ database, openViking: fake.client, jobs });

  const outcome = await indexing.rebuild({ userId: "owner", id: "job", leaseToken: "lease", payload: { capsuleId: "capsule-a", accountCreatedAt: generation } });

  assert.equal(outcome.result.status, "published");
  assert.equal(outcome.result.entries, 1);
  assert.equal(outcome.result.unpublishable, 2, "what was skipped is reported on the job, where an operator can see it");
  assert.deepEqual([...fake.files.keys()].map((uri) => parseCapsuleFactUri(uri).factId), ["fact-a"]);
});

test("a rebuild whose writes fail leaves no publication and reports the upstream reason", async () => {
  const fake = openVikingFake();
  const rows = (sql) => {
    if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
    if (sql.includes("kind='capsule'")) return { rows: [{ id: "capsule-a", revision: 1, payload: {}, deleted_at: null }] };
    if (sql.includes("kind='fact'")) {
      return { rows: [{ id: "fact-a", revision: 1, payload: { capsuleId: "capsule-a", status: "approved", factKind: "analysis", layer: "knowledge", content: "text" } }] };
    }
    return { rows: [] };
  };
  let published = false;
  const database = {
    async query(sql) { return rows(sql); },
    pool: { async connect() { return { async query() { return { rows: [] }; }, release() {} }; } },
  };
  const indexing = new MemoryIndexing({ database, openViking: fake.client,
    jobs: { async finishWithLease() { published = true; } } });
  fake.fail({ status: 503, code: "UNAVAILABLE" });
  await assert.rejects(
    indexing.rebuild({ userId: "owner", id: "job", leaseToken: "lease", payload: { capsuleId: "capsule-a", accountCreatedAt: generation } }),
    (error) => {
      // The code says what happened (the server answered 503), and the message
      // carries the reason the server gave for it.
      assert.equal(error.code, "memory_index_unavailable");
      assert.match(error.message, /UNAVAILABLE: The fixture failed this call\./, "the upstream reason must survive the client");
      return true;
    },
  );
  assert.equal(published, false);
});

test("final snapshots lock mutable capsule rows without reversing the account deletion lock order", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
      if (sql.includes("kind='capsule'")) {
        return { rows: [{ id: "capsule-a", revision: 2, payload: {}, deleted_at: null }] };
      }
      return { rows: [] };
    },
  };
  const indexing = new MemoryIndexing({ database: {}, openViking: {}, jobs: {} });
  await indexing.snapshot("owner", "capsule-a", { client, lock: true });
  assert.doesNotMatch(queries[0], /FOR SHARE/);
  assert.match(queries[1], /FOR SHARE/);
  assert.match(queries[2], /FOR SHARE/);
});

test("account deletion locks and removes every canonical or published capsule subtree", async () => {
  const fake = openVikingFake();
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push([sql, values]);
      if (sql.includes("evimed_control.users")) return { rows: [{ generation }] };
      if (sql.includes("UNION SELECT")) return { rows: [{ capsule_id: "capsule-a" }, { capsule_id: "capsule-b" }] };
      return { rows: [] };
    },
  };
  for (const capsuleId of ["capsule-a", "capsule-b"]) {
    indexFact(fake, "owner", { capsuleId, factKind: "analysis", factId: "fact", revision: 1, content: "text" });
  }
  // A subtree from an earlier account generation, which no ledger row names.
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: "fact", revision: 1, content: "older", accountCreatedAt: "2026-01-01 00:00:00+00" });
  const indexing = new MemoryIndexing({ database: {}, openViking: fake.client, jobs: {} });

  assert.deepEqual(await indexing.prepareAccountDeletion("owner", generation, client), { scopes: 2, verified: true });
  assert.equal(fake.files.size, 0, "every capsule subtree of this user must be gone, including one no row names");
  const deletes = fake.calls.filter((call) => call.method === "DELETE");
  assert.deepEqual(deletes.map((call) => call.params.get("uri")), [
    capsuleMemoryRoot("owner", { accountCreatedAt: generation, capsuleId: "capsule-a" }),
    capsuleMemoryRoot("owner", { accountCreatedAt: generation, capsuleId: "capsule-b" }),
    capsuleTreeUri("owner"),
  ]);
  assert.ok(deletes.every((call) => call.params.get("recursive") === "true" && call.body === null),
    "a JSON body is answered 400 by this route");
  const locks = calls.filter(([sql]) => sql.includes("pg_advisory_xact_lock"));
  assert.deepEqual(locks.map(([, values]) => values[0]), ["memory-index:owner:capsule-a", "memory-index:owner:capsule-b"]);
});

test("account deletion acquires the shared memory-index lock before any user-row work", async () => {
  const calls = [];
  const indexing = new MemoryIndexing({ database: {}, openViking: {}, jobs: {} });
  await indexing.lockAccountDeletion("owner", { async query(sql, values) { calls.push([sql, values]); } });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0][1], ["memory-index-account:owner"]);
});

test("rebuild acquires account before capsule and releases both on an early superseded job", async () => {
  const queries = [];
  let released = 0;
  const connection = {
    async query(sql, values) { queries.push([sql, values]); },
    release() { released++; },
  };
  const indexing = new MemoryIndexing({
    database: { pool: { async connect() { return connection; } } },
    openViking: {},
    jobs: { async finish() { return { status: "superseded_account_generation" }; } },
  });
  indexing.snapshot = async () => null;
  await indexing.rebuild({ userId: "owner", id: "job", leaseToken: "lease", payload: { capsuleId: "capsule-a", accountCreatedAt: generation } });
  assert.deepEqual(queries.map(([, values]) => values[0]), [
    "memory-index-account:owner",
    "memory-index:owner:capsule-a",
    "memory-index:owner:capsule-a",
    "memory-index-account:owner",
  ]);
  assert.match(queries[0][0], /pg_advisory_lock/);
  assert.match(queries[1][0], /pg_advisory_lock/);
  assert.match(queries[2][0], /pg_advisory_unlock/);
  assert.match(queries[3][0], /pg_advisory_unlock/);
  assert.equal(released, 1);
});

test("account deletion refuses a stale generation before taking capsule locks or removing anything", async () => {
  const fake = openVikingFake();
  indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: "fact", revision: 1, content: "text" });
  const indexing = new MemoryIndexing({ database: {}, openViking: fake.client, jobs: {} });
  const client = { async query() { return { rows: [{ generation: "another-generation" }] }; } };
  await assert.rejects(indexing.prepareAccountDeletion("owner", generation, client), { code: "memory_account_changed" });
  assert.equal(fake.files.size, 1);
});

test("worker uses ProductJobs leases and retries a bounded failed index job", async () => {
  const calls = [];
  const job = { id: "job", userId: "owner", leaseToken: "lease", attempts: 1, payload: {} };
  const jobs = {
    async claim() { calls.push("claim"); return job; },
    async renew() { return true; },
    async fail(...args) { calls.push(["fail", ...args]); },
  };
  const indexing = { async rebuild() { const error = new Error("private detail"); error.code = "memory_index_unavailable"; throw error; }, async reconcile() {} };
  const worker = new MemoryIndexWorker({ jobs, indexing, pollMs: 60_000, leaseMs: 3_000, reconcileMs: 60_000 });
  await worker.tick();
  assert.equal(calls[0], "claim");
  assert.equal(calls[1][0], "fail");
  assert.deepEqual(calls[1][5], { retry: true, delayMs: 2000 });
  assert.equal(calls[1][4].message, "Memory indexing failed.");
});

// One worker, two producers. The capsule half publishes approved facts; the
// record half carries one research memory. They are dispatched by the kind the
// queue leased, never by inspecting a payload, so a capsule job can never be
// handed to the component that indexes records and call it a bad payload.
test("the worker leases both halves of the index and gives each to the component that owns it", async () => {
  const claimed = [
    { id: "job-capsule", userId: "owner", leaseToken: "lease", attempts: 0, kind: "memory-index", payload: { capsuleId: "c" } },
    { id: "job-record", userId: "owner", leaseToken: "lease", attempts: 0, kind: "memory-record-index", payload: { recordId: "r" } },
  ];
  const asked = [];
  const jobs = {
    async claim(kinds) { asked.push(kinds); return claimed.shift() ?? null; },
    async renew() { return true; },
  };
  const ran = [];
  const indexing = { async rebuild(job) { ran.push(["capsule", job.id]); return { status: "published" }; }, async reconcile() {} };
  const substrate = { async indexRecord(job) { ran.push(["record", job.id]); return { status: "indexed" }; } };
  const worker = new MemoryIndexWorker({ jobs, indexing, substrate, pollMs: 60_000, reconcileMs: 60_000 });

  assert.deepEqual(worker.kinds, ["memory-index", "memory-record-index"]);
  await worker.tick();
  await worker.tick();
  assert.deepEqual(ran, [["capsule", "job-capsule"], ["record", "job-record"]]);
  assert.deepEqual(asked[0], ["memory-index", "memory-record-index"]);
});

test("a worker with no substrate does not lease the work it could not run", () => {
  const worker = new MemoryIndexWorker({ jobs: {}, indexing: {}, pollMs: 60_000, reconcileMs: 60_000 });
  assert.deepEqual(worker.kinds, ["memory-index"]);
});

test("worker stops retrying a job whose input the index will refuse again", async () => {
  const calls = [];
  const jobs = {
    async claim() { return { id: "job", userId: "owner", leaseToken: "lease", attempts: 1, payload: {} }; },
    async renew() { return true; },
    async fail(...args) { calls.push(args); },
  };
  for (const code of ["memory_index_job_invalid", "memory_id_invalid"]) {
    const indexing = { async rebuild() { const error = new Error("input"); error.code = code; throw error; }, async reconcile() {} };
    await new MemoryIndexWorker({ jobs, indexing, pollMs: 60_000, reconcileMs: 60_000 }).tick();
    assert.deepEqual(calls.at(-1)[4], { retry: false, delayMs: 0 }, `${code} must not be retried`);
  }
});

// Both halves can be left behind by the same outage, so both are reconciled.
// The capsule ledger re-arms from what it published; the record half re-arms
// the jobs its writers enqueued. A reconcile that drove only one of them would
// leave a deleted memory's copy in the index with nothing left to remove it.
test("the reconcile drives both halves of the index, not only the one it started with", async () => {
  const ran = [];
  const indexing = { async reconcile() { ran.push("capsules"); return 1; } };
  const substrate = { async reconcileRecords() { ran.push("records"); return 2; } };
  const worker = new MemoryIndexWorker({ jobs: {}, indexing, substrate, pollMs: 60_000, reconcileMs: 60_000 });
  await worker.reconcile();
  assert.deepEqual(ran.sort(), ["capsules", "records"]);
});

test("a worker with no substrate still reconciles the half it has", async () => {
  const ran = [];
  const indexing = { async reconcile() { ran.push("capsules"); return 1; } };
  const worker = new MemoryIndexWorker({ jobs: {}, indexing, pollMs: 60_000, reconcileMs: 60_000 });
  await worker.reconcile();
  assert.deepEqual(ran, ["capsules"]);
  assert.equal(worker.status().lastError, null);
});

test("with no index provider the worker drains the queue instead of letting it grow", async () => {
  // `MEMORY_INDEX_PROVIDER=builtin` composes no index, but the database trigger
  // that enqueues these jobs fires on every capsule and fact write regardless —
  // a Postgres trigger cannot read a Node config. Nothing was constructed to
  // claim them, so they accumulated silently: two had been queued since
  // 2026-09-15 when the 2026-09-16 review found them (M5).
  const claimed = [
    { id: "job-capsule", userId: "owner", leaseToken: "lease", attempts: 0, kind: "memory-index", payload: { capsuleId: "c" } },
    { id: "job-record", userId: "owner", leaseToken: "lease", attempts: 0, kind: "memory-record-index", payload: { recordId: "r" } },
  ];
  const finished = [];
  const jobs = {
    async claim() { return claimed.shift() ?? null; },
    async renew() { return true; },
    async finish(userId, id, leaseToken, result) { finished.push([id, result]); return result; },
    async fail(...args) { finished.push(["fail", ...args]); },
  };
  const worker = new MemoryIndexWorker({ jobs, indexing: null, pollMs: 60_000, reconcileMs: 60_000 });

  assert.equal(worker.draining, true);
  assert.deepEqual(worker.kinds, ["memory-index", "memory-record-index"], "with no index, neither half has a claimer");
  await worker.tick();
  await worker.tick();
  assert.deepEqual(finished, [
    ["job-capsule", { skipped: "no_index_provider" }],
    ["job-record", { skipped: "no_index_provider" }],
  ], "the job rows say why they were closed rather than disappearing");

  // And reconcile has nothing to reconcile against, rather than throwing on a
  // null index every interval.
  await worker.reconcile();
  assert.equal(worker.lastError, null);
});

test("an index provider still does the indexing rather than draining", async () => {
  const jobs = {
    async claim() { return { id: "job", userId: "owner", leaseToken: "lease", attempts: 0, kind: "memory-index", payload: { capsuleId: "c" } }; },
    async renew() { return true; },
    async finish() { throw new Error("a composed index must not drain its own queue"); },
  };
  const ran = [];
  const indexing = { async rebuild(job) { ran.push(job.id); return { status: "published" }; }, async reconcile() {} };
  const worker = new MemoryIndexWorker({ jobs, indexing, pollMs: 60_000, reconcileMs: 60_000 });
  assert.equal(worker.draining, false);
  await worker.tick();
  assert.deepEqual(ran, ["job"]);
});

test("worker refuses invalid timer configuration before it can create a busy loop", () => {
  assert.throws(() => new MemoryIndexWorker({ jobs: {}, indexing: {}, pollMs: 0 }), /Invalid memory index poll interval/);
  assert.throws(() => new MemoryIndexWorker({ jobs: {}, indexing: {}, leaseMs: 500 }), /Invalid memory index lease interval/);
});

test("a claim failure is contained and recorded instead of becoming an unhandled rejection", async () => {
  const jobs = { async claim() { const error = new Error("database unavailable"); error.code = "database_unavailable"; throw error; } };
  const worker = new MemoryIndexWorker({ jobs, indexing: {}, pollMs: 60_000, reconcileMs: 60_000 });
  assert.equal(await worker.tick(), null);
  assert.equal(worker.status().lastError, "database_unavailable");
});

test("the index refuses a call that carries no key, the way the deployed server does", async () => {
  const fake = openVikingFake();
  const keyless = new OpenVikingClient({ openVikingUrl: "http://openviking.internal:1933" }, { fetchImpl: fake.client.fetchImpl });
  await assert.rejects(
    () => keyless.find("owner", "kidney", { targets: ["viking://user/u/memories/evimed/capsule"] }),
    (error) => error.code === "memory_index_auth_failed" && /UNAUTHENTICATED/.test(error.message),
  );
});
