// Study facts and the faithfulness check (c3-faith, 2026-10-25): quotations code finds, the closed comparison, the source
// confirming each suspicion, the repair -> removal path, idempotence per text hash. Scripted editors; no model, no database.
import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_FAITH_VERSION, compareFaithClaims, faithBriefUnits, faithBriefWithout, frontierFaithBrief, frontierFaithCheck, frontierFaithLead,
  frontierFaithLoop, frontierSentences, joinFaithSentences, parseFaithClaims } from "../src/frontierFaith.mjs";
import { faithDiagnostic, frontierEnsureStudyFacts } from "../src/frontierFaithStep.mjs";
import { frontierRepairBrief } from "../src/frontierBrief.mjs";
import { frontierRepairLead } from "../src/frontierLead.mjs";
import { FRONTIER_STUDY_FACTS_VERSION, buildStudyFactsInput, frontierStudyFactsView, frontierWriteStudyFacts, verifyStudyFacts } from "../src/frontierStudyFacts.mjs";

const TEXT = [
  "Background: Oral drug X may lower LDL cholesterol.",
  "Methods: In a double-blind randomised trial, 1200 adults aged 40 years or older were assigned to drug X or placebo for 12 weeks.",
  "Results: The primary end point, LDL change, was lower with drug X than with placebo (-24% vs -3%; P<0.001).",
  "Conclusions: These results suggest that drug X may be useful in adults at risk; confirmation is needed.",
].join("\n");
const input = buildStudyFactsInput({ sourceName: "Journal", date: "2026-10-21", titleRaw: "Drug X versus placebo for LDL", text: TEXT, kind: "abstract" });

/** The model's extraction for TEXT, all quotations true. */
const goodAnswer = () => ({
  design: "rct", design_quote: "In a double-blind randomised trial", n: 1200,
  population_text: "40岁及以上成人", population_quote: "1200 adults aged 40 years or older", species: "human", age: "adult", sex: "not-stated",
  intervention_text: "药物 X", intervention_quote: "assigned to drug X or placebo",
  comparator_text: "安慰剂", comparator_quote: "assigned to drug X or placebo", comparator_kind: "placebo",
  endpoint_text: "LDL 变化", endpoint_quote: "The primary end point, LDL change",
  direction: "favours-intervention", direction_quote: "was lower with drug X than with placebo (-24% vs -3%; P<0.001)",
  certainty: "suggestive", certainty_quote: "These results suggest that drug X may be useful in adults at risk",
  spin_present: false, spin_reason: "结论与主要终点一致", spin_quote: null,
});

test("study facts: every field is anchored to a quotation found in the source, and a field whose quote is not found is null", () => {
  const ok = verifyStudyFacts(goodAnswer(), input);
  assert.deepEqual(ok.rejected, []);
  const facts = /** @type {any} */ (ok.facts);
  assert.equal(facts.design, "rct");
  assert.equal(facts.n, 1200);
  assert.equal(facts.comparator.kind, "placebo");
  assert.equal(facts.direction, "favours-intervention");
  assert.equal(facts.certainty, "suggestive");
  assert.equal(facts.quotes_verified, true);
  assert.equal(facts.version, FRONTIER_STUDY_FACTS_VERSION);

  const bad = verifyStudyFacts({ ...goodAnswer(),
    comparator_quote: "compared with an active drug in 3000 patients", // not in the source
    design_quote: "a cluster randomised pragmatic trial", // not in the source
    direction_quote: "the effect was reversed" }, input);
  const wrong = /** @type {any} */ (bad.facts);
  assert.equal(wrong.comparator, null, "a comparator whose quote is not found is null");
  assert.equal(wrong.design, "other", "a design that rests on a missing quote is not one the source can be shown to state");
  assert.equal(wrong.direction, "not-stated");
  assert.equal(wrong.quotes_verified, false);
  assert.deepEqual(bad.rejected.map((entry) => `${entry.field}:${entry.reason}`).sort(),
    ["comparator.quote:verbatim", "design.quote:verbatim", "design:unanchored", "direction.quote:verbatim", "direction:unanchored"]);
});

