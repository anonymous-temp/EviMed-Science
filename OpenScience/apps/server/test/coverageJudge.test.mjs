import assert from "node:assert/strict";
import test from "node:test";
import { coverageJudgeContext } from "../src/clinicalEvidenceQuality.mjs";
import {
  CoverageJudge,
  coverageJudgeNotices,
  coverageJudgePayload,
  parseJudgeVerdicts,
  verifiedCoverageVerdicts,
} from "../src/coverageJudge.mjs";

// A miniature package: a brief with three numbered questions, a ledger that
// registers them, and a report whose sections are exactly the ones the excerpt
// rules care about — the two a reader takes an answer away from (摘要, 结论), a
// body section, a limitations section and a reference list.
const reportLines = [
  "# 用力排便与急性冠脉事件的证据评价",                                    // 1
  "",                                                                     // 2
  "## 摘要",                                                              // 3
  "本文回答三个问题。排便场景下含服自救药物后可先观察十分钟再决定是否呼叫急救。", // 4
  "",                                                                     // 5
  "## 结果",                                                              // 6
  "病例交叉研究报告用力排便后一小时内发病风险比为 2.7（95% CI 1.4–5.2）。<!-- claim:CLM-001 -->", // 7
  "",                                                                     // 8
  "基层门诊的头晕病因构成中，心血管占 57%，前庭占 14%；未检索到住院人群的构成数据。<!-- claim:CLM-002 -->", // 9
  "",                                                                     // 10
  "## 结论",                                                              // 11
  "排便用力与急性冠脉事件之间存在可重复的时间关联。未检索到排便场景下含服自救药物的前瞻性研究。说明书未载该场景的用法。", // 12
  "",                                                                     // 13
  "## 局限性",                                                            // 14
  "本次未获取中文数据库的全文记录。<!-- claim:CLM-003 -->",                 // 15
  "",                                                                     // 16
  "## 参考文献",                                                          // 17
  "1. Verified clinical source 1. PMID 900001.",                          // 18
];
const reportText = reportLines.join("\n");
const abstractLine = 4;
const resultsAnchoredLine = 7;
const otherAnchoredLine = 9;
const conclusionLine = 12;
const limitationsLine = 15;
const titleLine = 1;

const briefText = [
  "# 研究任务",
  "",
  "## 需要回答的问题",
  "",
  "1. 用力排便与急性冠脉事件的关联强度是多少？",
  "2. 排便场景下含服自救药物后先观察十分钟是否安全？",
  "3. 晨起头晕在未确诊冠心病人群中的病因构成如何？",
  "",
].join("\n");

const questionCoverageText = JSON.stringify({
  schemaVersion: 1,
  entries: [
    {
      id: "1.1",
      question: "用力排便与急性冠脉事件的关联强度是多少",
      status: "answered",
      reportLines: [resultsAnchoredLine],
    },
    {
      id: "2.1",
      question: "排便场景下含服自救药物后先观察十分钟是否安全",
      status: "gap",
      searches: [{ query: "valsalva AND myocardial infarction", database: "PubMed", searchedAt: "2026-02-11" }],
    },
    {
      id: "3.1",
      question: "晨起头晕在未确诊冠心病人群中的病因构成如何",
      status: "answered",
      reportLines: [otherAnchoredLine],
    },
    {
      id: "4.1",
      question: "中文数据库的覆盖缺口对结论稳健性有何影响",
      status: "answered",
      reportLines: [limitationsLine],
    },
  ],
});

function context() {
  const built = coverageJudgeContext({ briefText, questionCoverageText, reportText });
  assert.ok(built, "the fixture must produce a judgeable context");
  return built;
}

function baseConfig(overrides = {}) {
  return {
    coverageJudgeEnabled: true,
    coverageJudgeTimeoutMs: 30_000,
    deepseekProviderEnabled: true,
    deepseekApiKey: "sk-test",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-pro",
    production: false,
    ...overrides,
  };
}

