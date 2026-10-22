import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FRONTIER_EVIDENCE_TYPES } from "@evimed/domain";
import {
  FRONTIER_AI_MINUTE_INSTRUCTIONS,
  FRONTIER_DIGEST_INSTRUCTIONS,
  FRONTIER_EDITOR_VERSION,
  FRONTIER_EDIT_INSTRUCTIONS,
  FRONTIER_MODEL_INPUT_CHARS,
  FRONTIER_PROSE_ISSUE_KINDS,
  FRONTIER_SCREEN_INSTRUCTIONS,
  FRONTIER_TEXT_LIMITS,
  FRONTIER_TRANSLATE_BODY_INSTRUCTIONS,
  FRONTIER_TRANSLATE_POST_INSTRUCTIONS,
  FRONTIER_TRANSLATION_LIMITS,
  FrontierEditor,
  abstractNumberSource,
  aiMinuteNumberSource,
  buildAbstractInput,
  buildAiMinuteInput,
  buildDigestInput,
  buildModelInput,
  frontierEditorDiagnostics,
  digestNumberSource,
  editNumberSource,
  frontierParagraphs,
  isChineseProse,
  isChineseTitle,
  parseModelJson,
  sha256,
  trimToWholeSentences,
  validateScreen,
  verifyAbstract,
  verifyEdit,
  verifyParagraph,
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

test("the edit asks for an answer-first 导读 and a 推荐理由 that says what a reader can do with the item, never why it was picked", () => {
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /summary_zh：导读，两三句，不超过 200 个字，答案前置：第一句直接说清这条消息的核心/);
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /reason_zh：推荐理由，一句话，45 到 70 个字，写给临床医生、药师或研究者：读了这条可以拿它做什么/);
  // The cause of the 2026-09-24 retirement — a line about the feed's own choice («为什么值得看», 「为什么入选」) — is what the prompt rules out.
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /不写为什么入选、为什么推荐或值不值得读，不评价本平台/);
  assert.doesNotMatch(FRONTIER_EDIT_INSTRUCTIONS, /为什么值得看/);
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /支持不了具体的阅读价值时给空字符串/, "an empty reason is an answer");
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /"reason_zh":"","tags":\[\]/, "both keys are in the output shape");
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /主题词表：糖尿病、2型糖尿病/, "the topics' tags are offered in the stable prefix");
  assert.equal(FRONTIER_TEXT_LIMITS.summary, 220);
  assert.deepEqual([FRONTIER_TEXT_LIMITS.reasonMin, FRONTIER_TEXT_LIMITS.reason, FRONTIER_TEXT_LIMITS.tags], [20, 90, 7]);
});

test("the 推荐理由 is checked on its own: a failed reason is dropped, the answer is not sent back for it, and it rides along when the answer is", async () => {
  const modelInput = buildModelInput(item());
  const good = "肥胖但无糖尿病的心血管高危患者，可据此评估加用司美格鲁肽做二级预防的获益与胃肠道耐受。";
  const kept = verifyEdit(answer({ reason_zh: good }), item(), modelInput);
  assert.deepEqual([kept.issues, kept.reasonIssues, kept.output.reasonZh], [[], [], good]);
  for (const [what, reason, kind] of /** @type {Array<[string, string, string]>} */ ([
    ["too long", "司".repeat(95), "length"], ["too short", "可参考。", "length"], ["a link", `${good}见 www.nejm.org`, "link"],
    ["not Chinese", "Clinicians can use this to weigh semaglutide for secondary prevention in obesity.", "language"],
    ["a number the source lacks", "肥胖患者心血管事件可降低 35%，可据此评估加用司美格鲁肽做二级预防。", "number"],
  ])) {
    const verified = verifyEdit(answer({ reason_zh: reason }), item(), modelInput);
    assert.deepEqual(verified.issues, [], `${what}: the answer itself passes`);
    assert.equal(verified.output.reasonZh, null, `${what}: the reason is dropped`);
    assert.ok(verified.reasonKinds.includes(/** @type {any} */ (kind)), what);
  }
  assert.equal(verifyEdit(answer({ reason_zh: "" }), item(), modelInput).output.reasonZh, null, "empty is an answer, not a failure");

  // A reason alone never pays for a rewrite.
  const once = stubModel([() => answer({ reason_zh: "司".repeat(95) })]);
  const editor = new FrontierEditor(config, { owner, callModel: once.callModel });
  const passed = await editor.edit(item());
  assert.equal(once.calls.length, 1);
  assert.equal(passed.verification, "passed");
  assert.equal(passed.output?.reasonZh, null);
  assert.deepEqual(editor.counters.reasonDropped, { length: 1 });
  // When the answer is sent back for something else, the reason's issue goes with it, and the rewrite's reason is the one kept.
  const twice = stubModel([() => answer({ title_zh: "司美格鲁肽降低心血管事件 25%", reason_zh: "可参考。" }), () => answer({ reason_zh: good })]);
  const repaired = await new FrontierEditor(config, { owner, callModel: twice.callModel }).edit(item());
  assert.equal(repaired.verification, "repaired");
  assert.match(twice.calls[1].body.messages[3].content, /- reason_zh 太短/);
  assert.equal(repaired.output?.reasonZh, good);
});

