// The edit by genre (ct-write 2026-10-24): the edit names the genre (code keeps the genres it is sure of), is told a genre code is
// sure of outside its input, and writes its 推荐理由 through the genre's lens; the backfill's genre call and reason call.
import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_GENRES, FRONTIER_GENRE_LABELS_ZH, frontierGenreDecision } from "@evimed/domain";
import {
  FRONTIER_EDIT_INSTRUCTIONS,
  FRONTIER_EDIT_OUTPUT_KEYS,
  FRONTIER_GENRE_INSTRUCTIONS,
  FRONTIER_GENRE_SCOPES_ZH,
  FRONTIER_REASON_LENSES_ZH,
  FRONTIER_REASON_VERSION,
  FrontierEditor,
  buildGenreInput,
  buildReasonInput,
  frontierEditPolicyCurrent,
  frontierReasonInstructions,
  readerNumberSource,
  verifyEdit,
  verifyGenres,
  verifyReason,
} from "../src/frontierEditor.mjs";

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
  titleRaw: "Gilead to acquire oral IL-23R program for $1.275 billion upfront", sourceName: "Gilead", isChinese: false,
  allowedLanes: ["pipeline", "evidence"], abstract: null,
  bodyExcerpt: "Gilead Sciences will pay $1.275 billion upfront in cash to acquire an oral IL-23R inhibitor program whose lead asset HCXT-2001 is in Phase 1.",
  glossary: [], ...overrides,
});
const answer = (overrides = {}) => ({
  genre: "industry", title_zh: "吉利德以 12.75 亿美元首付款收购口服 IL-23R 抑制剂项目",
  summary_zh: "吉利德以 12.75 亿美元现金首付款收购一个口服 IL-23R 抑制剂项目，核心资产 HCXT-2001 处于 1 期。",
  reason_zh: "口服 IL-23R 抑制剂赛道的估值因这笔早期资产买断而抬高，炎症性肠病和银屑病领域的研发团队需要重新评估竞争格局。",
  tags: [], lane: "pipeline", specialties: [], evidence_type: "press-release",
  entities: { drugs: [], trials: [], orgs: ["吉利德"], diseases: [] }, scores: { impact: 12, novelty: 12, relevance: 8 }, flags: [],
  ...overrides,
});

test("the edit asks for the genre, lists every genre with what it is, and still asks for every key the checks read", () => {
  assert.ok(FRONTIER_EDIT_OUTPUT_KEYS.includes("genre"));
  assert.ok(frontierEditPolicyCurrent(FRONTIER_EDIT_INSTRUCTIONS));
  assert.equal(frontierEditPolicyCurrent(FRONTIER_EDIT_INSTRUCTIONS.replace('"genre":"",', "")), false,
    "a served prompt written before the genre is not used: the shipped one is");
  for (const genre of FRONTIER_GENRES) {
    assert.ok(FRONTIER_EDIT_INSTRUCTIONS.includes(`${genre} ${FRONTIER_GENRE_LABELS_ZH[genre]}（${FRONTIER_GENRE_SCOPES_ZH[genre]}）`), genre);
    assert.ok(FRONTIER_GENRE_INSTRUCTIONS.includes(`${genre} ${FRONTIER_GENRE_LABELS_ZH[genre]}`), genre);
  }
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /媒体对一项研究的报道是 news 而不是 paper/);
  // The 推荐理由 is written through its genre's lens, and never with the formula openings measured on production (~70%).
  for (const genre of FRONTIER_GENRES) if (FRONTIER_REASON_LENSES_ZH[genre]) assert.ok(FRONTIER_EDIT_INSTRUCTIONS.includes(FRONTIER_REASON_LENSES_ZH[genre]), genre);
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /不用「可了解」「可帮助」「可据此」/);
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /不写原文没有什么（不用「原文仅」「未列出」/);
});

test("the edit's genre is a known key or none, and never fails an answer", () => {
  assert.equal(verifyEdit(answer(), item(), "标题：x").output.genre, "industry");
  const unknown = verifyEdit(answer({ genre: "press" }), item(), "标题：x");
  assert.equal(unknown.output.genre, null);
  assert.ok(!unknown.failed.has("genre"));
  assert.equal(verifyEdit(answer({ genre: undefined }), item(), "标题：x").output.genre, null);
});