test("study facts: a number the source does not state, a link and a closed value outside its list are refused", () => {
  const facts = /** @type {any} */ (verifyStudyFacts({ ...goodAnswer(), n: 999, population_text: "年龄在 55 岁及以上的成人", intervention_text: "见 https://example.org/x",
    species: "dog", age: "teenager" }, input).facts);
  assert.equal(facts.n, null, "a size the source does not state");
  assert.equal(facts.population, null, "a population text with a number not in the source");
  assert.equal(facts.intervention, null, "a link");
  const lenient = /** @type {any} */ (verifyStudyFacts({ ...goodAnswer(), species: "dog", age: "teenager" }, input).facts);
  assert.equal(lenient.population.species, "not-stated");
  assert.equal(lenient.population.age, "not-stated");
  assert.equal(verifyStudyFacts(null, input).facts, null);
  assert.equal(verifyStudyFacts([], input).facts, null);
});

test("study facts: the title is part of the source a design is found in; a quotation may differ in white space and notation only", () => {
  const titled = buildStudyFactsInput({ sourceName: "J", titleRaw: "A prospective cohort study of X", text: "Methods were standard.", kind: "abstract" });
  const facts = /** @type {any} */ (verifyStudyFacts({ design: "cohort", design_quote: "A prospective   cohort study of X" }, titled).facts);
  assert.equal(facts.design, "cohort");
});

test("study facts: one call, the same text is never asked twice, a changed text is, an empty answer is asked once for that text", async () => {
  let calls = 0;
  const editor = { async callJson() { calls += 1; return goodAnswer(); } };
  const first = await frontierEnsureStudyFacts(editor, { stored: null, sha: "aaa", input: { sourceName: "J", titleRaw: "T", text: TEXT, kind: "abstract" } });
  assert.equal(calls, 1);
  assert.equal(first.fresh, true);
  assert.equal(first.record.basis, "aaa");
  assert.equal(first.view?.design, "rct");
  const again = await frontierEnsureStudyFacts(editor, { stored: first.record, sha: "aaa", input: { sourceName: "J", titleRaw: "T", text: TEXT, kind: "abstract" } });
  assert.equal(calls, 1, "idempotent per text hash");
  assert.equal(again.fresh, false);
  assert.equal(again.view?.design, "rct");
  await frontierEnsureStudyFacts(editor, { stored: first.record, sha: "bbb", input: { sourceName: "J", titleRaw: "T", text: TEXT, kind: "abstract" } });
  assert.equal(calls, 2, "a changed text reads it again");
  // An answer that is no object, twice: recorded as empty for this text and not asked about it again.
  let blank = 0;
  const silent = { async callJson() { blank += 1; return null; } };
  const none = await frontierEnsureStudyFacts(silent, { stored: null, sha: "ccc", input: { sourceName: "J", titleRaw: "T", text: TEXT, kind: "abstract" } });
  assert.equal(blank, 2, "a non-object answer is asked once more");
  assert.deepEqual([none.record.empty, none.view], [true, null]);
  const stored = await frontierEnsureStudyFacts(silent, { stored: none.record, sha: "ccc", input: { sourceName: "J", titleRaw: "T", text: TEXT, kind: "abstract" } });
  assert.equal(blank, 2);
  assert.equal(stored.view, null);
  // A failed call records nothing: it is asked again later.
  const broken = { async callJson() { throw Object.assign(new Error("x"), { code: "usage_budget_exceeded" }); } };
  const failed = await frontierEnsureStudyFacts(broken, { stored: null, sha: "ddd", input: { sourceName: "J", titleRaw: "T", text: TEXT, kind: "abstract" } });
  assert.deepEqual([failed.record, failed.error], [null, "usage_budget_exceeded"]);
  const write = await frontierWriteStudyFacts(broken, { sourceName: "J", titleRaw: "T", text: TEXT, kind: "abstract" });
  assert.equal(write.error, "usage_budget_exceeded");
});

