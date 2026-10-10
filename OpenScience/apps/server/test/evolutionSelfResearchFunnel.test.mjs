// The weekly self-research funnel : collected, merged, screened, shortlisted, enriched, read whole, written as cards.
// Every dependency is a double: no model, no network, no database.
import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptTriage, cardIsComplete, compareCandidates, createEvolutionSelfResearch, mergeEntries, mondayOf, triageMessages, triageText,
} from "../src/evolutionSelfResearch.mjs";
import { createEvolutionScholarEnrichment } from "../src/evolutionScholarEnrichment.mjs";

const MONDAY = new Date("2026-10-12T22:30:00.000Z");
const WEEK_ID = "evolution-self-research-2026-10-12";

/** The ledger the module saves its week into, with the revision check the real one has. */
function ledger() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  const service = {
    get: async (/** @type {string} */ id) => rows.get(id) ?? null,
    list: async (/** @type {string} */ type) => [...rows.values()].filter(row => row.type === type),
    save: async (/** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ payload, /** @type {any} */ previous = null) => {
      const current = rows.get(id);
      assert.equal(previous?.revision ?? 0, current?.revision ?? 0, `${id}: saved on a stale revision`);
      const row = { type, id, payload: JSON.parse(JSON.stringify(payload)), revision: (current?.revision ?? 0) + 1 };
      rows.set(id, row);
      return row;
    },
  };
  return { rows, service };
}

let sequence = 0;
/** One entry as `discover` returns it. */
function entry(/** @type {Record<string, any>} */ over = {}) {
  const n = ++sequence, id = `2610.${String(n).padStart(5, "0")}`;
  return { id: String(n), title: `A paper about agents number ${n}`, abstract: `Abstract ${n}.`, sourceText: `Abstract of paper ${n}: incremental updates retain details of useful prior methods in agent memory.`,
    sourceUrl: `https://arxiv.org/abs/${id}`, doi: `10.48550/arxiv.${id}`, sourceId: "ai-discovery-arxiv-agents-memory", publishedAt: "2026-10-09T10:00:00.000Z",
    cursor: { id: String(n), receivedAt: "2026-10-10T00:00:00.000Z" }, ...over };
}
/** The card a model would write for one preserved paper. */
const cardFor = (/** @type {any} */ preserved, /** @type {string} */ key = `mechanism of ${preserved.entryId}`) => ({ entryId: preserved.entryId, mechanismKey: key, problem: "context collapse",
  mechanism: "incremental updates", falsifiableExpectation: "shorter context with stable performance", targetObjects: ["memory"], estimatedCostCny: 2, quote: preserved.text.slice(0, 50) });

/** A funnel with doubles for everything it depends on; `over` replaces any of them. */
function funnel(/** @type {any[]} */ entries, /** @type {Record<string, any>} */ over = {}) {
  const { rows, service } = ledger();
  /** @type {any} */
  const seen = { triage: [], read: [], verify: [], extract: [], opportunities: [], discover: [] };
  const research = createEvolutionSelfResearch({
    service, now: () => MONDAY,
    discover: async (/** @type {any} */ input) => { seen.discover.push(input); return entries; },
    triage: async ({ items }) => { seen.triage.push(items); return { items: items.map((/** @type {any} */ item) => ({ id: item.id, fit: 3, venue: { status: "none", quote: "" } })) }; },
    readFullText: async paper => { seen.read.push(paper); return { kind: "abstract", reason: "no_reader" }; },
    verify: async (/** @type {any} */ item) => { seen.verify.push(item); return { text: item.sourceText, digest: `sha256:${item.id}`, url: item.sourceUrl, publicationStatus: item.publicationStatus }; },
    extract: async (/** @type {any} */ input) => { seen.extract.push(input); return { cards: [cardFor(input.entries[0])] }; },
    addOpportunity: async (/** @type {any} */ input) => { seen.opportunities.push(input); },
    ...over,
  });
  return { research, rows, service, seen };
}

