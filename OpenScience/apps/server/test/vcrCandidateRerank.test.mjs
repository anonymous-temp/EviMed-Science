// Reordering a candidate list against the run's summary of the patient (G11): the DashScope request as the model documents it, batches that stay
// inside one call's limits, an order that puts the scored in score order and leaves what could not be scored where it was, and every failure
// failing open. The endpoint is a double; nothing here shows that the reranker ranks well — the public pools in evals/vcr-model-comparison do.
import assert from "node:assert/strict";
import test from "node:test";

import { VCR_RERANK_INSTRUCT, VcrCandidateRerank, candidateCard, orderByScores, rerankCandidates } from "../src/vcrCandidateRerank.mjs";

const API = "https://dashscope.example.org/compatible-api/v1/reranks";
const NATIVE = "https://dashscope.example.org/api/v1/services/rerank/text-rerank/text-rerank";

/** An endpoint double: scores a document by how many words of the query it holds, records every request body. @param {{ fail?: (body: any, call: number) => any }} [options] */
function endpoint({ fail } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const failure = fail?.(body, calls.length);
    if (failure) return failure instanceof Error ? Promise.reject(failure) : failure;
    const query = String(body.query ?? body.input?.query).toLowerCase().split(/\W+/).filter(Boolean);
    const documents = body.documents ?? body.input.documents;
    const results = documents.map((document, index) => ({ index, relevance_score: query.filter((word) => document.toLowerCase().includes(word)).length / query.length }));
    const payload = body.input ? { output: { results }, usage: { total_tokens: 1 } } : { results, usage: { total_tokens: 1 } };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return { calls, fetchImpl };
}

const reranker = (extra = {}, fetchImpl) => new VcrCandidateRerank({ apiKey: "k", model: "qwen3-rerank", apiBase: API, ...extra }, { fetchImpl, report: () => {} });
const trial = (id, title, extra = {}) => ({ registryId: id, title, conditions: ["cond"], interventions: [], ...extra });

test("a card is the registry's words about the trial in a fixed order, bounded, with the head of the eligibility text when there is one", () => {
  const card = candidateCard({ title: "Osimertinib in EGFR NSCLC", conditions: ["NSCLC", "EGFR mutation"], interventions: ["Osimertinib"], phase: "Phase 3", sexStated: "ALL", ageStated: "18 Years – N/A",
    eligibilityHead: "Inclusion Criteria:  histologically  confirmed stage IV" });
  assert.equal(card, ["title: Osimertinib in EGFR NSCLC", "conditions: NSCLC; EGFR mutation", "interventions: Osimertinib", "phase: Phase 3", "sex: ALL", "age: 18 Years – N/A",
    "eligibility: Inclusion Criteria: histologically confirmed stage IV"].join("\n"));
  assert.equal(candidateCard({ title: "t", conditions: [] }), "title: t", "a listing with no eligibility text is read on what it has");
  assert.ok(candidateCard({ title: "t", eligibilityHead: "x".repeat(5000) }, 300).length <= 300);
});

test("scored documents are put in score order and an unscored one keeps its slot; equal scores keep the order they arrived in", () => {
  assert.deepEqual(orderByScores([0.1, 0.9, 0.5]), [1, 2, 0]);
  assert.deepEqual(orderByScores([0.5, 0.5, 0.5]), [0, 1, 2]);
  assert.deepEqual(orderByScores([null, null, null]), [0, 1, 2], "nothing scored is the order given");
  assert.deepEqual(orderByScores([0.1, null, 0.9, null, 0.5]), [2, 1, 4, 3, 0], "the failed batch's trials stay in their slots; the scored fill the rest by score");
  const permutation = orderByScores([0.3, null, 0.8, 0.8, null, 0.1]);
  assert.deepEqual([...permutation].sort(), [0, 1, 2, 3, 4, 5], "always a whole permutation");
});