test("the stored record is read as the contract's shape, and what is not a record is null", () => {
  const record = { ...(/** @type {any} */ (verifyStudyFacts(goodAnswer(), input).facts)), basis: "aaa" };
  const view = /** @type {any} */ (frontierStudyFactsView(record));
  assert.deepEqual([view.design, view.n, view.direction, view.certainty, view.quotes_verified], ["rct", 1200, "favours-intervention", "suggestive", true]);
  assert.ok(view.population.quote && view.comparator.quote && view.primary_endpoint.quote);
  assert.equal(frontierStudyFactsView({ version: "x", basis: "a", empty: true }), null);
  assert.equal(frontierStudyFactsView(null), null);
  assert.equal(frontierStudyFactsView([]), null);
});

// ───────────────────────── the check ─────────────────────────

const FACTS = /** @type {any} */ (frontierStudyFactsView(verifyStudyFacts(goodAnswer(), input).facts));

test("sentences end at the fixed punctuation set and join again", () => {
  assert.deepEqual(frontierSentences("药物 X 降低了 LDL。随访 12 周；样本量 1200！ 是否有效？"), ["药物 X 降低了 LDL。", "随访 12 周；", "样本量 1200！", "是否有效？"]);
  // A full stop after a Latin letter is an abbreviation, as in `trimToWholeSentences`: a Chinese draft ends its sentences with 。
  assert.deepEqual(frontierSentences("药物 X vs. 安慰剂，样本量 n=1200。 Done! Next"), ["药物 X vs. 安慰剂，样本量 n=1200。", "Done!", "Next"]);
  assert.deepEqual(frontierSentences("  "), []);
  assert.equal(joinFaithSentences(["甲；"]), "甲。");
});

test("claims are kept only with the words they rest on found in their sentence; closed values only from their lists", () => {
  const units = [{ id: "a", text: "一项随机对照试验显示药物 X 显著降低 LDL。" }, { id: "b", text: "其余内容。" }];
  const claims = parseFaithClaims({ s: [
    { i: 1, design: "rct", design_w: "随机对照试验", direction: "favours-intervention", scope: "primary", direction_w: "显著降低 LDL", certainty: "definitive", certainty_w: "证实" },
    { i: 2, design: "cohort", design_w: "队列" },
    { i: 9, design: "rct", design_w: "随机" },
    { i: 1, species: "dog", population_w: "犬" },
  ] }, units);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].design, "rct");
  assert.equal(claims[0].direction, "favours-intervention");
  assert.equal(claims[0].certainty, undefined, "words not in the sentence: the claim is dropped");
  assert.equal(claims[0].species, undefined, "a value outside its list");
});

/** @param {Partial<import("../src/frontierFaith.mjs").FaithClaim>} claim */
const compare = (claim, facts = FACTS) => compareFaithClaims([{ unit: 0, text: "s", ...claim }], facts).map((entry) => entry.rule);

