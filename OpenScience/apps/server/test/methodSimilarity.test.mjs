// What a learned method is close to: by the meaning of its text when an embedder answers, by shared words when it does not,
// and the answer says which. The embedder here is a stub that places a text on an axis named in it, so the geometry is exact.
import assert from "node:assert/strict";
import test from "node:test";

import { candidatePairs, createMethodSimilarity, methodText, methodTokens } from "../src/methodSimilarity.mjs";

/** @param {string} id @param {string} description @param {any} [extra] */
const method = (id, description, extra = {}) => ({
  id,
  payload: {
    frontmatter: { name: id.replace("method:learned:", ""), description, whenToUse: "", metadata: {} },
    contentDigest: `sha256:${id.padEnd(64, "0").slice(0, 64)}`,
    ...extra,
  },
});

/** A text "lives" on the axis its `axis-x` marker names; every other axis is a little noise, so two texts on one axis are close, not equal. */
const AXES = ["a", "b", "c", "d"];
/** @param {string} text */
function vectorOf(text) {
  const axis = AXES.findIndex((letter) => text.includes(`axis-${letter}`));
  const noise = [...text].reduce((total, character) => total + character.charCodeAt(0), 0) % 7;
  return AXES.map((_, index) => (index === axis ? 1 : 0.02 * ((noise + index) % 3)));
}

/** @param {{fail?: boolean, malformed?: boolean}} [options] */
function stubEmbedder(options = {}) {
  /** @type {string[][]} */
  const calls = [];
  const embed = async (/** @type {string[]} */ texts) => {
    calls.push(texts);
    if (options.fail) throw Object.assign(new Error("down"), { code: "kb_embedding_unavailable" });
    if (options.malformed) return texts.map(() => [Number.NaN, 1]);
    return texts.map(vectorOf);
  };
  return { embed, calls };
}

const library = () => [
  method("m1", "Resolve a claim to its span. axis-a one"),
  method("m2", "Resolve a claim to its anchor. axis-a two"),
  method("m3", "Count the forest plots. axis-b one"),
  method("m4", "Count the funnel plots. axis-b two"),
  method("m5", "Something else entirely. axis-c one"),
];

test("the pairs of a library are each method's nearest neighbours above the floor, every pair once, best first", async () => {
  const { embed } = stubEmbedder();
  const similarity = createMethodSimilarity({ embed });
  const pairs = await similarity.pairs(library());
  assert.deepEqual(pairs.map((pair) => `${pair.a}>${pair.b}`).sort(), ["m1>m2", "m3>m4"], "m5 is alone on its axis, so it pairs with nobody");
  assert.ok(pairs[0].score >= pairs[1].score, "best first");
  assert.ok(pairs.every((pair) => pair.score >= 0.8 && pair.overlap === pair.score));
  assert.equal(/** @type {any} */ (pairs).mode, "embedding");
  assert.deepEqual(JSON.parse(JSON.stringify(pairs)), pairs.map((pair) => ({ ...pair })), "the mode is not an enumerable key: a plain comparison and a serialisation do not see it");
  assert.deepEqual(Object.keys(pairs), pairs.map((_, index) => String(index)));
});

test("the floor and the per-method bound are the caller's", async () => {
  const similarity = createMethodSimilarity({ embed: stubEmbedder().embed });
  assert.deepEqual(await similarity.pairs(library(), { floor: 1.01 }), [], "no cosine reaches it");
  assert.equal((await similarity.pairs(library(), { floor: 0.99 })).length <= 2, true, "a higher floor keeps a subset of the pairs");
  const crowded = Array.from({ length: 6 }, (_, index) => method(`n${index}`, `Same axis. axis-d ${index}`));
  const bounded = await similarity.pairs(crowded, { topK: 1, floor: 0.5 });
  assert.ok(bounded.length >= 3 && bounded.length <= 6, `six methods, one neighbour each: ${bounded.length} pairs, never the fifteen of all of them`);
  const seen = new Set(bounded.map((pair) => [pair.a, pair.b].join(">")));
  assert.equal(seen.size, bounded.length, "a pair two methods both named is one pair");
  assert.deepEqual(await similarity.pairs([library()[0]]), [], "one method has no pair");
});

test("a vector is kept per method and digest: a second look embeds nothing, an amended body or a new line embeds that method only", async () => {
  const { embed, calls } = stubEmbedder();
  const similarity = createMethodSimilarity({ embed });
  const methods = library();
  await similarity.pairs(methods);
  assert.deepEqual(calls.map((texts) => texts.length), [5]);
  await similarity.pairs(methods);
  assert.equal(calls.length, 1, "every vector was cached");
  assert.equal(similarity.stats().cacheHits, 5);

  const amended = [...methods.slice(0, 2), method("m3", "Count the forest plots. axis-b one", { contentDigest: `sha256:${"f".repeat(64)}` }), ...methods.slice(3)];
  await similarity.pairs(amended);
  assert.deepEqual(calls.map((texts) => texts.length), [5, 1], "a new digest is one new text");

  // The researcher's line is outside the digest: the same digest with a new line is a different text, and a miss.
  const retitled = [...amended.slice(0, 4), { ...amended[4], payload: { ...amended[4].payload, display: { title: "别的做法", summary: "完全不同的另一件事。" } } }];
  await similarity.pairs(retitled);
  assert.deepEqual(calls.map((texts) => texts.length), [5, 1, 1]);
  assert.match(calls[2][0], /别的做法/);

  const small = createMethodSimilarity({ embed, cacheLimit: 2 });
  await small.pairs(library());
  assert.ok(small.stats().cached <= 2, "the cache is bounded and an over-full one does not lose what the call in hand needs");
});