function fetchReturning(content, { ok = true, reasoningContent = undefined, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const message = reasoningContent === undefined ? { content } : { content, reasoning_content: reasoningContent };
    return {
      ok,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message }] }),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const responsiveVerdict = {
  entryId: "1.1",
  kind: "answer-not-responsive",
  reportLine: resultsAnchoredLine,
  quote: "用力排便后一小时内发病风险比为 2.7",
  why: "题面第 1 问问的是关联强度在已确诊与未确诊人群之间是否一致，该行只给出总体风险比。",
};

// --- what the judge is shown -------------------------------------------------

test("a delivery with no parsable brief questions, no ledger or no report is not judgeable", () => {
  assert.equal(coverageJudgeContext({ briefText: null, questionCoverageText, reportText }), null);
  assert.equal(coverageJudgeContext({ briefText: "# 只有标题", questionCoverageText, reportText }), null);
  assert.equal(coverageJudgeContext({ briefText, questionCoverageText: "", reportText }), null);
  assert.equal(coverageJudgeContext({ briefText, questionCoverageText: "not json", reportText }), null);
  assert.equal(coverageJudgeContext({ briefText, questionCoverageText, reportText: "" }), null);
});

test("the excerpt is the two verdict sections plus the paragraphs the ledger itself cites, and nothing else", () => {
  const built = context();
  // The takeaway sections, in full.
  assert.ok(built.excerptLines.has(abstractLine));
  assert.ok(built.excerptLines.has(conclusionLine));
  assert.equal(built.verdictLines.get(abstractLine), "摘要");
  assert.equal(built.verdictLines.get(conclusionLine), "结论");
  // The lines the ledger points at.
  assert.ok(built.excerptLines.has(resultsAnchoredLine));
  assert.ok(built.excerptLines.has(otherAnchoredLine));
  assert.ok(built.excerptLines.has(limitationsLine));
  // And not the rest of the report — this is the cost ceiling, not a detail.
  assert.equal(built.excerptLines.has(titleLine), false);
  assert.equal(built.excerptLines.has(18), false, "the reference list is never sent");
  assert.ok(built.excerpt.length < reportLines.length);
  assert.equal(built.truncated, false);
  const payload = coverageJudgePayload(built);
  const sent = JSON.stringify(payload);
  assert.ok(!sent.includes("Verified clinical source"), "the reference list is never sent");
  assert.ok(!sent.includes("用力排便与急性冠脉事件的证据评价"), "the title line is never sent");
  assert.equal(payload.briefQuestions.length, 3);
  assert.equal(payload.ledgerEntries.length, 4);
  assert.equal(payload.excerptIsPartial, false);
});

// --- verification: what the code checks of what the model says ---------------

test("a verdict that survives every check is kept, with its line and quotation intact", () => {
  const { kept, discarded } = verifiedCoverageVerdicts([responsiveVerdict], context());
  assert.deepEqual(discarded, {});
  assert.equal(kept.length, 1);
  assert.equal(kept[0].entryId, "1.1");
  assert.equal(kept[0].line, resultsAnchoredLine);
  assert.equal(kept[0].question, "用力排便与急性冠脉事件的关联强度是多少");
});

test("an entry id the ledger does not contain is discarded", () => {
  const { kept, discarded } = verifiedCoverageVerdicts(
    [{ ...responsiveVerdict, entryId: "9.9" }],
    context(),
  );
  assert.equal(kept.length, 0);
  assert.equal(discarded.unknown_entry, 1);
});

test("a kind outside the three, or one that contradicts the entry's registered status, is discarded", () => {
  const built = context();
  assert.equal(verifiedCoverageVerdicts([{ ...responsiveVerdict, kind: "made-up" }], built).discarded.unknown_kind, 1);
  // 1.1 is registered "answered"; only a "gap" entry can be a false gap.
  assert.equal(verifiedCoverageVerdicts([{ ...responsiveVerdict, kind: "false-gap" }], built).discarded.status_mismatch, 1);
  // 2.1 is registered "gap"; it cannot be an unresponsive answer.
  assert.equal(
    verifiedCoverageVerdicts([{ ...responsiveVerdict, entryId: "2.1" }], built).discarded.status_mismatch,
    1,
  );
});