test("comparison: each kind of mismatch, and what passes", () => {
  assert.deepEqual(compare({ design: "cohort", designWords: "队列" }), [], "a lower design than the source's is no upgrade");
  assert.deepEqual(compare({ design: "meta-analysis", designWords: "Meta" }), ["design-upgrade"]);
  assert.deepEqual(compare({ design: "rct", designWords: "随机" }), []);
  const cohort = { ...FACTS, design: "cohort", quotes: { ...FACTS.quotes, design: "q" } };
  assert.deepEqual(compare({ design: "rct", designWords: "随机试验" }, cohort), ["design-upgrade"], "a cohort written as a trial");
  assert.deepEqual(compare({ design: "case-series", designWords: "病例系列" }, cohort), [], "a lower tier is not claimed upward");

  assert.deepEqual(compare({ direction: "no-difference", scope: "primary", directionWords: "无差异" }), ["direction-contradiction"]);
  assert.deepEqual(compare({ direction: "no-difference", scope: "subgroup", directionWords: "亚组无差异" }), [], "only the main result is compared");
  assert.deepEqual(compare({ direction: "favours-comparator", scope: "safety", directionWords: "不良事件更多" }), []);
  assert.deepEqual(compare({ direction: "favours-intervention", scope: "primary", directionWords: "更好" }), []);
  const exposure = { ...FACTS, comparator: { text: "未暴露", quote: "q", kind: "other" } };
  assert.deepEqual(compare({ direction: "no-difference", scope: "primary", directionWords: "无差异" }, exposure), [], "no intervention-control pair: no direction to compare");

  assert.deepEqual(compare({ comparator: "active", comparatorWords: "对比标准药物" }), ["comparator-differs"]);
  assert.deepEqual(compare({ comparator: "placebo", comparatorWords: "安慰剂" }), []);
  const usual = { ...FACTS, comparator: { text: "常规护理", quote: "q", kind: "no-treatment" } };
  assert.deepEqual(compare({ comparator: "active", comparatorWords: "标准治疗" }, usual), [], "usual care and another treatment are one class");
  assert.deepEqual(compare({ comparator: "none", comparatorWords: "单臂" }), ["comparator-differs"]);

  assert.deepEqual(compare({ species: "animal", populationWords: "小鼠" }), ["species-differs"]);
  assert.deepEqual(compare({ age: "child", populationWords: "儿童" }), ["age-differs"]);
  assert.deepEqual(compare({ age: "older", populationWords: "老年" }), [], "adult and older are not told apart");
  assert.deepEqual(compare({ age: "any", populationWords: "各年龄" }), ["age-differs"]);
  const women = { ...FACTS, population: { ...FACTS.population, sex: "female" } };
  assert.deepEqual(compare({ sex: "both", populationWords: "男女" }, women), ["sex-differs"]);
  assert.deepEqual(compare({ sex: "female", populationWords: "女性" }, women), []);

  assert.deepEqual(compare({ certainty: "definitive", certaintyWords: "证实" }), ["certainty-raised"]);
  assert.deepEqual(compare({ certainty: "suggestive", certaintyWords: "提示" }), []);
  assert.deepEqual(compare({ causal: true, causalWords: "导致" }), [], "a trial may say cause");
  assert.deepEqual(compare({ causal: true, causalWords: "导致" }, cohort), ["causal-for-observational"]);
});

test("comparison: a fact the source is not shown to state is never a reason", () => {
  const unanchored = { ...FACTS, quotes: { design: null, direction: null, certainty: null }, comparator: null, population: null };
  assert.deepEqual(compareFaithClaims([{ unit: 0, text: "s", design: "meta-analysis", designWords: "m", direction: "no-difference", scope: "primary", directionWords: "d",
    comparator: "active", comparatorWords: "c", species: "animal", populationWords: "p", certainty: "definitive", certaintyWords: "w" }], unanchored), []);
  assert.deepEqual(compareFaithClaims([{ unit: 0, text: "s", design: "meta-analysis", designWords: "m" }], null), []);
});

/** A scripted editor: the claim reader, the source verifier and the writer's repair, told apart by their instructions. */
function scripted({ claims, verdicts, repaired }) {
  const calls = { claims: 0, verify: 0, repair: 0 };
  return { calls, async callJson(/** @type {any[]} */ messages) {
    const system = messages[0].content;
    if (system.includes("稿件已经按句编号")) { calls.claims += 1; return typeof claims === "function" ? claims(messages[1].content, calls.claims) : claims; }
    if (system.includes("被怀疑")) { calls.verify += 1; return typeof verdicts === "function" ? verdicts(messages[1].content) : verdicts; }
    calls.repair += 1;
    return typeof repaired === "function" ? repaired(messages) : repaired;
  } };
}
const SOURCE_TEXT = `标题：Drug X versus placebo for LDL\n正文（摘要）：\n${TEXT}`;

