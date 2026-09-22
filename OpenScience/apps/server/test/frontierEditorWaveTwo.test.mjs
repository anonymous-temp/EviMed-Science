// The editor's second-wave calls with a stubbed model (build spec D): 「是不是同一
// 件事」, the reader profile, and the Chinese abstract — each metered as a
// `frontier` call, each answer validated, numbers checked where a text states
// them, and what fails dropped rather than softened.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  FRONTIER_ABSTRACT_INSTRUCTIONS,
  FRONTIER_AI_MINUTE_INSTRUCTIONS,
  FRONTIER_DIGEST_INSTRUCTIONS,
  FRONTIER_EDITOR_VERSION,
  FRONTIER_EDIT_INSTRUCTIONS,
  FRONTIER_SCREEN_INSTRUCTIONS,
  FRONTIER_PROFILE_INSTRUCTIONS,
  FRONTIER_SAME_EVENT_INSTRUCTIONS,
  FrontierEditor,
  buildAbstractInput,
  buildProfileInput,
  buildSameEventInput,
  validateSameEvent,
  verifyAbstract,
  verifyProfile,
} from "../src/frontierEditor.mjs";

const OWNER = { userId: "operator", projectId: "evimed-frontier" };
const CONFIG = { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", frontierModel: "deepseek-flash" };

/** A model that answers each call from the list, and records what it was asked. @param {Array<unknown>} answers */
function scriptedModel(answers) {
  const calls = [];
  const callModel = async (_dependencies, request) => {
    calls.push(request);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return { choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) } }] };
  };
  return { calls, callModel };
}

test("the three prompts keep the editor's shape: a stable prefix, JSON only, and they re-key no item", () => {
  for (const prompt of [FRONTIER_SAME_EVENT_INSTRUCTIONS, FRONTIER_PROFILE_INSTRUCTIONS, FRONTIER_ABSTRACT_INSTRUCTIONS]) {
    assert.match(prompt, /^你是 EviMed「前沿动态」的/);
    assert.match(prompt, /JSON/);
  }
  assert.match(FRONTIER_PROFILE_INSTRUCTIONS, /cardiology 心血管/, "the specialty vocabulary is in the prefix");
  // The version names the prompts that write the items', events' and issues'
  // Chinese; the three new ones write none of it and must not re-key an item.
  const four = createHash("sha256").update(`${FRONTIER_SCREEN_INSTRUCTIONS}\n${FRONTIER_EDIT_INSTRUCTIONS}\n${FRONTIER_DIGEST_INSTRUCTIONS}\n${FRONTIER_AI_MINUTE_INSTRUCTIONS}`)
    .digest("hex").slice(0, 12);
  assert.equal(FRONTIER_EDITOR_VERSION, `frontier-editor-1.${four}`);
});

test("same event: the input names the new report and at most three earlier ones; the answer is one verdict each, in the vocabulary", () => {
  const report = { sourceName: "Reuters", titleRaw: "FDA approves drug X", titleZh: "FDA 批准 X 药", summaryZh: "导读", publishedAt: "2026-09-21T08:00:00Z" };
  const input = JSON.parse(buildSameEventInput({ report, candidates: [report, report, report, report] }));
  assert.equal(input.new.source, "Reuters");
  assert.equal(input.new.date, "2026-09-21");
  assert.deepEqual(input.earlier.map((entry) => entry.id), ["1", "2", "3"]);
  assert.deepEqual(validateSameEvent(2, { items: [{ id: "2", verdict: "Related" }, { id: 1, verdict: "yes" }] }), ["yes", "related"]);
  assert.equal(validateSameEvent(2, { items: [{ id: "1", verdict: "yes" }] }), null, "one verdict short");
  assert.equal(validateSameEvent(1, { items: [{ id: "1", verdict: "same" }] }), null, "outside the vocabulary");
  assert.equal(validateSameEvent(2, { items: [{ id: "1", verdict: "yes" }, { id: "1", verdict: "no" }] }), null, "an id twice");
  assert.equal(validateSameEvent(1, null), null);
});