test("the request is the documented one: the model, the masked summary as the query, the documents, a top_n of all of them and the instruction", async () => {
  const double = endpoint();
  const rerank = reranker({}, double.fetchImpl);
  const result = await rerankCandidates({ summary: "63-year-old woman with stage IV lung adenocarcinoma, mobile 13800138000", candidates: [trial("NCT1", "breast study"), trial("NCT2", "lung adenocarcinoma study")] }, { reranker: rerank });
  assert.equal(result.state, "ranked");
  assert.deepEqual(result.ids, ["NCT2", "NCT1"]);
  assert.equal(result.applied, true);
  const [call] = double.calls;
  assert.equal(call.url, API);
  assert.equal(call.headers.Authorization, "Bearer k");
  assert.equal(call.body.model, "qwen3-rerank");
  assert.equal(call.body.top_n, 2);
  assert.equal(call.body.instruct, VCR_RERANK_INSTRUCT);
  assert.ok(!call.body.query.includes("13800138000"), "an identifier shape never leaves");
  assert.match(call.body.query, /lung adenocarcinoma/);
  assert.match(call.body.documents[1], /^title: lung adenocarcinoma study/);
  // The native path puts the same things in its own envelope.
  const nativeDouble = endpoint();
  await rerankCandidates({ summary: "lung", candidates: [trial("A", "lung"), trial("B", "x")] }, { reranker: reranker({ apiBase: NATIVE }, nativeDouble.fetchImpl) });
  const native = nativeDouble.calls[0].body;
  assert.deepEqual([native.input.query, native.input.documents.length, native.parameters.top_n, native.parameters.instruct], ["lung", 2, 2, VCR_RERANK_INSTRUCT]);
  // A model that does not read `instruct` is not sent one.
  const other = endpoint();
  await rerankCandidates({ summary: "lung", candidates: [trial("A", "a"), trial("B", "b")] }, { reranker: reranker({ model: "gte-rerank-v2" }, other.fetchImpl) });
  assert.equal("instruct" in other.calls[0].body, false);
});

test("documents go in batches of at most the batch size and the batch's characters; scores from different batches are ordered together", async () => {
  const double = endpoint();
  const rerank = reranker({ batchSize: 4, concurrency: 2 }, double.fetchImpl);
  const candidates = Array.from({ length: 10 }, (_, at) => trial(`T${at}`, at === 7 ? "lung lung target" : `other ${at}`));
  const result = await rerankCandidates({ summary: "lung target", candidates }, { reranker: rerank });
  assert.deepEqual(double.calls.map((call) => call.body.documents.length).sort(), [2, 4, 4]);
  assert.equal(result.batches, 3);
  assert.equal(result.ids[0], "T7", "the best trial of the third batch leads the whole list");
  assert.deepEqual([...result.ids].sort(), candidates.map((candidate) => candidate.registryId).sort());
  // A batch is also bounded by the model's sum, the query counted once for every document plus the documents, so a request never exceeds what one call may carry.
  const wide = endpoint();
  await reranker({ batchSize: 50, requestChars: 3000, maxCharsPerDocument: 1500 }, wide.fetchImpl)
    .score("q", Array.from({ length: 5 }, () => "w".repeat(1400)));
  assert.deepEqual(wide.calls.map((call) => call.body.documents.length).sort(), [1, 2, 2]);
  const longQuery = endpoint();
  await reranker({ batchSize: 50, requestChars: 10_000, maxQueryChars: 2000, maxCharsPerDocument: 1500 }, longQuery.fetchImpl)
    .score("lung cancer stage IV ".repeat(85), Array.from({ length: 9 }, () => "plain trial text ".repeat(60)));
  assert.deepEqual(longQuery.calls.map((call) => call.body.documents.length), [3, 3, 3], "a long summary is paid for in every document: about 2,800 characters each, three to a request");
});

test("a batch that fails leaves its trials where they were and the rest are reordered; every code is named, and nothing throws", async () => {
  const candidates = Array.from({ length: 6 }, (_, at) => trial(`T${at}`, at === 5 ? "lung" : at === 1 ? "lung lung" : `other ${at}`));
  // The second batch (T3..T5) is refused by the upstream.
  const half = reranker({ batchSize: 3, concurrency: 1 }, endpoint({ fail: (_body, call) => (call === 2 ? new Response("{}", { status: 500 }) : null) }).fetchImpl);
  const partial = await rerankCandidates({ summary: "lung", candidates }, { reranker: half });
  assert.deepEqual([partial.state, partial.failedBatches, partial.reasons, partial.applied], ["partial", 1, ["vcr_rerank_upstream_error"], true]);
  assert.deepEqual(partial.ids.slice(3), ["T3", "T4", "T5"], "the unscored kept their slots");
  assert.equal(partial.ids[0], "T1");

  const refused = await rerankCandidates({ summary: "lung", candidates }, { reranker: reranker({ batchSize: 3, concurrency: 1 }, endpoint({ fail: () => new Response("no", { status: 401 }) }).fetchImpl) });
  assert.deepEqual([refused.state, refused.reasons, refused.applied, refused.ids], ["failed", ["vcr_rerank_auth_failed"], false, candidates.map((candidate) => candidate.registryId)], "a refused key fails the whole list open, once");

  const garbled = await rerankCandidates({ summary: "lung", candidates }, { reranker: reranker({}, async () => new Response("<html>", { status: 200 })) });
  assert.deepEqual([garbled.state, garbled.reasons], ["failed", ["vcr_rerank_response_invalid"]]);
  const short = await rerankCandidates({ summary: "lung", candidates }, { reranker: reranker({}, async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }), { status: 200 })) });
  assert.deepEqual([short.state, short.reasons], ["failed", ["vcr_rerank_response_invalid"]], "an answer that does not cover its batch is not half used");
  const down = await rerankCandidates({ summary: "lung", candidates }, { reranker: reranker({}, async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); }) });
  assert.deepEqual([down.state, down.reasons], ["failed", ["vcr_rerank_unavailable"]]);
  const slow = await rerankCandidates({ summary: "lung", candidates }, { reranker: reranker({ timeoutMs: 500 }, (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) ) });
  assert.deepEqual([slow.state, slow.reasons], ["failed", ["vcr_rerank_timeout"]]);
  assert.deepEqual(slow.ids, candidates.map((candidate) => candidate.registryId));
  const counts = half.counts();
  assert.equal(counts.succeeded, 1);
  assert.deepEqual(counts.failed, { vcr_rerank_upstream_error: 1 });
});

