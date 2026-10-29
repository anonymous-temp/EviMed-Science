// The topic zones' membership, without a database: how the recall's legs add up, the excluded names, what the judge is shown and
// how its answer is held to the batch, the checks of 「最新进展」, when it is due, the order of its material, and the stats arithmetic.
import assert from "node:assert/strict";
import test from "node:test";
import { EVIDENCE_ZONE_GUIDANCE, normalizeEvidenceZoneDefinition } from "@evimed/domain";
import {
  EVIDENCE_ZONE_JUDGE_INSTRUCTIONS,
  EVIDENCE_ZONE_PROGRESS_INSTRUCTIONS,
  EvidenceZoneMembership,
  ZONE_JUDGE,
  ZONE_RECALL,
  buildZoneJudgeInput,
  buildZoneProgressInput,
  orderZoneMaterial,
  shapeZoneStats,
  verifyZoneJudgements,
  verifyZoneProgress,
  zoneProgressBasis,
  zoneProgressDue,
  zoneRecallVerdict,
  zoneWordsHitStands,
} from "../src/evidenceZoneMembership.mjs";

const leg = (/** @type {Partial<{tag: boolean, entity: boolean, words: boolean}>} */ found = {}) => ({ tag: false, entity: false, words: false, ...found });

test("a candidate hits every keyword; all but one is enough only with the vector near and two keywords at least", () => {
  assert.deepEqual(zoneRecallVerdict([leg({ tag: true }), leg({ words: true })], null),
    { candidate: true, via: "tag", partial: false, wordsOnly: true, weak: 1 }, "the strongest leg that offered it, and a keyword that hit by words alone");
  assert.equal(zoneRecallVerdict([leg({ entity: true }), leg({ entity: true })], null).via, "entity");
  assert.equal(zoneRecallVerdict([leg({ words: true }), leg({ words: true })], null).via, "words");
  assert.equal(zoneRecallVerdict([leg({ tag: true }), leg()], null).candidate, false, "one keyword missing and no vector");
  assert.equal(zoneRecallVerdict([leg({ tag: true }), leg()], ZONE_RECALL.nearCosine - 0.01).candidate, false, "the vector is not near enough");
  assert.deepEqual(zoneRecallVerdict([leg({ tag: true }), leg()], ZONE_RECALL.nearCosine),
    { candidate: true, via: "tag", partial: true, wordsOnly: false, weak: 0 }, "the vector completes it; the keyword leg is still the strongest");
  assert.equal(zoneRecallVerdict([leg({ words: true }), leg()], 0.9).via, "words");
  assert.equal(zoneRecallVerdict([leg(), leg(), leg({ tag: true })], 0.99).candidate, false, "two keywords missing is not rescued by any cosine");
  assert.equal(zoneRecallVerdict([leg()], 0.99).candidate, false, "a one-keyword zone is not widened by the all-but-one rule");
  assert.equal(zoneRecallVerdict([leg({ tag: true })], null).candidate, true);
  assert.equal(zoneRecallVerdict([], 0.9).candidate, false);
});

test("an excluded name takes a keyword's words-only hit away when nothing else of the keyword is in the text", () => {
  const terms = ["乳腺癌", "breast cancer"];
  const excluded = ["乳腺癌耐药蛋白", "BCRP"];
  assert.equal(zoneWordsHitStands(terms, excluded, "乳腺癌耐药蛋白（BCRP）在药物外排中的作用"), false);
  assert.equal(zoneWordsHitStands(terms, excluded, "乳腺癌耐药蛋白抑制剂用于乳腺癌患者的研究"), true, "the keyword is also there on its own");
  assert.equal(zoneWordsHitStands(terms, excluded, "Breast cancer outcomes with trastuzumab"), true, "no excluded name in the text: untouched");
  assert.equal(zoneWordsHitStands(terms, excluded, "BCRP expression and Breast Cancer subtypes"), true);
  assert.equal(zoneWordsHitStands(terms, [], "乳腺癌耐药蛋白"), true, "a zone with no excluded names never takes a hit away");
  assert.equal(zoneWordsHitStands(terms, ["乳腺癌耐药蛋白"], "乳腺癌耐药蛋白、乳腺癌耐药蛋白"), false, "every occurrence is taken out");
});

/** @param {Record<string, any>} [overrides] */
function definition(overrides = {}) {
  const { definition: normalized, issues } = normalizeEvidenceZoneDefinition({
    type: "drug-indication",
    keywords: [{ label: "GLP-1 受体激动剂", terms: ["司美格鲁肽", "替尔泊肽"] }, { label: "减重", terms: ["肥胖", "体重管理"] }],
    perspective: "efficacy", scope: "GLP-1 类药物用于减重的疗效研究、指南与监管动态", include: "纳入减重适应症的研究", exclude: "不含只讲降糖的研究",
    excludeTerms: ["乳腺癌耐药蛋白"], specialties: ["endocrinology"], group: "肥胖", seeds: { positive: ["p1"], negative: ["n1"] }, ...overrides,
  });
  assert.deepEqual(issues, []);
  return /** @type {any} */ (normalized);
}