test("tags are short names kept or dropped one by one: no sentence, no link, no number the source lacks, seven at most", () => {
  const modelInput = buildModelInput(item());
  const tags = (/** @type {unknown} */ value) => verifyEdit(answer({ tags: value }), item(), modelInput);
  assert.deepEqual(tags(["GLP-1 受体激动剂", "肥胖", "#心血管预防"]).output.tags, ["GLP-1 受体激动剂", "肥胖", "心血管预防"]);
  assert.deepEqual(tags(["肥胖", "肥胖", "见 www.nejm.org", "降低了心血管事件，效果明显", "降低 35%", "甲", "司".repeat(17)]).output.tags, ["肥胖"]);
  assert.deepEqual(tags(["随访 39.8 个月"]).output.tags, ["随访 39.8 个月"], "a number the source states may stand");
  assert.deepEqual(tags(["一", "二二", "三三", "四四", "五五", "六六", "七七", "八八", "九九"].slice(1)).output.tags.length, 7);
  assert.deepEqual(tags("肥胖").output.tags, [], "not an array: no tags, and no failure");
  assert.deepEqual(tags("肥胖").issues, []);
});

test("D-04: the edit prompt says a design the vocabulary has no key for is `other`, never the nearest design — and the cases that hold it load", async () => {
  // Production, 2026-10-10: 「多准则决策分析评估NSCLC全面基因组检测价值」 was typed observational by the model (basis model, PubMed type only
  // Journal Article) because nothing told it what to do with a design the list lacks; the authority term of that label let it be selected.
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /研究设计不在词表里的（卫生经济学评价、决策分析、建模、方法学研究、问卷调查、病例报告）一律填 other，不要套用最接近的设计/);
  assert.ok(FRONTIER_EVIDENCE_TYPES.includes("other"), "the key the rule points at is in the vocabulary");
  assert.equal(FRONTIER_EDIT_INSTRUCTIONS.split("\n").filter((line) => line.includes("一律填 other")).length, 1, "one line, not a second rule");

  const cases = JSON.parse(await readFile(new URL("../../../evals/frontier-editing/cases.json", import.meta.url), "utf8"));
  assert.deepEqual([cases.lane.length, cases.same_event.length], [5, 11], "the sections the other readers use are as they were");
  assert.equal(cases.evidence_type[0].id, "synthetic-mcda-genomic-testing");
  assert.equal(cases.evidence_type[0].public_id, "5a5fed19cd8ee71f", "the incident's own item");
  for (const entry of cases.evidence_type) {
    assert.ok(entry.expect.length > 0 && entry.expect.every((type) => FRONTIER_EVIDENCE_TYPES.includes(type)), entry.id);
    assert.ok(entry.why.length > 20, entry.id);
    // The case goes through the editor's own input builder, and an answer typed `other` is a verified edit of it.
    const input = buildModelInput({ ...entry.edit, allowedLanes: ["evidence"] });
    assert.match(input, /^允许的栏目：evidence/);
    assert.ok(input.endsWith(`摘要：${entry.edit.abstract}`), `${entry.id}: the abstract is the last, whole`);
    const verified = verifyEdit(answer({ title_zh: "一项研究的评价", summary_zh: "", evidence_type: "other" }), { ...entry.edit, allowedLanes: ["evidence"] }, input);
    assert.equal(verified.output.evidenceType, "other", entry.id);
    assert.ok(!verified.failed.has("evidence_type"), entry.id);
  }
});

