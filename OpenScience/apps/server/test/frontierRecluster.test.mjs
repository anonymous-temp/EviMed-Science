// The re-clustering sweep's decisions without a database (c3-cluster 2026-10-25): which events are paired, what the model is shown,
// how its answers are read, which merges and links a set of verdicts asks for, and which pick an event keeps after a merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRONTIER_RECLUSTER,
  FRONTIER_RECLUSTER_INSTRUCTIONS,
  FRONTIER_RECLUSTER_PAIR_INSTRUCTIONS,
  buildReclusterInput,
  buildReclusterPairInput,
  frontierMergeSelection,
  frontierReclusterFeatures,
  frontierReclusterPairKey,
  frontierReclusterPairs,
  frontierReclusterPlan,
  validateReclusterAnswer,
  validateReclusterPair,
} from "../src/frontierRecluster.mjs";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-24T02:00:00Z");
const at = (days) => new Date(T0 + days * DAY).toISOString();

/** An event of the sweep's shape. */
function event(id, title, { first = 0, last = first, keys = [], members = null, digest = null } = {}) {
  return { id: String(id), title, digest, firstAt: at(first), lastAt: at(last), entityKeys: keys,
    members: members ?? [{ id: `${id}-1`, titleZh: title, titleRaw: title, sourceName: `source-${id}`, primary: false, publishedAt: at(first), registryIds: [] }] };
}

test("a pair key is the same whichever event is named first", () => {
  assert.equal(frontierReclusterPairKey(5, 12), frontierReclusterPairKey("12", "5"));
  assert.notEqual(frontierReclusterPairKey(5, 12), frontierReclusterPairKey(5, 13));
});

test("the features an event is compared by: identifiers, trial names, drugs, title words", () => {
  const feature = frontierReclusterFeatures(event(1, "TAK-921 治疗晚期胃癌 3 期试验达到主要终点", {
    keys: ["trial:G-HOPE-001", "drug:Arcotatug Tavatecan", "org:武田", "disease:胃癌"],
    members: [{ id: "m1", titleZh: "TAK-921 治疗晚期胃癌", titleRaw: "TAK-921 in gastric cancer", doi: "10.1000/ABC", pmid: "123", registryIds: ["nct01234567"] }] }));
  assert.deepEqual([...feature.trials], ["g-hope-001"]);
  assert.deepEqual([...feature.drugs], ["arcotatug tavatecan"]);
  assert.deepEqual([...feature.registry], ["NCT01234567"]);
  assert.deepEqual([...feature.works].sort(), ["doi:10.1000/abc", "pmid:123"]);
  assert.ok(feature.titles.length >= 2);
});

test("candidates: a shared trial name, registry id or DOI makes a pair; a shared popular drug alone does not", () => {
  const a = event(1, "A readout", { keys: ["trial:alpha-1", "drug:pembrolizumab"] });
  const b = event(2, "Another readout", { first: 1, keys: ["trial:alpha-1"] });
  const c = event(3, "Unrelated", { first: 1, keys: ["drug:pembrolizumab"] });
  const d = event(4, "Registered", { first: 1, members: [{ id: "d1", titleZh: "x", registryIds: ["NCT00000001"], publishedAt: at(1) }] });
  const e = event(5, "Registered too", { first: 1, members: [{ id: "e1", titleZh: "y", registryIds: ["NCT00000001"], publishedAt: at(1) }] });
  const f = event(6, "Same work", { first: 1, members: [{ id: "f1", titleZh: "z", doi: "10.1/x", publishedAt: at(1) }] });
  const g = event(7, "Same work again", { first: 1, members: [{ id: "g1", titleZh: "w", doi: "10.1/X", publishedAt: at(1) }] });
  const crowd = Array.from({ length: 8 }, (_, index) => event(100 + index, `Crowd ${index}`, { first: 1, keys: ["drug:pembrolizumab"] }));
  const { pairs } = frontierReclusterPairs({ anchors: [a, d, f], pool: [a, b, c, d, e, f, g, ...crowd] });
  const named = pairs.map((pair) => `${pair.a.id}-${pair.b.id}`).sort();
  assert.deepEqual(named, ["1-2", "4-5", "6-7"]);
  const byId = Object.fromEntries(pairs.map((pair) => [`${pair.a.id}-${pair.b.id}`, pair]));
  assert.equal(byId["4-5"].score, 1);
  assert.equal(byId["6-7"].score, 1);
  assert.equal(byId["1-2"].score, 0.95);
  assert.deepEqual(byId["1-2"].signals.trials, ["alpha-1"]);
});

