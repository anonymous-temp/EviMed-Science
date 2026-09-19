import assert from "node:assert/strict";
import test from "node:test";

import { KB_QUERY_INSTRUCT, KbEmbedder } from "../src/kbEmbedding.mjs";

const KEY = "sk-dashscope-test-only-0123456789";

function recordingFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    return answer(body);
  };
  return { fetchImpl, calls };
}

/** DashScope's answer shape: vectors listed out of order, keyed by text_index. */
const echoVectors = (dimension) => (body) => new Response(JSON.stringify({
  output: { embeddings: body.input.texts.map((_, index) => ({ text_index: index, embedding: new Array(dimension).fill(index + 1) })).reverse() },
  usage: { total_tokens: body.input.texts.length * 7 },
}), { status: 200 });

test("documents are embedded as documents, ten to a request, in their own order", async () => {
  const { fetchImpl, calls } = recordingFetch(echoVectors(4));
  const embedder = new KbEmbedder({ apiKey: KEY, model: "qwen3.7-text-embedding", dimension: 4, apiBase: "https://dashscope.aliyuncs.com/" }, { fetchImpl });
  const texts = Array.from({ length: 23 }, (_, index) => `chunk ${index}`);
  const vectors = await embedder.embedDocuments(texts);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding");
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body.parameters, { dimension: 4, text_type: "document" });
  assert.equal(calls[0].body.model, "qwen3.7-text-embedding");
  assert.deepEqual(calls.map((call) => call.body.input.texts.length), [10, 10, 3]);
  assert.equal(vectors.length, 23);
  assert.deepEqual(vectors[0], [1, 1, 1, 1], "reordered by text_index, not by list position");
  assert.deepEqual(vectors[12], [3, 3, 3, 3]);
  assert.deepEqual(embedder.counters, { requests: 3, texts: 23, tokens: 161, failures: 0 });
  assert.equal(embedder.modelKey, "qwen3.7-text-embedding@4");
});

test("a query is embedded as a query, with the retrieval instruction", async () => {
  const { fetchImpl, calls } = recordingFetch(echoVectors(4));
  const embedder = new KbEmbedder({ apiKey: KEY, model: "m", dimension: 4, apiBase: "https://dashscope.aliyuncs.com" }, { fetchImpl });
  assert.deepEqual(await embedder.embedQuery("利伐沙班的剂量"), [1, 1, 1, 1]);
  assert.deepEqual(calls[0].body.parameters, { dimension: 4, text_type: "query", instruct: KB_QUERY_INSTRUCT });
  assert.match(KB_QUERY_INSTRUCT, /^[\x20-\x7e]+$/, "the instruction is English, as the documentation asks");
});

test("a refusal, an outage or a malformed answer is named, and the key never appears in it", async () => {
  const refused = new KbEmbedder({ apiKey: KEY, model: "m", dimension: 4, apiBase: "https://x.test" },
    { fetchImpl: async () => new Response(JSON.stringify({ code: "InvalidApiKey", message: `Invalid API-key provided: ${KEY}` }), { status: 401 }) });
  await assert.rejects(refused.embedQuery("q"), (error) => error.code === "kb_embedding_auth_failed" && !String(error.message).includes(KEY));
  const down = new KbEmbedder({ apiKey: KEY, model: "m", dimension: 4, apiBase: "https://x.test" },
    { fetchImpl: async () => { throw new TypeError(`fetch failed for ${KEY}`); } });
  await assert.rejects(down.embedQuery("q"), (error) => error.code === "kb_embedding_unavailable" && !String(error.message).includes(KEY));
  const wrongWidth = new KbEmbedder({ apiKey: KEY, model: "m", dimension: 4, apiBase: "https://x.test" },
    { fetchImpl: async (_url, init) => echoVectors(3)(JSON.parse(init.body)) });
  await assert.rejects(wrongWidth.embedDocuments(["a"]), { code: "kb_embedding_response_invalid" });
  assert.equal(wrongWidth.counters.failures, 1);
  const unconfigured = new KbEmbedder({ apiKey: "", model: "m", dimension: 4, apiBase: "https://x.test" });
  assert.equal(unconfigured.configured, false);
  await assert.rejects(unconfigured.embedQuery("q"), { code: "kb_embedding_unconfigured" });
});