test("F12c: the edit prompt lets the editor propose a boxed warning, once, only for one a safety notice adds or strengthens; a flag outside the model's list is sent back by name", () => {
  // The owner's ruling of 2026-10-10 sends a Class I recall or a boxed-warning alert to every reader with the push on. A recall's class is
  // a field of the record (code reads it); a boxed warning is language, so the editor judges it and code keeps the answer closed.
  assert.equal(FRONTIER_EDIT_INSTRUCTIONS.split("\n").filter((line) => line.includes("boxed-warning")).length, 1, "one line, not a second rule");
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /新增、加强或要求加框警告/);
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /已有的、放宽或取消的黑框警告不算/);
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /"press-release"/, "the first flag is still there, unchanged");
  const refused = verifyEdit(answer({ flags: ["sponsored"] }), item(), buildModelInput(item()));
  assert.ok(refused.failed.has("flags"));
  assert.ok(refused.issues.some((issue) => issue.includes("press-release") && issue.includes("boxed-warning")), "the rewrite is told what a flag may be");
});

test("F12c: the eval has cases that hold the boxed-warning judgement, both ways: added or strengthened, and everything near it that is not", async () => {
  const cases = JSON.parse(await readFile(new URL("../../../evals/frontier-editing/cases.json", import.meta.url), "utf8"));
  const ids = cases.flags.map((/** @type {any} */ entry) => entry.id);
  assert.deepEqual(ids, ["synthetic-fda-adds-boxed-warning", "synthetic-nmpa-adds-boxed-warning-zh", "synthetic-boxed-warning-removed",
    "synthetic-label-revision-without-boxed-warning", "synthetic-existing-boxed-warning-mentioned", "synthetic-class-ii-recall"]);
  for (const entry of cases.flags) {
    assert.ok(entry.expect.every((/** @type {string} */ flag) => ["boxed-warning"].includes(flag)), entry.id);
    assert.ok(entry.expect_not.every((/** @type {string} */ flag) => ["boxed-warning"].includes(flag)), entry.id);
    assert.equal(entry.expect.length + entry.expect_not.length, 1, `${entry.id}: one judgement each`);
    assert.ok(entry.why.length > 20 && /F12c/.test(entry.why), entry.id);
    assert.equal(entry.edit.evidenceFixed.type, "safety-notice", "a safety feed's items arrive with their type fixed by code");
    const input = buildModelInput({ ...entry.edit, allowedLanes: ["safety"] });
    assert.match(input, /^允许的栏目：safety/);
    assert.match(input, /证据类型：safety-notice（已由程序确定，照填）/);
  }
  assert.deepEqual(cases.flags.filter((/** @type {any} */ entry) => entry.expect.length).map((/** @type {any} */ entry) => entry.id),
    ["synthetic-fda-adds-boxed-warning", "synthetic-nmpa-adds-boxed-warning-zh"], "two ways it is added, an English notice and a Chinese one");
  assert.equal(cases.flags.find((/** @type {any} */ entry) => entry.id === "synthetic-nmpa-adds-boxed-warning-zh").edit.isChinese, true);
});

