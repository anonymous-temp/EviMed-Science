import assert from "node:assert/strict";
import test from "node:test";
import {
  FRONTIER_AI_MINUTE_INSTRUCTIONS,
  FRONTIER_DIGEST_INSTRUCTIONS,
  FRONTIER_EDITOR_VERSION,
  FRONTIER_EDIT_INSTRUCTIONS,
  FRONTIER_MODEL_INPUT_CHARS,
  FRONTIER_PROSE_ISSUE_KINDS,
  FRONTIER_SCREEN_INSTRUCTIONS,
  FRONTIER_TEXT_LIMITS,
  FrontierEditor,
  buildDigestInput,
  buildModelInput,
  isChineseProse,
  isChineseTitle,
  parseModelJson,
  sha256,
  trimToWholeSentences,
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

test("a batch the provider fails with an error status is not asked again entry by entry", async () => {
  // 2026-09-23: DeepSeek answered every call 402 for two hours, and each
  // failing batch of twenty was asked again whole and then one entry at a
  // time — 22 calls and 22 ledger rows a batch, booked uncertain then.
  /** @param {number} status @param {string} code */
  const provider = (status, code) => () => {
    throw Object.assign(new Error(`HTTP ${status}`), { code, upstreamStatus: status });
  };
  const spent = stubModel([provider(402, "model_gateway_payment_required")]);
  const balance = await new FrontierEditor(config, { owner, callModel: spent.callModel }).screen(batch(20));
  assert.equal(spent.calls.length, 1, "a spent balance is not different a second later");
  assert.deepEqual([...new Set(balance.errors.values())], ["model_gateway_payment_required"]);
  assert.equal(balance.errors.size, 20);

  const busy = stubModel([provider(503, "model_gateway_upstream_error"), provider(503, "model_gateway_upstream_error")]);
  const overloaded = new FrontierEditor(config, { owner, callModel: busy.callModel });
  const result = await overloaded.screen(batch(20));
  assert.equal(busy.calls.length, 2, "a 5xx is asked again once, whole, and not split into twenty more");
  assert.equal(result.errors.size, 20);
  assert.equal(overloaded.counters.screenSingles, 0);

  // A deadline is a provider wait too; shrinking twenty inputs must not spend
  // twenty more calls before the pipeline can record its cooldown.
  const slow = stubModel([refuse("frontier_model_timeout"), refuse("frontier_model_timeout"),
    () => verdicts(1), () => verdicts(1)]);
  const timed = await new FrontierEditor(config, { owner, callModel: slow.callModel }).screen(batch(2));
  assert.equal(slow.calls.length, 2);
  assert.equal(timed.verdicts.size, 0);
  assert.deepEqual([...timed.errors.values()],["frontier_model_timeout","frontier_model_timeout"]);
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

test("the edit asks for no 「为什么值得看」: the summary's last sentence carries what the item means, within three lines", () => {
  assert.doesNotMatch(FRONTIER_EDIT_INSTRUCTIONS, /reason_zh|为什么值得看/, "the field and its output key are gone");
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /summary_zh：两三句导读，不超过 120 个字/);
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /最后一句说明它对临床实践或科研意味着什么，只依据原文，不夸大/);
  assert.equal(FRONTIER_TEXT_LIMITS.summary, 140);
  assert.equal(Object.hasOwn(FRONTIER_TEXT_LIMITS, "reason"), false);
});

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
  assert.ok(result.modelInput.indexOf("术语") < result.modelInput.indexOf("摘要："), "the source text comes last");
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
    () => answer({ summary_zh: "心血管事件降低 30%，详见 https://example.org" }),
  ]);
  const kept = await new FrontierEditor(config, { owner, callModel: wrongTwice.callModel }).edit(item());
  assert.equal(kept.verification, "title-only");
  assert.equal(kept.output?.titleZh, "司美格鲁肽降低非糖尿病肥胖患者心血管事件 20%");
  assert.equal(kept.output?.summaryZh, null);
  assert.equal(Object.hasOwn(kept.output ?? {}, "reasonZh"), false, "「为什么值得看」 is no longer written at all");
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