test("a line outside the report, or one the model was never shown, is discarded", () => {
  const built = context();
  assert.equal(verifiedCoverageVerdicts([{ ...responsiveVerdict, reportLine: 999 }], built).discarded.line_out_of_range, 1);
  assert.equal(verifiedCoverageVerdicts([{ ...responsiveVerdict, reportLine: 0 }], built).discarded.line_out_of_range, 1);
  assert.equal(verifiedCoverageVerdicts([{ ...responsiveVerdict, reportLine: 7.5 }], built).discarded.line_out_of_range, 1);
  assert.equal(verifiedCoverageVerdicts([{ ...responsiveVerdict, reportLine: "行七" }], built).discarded.line_out_of_range, 1);
  // Line 1 exists and is not blank; it was simply not in the excerpt.
  assert.equal(
    verifiedCoverageVerdicts([{ ...responsiveVerdict, reportLine: titleLine, quote: "用力排便与急性冠脉事件的证据评价" }], built)
      .discarded.line_not_shown,
    1,
  );
});

test("a line in the limitations section is discarded: it is not where an answer is given or withheld", () => {
  const built = context();
  const { kept, discarded } = verifiedCoverageVerdicts([{
    entryId: "4.1",
    kind: "answer-not-responsive",
    reportLine: limitationsLine,
    quote: "本次未获取中文数据库的全文记录",
    why: "这一行只是承认缺口。",
  }], built);
  assert.equal(kept.length, 0);
  assert.equal(discarded.line_excluded_section, 1);
});

test("an unresponsive-answer verdict must name a line that entry itself declared", () => {
  // Otherwise the charge is not "your own citation does not answer this", it is
  // an unfalsifiable claim about a line the entry never mentioned.
  const { kept, discarded } = verifiedCoverageVerdicts([{
    ...responsiveVerdict,
    reportLine: otherAnchoredLine,
    quote: "心血管占 57%",
  }], context());
  assert.equal(kept.length, 0);
  assert.equal(discarded.line_not_declared_by_entry, 1);
});

test("a gap-answered-in-verdict verdict must name a line inside 摘要, 结论 or 临床实践要点", () => {
  const built = context();
  const inConclusion = verifiedCoverageVerdicts([{
    entryId: "2.1",
    kind: "gap-answered-in-verdict",
    reportLine: abstractLine,
    quote: "含服自救药物后可先观察十分钟再决定是否呼叫急救",
    why: "该子问登记为空缺，摘要却给出了处置结论。",
  }], built);
  assert.equal(inConclusion.kept.length, 1);
  assert.equal(inConclusion.kept[0].section, "摘要");

  const inBody = verifiedCoverageVerdicts([{
    entryId: "2.1",
    kind: "gap-answered-in-verdict",
    reportLine: resultsAnchoredLine,
    quote: "发病风险比为 2.7",
    why: "结果一节给出了数字。",
  }], built);
  assert.equal(inBody.kept.length, 0);
  assert.equal(inBody.discarded.line_not_in_verdict_section, 1);
});

test("a false-gap verdict must name a paragraph that actually carries a claim anchor", () => {
  const built = context();
  const anchored = verifiedCoverageVerdicts([{
    entryId: "2.1",
    kind: "false-gap",
    reportLine: resultsAnchoredLine,
    quote: "发病风险比为 2.7",
    why: "登记为空缺，但结果一节已有挂着证据的答案。",
  }], built);
  assert.equal(anchored.kept.length, 1);

  const unanchored = verifiedCoverageVerdicts([{
    entryId: "2.1",
    kind: "false-gap",
    reportLine: conclusionLine,
    quote: "存在可重复的时间关联",
    why: "结论里有一句话。",
  }], built);
  assert.equal(unanchored.kept.length, 0);
  assert.equal(unanchored.discarded.line_not_anchored, 1);
});

