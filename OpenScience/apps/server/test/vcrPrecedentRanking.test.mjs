/**
 * Ranking the registry trials a search found (algorithm round E5): BM25 over their words, the embedder over their meaning, the weight of the
 * two following the language of the question, the fallback named, and "has results" out of the score. The embedder is a stub with vectors we
 * choose: no embedding service is called here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createVcrEvidencePipeline, precedentSimilarity } from "../src/vcrEvidence.mjs";
import { PRECEDENT_FUSION, bm25, precedentQueryText, precedentText, precedentTokens, rankPrecedentCandidates } from "../src/vcrPrecedentRanking.mjs";

/** A candidate as the registry search hands it over, scored by its words the way `findPrecedents` scores it before the re-ranking. */
function candidate(/** @type {string} */ registryId, /** @type {Record<string, any>} */ fields, /** @type {any} */ target = {}) {
  const item = { registry: "clinicaltrials.gov", registryId, title: "", conditions: [], interventions: [], phases: [], allocation: "", hasResults: false, ...fields };
  return { ...item, similarity: precedentSimilarity({ pico: { conditions: item.conditions, interventions: item.interventions.map((/** @type {string} */ name) => ({ name })) },
    design: { phases: item.phases, allocation: item.allocation, hasResults: item.hasResults } }, target) };
}

/** An embedder whose vector for a text is chosen by the concept words it holds: texts about one concept are near, whatever the words. */
function conceptEmbedder(/** @type {Record<string, number[]>} */ concepts) {
  /** @type {string[][]} */ const calls = [];
  const vectorOf = (/** @type {string} */ text) => {
    const found = Object.entries(concepts).filter(([word]) => text.toLowerCase().includes(word));
    const vector = [0.05, 0.05, 0.05];
    for (const [, direction] of found) direction.forEach((each, at) => { vector[at] += each; });
    return vector;
  };
  return { calls, configured: true, modelKey: "stub@3", async embedDocuments(/** @type {string[]} */ texts) { calls.push([...texts]); return texts.map(vectorOf); } };
}

test("BM25 is the formula: a worked example, a shorter document scoring higher for the same word, a word nobody holds adding nothing", () => {
  // Documents [a b b], [a c], [c c c c]; query [a]. N = 3, the word is in 2: idf = ln(1 + (3 - 2 + 0.5) / (2 + 0.5)) = ln 1.6 = 0.470004.
  // Mean length 3. Document 1: tf 1, length 3: 2.2 / (1 + 1.2 * (0.25 + 0.75 * 1)) = 1.0, so 0.470004. Document 2: length 2:
  // 2.2 / (1 + 1.2 * (0.25 + 0.75 * 2 / 3)) = 2.2 / 1.9 = 1.157895, so 0.544215. Document 3 holds no a.
  const scores = bm25(["a"], [["a", "b", "b"], ["a", "c"], ["c", "c", "c", "c"]]);
  assert.ok(Math.abs(scores[0] - 0.470004) < 1e-6, String(scores[0]));
  assert.ok(Math.abs(scores[1] - 0.544215) < 1e-6, String(scores[1]));
  assert.equal(scores[2], 0);
  assert.deepEqual(bm25(["zzz"], [["a"], ["b"]]), [0, 0]);
  assert.deepEqual(bm25(["a"], []), []);
  // A word in every document weighs almost nothing and is never negative.
  assert.ok(bm25(["a"], [["a"], ["a"], ["a"]]).every((each) => each > 0 && each < 0.2));
  // Repeating a word in the query does not count it twice.
  assert.deepEqual(bm25(["a", "a"], [["a", "b"], ["c"]]), bm25(["a"], [["a", "b"], ["c"]]));
});

test("tokens: Latin words and digit groups lowercased, Han characters as overlapping pairs only when asked", () => {
  assert.deepEqual(precedentTokens("Non-Small Cell Lung Cancer, EGFR T790M; a", { han: false }), ["non-small", "cell", "lung", "cancer", "egfr", "t790m"]);
  assert.deepEqual(precedentTokens("非小细胞肺癌 EGFR"), ["egfr", "非小", "小细", "细胞", "胞肺", "肺癌"]);
  assert.deepEqual(precedentTokens("非小细胞肺癌", { han: false }), []);
  assert.equal(precedentText({ title: "A trial", conditions: ["Asthma"], interventions: ["drug x", { name: "drug y" }] }), "A trial ; Asthma ; drug x ; drug y");
  assert.equal(precedentQueryText({ condition: "asthma", interventions: ["a", "b"], intervention: "c" }), "asthma ; a ; b ; c");
});