test("a paper listed by several rows is one candidate, carrying everything the rows say about it", () => {
  const id = "2610.99999", base = { doi: `10.48550/arxiv.${id}`, publishedAt: "2026-10-09T10:00:00.000Z" };
  const merged = [...mergeEntries([
    entry({ ...base, id: "1", sourceId: "ai-discovery-arxiv-agents-memory", sourceUrl: `https://arxiv.org/abs/${id}`, sourceText: "The abstract of the paper, long enough to be the longest text of the three.\n\nComments: Accepted at NeurIPS 2026" }),
    entry({ ...base, id: "2", sourceId: "ai-discovery-hf-daily-papers", sourceUrl: `https://arxiv.org/abs/${id}`, sourceText: `The abstract.\n\nCode: https://github.com/team/repo`, publishedAt: "2026-10-08T00:00:00.000Z" }),
    entry({ ...base, id: "3", sourceId: "ai-discovery-arxiv-venue-accepted", sourceUrl: `https://arxiv.org/abs/${id}v2` }),
    entry({ id: "4", sourceId: "ai-discovery-gh-langchain-ai-langgraph", title: "langgraph 1.2.14", sourceUrl: "https://github.com/langchain-ai/langgraph/releases/tag/1.2.14", doi: null, sourceText: "Changes since 1.2.13" }),
  ]).values()];
  assert.equal(merged.length, 2);
  const paper = merged.find(candidate => candidate.kind === "paper");
  assert.equal(paper.key, `arxiv:${id}`);
  assert.deepEqual(paper.sourceIds, ["ai-discovery-arxiv-agents-memory", "ai-discovery-hf-daily-papers", "ai-discovery-arxiv-venue-accepted"]);
  assert.equal(paper.attention, true);
  assert.equal(paper.venueRow, true);
  assert.equal(paper.codeLink, "https://github.com/team/repo");
  assert.match(paper.text, /Comments: Accepted at NeurIPS 2026$/, "the longest text is kept, which is the one with the authors' comment");
  assert.equal(paper.publishedAt, "2026-10-08T00:00:00.000Z", "the earliest date is kept");
  assert.equal(merged.find(candidate => candidate.kind === "release").key.startsWith("url:"), true);
});

test("the order a shortlist is read in: topical fit, then venue, then a code link, then attention, then citations once a paper is ninety days old", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  const paper = (/** @type {string} */ key, /** @type {any} */ over = {}) => ({ key, fit: 2, label: "none", codeLink: null, attention: false, citations: null, publishedAt: "2026-10-01T00:00:00Z", ...over });
  const order = (/** @type {any[]} */ list) => [...list].sort((a, b) => compareCandidates(a, b, now)).map(item => item.key);
  assert.deepEqual(order([paper("low-fit-but-everything-else", { fit: 2, label: "accepted", codeLink: "x", attention: true }), paper("fit-3", { fit: 3 })]), ["fit-3", "low-fit-but-everything-else"]);
  assert.deepEqual(order([paper("none"), paper("workshop", { label: "workshop" }), paper("accepted", { label: "accepted" })]), ["accepted", "workshop", "none"]);
  assert.deepEqual(order([paper("plain"), paper("code", { codeLink: "https://github.com/a/b" })]), ["code", "plain"]);
  assert.deepEqual(order([paper("quiet"), paper("upvoted", { attention: true })]), ["upvoted", "quiet"]);
  assert.deepEqual(order([paper("new", { citations: 500 }), paper("old", { citations: 3, publishedAt: "2026-05-01T00:00:00Z" }), paper("older", { citations: 40, publishedAt: "2026-04-01T00:00:00Z" })]),
    ["older", "old", "new"], "a young paper's citations count for nothing; an old one's do");
  assert.deepEqual(order([paper("b", { publishedAt: "2026-10-02T00:00:00Z" }), paper("a", { publishedAt: "2026-10-03T00:00:00Z" })]), ["a", "b"], "the newest first");
  assert.deepEqual(order([paper("unscreened", { fit: null }), paper("zero", { fit: 0 })]), ["zero", "unscreened"]);
});

