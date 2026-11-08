// A search for a patient's trials reads deeper than a page and for more than three phrases (G11): the registry client against a local fake of the
// ClinicalTrials.gov API (pages, page tokens, a pace), the retrieval within its deadline, the fusion of the run's phrases, the reordering against the
// run's summary, and the receipt a judging job reads its trials from. No real registry and no real model: the fake server stands where they would.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createTrialRegistryClient } from "../src/trialRegistryClient.mjs";
import { CANDIDATE_TERMS_MAX, fuseRanked, fusionScore } from "../src/vcrCandidateSearch.mjs";
import { VcrCandidateRerank } from "../src/vcrCandidateRerank.mjs";
import { retrievalDepth, retrieveCandidates } from "../src/vcrCandidateRetrieve.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";

const NOW = new Date("2026-11-04T08:00:00.000Z");

/**
 * A fake of the ClinicalTrials.gov list API. A phrase `P<n>` finds the trials `[n * 100, n * 100 + width)` of one numbered series, so phrases overlap on purpose; any other
 * phrase finds `width` trials of its own. A page is `pageSize` of them with a token for the next.
 * @param {{ width?: number, delayMs?: number, fail?: (request: any) => number | null }} [options]
 */
async function fakeCtgov({ width = 250, delayMs = 0, fail } = {}) {
  /** @type {Array<{ at: number, cond: string | null, term: string | null, pageSize: number, pageToken: string | null, fields: string }>} */
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    // A port scanner of the development host probes listening test servers with a bare GET; it is not a request of the registry client.
    if (url.pathname !== "/studies") { response.writeHead(404).end(); return; }
    const entry = { at: Date.now(), cond: url.searchParams.get("query.cond"), term: url.searchParams.get("query.term"), pageSize: Number(url.searchParams.get("pageSize")),
      pageToken: url.searchParams.get("pageToken"), fields: url.searchParams.get("fields") ?? "" };
    requests.push(entry);
    const answer = () => {
      const status = fail?.(entry);
      if (status) { response.writeHead(status).end("{}"); return; }
      const phrase = entry.cond ?? entry.term ?? "";
      const series = /^P(\d+)$/.exec(phrase);
      const start = series ? Number(series[1]) * 100 : 100000 + [...phrase].reduce((sum, char) => sum + char.charCodeAt(0), 0) * 1000;
      const offset = entry.pageToken ? Number(entry.pageToken) : 0;
      const size = entry.pageSize || 20;
      const studies = [];
      for (let at = offset; at < Math.min(width, offset + size); at += 1) {
        const id = `NCT${String(start + at).padStart(8, "0")}`;
        studies.push({ protocolSection: {
          identificationModule: { nctId: id, briefTitle: `Trial ${id}` }, statusModule: { overallStatus: "RECRUITING" }, designModule: { phases: ["PHASE2"] },
          conditionsModule: { conditions: ["Lung cancer"] }, armsInterventionsModule: { interventions: [{ name: "Drug" }] },
          eligibilityModule: { sex: "ALL", minimumAge: "18 Years", maximumAge: "N/A", ...(entry.fields.includes("eligibilityCriteria") ? { eligibilityCriteria: `Inclusion Criteria: stage IV disease for ${id}` } : {}) },
        } });
      }
      const next = offset + size < width ? String(offset + size) : null;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ totalCount: width, studies, ...(next ? { nextPageToken: next } : {}) }));
    };
    if (delayMs) setTimeout(answer, delayMs); else answer();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, baseUrl: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** The pipeline over the fake: the real registry client (paced), ChiCTR and CTIS as asked for, and doubles for the reranker and the receipt store. */
function build(fake, { chictr = null, reranker = null, searches = null, retrieval = {}, paceMs = 0 } = {}) {
  const registry = createTrialRegistryClient({ baseUrl: fake.baseUrl, ctisBaseUrl: "", timeoutMs: 5_000, maxAttempts: 1, paceMs, chictrAdapter: chictr });
  return createVcrEvidencePipeline({ store: {}, registry, now: () => NOW, reranker, searches, retrieval });
}

/** A receipt store double that keeps what it is given. */
const receipts = () => {
  const held = new Map();
  return {
    held,
    async save(study, entry) { const id = `cns_${held.size + 1}`; held.set(id, { id, studyId: study.id, createdAt: NOW.toISOString(), ...entry }); return id; },
    async get(study, id) { const row = held.get(id); return row && row.studyId === study.id ? row : null; },
  };
};