test("F12a: every economic evaluation and decision analysis the owner named has an eval case that expects `other`, and two controls hold the real designs", async () => {
  // The owner's ruling of 2026-10-10 (review B, D-04): a multi-criteria decision analysis, a Markov cost-effectiveness model, a budget
  // impact analysis and a discrete-event simulation are economic evaluation or decision analysis, never a cohort or a trial. The first
  // two cases came with the prompt line; the rest are what the line is held by, and the two that follow tempt the nearest design with
  // the data the model was built on (a trial's curves, a registry's rates). The controls make the line unable to pass by sending
  // everything to `other`.
  const cases = JSON.parse(await readFile(new URL("../../../evals/frontier-editing/cases.json", import.meta.url), "utf8"));
  const byId = new Map(cases.evidence_type.map((/** @type {any} */ entry) => [entry.id, entry]));
  assert.equal(byId.size, cases.evidence_type.length, "no case id twice");
  const economic = ["synthetic-mcda-genomic-testing", "synthetic-cost-effectiveness-model", "synthetic-budget-impact-analysis", "synthetic-discrete-event-simulation",
    "synthetic-partitioned-survival-cost-utility", "synthetic-screening-microsimulation"];
  for (const id of economic) {
    assert.ok(byId.has(id), `${id} is an eval case`);
    assert.deepEqual(byId.get(id).expect, ["other"], id);
  }
  assert.deepEqual(cases.evidence_type.map((/** @type {any} */ entry) => entry.id), [...economic, "synthetic-pharmacist-survey",
    "synthetic-control-prospective-cohort", "synthetic-control-randomised-trial"], "the section, in the order it is read");
  assert.deepEqual(byId.get("synthetic-pharmacist-survey").expect, ["other"]);
  assert.deepEqual(byId.get("synthetic-control-prospective-cohort").expect, ["observational"]);
  assert.deepEqual(byId.get("synthetic-control-randomised-trial").expect, ["rct"]);
  // Each case is a distinct abstract: a second copy of one text would count one answer twice.
  assert.equal(new Set(cases.evidence_type.map((/** @type {any} */ entry) => entry.edit.abstract)).size, cases.evidence_type.length);
  for (const id of economic.slice(2)) assert.match(byId.get(id).why, /F12a/, `${id} says which ruling it holds`);
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
  assert.equal(kept.output?.reasonZh, null, "no verified 导读, no 推荐理由");
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

// Three sentences of a summary: the first two are 158 code points, all three 221 (over the 220 limit).
const SENTENCE_1 = "一项纳入 17,604 例患者的研究显示，司美格鲁肽使主要不良心血管事件降低 20%，风险比 0.80，随访 39.8 个月。";
const SENTENCE_2 = "这一结果为无糖尿病的肥胖人群提供了心血管保护的证据，覆盖了既往心肌梗死、卒中和外周动脉疾病的患者，主要终点的获益在各个预设亚组中方向一致，安全性方面胃肠道不良反应导致停药的比例高于安慰剂组。";
const SENTENCE_3 = "对于临床医生而言，这提示在评估此类患者的心血管风险时，可以把药物治疗纳入综合管理的考虑范围之内，并结合个体情况权衡获益与风险。";
const length = (/** @type {string} */ text) => [...text].length;

test("a length issue names the measured length, the limit and how much to cut — for the title and the summary", async () => {
  const modelInput = buildModelInput(item());
  const long = SENTENCE_1 + SENTENCE_2 + SENTENCE_3;
  assert.equal(length(long), 221);
  const summary = verifyEdit(answer({ summary_zh: long }), item(), modelInput);
  assert.deepEqual(summary.issues, ["summary_zh 太长：现在 221 个字，不能超过 220 个字，请删掉至少 1 个字（可以删去次要的限定语或英文全称，保留数字与结论）。"]);
  assert.deepEqual(summary.kinds, [{ field: "summary_zh", kind: "length" }]);
  const title = verifyEdit(answer({ title_zh: "司".repeat(75) }), item(), modelInput);
  assert.deepEqual(title.issues, ["title_zh 太长：现在 75 个字，不能超过 60 个字，请删掉至少 15 个字（可以删去次要的限定语或英文全称，保留数字与结论）。"]);
  assert.deepEqual(title.kinds, [{ field: "title_zh", kind: "length" }]);

  // …and the rewrite message the model receives carries it.
  const { calls, callModel } = stubModel([() => answer({ summary_zh: long }), () => answer()]);
  const result = await new FrontierEditor(config, { owner, callModel }).edit(item());
  assert.equal(result.verification, "repaired");
  assert.match(calls[1].body.messages[3].content, /- summary_zh 太长：现在 221 个字，不能超过 220 个字，请删掉至少 1 个字/);
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
  assert.deepEqual(kinds({ summary_zh: "司".repeat(230) + " www.nejm.org" }).map(({ kind }) => kind), ["length", "link"]);
  assert.deepEqual(kinds({ lane: "ai" }), [], "a lane, specialties and the rest are not Chinese texts");
  assert.deepEqual(kinds({}), []);
  assert.deepEqual([...FRONTIER_PROSE_ISSUE_KINDS], ["empty", "length", "link", "language", "number"], "the closed set the counters are labelled with");
  const seen = new Set([
    ...kinds({ summary_zh: "" }), ...kinds({ summary_zh: "司".repeat(230) + " www.nejm.org" }),
    ...kinds({ summary_zh: "Semaglutide lowered events." }), ...kinds({ summary_zh: "降低 25%。" }),
  ].map(({ kind }) => kind));
  assert.deepEqual([...seen].sort(), [...FRONTIER_PROSE_ISSUE_KINDS].sort(), "every kind is produced, and none outside the set");
});

test("D-06: a number the source does not state is not found in the lines the platform wrote around the source: the date, the names, the glossary", () => {
  // The review's example: an abstract that states only a hazard ratio and its interval, published on 2026-10-09. The summary
  // below invents a count (10) and a date (2026, 10), which the 「发布日期：2026-10-09」 line used to supply.
  const bare = item({ abstract: "Hazard ratio 0.80 (95% CI 0.70 to 0.92).", publishedAt: "2026-10-09T00:00:00.000Z", trialFacts: null, journal: "Journal 2026" });
  const input = buildModelInput(bare);
  assert.match(input, /发布日期：2026-10-09/, "the model is still told the date");
  const invented = verifyEdit(answer({ title_zh: "司美格鲁肽的心血管结局研究", summary_zh: "试验入组 10 例患者，事件减少 20%。2026 年 10 月发表。" }), bare, input);
  assert.equal(invented.numbers.checked, 4);
  assert.deepEqual(invented.numbers.missing.map(({ raw }) => raw), ["10", "20%", "2026", "10"]);
  assert.deepEqual(invented.kinds, [{ field: "summary_zh", kind: "number" }, { field: "summary_zh", kind: "number" }, { field: "summary_zh", kind: "number" }, { field: "summary_zh", kind: "number" }]);
  // What the source states passes, in the title and the summary.
  const stated = verifyEdit(answer({ title_zh: "司美格鲁肽风险比 0.80", summary_zh: "风险比 0.80（95% 置信区间 0.70 至 0.92）。" }), bare, input);
  assert.deepEqual(stated.issues, []);
  assert.equal(stated.numbers.checked, 5);
  // The trial facts and the body excerpt are source lines too.
  const facts = item({ abstract: "Hazard ratio 0.80.", bodyExcerpt: "Median follow-up was 33 months.", trialFacts: { phase: "Phase 3", enrollment: 17604 } });
  assert.deepEqual(verifyEdit(answer({ title_zh: "司美格鲁肽的心血管结局研究", summary_zh: "该试验入组 17604 例患者，随访中位数 33 个月。" }), facts, buildModelInput(facts)).issues, []);
  // …and the picked lines are exactly those, in the order the input has them.
  assert.equal(editNumberSource(input), ["标题：Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes", "摘要：Hazard ratio 0.80 (95% CI 0.70 to 0.92)."].join("\n"));
  assert.equal(editNumberSource(buildModelInput(facts)).split("\n").map((line) => line.split("：")[0]).join(","), "试验信息,标题,摘要,正文节选");
});

test("D-06: a digest and an AI minute are held to the reports' and items' own words, not to their dates and numbering", async () => {
  const digestInput = buildDigestInput({ reports, previousDigest: "此前报道称降低 15%。" });
  assert.deepEqual(digestNumberSource(digestInput).split("\n").map((line) => line.split("：")[0]),
    ["上一版综述", "标题", "中文标题", "导读", "原文", "标题", "中文标题", "导读"], "the numbering and the dated header lines are not source");
  const dated = stubModel([
    () => ({ digest_zh: "2026 年 9 月 21 日，STAT 报道了试验结果，NEJM 发表的试验降低 20%。", latest_zh: "最新进展。" }),
    () => ({ digest_zh: "2026 年 9 月 21 日，STAT 报道了试验结果，NEJM 发表的试验降低 20%。", latest_zh: "最新进展。" }),
  ]);
  const droppedDigest = await new FrontierEditor(config, { owner, callModel: dated.callModel }).writeEventDigest({ reports });
  assert.equal(droppedDigest.verification, "dropped", "a date only the header states is a number the reports do not state");
  assert.deepEqual(droppedDigest.issues.map((issue) => issue.match(/「(\d+)」/)?.[1]), ["2026", "9", "21"]);

  const items = [{ titleRaw: "AI triage model validated", titleZh: "AI 分诊模型完成验证", summaryZh: "该模型在 3 家医院的回顾性数据中完成验证。", sourceName: "Lancet Digital Health" }];
  const minuteInput = buildAiMinuteInput({ day: "2026-09-22", items });
  assert.equal(aiMinuteNumberSource(minuteInput), "AI 分诊模型完成验证\n导读：该模型在 3 家医院的回顾性数据中完成验证。", "the day, the numbering and the source name are not source");
  const wrongDay = stubModel([() => ({ ai_minute_zh: "9 月 22 日发布的模型在 3 家医院完成验证。" }), () => ({ ai_minute_zh: "9 月 22 日发布的模型在 3 家医院完成验证。" })]);
  const droppedMinute = await new FrontierEditor(config, { owner, callModel: wrongDay.callModel }).writeDaily({ day: "2026-09-22", items });
  assert.equal(droppedMinute.verification, "dropped");
  assert.deepEqual(droppedMinute.issues.map((issue) => issue.match(/「(\d+)」/)?.[1]), ["9", "22"]);
});

test("D-06: the Chinese abstract is held to the title and the abstract, not to the glossary lines between them", () => {
  const input = buildAbstractInput({ titleRaw: "Cohort outcomes", abstract: "Results are reported for the primary cohort.\n\nMortality was 12%.",
    glossary: [{ termEn: "cohort", termZh: "第 7 队列", keepOriginal: false }] });
  assert.match(input, /- cohort → 第 7 队列/);
  assert.equal(abstractNumberSource(input), "标题：Cohort outcomes\n摘要：Results are reported for the primary cohort.\n\nMortality was 12%.", "the abstract keeps its paragraphs");
  assert.deepEqual(verifyAbstract({ abstract_zh: "主要队列的结果见下。\n死亡率为 12%。" }, input).issues, []);
  const glossaryOnly = verifyAbstract({ abstract_zh: "结果见第 7 队列。\n死亡率为 12%。" }, input);
  assert.equal(glossaryOnly.issues.length, 1);
  assert.match(glossaryOnly.issues[0], /「7」在原文里找不到/);
});

test("a rewrite whose summary is only too long is published with its whole sentences that fit, repaired", async () => {
  const long = SENTENCE_1 + SENTENCE_2 + SENTENCE_3;
  const { calls, callModel } = stubModel([() => answer({ summary_zh: `${long}${SENTENCE_3}` }), () => answer({ summary_zh: long })]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.edit(item());
  assert.equal(calls.length, 2, "one rewrite, then nothing more is paid for");
  assert.equal(result.verification, "repaired");
  assert.equal(result.attempts, 2);
  assert.equal(result.output?.summaryZh, SENTENCE_1 + SENTENCE_2, "the longest prefix of whole sentences within 220");
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
  // One sentence of 252 code points: nothing of it is a whole sentence within 220.
  const oneSentence = `${Array(4).fill(SENTENCE_3.slice(0, -1)).join("，")}。`;
  assert.equal(length(oneSentence), 252);
  const { callModel } = stubModel([() => answer({ summary_zh: oneSentence }), () => answer({ summary_zh: oneSentence })]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.edit(item());
  assert.equal(result.verification, "title-only");
  assert.equal(result.output?.summaryZh, null);
  assert.equal(result.output?.titleZh, "司美格鲁肽降低非糖尿病肥胖患者心血管事件 20%", "a title that passed on its own is kept, as ever");
  assert.equal(result.output?.scores, null);
  assert.ok(result.issues.some((issue) => issue.includes("现在 252 个字")));
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
  const english = "Semaglutide reduced major adverse cardiovascular events by 20% in 17,604 patients over 39.8 months. ".repeat(3);
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
  assert.ok(issues({ summary_zh: "司".repeat(221) }).some((issue) => issue.includes("太长")), "200 asked, with room for a near miss: 220");
  assert.deepEqual(issues({ summary_zh: "司".repeat(220) }), []);
  assert.ok(issues({ summary_zh: "心血管事件降低 20%，见 www.nejm.org 原文。" }).some((issue) => issue.includes("链接")));
  // A 推荐理由 that fails its own checks fails nothing else, and is not kept.
  assert.deepEqual(issues({ reason_zh: "见 www.nejm.org 原文 99%" }), []);
  assert.equal(verifyEdit(answer({ reason_zh: "理由" }), item(), modelInput).output.reasonZh, null);
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
  assert.deepEqual(verifyEdit(answer({ flags: ["class-i-recall", "boxed-warning", "china"] }), item(), modelInput).output.flags, ["boxed-warning"],
    "a boxed warning is the model's to propose; a recall's class and every other mark are code's");
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
  // (The title is numberless: the default answer's 「20%」 used to pass here on the 20th of 「发布日期：2026-09-20」, a number the
  // title-only source does not state — D-06.)
  const withoutSummary = verifyEdit(answer({ title_zh: "司美格鲁肽与心血管结局", summary_zh: "" }), bare, bareInput);
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


test("edit diagnostics preserve actual field outcomes without model prose", async () => {
  const editor = new FrontierEditor(config, { owner, callModel: stubModel([
    () => answer({ summary_zh: "English summary", title_zh: "司美格鲁肽降低心血管事件 20%" }),
    () => answer({ summary_zh: "English summary", title_zh: "English title" }),
  ]).callModel });
  const result = await editor.edit(item());
  assert.equal(result.output?.titleZh, "司美格鲁肽降低心血管事件 20%");
  assert.deepEqual(result.fieldDiagnostics, { title_zh: ["passed"], summary_zh: ["language"] });
  assert.equal(result.attempts, 2);
  assert.equal(result.modelInputSha256, sha256(result.modelInput));
  assert.ok(!JSON.stringify(result.fieldDiagnostics).includes("English"));
});

test("source-only items distinguish missing source text from rejected summaries", async () => {
  const result = await new FrontierEditor(config, { owner, callModel: stubModel([() => answer({ title_zh: "司美格鲁肽研究", summary_zh: null })]).callModel })
    .edit({ ...item(), abstract: null, summary: null, bodyExcerpt: null });
  assert.deepEqual(result.fieldDiagnostics, { title_zh: ["passed"], summary_zh: ["source_missing"] });
});


test("public diagnostics reject unknown content and retain only closed bounded metadata", () => {
  assert.equal(frontierEditorDiagnostics({}), null);
  const kept = frontierEditorDiagnostics({ schemaVersion: 1, outcome: "title-only", attempts: 9999,
    inputSha256: "a".repeat(64), editorVersion: "policy:v2", checkedAt: "2026-10-20T00:00:00Z",
    reason: "private upstream message", answer: "private model answer", fields: {
      title_zh: ["language", "language", "private body"], summary_zh: ["number"], private: ["answer"] } });
  assert.deepEqual(kept, { schemaVersion: 1, outcome: "title-only", attempts: null,
    inputSha256: "a".repeat(64), editorVersion: "policy:v2", checkedAt: "2026-10-20T00:00:00.000Z", reason: null,
    fields: { title_zh: ["language"], summary_zh: ["number"] } });
});

test("pending and repaired diagnostics reflect the last actual field check", async () => {
  const pending = await new FrontierEditor(config, { owner, callModel: stubModel([refuse("usage_budget_exceeded")]).callModel }).edit(item());
  assert.equal(pending.attempts, 1);
  assert.deepEqual(pending.fieldDiagnostics, { title_zh: ["not_checked"], summary_zh: ["not_checked"] });
  const repaired = await new FrontierEditor(config, { owner, callModel: stubModel([
    () => answer({ title_zh: "English title", summary_zh: "English summary" }), () => answer(),
  ]).callModel }).edit(item());
  assert.equal(repaired.verification, "repaired");
  assert.deepEqual(repaired.fieldDiagnostics, { title_zh: ["passed"], summary_zh: ["passed"] });
});


test("diagnostic provenance uses the resolved policy and actual bounded calls", async () => {
  const editor = new FrontierEditor(config, { owner, callModel: stubModel([() => answer()]).callModel,
    policies: { resolve: async (_module, policy) => ({ revisionId: "policy:v2", policy }) } });
  const result = await editor.edit(item());
  assert.equal(result.editorVersion,"policy:v2");
  assert.equal(result.attempts,1);
  assert.equal(result.modelInputSha256,sha256(result.modelInput));
});

test("the full text is split into the paragraphs a reader sees, losslessly: blank lines, then line breaks, then sentence ends, then the limit", () => {
  assert.deepEqual(frontierParagraphs("A para.\n\nB line1\nB line2\n\n\n  C  x "), ["A para.", "B line1\nB line2", "C x"]);
  const long = "HR 0.80 (95% CI 0.70-0.92). Results were consistent. 结果一致。".repeat(60);
  const pieces = frontierParagraphs(long);
  assert.ok(pieces.length > 1 && pieces.every((piece) => piece.length <= FRONTIER_TRANSLATION_LIMITS.paragraphChars));
  assert.equal(pieces.join("").replace(/\s/g, ""), long.replace(/\s/g, ""), "nothing is lost at a cut");
  assert.deepEqual(frontierParagraphs(""), []);
  assert.deepEqual(frontierParagraphs(null), []);
});

test("a translated paragraph is held to its own original: Chinese, bounded, no number added and none dropped", () => {
  const original = "In 17,604 patients, semaglutide reduced events by 20% (hazard ratio 0.80).";
  assert.equal(verifyParagraph("在 17,604 例患者中，司美格鲁肽使事件减少 20%（风险比 0.80）。", original), "在 17,604 例患者中，司美格鲁肽使事件减少 20%（风险比 0.80）。");
  assert.equal(verifyParagraph("在 17,604 例患者中，司美格鲁肽使事件减少 25%（风险比 0.80）。", original), null, "a number the original lacks");
  assert.equal(verifyParagraph("在患者中，司美格鲁肽使事件减少 20%（风险比 0.80）。", original), null, "a number the original states is gone");
  assert.equal(verifyParagraph("In 17,604 patients, semaglutide reduced events by 20% (hazard ratio 0.80).", original), null, "not translated");
  assert.equal(verifyParagraph("", original), null);
  assert.equal(verifyParagraph("译".repeat(400), "Short text here."), null, "far longer than its original");
  assert.equal(verifyParagraph("NCT01234567", "NCT01234567"), "NCT01234567", "nothing to translate comes back as it was");
});

test("translateBody: one translation per paragraph or none trusted; refused paragraphs asked once more; complete only when all came back", async () => {
  const paragraphs = ["Semaglutide reduced events by 20%.", "Adverse events occurred in 12% of patients.", "The trial enrolled adults with obesity."];
  const good = ["司美格鲁肽使事件减少 20%。", "12% 的患者发生不良事件。", "该试验纳入了肥胖成人。"];
  // First answer: the second paragraph adds a number; the retry asks for it alone and gets it right.
  const { calls, callModel } = stubModel([() => ({ t: [good[0], "15% 的患者发生不良事件。", good[2]] }), () => ({ t: [good[1]] })]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const result = await editor.translateBody({ paragraphs, glossary: [{ kind: "drug", termEn: "semaglutide", termZh: "司美格鲁肽", keepOriginal: false, origin: "hand" }] });
  assert.deepEqual(result, { paragraphs: good, complete: true, calls: 2, error: null });
  assert.equal(calls[0].purpose, "frontier");
  assert.equal(calls[0].body.messages[0].content, FRONTIER_TRANSLATE_BODY_INSTRUCTIONS);
  const asked = JSON.parse(calls[0].body.messages[1].content);
  assert.deepEqual(asked.p, paragraphs);
  assert.ok(asked.glossary.some((line) => line.includes("semaglutide → 司美格鲁肽")));
  assert.deepEqual(JSON.parse(calls[1].body.messages[1].content).p, [paragraphs[1]], "only the refused paragraph is asked again");
  assert.deepEqual(editor.counters.translatedParagraphs, 3);

  // A count that does not match trusts nothing; a paragraph refused twice stays untranslated, and the result is not complete.
  const shifted = stubModel([() => ({ t: [good[0], good[1]] }), () => ({ t: [...good, "死亡率为 99%。"] })]);
  const partial = await new FrontierEditor(config, { owner, callModel: shifted.callModel }).translateBody({ paragraphs: [...paragraphs, "Mortality was 3%."] });
  assert.equal(shifted.calls.length, 2, "the whole answer was refused, so every paragraph was asked once more");
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.paragraphs, [...good, null]);

  // A call that cannot be made stops the item with its code, keeping what was verified.
  const refused = await new FrontierEditor(config, { owner, callModel: stubModel([refuse("usage_budget_exceeded")]).callModel }).translateBody({ paragraphs });
  assert.deepEqual([refused.complete, refused.error, refused.paragraphs], [false, "usage_budget_exceeded", [null, null, null]]);
});

test("translateBody stops asking past the item's limit, in calls of bounded size, and an X post takes the post shape", async () => {
  const paragraph = `${"Results were consistent across all prespecified subgroups. ".repeat(30)}`.trim();
  const paragraphs = Array.from({ length: 10 }, () => paragraph);
  const { calls, callModel } = stubModel(Array.from({ length: 20 }, () => (/** @type {any} */ call) => ({ t: JSON.parse(call.body.messages[1].content).p.map(() => "各预设亚组的结果一致。") })));
  const result = await new FrontierEditor(config, { owner, callModel }).translateBody({ paragraphs });
  const asked = calls.flatMap((call) => JSON.parse(call.body.messages[1].content).p);
  assert.ok(asked.length * paragraph.length <= FRONTIER_TRANSLATION_LIMITS.itemChars, "never past the item's limit");
  assert.ok(calls.every((call) => JSON.parse(call.body.messages[1].content).p.join("").length <= FRONTIER_TRANSLATION_LIMITS.callChars + paragraph.length));
  assert.equal(result.complete, false, "the paragraphs past the limit are not translated");
  assert.equal(result.paragraphs.filter(Boolean).length, asked.length);

  const post = stubModel([() => ({ t: ["@nejm 新试验：司美格鲁肽使事件减少 20%。#obesity"] })]);
  const translated = await new FrontierEditor(config, { owner, callModel: post.callModel }).translateBody({ paragraphs: ["@nejm New trial: semaglutide cut events by 20%. #obesity"], post: true });
  assert.equal(post.calls[0].body.messages[0].content, FRONTIER_TRANSLATE_POST_INSTRUCTIONS);
  assert.equal(translated.complete, true);
});
