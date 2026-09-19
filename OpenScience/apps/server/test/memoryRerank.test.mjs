// Reordering a recall's candidates, and what happens when that fails.
//
// Every assertion here is about one property: a reranker may improve the order
// and may never cost a recall its answer. The endpoint is DashScope's, whose
// two paths take two different envelopes, so which envelope is sent is pinned
// rather than remembered.
import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_RERANK_INSTRUCT, MemoryRerank } from "../src/memoryRerank.mjs";

const key = `not-a-real-${"credential"}`;
const flatBase = "https://dashscope.aliyuncs.com/compatible-api/v1/reranks";
const nativeBase = "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank";

/** Records every call and answers with the queued responses. */
function recordingFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const next = queue.shift() ?? { status: 200, body: {} };
    if (next.throws) throw next.throws;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      async text() { return typeof next.body === "string" ? next.body : JSON.stringify(next.body); },
    };
  };
  impl.calls = calls;
  return impl;
}

/** Scores in the order given, highest first, in the flat shape. */
function flatResults(scores) {
  return { results: scores.map((score, index) => ({ index, relevance_score: score })) };
}

function reranker(options = {}, responses = []) {
  const fetchImpl = recordingFetch(responses);
  const reported = [];
  const rerank = new MemoryRerank(
    { apiKey: key, model: "qwen3-rerank", apiBase: flatBase, ...options },
    { fetchImpl, report: (code) => reported.push(code) },
  );
  return { rerank, fetchImpl, reported };
}

test("an unconfigured reranker is inert and asks nobody anything", async () => {
  for (const options of [{ apiKey: "" }, { model: "" }, { apiBase: "" }]) {
    const { rerank, fetchImpl } = reranker(options, [{ status: 200, body: flatResults([0.9, 0.1]) }]);
    assert.equal(rerank.configured, false);
    assert.deepEqual(await rerank.order("q", ["a", "b"]), [0, 1]);
    assert.equal(fetchImpl.calls.length, 0, "a deployment with nothing configured must make no call at all");
  }
});

test("the endpoint decides the envelope, because the two DashScope paths take different ones", async () => {
  const flat = reranker({}, [{ status: 200, body: flatResults([0.2, 0.8]) }]);
  await flat.rerank.order("kidney outcomes", ["first", "second"]);
  assert.deepEqual(flat.fetchImpl.calls[0].body, {
    model: "qwen3-rerank", query: "kidney outcomes", documents: ["first", "second"], top_n: 2,
    instruct: MEMORY_RERANK_INSTRUCT,
  });
  assert.equal(flat.fetchImpl.calls[0].url, flatBase);

  const native = reranker({ apiBase: nativeBase, model: "qwen3.7-text-rerank" },
    [{ status: 200, body: { output: { results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.8 }] } } }]);
  const order = await native.rerank.order("kidney outcomes", ["first", "second"]);
  assert.deepEqual(native.fetchImpl.calls[0].body, {
    model: "qwen3.7-text-rerank",
    input: { query: "kidney outcomes", documents: ["first", "second"] },
    parameters: { return_documents: false, instruct: MEMORY_RERANK_INSTRUCT },
  });
  assert.deepEqual(order, [1, 0], "the native answer arrives under output.results");
});