test("a screening answer is kept for the items the batch had, with a fit from 0 to 3 and a venue only when its words are in the text", () => {
  const batch = [{ id: "i1", candidate: { key: "a", text: "Abstract.\n\nComments: Accepted at ICLR 2027 (poster)" } }, { id: "i2", candidate: { key: "b", text: "Abstract." } },
    { id: "i3", candidate: { key: "c", text: "Abstract." } }];
  const { kept, quoteRejected } = acceptTriage(batch, { items: [
    { id: "i1", fit: 3, venue: { status: "accepted", quote: "Accepted at ICLR 2027 (poster)" } },
    { id: "i2", fit: 2, venue: { status: "accepted", quote: "Accepted at NeurIPS" } },
    { id: "i3", fit: 4, venue: { status: "none", quote: "" } },
    { id: "i9", fit: 3, venue: { status: "none", quote: "" } },
    { id: "i1", fit: 0, venue: { status: "none", quote: "" } },
  ] });
  assert.deepEqual([...kept], [["a", { fit: 3, label: "accepted", quote: "Accepted at ICLR 2027 (poster)" }], ["b", { fit: 2, label: "none", quote: null }]]);
  assert.equal(quoteRejected, 1, "a claim whose words are not in the text is dropped, not softened");
  assert.deepEqual([...acceptTriage(batch, null).kept], []);
  assert.deepEqual([...acceptTriage(batch, { items: [{ id: "i1", fit: 2, venue: { status: "workshop", quote: "Accepted at ICLR 2027 (poster)" } }] }).kept][0][1].label, "workshop");
});

test("the screening call is told the platform's open problems and sees the authors' comment even in a long abstract", () => {
  const long = `${"An abstract sentence. ".repeat(80)}\n\nComments: Accepted at COLM 2026`;
  const text = triageText({ text: long });
  assert.ok(text.length < long.length);
  assert.match(text, /Comments: Accepted at COLM 2026$/);
  assert.equal(triageText({ text: "short" }), "short");
  const messages = triageMessages([{ id: "i1", kind: "paper", title: "T", text }], ["Memory recall misses source conflicts"]);
  assert.match(messages[0].content, /untrusted data/);
  assert.deepEqual(JSON.parse(messages[1].content).problems, ["Memory recall misses source conflicts"]);
});