test("the judge is shown the zones with their keywords and examples, and each item with its candidate zones", () => {
  const input = buildZoneJudgeInput(
    [{ label: "Z1", id: "ez_1", title: "GLP-1 受体激动剂减重", definition: definition(), positive: ["司美格鲁肽减重 68 周"], negative: ["GLP-1 与阿尔茨海默病"] },
      { label: "Z2", id: "ez_2", title: "SGLT2 抑制剂心肾保护", definition: definition({ perspective: null, excludeTerms: [], seeds: {} }), positive: [], negative: [] }],
    [{ n: 1, role: "研究", date: "2026-10-27", source: "NEJM", title: "司美格鲁肽用于肥胖", lead: "随机对照试验，体重下降 15%。", entities: ["司美格鲁肽"], tags: ["肥胖"], zones: ["Z1", "Z2"], note: "读者认为这条不属于这个专区。" }]);
  for (const part of ["【专区】", "Z1｜GLP-1 受体激动剂减重", "① GLP-1 受体激动剂（司美格鲁肽、替尔泊肽）", "② 减重（肥胖、体重管理）", "视角：efficacy",
    "不算的名称：乳腺癌耐药蛋白", "算的例子：「司美格鲁肽减重 68 周」", "不算的例子：「GLP-1 与阿尔茨海默病」", "Z2｜SGLT2 抑制剂心肾保护", "【条目】",
    "[1] 研究｜2026-10-27｜NEJM｜司美格鲁肽用于肥胖", "导读：随机对照试验，体重下降 15%。", "实体：司美格鲁肽；标签：肥胖", "候选专区：Z1、Z2", "读者提示：读者认为这条不属于这个专区。"]) {
    assert.ok(input.includes(part), `the input has ${part}`);
  }
  assert.ok(!/不算的名称：.*\nZ2/.test(input.split("Z2｜")[1] ?? ""), "a zone without excluded names has no such line");
});

test("the instructions carry the owner's guidance and name the block 「最新进展」", () => {
  assert.ok(EVIDENCE_ZONE_JUDGE_INSTRUCTIONS.includes(`${EVIDENCE_ZONE_GUIDANCE.keywordsMin} 到 ${EVIDENCE_ZONE_GUIDANCE.keywordsMax} 个关键词`));
  assert.ok(EVIDENCE_ZONE_JUDGE_INSTRUCTIONS.includes(`${EVIDENCE_ZONE_GUIDANCE.perWeekLow} 到 ${EVIDENCE_ZONE_GUIDANCE.perWeekHigh} 条动态`));
  assert.ok(EVIDENCE_ZONE_JUDGE_INSTRUCTIONS.includes("core|related|out"));
  assert.ok(EVIDENCE_ZONE_PROGRESS_INSTRUCTIONS.includes("最新进展"));
  assert.ok(!EVIDENCE_ZONE_PROGRESS_INSTRUCTIONS.includes("AI 近况"));
  assert.ok(EVIDENCE_ZONE_PROGRESS_INSTRUCTIONS.includes("不写证据强、弱、确定、不确定"), "no wording about the strength of evidence");
  assert.ok(!/\bAI\b/.test(EVIDENCE_ZONE_PROGRESS_INSTRUCTIONS.split("\n")[0]), "no AI in the block's voice");
  // Found by the live check (2026-10-29): the date a model is shown is the platform's, and it wrote it as the approval's; it joined two
  // items with 「同期」; it opened with a sentence that had no mark.
  assert.ok(EVIDENCE_ZONE_PROGRESS_INSTRUCTIONS.includes("平台收录的日期") && EVIDENCE_ZONE_PROGRESS_INSTRUCTIONS.includes("同期") && EVIDENCE_ZONE_PROGRESS_INSTRUCTIONS.includes("没有编号的开场白"));
  assert.ok(EVIDENCE_ZONE_JUDGE_INSTRUCTIONS.includes("研究人群或背景"), "a keyword that is only the population does not make an item core");
});

const BATCH = [
  { n: 1, zones: [{ label: "Z1", id: "ez_aaaa" }, { label: "Z2", id: "ez_bbbb" }] },
  { n: 2, zones: [{ label: "Z1", id: "ez_aaaa" }] },
];