test("same event: metered as a frontier call with its own bounds; an invalid answer is asked once more, then it is no answer", async () => {
  const report = { sourceName: "Reuters", titleRaw: "FDA approves drug X" };
  const good = scriptedModel(["not json at all", { items: [{ id: "1", verdict: "yes" }, { id: "2", verdict: "no" }] }]);
  const editor = new FrontierEditor(CONFIG, { callModel: good.callModel, owner: OWNER });
  const judged = await editor.judgeSameEvent({ report, candidates: [report, report] });
  assert.deepEqual(judged, { verdicts: ["yes", "no"], error: null, attempts: 2 });
  assert.equal(good.calls[0].purpose, "frontier");
  assert.deepEqual(good.calls[0].limits, { daily: 0, weekly: 0 });
  assert.equal(good.calls[0].body.max_tokens, 300);
  assert.equal(good.calls[0].body.messages[0].content, FRONTIER_SAME_EVENT_INSTRUCTIONS);
  assert.deepEqual(good.calls[0].body.thinking, { type: "disabled" });

  const bad = scriptedModel([{ items: [] }, { items: [] }]);
  const failed = await new FrontierEditor(CONFIG, { callModel: bad.callModel, owner: OWNER }).judgeSameEvent({ report, candidates: [report] });
  assert.deepEqual(failed, { verdicts: null, error: "frontier_same_event_invalid", attempts: 2 });
  const spent = scriptedModel([Object.assign(new Error("spent"), { code: "usage_budget_exceeded" })]);
  const refused = await new FrontierEditor(CONFIG, { callModel: spent.callModel, owner: OWNER }).judgeSameEvent({ report, candidates: [report] });
  assert.equal(refused.error, "usage_budget_exceeded");
  assert.equal(spent.calls.length, 1, "a spent budget is not asked twice");
  assert.deepEqual(await new FrontierEditor(CONFIG, { callModel: spent.callModel, owner: OWNER }).judgeSameEvent({ report, candidates: [] }),
    { verdicts: [], error: null, attempts: 0 }, "nothing to ask, no call");
});

const memories = [
  { id: "m1", kind: "project_fact", text: "正在做 SGLT2 抑制剂与心衰住院的 Meta 分析，纳入 12 项 RCT" },
  { id: "m2", kind: "profile", text: "心内科主治医师，关注心衰和房颤" },
  { id: "m3", kind: "preference", text: "回答要简短" },
];

test("a profile answer is checked piece by piece: a phrase naming no memory, a number its memory lacks, a link — dropped alone", () => {
  const input = JSON.parse(buildProfileInput({ memories }));
  assert.deepEqual(input.memories.map((memory) => memory.id), ["m1", "m2", "m3"]);
  const verified = verifyProfile({
    specialties: ["cardiology", "astrology", "cardiology"],
    phrases: [
      { text: "SGLT2 抑制剂与心衰住院的 Meta 分析", memory_id: "m1" },
      { text: "纳入 12 项 RCT 的心衰研究", memory_id: "m1" },
      { text: "纳入 30 项 RCT 的心衰研究", memory_id: "m1" },
      { text: "房颤", memory_id: "m2" },
      { text: "心衰指南", memory_id: "m9" },
      { text: "见 www.example.com", memory_id: "m2" },
      { text: "SGLT2 抑制剂与心衰住院的 Meta 分析", memory_id: "m1" },
      { text: "心", memory_id: "m2" },
    ],
  }, memories);
  assert.deepEqual(verified.specialties, ["cardiology"]);
  assert.deepEqual(verified.phrases, [
    { text: "SGLT2 抑制剂与心衰住院的 Meta 分析", memoryId: "m1" },
    { text: "纳入 12 项 RCT 的心衰研究", memoryId: "m1" },
    { text: "房颤", memoryId: "m2" },
  ]);
  assert.deepEqual(verified.dropped.map((entry) => entry.reason), ["number", "unknown-memory", "link", "duplicate", "length"]);
  assert.equal(verifyProfile({ specialties: [] }, memories), null, "not the shape at all");
});