test("the week: papers merged across rows, screened, the best read whole, cards written with where they came from", async () => {
  const shared = "2610.77777";
  const entries = [
    entry({ id: "a1", sourceId: "ai-discovery-arxiv-agents-memory", doi: `10.48550/arxiv.${shared}`, sourceUrl: `https://arxiv.org/abs/${shared}`, title: "Shared paper" }),
    entry({ id: "a2", sourceId: "ai-discovery-hf-daily-papers", doi: `10.48550/arxiv.${shared}`, sourceUrl: `https://arxiv.org/abs/${shared}`, title: "Shared paper", sourceText: "Abstract of the shared paper.\n\nCode: https://github.com/team/shared" }),
    entry({ id: "b1" }), entry({ id: "volume", sourceId: "ai-discovery-pmlr-volumes", title: "v306", doi: null, sourceUrl: "https://proceedings.mlr.press/v306" }),
  ];
  const { research, rows, seen } = funnel(entries, { readFullText: async (/** @type {any} */ paper) => { seen.read.push(paper); return { kind: "full", text: `Full text of ${paper.arxivId}: incremental updates retain details of useful prior methods in agent memory.`, url: `https://arxiv.org/html/${paper.arxivId}`, truncated: false }; } });
  const result = await research.tick();
  assert.equal(result.status, "complete");
  assert.deepEqual(result.funnel, { collected: 4, merged: 2, venueEvents: 1, alreadyScreened: 0, screened: 2, deferred: 0, unscreened: 0, triageFailed: 0, shortlisted: 2, picks: 2, fullTexts: 2, verified: 2, cards: 2, rejected: 0, extractFailed: 0 });
  assert.equal(seen.triage.length, 1);
  assert.equal(seen.triage[0].length, 2, "the shared paper is screened once, and the proceedings volume is no candidate");
  assert.ok(seen.read.every((/** @type {any} */ paper) => /^2610\./.test(paper.arxivId)));
  const cards = [...rows.values()].filter(row => row.type === "mechanism-card");
  assert.equal(cards.length, 2);
  const shared_ = cards.find(card => card.payload.discovery.sources.includes("ai-discovery-hf-daily-papers"));
  assert.deepEqual(shared_.payload.discovery, { kind: "paper", sources: ["ai-discovery-arxiv-agents-memory", "ai-discovery-hf-daily-papers"], venueLabel: "none", labelSource: null,
    codeLink: "https://github.com/team/shared", attention: true, fullText: true });
  assert.equal(shared_.payload.status, "hypothesis");
  assert.equal(seen.opportunities.length, 2);
  assert.deepEqual(seen.discover.map((/** @type {any} */ input) => [input.afterId, input.limit]), [[null, 100]]);
  assert.equal(new Date(seen.discover[0].since).toISOString(), "2026-10-03T22:30:00.000Z", "a week and two days back");
  assert.deepEqual(result.sources["ai-discovery-hf-daily-papers"], { entries: 1, health: null, skipped: false, shortlisted: 1, cards: 1 });
  assert.equal(rows.get(WEEK_ID).payload.status, "complete");
  assert.equal((await research.tick()).status, "complete", "a finished week is not run twice");
  assert.equal(seen.triage.length, 1);
});

test("the caps hold at every stage, and the cap that bit is counted", async () => {
  const entries = Array.from({ length: 12 }, (_, index) => entry({ id: `p${index}`, sourceId: index === 11 ? "ai-discovery-hf-daily-papers" : "ai-discovery-arxiv-agents-memory" }));
  const { research, seen } = funnel(entries, { limits: { screen: 5, shortlist: 4, fullText: 3, cards: 2 } });
  const result = await research.tick();
  const screenedIds = seen.triage.flat().map((/** @type {any} */ item) => item.title);
  assert.equal(screenedIds.length, 5, "at most `screen` titles and abstracts");
  assert.ok(screenedIds.includes(entries[11].title), "what the community listed is screened first when there is not room for everything");
  assert.equal(result.funnel.shortlisted, 4);
  assert.equal(result.funnel.deferred, 7, "what the cap left waits for next week");
  assert.equal(result.funnel.picks, 3);
  assert.equal(seen.read.length, 2, "reading stops at `cards` cards: the third pick is never read");
  assert.equal(result.funnel.cards, 2);
  assert.deepEqual(research.counters.capHits, { collect: 0, screen: 1, shortlist: 1, fullText: 1, cards: 1 });
  assert.equal(research.limits.screen, 5);
});

test("the defaults are the brief's: 300 screens, 30 shortlisted, 12 read whole, 8 cards", async () => {
  const { research } = funnel([]);
  assert.deepEqual(research.limits, { screen: 300, shortlist: 30, fullText: 12, cards: 8 });
});

test("screening runs in batches of thirty; a batch that fails leaves its items unscreened and the others go on", async () => {
  const entries = Array.from({ length: 70 }, (_, index) => entry({ id: `q${index}` }));
  let calls = 0;
  const { research, seen } = funnel(entries, { limits: { shortlist: 100, fullText: 0 },
    triage: async ({ items }) => { calls += 1; seen.triage.push(items); if (calls === 2) throw new Error("model unavailable"); return { items: items.map((/** @type {any} */ item) => ({ id: item.id, fit: 2, venue: { status: "none", quote: "" } })) }; } });
  const result = await research.tick();
  assert.deepEqual(seen.triage.map((/** @type {any[]} */ batch) => batch.length), [30, 30, 10]);
  assert.equal(result.funnel.screened, 40);
  assert.equal(result.funnel.unscreened, 30);
  assert.equal(result.funnel.triageFailed, 1);
  assert.equal(result.funnel.shortlisted, 40, "only what was screened is shortlisted: a verdict is never invented");
  assert.equal(research.counters.triageBatchesFailed, 1);
});