// The largest false-positive class measured live: 12 of 109 verdicts reported a
// run for writing 「未检索到……」 in its conclusion, which is the sentence the
// coverage ledger exists to encourage. A gap charge whose own quotation says the
// search came back empty is refuted by its own evidence.
test("a gap charge whose quotation is itself an empty-search statement is discarded", () => {
  const built = context();
  const selfRefuting = verifiedCoverageVerdicts([{
    entryId: "2.1",
    kind: "gap-answered-in-verdict",
    reportLine: conclusionLine,
    quote: "未检索到排便场景下含服自救药物的前瞻性研究",
    why: "结论就这一子问给出了答案。",
  }], built);
  assert.equal(selfRefuting.kept.length, 0);
  assert.equal(selfRefuting.discarded.quote_states_retrieval_gap, 1);

  // The same shape as a false-gap charge: still refuted by its own quotation.
  assert.equal(
    verifiedCoverageVerdicts([{
      entryId: "2.1",
      kind: "false-gap",
      reportLine: otherAnchoredLine,
      quote: "未检索到住院人群的构成数据",
      why: "登记为空缺，正文其实有答案。",
    }], built).discarded.quote_states_retrieval_gap,
    1,
  );
});

test("an absence found inside a document already in hand is an answer, and survives", () => {
  const built = context();
  const kept = verifiedCoverageVerdicts([{
    entryId: "2.1",
    kind: "gap-answered-in-verdict",
    reportLine: conclusionLine,
    quote: "说明书未载该场景的用法",
    why: "说明书已取得并读过，它的沉默就是这一问的答案，不是检索空手。",
  }], built);
  assert.equal(kept.kept.length, 1);
  assert.equal(kept.kept[0].quote, "说明书未载该场景的用法");
});

test("an unresponsive-answer charge is not touched by the empty-search rule", () => {
  const built = context();
  // The charge here is "the line you cited answers something else", and a line
  // may say what it did not find while answering something else entirely.
  const kept = verifiedCoverageVerdicts([{
    entryId: "3.1",
    kind: "answer-not-responsive",
    reportLine: otherAnchoredLine,
    quote: "未检索到住院人群的构成数据",
    why: "题面第 3 问问的是未确诊冠心病人群，该行给的是基层门诊构成。",
  }], built);
  assert.equal(kept.kept.length, 1);
});

test("a quotation that is not verbatim from the line it names is discarded", () => {
  const built = context();
  assert.equal(
    verifiedCoverageVerdicts([{ ...responsiveVerdict, quote: "风险比大约是三倍左右" }], built).discarded.quote_not_verbatim,
    1,
  );
  // Whitespace is not content: the report writes 「2.7（95% CI 1.4–5.2）」 and a
  // model copying it back may not reproduce the spacing.
  assert.equal(
    verifiedCoverageVerdicts([{ ...responsiveVerdict, quote: "发病风险比为2.7" }], built).kept.length,
    1,
  );
  assert.equal(verifiedCoverageVerdicts([{ ...responsiveVerdict, quote: "2.7" }], built).discarded.quote_too_short, 1);
  assert.equal(verifiedCoverageVerdicts([{ ...responsiveVerdict, quote: 7 }], built).discarded.quote_too_short, 1);
});

test("a verdict with no reason, and a repeat of one already kept, are discarded", () => {
  const built = context();
  assert.equal(verifiedCoverageVerdicts([{ ...responsiveVerdict, why: "   " }], built).discarded.no_reason, 1);
  const repeated = verifiedCoverageVerdicts([responsiveVerdict, { ...responsiveVerdict, why: "同一条重复" }], built);
  assert.equal(repeated.kept.length, 1);
  assert.equal(repeated.discarded.duplicate, 1);
});

test("verdicts are capped, and the reason text is bounded", () => {
  const built = context();
  const many = Array.from({ length: 30 }, (_, index) => ({
    ...responsiveVerdict,
    reportLine: resultsAnchoredLine,
    why: `理由 ${index} ${"很".repeat(400)}`,
    // Distinct keys so deduplication is not what caps the list.
    entryId: index % 2 === 0 ? "1.1" : "3.1",
    quote: index % 2 === 0 ? "发病风险比为 2.7" : "心血管占 57%",
  }));
  const { kept } = verifiedCoverageVerdicts(many, built);
  assert.ok(kept.length <= 8, `kept ${kept.length} verdicts`);
  for (const verdict of kept) assert.ok(verdict.why.length <= 110);
});