const target = { condition: "myocardial infarction", intervention: "aspirin" };
const concepts = { infarction: [1, 0, 0], "heart attack": [1, 0, 0], aspirin: [0, 1, 0], acetylsalicylic: [0, 1, 0], diabetes: [0, 0, 1], metformin: [0, 0, 1] };

test("meaning finds the same trial under other words, and the words keep what they know: the hybrid ranks both above the unrelated", async () => {
  const same = candidate("NCT_SAME", { title: "Aspirin after infarction", conditions: ["Myocardial Infarction"], interventions: ["Aspirin"] }, target);
  const synonym = candidate("NCT_SYN", { title: "Acetylsalicylic acid in heart attack", conditions: ["Heart Attack"], interventions: ["Acetylsalicylic Acid"] }, target);
  const unrelated = candidate("NCT_OFF", { title: "Metformin for diabetes", conditions: ["Diabetes"], interventions: ["Metformin"] }, target);
  const words = await rankPrecedentCandidates({ candidates: [unrelated, synonym, same], target, embedder: null });
  assert.equal(words.ranking.mode, "lexical");
  assert.equal(words.candidates[0].registryId, "NCT_SAME");
  assert.equal(words.candidates[1].registryId, "NCT_OFF", "by words alone the synonym has nothing to match and ties with the unrelated trial at the bottom");
  const hybrid = await rankPrecedentCandidates({ candidates: [unrelated, synonym, same], target, embedder: conceptEmbedder(concepts) });
  assert.deepEqual(hybrid.candidates.map((entry) => entry.registryId), ["NCT_SAME", "NCT_SYN", "NCT_OFF"]);
  assert.equal(hybrid.ranking.mode, "hybrid");
  assert.deepEqual([hybrid.ranking.lexicalWeight, hybrid.ranking.embeddingWeight], [PRECEDENT_FUSION.lexical, PRECEDENT_FUSION.embedding]);
  assert.equal(hybrid.ranking.model, "stub@3");
  assert.equal(hybrid.ranking.fallback, null);
  const [top] = hybrid.candidates;
  assert.ok(top.similarity.parts.bm25 === 1 && top.similarity.parts.embedding > 0.9, JSON.stringify(top.similarity));
  assert.ok(top.similarity.score > hybrid.candidates[1].similarity.score && hybrid.candidates[1].similarity.score > hybrid.candidates[2].similarity.score);
  assert.ok(hybrid.candidates.every((entry) => entry.similarity.score >= 0 && entry.similarity.score <= 1));
});

test("a question with no Latin word is never fused with BM25 at the embedder's weight: the embedder ranks alone, and the weights are never equal", async () => {
  assert.notEqual(PRECEDENT_FUSION.lexical, PRECEDENT_FUSION.embedding);
  assert.equal(PRECEDENT_FUSION.lexical + PRECEDENT_FUSION.embedding, 1);
  assert.ok(PRECEDENT_FUSION.lexical < PRECEDENT_FUSION.embedding);
  const chinese = { condition: "心肌梗死", intervention: "阿司匹林" };
  const embedder = conceptEmbedder({ ...concepts, 心肌梗死: [1, 0, 0], 阿司匹林: [0, 1, 0] });
  const same = candidate("NCT_SAME", { title: "Aspirin after infarction", conditions: ["Myocardial Infarction"], interventions: ["Aspirin"] }, chinese);
  const unrelated = candidate("NCT_OFF", { title: "Metformin for diabetes", conditions: ["Diabetes"], interventions: ["Metformin"] }, chinese);
  const ranked = await rankPrecedentCandidates({ candidates: [unrelated, same], target: chinese, embedder });
  assert.equal(ranked.ranking.mode, "embedding");
  assert.deepEqual([ranked.ranking.lexicalWeight, ranked.ranking.embeddingWeight], [0, 1]);
  assert.equal(ranked.candidates[0].registryId, "NCT_SAME");
  assert.ok(ranked.candidates.every((entry) => entry.similarity.parts.bm25 === 0), "the lexical channel said nothing about English records");
  assert.match(ranked.ranking.note, /没有英文词/);
  // A question that carries English words as well keeps its Chinese for the embedder and gives BM25 only the English.
  const mixed = { condition: "心肌梗死 myocardial infarction", intervention: "aspirin" };
  const both = await rankPrecedentCandidates({ candidates: [unrelated, same], target: mixed, embedder });
  assert.deepEqual([both.ranking.mode, both.ranking.lexicalWeight, both.ranking.embeddingWeight], ["hybrid", 0.4, 0.6]);
});

