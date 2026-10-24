// The reader's 「AI 要点」 (frontierBrief.mjs, ct-write 2026-10-24): one table of typed fields per genre, the instructions built from it,
// every field checked on its own (numbers in the source, a quotation a run of the source's own words), what a reader is served,
// and one metered call per item.
import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_GENRES } from "@evimed/domain";
import {
  FRONTIER_BRIEF_FIELDS,
  FRONTIER_BRIEF_LIMITS,
  FRONTIER_BRIEF_VERSION,
  buildBriefInput,
  frontierBriefInstructions,
  frontierBriefView,
  frontierBriefWanted,
  frontierWriteBrief,
  quotationForm,
  verifyBrief,
} from "../src/frontierBrief.mjs";

const SOURCE = [
  "Background: Oral PCSK9 inhibition lowers LDL cholesterol.",
  "Methods: In a double-blind trial, 12,000 patients were randomly assigned to the oral inhibitor or placebo and followed for 2.1 years.",
  "Results: The primary end point occurred in 7.2% of the active group and 8.8% of the placebo group (hazard ratio, 0.82; 95% CI, 0.75 to 0.90).",
  "Conclusions: Oral PCSK9 inhibition reduced the risk of major cardiovascular events.",
].join("\n\n");
const input = buildBriefInput({ sourceName: "NEJM 2027", date: "2026-10-21", titleRaw: "Oral PCSK9 Inhibition and Cardiovascular Outcomes", text: SOURCE, kind: "abstract" });

test("every genre has a row of fields; a post has none and is not asked", () => {
  for (const genre of FRONTIER_GENRES) {
    const shape = FRONTIER_BRIEF_FIELDS[genre];
    assert.ok(shape && Array.isArray(shape.points), genre);
    assert.equal(new Set(shape.points.map((field) => field.key)).size, shape.points.length, `${genre}: keys are unique`);
    assert.ok(!shape.points.some((field) => field.key === "points" || field.key === "quote"), `${genre}: no key is the answer's own (measured: a field named points was read as the list)`);
  }
  assert.equal(frontierBriefWanted("social"), false);
  assert.equal(frontierBriefWanted("paper"), true);
  assert.equal(frontierBriefWanted("unknown"), false);
  assert.equal(frontierBriefInstructions("social"), null);
  assert.match(FRONTIER_BRIEF_VERSION, /^frontier-brief-1\.[a-f0-9]{12}$/);
});

test("the instructions share one prefix and end with the genre's fields, the quotation outside the points", () => {
  const paper = /** @type {string} */ (frontierBriefInstructions("paper"));
  const policy = /** @type {string} */ (frontierBriefInstructions("policy"));
  const prefix = paper.slice(0, paper.indexOf("本条类型"));
  assert.ok(policy.startsWith(prefix), "the shared rules are the cached prefix");
  assert.match(paper, /本条类型：研究论文/);
  for (const field of FRONTIER_BRIEF_FIELDS.paper.points) assert.ok(paper.includes(`- ${field.key}（${field.label}`), field.key);
  assert.match(paper, /quote（作者结论，原文摘录）/);
  assert.match(paper, /quote 放在 points 外面/);
  assert.doesNotMatch(/** @type {string} */ (frontierBriefInstructions("industry")), /quote（/, "a genre without a quotation asks for none");
  assert.match(paper, /不要写「未提及」「未披露」/);
});

test("a good answer is kept field by field, in the table's order, under the table's labels", () => {
  const { brief, dropped } = verifyBrief({
    points: {
      results: ["主要终点事件 7.2% 对 8.8%（风险比 0.82；95% CI，0.75 至 0.90）。"],
      design: "双盲随机试验，12000 例患者，随访 2.1 年。",
      question: "口服 PCSK9 抑制剂能否降低主要心血管事件。",
    },
    quote: { text: "Oral PCSK9 inhibition reduced the risk of major cardiovascular events.", zh: "口服 PCSK9 抑制降低了主要心血管事件的风险。" },
  }, { genre: "paper", input });
  assert.deepEqual(dropped, []);
  assert.deepEqual(brief, {
    genre: "paper",
    points: [
      { key: "question", label: "研究问题", text: "口服 PCSK9 抑制剂能否降低主要心血管事件。" },
      { key: "design", label: "设计与对象", text: "双盲随机试验，12000 例患者，随访 2.1 年。" },
      { key: "results", label: "主要结果", items: ["主要终点事件 7.2% 对 8.8%（风险比 0.82；95% CI，0.75 至 0.90）。"] },
    ],
    quote: { key: "conclusion", label: "作者结论", text: "Oral PCSK9 inhibition reduced the risk of major cardiovascular events.", zh: "口服 PCSK9 抑制降低了主要心血管事件的风险。" },
  });
});