test("the check: a suspicion is a mismatch only when the source is shown to say otherwise, in its own words", async () => {
  const claims = { s: [{ i: 1, direction: "no-difference", scope: "primary", direction_w: "无显著差异" }] };
  const units = [{ id: "l0", text: "药物 X 与安慰剂相比无显著差异。" }];
  const faithful = scripted({ claims, verdicts: { v: [{ i: 1, verdict: "faithful" }] } });
  const one = await frontierFaithCheck(faithful, { facts: FACTS, units, source: SOURCE_TEXT });
  assert.equal(one.candidates.length, 1);
  assert.deepEqual(one.mismatches, [], "the verifier did not confirm");
  const noQuote = scripted({ claims, verdicts: { v: [{ i: 1, verdict: "misstated" }] } });
  assert.deepEqual((await frontierFaithCheck(noQuote, { facts: FACTS, units, source: SOURCE_TEXT })).mismatches, [], "misstated without a quotation confirms nothing");
  const invented = scripted({ claims, verdicts: { v: [{ i: 1, verdict: "misstated", quote: "drug X reduced mortality by half" }] } });
  assert.deepEqual((await frontierFaithCheck(invented, { facts: FACTS, units, source: SOURCE_TEXT })).mismatches, [], "a quotation that is not in the source confirms nothing");
  const confirmed = scripted({ claims, verdicts: { v: [{ i: 1, verdict: "misstated", quote: "was lower with drug X than with placebo (-24% vs -3%; P<0.001)" }] } });
  const result = await frontierFaithCheck(confirmed, { facts: FACTS, units, source: SOURCE_TEXT });
  assert.deepEqual(result.mismatches.map((entry) => entry.rule), ["direction-contradiction"]);
  assert.match(String(result.mismatches[0].quote), /lower with drug X/);
  // No source given: the comparison alone decides (a test seam; the pipeline always gives the source).
  assert.equal((await frontierFaithCheck(scripted({ claims }), { facts: FACTS, units })).mismatches.length, 1);
  // A claim call that fails concludes nothing; no facts or no units: no call.
  const broken = { async callJson() { throw Object.assign(new Error("x"), { code: "frontier_provider_unavailable" }); } };
  const failed = await frontierFaithCheck(broken, { facts: FACTS, units, source: SOURCE_TEXT });
  assert.deepEqual([failed.mismatches.length, failed.error], [0, "frontier_provider_unavailable"]);
  const idle = scripted({ claims });
  await frontierFaithCheck(idle, { facts: null, units, source: SOURCE_TEXT });
  await frontierFaithCheck(idle, { facts: FACTS, units: [], source: SOURCE_TEXT });
  assert.equal(idle.calls.claims, 0);
});

const QUOTE = "was lower with drug X than with placebo (-24% vs -3%; P<0.001)";
const BAD_LEAD = "一项随机对照试验纳入 1200 名成人。药物 X 与安慰剂相比无显著差异。随访 12 周。";