test("no embedder, or one that fails, is a named fallback to the words: every trial is still returned, in an order that is stated", async () => {
  const a = candidate("NCT_A", { title: "Aspirin after infarction", conditions: ["Myocardial Infarction"], interventions: ["Aspirin"] }, target);
  const b = candidate("NCT_B", { title: "Metformin for diabetes", conditions: ["Diabetes"], interventions: ["Metformin"] }, target);
  const none = await rankPrecedentCandidates({ candidates: [b, a], target, embedder: null });
  assert.deepEqual([none.ranking.mode, none.ranking.fallback, none.ranking.model, none.candidates.length], ["lexical", "embedder_unconfigured", null, 2]);
  assert.match(none.ranking.note, /没有接入/);
  const unconfigured = await rankPrecedentCandidates({ candidates: [b, a], target, embedder: { ...conceptEmbedder(concepts), configured: false } });
  assert.equal(unconfigured.ranking.fallback, "embedder_unconfigured");
  const failing = { configured: true, modelKey: "x@1", async embedDocuments() { throw new Error("unavailable"); } };
  const failed = await rankPrecedentCandidates({ candidates: [b, a], target, embedder: failing });
  assert.deepEqual([failed.ranking.mode, failed.ranking.fallback, failed.candidates.map((entry) => entry.registryId)], ["lexical", "embedder_failed", ["NCT_A", "NCT_B"]]);
  assert.match(failed.ranking.note, /没有答复/);
  const wrongShape = { configured: true, modelKey: "x@2", async embedDocuments() { return []; } };
  assert.equal((await rankPrecedentCandidates({ candidates: [b, a], target, embedder: wrongShape })).ranking.fallback, "embedder_failed");
  // A Chinese question and no embedder: the Han pairs stand in for the words, so Chinese records can still be matched by them.
  const zh = { condition: "肺癌" };
  const chictr = candidate("ChiCTR1", { registry: "chictr", title: "肺癌化疗研究", conditions: ["肺癌"], interventions: ["化疗"] }, zh);
  const english = candidate("NCT_L", { title: "Lung cancer chemotherapy", conditions: ["Lung Cancer"], interventions: ["Chemotherapy"] }, zh);
  const ranked = await rankPrecedentCandidates({ candidates: [english, chictr], target: zh, embedder: null });
  assert.equal(ranked.candidates[0].registryId, "ChiCTR1");
  assert.equal(ranked.ranking.mode, "lexical");
  assert.deepEqual((await rankPrecedentCandidates({ candidates: [], target, embedder: conceptEmbedder(concepts) })).candidates, []);
});

test("whether a record has results is not how like the question it is: it breaks a tie and nothing else", async () => {
  const text = { title: "Aspirin after infarction", conditions: ["Myocardial Infarction"], interventions: ["Aspirin"] };
  const plain = candidate("NCT_1", text, target);
  const withResults = candidate("NCT_2", { ...text, hasResults: true }, target);
  assert.equal(plain.similarity.score, withResults.similarity.score);
  const tied = await rankPrecedentCandidates({ candidates: [plain, withResults], target, embedder: null });
  assert.deepEqual(tied.candidates.map((entry) => entry.registryId), ["NCT_2", "NCT_1"], "results first among equals");
  assert.equal(tied.candidates[0].similarity.score, tied.candidates[1].similarity.score);
  assert.ok(!("hasResults" in tied.candidates[0].similarity.parts));
  // A trial with results that is less like the question does not climb above one that is more like it.
  const off = candidate("NCT_3", { title: "Metformin for diabetes", conditions: ["Diabetes"], interventions: ["Metformin"], hasResults: true }, target);
  const order = await rankPrecedentCandidates({ candidates: [off, plain], target, embedder: null });
  assert.equal(order.candidates[0].registryId, "NCT_1");
  // And the order does not depend on the order the registry answered in.
  const reversed = await rankPrecedentCandidates({ candidates: [withResults, plain], target, embedder: null });
  assert.deepEqual(reversed.candidates.map((entry) => entry.registryId), ["NCT_2", "NCT_1"]);
});