test("a phrase is read a page at a time up to the depth, with the registry's own page token, and the head of the eligibility text only when a summary will be read", async (t) => {
  const fake = await fakeCtgov({ width: 250 });
  t.after(fake.close);
  const pipeline = build(fake);
  const answer = await pipeline.patientCandidates({ userId: "u", filter: { condition: "P1" } });
  assert.equal(answer.available, true);
  // One phrase: depth 200, pages of 100 — two requests, the second carrying the token the first returned.
  assert.deepEqual(fake.requests.map((request) => [request.pageSize, request.pageToken]), [[100, null], [100, "100"]]);
  assert.equal(fake.requests.some((request) => request.fields.includes("eligibilityCriteria")), false, "no eligibility text is asked for when nothing will read it");
  const registry = answer.registries.find((entry) => entry.registry === "clinicaltrials.gov");
  assert.deepEqual([registry.state, registry.searched], ["searched", [{ query: "P1", found: 200, total: 250, pages: 2 }]]);
  assert.equal(answer.retrieved, 200);
  assert.equal(answer.returned, 20, "the answer shows the list's size and keeps the rest");
  assert.deepEqual([answer.more, answer.nextOffset, answer.offset], [true, 20, 0]);
  assert.deepEqual(answer.retrieval, { phrases: 1, depthPerPhrase: 200, requests: 2 + 1 + 1, reachedAllPhrases: true, truncated: false });
  assert.equal(answer.candidates[0].registryId, "NCT00000100", "the registry's own order within a phrase");
});

test("the condition and up to 32 more phrases are accepted, asked in the run's order of priority, each registry at its own pace, and a 33rd is refused in words", async (t) => {
  const fake = await fakeCtgov({ width: 30 });
  t.after(fake.close);
  const pipeline = build(fake, { paceMs: 30, retrieval: { deadlineMs: 20_000 } });
  const terms = Array.from({ length: CANDIDATE_TERMS_MAX }, (_, at) => `P${at + 2}`);
  const started = Date.now();
  const answer = await pipeline.patientCandidates({ userId: "u", filter: { condition: "P1", terms } });
  assert.equal(answer.available, true);
  assert.equal(answer.retrieval.phrases, 33);
  assert.equal(answer.retrieval.depthPerPhrase, retrievalDepth(33, 500));
  assert.equal(answer.retrieval.reachedAllPhrases, true);
  const asked = fake.requests.map((request) => request.cond ?? request.term);
  assert.deepEqual(asked, ["P1", ...terms], "one request each (30 results fit one page), in the run's order");
  assert.equal(fake.requests[0].cond, "P1", "the condition is a condition and the phrases are terms");
  assert.equal(fake.requests[1].term, "P2");
  // The registry client spaced the starts: 32 requests at 30 ms cannot take less than 31 gaps.
  const starts = fake.requests.map((request) => request.at);
  const gaps = starts.slice(1).map((at, index) => at - starts[index]).sort((a, b) => a - b);
  assert.ok(gaps[Math.floor(gaps.length / 2)] >= 25, `the median gap between arrivals is about a pace (${gaps[Math.floor(gaps.length / 2)]} ms)`);
  assert.ok(Date.now() - started >= 32 * 25, "33 requests at a 30 ms pace take at least 32 gaps, less the timer's slack");
  const refused = await pipeline.patientCandidates({ userId: "u", filter: { condition: "P1", terms: [...terms, "one more"] } });
  assert.deepEqual([refused.available, refused.code], [false, "vcr_read_filter_invalid"]);
  assert.match(refused.message, /最多 32 个/);
});

test("the deadline bounds the read: phrases it did not reach are said so, and what was read stands", async (t) => {
  const fake = await fakeCtgov({ width: 20, delayMs: 120 });
  t.after(fake.close);
  const pipeline = build(fake, { retrieval: { deadlineMs: 450, concurrency: 1 } });
  const answer = await pipeline.patientCandidates({ userId: "u", filter: { condition: "P1", terms: ["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"] } });
  assert.equal(answer.available, true);
  const registry = answer.registries.find((entry) => entry.registry === "clinicaltrials.gov");
  assert.equal(registry.state, "partial");
  assert.ok(registry.searched.length >= 2 && registry.searched.length < 9);
  assert.ok(registry.failed.length >= 1 && registry.failed.every((failure) => failure.reason === "search_deadline"), "not reached is a reason, not a silence");
  assert.equal(answer.retrieval.reachedAllPhrases, false);
  assert.match(answer.coverage, /部分检索词失败或没来得及查/);
  assert.ok(answer.candidates.length > 0);
});