test("candidates: a drug few events carry needs some similarity of the titles or vectors, and a vector alone is enough from 0.7", () => {
  const a = event(1, "Atacicept 3期试验最终分析减缓IgA肾病eGFR下降", { keys: ["drug:atacicept"] });
  const b = event(2, "Coverage of a financing round", { first: 1, keys: ["drug:atacicept"] });
  const c = event(3, "Atacicept 价格", { first: 1, keys: ["drug:atacicept"] });
  const noKeys = event(4, "Totally different words", { first: 1 });
  const cosines = new Map([[frontierReclusterPairKey(1, 3), 0.62], [frontierReclusterPairKey(1, 4), 0.69]]);
  const found = frontierReclusterPairs({ anchors: [a], pool: [a, b, c, noKeys], cosines, vectors: new Set(["1", "2", "3", "4"]) });
  assert.deepEqual(found.pairs.map((pair) => pair.b.id).sort(), ["3"], "the drug with a 0.62 cosine is a pair; the drug with no similarity is not; 0.69 alone is not; the title words do not stand in where vectors exist");
  const lexical = frontierReclusterPairs({ anchors: [a], pool: [a, event(5, "Atacicept 3期试验最终分析的IgA肾病eGFR下降结果", { first: 1, keys: ["drug:atacicept"] })] });
  assert.equal(lexical.pairs.length, 1, "a shared drug and similar titles make a pair without any vector");
  const more = frontierReclusterPairs({ anchors: [a], pool: [a, noKeys], cosines: new Map([[frontierReclusterPairKey(1, 4), 0.7]]), vectors: new Set(["1", "4"]) });
  assert.equal(more.pairs.length, 1);
  assert.equal(more.pairs[0].signals.cosine, 0.7);
});

test("candidates: title words stand in for vectors only for an event that has none, and only for titles with enough words", () => {
  const long = "刚果埃博拉疫情扩散至第八个省并出现输入病例的报道";
  const a = event(1, long);
  const b = event(2, long, { first: 1 });
  const short = event(3, "埃博拉疫情", { first: 1 });
  assert.equal(frontierReclusterPairs({ anchors: [a], pool: [a, b, short] }).pairs.length, 1, "no vectors anywhere: the words decide, a short title is contained in any long one and decides nothing");
  assert.equal(frontierReclusterPairs({ anchors: [a], pool: [a, b], vectors: new Set(["1", "2"]) }).pairs.length, 0, "both have vectors, and the vectors did not meet");
  assert.equal(frontierReclusterPairs({ anchors: [a], pool: [a, b], vectors: new Set(["1"]) }).pairs.length, 1, "one of them has none");
});