test("the judge's answer keeps only a closed verdict for a pair that was asked; the first answer for a pair stands", () => {
  const checked = verifyZoneJudgements({ judgements: [
    { item: 1, zone: "Z1", verdict: "core" },
    { item: 1, zone: "ez_bbbb", verdict: "RELATED" },
    { item: 2, zone: "Z1", verdict: "out" },
    { item: 2, zone: "Z2", verdict: "core" },        // zone not asked for this item
    { item: 3, zone: "Z1", verdict: "core" },        // item not in the batch
    { item: 1, zone: "Z9", verdict: "core" },        // unknown zone
    { item: 2, zone: "Z1", verdict: "core" },        // second answer for a pair
    { item: 1, zone: "Z1", verdict: "definitely" },  // not in the closed list
    { item: "1", zone: "z2", verdict: "out" },       // the same pair as the second line
    null,
  ] }, BATCH);
  assert.equal(checked.malformed, false);
  assert.deepEqual(checked.verdicts, [
    { n: 1, zoneId: "ez_aaaa", verdict: "core" },
    { n: 1, zoneId: "ez_bbbb", verdict: "related" },
    { n: 2, zoneId: "ez_aaaa", verdict: "out" },
  ]);
  assert.equal(checked.ignored, 7);
  for (const answer of [null, {}, { judgements: "core" }, "core", { judgement: [] }]) {
    assert.equal(verifyZoneJudgements(answer, BATCH).malformed, true, JSON.stringify(answer));
  }
  assert.deepEqual(verifyZoneJudgements({ judgements: [] }, BATCH), { verdicts: [], ignored: 0, malformed: false }, "an empty list is readable; it decides nothing");
});

/** @param {number} n @param {string} [title] */
const ref = (n, title = `标题 ${n}`) => ({ n, itemId: `item${n}`, role: "研究", date: "2026-10-27", sourceName: "NEJM", title, summary: `导读 ${n}：纳入 68 周，体重下降 15%。` });
const LONG = "司美格鲁肽在肥胖成人中的 68 周随机对照试验显示体重下降 15%[1]。口服剂型的 3 期研究报告了相近的体重变化，并给出了停药后的随访结果[2]。监管机构更新了该类药物的标签，补充了胃肠道不良反应的描述[3]。另有一项队列研究分析了真实世界中的使用情况，纳入 68 周的随访数据[1]。";

test("a 「最新进展」 passes when every mark is a shown item, the numbers are in the material and it is one paragraph", () => {
  const refs = [ref(1), ref(2), ref(3)];
  const input = buildZoneProgressInput({ title: "GLP-1 受体激动剂减重", scope: "减重疗效" }, refs);
  assert.ok(input.includes("【专区】GLP-1 受体激动剂减重") && input.includes("[1] 研究｜2026-10-27｜NEJM｜标题 1") && input.includes("导读：导读 1"));
  const ok = verifyZoneProgress({ overview_zh: LONG }, input, refs);
  assert.deepEqual(ok.issues, [], ok.issues.join("；"));
  assert.deepEqual(ok.cited.sort(), [1, 2, 3]);
  assert.equal(ok.output.overview_zh, LONG);
  // A mark that was not shown, no mark at all, a number the material does not have, two paragraphs, a link, too short.
  assert.ok(verifyZoneProgress({ overview_zh: LONG.replace("[3]", "[7]") }, input, refs).issues.some((issue) => issue.includes("[7]")));
  assert.ok(verifyZoneProgress({ overview_zh: LONG.replace(/\[\d\]/g, "") }, input, refs).issues.some((issue) => issue.includes("没有标注")));
  assert.ok(verifyZoneProgress({ overview_zh: LONG.replace("15%", "99%") }, input, refs).issues.some((issue) => issue.includes("99")));
  assert.ok(verifyZoneProgress({ overview_zh: `${LONG}\n${LONG}` }, input, refs).issues.length > 0);
  assert.ok(verifyZoneProgress({ overview_zh: `${LONG} https://example.org` }, input, refs).issues.length > 0);
  assert.ok(verifyZoneProgress({ overview_zh: "体重下降 15%[1]。" }, input, refs).issues.some((issue) => issue.includes("太短")));
  // Empty is a valid answer: no block.
  const empty = verifyZoneProgress({ overview_zh: "" }, input, refs);
  assert.deepEqual(empty.issues, []);
  assert.equal(empty.output.overview_zh, null);
});

test("the basis of a paragraph is its material, whatever the order", () => {
  assert.equal(zoneProgressBasis([ref(1), ref(2)]), zoneProgressBasis([ref(2), ref(1)]));
  assert.notEqual(zoneProgressBasis([ref(1), ref(2)]), zoneProgressBasis([ref(1), ref(3)]));
});