// Three sentences of a summary: the first two are 89 code points, all three 152 (over the 140 limit).
const SENTENCE_1 = "一项纳入 17,604 例患者的研究显示，司美格鲁肽使主要不良心血管事件降低 20%，风险比 0.80，随访 39.8 个月。";
const SENTENCE_2 = "这一结果为无糖尿病的肥胖人群提供了心血管保护的证据。";
const SENTENCE_3 = "对于临床医生而言，这提示在评估此类患者的心血管风险时，可以把药物治疗纳入综合管理的考虑范围之内，并结合个体情况权衡获益与风险。";
const length = (/** @type {string} */ text) => [...text].length;

test("a length issue names the measured length, the limit and how much to cut — for the title and the summary", async () => {
  const modelInput = buildModelInput(item());
  const long = SENTENCE_1 + SENTENCE_2 + SENTENCE_3;
  assert.equal(length(long), 152);
  const summary = verifyEdit(answer({ summary_zh: long }), item(), modelInput);
  assert.deepEqual(summary.issues, ["summary_zh 太长：现在 152 个字，不能超过 140 个字，请删掉至少 12 个字（可以删去次要的限定语或英文全称，保留数字与结论）。"]);
  assert.deepEqual(summary.kinds, [{ field: "summary_zh", kind: "length" }]);
  const title = verifyEdit(answer({ title_zh: "司".repeat(75) }), item(), modelInput);
  assert.deepEqual(title.issues, ["title_zh 太长：现在 75 个字，不能超过 60 个字，请删掉至少 15 个字（可以删去次要的限定语或英文全称，保留数字与结论）。"]);
  assert.deepEqual(title.kinds, [{ field: "title_zh", kind: "length" }]);

  // …and the rewrite message the model receives carries it.
  const { calls, callModel } = stubModel([() => answer({ summary_zh: long }), () => answer()]);
  const result = await new FrontierEditor(config, { owner, callModel }).edit(item());
  assert.equal(result.verification, "repaired");
  assert.match(calls[1].body.messages[3].content, /- summary_zh 太长：现在 152 个字，不能超过 140 个字，请删掉至少 12 个字/);
});

test("every kind of failed Chinese text is named: empty, length, link, language, number", () => {
  const modelInput = buildModelInput(item());
  /** @param {Record<string, any>} overrides */
  const kinds = (overrides) => verifyEdit(answer(overrides), item(), modelInput).kinds;
  assert.deepEqual(kinds({ summary_zh: "" }), [{ field: "summary_zh", kind: "empty" }]);
  assert.deepEqual(kinds({ title_zh: "  " }), [{ field: "title_zh", kind: "empty" }]);
  assert.deepEqual(kinds({ summary_zh: "见 www.nejm.org 原文，降低 20%。" }), [{ field: "summary_zh", kind: "link" }]);
  assert.deepEqual(kinds({ summary_zh: "Semaglutide lowered events by 20%." }), [{ field: "summary_zh", kind: "language" }]);
  assert.deepEqual(kinds({ summary_zh: "心血管事件降低 25%。" }), [{ field: "summary_zh", kind: "number" }]);
  assert.deepEqual(kinds({ title_zh: "司美格鲁肽降低心血管事件 25%" }), [{ field: "title_zh", kind: "number" }]);
  assert.deepEqual(kinds({ summary_zh: "司".repeat(150) + " www.nejm.org" }).map(({ kind }) => kind), ["length", "link"]);
  assert.deepEqual(kinds({ lane: "ai" }), [], "a lane, specialties and the rest are not Chinese texts");
  assert.deepEqual(kinds({}), []);
  assert.deepEqual([...FRONTIER_PROSE_ISSUE_KINDS], ["empty", "length", "link", "language", "number"], "the closed set the counters are labelled with");
  const seen = new Set([
    ...kinds({ summary_zh: "" }), ...kinds({ summary_zh: "司".repeat(150) + " www.nejm.org" }),
    ...kinds({ summary_zh: "Semaglutide lowered events." }), ...kinds({ summary_zh: "降低 25%。" }),
  ].map(({ kind }) => kind));
  assert.deepEqual([...seen].sort(), [...FRONTIER_PROSE_ISSUE_KINDS].sort(), "every kind is produced, and none outside the set");
});