test("a failed field is dropped and the rest kept: a number not in the source, a link, English prose, an unknown key, nothing to say", () => {
  const { brief, dropped } = verifyBrief({
    points: {
      question: "口服 PCSK9 抑制剂能否降低主要心血管事件。",
      design: "双盲随机试验，15000 例患者。",
      safety: "详见 www.nejm.org 的补充材料中的安全性部分。",
      limits: "The follow-up was short.",
      next: "下一步研究。",
      results: [],
    },
  }, { genre: "paper", input });
  assert.deepEqual(brief?.points.map((point) => point.key), ["question"]);
  assert.deepEqual(dropped.map((part) => `${part.key}:${part.reason}`).sort(), ["design:number", "limits:language", "next:unknown", "safety:link"]);
});

test("three characters say nothing a field asks for (「未提及」, measured 2026-10-24); a field of names is not asked for Chinese prose", () => {
  const industryInput = buildBriefInput({ sourceName: "S", titleRaw: "Deal", text: "Gilead pays $1.275 billion upfront for HCXT-2001.", kind: "body" });
  const { brief, dropped } = verifyBrief({ points: { event: "吉利德收购 HCXT-2001 项目。", next: "未提及" } }, { genre: "industry", input: industryInput });
  assert.deepEqual(brief?.points.map((point) => point.key), ["event"]);
  assert.deepEqual(dropped, [{ key: "next", reason: "length" }]);
  const trialInput = buildBriefInput({ sourceName: "ClinicalTrials.gov", titleRaw: "A trial", text: "NCT05804045 is sponsored by Pfizer.", kind: "excerpt" });
  const trial = verifyBrief({ points: { registry: "NCT05804045", sponsor: "Pfizer" } }, { genre: "trial", input: trialInput });
  assert.deepEqual(trial.brief?.points.map((point) => point.text), ["NCT05804045", "Pfizer"]);
});

test("too long keeps its leading whole sentences; a first sentence over the limit is dropped", () => {
  const sentence = "双盲随机试验纳入患者并随访。";
  const long = sentence.repeat(Math.ceil(FRONTIER_BRIEF_LIMITS.text / sentence.length) + 2);
  const kept = verifyBrief({ points: { design: long } }, { genre: "paper", input });
  assert.ok(kept.brief && [...String(kept.brief.points[0].text)].length <= FRONTIER_BRIEF_LIMITS.text);
  assert.ok(String(kept.brief?.points[0].text).endsWith("。"));
  const runOn = verifyBrief({ points: { design: "双".repeat(FRONTIER_BRIEF_LIMITS.text + 5) } }, { genre: "paper", input });
  assert.equal(runOn.brief, null);
  assert.deepEqual(runOn.dropped, [{ key: "design", reason: "length" }]);
});

test("a quotation is a run of the source's own words, compared in one notation and kept as written; its Chinese is held to the source", () => {
  const spaced = verifyBrief({ quote: { text: "Oral PCSK9 inhibition  reduced the risk\nof major cardiovascular events." } }, { genre: "paper", input });
  assert.equal(spaced.brief?.quote?.text, "Oral PCSK9 inhibition reduced the risk of major cardiovascular events.");
  const invented = verifyBrief({ quote: { text: "Oral PCSK9 inhibition eliminated major cardiovascular events." } }, { genre: "paper", input });
  assert.equal(invented.brief, null);
  assert.deepEqual(invented.dropped, [{ key: "quote", reason: "verbatim" }]);
  const wrongNumber = verifyBrief({ quote: { text: "Oral PCSK9 inhibition reduced the risk of major cardiovascular events.", zh: "口服 PCSK9 抑制使主要心血管事件风险降低 30%。" } }, { genre: "paper", input });
  assert.equal(wrongNumber.brief?.quote?.zh, undefined, "the Chinese with a number not in the source goes; the quotation stays");
  assert.deepEqual(wrongNumber.dropped, [{ key: "quote.zh", reason: "number" }]);
  // A Chinese source's quotation keeps its full-width punctuation as the source has it.
  const zhInput = buildBriefInput({ sourceName: "梅斯", titleRaw: "指南", text: "推荐意见 1：成人复杂性尿路感染首选口服抗菌药物（强推荐，中等质量证据）。", kind: "body" });
  const zh = verifyBrief({ quote: { text: "推荐意见 1：成人复杂性尿路感染首选口服抗菌药物（强推荐，中等质量证据）。", zh: "重复" } }, { genre: "guideline", input: zhInput });
  assert.equal(zh.brief?.quote?.text, "推荐意见 1：成人复杂性尿路感染首选口服抗菌药物（强推荐，中等质量证据）。");
  assert.equal(zh.brief?.quote?.zh, undefined, "a Chinese quotation needs no Chinese");
  assert.equal(quotationForm("Ａ，“b”—c"), "A,\"b\"-c");
});