test("a 「最新进展」 is due when never written, when the material changed a day on, or when a key update came six hours on", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  const ago = (/** @type {number} */ hours) => new Date(now.getTime() - hours * 3_600_000);
  const written = (/** @type {string} */ basis) => ({ basis });
  assert.equal(zoneProgressDue({ coreCount: 2, basis: "b", overview: null, overviewAt: null, newestKeyAt: null, now }), false, "under three core items");
  assert.equal(zoneProgressDue({ coreCount: 3, basis: "b", overview: null, overviewAt: null, newestKeyAt: null, now }), true, "never written");
  assert.equal(zoneProgressDue({ coreCount: 3, basis: "b", overview: written("b"), overviewAt: ago(30), newestKeyAt: null, now }), false, "same material");
  assert.equal(zoneProgressDue({ coreCount: 3, basis: "c", overview: written("b"), overviewAt: ago(19), newestKeyAt: null, now }), false, "changed, but written 19 hours ago");
  assert.equal(zoneProgressDue({ coreCount: 3, basis: "c", overview: written("b"), overviewAt: ago(21), newestKeyAt: null, now }), true, "changed, written 21 hours ago");
  assert.equal(zoneProgressDue({ coreCount: 3, basis: "b", overview: written("b"), overviewAt: ago(5), newestKeyAt: ago(1), now }), false, "key update, written 5 hours ago");
  assert.equal(zoneProgressDue({ coreCount: 3, basis: "b", overview: written("b"), overviewAt: ago(7), newestKeyAt: ago(1), now }), true, "key update newer than a paragraph 7 hours old");
  assert.equal(zoneProgressDue({ coreCount: 3, basis: "b", overview: written("b"), overviewAt: ago(7), newestKeyAt: ago(8), now }), false, "the key update is older than the paragraph");
  assert.equal(zoneProgressDue({ coreCount: 4, basis: "b", overview: { basis: "b" }, overviewAt: null, newestKeyAt: null, now }), true, "taken down: no time stamp, written again");
});

test("the material puts key updates first, then selected, then the score, one item per event, at most thirty", () => {
  const row = (/** @type {number} */ id, /** @type {Record<string, any>} */ more = {}) => ({ id, event_id: null, genre: "paper", practice_changing: false, safety_alert: false, flags: [], selected: false,
    score_total: 50, visible_at: `2026-10-2${id % 9}T08:00:00Z`, ...more });
  const ordered = orderZoneMaterial([
    row(1, { score_total: 90 }),
    row(2, { genre: "guideline", score_total: 10 }),
    row(3, { selected: true, score_total: 40 }),
    row(4, { event_id: 7, score_total: 60 }),
    row(5, { event_id: 7, score_total: 70 }),
    row(6, { flags: ["corrected"], score_total: 5 }),
    row(7, { practice_changing: true, score_total: 1 }),
  ]).map(({ row: item, key }) => [item.id, key]);
  assert.deepEqual(ordered.map(([id]) => id), [2, 6, 7, 3, 1, 5], "key updates first (guideline, correction, practice-changing, by date), then selected, then the best of an event once");
  assert.deepEqual(ordered.map(([, key]) => key), [true, true, true, false, false, false]);
  const many = Array.from({ length: 60 }, (_, index) => row(index + 1));
  assert.equal(orderZoneMaterial(many).length, 30);
});

test("the stats count events by window and divide the last 28 days by four", () => {
  assert.deepEqual(shapeZoneStats({ all_count: 120, week: 9, month: 41, d28: 38, roles: { research: 30, guideline: 2 },
    latest: { public_id: "abc", title: "最新一条", visible_at: "2026-10-28T08:00:00Z" }, key_latest: null }),
  { week: 9, month: 41, all: 120, perWeek: 9.5, roleCounts30: { research: 30, guideline: 2 }, latest: { itemId: "abc", title: "最新一条", at: "2026-10-28T08:00:00.000Z" }, keyLatest: null, cards: 0 });
  assert.deepEqual(shapeZoneStats({}), { week: 0, month: 0, all: 0, perWeek: 0, roleCounts30: {}, latest: null, keyLatest: null, cards: 0 });
  assert.equal(shapeZoneStats({ d28: 5 }).perWeek, 1.3, "one decimal");
});

test("the batching limits are the ones the brief names", () => {
  assert.equal(ZONE_JUDGE.itemsPerCall, 10);
  assert.equal(ZONE_JUDGE.zonesPerItem, 8);
  assert.equal(ZONE_JUDGE.maxAttempts, 3);
});

test("a switched-off module does nothing on a tick, and a database is required", async () => {
  assert.throws(() => new EvidenceZoneMembership({ database: null }), TypeError);
  const calls = [];
  const membership = new EvidenceZoneMembership({ database: { query: async (/** @type {string} */ text) => { calls.push(text); return { rows: [] }; }, transaction: async () => { calls.push("tx"); } },
    config: { evidenceZoneTopicsEnabled: false } });
  assert.equal(membership.enabled, false);
  const result = await membership.tick(new Date());
  assert.deepEqual(result.parts, { skipped: "disabled" });
  assert.deepEqual(calls, []);
  assert.equal(membership.status().counters.ticks, 1);
});