test("a registry that fails costs its own part only; the others' pages stand, and ChiCTR has one request a phrase with as many as it will give", async (t) => {
  const fake = await fakeCtgov({ width: 40, fail: () => 500 });
  t.after(fake.close);
  const asked = [];
  const chictr = async (request) => { asked.push(request); return { total: 2, items: [{ registrationNo: "ChiCTR2400000001", title: "肺癌研究", status: "招募中", conditions: ["肺癌"], interventions: ["药物"], url: "https://www.chictr.org.cn/x" }] }; };
  const pipeline = build(fake, { chictr });
  const answer = await pipeline.patientCandidates({ userId: "u1", filter: { condition: "肺癌", terms: ["lung cancer"] } });
  assert.equal(answer.status, "ok");
  const ctgov = answer.registries.find((entry) => entry.registry === "clinicaltrials.gov");
  assert.equal(ctgov.state, "failed");
  assert.deepEqual(answer.registries.find((entry) => entry.registry === "chictr").searched.map((entry) => [entry.query, entry.pages]), [["肺癌", 1], ["lung cancer", 1]]);
  assert.deepEqual(asked.map((request) => [request.query, request.limit, request.userId]), [["肺癌", 100, "u1"], ["lung cancer", 100, "u1"]]);
  assert.deepEqual(answer.candidates.map((candidate) => candidate.registryId), ["ChiCTR2400000001"]);
  assert.match(answer.coverage, /ClinicalTrials\.gov没查到：http_500/);
});

test("the phrases of one registry are fused by TrialGPT's weights: an earlier phrase counts for more, and a trial several phrases find rises", () => {
  assert.equal(fusionScore(0, 0), 1 / 20);
  assert.equal(fusionScore(0, 1), 1 / 40);
  assert.equal(fusionScore(4, 2), (1 / 24) * (1 / 3));
  const item = (registryId) => ({ registryId });
  const fused = fuseRanked([
    [item("A"), item("B"), item("C")],
    [item("C"), item("D")],
    [item("D"), item("C"), item("E")],
  ]);
  // A: 1/20 = .05; C: 1/22 + 1/40 + 1/(21*3) = .0455 + .025 + .0159 = .0864; B: 1/21 = .0476; D: 1/21*.5 + 1/20*(1/3) = .0238 + .0167 = .0405; E: 1/22/3 = .0152
  assert.deepEqual(fused.map((candidate) => candidate.registryId), ["C", "A", "B", "D", "E"]);
  assert.deepEqual(fuseRanked([[item("X"), item("x ")], [item("")]]).map((candidate) => candidate.registryId), ["X"], "the same id once, and an empty id never");
});

test("with a summary the list is reordered against it, the answer says so, and what the summary said is kept nowhere", async (t) => {
  const fake = await fakeCtgov({ width: 60 });
  t.after(fake.close);
  /** @type {any[]} */
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    // The trial with the highest number is the one that reads best against the summary.
    const results = body.documents.map((document, index) => ({ index, relevance_score: Number(/NCT(\d{8})/.exec(document)[1]) / 1e8 }));
    return new Response(JSON.stringify({ results }), { status: 200 });
  };
  const reranker = new VcrCandidateRerank({ apiKey: "k", model: "qwen3-rerank", apiBase: "https://dashscope.example.org/compatible-api/v1/reranks", batchSize: 25 }, { fetchImpl, report: () => {} });
  const store = receipts();
  const pipeline = build(fake, { reranker, searches: store });
  const summary = "58-year-old man, stage IV lung adenocarcinoma, EGFR L858R, progressed on osimertinib";
  const study = { id: "std_1", userId: "u" };
  const answer = await pipeline.patientCandidates({ userId: "u", study, filter: { condition: "P1", summary, limit: 5 } });
  assert.equal(fake.requests.every((request) => request.fields.includes("eligibilityCriteria")), true, "the head of the eligibility text is asked for because a summary will be read against it");
  assert.deepEqual([answer.rerank.state, answer.rerank.applied, answer.rerank.batches, answer.rerank.model], ["ranked", true, 3, "qwen3-rerank"]);
  assert.equal(bodies.length, 3);
  assert.match(bodies[0].documents[0], /eligibility: Inclusion Criteria: stage IV disease for NCT\d{8}/);
  assert.deepEqual(answer.candidates.map((candidate) => candidate.registryId), ["NCT00000159", "NCT00000158", "NCT00000157", "NCT00000156", "NCT00000155"].map((id) => id.replace(/^NCT00000/, "NCT00000")));
  assert.deepEqual(answer.candidates.map((candidate) => candidate.rank), [1, 2, 3, 4, 5]);
  assert.ok(answer.candidates.every((candidate) => typeof candidate.relevance === "number"));
  assert.match(answer.order, /重排序/);
  assert.match(answer.coverage, /已按与患者摘要的相关程度重排/);
  assert.equal(JSON.stringify(answer).includes("EGFR L858R"), false, "the answer does not repeat the summary");
  assert.deepEqual(answer.request.summary.chars, [...summary].length);
  // The receipt holds the whole list in this order, the search's request and the registries' state; the summary only as a hash and a length.
  const receipt = store.held.get(answer.searchId);
  assert.equal(receipt.items.length, answer.retrieved);
  assert.equal(receipt.items[0].registryId, answer.candidates[0].registryId);
  assert.equal(JSON.stringify(receipt).includes("EGFR L858R"), false);
  assert.equal(receipt.rerank.applied, true);

  // The rest of the list is read back from the receipt without asking a registry again.
  const before = fake.requests.length;
  const page = await pipeline.patientCandidates({ userId: "u", study, filter: { searchId: answer.searchId, offset: 5, limit: 3 } });
  assert.deepEqual([page.available, page.returned, page.offset, page.nextOffset, page.more], [true, 3, 5, 8, true]);
  assert.deepEqual(page.candidates.map((candidate) => candidate.rank), [6, 7, 8]);
  assert.equal(page.candidates[0].registryId, receipt.items[5].registryId);
  assert.equal(fake.requests.length, before);
  assert.match(page.coverage, /已查/);
  // Another study cannot read it, and an unknown id is a named finding.
  assert.equal((await pipeline.patientCandidates({ userId: "u", study: { id: "std_2", userId: "u" }, filter: { searchId: answer.searchId } })).available, false);
  assert.equal((await pipeline.patientCandidates({ userId: "u", study, filter: { searchId: "cns_nope" } })).code, "vcr_read_filter_invalid");
  assert.equal((await pipeline.patientCandidates({ userId: "u", study, filter: { searchId: "bad id" } })).available, false);
});