test("candidates: the window, the existing link, the older event first, a pair of two anchors once, the cap and the anchors it cuts off", () => {
  const keys = ["trial:t-1"];
  const a = event(1, "A", { first: 0, keys });
  const b = event(2, "B", { first: 2, keys });
  const late = event(3, "Late", { first: 12, keys });
  const linkedEvent = event(4, "Linked", { first: 1, keys });
  const linked = new Set([frontierReclusterPairKey(1, 4)]);
  const both = frontierReclusterPairs({ anchors: [a, b], pool: [a, b, late, linkedEvent], linked });
  assert.deepEqual(both.pairs.map((pair) => `${pair.a.id}-${pair.b.id}`).sort(), ["1-2", "4-2"], "(4, 2): the older event is A");
  assert.ok(both.pairs.every((pair) => pair.a.firstAt <= pair.b.firstAt), "the older event is A");
  assert.ok(!both.pairs.some((pair) => [pair.a.id, pair.b.id].includes("3")), "twelve days apart is outside the window");
  assert.ok(!both.pairs.some((pair) => [pair.a.id, pair.b.id].includes("1") && [pair.a.id, pair.b.id].includes("4")), "a linked pair is not asked again");
  const cap = frontierReclusterPairs({ anchors: [a, b], pool: [a, b, linkedEvent], max: 1 });
  assert.equal(cap.pairs.length, 1);
  assert.equal(cap.candidates, 3);
  assert.ok(cap.truncated.size >= 1, "an anchor with a pair beyond the cap is not to be called checked");
});

test("the batch call shows both events, their dates in the feed's zone, and the reports that read like the other event's first", () => {
  const shared = "详细数据确认Moderna与默沙东癌症疫苗在黑色素瘤试验中达到关键终点";
  const many = Array.from({ length: 14 }, (_, index) => ({ id: `a${index}`, titleZh: `无关报道 ${index} 号`, titleRaw: `unrelated report ${index}`, sourceName: "s", publishedAt: at(0), registryIds: [] }));
  const a = event(1, "Vaccine readout", { members: [...many, { id: "a-shared", titleZh: shared, titleRaw: "x", sourceName: "STAT", publishedAt: at(0.5), registryIds: [] }] });
  const b = event(2, "Leak", { first: 1, members: [{ id: "b1", titleZh: shared, titleRaw: "y", sourceName: "BioPharma", publishedAt: at(1), registryIds: [] }] });
  const input = buildReclusterInput([{ a, b }]);
  assert.match(input, /配对 P1/);
  assert.match(input, /事件 A/);
  assert.match(input, /事件 B/);
  assert.match(input, /2026-10-24 至 2026-10-24|2026-10-24 至 2026-10-25/);
  assert.ok(input.includes(shared), "the report both events hold is shown for A even among fifteen");
  assert.match(input, /另有 \d+ 篇报道未列出/);
  assert.equal(input.split("\n- ").length - 1 <= FRONTIER_RECLUSTER.shown + 1 + 2, true);
  const second = buildReclusterPairInput({ a: { ...a, digest: "A 概览" }, b }, {});
  assert.match(second, /事件概览：A 概览/);
  assert.match(FRONTIER_RECLUSTER_INSTRUCTIONS, /SAME.*RELATED.*DIFFERENT/s);
  assert.match(FRONTIER_RECLUSTER_PAIR_INSTRUCTIONS, /"relation":"SAME\|RELATED\|DIFFERENT"/);
});

test("a batch answer is read pair by pair: a pair it does not address once with a known relation is unjudged, not different", () => {
  const read = validateReclusterAnswer(4, { pairs: [
    { id: "P1", relation: "same", confidence: 0.9, reason: "同一次发生" },
    { id: "p2", relation: "RELATED", confidence: "0.4", reason: "后续" },
    { id: "P3", relation: "MAYBE", confidence: 1 },
    { id: "P9", relation: "SAME" },
  ] });
  assert.equal(read[0].relation, "SAME");
  assert.equal(read[0].confidence, 0.9);
  assert.equal(read[1].relation, "RELATED");
  assert.equal(read[1].confidence, 0.4);
  assert.equal(read[2], null, "an unknown relation");
  assert.equal(read[3], null, "never addressed");
  const doubled = validateReclusterAnswer(2, { pairs: [{ id: "P1", relation: "SAME" }, { id: "P1", relation: "DIFFERENT" }, { id: "P2", relation: "DIFFERENT" }] });
  assert.equal(doubled[0], null, "an id answered twice is no answer");
  assert.equal(doubled[1].relation, "DIFFERENT");
  assert.equal(validateReclusterAnswer(2, null), null);
  assert.equal(validateReclusterAnswer(2, { pairs: "no" }), null);
  assert.equal(validateReclusterPair({ relation: "same", confidence: 2, difference: "…" }).confidence, 1);
  assert.equal(validateReclusterPair({ relation: "who knows" }), null);
});