test("a vector is kept per text and model: a repeated search embeds only what it has not seen", async () => {
  const embedder = { ...conceptEmbedder(concepts), modelKey: "cache-test@3" };
  embedder.calls = [];
  const embed = embedder.embedDocuments;
  embedder.embedDocuments = async (/** @type {string[]} */ texts) => { embedder.calls.push([...texts]); return embed.call(embedder, texts); };
  const a = candidate("NCT_A", { title: "Unique title alpha", conditions: ["Myocardial Infarction"], interventions: ["Aspirin"] }, target);
  const b = candidate("NCT_B", { title: "Unique title beta", conditions: ["Diabetes"], interventions: ["Metformin"] }, target);
  await rankPrecedentCandidates({ candidates: [a, b], target, embedder });
  assert.equal(embedder.calls.length, 1);
  assert.equal(embedder.calls[0].length, 3, "the question and the two records");
  await rankPrecedentCandidates({ candidates: [a, b], target, embedder });
  assert.equal(embedder.calls.length, 1, "nothing new to embed");
  const c = candidate("NCT_C", { title: "Unique title gamma", conditions: ["Myocardial Infarction"], interventions: ["Aspirin"] }, target);
  await rankPrecedentCandidates({ candidates: [a, b, c], target, embedder });
  assert.equal(embedder.calls.length, 2);
  assert.equal(embedder.calls[1].length, 1, "only the new record");
  // Another model's vectors are not this model's.
  await rankPrecedentCandidates({ candidates: [a], target, embedder: { ...embedder, modelKey: "other@3", embedDocuments: embedder.embedDocuments } });
  assert.equal(embedder.calls.length, 3);
});

test("findPrecedents ranks what the three registries answered and says how", async () => {
  const hits = [
    { registry: "clinicaltrials.gov", registryId: "NCT_B", title: "Metformin for diabetes", conditions: ["Diabetes"], interventions: ["Metformin"], phases: ["PHASE3"], allocation: "RANDOMIZED", hasResults: true },
    { registry: "clinicaltrials.gov", registryId: "NCT_A", title: "Acetylsalicylic acid in heart attack", conditions: ["Heart Attack"], interventions: ["Acetylsalicylic Acid"], phases: ["PHASE3"], allocation: "RANDOMIZED", hasResults: false },
  ];
  const registry = {
    configured: true,
    async search() { return { status: "ok", items: hits, total: 2 }; },
    async searchChictr() { return { status: "registry_unavailable", reason: "registry_not_configured", items: [] }; },
  };
  const bare = createVcrEvidencePipeline({ store: {}, registry });
  const withWords = await bare.findPrecedents({ userId: "u1", target: { ...target, phases: ["PHASE3"] }, includeCtis: false });
  assert.equal(withWords.ranking.mode, "lexical");
  assert.equal(withWords.ranking.fallback, "embedder_unconfigured");
  assert.equal(withWords.candidates.length, 2);
  const pipeline = createVcrEvidencePipeline({ store: {}, registry });
  pipeline.attachEmbedder(conceptEmbedder(concepts));
  const found = await pipeline.findPrecedents({ userId: "u1", target: { ...target, phases: ["PHASE3"] }, includeCtis: false });
  assert.equal(found.ranking.mode, "hybrid");
  assert.deepEqual(found.candidates.map((entry) => entry.registryId), ["NCT_A", "NCT_B"], "the trial in other words, but of the same thing, outranks the one that has results");
  assert.equal(found.candidates[1].hasResults, true, "results are still shown on the candidate");
  assert.equal(pipeline.counters.valueChecks["precedent_ranking:hybrid"], 1);
  assert.equal(bare.counters.valueChecks["precedent_ranking:lexical_embedder_unconfigured"], 1);
});