test("each notice fits the run ledger's per-notice budget without cutting a quotation", () => {
  const { kept } = verifiedCoverageVerdicts([
    responsiveVerdict,
    {
      entryId: "2.1",
      kind: "gap-answered-in-verdict",
      reportLine: abstractLine,
      quote: "含服自救药物后可先观察十分钟再决定是否呼叫急救",
      why: "该子问登记为空缺，摘要却把处置写成了结论，读者会照做。".repeat(4),
    },
  ], context());
  const notices = coverageJudgeNotices(kept);
  assert.equal(notices.length, kept.length + 1);
  // agentRuns truncates a run-ledger notice at 300 characters.
  for (const notice of notices) assert.ok(notice.length <= 300, `notice was ${notice.length} characters`);
  assert.match(notices[0], /未经核对/, "the preamble must say which part nothing verified");
  assert.match(notices[1], /第 7 行/);
  assert.match(notices[1], /用力排便后一小时内发病风险比为 2\.7/);
  assert.deepEqual(coverageJudgeNotices([]), []);
});

// --- the model boundary ------------------------------------------------------

test("a judge that is disabled or unconfigured never calls the model and says nothing", async () => {
  for (const overrides of [{ coverageJudgeEnabled: false }, { deepseekProviderEnabled: false }, { deepseekApiKey: "" }]) {
    const fetchImpl = fetchReturning(JSON.stringify({ verdicts: [responsiveVerdict] }));
    const judge = new CoverageJudge(baseConfig(overrides), { fetchImpl });
    assert.equal(judge.available, false);
    const result = await judge.judge(context());
    assert.deepEqual(result, { notices: [], judged: false, verdicts: [] });
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test("an unjudgeable delivery costs no model call", async () => {
  const fetchImpl = fetchReturning(JSON.stringify({ verdicts: [] }));
  const judge = new CoverageJudge(baseConfig(), { fetchImpl });
  const result = await judge.judge(null);
  assert.deepEqual(result, { notices: [], judged: false, verdicts: [] });
  assert.equal(fetchImpl.calls.length, 0);
});

test("a verified verdict reaches the delivery as a notice", async () => {
  const fetchImpl = fetchReturning(JSON.stringify({ verdicts: [responsiveVerdict] }));
  const judge = new CoverageJudge(baseConfig(), { fetchImpl });
  const result = await judge.judge(context());
  assert.equal(result.judged, true);
  assert.equal(result.verdicts.length, 1);
  assert.match(result.notices.join("\n"), /台账条目 1\.1/);
  assert.equal(fetchImpl.calls.length, 1, "one delivery, one model call");
  assert.match(fetchImpl.calls[0].url, /\/chat\/completions$/);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.type, "json_object");
  assert.ok(body.max_tokens >= 8_000, "a reasoning model needs room to answer after it thinks");
  // The prompt carries the excerpt, not the report.
  assert.ok(!body.messages[1].content.includes("Verified clinical source"));
});

test("an empty verdict list is a judgement of nothing wrong, not a failure", async () => {
  const fetchImpl = fetchReturning(JSON.stringify({ verdicts: [] }));
  const judge = new CoverageJudge(baseConfig(), { fetchImpl });
  const result = await judge.judge(context());
  assert.deepEqual(result, { notices: [], judged: true, verdicts: [] });
  assert.equal(judge.lastFailure, null);
});

test("a judgement whose every verdict failed verification degrades in the open", async () => {
  // Silence here would read exactly like "checked, nothing found".
  const fetchImpl = fetchReturning(JSON.stringify({
    verdicts: [
      { ...responsiveVerdict, entryId: "9.9" },
      { ...responsiveVerdict, quote: "这句话报告里没有" },
    ],
  }));
  const judge = new CoverageJudge(baseConfig(), { fetchImpl });
  const result = await judge.judge(context());
  assert.equal(result.judged, false);
  assert.equal(result.verdicts.length, 0);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0], /未做语义覆盖判定/);
  assert.match(result.notices[0], /不因此扣留交付/);
  assert.equal(judge.lastFailure, "all_verdicts_unverifiable");
});