test("a recall is judged as a memory search, and another caller can ask for its own judgement", async () => {
  // Unasked, qwen3-rerank judges question answering: which passage answers the
  // query. A recall wants the memories that bear on the question, including a
  // preference that answers nothing, so that is the default instruction.
  assert.match(MEMORY_RERANK_INSTRUCT, /^Given a researcher's current question, retrieve the memories/);
  const ranked = { status: 200, body: flatResults([0.2, 0.8]) };
  const own = "Given a clinical question, retrieve passages of the researcher's own documents that answer it.";
  const flat = reranker({}, [ranked, ranked, ranked]);
  await flat.rerank.order("q", ["a", "b"]);
  await flat.rerank.order("q", ["a", "b"], { instruct: own });
  await flat.rerank.order("q", ["a", "b"], { instruct: "" });
  assert.deepEqual(flat.fetchImpl.calls.map((call) => call.body.instruct), [MEMORY_RERANK_INSTRUCT, own, undefined],
    "the default, the caller's own, and none when the caller asks for none");

  const native = reranker({ apiBase: nativeBase }, [{ status: 200, body: { output: { results: [{ index: 0, relevance_score: 1 }, { index: 1, relevance_score: 0 }] } } }]);
  await native.rerank.order("q", ["a", "b"], { instruct: own });
  assert.equal(native.fetchImpl.calls[0].body.parameters.instruct, own, "the native path carries it under parameters");
  assert.equal(native.fetchImpl.calls[0].body.instruct, undefined);

  // A model DashScope does not document it for is not sent it.
  const older = reranker({ model: "gte-rerank-v2" }, [ranked]);
  await older.rerank.order("q", ["a", "b"]);
  assert.equal(Object.hasOwn(older.fetchImpl.calls[0].body, "instruct"), false);
});

test("the returned order is the scored one, and equal scores keep the order they arrived in", async () => {
  const { rerank } = reranker({}, [{ status: 200, body: flatResults([0.1, 0.9, 0.5]) }]);
  assert.deepEqual(await rerank.order("q", ["a", "b", "c"]), [1, 2, 0]);

  const tied = reranker({}, [{ status: 200, body: { results: [{ index: 2, relevance_score: 0.5 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.5 }] } }]);
  assert.deepEqual(await tied.rerank.order("q", ["a", "b", "c"]), [0, 1, 2]);
});

test("every failure keeps the order that arrived, and says so exactly once", async () => {
  const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
  const cases = [
    [{ status: 401, body: { message: "unauthorized" } }, "memory_rerank_auth_failed"],
    [{ status: 500, body: { message: "boom" } }, "memory_rerank_upstream_error"],
    [{ throws: timeout }, "memory_rerank_timeout"],
    [{ throws: new Error("ECONNREFUSED") }, "memory_rerank_unavailable"],
    [{ status: 200, body: "not json at all" }, "memory_rerank_response_invalid"],
    [{ status: 200, body: flatResults([0.9]) }, "memory_rerank_response_invalid"],
    [{ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0.5 }] } }, "memory_rerank_response_invalid"],
    [{ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 7, relevance_score: 0.5 }] } }, "memory_rerank_response_invalid"],
  ];
  for (const [response, code] of cases) {
    const { rerank, reported } = reranker({}, [response, response]);
    assert.deepEqual(await rerank.order("q", ["a", "b"]), [0, 1], `${code} must not cost the recall its order`);
    assert.deepEqual(await rerank.order("q", ["a", "b"]), [0, 1]);
    assert.deepEqual(reported, [code], "one line per outage, not one per question a researcher types");
    assert.equal(rerank.status().code, code);
  }
});

test("a recovered reranker reports the next outage again", async () => {
  const { rerank, reported } = reranker({}, [
    { status: 500, body: {} },
    { status: 200, body: flatResults([0.9, 0.1]) },
    { status: 500, body: {} },
  ]);
  await rerank.order("q", ["a", "b"]);
  await rerank.order("q", ["a", "b"]);
  assert.equal(rerank.status().code, null);
  await rerank.order("q", ["a", "b"]);
  assert.deepEqual(reported, ["memory_rerank_upstream_error", "memory_rerank_upstream_error"]);
});

test("the request is bounded in documents and in characters, and the tail keeps its order", async () => {
  const { rerank, fetchImpl } = reranker({ maxDocuments: 2, maxCharsPerDocument: 100 },
    [{ status: 200, body: flatResults([0.1, 0.9]) }]);
  const documents = ["a".repeat(500), "b".repeat(500), "c", "d"];
  const order = await rerank.order("q".repeat(500), documents);
  const sent = fetchImpl.calls[0].body;
  assert.equal(sent.documents.length, 2);
  assert.ok(sent.documents.every((document) => document.length === 100));
  assert.equal(sent.query.length, 100);
  assert.deepEqual(order, [1, 0, 2, 3], "what was not scored keeps the order the index gave it");
});

test("nothing that could carry the key leaves this module", async () => {
  const { rerank, fetchImpl, reported } = reranker({}, [{ status: 401, body: { message: `key ${key} rejected` } }]);
  const order = await rerank.order("q", ["a", "b"]);
  assert.equal(JSON.stringify(order).includes(key), false);
  assert.equal(JSON.stringify(rerank.status()).includes(key), false);
  assert.equal(reported.join(" ").includes(key), false);
  // It does travel on the wire, and nowhere else: that is the one place it is
  // supposed to appear.
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, `Bearer ${key}`);
});

test("a key file that anyone could read is refused rather than used", async (t) => {
  const { mkdtemp, writeFile, chmod } = await import("node:fs/promises");
  const path = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(path.join(tmpdir(), "evimed-rerank-"));
  const file = path.join(directory, "dashscope.api-key");
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  t.after(async () => { await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }); });

  const loaded = new MemoryRerank({ apiKeyFile: file, model: "qwen3-rerank", apiBase: flatBase });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.apiKey, key, "a trailing newline is a terminator, not part of the credential");

  await chmod(file, 0o644);
  const exposed = new MemoryRerank({ apiKeyFile: file, model: "qwen3-rerank", apiBase: flatBase });
  assert.equal(exposed.configured, false);
  assert.equal(exposed.status().code, "memory_rerank_key_permissions");

  const missing = new MemoryRerank({ apiKeyFile: path.join(directory, "absent"), model: "qwen3-rerank", apiBase: flatBase });
  assert.equal(missing.status().code, "memory_rerank_key_unavailable");
});