test("with no key, no summary or fewer than two trials it asks nothing and says why", async () => {
  const double = endpoint();
  const candidates = [trial("A", "a"), trial("B", "b")];
  const off = await rerankCandidates({ summary: "x", candidates }, { reranker: reranker({ enabled: false }, double.fetchImpl) });
  assert.deepEqual([off.state, off.applied, off.reasons, off.ids], ["unconfigured", false, ["vcr_rerank_unconfigured"], ["A", "B"]]);
  const nokey = await rerankCandidates({ summary: "x", candidates }, { reranker: reranker({ apiKey: "" }, double.fetchImpl) });
  assert.equal(nokey.state, "unconfigured");
  assert.equal((await rerankCandidates({ summary: "x", candidates }, { reranker: null })).state, "unconfigured");
  const noSummary = await rerankCandidates({ summary: "  ", candidates }, { reranker: reranker({}, double.fetchImpl) });
  assert.deepEqual([noSummary.state, noSummary.applied], ["skipped", false]);
  const one = await rerankCandidates({ summary: "x", candidates: [trial("A", "a")] }, { reranker: reranker({}, double.fetchImpl) });
  assert.equal(one.state, "skipped");
  assert.equal(double.calls.length, 0);
});

test("each request's token count, as the provider gave it, is handed to the caller's bill; a request with no count books nothing, and a bill that fails changes no order", async () => {
  const booked = [];
  const counted = (tokens) => async (_url, init) => {
    const body = JSON.parse(init.body);
    const documents = body.documents ?? body.input.documents;
    const results = documents.map((_, index) => ({ index, relevance_score: index / documents.length }));
    return new Response(JSON.stringify({ results, request_id: `req-${tokens}`, ...(tokens == null ? {} : { usage: { total_tokens: tokens } }) }), { status: 200 });
  };
  const rerank = reranker({ batchSize: 2 }, counted(79));
  const candidates = ["a", "b", "c", "d", "e"].map((id) => trial(id, `title ${id}`));
  const result = await rerankCandidates({ summary: "lung cancer", candidates }, { reranker: rerank, bill: async (spend) => { booked.push(spend); } });
  assert.equal(result.state, "ranked");
  assert.equal(booked.length, 3, "one booking for each of the three requests");
  assert.deepEqual(booked[0], { tokens: 79, requestId: "req-79", model: "qwen3-rerank" });
  assert.equal(rerank.counts().billedTokens, 237);

  // No count came back: nothing is written down that was not measured.
  const silent = reranker({}, counted(null));
  const unbilled = [];
  await rerankCandidates({ summary: "lung cancer", candidates }, { reranker: silent, bill: async (spend) => { unbilled.push(spend); } });
  assert.deepEqual(unbilled, []);
  assert.equal(silent.counts().unmetered, 1);

  // A ledger that cannot be written leaves the order as it was scored, and the failure is counted.
  const broken = reranker({}, counted(10));
  const ordered = await rerankCandidates({ summary: "lung cancer", candidates }, { reranker: broken, bill: async () => { throw new Error("ledger down"); } });
  assert.equal(ordered.state, "ranked");
  assert.deepEqual(ordered.ids, ["e", "d", "c", "b", "a"]);
  assert.equal(broken.counts().billingFailed, 1);
  assert.equal(broken.counts().billedTokens, 0);

  // A refused request (401) was never counted by the provider: no booking.
  const refused = reranker({}, async () => new Response("no", { status: 401 }));
  const none = [];
  await rerankCandidates({ summary: "lung cancer", candidates }, { reranker: refused, bill: async (spend) => { none.push(spend); } });
  assert.deepEqual(none, []);
});