test("a partly unverifiable judgement keeps what survived", async () => {
  const fetchImpl = fetchReturning(JSON.stringify({
    verdicts: [{ ...responsiveVerdict, entryId: "9.9" }, responsiveVerdict],
  }));
  const judge = new CoverageJudge(baseConfig(), { fetchImpl });
  const result = await judge.judge(context());
  assert.equal(result.judged, true);
  assert.equal(result.verdicts.length, 1);
});

test("every model failure path degrades to a notice and never throws", async () => {
  const cases = [
    ["transport", new CoverageJudge(baseConfig(), { fetchImpl: async () => { throw new Error("network down"); } })],
    ["http", new CoverageJudge(baseConfig(), { fetchImpl: fetchReturning("{}", { ok: false, status: 503 }) })],
    ["unparseable", new CoverageJudge(baseConfig(), { fetchImpl: fetchReturning("not json at all") })],
    ["empty", new CoverageJudge(baseConfig(), { fetchImpl: fetchReturning("") })],
    ["wrong shape", new CoverageJudge(baseConfig(), { fetchImpl: fetchReturning(JSON.stringify({ ok: true })) })],
    ["bad envelope", new CoverageJudge(baseConfig(), { fetchImpl: async () => ({ ok: true, headers: { get: () => null }, text: async () => "<html>" }) })],
    ["oversized", new CoverageJudge(baseConfig(), {
      fetchImpl: async () => ({ ok: true, headers: { get: () => String(1024 * 1024) }, text: async () => "{}" }),
    })],
  ];
  for (const [name, judge] of cases) {
    const result = await judge.judge(context());
    assert.equal(result.judged, false, name);
    assert.equal(result.verdicts.length, 0, name);
    assert.equal(result.notices.length, 1, name);
    assert.match(result.notices[0], /未做语义覆盖判定/, name);
    assert.ok(judge.lastFailure, name);
  }
});

test("a judge that times out degrades rather than holding up the delivery", async () => {
  const judge = new CoverageJudge(baseConfig({ coverageJudgeTimeoutMs: 1_000 }), {
    fetchImpl: (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });
  const result = await judge.judge(context());
  assert.equal(judge.lastFailure, "timeout");
  assert.equal(result.judged, false);
  assert.match(result.notices[0], /未做语义覆盖判定/);
});

test("the verdict is read wherever a reasoning model left it", () => {
  assert.equal(parseJudgeVerdicts("```json\n{\"verdicts\":[]}\n```").length, 0);
  const reasoning = [
    "Entry 1.1 cites line 7, which reports an overall hazard ratio.",
    "Final answer: {\"verdicts\": [{\"entryId\": \"1.1\", \"kind\": \"answer-not-responsive\", \"reportLine\": 7, \"quote\": \"q\", \"why\": \"w\"}]}",
  ].join(" ");
  assert.equal(parseJudgeVerdicts(reasoning)?.length, 1);
  assert.equal(parseJudgeVerdicts("{\"verdicts\": \"nope\"}"), null);
  assert.equal(parseJudgeVerdicts(""), null);
  assert.equal(parseJudgeVerdicts(null), null);
});

test("a reasoning model's verdict list is recovered from reasoning_content", async () => {
  const fetchImpl = fetchReturning("", {
    reasoningContent: `Considering the ledger. Final answer: ${JSON.stringify({ verdicts: [responsiveVerdict] })}`,
  });
  const judge = new CoverageJudge(baseConfig(), { fetchImpl });
  const result = await judge.judge(context());
  assert.equal(result.verdicts.length, 1);
});

test("production judging may only reach the official provider origin", async () => {
  const judge = new CoverageJudge(
    baseConfig({ production: true, deepseekBaseUrl: "https://someone-elses-proxy.example.com" }),
    { fetchImpl: fetchReturning(JSON.stringify({ verdicts: [] })) },
  );
  const result = await judge.judge(context());
  assert.equal(result.judged, false);
  assert.match(result.notices[0], /未做语义覆盖判定/);
});