test("a profile is one metered call, asked once more when the answer is not the shape; no memories, no call", async () => {
  const model = scriptedModel([{ phrases: "none" }, { specialties: ["cardiology"], phrases: [{ text: "房颤", memory_id: "m2" }] }]);
  const editor = new FrontierEditor(CONFIG, { callModel: model.callModel, owner: OWNER });
  const profile = await editor.extractProfile({ memories });
  assert.deepEqual({ specialties: profile.specialties, phrases: profile.phrases, error: profile.error, attempts: profile.attempts },
    { specialties: ["cardiology"], phrases: [{ text: "房颤", memoryId: "m2" }], error: null, attempts: 2 });
  assert.equal(model.calls[0].body.messages[0].content, FRONTIER_PROFILE_INSTRUCTIONS);
  assert.equal(model.calls[0].body.max_tokens, 1000);
  const none = await editor.extractProfile({ memories: [] });
  assert.deepEqual(none.phrases, []);
  assert.equal(model.calls.length, 2, "an empty memory costs nothing");
});

test("the Chinese abstract keeps its paragraphs, and every number in it must be in the original", () => {
  const input = buildAbstractInput({ titleRaw: "Semaglutide in HFpEF", abstract: "Background: ...\n\nResults: The KCCQ score improved by 16.6 points vs 8.7 (P<0.001).",
    glossary: [{ termEn: "semaglutide", termZh: "司美格鲁肽", keepOriginal: false }, { termEn: "STEP-HFpEF", termZh: "STEP-HFpEF", keepOriginal: true }] });
  assert.match(input, /^标题：Semaglutide in HFpEF\n术语表（本篇原文里出现的词，译名必须照用）：\n- semaglutide → 司美格鲁肽\n- STEP-HFpEF：保留原文\n摘要：Background/);
  const good = verifyAbstract({ abstract_zh: "背景：……\n\n结果：KCCQ 评分改善 16.6 分，对照组为 8.7 分（P<0.001）。" }, input);
  assert.deepEqual(good.issues, []);
  assert.equal(good.output.abstract_zh, "背景：……\n结果：KCCQ 评分改善 16.6 分，对照组为 8.7 分（P<0.001）。", "paragraphs kept, blank lines folded");
  const wrong = verifyAbstract({ abstract_zh: "结果：KCCQ 评分改善约 17 分，对照组为 8.7 分。" }, input);
  assert.equal(wrong.issues.length, 1);
  assert.match(wrong.issues[0], /「17」在原文里找不到/);
  assert.match(verifyAbstract({ abstract_zh: "The KCCQ improved." }, input).issues.join(), /要用中文写/);
  assert.match(verifyAbstract(null, input).issues.join(), /没有读到 JSON 对象/);
});

test("the Chinese abstract: a failed check is rewritten once with the issue named, a second failure is dropped", async () => {
  const abstract = "The KCCQ score improved by 16.6 points vs 8.7.";
  const repaired = scriptedModel([{ abstract_zh: "KCCQ 评分改善约 17 分。" }, { abstract_zh: "KCCQ 评分改善 16.6 分，对照组为 8.7 分。" }]);
  const editor = new FrontierEditor(CONFIG, { callModel: repaired.callModel, owner: OWNER });
  const result = await editor.writeAbstractZh({ titleRaw: "Semaglutide in HFpEF", abstract });
  assert.equal(result.verification, "repaired");
  assert.equal(result.abstractZh, "KCCQ 评分改善 16.6 分，对照组为 8.7 分。");
  assert.match(repaired.calls[1].body.messages.at(-1).content, /「17」在原文里找不到/);
  assert.equal(repaired.calls[0].body.max_tokens, 3000);
  const dropped = scriptedModel([{ abstract_zh: "改善约 17 分。" }, { abstract_zh: "改善约 18 分。" }]);
  const refused = await new FrontierEditor(CONFIG, { callModel: dropped.callModel, owner: OWNER }).writeAbstractZh({ titleRaw: "t", abstract });
  assert.equal(refused.verification, "dropped");
  assert.equal(refused.abstractZh, null, "never a softened translation");
  const unavailable = await new FrontierEditor(CONFIG, { callModel: dropped.callModel }).writeAbstractZh({ titleRaw: "t", abstract });
  assert.equal(unavailable.verification, "pending");
  assert.equal(unavailable.error, "frontier_editor_unavailable", "no owner to bill, no call");
});