test("a venue the authors claim counts only with their words in the text, and the card's evidence strength follows it", async () => {
  const withComment = entry({ id: "claimed", sourceText: "Abstract of the claimed paper with enough words in it.\n\nComments: Accepted at ICLR 2027" });
  const liar = entry({ id: "liar", sourceText: "Abstract of the other paper with enough words in it. Nothing about venues." });
  const { research, seen, rows } = funnel([withComment, liar], { limits: { cards: 8 },
    triage: async ({ items }) => ({ items: items.map((/** @type {any} */ item) => ({ id: item.id, fit: 3, venue: { status: "accepted", quote: item.text.includes("ICLR") ? "Accepted at ICLR 2027" : "Accepted at NeurIPS 2026" } })) }) });
  await research.tick();
  const status = Object.fromEntries(seen.verify.map((/** @type {any} */ item) => [item.id, item.publicationStatus]));
  assert.deepEqual(status, { claimed: "accepted", liar: "preprint" });
  const strength = Object.fromEntries([...rows.values()].filter(row => row.type === "mechanism-card").map(row => [row.payload.source.entryId, row.payload.evidenceStrength]));
  assert.deepEqual(strength, { claimed: "peer-reviewed", liar: "preprint" });
  assert.equal(research.counters.venueQuotesRejected, 1);
});

test("a scholarly index with a key names a venue and citations; without one it is skipped, counted, and the week goes on", async () => {
  const entries = [entry({ id: "indexed" }), entry({ id: "plain" })];
  /** @type {string[]} */
  const asked = [];
  const noKey = createEvolutionScholarEnrichment({ fetchImpl: /** @type {typeof fetch} */ (async url => { asked.push(String(url)); throw new Error("must not be asked"); }) });
  const skipped = funnel(entries, { enrich: (/** @type {any[]} */ papers) => noKey.enrich(papers) });
  const first = await skipped.research.tick();
  assert.deepEqual(first.enrichment, { semanticScholar: { status: "skipped", reason: "no_key", found: 0 }, openAlex: { status: "skipped", reason: "no_key", found: 0 } });
  assert.equal(asked.length, 0);
  assert.equal(first.status, "complete");
  assert.deepEqual(skipped.research.counters.enrichment, { semanticScholar: { no_key: 1 }, openAlex: { no_key: 1 } });

  const keyed = createEvolutionScholarEnrichment({ semanticScholarKey: "k", fetchImpl: /** @type {typeof fetch} */ (async (_url, init) => {
    const ids = JSON.parse(/** @type {any} */ (init).body).ids;
    return new Response(JSON.stringify(ids.map((/** @type {string} */ id) => (id.endsWith(entries[0].doi.split("arxiv.")[1]) ? { venue: "Neural Information Processing Systems", citationCount: 7, externalIds: {} } : { venue: "", citationCount: 0, externalIds: {} }))));
  }) });
  const enriched = funnel(entries, { enrich: (/** @type {any[]} */ papers) => keyed.enrich(papers), readFullText: async (/** @type {any} */ paper) => { enriched.seen.read.push(paper); return { kind: "abstract", reason: "no_reader" }; } });
  const second = await enriched.research.tick();
  assert.equal(second.enrichment.semanticScholar.found, 2);
  assert.deepEqual(enriched.seen.read.map((/** @type {any} */ paper) => paper.arxivId), [entries[0].doi.split("arxiv.")[1], entries[1].doi.split("arxiv.")[1]], "the paper the index places at a venue is read first");
  assert.equal(enriched.seen.verify[0].publicationStatus, "accepted");
  assert.equal(enriched.rows.get(WEEK_ID).payload.shortlist.length, 2);
});

