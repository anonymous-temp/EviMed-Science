// What Semantic Scholar and OpenAlex add about a shortlisted paper, when the deployment has their keys: recorded answers, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createEvolutionScholarEnrichment, openAlexFields, semanticScholarFields } from "../src/evolutionScholarEnrichment.mjs";

const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(new URL(`./fixtures/evolution/${name}`, import.meta.url), "utf8"));
const s2 = fixture("semantic-scholar-batch.json");
const preprint = fixture("openalex-work-preprint.json");
const published = fixture("openalex-work-published.json");
const papers = [
  { key: "arxiv:2610.12083", arxivId: "2610.12083", doi: null },
  { key: "arxiv:2610.12453", arxivId: "2610.12453", doi: null },
  { key: "arxiv:2506.00001", arxivId: "2506.00001", doi: null },
];
const json = (/** @type {any} */ body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers from the recorded files and remembers what it was asked. */
function recorder(/** @type {(url: string, init: any) => Response} */ answer) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  const fetchImpl = /** @type {typeof fetch} */ (async (/** @type {any} */ url, /** @type {any} */ init) => { calls.push({ url: String(url), init }); return answer(String(url), init); });
  return { calls, fetchImpl };
}

test("what the ranking reads of a Semantic Scholar record: a venue that is not a repository, the citations, the DOI", () => {
  assert.deepEqual(semanticScholarFields(s2[0]), { venue: null, citations: 0, publicationDate: "2026-10-08", doi: null, openAccessPdf: null });
  assert.deepEqual(semanticScholarFields(s2[2]), { venue: "Asia Pacific Conference on Circuits and Systems", citations: 1, publicationDate: s2[2].publicationDate,
    doi: "10.1109/apccas62602.2024.10808959", openAccessPdf: semanticScholarFields(s2[2])?.openAccessPdf ?? null });
  assert.equal(semanticScholarFields({ venue: "arXiv.org", citationCount: 3 })?.venue, null, "a repository is where a preprint is kept, not where it was published");
  assert.equal(semanticScholarFields({ venue: "", publicationVenue: { name: "NeurIPS" } })?.venue, "NeurIPS");
  assert.equal(semanticScholarFields(null), null);
  assert.equal(semanticScholarFields({ citationCount: -1 })?.citations, null);
});

test("what it reads of an OpenAlex work: a journal or conference among its locations, the citations", () => {
  assert.deepEqual(openAlexFields(preprint), { venue: null, citations: 0, publicationDate: "2025-03-26", doi: "10.48550/arxiv.2506.00001", openAccessPdf: null });
  assert.equal(openAlexFields(published)?.venue, "neural information processing systems");
  assert.equal(openAlexFields(published)?.citations, published.cited_by_count);
  assert.ok(openAlexFields(published)?.citations > 1000);
  assert.equal(openAlexFields(undefined), null);
});

test("a deployment without a key skips the index and says so, and asks nothing", async () => {
  const { calls, fetchImpl } = recorder(() => json({}));
  const scholar = createEvolutionScholarEnrichment({ fetchImpl });
  assert.deepEqual(scholar.available(), { semanticScholar: false, openAlex: false });
  const { providers, byKey } = await scholar.enrich(papers);
  assert.deepEqual(providers, { semanticScholar: { status: "skipped", reason: "no_key", found: 0 }, openAlex: { status: "skipped", reason: "no_key", found: 0 } });
  assert.equal(byKey.size, 0);
  assert.equal(calls.length, 0, "no key, no request");
});

test("with a Semantic Scholar key one batch is sent in the shortlist's order, and what comes back is read by position", async () => {
  const { calls, fetchImpl } = recorder(() => json(s2));
  const scholar = createEvolutionScholarEnrichment({ semanticScholarKey: "s2-secret", fetchImpl });
  const { providers, byKey } = await scholar.enrich(papers);
  assert.deepEqual(providers, { semanticScholar: { status: "ok", found: 3 }, openAlex: { status: "skipped", reason: "no_key", found: 0 } });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.match(call.url, /^https:\/\/api\.semanticscholar\.org\/graph\/v1\/paper\/batch\?fields=/);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["x-api-key"], "s2-secret");
  assert.deepEqual(JSON.parse(call.init.body), { ids: ["ARXIV:2610.12083", "ARXIV:2610.12453", "ARXIV:2506.00001"] });
  assert.equal(call.init.redirect, "error");
  assert.equal(byKey.get("arxiv:2506.00001")?.venue, "Asia Pacific Conference on Circuits and Systems");
  assert.deepEqual(byKey.get("arxiv:2506.00001")?.from, ["semanticScholar"]);
  assert.equal(byKey.get("arxiv:2610.12083")?.citations, 0);
});

test("a paper without an arXiv identifier is looked up by DOI, and one with neither is not asked about", async () => {
  const { calls, fetchImpl } = recorder(() => json([null, null]));
  const scholar = createEvolutionScholarEnrichment({ semanticScholarKey: "k", fetchImpl });
  await scholar.enrich([{ key: "doi:10.1/x", arxivId: null, doi: "10.1/x" }, { key: "title:abc", arxivId: null, doi: null }, { key: "arxiv:2610.1", arxivId: "2610.00001", doi: null }]);
  assert.deepEqual(JSON.parse(calls[0].init.body).ids, ["DOI:10.1/x", "ARXIV:2610.00001"]);
});

