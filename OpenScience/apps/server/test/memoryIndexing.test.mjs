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

  // A capsule that was never written reads as an empty index, not as an error:
  // rebuild is what repairs it, and it calls this first.
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
  const found = await indexing.readback(snapshot);
  assert.deepEqual(found.map((entry) => [entry.factId, entry.revision]), [["runtime-note:ab12", 4]]);

  fake.files.clear();
  assert.deepEqual(await indexing.readback({ ...snapshot, entries: [] }), [], "an empty capsule has an empty index, not a missing one");
});

test("readback pages a directory with offset instead of trusting one response", async () => {
  // One more fact than the server's own page holds. A reader that trusted the
  // first response would call this capsule incomplete forever, and the worker
  // would rebuild it on every reconciliation.
  const fake = openVikingFake();
  const entries = [];
  for (let index = 0; index <= 1_000; index++) {
    entries.push({ id: `fact-${index}`, revision: 1, factKind: "analysis", layer: "knowledge", content: "text" });
    indexFact(fake, "owner", { capsuleId: "capsule-a", factKind: "analysis", factId: `fact-${index}`, revision: 1, content: "text" });
  }
  const indexing = new MemoryIndexing({ database: {}, openViking: fake.client, jobs: {} });
  assert.equal((await indexing.readback({ userId: "owner", generation, capsuleId: "capsule-a", entries })).length, 1_001);
  const listings = fake.calls.filter((call) => call.path === "/api/v1/fs/ls");
  const leafPages = listings.filter((call) => call.params.get("uri").endsWith("/analysis"));
  assert.deepEqual(leafPages.map((call) => call.params.get("offset")), ["0", "1000"]);
  assert.ok(listings.every((call) => call.params.get("limit") === null), "a limit truncates silently and hides what it dropped");
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