test("the plan: confirmed SAME merges into the older event; an unconfirmed one, a RELATED and a DIFFERENT merge nothing", () => {
  const a = { id: "1", firstAt: at(0) };
  const b = { id: "2", firstAt: at(1) };
  const c = { id: "3", firstAt: at(2) };
  const d = { id: "4", firstAt: at(3) };
  const plan = frontierReclusterPlan([
    { a, b, relation: "SAME", confirmed: true, confidence: 0.9 },
    { a: b, b: c, relation: "SAME", confirmed: undefined, confidence: 0.9 },
    { a: c, b: d, relation: "RELATED" },
    { a, b: d, relation: "DIFFERENT" },
  ]);
  assert.deepEqual(plan.merges, [{ survivor: "1", absorbed: ["2"] }]);
  assert.deepEqual(plan.links, [{ from: "3", to: "4" }], "a RELATED pair whose events stay apart is a link, older to newer");
});

test("the plan: a chain of confirmed SAMEs is one group, the oldest survives; a verdict against the join vetoes it", () => {
  const events = ["1", "2", "3", "4"].map((id, index) => ({ id, firstAt: at(index) }));
  const [a, b, c, d] = events;
  const chain = frontierReclusterPlan([
    { a: b, b: c, relation: "SAME", confirmed: true, confidence: 0.8 },
    { a, b, relation: "SAME", confirmed: true, confidence: 0.9 },
    { a: c, b: d, relation: "SAME", confirmed: true, confidence: 0.7 },
  ]);
  assert.deepEqual(chain.merges, [{ survivor: "1", absorbed: ["2", "3", "4"] }]);
  const vetoed = frontierReclusterPlan([
    { a, b, relation: "SAME", confirmed: true, confidence: 0.9 },
    { a: b, b: c, relation: "SAME", confirmed: true, confidence: 0.8 },
    { a, b: c, relation: "DIFFERENT" },
  ]);
  assert.deepEqual(vetoed.merges, [{ survivor: "1", absorbed: ["2"] }], "A=B and B=C would join A and C against a call that said they differ");
  assert.equal(vetoed.vetoed, 1);
  const secondLookSaidNo = frontierReclusterPlan([
    { a, b, relation: "SAME", confirmed: true, confidence: 0.9 },
    { a: b, b: c, relation: "SAME", confirmed: true, confidence: 0.8 },
    { a, b: c, relation: "SAME", confirmed: false, confidence: 0.95 },
  ]);
  assert.deepEqual(secondLookSaidNo.merges, [{ survivor: "1", absorbed: ["2"] }], "a SAME the second look refused counts against the join as much as a RELATED");
});

test("the plan: a RELATED verdict also vetoes a join through a chain, and stays a link; the valve caps the merges of a run", () => {
  const events = ["1", "2", "3", "4", "5", "6"].map((id, index) => ({ id, firstAt: at(index) }));
  const [a, b, c, d, e, f] = events;
  const inside = frontierReclusterPlan([
    { a, b, relation: "SAME", confirmed: true, confidence: 0.9 },
    { a: b, b: c, relation: "SAME", confirmed: true, confidence: 0.8 },
    { a, b: c, relation: "RELATED" },
  ]);
  assert.deepEqual(inside.merges, [{ survivor: "1", absorbed: ["2"] }]);
  assert.deepEqual(inside.links, [{ from: "1", to: "3" }], "A and C were judged related, so they stay two events with a link between them");
  const capped = frontierReclusterPlan([
    { a, b, relation: "SAME", confirmed: true, confidence: 0.9 },
    { a: c, b: d, relation: "SAME", confirmed: true, confidence: 0.8 },
    { a: e, b: f, relation: "SAME", confirmed: true, confidence: 0.7 },
  ], { maxMerges: 2 });
  assert.equal(capped.merges.length, 2);
  assert.equal(capped.capped, 1);
  assert.ok(capped.merges.some((merge) => merge.survivor === "1") && capped.merges.some((merge) => merge.survivor === "3"), "the most confident merges stand");
});

