import assert from "node:assert/strict";
import test from "node:test";
import {
  FRONTIER_AI_MINUTE_INSTRUCTIONS,
  FRONTIER_DIGEST_INSTRUCTIONS,
  FRONTIER_EDITOR_VERSION,
  FRONTIER_EDIT_INSTRUCTIONS,
  FRONTIER_MODEL_INPUT_CHARS,
  FRONTIER_SCREEN_INSTRUCTIONS,
  FrontierEditor,
  buildDigestInput,
  buildModelInput,
  isChineseProse,
  isChineseTitle,
  parseModelJson,
  sha256,
  validateScreen,
  verifyEdit,
} from "../src/frontierEditor.mjs";

const config = { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", frontierModel: "deepseek-flash" };
const owner = { userId: "operator", projectId: "evimed-frontier" };

/** A model that answers from a queue; each answer sees the call it answers. */
function stubModel(/** @type {Array<(call: any) => any>} */ answers) {
  /** @type {any[]} */
  const calls = [];
  const callModel = async (/** @type {any} */ _deps, /** @type {any} */ call) => {
    calls.push(call);
    const answer = answers.shift();
    if (!answer) throw new Error("no more answers");
    const value = await answer(call);
    return { choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) } }] };
  };
  return { calls, callModel };
}

/** @param {string} code */
const refuse = (code) => () => { throw Object.assign(new Error(code), { code }); };

/** @param {number} count @param {string[]} [lanes] */
const batch = (count, lanes = ["evidence"]) => Array.from({ length: count }, (_, index) => ({
  key: `e${index + 1}`, title: `Title ${index + 1}`, sourceName: "NEJM", excerpt: "x".repeat(400), allowedLanes: lanes,
}));

/** @param {number} count */
const verdicts = (count, overrides = {}) => ({ items: Array.from({ length: count }, (_, index) => ({
  id: String(index + 1), medical: true, news: index % 2 === 0, lane: "evidence", specialties: ["cardiology"], language: "en", ...overrides,
})) });

test("a screening call is metered as frontier, thinking off, JSON, temperature 0, bounded output, charged to the internal project", async () => {
  const { calls, callModel } = stubModel([() => verdicts(3)]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.screen(batch(3));
  assert.equal(result.verdicts.size, 3);
  assert.deepEqual(result.verdicts.get("e2"), { medical: true, news: false, lane: "evidence", digest: false, specialties: ["cardiology"], language: "en" });
  const [call] = calls;
  assert.equal(call.purpose, "frontier");
  assert.equal(call.userId, "operator");
  assert.equal(call.projectId, "evimed-frontier");
  assert.deepEqual(call.limits, { daily: 0, weekly: 0 }, "the module's own budget governs, not the account's caps");
  assert.deepEqual(call.body.thinking, { type: "disabled" });
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.model, "deepseek-flash");
  assert.ok(call.body.max_tokens > 0 && call.body.max_tokens <= 4_000, "an explicit output bound");
  assert.ok(call.signal instanceof AbortSignal, "its own timeout");
  assert.equal(call.body.messages[0].content, FRONTIER_SCREEN_INSTRUCTIONS, "the stable prefix first, byte for byte");
  const sent = JSON.parse(call.body.messages[1].content);
  assert.equal(sent.items.length, 3);
  assert.equal(sent.items[0].excerpt, `${"x".repeat(300)}…`, "the first 300 characters, marked as cut");
  assert.deepEqual(sent.items[0].lanes, ["evidence"]);
});