test("an index that throws costs the week nothing", async () => {
  const { research } = funnel([entry({ id: "x" })], { enrich: async () => { throw new Error("index down"); } });
  const result = await research.tick();
  assert.equal(result.status, "complete");
  assert.deepEqual(result.enrichment, { enrichment: { status: "failed", reason: "unavailable", found: 0 } });
  assert.equal(result.funnel.cards, 1);
});

test("a paper that cannot be read whole is read from its abstract, and the reason is counted", async () => {
  const entries = [entry({ id: "r1" }), entry({ id: "r2" }), entry({ id: "r3" })];
  const outcomes = [{ kind: "abstract", reason: "web_read_robots_disallowed" }, Promise.reject(new Error("boom")), { kind: "full", text: "Full text of r3: incremental updates retain details of useful prior methods.", url: "https://arxiv.org/html/x", truncated: false }];
  let index = 0;
  const { research, seen } = funnel(entries, { readFullText: async () => outcomes[index++] });
  const result = await research.tick();
  assert.equal(result.funnel.cards, 3);
  assert.deepEqual(research.counters.fullTextFallbacks, { web_read_robots_disallowed: 1, unreachable: 1 });
  assert.equal(research.counters.fullTexts, 1);
  assert.equal(seen.verify.filter((/** @type {any} */ item) => item.sourceText.startsWith("Full text")).length, 1, "the abstract is what was preserved where the page could not be read");
  assert.equal(result.funnel.fullTexts, 1);
});

test("a card that fails the quotation or the field checks is rejected and counted; a duplicate mechanism is written once", async () => {
  const entries = [entry({ id: "k1" }), entry({ id: "k2" }), entry({ id: "k3" })];
  let call = 0;
  const { research, rows } = funnel(entries, { extract: async (/** @type {any} */ input) => {
    call += 1;
    const preserved = input.entries[0];
    if (call === 1) return { cards: [{ ...cardFor(preserved, "same mechanism"), quote: "A fabricated quotation that does not occur in the paper at all." }, cardFor(preserved, "same mechanism")] };
    if (call === 2) return { cards: [cardFor(preserved, "SAME   mechanism"), { ...cardFor(preserved, "other"), estimatedCostCny: -1 }] };
    return { cards: [{ ...cardFor(preserved, "third"), entryId: "someone-else" }] };
  } });
  const result = await research.tick();
  assert.equal([...rows.values()].filter(row => row.type === "mechanism-card").length, 1, "the renamed duplicate is not a second card");
  assert.equal(result.rejected, 3);
  assert.equal(research.counters.rejected, 3);
  assert.equal(cardIsComplete({ quote: "short", mechanismKey: "k" }, { text: "short" }), false);
});

test("a week in which the model answered nothing is run again, and what was done before is not done twice", async () => {
  const entries = [entry({ id: "m1" }), entry({ id: "m2" })];
  let triageCalls = 0;
  let broken = true;
  const { research, rows, seen } = funnel(entries, {
    triage: async ({ items }) => { triageCalls += 1; return { items: items.map((/** @type {any} */ item) => ({ id: item.id, fit: 3, venue: { status: "none", quote: "" } })) }; },
    extract: async (/** @type {any} */ input) => { if (broken) throw new Error("model down"); seen.extract.push(input); return { cards: [cardFor(input.entries[0])] }; },
  });
  await assert.rejects(research.tick(), { code: "evolution_self_research_unavailable" });
  assert.equal(rows.get(WEEK_ID).payload.status, "running");
  assert.equal(Object.keys(rows.get(WEEK_ID).payload.verdicts).length, 2, "the screening is kept");
  broken = false;
  const result = await research.tick();
  assert.equal(result.status, "complete");
  assert.equal(triageCalls, 1, "the screening was not paid for again");
  assert.equal(result.funnel.cards, 2);

  const dead = funnel(entries, { triage: async () => { throw new Error("down"); } });
  await assert.rejects(dead.research.tick(), { code: "evolution_self_research_unavailable" });
  assert.equal(dead.rows.get(WEEK_ID).payload.status, "running", "not recorded as a week of nothing");
});