test("the loop: clean, repaired, trimmed, emptied and unchecked", async () => {
  const flagFirstSentenceOfSecond = (/** @type {string} */ text) => (text.includes("无显著差异") ? { s: [{ i: 2, direction: "no-difference", scope: "primary", direction_w: "无显著差异" }] } : { s: [] });
  const confirm = { v: [{ i: 1, verdict: "misstated", quote: QUOTE }] };
  const lead = async (/** @type {any} */ editor, /** @type {string} */ draft, /** @type {string | null} */ fix) => frontierFaithLead(editor, { facts: FACTS, lead: draft, source: SOURCE_TEXT,
    repair: async () => fix });

  const clean = scripted({ claims: { s: [] } });
  assert.equal((await lead(clean, "药物 X 降低了 LDL。", null)).outcome, "clean");

  const ed1 = scripted({ claims: flagFirstSentenceOfSecond, verdicts: confirm });
  const repaired = await lead(ed1, BAD_LEAD, "一项随机对照试验纳入 1200 名成人。药物 X 较安慰剂降低 LDL（-24% 对 -3%）。随访 12 周。");
  assert.equal(repaired.outcome, "repaired");
  assert.match(String(repaired.draft), /降低 LDL/);
  assert.equal(repaired.first.length, 1);
  assert.deepEqual(repaired.remaining, []);
  assert.equal(repaired.calls, 4, "claims, source, repair, claims again (no suspicion left, so no source call)");

  // The repair is refused by the writer's own checks (null): the sentence is taken out.
  const ed2 = scripted({ claims: flagFirstSentenceOfSecond, verdicts: confirm });
  const trimmed = await lead(ed2, BAD_LEAD, null);
  assert.equal(trimmed.outcome, "trimmed");
  assert.equal(trimmed.draft, "一项随机对照试验纳入 1200 名成人。随访 12 周。");

  // The repair still says it: the sentence of the repaired draft is taken out.
  const ed3 = scripted({ claims: flagFirstSentenceOfSecond, verdicts: confirm });
  const still = await lead(ed3, BAD_LEAD, "一项随机对照试验纳入 1200 名成人。药物 X 与安慰剂相比无显著差异，随访 12 周。");
  assert.equal(still.outcome, "trimmed");
  assert.equal(still.draft, "一项随机对照试验纳入 1200 名成人。");

  // Nothing would be left: no draft (the pipeline keeps the previous accepted text).
  const ed4 = scripted({ claims: { s: [{ i: 1, direction: "no-difference", scope: "primary", direction_w: "无显著差异" }] }, verdicts: confirm });
  const emptied = await lead(ed4, "药物 X 与安慰剂相比无显著差异。", null);
  assert.deepEqual([emptied.outcome, emptied.draft], ["emptied", null]);

  // The writer's call fails for the budget: the draft stays as it is, nothing is concluded.
  const ed5 = scripted({ claims: flagFirstSentenceOfSecond, verdicts: confirm });
  const budget = await frontierFaithLead(ed5, { facts: FACTS, lead: BAD_LEAD, source: SOURCE_TEXT, repair: async () => { throw Object.assign(new Error("x"), { code: "usage_budget_exceeded" }); } });
  assert.deepEqual([budget.outcome, budget.draft, budget.error], ["unchecked", BAD_LEAD, "usage_budget_exceeded"]);

  // No facts: the draft is not touched and nothing is asked.
  const ed6 = scripted({ claims: flagFirstSentenceOfSecond, verdicts: confirm });
  const nothing = await frontierFaithLoop(ed6, { facts: null, draft: BAD_LEAD, unitsOf: () => [], repair: async () => null, remove: () => null });
  assert.deepEqual([nothing.outcome, ed6.calls.claims], ["no-facts", 0]);
});