test("a reranker that fails leaves the registries' order and says so; with no study there is a list and no receipt; without a summary nothing is reranked", async (t) => {
  const fake = await fakeCtgov({ width: 30 });
  t.after(fake.close);
  const down = new VcrCandidateRerank({ apiKey: "k", model: "qwen3-rerank", apiBase: "https://dashscope.example.org/compatible-api/v1/reranks" }, { fetchImpl: async () => new Response("{}", { status: 503 }), report: () => {} });
  const store = receipts();
  const pipeline = build(fake, { reranker: down, searches: store });
  const plain = await build(fake).patientCandidates({ userId: "u", filter: { condition: "P1" } });
  const failed = await pipeline.patientCandidates({ userId: "u", study: { id: "std_1", userId: "u" }, filter: { condition: "P1", summary: "a summary" } });
  assert.deepEqual([failed.rerank.state, failed.rerank.applied, failed.rerank.reasons], ["failed", false, ["vcr_rerank_upstream_error"]]);
  assert.deepEqual(failed.candidates.map((candidate) => candidate.registryId), plain.candidates.map((candidate) => candidate.registryId), "the order the registries gave");
  assert.ok(failed.candidates.every((candidate) => candidate.relevance === undefined));
  assert.match(failed.coverage, /重排没有成功，保持检索顺序/);
  assert.match(failed.order, /检索顺序/);
  assert.ok(failed.searchId);
  // No study: the same list, and no receipt to read from.
  const free = await pipeline.patientCandidates({ userId: "u", filter: { condition: "P1", summary: "a summary" } });
  assert.equal(free.searchId, undefined);
  assert.equal(free.candidates.length, 20);
  // Nothing to read against: not reranked, and the answer says it was not asked.
  const none = await pipeline.patientCandidates({ userId: "u", study: { id: "std_1", userId: "u" }, filter: { condition: "P1" } });
  assert.deepEqual([none.rerank.state, none.rerank.summaryGiven, none.rerank.applied], ["skipped", false, false]);
  // A store that cannot write is a search without a receipt, not a failed search.
  const broken = build(fake, { searches: { async save() { throw new Error("db down"); }, async get() { return null; } } });
  const unsaved = await broken.patientCandidates({ userId: "u", study: { id: "std_1", userId: "u" }, filter: { condition: "P1" } });
  assert.equal(unsaved.available, true);
  assert.equal(unsaved.searchId, undefined);
});