test("a paper whose preservation fails is recorded unverified and the others go on", async () => {
  const entries = [entry({ id: "s1" }), entry({ id: "s2" }), entry({ id: "s3" })];
  let verifyCalls = 0;
  const { research, rows, seen } = funnel(entries, {
    verify: async (/** @type {any} */ item) => { verifyCalls += 1; if (verifyCalls === 2) throw new Error("the ledger refused the asset"); return { text: item.sourceText, digest: `d${item.id}`, url: item.sourceUrl, publicationStatus: item.publicationStatus }; } });
  const result = await research.tick();
  assert.equal(result.status, "complete");
  assert.equal(result.funnel.verified, 2);
  assert.equal(Object.values(rows.get(WEEK_ID).payload.processed).filter((/** @type {any} */ item) => item.outcome === "unverified").length, 1);
  assert.equal(seen.read.length, 3);
});

test("a run that stops midway resumes: what was screened and what was read is not paid for again", async () => {
  const entries = [entry({ id: "t1" }), entry({ id: "t2" }), entry({ id: "t3" })];
  const { rows, service } = ledger();
  let failOnce = true;
  const flaky = { ...service, save: async (/** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ payload, /** @type {any} */ previous) => {
    if (failOnce && type === "self-research" && Object.keys(payload.processed ?? {}).length === 2) { failOnce = false; throw new Error("the database went away"); }
    return service.save(type, id, payload, previous);
  } };
  const seen = { triage: 0, read: [], extract: 0 };
  const build = () => createEvolutionSelfResearch({ service: flaky, now: () => MONDAY, discover: async () => entries,
    triage: async ({ items }) => { seen.triage += 1; return { items: items.map((/** @type {any} */ item) => ({ id: item.id, fit: 3, venue: { status: "none", quote: "" } })) }; },
    readFullText: async (/** @type {any} */ paper) => { /** @type {any} */ (seen.read).push(paper.arxivId); return { kind: "abstract", reason: "no_reader" }; },
    verify: async (/** @type {any} */ item) => ({ text: item.sourceText, digest: `d${item.id}`, url: item.sourceUrl, publicationStatus: item.publicationStatus }),
    extract: async (/** @type {any} */ input) => { seen.extract += 1; return { cards: [cardFor(input.entries[0])] }; } });
  await assert.rejects(build().tick(), /database went away/);
  assert.equal(rows.get(WEEK_ID).payload.status, "running");
  assert.equal(Object.keys(rows.get(WEEK_ID).payload.processed).length, 1);
  const result = await build().tick();
  assert.equal(result.status, "complete");
  assert.equal(seen.triage, 1, "screened once");
  assert.equal(seen.read.length, 4, "two papers before the stop, and the one it stopped on again with the one after it");
  assert.equal([...rows.values()].filter(row => row.type === "mechanism-card").length, 3, "the card written just before the stop is not written twice");
  assert.equal(Object.keys(result.processed).length, 3);
});

test("a paper screened in the last two weeks is not screened again", async () => {
  const early = [entry({ id: "w1" }), entry({ id: "w2" })];
  const { research, rows, seen } = funnel(early);
  await research.tick();
  assert.equal(seen.triage.flat().length, 2);
  // The next Monday the same two papers are still inside the window beside a new one.
  const later = [...early, entry({ id: "w3" })];
  const next = createEvolutionSelfResearch({ service: { get: async (/** @type {string} */ id) => rows.get(id) ?? null, list: async (/** @type {string} */ type) => [...rows.values()].filter(row => row.type === type),
    save: async (/** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ payload, /** @type {any} */ previous) => { const row = { type, id, payload, revision: (previous?.revision ?? 0) + 1 }; rows.set(id, row); return row; } },
  now: () => new Date(MONDAY.getTime() + 7 * 86_400_000), discover: async () => later, verify: async (/** @type {any} */ item) => ({ text: item.sourceText, digest: `n${item.id}`, url: item.sourceUrl }),
  triage: async ({ items }) => { seen.triage.push(items); return { items: items.map((/** @type {any} */ item) => ({ id: item.id, fit: 3, venue: { status: "none", quote: "" } })) }; },
  extract: async (/** @type {any} */ input) => ({ cards: [cardFor(input.entries[0])] }) });
  const result = await next.tick();
  assert.equal(seen.triage.at(-1).length, 1, "only the new paper is screened");
  assert.equal(result.funnel.alreadyScreened, 2);
  assert.equal(next.counters.alreadyScreened, 2);
});