test("a rewrite whose summary is only too long is published with its whole sentences that fit, repaired", async () => {
  const long = SENTENCE_1 + SENTENCE_2 + SENTENCE_3;
  const { calls, callModel } = stubModel([() => answer({ summary_zh: `${long}${SENTENCE_3}` }), () => answer({ summary_zh: long })]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.edit(item());
  assert.equal(calls.length, 2, "one rewrite, then nothing more is paid for");
  assert.equal(result.verification, "repaired");
  assert.equal(result.attempts, 2);
  assert.equal(result.output?.summaryZh, SENTENCE_1 + SENTENCE_2, "the longest prefix of whole sentences within 140");
  assert.ok(length(result.output?.summaryZh ?? "") <= FRONTIER_TEXT_LIMITS.summary);
  // The rest of the answer stands as a verified answer's: it is not a title-only stand-in.
  assert.equal(result.output?.titleZh, "司美格鲁肽降低非糖尿病肥胖患者心血管事件 20%");
  assert.deepEqual(result.output?.scores, { impact: 26, novelty: 15, relevance: 17 });
  assert.deepEqual(result.output?.entities.drugs, ["司美格鲁肽"]);
  // The numbers were checked on the text that is published: 17,604, 20%, 0.80, 39.8 and the title's 20%.
  assert.deepEqual(result.numbers?.missing, []);
  assert.equal(result.numbers?.checked, 5);
  assert.ok(result.issues.some((issue) => issue.includes("太长")), "the length it was trimmed for stays on the result");
  assert.equal(editor.counters.summaryTrimmed, 1);
  assert.equal(editor.counters.verification.repaired, 1);
  assert.equal(editor.counters.verification["title-only"], 0);
  assert.deepEqual(editor.counters.finalIssues, {}, "an item that was published with a summary has no final issue");
  assert.deepEqual(editor.counters.firstPassIssues, { summary_zh: { length: 1 } });
});

test("with a single attempt, the first answer's too-long summary is trimmed the same way", async () => {
  const { calls, callModel } = stubModel([() => answer({ summary_zh: SENTENCE_1 + SENTENCE_2 + SENTENCE_3 })]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.edit(item(), { singleAttempt: true });
  assert.equal(calls.length, 1);
  assert.equal(result.verification, "repaired");
  assert.equal(result.output?.summaryZh, SENTENCE_1 + SENTENCE_2);
  assert.equal(editor.counters.summaryTrimmed, 1);
  assert.equal(editor.counters.rewrites, 0);
});

test("a rewrite that could not be had leaves the first answer's too-long summary trimmed, not dropped", async () => {
  const { callModel } = stubModel([() => answer({ summary_zh: SENTENCE_1 + SENTENCE_2 + SENTENCE_3 }), refuse("model_gateway_timeout")]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.edit(item());
  assert.equal(result.verification, "repaired");
  assert.equal(result.output?.summaryZh, SENTENCE_1 + SENTENCE_2);
  assert.equal(result.error, "model_gateway_timeout", "the failed rewrite is still on the record");
});

test("a too-long summary with no whole sentence under the limit stays title-only", async () => {
  // One sentence of 189 code points: nothing of it is a whole sentence within 140.
  const oneSentence = `${Array(3).fill(SENTENCE_3.slice(0, -1)).join("，")}。`;
  assert.equal(length(oneSentence), 189);
  const { callModel } = stubModel([() => answer({ summary_zh: oneSentence }), () => answer({ summary_zh: oneSentence })]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.edit(item());
  assert.equal(result.verification, "title-only");
  assert.equal(result.output?.summaryZh, null);
  assert.equal(result.output?.titleZh, "司美格鲁肽降低非糖尿病肥胖患者心血管事件 20%", "a title that passed on its own is kept, as ever");
  assert.equal(result.output?.scores, null);
  assert.ok(result.issues.some((issue) => issue.includes("现在 189 个字")));
  assert.equal(editor.counters.summaryTrimmed, 0);
  assert.deepEqual(editor.counters.finalIssues, { summary_zh: { length: 1 } });
});

test("a too-long summary that is also wrong another way is not trimmed: a link, a number, an empty one, another field", async () => {
  const long = SENTENCE_1 + SENTENCE_2 + SENTENCE_3;
  for (const [what, overrides] of /** @type {Array<[string, Record<string, any>]>} */ ([
    ["a link in the tail that would be dropped", { summary_zh: `${long} 详见 https://example.org` }],
    ["a number the source does not have", { summary_zh: `${long}另有 35% 的患者出现了不良反应。` }],
    ["a number the source does not have in the part that would be kept", { summary_zh: SENTENCE_1.replace("20%", "25%") + SENTENCE_2 + SENTENCE_3 }],
    ["not Chinese prose", { summary_zh: "Semaglutide reduced major adverse cardiovascular events by 20% in 17,604 patients. ".repeat(3) }],
    ["a lane outside the item's own", { summary_zh: long, lane: "ai" }],
    ["a title that failed too", { summary_zh: long, title_zh: "司美格鲁肽降低心血管事件 25%" }],
  ])) {
    const { callModel } = stubModel([() => answer(overrides), () => answer(overrides)]);
    const editor = new FrontierEditor(config, { owner, callModel });
    const result = await editor.edit(item());
    assert.equal(result.verification, "title-only", what);
    assert.equal(result.output?.summaryZh, null, what);
    assert.equal(editor.counters.summaryTrimmed, 0, what);
  }
});

test("the kind counters count each failed kind once per first answer, and the final ones the answer an item was left on", async () => {
  const long = SENTENCE_1 + SENTENCE_2 + SENTENCE_3;
  const english = "Semaglutide reduced major adverse cardiovascular events by 20% in 17,604 patients over 39.8 months. ".repeat(2);
  const editor = new FrontierEditor(config, { owner, callModel: stubModel([
    // 1: a link in the summary and a number in the title, twice → title-only.
    () => answer({ summary_zh: "司美格鲁肽使主要不良心血管事件降低 20%，详见 www.nejm.org。", title_zh: "司美格鲁肽降低心血管事件 25%" }),
    () => answer({ summary_zh: "司美格鲁肽使主要不良心血管事件降低 20%，详见 www.nejm.org。", title_zh: "司美格鲁肽降低心血管事件 25%" }),
    // 2: an empty summary, then a good one → repaired.
    () => answer({ summary_zh: "" }),
    () => answer(),
    // 3: three wrong numbers in one summary (one count), then too long and not Chinese → title-only.
    () => answer({ summary_zh: "降低 25%，随访 40 个月，纳入 99 例。" }),
    () => answer({ summary_zh: english }),
    // 4: too long → rewritten, still too long → trimmed.
    () => answer({ summary_zh: long }),
    () => answer({ summary_zh: long }),
  ]).callModel });
  for (let index = 0; index < 4; index += 1) await editor.edit(item());
  assert.deepEqual(editor.counters.firstPassIssues, {
    summary_zh: { link: 1, empty: 1, number: 1, length: 1 },
    title_zh: { number: 1 },
  });
  assert.deepEqual(editor.counters.finalIssues, {
    summary_zh: { link: 1, length: 1, language: 1 },
    title_zh: { number: 1 },
  });
  assert.equal(editor.counters.summaryTrimmed, 1);
  assert.deepEqual(editor.counters.verification, { passed: 0, repaired: 2, "title-only": 2, pending: 0 });
  assert.deepEqual(editor.counters.firstPassFailures, { summary_zh: 4, title_zh: 1 }, "the field counter is unchanged");
});

test("trimToWholeSentences keeps the longest prefix of whole sentences that fits, by a fixed set of sentence ends", () => {
  assert.equal(trimToWholeSentences("甲乙。丙丁。戊己。", 6), "甲乙。丙丁。");
  assert.equal(trimToWholeSentences("甲乙。丙丁。戊己。", 5), "甲乙。");
  assert.equal(trimToWholeSentences("甲乙。丙丁。戊己。", 9), "甲乙。丙丁。戊己。", "exactly the limit fits");
  assert.equal(trimToWholeSentences("甲乙。丙丁。", 2), null, "not even the first sentence fits");
  assert.equal(trimToWholeSentences("没有句号的一段话", 100), null, "no sentence end, no whole sentence");
  assert.equal(trimToWholeSentences("甲乙！丙丁？戊己。", 6), "甲乙！丙丁？");
  // A decimal point is not a sentence end; an ASCII stop, ! ? or ; before a space or the end is.
  assert.equal(trimToWholeSentences("风险比 0.80 提示获益。随访 39.8 个月。", 12), null);
  assert.equal(trimToWholeSentences("降低 20%. 风险比 0.80! 随访 39.8 个月", length("降低 20%. 风险比 0.80!")), "降低 20%. 风险比 0.80!");
  assert.equal(trimToWholeSentences("降低 20%. 风险比 0.80! 随访 39.8 个月", length("降低 20%.")), "降低 20%.");
  // …but an ASCII stop after a Latin letter is an abbreviation (vs., et al.), not an end.
  assert.equal(trimToWholeSentences("与安慰剂 vs. 对照相比降低风险。", length("与安慰剂 vs.")), null);
  assert.equal(trimToWholeSentences("与安慰剂 vs. 对照相比降低风险。", 100), "与安慰剂 vs. 对照相比降低风险。");
  // A semicolon ends a clause the reader takes as a sentence; a kept text does not end on one.
  assert.equal(trimToWholeSentences("降低 20%；风险比 0.80；随访 39.8 个月。", length("降低 20%；风险比 0.80；")), "降低 20%；风险比 0.80。");
  assert.equal(trimToWholeSentences("降低 20%; 风险比 0.80; 随访 39.8 个月。", length("降低 20%; 风险比 0.80;")), "降低 20%; 风险比 0.80。");
  // A closing quote or bracket belongs to the sentence it closes.
  assert.equal(trimToWholeSentences("结果为「阳性。」后续无关。", length("结果为「阳性。」")), "结果为「阳性。」");
  assert.equal(trimToWholeSentences("结果为阳性（见表 1。）后续无关。", length("结果为阳性（见表 1。）")), "结果为阳性（见表 1。）");
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
  assert.ok(issues({ summary_zh: "司".repeat(141) }).some((issue) => issue.includes("太长")), "three lines of forty, with room for a near miss: 140");
  assert.deepEqual(issues({ summary_zh: "司".repeat(140) }), []);
  assert.ok(issues({ summary_zh: "心血管事件降低 20%，见 www.nejm.org 原文。" }).some((issue) => issue.includes("链接")));
  // A retired 「为什么值得看」 an answer still carries is neither checked nor kept.
  assert.deepEqual(issues({ reason_zh: "见 www.nejm.org 原文 99%" }), []);
  assert.equal(Object.hasOwn(verifyEdit(answer({ reason_zh: "理由" }), item(), modelInput).output, "reasonZh"), false);
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

test("the edit input keeps generated drug names out of the hand-kept glossary", () => {
  // The generated pair is from the actual NMPA glossary; its product salt
  // must not receive the authority of the hand-kept substance/form names.
  const glossary = [
    { kind: "drug", termEn: "dexamethasone", termZh: "地塞米松磷酸钠", keepOriginal: false, origin: "nmpa-drug-list" },
    { kind: "drug", termEn: "testosterone", termZh: "睾酮", keepOriginal: false, origin: "hand" },
    { kind: "drug", termEn: "Testosterone gel", termZh: "睾酮凝胶", keepOriginal: false, origin: "hand" },
    { kind: "trial", termEn: "SELECT", termZh: "SELECT", keepOriginal: true },
  ];
  const original = structuredClone(glossary);
  const abstract = "Dexamethasone and Testosterone gel were the registered interventions.";
  const text = buildModelInput(item({ titleRaw: "Registered interventions", abstract, glossary }));
  const handStart = text.indexOf("手工术语表");
  const candidateStart = text.indexOf("自动生成术语候选");
  const sourceStart = text.indexOf("来源：");
  assert.ok(handStart >= 0 && candidateStart > handStart && sourceStart > candidateStart);
  assert.deepEqual(text.slice(handStart, candidateStart).split("\n").filter((line) => line.startsWith("- ")), [
    "- testosterone → 睾酮", "- Testosterone gel → 睾酮凝胶",
  ]);
  assert.deepEqual(text.slice(candidateStart, sourceStart).split("\n").filter((line) => line.startsWith("- ")), [
    "- dexamethasone → 地塞米松磷酸钠", "- SELECT：保留原文",
  ], "unknown provenance remains a candidate, including keep-original terms");
  assert.ok(text.endsWith(`摘要：${abstract}`), "the exact source text remains last");
  assert.ok(text.length <= FRONTIER_MODEL_INPUT_CHARS + 20);
  assert.deepEqual(glossary, original);
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

test("evidence relevance accepts skip reasons and preserves new/existing question decisions", async () => {
  const { calls, callModel } = stubModel([
    () => ({ skip: true, reason: "该来源不回答专区的抗凝问题。" }),
    () => ({ cardId: null }),
    () => ({ cardId: "known-card" }),
    () => ({ skip: true, reason: "" }),
    () => ({ cardId: "unknown-card" }),
  ]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const input = { zone: "房颤抗凝", description: "卒中预防、出血与适用边界。", background: "Primary-source evidence.",
    source: { title: "Right Atrial Ectopic Hepatic Tissue", text: "Retained source text.", coverage: "abstract" }, cards: [] };
  assert.deepEqual(await editor.evidenceTarget(input), { skip: true, reason: "该来源不回答专区的抗凝问题。" });
  assert.equal(await editor.evidenceTarget(input), null);
  input.cards.push({ id: "known-card" });
  assert.equal(await editor.evidenceTarget(input), "known-card");
  await assert.rejects(editor.evidenceTarget(input), { code: "evidence_target_invalid" });
  await assert.rejects(editor.evidenceTarget(input), { code: "evidence_target_invalid" });
  assert.equal(calls[0].purpose, "frontier");
  assert.equal(calls[0].body.max_tokens, 500);
  assert.equal(JSON.parse(calls[0].body.messages[1].content).description, input.description);
  assert.match(calls[0].body.messages[0].content, /Make this decision even when cards is empty/);
});

test("author gateway preserves DOMException timeout and frozen provider refusal causes without mutating errors", async () => {
  const original=new DOMException("Synthetic timeout","AbortError");
  const frozen=Object.freeze(Object.assign(new Error("Synthetic refusal"),{code:"model_gateway_payment_required",upstreamStatus:402}));
  for(const [cause,code,status] of [[original,"frontier_model_timeout",undefined],[frozen,"model_gateway_payment_required",402]]) {
    const editor=new FrontierEditor(config,{owner,callModel:async()=>{throw cause;}});
    await assert.rejects(editor.evidenceCard({sources:[]}),error=>{
      assert.equal(error.code,code);assert.equal(error.cause,cause);assert.equal(error.upstreamStatus,status);assert.notEqual(error.name,"TypeError");return true;
    });
    assert.equal(editor.counters.callFailures,1);assert.equal(editor.lastError,code);
  }
  assert.equal(original.code,20);
});

test("an incomplete author response cannot publish JSON from either final content or its reasoning",async()=>{
  const previous={title:"Previous card",summary:"Previous summary",body:"Previous body",limitations:"Previous limits",content:null};
  for(const finishReason of ["length","content_filter","tool_calls","unexpected",null]) {
    let calls=0;
    const editor=new FrontierEditor(config,{owner,callModel:async()=>{
      calls++;
      return {choices:[{finish_reason:finishReason,message:{content:JSON.stringify(previous),reasoning_content:JSON.stringify(previous)}}]};
    }});
    await assert.rejects(editor.evidenceCard({previous,sources:[]}),{code:"frontier_model_incomplete"});
    assert.equal(calls,1);
    assert.equal(editor.lastError,"frontier_model_incomplete");
  }
  const editor=new FrontierEditor(config,{owner,callModel:async()=>({choices:[{finish_reason:"length",message:{content:'{"title":"Unfinished',reasoning_content:JSON.stringify(previous)}}]})});
  await assert.rejects(editor.evidenceCard({previous,sources:[]}),{code:"frontier_model_incomplete"});
});

test("only evidence authors request bounded low thinking under the existing owner and frontier metering",async()=>{
  const final={title:"Final card",summary:"Final summary",body:"Final body",limitations:"Final limits",content:null};
  const {calls,callModel}=stubModel([()=>final,()=>({findings:[]}),()=>({skip:true,reason:"Unrelated evidence"}),()=>verdicts(1)]);
  const editor=new FrontierEditor(config,{owner,callModel});
  await editor.evidenceCard({sources:[]});
  await editor.evidenceReview({sources:[]});
  await editor.evidenceTarget({cards:[],source:{}});
  await editor.screen(batch(1));
  const author=calls[0];
  assert.deepEqual(author.body.thinking,{type:"enabled"});
  assert.equal(author.body.reasoning_effort,"low");
  assert.equal(author.body.max_tokens,16000);
  assert.equal(author.purpose,"frontier");
  assert.equal(author.userId,owner.userId);
  assert.equal(author.projectId,owner.projectId);
  assert.deepEqual(author.limits,{daily:0,weekly:0});
  assert.deepEqual(author.body.response_format,{type:"json_object"});
  assert.ok(author.signal instanceof AbortSignal);
  for(const call of calls.slice(1)) {
    assert.deepEqual(call.body.thinking,{type:"disabled"});
    assert.equal(call.body.reasoning_effort,undefined);
  }
});

test("explicit rewrites retain source and visual context without previous prose or mutating their input",async()=>{
  const previous={title:"Original title",summary:"Original summary",body:"Original body",limitations:"Original limitations",
    content:{question:"Original question",answer:"Original answer",population:"Original population",context:"Original context",nextStep:"Original next step",
      sections:[{title:"Old section",text:"Old prose",sourceIndexes:[1]}],
      tables:[{title:"Source counts",columns:["Group","Events"],rows:[["Control","10"]],sourceIndexes:[1]}],
      comparisons:[{title:"Observed events",outcome:"Events",timeframe:"Trial",denominator:100,control:{label:"Control",events:10},intervention:{label:"Intervention",events:5},sourceIndexes:[1]}]},
    sources:[{sourceIndex:1,title:"Primary trial",url:"https://example.org/trial"}]};
  const base={previous,zone:{title:"Methods"},sources:[{sourceIndex:1,title:"Primary trial",text:"Retained source",coverage:"abstract"}],
    readerQuestions:[{origin:"card-comment",text:"Clarify the comparison."}],previousFindings:[{kind:"limitation",text:"Clarify follow-up."}],sourceChecks:[{sourceIndex:1,status:"checked"}]};
  const final={title:"Final card",summary:"Final summary",body:"Final body",limitations:"Final limits",content:null};
  for(const flag of [true,false,undefined]) {
    const input={...structuredClone(base),...(flag===undefined?{}:{rewriteRequested:flag})};
    const before=structuredClone(input);
    const {calls,callModel}=stubModel([()=>final]);
    await new FrontierEditor(config,{owner,callModel}).evidenceCard(input);
    const sent=JSON.parse(calls[0].body.messages[1].content);
    assert.deepEqual(input,before,"building the author request must not change caller-owned state");
    for(const key of ["sources","readerQuestions","previousFindings","sourceChecks","zone"])assert.deepEqual(sent[key],before[key]);
    if(flag===true)assert.deepEqual(sent.previous,{title:previous.title,content:{question:previous.content.question,tables:previous.content.tables,comparisons:previous.content.comparisons},sources:previous.sources});
    else assert.deepEqual(sent.previous,before.previous,"ordinary maintenance keeps its prior context");
  }
});

test("only final message content supplies evidence JSON; absent finish reason remains compatible",async()=>{
  const final={title:"Final card",summary:"Final summary",body:"Final body",limitations:"Final limits",content:null};
  const reasoning={...final,title:"A draft mentioned in reasoning"};
  for(const ending of [{finish_reason:"stop"},{}]) {
    const editor=new FrontierEditor(config,{owner,callModel:async()=>({choices:[{...ending,message:{content:JSON.stringify(final),reasoning_content:JSON.stringify(reasoning)}}]})});
    assert.deepEqual(await editor.evidenceCard({sources:[]}),final);
  }
  for(const content of [undefined,'{"title":"Unfinished']) {
    const editor=new FrontierEditor(config,{owner,callModel:async()=>({choices:[{finish_reason:"stop",message:{content,reasoning_content:JSON.stringify(reasoning)}}]})});
    await assert.rejects(editor.evidenceCard({sources:[]}),{code:"evidence_author_invalid"});
  }
  const reviewer=new FrontierEditor(config,{owner,callModel:async()=>({choices:[{finish_reason:"stop",message:{content:null,reasoning_content:'{"findings":[]}'}}]})});
  await assert.rejects(reviewer.evidenceReview({sources:[]}),{code:"evidence_review_invalid"});
});

test("pending edits and screen errors preserve provider status and confirmed transport codes",async()=>{
  for (const original of [
    Object.assign(new Error("Provider refused"),{code:"model_gateway_upstream_error",upstreamStatus:429}),
    Object.assign(new Error("Provider refused"),{code:"model_gateway_upstream_error",upstreamStatus:503}),
    new TypeError("fetch failed",{cause:Object.assign(new Error("reset"),{code:"ECONNRESET"})}),
  ]) {
    const editor=new FrontierEditor(config,{owner,callModel:async()=>{throw original;}});
    const edited=await editor.edit(item());
    assert.equal(edited.verification,"pending");
    assert.equal(edited.upstreamStatus,original.upstreamStatus);
    assert.equal(edited.networkCode,original.cause?.code);
    const screened=await editor.screen(batch(1));
    assert.deepEqual(screened.providerErrors.get("e1"),{
      ...(original.upstreamStatus?{upstreamStatus:original.upstreamStatus}:{}),
      ...(original.cause?.code?{networkCode:original.cause.code}:{}),
    });
  }
});

test("confirmed timeout or network outage never fans a screening batch out into paid single calls",async()=>{
  for (const error of [
    new DOMException("Timeout","AbortError"),
    new TypeError("fetch failed",{cause:Object.assign(new Error("reset"),{code:"ECONNRESET"})}),
  ]) {
    let calls=0;
    const editor=new FrontierEditor(config,{owner,callModel:async()=>{calls++;throw error;}});
    const result=await editor.screen(batch(20));
    assert.equal(calls,2,"at most the original whole-batch retry; no per-entry requests");
    assert.equal(result.errors.size,20);
    assert.equal(editor.counters.screenSingles,0);
  }
});