test("a screening answer that is not one valid verdict per entry is asked again once, then entry by entry", async () => {
  // Wrong count, then an unknown lane for the whole batch, then one by one.
  const { calls, callModel } = stubModel([
    () => verdicts(2),
    () => verdicts(3, { lane: "gossip" }),
    () => ({ items: [{ id: "1", medical: true, news: true, lane: "evidence", specialties: [], language: "en" }] }),
    () => ({ items: [{ id: "1", medical: false, news: false, lane: "evidence", specialties: ["astrology"], language: "en" }] }),
    () => ({ items: [{ id: "1", medical: true, news: true, lane: "evidence", specialties: ["oncology", "hematology", "pharmacy", "radiology"], language: "zh" }] }),
  ]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.screen(batch(3));
  assert.equal(calls.length, 5);
  assert.deepEqual([...result.verdicts.keys()], ["e1", "e3"]);
  assert.equal(result.errors.get("e2"), "frontier_screen_invalid", "an unknown specialty is not a verdict");
  assert.deepEqual(result.verdicts.get("e3")?.specialties, ["oncology", "hematology", "pharmacy"], "ordered by relevance, the first three kept");
  assert.equal(editor.counters.screenRetries, 1);
  assert.equal(editor.counters.screenSingles, 3);
});

test("a spent budget is not asked again, and an editor without an owner makes no call", async () => {
  const spent = stubModel([refuse("usage_budget_exceeded")]);
  const editor = new FrontierEditor(config, { owner, callModel: spent.callModel });
  const result = await editor.screen(batch(4));
  assert.equal(spent.calls.length, 1);
  assert.equal(result.verdicts.size, 0);
  assert.deepEqual([...result.errors.values()], Array(4).fill("usage_budget_exceeded"));

  const none = stubModel([]);
  const ownerless = new FrontierEditor(config, { callModel: none.callModel });
  assert.equal(ownerless.available, false);
  const unowned = await ownerless.screen(batch(2));
  assert.equal(none.calls.length, 0);
  assert.equal(unowned.errors.get("e1"), "frontier_editor_unavailable");
  ownerless.owner = owner;
  assert.equal(ownerless.available, true, "the owner may be assigned once the internal project exists");
  assert.equal(new FrontierEditor({ ...config, deepseekApiKey: "" }, { owner }).available, false);
});

test("screening says whether a piece covers several stories, and it defaults to one", () => {
  const batch = [{ key: "a", title: "Pharmalittle: two read-outs and more", sourceName: "STAT", allowedLanes: ["evidence", "pipeline"] }];
  const digest = validateScreen(batch, { items: [{ id: "1", medical: true, news: true, lane: "pipeline", specialties: [], language: "en", digest: true }] });
  assert.equal(digest?.get("a")?.digest, true);
  const single = validateScreen(batch, { items: [{ id: "1", medical: true, news: true, lane: "pipeline", specialties: [], language: "en" }] });
  assert.equal(single?.get("a")?.digest, false, "an answer without the field is one story");
  assert.match(FRONTIER_SCREEN_INSTRUCTIONS, /digest/);
});

test("screening validation: same count, every id once, lanes within the entry's own, booleans, a language code", () => {
  const input = batch(2, ["regulatory"]);
  const good = { items: [
    { id: "2", medical: true, news: true, lane: "regulatory", specialties: [], language: "zh" },
    { id: 1, medical: false, news: false, lane: "regulatory", specialties: [], language: "EN" },
  ] };
  assert.equal(validateScreen(input, good)?.get("e1")?.language, "en");
  for (const broken of [
    { items: [good.items[0]] },
    { items: [good.items[0], { ...good.items[0] }] },
    { items: [good.items[0], { ...good.items[1], lane: "evidence" }] },
    { items: [good.items[0], { ...good.items[1], medical: "yes" }] },
    { items: [good.items[0], { ...good.items[1], language: "english" }] },
    { items: [good.items[0], { ...good.items[1], id: "7" }] },
    null,
  ]) assert.equal(validateScreen(input, broken), null, JSON.stringify(broken));
});

/** @param {Record<string, any>} [overrides] */
function item(overrides = {}) {
  return {
    titleRaw: "Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes",
    sourceName: "NEJM", sourceTypeLabel: "期刊", publishedAt: "2026-09-20T00:00:00.000Z", datePrecision: "day",
    isChinese: false, allowedLanes: ["evidence"], evidenceFixed: null,
    abstract: "In 17,604 patients, semaglutide reduced major adverse cardiovascular events by 20% (hazard ratio 0.80) over 39.8 months.",
    summary: null, bodyExcerpt: null, journal: "N Engl J Med", publicationTypes: ["Randomized Controlled Trial"],
    trialFacts: { phase: "Phase 3", enrollment: 17604 },
    glossary: [{ kind: "drug", termEn: "semaglutide", termZh: "司美格鲁肽", keepOriginal: false }, { kind: "trial", termEn: "SELECT", termZh: "SELECT", keepOriginal: true }],
    defaults: { lane: "evidence", specialties: ["cardiology"] },
    ...overrides,
  };
}

/** @param {Record<string, any>} [overrides] */
function answer(overrides = {}) {
  return {
    title_zh: "司美格鲁肽降低非糖尿病肥胖患者心血管事件 20%",
    summary_zh: "一项纳入 17,604 例患者的研究显示，司美格鲁肽使主要不良心血管事件降低 20%，风险比 0.80，随访 39.8 个月。",
    reason_zh: "为无糖尿病的肥胖患者心血管预防提供 RCT 证据。",
    lane: "evidence", specialties: ["cardiology", "endocrinology"], evidence_type: "rct",
    entities: { drugs: ["司美格鲁肽"], trials: ["SELECT"], orgs: [], diseases: ["肥胖"] },
    scores: { impact: 26, novelty: 15, relevance: 17 }, flags: [],
    ...overrides,
  };
}

test("an edit that passes every check is published as written, with what the model was shown and its hash", async () => {
  const { calls, callModel } = stubModel([() => answer()]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.edit(item());
  assert.equal(result.verification, "passed");
  assert.deepEqual(editor.counters.numberCheck, { first: 1, firstFailed: 0 });
  assert.equal(result.attempts, 1);
  assert.equal(result.output?.titleZh, "司美格鲁肽降低非糖尿病肥胖患者心血管事件 20%");
  assert.deepEqual(result.output?.scores, { impact: 26, novelty: 15, relevance: 17 });
  assert.equal(result.modelInputSha256, sha256(result.modelInput));
  assert.equal(result.editorVersion, FRONTIER_EDITOR_VERSION);
  const [call] = calls;
  assert.equal(call.body.messages[0].content, FRONTIER_EDIT_INSTRUCTIONS, "the long stable prefix first");
  assert.equal(call.body.messages[1].content, result.modelInput, "the item last, exactly what is stored");
  assert.match(result.modelInput, /- semaglutide → 司美格鲁肽/, "the glossary entries the text names");
  assert.match(result.modelInput, /- SELECT：保留原文/);
  assert.ok(result.modelInput.indexOf("术语表") < result.modelInput.indexOf("摘要："), "the source text comes last");
  assert.equal(result.numbers?.checked, 5, "20% in the title; 17,604, 20%, 0.80 and 39.8 in the summary");
  assert.deepEqual(result.numbers?.missing, []);
});

test("a number the source does not state is sent back once, by name; a correct rewrite is repaired", async () => {
  const { calls, callModel } = stubModel([
    () => answer({ summary_zh: "司美格鲁肽使心血管事件降低 25%，覆盖 1.8 万名患者。" }),
    () => answer(),
  ]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.edit(item());
  assert.equal(result.verification, "repaired");
  assert.equal(result.attempts, 2);
  assert.deepEqual(editor.counters.numberCheck, { first: 1, firstFailed: 1 }, "the number check's own first-pass count");
  const rewrite = calls[1].body.messages;
  assert.equal(rewrite.length, 4, "the prefix, the item, the first answer, the issues");
  assert.equal(rewrite[2].role, "assistant");
  assert.match(rewrite[3].content, /summary_zh 里的数字「25%」在原文里找不到相等的数字/);
  assert.match(rewrite[3].content, /「1\.8 万」/);
});

test("a rewrite that fails again leaves the title only — and only a title that passed on its own", async () => {
  const wrongTwice = stubModel([
    () => answer({ summary_zh: "心血管事件降低 25%。" }),
    () => answer({ summary_zh: "心血管事件降低 30%。", reason_zh: "重要！见 https://example.org" }),
  ]);
  const kept = await new FrontierEditor(config, { owner, callModel: wrongTwice.callModel }).edit(item());
  assert.equal(kept.verification, "title-only");
  assert.equal(kept.output?.titleZh, "司美格鲁肽降低非糖尿病肥胖患者心血管事件 20%");
  assert.equal(kept.output?.summaryZh, null);
  assert.equal(kept.output?.reasonZh, null);
  assert.equal(kept.output?.scores, null, "an unverified answer's scores are not used");
  assert.deepEqual(kept.output?.entities.drugs, ["司美格鲁肽"], "structure that passed its own checks is kept");
  assert.ok(kept.issues.some((issue) => issue.includes("链接")));

  const titleWrong = stubModel([
    () => answer({ title_zh: "司美格鲁肽降低心血管事件 25%", summary_zh: "降低 25%。" }),
    () => answer({ title_zh: "Semaglutide cuts MACE by a fifth", summary_zh: "降低 30%。" }),
  ]);
  const dropped = await new FrontierEditor(config, { owner, callModel: titleWrong.callModel }).edit(item());
  assert.equal(dropped.verification, "title-only");
  assert.equal(dropped.output?.titleZh, null, "neither title passed: the original title stands alone");
});

test("a Chinese source keeps its own title; the model's title is not used or checked", async () => {
  const { callModel } = stubModel([() => answer({ title_zh: "完全不同的标题 99%" })]);
  const result = await new FrontierEditor(config, { owner, callModel }).edit(item({
    titleRaw: "国家药监局批准司美格鲁肽新适应症", isChinese: true,
    abstract: "国家药监局批准司美格鲁肽用于降低心血管事件风险，纳入 17,604 例患者，事件降低 20%，风险比 0.80，随访 39.8 个月。",
  }));
  assert.equal(result.verification, "passed");
  assert.equal(result.output?.titleZh, "国家药监局批准司美格鲁肽新适应症");
  assert.match(result.modelInput, /中文信源：是/);
});

test("an evidence type code has decided is the one used, whatever the model says", async () => {
  const { callModel } = stubModel([() => answer({ evidence_type: "observational" })]);
  const result = await new FrontierEditor(config, { owner, callModel }).edit(item({ evidenceFixed: { type: "rct", basis: "pubmed-types" } }));
  assert.equal(result.output?.evidenceType, "rct");
  assert.match(result.modelInput, /证据类型：rct（已由程序确定，照填）/);
});

test("no answer is pending, not title-only: a failed call is tried once more, a spent budget not at all", async () => {
  const down = stubModel([refuse("model_gateway_upstream_error"), refuse("model_gateway_timeout")]);
  const failed = await new FrontierEditor(config, { owner, callModel: down.callModel }).edit(item());
  assert.equal(failed.verification, "pending");
  assert.equal(failed.error, "model_gateway_timeout");
  assert.equal(failed.output, null);
  assert.equal(down.calls.length, 2);

  const spent = stubModel([refuse("usage_budget_exceeded")]);
  const budget = await new FrontierEditor(config, { owner, callModel: spent.callModel }).edit(item());
  assert.equal(budget.verification, "pending");
  assert.equal(spent.calls.length, 1);

  const unparsable = stubModel([() => "not json at all", () => answer()]);
  const repaired = await new FrontierEditor(config, { owner, callModel: unparsable.callModel }).edit(item());
  assert.equal(repaired.verification, "repaired", "an answer that is not JSON is an issue, sent back like any other");
});

test("the verification's other checks: vocabularies, lengths, links, Chinese prose, entity caps, flags", () => {
  const modelInput = buildModelInput(item());
  /** @param {Record<string, any>} overrides */
  const issues = (overrides) => verifyEdit(answer(overrides), item(), modelInput).issues;
  assert.deepEqual(issues({}), []);
  assert.ok(issues({ lane: "ai" }).some((issue) => issue.includes("lane 必须是以下之一：evidence")));
  assert.ok(issues({ specialties: "cardiology" }).some((issue) => issue.includes("specialties")));
  // Format slips are put right, not sent back (2026-09-22: most rewrites were these):
  // a key outside the vocabulary is dropped, a sixth entity cut, a score past its scale clamped.
  assert.deepEqual(issues({ specialties: ["cardiology", "astrology"] }), []);
  assert.deepEqual(verifyEdit(answer({ specialties: ["cardiology", "astrology"] }), item(), modelInput).output.specialties, ["cardiology"]);
  assert.ok(issues({ evidence_type: "anecdote" }).some((issue) => issue.includes("evidence_type")));
  assert.ok(issues({ summary_zh: "司".repeat(161) }).some((issue) => issue.includes("太长")));
  assert.ok(issues({ reason_zh: "见 www.nejm.org 原文" }).some((issue) => issue.includes("链接")));
  assert.ok(issues({ reason_zh: "An important randomized trial for obesity care" }).some((issue) => issue.includes("中文")));
  const six = { drugs: ["a", "b", "c", "d", "e", "f"], trials: [], orgs: [], diseases: [] };
  assert.deepEqual(issues({ entities: six }), []);
  assert.deepEqual(verifyEdit(answer({ entities: six }), item(), modelInput).output.entities.drugs, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(issues({ scores: { impact: 31, novelty: 2, relevance: 2 } }), []);
  assert.deepEqual(verifyEdit(answer({ scores: { impact: 31, novelty: -1, relevance: 25 } }), item(), modelInput).output.scores,
    { impact: 30, novelty: 0, relevance: 20 });
  assert.ok(issues({ scores: { impact: 3.5, novelty: 2, relevance: 2 } }).some((issue) => issue.includes("整数")));
  assert.ok(issues({ flags: ["sponsored"] }).some((issue) => issue.includes("flags")));
  assert.deepEqual(verifyEdit(answer({ flags: ["preprint", "press-release"] }), item(), modelInput).output.flags, ["press-release"],
    "a flag code decides is dropped, not failed");
  assert.deepEqual(verifyEdit(null, item(), modelInput).failed.has("answer"), true);
});

test("the item text: labelled lines, the glossary, trial facts, no date when it was inferred, bounded", () => {
  const text = buildModelInput(item({ datePrecision: "inferred", bodyExcerpt: "正文".repeat(5_000) }));
  assert.doesNotMatch(text, /发布日期/);
  assert.match(text, /试验信息：分期 Phase 3；入组 17604/);
  assert.ok(text.length <= FRONTIER_MODEL_INPUT_CHARS + 20, `${text.length} characters`);
  assert.match(buildModelInput(item()), /发布日期：2026-09-20/);
  assert.match(buildModelInput(item({ allowedLanes: ["evidence", "ai"] })), /允许的栏目：evidence（临床证据）、ai（AI 与医学）/);
});

test("reading an answer: fenced, wrapped in prose, or not JSON at all", () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Here it is: {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.equal(parseModelJson("[1,2]"), null);
  assert.equal(parseModelJson(""), null);
  assert.equal(parseModelJson(undefined), null);
});

test("what reads as Chinese: prose with drug codes is Chinese; a Japanese title is not a Chinese source's", () => {
  assert.equal(isChineseProse("SGLT2 抑制剂 DAPA-HF 试验结果"), true);
  assert.equal(isChineseProse("An English sentence 中"), false);
  assert.equal(isChineseTitle("国家药监局发布药物警戒快讯"), true);
  assert.equal(isChineseTitle("糖尿病の新しい治療"), false);
  assert.equal(isChineseTitle("Semaglutide in obesity"), false);
});

test("the editor version names the prompts: it changes when a prompt does", () => {
  assert.match(FRONTIER_EDITOR_VERSION, /^frontier-editor-1\.[a-f0-9]{12}$/);
  for (const vocabulary of ["cardiology 心血管", "rct RCT", "evidence 临床证据", "ai AI 与医学"]) {
    assert.ok(FRONTIER_EDIT_INSTRUCTIONS.includes(vocabulary), vocabulary);
  }
  assert.doesNotMatch(FRONTIER_EDIT_INSTRUCTIONS, /\{\{|undefined/, "no unfilled template");
});

const reports = [
  { role: "report", sourceName: "STAT", sourceTypeLabel: "媒体", publishedAt: "2026-09-21T08:00:00Z", titleRaw: "Semaglutide trial shows 20% fewer events",
    titleZh: "司美格鲁肽试验显示事件减少 20%", summaryZh: "媒体报道称事件减少 20%。" },
  { role: "primary", sourceName: "NEJM", sourceTypeLabel: "期刊", publishedAt: "2026-09-20T00:00:00Z", titleRaw: "Semaglutide and Cardiovascular Outcomes",
    titleZh: "司美格鲁肽与心血管结局", summaryZh: "17,604 例患者中，主要不良心血管事件降低 20%。", text: "Hazard ratio 0.80 in 17,604 patients." },
];

test("an event digest: primary sources first, numbers checked against the reports, the previous version kept when it fails", async () => {
  const input = buildDigestInput({ reports, previousDigest: "此前报道称降低 15%。" });
  assert.ok(input.indexOf("[1] 一手来源｜NEJM") < input.indexOf("[2] 报道｜STAT"), "the primary source is first");
  assert.match(input, /上一版综述：此前报道称降低 15%。/);
  const good = stubModel([() => ({ digest_zh: "NEJM 发表的试验纳入 17,604 例患者，主要不良心血管事件降低 20%，风险比 0.80。（与此前说法不同：此前称降低 15%。）",
    latest_zh: "STAT 报道了事件减少 20% 的结果。" })]);
  const editor = new FrontierEditor(config, { owner, callModel: good.callModel });
  const written = await editor.writeEventDigest({ reports, previousDigest: "此前报道称降低 15%。" });
  assert.equal(written.verification, "passed");
  assert.match(written.digestZh ?? "", /17,604/);
  assert.equal(good.calls[0].body.messages[0].content, FRONTIER_DIGEST_INSTRUCTIONS);
  assert.equal(good.calls[0].purpose, "frontier");
  assert.equal(written.modelInputSha256, sha256(written.modelInput));

  const wrong = stubModel([
    () => ({ digest_zh: "事件降低 25%。", latest_zh: "最新进展。" }),
    () => ({ digest_zh: "事件降低 30%。", latest_zh: "最新进展。" }),
  ]);
  const dropped = await new FrontierEditor(config, { owner, callModel: wrong.callModel }).writeEventDigest({ reports });
  assert.equal(dropped.verification, "dropped");
  assert.equal(dropped.digestZh, null, "nothing unverified is returned: the caller keeps its previous digest");
  assert.ok(dropped.issues.some((issue) => issue.includes("「30%」")));
  assert.match(wrong.calls[1].body.messages[3].content, /「25%」/);
});

test("the daily's AI minute: written from verified AI items only, skipped without any", async () => {
  const none = stubModel([]);
  const editor = new FrontierEditor(config, { owner, callModel: none.callModel });
  const skipped = await editor.writeDaily({ day: "2026-09-22", items: [{ titleRaw: "No summary", sourceName: "X" }] });
  assert.equal(skipped.verification, "skipped");
  assert.equal(none.calls.length, 0);
  const minute = stubModel([() => ({ ai_minute_zh: "一个医学 AI 模型在 3 家医院的回顾性验证中表现稳定，对影像科医生分诊有参考价值。" })]);
  const written = await new FrontierEditor(config, { owner, callModel: minute.callModel }).writeDaily({ day: "2026-09-22", items: [
    { titleRaw: "AI triage model validated", titleZh: "AI 分诊模型完成验证", summaryZh: "该模型在 3 家医院的回顾性数据中完成验证。", sourceName: "Lancet Digital Health" },
  ] });
  assert.equal(written.verification, "passed");
  assert.match(written.aiMinuteZh ?? "", /3 家医院/);
  assert.equal(minute.calls[0].body.messages[0].content, FRONTIER_AI_MINUTE_INSTRUCTIONS);
  assert.match(minute.calls[0].body.messages[1].content, /\[1\] Lancet Digital Health｜AI 分诊模型完成验证/);
});

test("an item with nothing but its title gets no summary rather than its title again", () => {
  // First live run (2026-09-22): every text-less notice came back with a
  // summary that restated its title. The input now says 「正文：无」, and an
  // empty summary is accepted there — and only there.
  const bare = item({ abstract: null, summary: null, bodyExcerpt: null });
  const bareInput = buildModelInput(bare);
  assert.match(bareInput, /正文：无/);
  const withoutSummary = verifyEdit(answer({ summary_zh: "" }), bare, bareInput);
  assert.deepEqual(withoutSummary.issues, []);
  assert.equal(withoutSummary.output.summaryZh, null);
  const full = item();
  const fullInput = buildModelInput(full);
  assert.doesNotMatch(fullInput, /正文：无/);
  assert.ok(verifyEdit(answer({ summary_zh: "" }), full, fullInput).issues.some((issue) => issue.includes("summary_zh 不能为空")));
});