test("each source on its own: one the plugin finds unreadable is skipped and counted, and the others are read", async () => {
  const entries = [entry({ id: "h1", sourceId: "ai-discovery-arxiv-agents-memory" }), entry({ id: "h2", sourceId: "openai-news" })];
  const { research } = funnel(entries, { sourceHealth: async () => [
    { id: "ai-discovery-arxiv-agents-memory", health: "healthy", enabled: true },
    { id: "ai-discovery-hf-daily-papers", health: "unreadable", enabled: true },
    { id: "ai-discovery-hf-blog", health: "new", enabled: false },
    { id: "openai-news", health: "degraded", enabled: true }] });
  const result = await research.tick();
  assert.deepEqual(Object.fromEntries(Object.entries(result.sources).map(([id, source]) => [id, [/** @type {any} */ (source).entries, /** @type {any} */ (source).skipped]])), {
    "ai-discovery-arxiv-agents-memory": [1, false], "ai-discovery-hf-daily-papers": [0, true], "ai-discovery-hf-blog": [0, true], "openai-news": [1, false] });
  assert.equal(research.counters.sourcesSkipped, 2);
  assert.equal(research.counters.sourcesRead, 2);
  assert.equal(result.funnel.cards, 2, "a degraded row is still read; the entries it did bring are used");
  const lost = funnel(entries, { sourceHealth: async () => { throw new Error("mirror unavailable"); } });
  assert.equal((await lost.research.tick()).status, "complete", "no health report is no reason to stop");
});

test("the week reads every page of the window and stops at its ceiling", async () => {
  const many = Array.from({ length: 250 }, (_, index) => entry({ id: `n${index}`, cursor: { id: String(index + 1) } }));
  /** @type {any[]} */
  const asked = [];
  const { research } = funnel([], { limits: { screen: 0 }, discover: async (/** @type {any} */ input) => {
    asked.push(input);
    const start = input.afterId == null ? 0 : Number(input.afterId);
    return many.slice(start, start + input.limit);
  } });
  const result = await research.tick();
  assert.equal(result.funnel.collected, 250);
  assert.deepEqual(asked.map(input => input.afterId), [null, "100", "200"]);
  assert.equal(research.counters.capHits.collect, 0);
});

test("proceedings volumes the plugin saw published are counted and set apart, never screened or read", async () => {
  const { research, seen } = funnel([entry({ id: "v1", sourceId: "ai-discovery-pmlr-volumes", doi: null, title: "v306" }), entry({ id: "v2", sourceId: "ai-discovery-acl-anthology-ingest", doi: null, title: "Ingest TACL 2026(Sep)" })]);
  const result = await research.tick();
  assert.equal(result.funnel.venueEvents, 2);
  assert.equal(seen.triage.length, 0);
  assert.equal(result.funnel.cards, 0);
  assert.equal(result.status, "complete");
  assert.equal(research.counters.venueEvents, 2);
});

test("the week starts on a Monday, in UTC", () => {
  assert.equal(mondayOf(new Date("2026-10-12T22:30:00Z")).toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(mondayOf(new Date("2026-10-18T23:59:59Z")).toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(mondayOf(new Date("2026-10-11T00:00:00Z")).toISOString(), "2026-10-05T00:00:00.000Z");
});
