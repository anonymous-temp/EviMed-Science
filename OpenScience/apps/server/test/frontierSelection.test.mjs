// The 精选 you can trust (c3-select 2026-10-25): the score's rubric and its answer, the practice proposal, the standalone score, the
// source a card names, the label a card carries. The gold set's measures are `evals/frontier-selection`; these hold the code.
import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_PRACTICE_LIMITS, FRONTIER_SCORE_MAXIMA } from "@evimed/domain";
import {
  FRONTIER_COMPARE_INSTRUCTIONS,
  FRONTIER_EDIT_INSTRUCTIONS,
  FRONTIER_EDIT_OUTPUT_KEYS,
  FRONTIER_PRACTICE_RULE_ZH,
  FRONTIER_SCORE_INSTRUCTIONS,
  FRONTIER_SCORE_RUBRIC_ZH,
  FrontierEditor,
  buildCompareInput,
  buildModelInput,
  frontierEditPolicyCurrent,
  frontierEditorDiagnostics,
  verifyEdit,
} from "../src/frontierEditor.mjs";
import { frontierSourceGrade } from "../src/frontierPipeline.mjs";
import { frontierPracticeLabel } from "../src/frontierService.mjs";

const config = { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", frontierModel: "deepseek-flash" };
const owner = { userId: "operator", projectId: "evimed-frontier" };
function stubModel(/** @type {Array<(call: any) => any>} */ answers) {
  /** @type {any[]} */
  const calls = [];
  const callModel = async (/** @type {any} */ _deps, /** @type {any} */ call) => {
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return { choices: [{ message: { content: JSON.stringify(await next(call)) } }] };
  };
  return { calls, callModel };
}
const item = (overrides = {}) => ({
  titleRaw: "FDA approves the first oral drug for hypertrophic cardiomyopathy", sourceName: "美国FDA", sourceTypeLabel: "监管", isChinese: false,
  allowedLanes: ["regulatory", "evidence"], abstract: null,
  bodyExcerpt: "The FDA approved aficamten for adults with symptomatic obstructive hypertrophic cardiomyopathy. In the SEQUOIA-HCM trial of 282 patients the peak oxygen uptake rose by 1.8 mL/kg/min.",
  glossary: [], ...overrides,
});
const answer = (overrides = {}) => ({
  genre: "approval", title_zh: "FDA 批准首个口服药治疗肥厚型心肌病",
  summary_zh: "FDA 批准 aficamten 用于有症状的梗阻性肥厚型心肌病成人。SEQUOIA-HCM 试验纳入 282 例患者，峰值摄氧量提高 1.8 mL/kg/min。",
  reason_zh: "梗阻性肥厚型心肌病的成人多了一个口服选择，心内科医生在评估症状和流出道压差时可把它放进用药方案比较。",
  tags: [], lane: "regulatory", specialties: [], evidence_type: "regulatory-decision",
  entities: { drugs: [], trials: ["SEQUOIA-HCM"], orgs: ["FDA"], diseases: [] }, scores: { impact: 24, novelty: 18, relevance: 12 },
  practice: { changing: false, reason_zh: "" }, flags: [], ...overrides,
});
const input = "标题：FDA approves\n摘要：The FDA approved aficamten for adults with symptomatic obstructive hypertrophic cardiomyopathy. In the SEQUOIA-HCM trial of 282 patients the peak oxygen uptake rose by 1.8 mL/kg/min.";

test("the rubric says what a place in 精选 is, ladders impact and novelty, and the edit asks for scores and practice first", () => {
  assert.ok(FRONTIER_EDIT_INSTRUCTIONS.includes(FRONTIER_SCORE_RUBRIC_ZH));
  assert.ok(FRONTIER_SCORE_INSTRUCTIONS.includes(FRONTIER_SCORE_RUBRIC_ZH), "the standalone score is the edit's rubric, word for word");
  for (const rung of ["0–8 没有实质内容", "9–14 没有人会因此改变做法", "15–20 对一个专科有用", "21–25 会改变一个专科常规做法", "26–30 几乎所有相关医生都要知道", "0–6 重复已知", "18–20 首次报告"]) {
    assert.ok(FRONTIER_SCORE_RUBRIC_ZH.includes(rung), rung);
  }
  // The answer opens with the two keys that must not be coloured by the writing that follows (dev AUC 0.940, against 0.887 with scores last).
  const format = FRONTIER_EDIT_INSTRUCTIONS.split("\n").find((line) => line.startsWith("{\"scores\""));
  assert.ok(format, "the output shape starts with scores");
  assert.ok(format.indexOf("\"scores\"") < format.indexOf("\"practice\"") && format.indexOf("\"practice\"") < format.indexOf("\"genre\"") && format.indexOf("\"genre\"") < format.indexOf("\"summary_zh\""));
  assert.ok(FRONTIER_EDIT_OUTPUT_KEYS.includes("practice"));
  assert.ok(frontierEditPolicyCurrent(FRONTIER_EDIT_INSTRUCTIONS));
  assert.equal(frontierEditPolicyCurrent(FRONTIER_EDIT_INSTRUCTIONS.replaceAll("\"practice\"", "\"x\"")), false, "a served prompt written before the label is not used");
  assert.ok(FRONTIER_EDIT_INSTRUCTIONS.includes(FRONTIER_PRACTICE_RULE_ZH));
  assert.match(FRONTIER_PRACTICE_RULE_ZH, /绝大多数条目填 \{"changing":false/);
  assert.match(FRONTIER_PRACTICE_RULE_ZH, new RegExp(`不超过 ${FRONTIER_PRACTICE_LIMITS.reasonChars} 个字`));
});

test("a practice proposal is a flag and a one-line Chinese reason whose numbers are the source's; anything else is no proposal and never fails the answer", () => {
  const ok = verifyEdit(answer({ practice: { changing: true, reason_zh: "首个口服药获批，梗阻性肥厚型心肌病成人可用，SEQUOIA-HCM 中峰值摄氧量提高 1.8 mL/kg/min。" } }), item(), input);
  assert.deepEqual(ok.output.practice, { changing: true, reasonZh: "首个口服药获批，梗阻性肥厚型心肌病成人可用，SEQUOIA-HCM 中峰值摄氧量提高 1.8 mL/kg/min。" });
  assert.equal(ok.issues.length, 0, "a proposal does not touch the answer's checks");
  for (const practice of [
    { changing: false, reason_zh: "x" },
    { changing: true, reason_zh: "" },
    { changing: true, reason_zh: "长".repeat(FRONTIER_PRACTICE_LIMITS.reasonChars + 1) },
    { changing: true, reason_zh: "Approved for adults with symptomatic disease" },
    { changing: true, reason_zh: "峰值摄氧量提高 9.9 mL/kg/min，值得所有医生关注。" },
    { changing: true, reason_zh: "详见 https://example.com 的说明" },
    "yes", null, undefined, [], 7,
  ]) {
    const checked = verifyEdit(answer({ practice }), item(), input);
    assert.equal(checked.output.practice, null, JSON.stringify(practice));
    assert.equal(checked.issues.length, 0, `${JSON.stringify(practice)} is no failure`);
  }
  assert.equal(verifyEdit({ ...answer(), practice: undefined }, item(), input).output.practice, null, "an answer without the key is an answer");
});

test("the model's own numbers stay in the diagnostics; the practice proposal does not leave the item as metadata", () => {
  const checkedAt = "2026-10-25T08:00:00.000Z";
  const diagnostics = frontierEditorDiagnostics({ schemaVersion: 1, outcome: "passed", checkedAt, scoresRaw: { impact: 21, novelty: 12, relevance: 14 },
    practice: { changing: true, reasonZh: "x" }, capped: ["genre:trial"] });
  assert.deepEqual(diagnostics?.scoresRaw, { impact: 21, novelty: 12, relevance: 14 });
  assert.equal(/** @type {any} */ (diagnostics).practice, undefined, "an unadmitted proposal is not served");
  assert.equal(/** @type {any} */ (diagnostics).capped, undefined);
});

test("the standalone score is one short call: the parts as written, on the scale, and the proposal; a bad answer is an error and no score", async () => {
  const { callModel, calls } = stubModel([
    () => ({ scores: { impact: 41, novelty: 18, relevance: -2 }, practice: { changing: true, reason_zh: "首个口服药获批，梗阻性肥厚型心肌病成人可用。" } }),
    () => ({ scores: { impact: "high" } }),
    () => ({ nothing: true }),
  ]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const good = await editor.scoreItem(item(), { genre: "approval" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.messages[0].content, FRONTIER_SCORE_INSTRUCTIONS);
  assert.ok(calls[0].body.max_tokens <= 500, "a score is a small answer");
  assert.match(calls[0].body.messages[1].content, /类型：approval（审批上市）/);
  assert.deepEqual(good.scoresRaw, { impact: 41, novelty: 18, relevance: -2 });
  assert.deepEqual(good.scores, { impact: FRONTIER_SCORE_MAXIMA.impact, novelty: 18, relevance: 0 });
  assert.equal(good.practice?.reasonZh, "首个口服药获批，梗阻性肥厚型心肌病成人可用。");
  assert.equal(good.error, null);
  for (const _ of [1, 2]) {
    const bad = await editor.scoreItem(item());
    assert.equal(bad.scores, null);
    assert.equal(bad.error, "frontier_score_invalid");
  }
  const failing = await new FrontierEditor(config, { owner, callModel: async () => { throw Object.assign(new Error("down"), { code: "model_gateway_upstream_error" }); } }).scoreItem(item());
  assert.equal(failing.scores, null);
  assert.equal(failing.error, "model_gateway_upstream_error");
  assert.equal(buildModelInput(item()).includes("类型："), false, "the genre rides after the input, so the input's identity is the source's");
});

test("the comparative pass is written and measured, not shipped: it lists nothing for an empty batch and reads picks by number", async () => {
  assert.match(FRONTIER_COMPARE_INSTRUCTIONS, /精选很挑/);
  assert.equal(buildCompareInput([{ sourceName: "x", authority: 3, genre: "paper", title: "t", excerpt: "e" }]).split("\n").length, 5);
  const { callModel } = stubModel([() => ({ picks: [{ n: 2, reason: "a" }, { n: 2, reason: "dup" }, { n: 9, reason: "outside" }, { n: 1 }] })]);
  const editor = new FrontierEditor(config, { owner, callModel });
  assert.deepEqual(await editor.compareBatch([]), { picks: [], error: null });
  const result = await editor.compareBatch([{ sourceName: "a", title: "A" }, { sourceName: "b", title: "B" }]);
  assert.deepEqual(result.picks, [{ index: 1, reason: "a" }, { index: 0, reason: "" }]);
});

test("a republisher's authority grade is capped at its table's; every other source keeps the registry's", () => {
  assert.equal(frontierSourceGrade({ id: "discovered-29e04956f24c862b4024", authority: 3 }), 1);
  assert.equal(frontierSourceGrade({ id: "discovered-29e04956f24c862b4024", authority: 1 }), 1);
  assert.equal(frontierSourceGrade({ authority: 3 }, "discovered-25304a7756bda9fd5b80"), 1, "the item's source id stands in when the row has none");
  assert.equal(frontierSourceGrade({ id: "prnewswire-health", authority: 3 }), 3);
  assert.equal(frontierSourceGrade(null, null), undefined);
});

test("the label a card carries is the admitted one with its reason; a proposal that was not admitted is never served", () => {
  assert.deepEqual(frontierPracticeLabel({ practice_changing: true, practice_zh: " 国内首个获批\n用于 HER2 阳性患者 " }), { reason: "国内首个获批 用于 HER2 阳性患者" });
  assert.equal(frontierPracticeLabel({ practice_changing: false, practice_zh: "reason held, not admitted" }), null);
  assert.equal(frontierPracticeLabel({ practice_changing: true, practice_zh: null }), null);
  assert.equal(frontierPracticeLabel({ practice_changing: true, practice_zh: "   " }), null);
  assert.equal(frontierPracticeLabel({}), null);
});