const pick = (id, genre, extra = {}) => ({ id, genre, zh: false, selected: true, rule: "genre-floor", safety: false, score: 60, ...extra });

test("one pick an event keeps after a merge: its paper first, then the higher score, a Chinese report, the lower id", () => {
  assert.deepEqual(frontierMergeSelection([pick("1", "conference", { score: 70 }), pick("2", "conference", { score: 62 })]),
    { keepId: "1", unselect: [{ id: "2", namedId: "1" }] });
  assert.deepEqual(frontierMergeSelection([pick("1", "conference", { score: 90 }), pick("2", "paper", { score: 60, rule: "threshold" })]),
    { keepId: "2", unselect: [{ id: "1", namedId: "2" }] }, "the paper beats a higher-scored report");
  assert.deepEqual(frontierMergeSelection([pick("3", "news", { score: 50 }), pick("2", "news", { score: 50, zh: true })]),
    { keepId: "2", unselect: [{ id: "3", namedId: "2" }] }, "equal scores: the Chinese report");
  assert.deepEqual(frontierMergeSelection([pick("4", "news", { score: 50 }), pick("3", "news", { score: 50 })]),
    { keepId: "3", unselect: [{ id: "4", namedId: "3" }] }, "then the lower id");
  assert.deepEqual(frontierMergeSelection([pick("1", "paper"), pick("2", "news", { selected: false })]), { keepId: "1", unselect: [] });
  assert.deepEqual(frontierMergeSelection([pick("1", "paper", { selected: false })]), { keepId: null, unselect: [] });
});

test("the exceptions: a safety alert, an operator's pin and a rule that is no arithmetic one stay; a Chinese 解读 stands beside a selected paper", () => {
  const safety = frontierMergeSelection([pick("1", "safety", { safety: true, rule: "safety-bypass", score: null }), pick("2", "paper", { rule: "threshold", score: 80 })]);
  assert.deepEqual(safety, { keepId: "1", unselect: [{ id: "2", namedId: "1" }] }, "a safety alert is the event's pick, and the arithmetic pick beside it leaves");
  const pinned = frontierMergeSelection([pick("1", "news", { rule: "operator-pin" }), pick("2", "news", { score: 99 })]);
  assert.deepEqual(pinned, { keepId: "1", unselect: [{ id: "2", namedId: "1" }] });
  const bothProtected = frontierMergeSelection([pick("1", "safety", { safety: true, rule: "threshold" }), pick("2", "safety", { safety: true, rule: "safety-bypass" })]);
  assert.deepEqual(bothProtected.unselect, [], "two safety alerts of one recall both stay");
  const beside = frontierMergeSelection([pick("1", "paper", { rule: "threshold", score: 70 }), pick("2", "commentary", { zh: true, score: 55 }), pick("3", "conference", { score: 52 })]);
  assert.equal(beside.keepId, "1");
  assert.deepEqual(beside.unselect, [{ id: "3", namedId: "1" }], "the Chinese 解读 of the selected paper stays, the English report leaves");
  const noPaper = frontierMergeSelection([pick("1", "commentary", { zh: true, score: 70 }), pick("2", "commentary", { zh: true, score: 60 })]);
  assert.deepEqual(noPaper.unselect, [{ id: "2", namedId: "1" }], "with no paper there is nothing for a 解读 to stand beside");
});