test("a patient with more than 500 trials keeps the best 500 for the receipt and shows a page at a time", async (t) => {
  const fake = await fakeCtgov({ width: 250 });
  t.after(fake.close);
  const store = receipts();
  const pipeline = build(fake, { searches: store });
  const answer = await pipeline.patientCandidates({ userId: "u", study: { id: "std_1", userId: "u" }, filter: { condition: "P1", terms: ["P20", "P40", "P60", "P80", "P100"] } });
  assert.equal(answer.retrieved, 500);
  assert.equal(answer.retrieval.truncated, true);
  assert.equal(answer.found > 500, true, "found counts what was merged before the cut");
  assert.equal(store.held.get(answer.searchId).items.length, 500);
  // The registries' lists are interleaved, so ClinicalTrials.gov alone does not decide who is in the 500.
  assert.equal(new Set(store.held.get(answer.searchId).items.map((item) => item.registryId)).size, 500);
});

test("retrieval alone: a failed first page is an unavailable phrase, a later page that fails keeps the pages before it, and an abort stops the reading", async () => {
  const calls = [];
  const asks = {
    r: async (query, page) => {
      calls.push([query.text, page.pageToken]);
      if (query.text === "bad") return { status: "registry_unavailable", reason: "http_500", items: [] };
      if (page.pageToken === "2") return { status: "registry_unavailable", reason: "timeout", items: [] };
      return { status: "ok", total: 300, items: Array.from({ length: 100 }, (_, at) => ({ registryId: `${query.text}${at}` })), nextPageToken: page.pageToken ? "2" : "1", retrievedAt: "2026-11-04T07:00:00.000Z" };
    },
  };
  const read = await retrieveCandidates({ queries: [{ kind: "condition", text: "a" }, { kind: "term", text: "bad" }], asks, registries: ["r"], retrieveMax: 500, pageSizes: { r: 100 }, deadlineAt: Date.now() + 5_000, concurrency: 1 });
  const [a, bad] = read.results.r;
  assert.deepEqual([a.status, a.pages, a.items.length, a.truncated, a.total], ["ok", 2, 200, null, 300], "the depth for two phrases is 200 and the third page is not asked");
  assert.deepEqual([bad.status, bad.reason, bad.items.length], ["unavailable", "http_500", 0]);
  const failing = await retrieveCandidates({ queries: [{ kind: "condition", text: "a" }], asks: { r: async (_q, page) => (page.pageToken === "1" ? { status: "registry_unavailable", reason: "timeout", items: [] } : { status: "ok", total: 900, items: [{ registryId: "x" }], nextPageToken: "1" }) },
    registries: ["r"], retrieveMax: 500, pageSizes: { r: 100 }, deadlineAt: Date.now() + 5_000 });
  assert.deepEqual([failing.results.r[0].status, failing.results.r[0].items.length, failing.results.r[0].truncated], ["ok", 1, "timeout"]);
  const stop = new AbortController();
  stop.abort();
  const aborted = await retrieveCandidates({ queries: [{ kind: "condition", text: "a" }], asks, registries: ["r"], retrieveMax: 500, pageSizes: { r: 100 }, deadlineAt: Date.now() + 5_000, signal: stop.signal });
  assert.equal(aborted.results.r[0].status, "not_reached");
  assert.deepEqual([retrievalDepth(2, 500), retrievalDepth(5, 500), retrievalDepth(33, 500)], [200, 188, 24]);
  assert.equal(retrievalDepth(200, 500), 20, "never fewer than 20 a term");
  assert.deepEqual([retrievalDepth(33, 500, "condition"), retrievalDepth(1, 500, "condition"), retrievalDepth(33, 100, "condition")], [200, 200, 100], "the condition keeps its depth whatever the terms");
});

test("the condition query reads deeper than the terms when there are many phrases", async () => {
  const sizes = {};
  const asks = { r: async (/** @type {any} */ query, /** @type {any} */ page) => { sizes[query.text] = (sizes[query.text] ?? 0) + 1; return { status: "ok", total: 900, items: Array.from({ length: page.limit }, (_, at) => ({ registryId: `${query.text}${page.pageToken ?? 0}-${at}` })), nextPageToken: String((Number(page.pageToken) || 0) + 1) }; } };
  const queries = [{ kind: "condition", text: "c" }, ...Array.from({ length: 32 }, (_, at) => ({ kind: "term", text: `t${at}` }))];
  const read = await retrieveCandidates({ queries, asks, registries: ["r"], retrieveMax: 500, pageSizes: { r: 100 }, deadlineAt: Date.now() + 5_000 });
  assert.equal(read.results.r[0].items.length, 200);
  assert.equal(read.results.r[1].items.length, 24);
  assert.equal(read.depth, 24);
});