test("a 要点 is checked field by field and item by item: the repair, then the removal; the authors' quotation is not read", async () => {
  const brief = { genre: "paper", points: [
    { key: "design", label: "设计与对象", text: "随机对照试验，1200 名成人。" },
    { key: "results", label: "主要结果", items: ["药物 X 与安慰剂无显著差异。", "LDL 变化 -24% 对 -3%。"] },
  ], quote: { key: "conclusion", label: "作者结论", text: "These results suggest that drug X may be useful in adults at risk" } };
  const units = faithBriefUnits(brief);
  assert.deepEqual(units.map((unit) => unit.id), ["design", "results.0", "results.1"]);
  assert.equal(units[1].label, "主要结果");
  const without = /** @type {any} */ (faithBriefWithout(brief, new Set([1])));
  assert.deepEqual(without.points[1].items, ["LDL 变化 -24% 对 -3%。"]);
  assert.deepEqual(without.quote, brief.quote);
  assert.deepEqual(/** @type {any} */ (faithBriefWithout(brief, new Set([0, 1, 2]))).points, [], "the quotation keeps a brief alive");
  assert.equal(faithBriefWithout({ points: [{ key: "a", label: "A", text: "甲" }] }, new Set([0])), null);

  const editor = scripted({ claims: (/** @type {string} */ text) => (text.includes("无显著差异") ? { s: [{ i: 2, direction: "no-difference", scope: "primary", direction_w: "无显著差异" }] } : { s: [] }),
    verdicts: { v: [{ i: 1, verdict: "misstated", quote: QUOTE }] } });
  const result = await frontierFaithBrief(editor, { facts: FACTS, brief, source: SOURCE_TEXT, repair: async () => null });
  assert.equal(result.outcome, "trimmed");
  assert.deepEqual(/** @type {any} */ (result.draft).points[1].items, ["LDL 变化 -24% 对 -3%。"]);
});

test("the repair hooks send the draft back through the writer's own instructions and checks", async () => {
  /** @type {any[]} */
  const seen = [];
  const leadEditor = { async callJson(/** @type {any[]} */ messages) { seen.push(messages); return { lead_zh: "药物 X 较安慰剂降低 LDL（-24% 对 -3%）。" }; } };
  const fixed = await frontierRepairLead(leadEditor, { sourceName: "J", titleRaw: "Drug X versus placebo for LDL", text: TEXT, kind: "abstract", genre: "paper" }, "药物 X 无效。", ["- 第 1 句写错了"]);
  assert.match(String(fixed), /降低 LDL/);
  assert.equal(seen[0].length, 4);
  assert.match(seen[0][0].content, /AI 导读/);
  assert.match(seen[0][3].content, /第 1 句写错了/);
  const numberBad = { async callJson() { return { lead_zh: "药物 X 降低 LDL 77%。" }; } };
  assert.equal(await frontierRepairLead(numberBad, { sourceName: "J", titleRaw: "T", text: TEXT, kind: "abstract", genre: "paper" }, "x", ["- y"]), null, "a repair with a number not in the source is refused");

  const briefEditor = { async callJson(/** @type {any[]} */ messages) { seen.push(messages); return { points: { design: "随机对照试验，1200 名成人，12 周。" } }; } };
  const brief = await frontierRepairBrief(briefEditor, { sourceName: "J", titleRaw: "Drug X versus placebo for LDL", text: TEXT, kind: "abstract", genre: "paper" },
    { genre: "paper", points: [{ key: "design", label: "设计与对象", text: "队列研究" }] }, ["- 设计写错了"]);
  assert.equal(/** @type {any} */ (brief).points[0].text, "随机对照试验，1200 名成人，12 周。");
  assert.match(seen.at(-1)[2].content, /队列研究/, "the draft is sent back as the assistant's own answer");
  assert.equal(await frontierRepairBrief(briefEditor, { sourceName: "J", titleRaw: "T", text: "x", kind: "abstract", genre: "social" }, { genre: "social", points: [] }, []), null);
});

test("the closed record of a check carries no text of the draft, the source or the model", () => {
  const record = faithDiagnostic({ outcome: "trimmed", candidates: 2, first: [{ rule: "direction-contradiction", kind: "direction", unit: 1, claim: "无差异", expected: "x", quote: "q" }],
    remaining: [{ rule: "direction-contradiction", kind: "direction", unit: 1, claim: "无差异", expected: "x", quote: "q" }], calls: 5, error: null, draft: "secret" });
  assert.deepEqual(record, { outcome: "trimmed", candidates: 2, confirmed: 1, remaining: 1, rules: ["direction-contradiction"], calls: 5, error: null });
  assert.match(FRONTIER_FAITH_VERSION, /^frontier-faith-1\.[a-f0-9]{12}$/);
});