test("a genre code is sure of rides after the input, never in it: the input's hash stays the source's", async () => {
  const { calls, callModel } = stubModel([() => answer({ genre: "news" }), () => answer()]);
  const editor = new FrontierEditor(config, { owner, callModel });
  const fixed = await editor.edit(item({ genreFixed: "social" }));
  const plain = await editor.edit(item());
  assert.equal(fixed.modelInput, plain.modelInput);
  assert.equal(fixed.modelInputSha256, plain.modelInputSha256);
  assert.match(calls[0].body.messages[1].content, /\n类型：social（社交动态，已由程序确定）$/);
  assert.doesNotMatch(calls[1].body.messages[1].content, /类型：/);
  // A genre code is not sure of is not said (the model decides it); one that is not a genre at all neither.
  const { calls: more, callModel: again } = stubModel([() => answer(), () => answer()]);
  const second = new FrontierEditor(config, { owner, callModel: again });
  await second.edit(item({ genreFixed: "industry" }));
  await second.edit(item({ genreFixed: "nonsense" }));
  assert.ok(more.every((call) => !/类型：/.test(call.body.messages[1].content)));
  // Code keeps its answer for a genre it is sure of: a post the model calls news is still a post.
  assert.deepEqual(frontierGenreDecision({ platform: "x" }, fixed.output?.genre), { genre: "social", basis: "code" });
  assert.deepEqual(frontierGenreDecision({ platform: "wechat" }, "approval"), { genre: "approval", basis: "model" });
});

test("a 推荐理由 written on its own: its genre's lens, the edit's rules, checked as the edit's reason is", async () => {
  for (const genre of FRONTIER_GENRES) {
    const instructions = frontierReasonInstructions(genre);
    assert.match(instructions, /不用「可了解」「可帮助」「可据此」/);
    if (FRONTIER_REASON_LENSES_ZH[genre]) assert.ok(instructions.endsWith(`推荐理由写${FRONTIER_REASON_LENSES_ZH[genre]}。`), genre);
    else assert.match(instructions, /给空字符串。$/, genre);
  }
  assert.match(FRONTIER_REASON_VERSION, /^frontier-reason-2\.[a-f0-9]{12}$/);
  const input = buildReasonInput({ sourceName: "Gilead 2027", titleRaw: "Deal", summaryZh: "吉利德以 12.75 亿美元收购，交易 2026 年完成。",
    text: "Gilead will pay $1.275 billion upfront." });
  assert.match(input, /导读（不要重复）：/);
  assert.doesNotMatch(readerNumberSource(input), /2026|2027/, "the summary shown and the source's name are not the source");
  assert.deepEqual(verifyReason({ reason_zh: "" }, input), { output: { reason_zh: null }, issues: [], numbers: { missing: [], checked: 0, unitMismatches: [] } });
  assert.deepEqual(verifyReason({ reason_zh: "口服 IL-23R 赛道的早期资产估值被这笔 12.75 亿美元首付款抬高，做同靶点研发的团队需要重新评估竞争格局和合作价格。" }, input).issues, []);
  assert.ok(verifyReason({ reason_zh: "这笔交易预计在 2026 年完成，口服 IL-23R 赛道的竞争格局随之改变，研发团队需要重新评估同靶点项目。" }, input).issues.some((issue) => issue.includes("2026")));
  assert.ok(verifyReason({ reason_zh: "格局改变。" }, input).issues.some((issue) => issue.includes("太短")));
  const { calls, callModel } = stubModel([() => ({ reason_zh: "口服 IL-23R 赛道的早期资产估值被这笔 12.75 亿美元首付款抬高，做同靶点研发的团队需要重新评估竞争格局和合作价格。" })]);
  const result = await new FrontierEditor(config, { owner, callModel }).writeReason({ genre: "industry", sourceName: "Gilead", titleRaw: "Deal", text: "Gilead will pay $1.275 billion upfront." });
  assert.equal(result.verification, "passed");
  assert.match(String(result.reason), /12\.75 亿美元/);
  assert.equal(calls[0].body.messages[0].content, frontierReasonInstructions("industry"));
});

test("the backfill's genre call: several items to a call, a known genre or none for each", async () => {
  const items = [{ sourceName: "医药观澜", title: "恒瑞公布 2 期数据", excerpt: "恒瑞医药公布口服小分子在研新药 2 期临床数据。" }, { sourceName: "Medical Xpress", title: "Study finds" }];
  const text = buildGenreInput(items);
  assert.match(text, /^\[1\]\n来源：医药观澜\n标题：恒瑞公布 2 期数据\n正文开头：恒瑞医药/);
  assert.match(text, /\[2\]\n来源：Medical Xpress\n标题：Study finds$/);
  assert.deepEqual(verifyGenres(items, { items: [{ n: 2, genre: "news" }, { n: 1, genre: "unknown" }] }), [null, "news"]);
  assert.deepEqual(verifyGenres(items, null), [null, null]);
  const { calls, callModel } = stubModel([() => ({ items: [{ n: 1, genre: "industry" }, { n: 2, genre: "news" }] })]);
  assert.deepEqual(await new FrontierEditor(config, { owner, callModel }).classifyGenres(items), ["industry", "news"]);
  assert.equal(calls[0].body.messages[0].content, FRONTIER_GENRE_INSTRUCTIONS);
});