test("the format slips the model makes are read as what they are (measured 2026-10-24)", () => {
  // A quotation set inside the points.
  const nested = verifyBrief({ points: { question: "口服 PCSK9 抑制剂能否降低主要心血管事件。", quote: { text: "Oral PCSK9 inhibition reduced the risk of major cardiovascular events." } } }, { genre: "paper", input });
  assert.equal(nested.brief?.quote?.key, "conclusion");
  assert.deepEqual(nested.dropped, []);
  // Points as a list of rows.
  const rows = verifyBrief({ points: [{ key: "question", text: "口服 PCSK9 抑制剂能否降低主要心血管事件。" }, { key: "results", items: ["主要终点事件 7.2% 对 8.8%。"] }] }, { genre: "paper", input });
  assert.deepEqual(rows.brief?.points.map((point) => point.key), ["question", "results"]);
  // A sentence field answered as phrases, and a list field answered with one sentence.
  const phrases = verifyBrief({ points: { design: ["双盲随机试验", "12000 例患者"], results: "主要终点事件 7.2% 对 8.8%。" } }, { genre: "paper", input });
  assert.deepEqual(phrases.brief?.points, [
    { key: "design", label: "设计与对象", text: "双盲随机试验；12000 例患者" },
    { key: "results", label: "主要结果", items: ["主要终点事件 7.2% 对 8.8%。"] },
  ]);
  assert.equal(verifyBrief(null, { genre: "paper", input }).brief, null);
  assert.equal(verifyBrief({ points: { design: 42 } }, { genre: "paper", input }).dropped[0].reason, "shape");
});

test("a brief's numbers are checked against the title and the text, never the date line or the source's name (D-06)", () => {
  const { dropped } = verifyBrief({ points: { design: "2026 年 10 月 21 日发表的双盲随机试验。" } }, { genre: "paper", input });
  assert.deepEqual(dropped, [{ key: "design", reason: "number" }]);
  assert.deepEqual(verifyBrief({ points: { design: "NEJM 2027 发表的双盲随机试验。" } }, { genre: "paper", input }).dropped, [{ key: "design", reason: "number" }]);
});

test("a stored brief is served under its genre's table: its labels, its keys, re-bounded; nothing left is null", () => {
  assert.deepEqual(frontierBriefView({ genre: "paper", points: [
    { key: "design", label: "旧标签", text: "双盲随机试验。" },
    { key: "retired", label: "已删", text: "x" },
    { key: "results", items: ["一", 2, ""] },
  ], quote: { label: "旧", text: "It works.", zh: "有效。" } }), {
    genre: "paper",
    points: [{ key: "design", label: "设计与对象", text: "双盲随机试验。" }, { key: "results", label: "主要结果", items: ["一"] }],
    quote: { key: "conclusion", label: "作者结论", text: "It works.", zh: "有效。" },
  });
  assert.equal(frontierBriefView({ genre: "made-up", points: [] }), null);
  assert.equal(frontierBriefView({ genre: "paper", points: [{ key: "design", text: "" }] }), null);
  assert.equal(frontierBriefView(null), null);
  assert.equal(frontierBriefView({ genre: "industry", points: [], quote: { text: "a quotation a genre without one cannot show" } }), null);
});

test("one brief is one metered call with its genre's instructions; a failed call records nothing; a post is not asked", async () => {
  /** @type {any[]} */
  const calls = [];
  const editor = {
    async callJson(/** @type {any[]} */ messages, /** @type {any} */ limits) {
      calls.push({ messages, limits });
      return { points: { question: "口服 PCSK9 抑制剂能否降低主要心血管事件。" } };
    },
  };
  const result = await frontierWriteBrief(editor, { genre: "paper", sourceName: "NEJM", titleRaw: "T", text: SOURCE, kind: "abstract" });
  assert.equal(result.asked, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.brief?.points.map((point) => point.key), ["question"]);
  assert.equal(calls[0].messages[0].content, frontierBriefInstructions("paper"));
  assert.match(calls[0].messages[1].content, /^来源：NEJM\n标题：T\n正文（摘要）：\nBackground:/);
  assert.ok(calls[0].limits.maxTokens > 0 && calls[0].limits.timeoutMs > 0);
  const failing = { async callJson() { throw Object.assign(new Error("down"), { code: "model_gateway_upstream_unavailable" }); } };
  assert.deepEqual((await frontierWriteBrief(failing, { genre: "paper", sourceName: "S", titleRaw: "T", text: SOURCE, kind: "abstract" })).error,
    "model_gateway_upstream_unavailable");
  const post = await frontierWriteBrief(editor, { genre: "social", sourceName: "S", titleRaw: "T", text: "post", kind: "body", post: true });
  assert.equal(post.asked, false);
  assert.equal(calls.length, 1);
});