test("with an OpenAlex key each paper is looked up by its DOI, the key travels in a header and never in the address, and a missing work is no failure", async () => {
  const { calls, fetchImpl } = recorder(url => {
    if (url.includes("arxiv.2506.00001")) return json(preprint);
    if (url.includes("arxiv.2610.12083")) return json(published);
    return json({ error: "not found" }, 404);
  });
  const scholar = createEvolutionScholarEnrichment({ openAlexKey: "oa key", fetchImpl, pause: async () => {} });
  const { providers, byKey } = await scholar.enrich(papers);
  assert.deepEqual(providers.openAlex, { status: "ok", found: 2 });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /^https:\/\/api\.openalex\.org\/works\/doi:10\.48550\/arxiv\.2610\.12083\?select=[\w,]+$/);
  assert.equal(calls[0].init.headers.authorization, "Bearer oa key");
  assert.equal(byKey.get("arxiv:2610.12083")?.venue, "neural information processing systems");
  assert.equal(byKey.has("arxiv:2610.12453"), false);
});

test("the two indexes are merged: Semantic Scholar's venue first, the larger citation count, both named", async () => {
  const { fetchImpl } = recorder(url => (url.includes("semanticscholar") ? json([{ venue: "ICML", citationCount: 2, externalIds: {} }, null, null])
    : json({ ...published, cited_by_count: 40, locations: [{ source: { type: "journal", display_name: "Nature" } }] })));
  const scholar = createEvolutionScholarEnrichment({ semanticScholarKey: "a", openAlexKey: "b", fetchImpl, pause: async () => {} });
  const { byKey } = await scholar.enrich([papers[0]]);
  assert.deepEqual(byKey.get("arxiv:2610.12083"), { venue: "ICML", citations: 40, publicationDate: byKey.get("arxiv:2610.12083")?.publicationDate, doi: byKey.get("arxiv:2610.12083")?.doi,
    openAccessPdf: null, from: ["semanticScholar", "openAlex"] });
});

test("each index fails on its own: a spent allowance ends that index for the week and the other still answers", async () => {
  const { calls, fetchImpl } = recorder(url => (url.includes("semanticscholar") ? json({ message: "Too Many Requests" }, 429) : json(published)));
  const scholar = createEvolutionScholarEnrichment({ semanticScholarKey: "a", openAlexKey: "b", fetchImpl, pause: async () => {} });
  const { providers, byKey } = await scholar.enrich(papers.slice(0, 2));
  assert.deepEqual(providers.semanticScholar, { status: "failed", reason: "http_429", found: 0 });
  assert.equal(providers.openAlex.status, "ok");
  assert.equal(byKey.size, 2);
  assert.equal(calls.filter(call => call.url.includes("openalex")).length, 2);

  const refused = recorder(url => (url.includes("openalex") ? json({}, 403) : json(s2)));
  const second = createEvolutionScholarEnrichment({ semanticScholarKey: "a", openAlexKey: "b", fetchImpl: refused.fetchImpl, pause: async () => {} });
  const answer = await second.enrich(papers);
  assert.equal(answer.providers.openAlex.reason, "http_403");
  assert.equal(refused.calls.filter(call => call.url.includes("openalex")).length, 1, "a refused key is not tried again for every paper");
  assert.equal(answer.providers.semanticScholar.status, "ok");
});

test("a key OpenAlex refuses (its recorded 401) ends that index and is not tried for every paper", async () => {
  const refusal = fixture("openalex-invalid-key.json");
  assert.equal(refusal.error, "Invalid or missing API key");
  const { calls, fetchImpl } = recorder(() => json(refusal, 401));
  const { providers } = await createEvolutionScholarEnrichment({ openAlexKey: "wrong", fetchImpl, pause: async () => {} }).enrich(papers);
  assert.deepEqual(providers.openAlex, { status: "failed", reason: "http_401", found: 0 });
  assert.equal(calls.length, 1);
});

test("an index that cannot be reached, answers the wrong shape or too much is reported by a closed code, never by the error or the key", async () => {
  const down = createEvolutionScholarEnrichment({ semanticScholarKey: "super-secret-key", openAlexKey: "other-secret-key", pause: async () => {},
    fetchImpl: /** @type {typeof fetch} */ (async url => { throw new TypeError(`fetch failed for ${url}`); }) });
  const outcome = await down.enrich(papers);
  assert.deepEqual(outcome.providers.semanticScholar, { status: "failed", reason: "unreachable", found: 0 });
  assert.deepEqual(outcome.providers.openAlex, { status: "failed", reason: "lookups_failed", found: 0 });
  assert.equal(JSON.stringify(outcome).includes("secret"), false, "a key is never part of a record");

  const odd = createEvolutionScholarEnrichment({ semanticScholarKey: "k", fetchImpl: recorder(() => json({ data: [] })).fetchImpl });
  assert.equal((await odd.enrich(papers)).providers.semanticScholar.reason, "unexpected_shape");
  const huge = createEvolutionScholarEnrichment({ semanticScholarKey: "k", fetchImpl: recorder(() => new Response("[" + "0,".repeat(1_100_000) + "0]")).fetchImpl });
  assert.equal((await huge.enrich(papers)).providers.semanticScholar.reason, "answer_too_large");
});

test("nothing is asked when there is nothing shortlisted", async () => {
  const { calls, fetchImpl } = recorder(() => json([]));
  const { providers } = await createEvolutionScholarEnrichment({ semanticScholarKey: "k", openAlexKey: "k", fetchImpl }).enrich([]);
  assert.deepEqual(providers, { semanticScholar: { status: "ok", found: 0 }, openAlex: { status: "ok", found: 0 } });
  assert.equal(calls.length, 0);
});