test("the methods nearest a text are the nearest first, bounded, and above a floor when one is asked for", async () => {
  const { embed, calls } = stubEmbedder();
  const similarity = createMethodSimilarity({ embed });
  const found = await similarity.nearest("How do I resolve a span? axis-a request", library(), { limit: 3 });
  assert.deepEqual(found.slice(0, 2).map((entry) => entry.method.id).sort(), ["m1", "m2"]);
  assert.equal(found.length, 3);
  assert.equal(calls.length, 1, "the query and every uncached method in one call");
  assert.equal(calls[0][0].startsWith("How do I resolve"), true);
  assert.equal(/** @type {any} */ (found).mode, "embedding");
  const floored = await similarity.nearest("axis-a request", library(), { limit: 8, minScore: 0.8 });
  assert.deepEqual(floored.map((entry) => entry.method.id).sort(), ["m1", "m2"]);
  assert.deepEqual(await similarity.nearest("   ", library()), []);
  assert.deepEqual(await similarity.nearest("axis-a", []), []);
});

test("without an embedder every answer is the shared-words shortlist, and says it is", async () => {
  const similarity = createMethodSimilarity({ embed: null });
  assert.equal(similarity.available(), false);
  const methods = [
    method("m1", "Resolves a claim to the source span it is bonded to."),
    method("m2", "Resolves a claim to the source span it quotes verbatim."),
    method("m3", "Counts the forest plots a meta analysis produced."),
  ];
  const pairs = await similarity.pairs(methods);
  assert.equal(/** @type {any} */ (pairs).mode, "lexical");
  assert.deepEqual(pairs.map((pair) => [pair.a, pair.b]), candidatePairs(methods).map((pair) => [pair.a, pair.b]));
  assert.ok(pairs.every((pair) => pair.score === pair.overlap && pair.overlap >= 2), "the score is the count of shared words, and the floor is two");
  const near = await similarity.nearest("resolve the source span of a claim", methods);
  assert.equal(/** @type {any} */ (near).mode, "lexical");
  assert.equal(near[0].method.id === "m1" || near[0].method.id === "m2", true);
  assert.ok(!near.some((entry) => entry.method.id === "m3"));
});

test("an embedder that fails costs one request, not one per call: the answer degrades, and the next try waits", async () => {
  let clock = 1_000;
  const { embed, calls } = stubEmbedder({ fail: true });
  /** @type {string[]} */
  const warnings = [];
  const similarity = createMethodSimilarity({ embed, retryAfterMs: 30_000, now: () => clock, logger: { warn: (message) => warnings.push(message) } });
  assert.equal(similarity.available(), true);
  const methods = [method("m1", "Resolves a claim to the source span."), method("m2", "Resolves a claim to the source span it quotes.")];
  const first = await similarity.pairs(methods);
  assert.equal(/** @type {any} */ (first).mode, "lexical");
  assert.equal(first.length, 1, "the lexical shortlist still pairs them");
  assert.equal(similarity.available(), false);
  assert.match(warnings[0], /embedding unavailable.*kb_embedding_unavailable/);
  await similarity.pairs(methods);
  await similarity.nearest("resolve the source span", methods);
  assert.equal(calls.length, 1, "no second request inside the wait");
  clock += 31_000;
  assert.equal(similarity.available(), true);
  await similarity.pairs(methods);
  assert.equal(calls.length, 2, "and one once it has passed");
  assert.equal(similarity.stats().failures, 2);
});

test("an answer that is not a vector per text is the embedder's fault, and the answer degrades", async () => {
  const similarity = createMethodSimilarity({ embed: stubEmbedder({ malformed: true }).embed });
  const pairs = await similarity.pairs([method("m1", "Resolves a claim to the source span."), method("m2", "Resolves a claim to the source span it quotes.")]);
  assert.equal(/** @type {any} */ (pairs).mode, "lexical");
  const short = createMethodSimilarity({ embed: async () => [[1, 0]] });
  assert.equal(/** @type {any} */ (await short.pairs(library())).mode, "lexical", "fewer vectors than texts");
});

test("a method is embedded as what it is called, what it does, when it applies and the line its researcher reads", () => {
  const text = methodText({
    id: "m1",
    payload: {
      frontmatter: { name: "resolve-claim-span", description: "Resolves a claim.", whenToUse: "When a claim needs its span.", metadata: { applies_when: "A ledger exists." } },
      display: { title: "先锚定", summary: "修报告前先对回原文。" },
      body: "never embedded",
    },
  });
  assert.equal(text, "resolve claim span\nResolves a claim.\nWhen a claim needs its span.\nA ledger exists.\n先锚定\n修报告前先对回原文。");
  assert.equal(createMethodSimilarity().methodText, methodText);
  assert.ok(methodText({ id: "x", payload: { frontmatter: { name: "x", description: "y".repeat(5000) } } }).length <= 1200);
  assert.ok(methodTokens("Resolves 风险评估 claims").has("风险"));
});
