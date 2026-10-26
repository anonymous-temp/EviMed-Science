// The kind of 行业动态 (c5-biz 2026-10-26): the edit names it for an item it calls industry, the answer is checked against the closed
// list in code (an unknown word is dropped, never guessed), and the backfill's kind call is the genre call's shape. The list filter and the
// stored column are in frontierIndustryKind.integration.test.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FRONTIER_INDUSTRY_KINDS, FRONTIER_INDUSTRY_KIND_LABELS_ZH, FRONTIER_LANES, frontierIndustryKindDecision } from "@evimed/domain";
import {
  FRONTIER_EDIT_INSTRUCTIONS,
  FRONTIER_EDIT_OUTPUT_KEYS,
  FRONTIER_GENRE_INSTRUCTIONS,
  FRONTIER_INDUSTRY_KIND_BATCH,
  FRONTIER_INDUSTRY_KIND_INSTRUCTIONS,
  FRONTIER_INDUSTRY_KIND_SCOPES_ZH,
  FrontierEditor,
  buildGenreInput,
  frontierEditPolicyCurrent,
  verifyEdit,
  verifyIndustryKinds,
} from "../src/frontierEditor.mjs";
import { normalizeItemsQuery, frontierDomainVocabulary } from "../src/frontierService.mjs";

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
  genre: "industry", industry_kind: "deal", title_zh: "吉利德以 12.75 亿美元首付款收购口服 IL-23R 抑制剂项目",
  summary_zh: "吉利德以 12.75 亿美元现金首付款收购一个口服 IL-23R 抑制剂项目，核心资产 HCXT-2001 处于 1 期。",
  reason_zh: "口服 IL-23R 抑制剂赛道的估值因这笔早期资产买断而抬高，炎症性肠病和银屑病领域的研发团队需要重新评估竞争格局。",
  tags: [], lane: "pipeline", specialties: [], evidence_type: "press-release",
  entities: { drugs: [], trials: [], orgs: ["吉利德"], diseases: [] }, scores: { impact: 12, novelty: 12, relevance: 8 }, flags: [],
  ...overrides,
});

test("the edit asks for the kind, lists every kind with what it is, and says it is for 行业动态 only", () => {
  assert.ok(FRONTIER_EDIT_OUTPUT_KEYS.includes("industry_kind"));
  assert.ok(frontierEditPolicyCurrent(FRONTIER_EDIT_INSTRUCTIONS));
  assert.equal(frontierEditPolicyCurrent(FRONTIER_EDIT_INSTRUCTIONS.replace('"industry_kind":"",', "")), false,
    "a served prompt written before the kind is not used: the shipped one is");
  for (const kind of FRONTIER_INDUSTRY_KINDS) {
    const line = `${kind} ${FRONTIER_INDUSTRY_KIND_LABELS_ZH[kind]}（${FRONTIER_INDUSTRY_KIND_SCOPES_ZH[kind]}）`;
    assert.ok(FRONTIER_EDIT_INSTRUCTIONS.includes(line), kind);
    assert.ok(FRONTIER_INDUSTRY_KIND_INSTRUCTIONS.includes(line), kind);
  }
  assert.match(FRONTIER_EDIT_INSTRUCTIONS, /industry_kind：只有 genre 是 industry 时填，其余类型给空字符串/);
  // The genre call is not changed by the kind: it still lists the genres only.
  assert.doesNotMatch(FRONTIER_GENRE_INSTRUCTIONS, /industry_kind/);
  // Language judgement stays with the model: the instructions carry the one rule and no keyword list.
  assert.match(FRONTIER_INDUSTRY_KIND_INSTRUCTIONS, /按事件本身选，不按公司的类型选/);
});

test("the edit's kind is a known key or none, and never fails an answer", () => {
  const verified = (/** @type {Record<string, unknown>} */ overrides) => verifyEdit(answer(overrides), item(), "标题：x");
  for (const kind of FRONTIER_INDUSTRY_KINDS) assert.equal(verified({ industry_kind: kind }).output.industryKind, kind, kind);
  // A word outside the list - another key, a Chinese label, a near word - is none, and the answer stands exactly as it did with a kind
  // (whatever the number checks say about this fixture, the kind adds nothing to them).
  const baseline = verified({});
  for (const word of ["merger", "融资与上市", "Deal", " deal", "", null, 4, ["deal"]]) {
    const result = verified({ industry_kind: word });
    assert.equal(result.output.industryKind, null, String(word));
    assert.ok(!result.failed.has("industry_kind"), `${String(word)}: not a failure`);
    assert.deepEqual([...result.failed], [...baseline.failed], String(word));
    assert.deepEqual(result.issues, baseline.issues, String(word));
  }
  assert.equal(verifyEdit(answer({ industry_kind: undefined }), item(), "标题：x").output.industryKind, null, "an older prompt's answer has no kind");
});

test("what is stored: the kind only for an item that ends as 行业动态", () => {
  const output = verifyEdit(answer({ genre: "news", industry_kind: "deal" }), item(), "标题：x").output;
  assert.equal(output.industryKind, "deal", "the verified answer keeps the model's word");
  assert.equal(frontierIndustryKindDecision("news", output.industryKind), null, "an item the genre makes news has no kind");
  assert.equal(frontierIndustryKindDecision("industry", output.industryKind), "deal");
});

test("the backfill's kind call: ten items to a call, shown as the genre call shows them, a known key or none for each", async () => {
  assert.equal(FRONTIER_INDUSTRY_KIND_BATCH, 10);
  const items = [{ sourceName: "医药观澜", title: "恒瑞与某公司达成授权合作", excerpt: "恒瑞医药宣布将一款在研药物的海外权益授权。" }, { sourceName: "STAT", title: "Biotech names a new chief executive" },
    { sourceName: "STAT", title: "A third item" }];
  assert.match(buildGenreInput(items), /^\[1\]\n来源：医药观澜\n标题：恒瑞与某公司达成授权合作\n正文开头：恒瑞医药宣布/);
  assert.deepEqual(verifyIndustryKinds(items, { items: [{ n: 2, industry_kind: "people" }, { n: 1, industry_kind: "deal" }, { n: 3, industry_kind: "unknown" }] }),
    ["deal", "people", null], "by number, not by position; a word outside the list is none");
  assert.deepEqual(verifyIndustryKinds(items, { items: [{ n: 1, industry_kind: "融资与上市" }] }), [null, null, null], "a label is not a key");
  assert.deepEqual(verifyIndustryKinds(items, null), [null, null, null]);
  assert.deepEqual(verifyIndustryKinds(items, { items: "deal" }), [null, null, null]);
  const { calls, callModel } = stubModel([() => ({ items: [{ n: 1, industry_kind: "deal" }, { n: 2, industry_kind: "people" }, { n: 3, industry_kind: "other" }] })]);
  assert.deepEqual(await new FrontierEditor(config, { owner, callModel }).classifyIndustryKinds(items), ["deal", "people", "other"]);
  assert.equal(calls[0].body.messages[0].content, FRONTIER_INDUSTRY_KIND_INSTRUCTIONS);
  assert.match(calls[0].body.messages[1].content, /\[3\]\n来源：STAT\n标题：A third item$/);
});

test("the list filter takes one kind of the closed list, and anything else is a 400", () => {
  const vocabulary = frontierDomainVocabulary();
  assert.equal(normalizeItemsQuery(new URLSearchParams({ industryKind: "financing" }), vocabulary).industryKind, "financing");
  assert.equal(normalizeItemsQuery(new URLSearchParams(), vocabulary).industryKind, null);
  assert.equal(normalizeItemsQuery(new URLSearchParams({ industryKind: "" }), vocabulary).industryKind, null);
  for (const value of ["merger", "融资与上市", "Deal", "deal,people", "industry"]) {
    assert.throws(() => normalizeItemsQuery(new URLSearchParams({ industryKind: value }), vocabulary), { code: "frontier_query_invalid" }, value);
  }
});

test("the eval's kind cases (evals/frontier-editing) are well formed and run through the edit and the backfill call the way the runner runs them", async () => {
  const cases = JSON.parse(await readFile(new URL("../../../evals/frontier-editing/cases.json", import.meta.url), "utf8")).industry_kind;
  assert.equal(cases.length, 16);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  const expected = new Set(cases.flatMap((entry) => entry.expect));
  for (const kind of FRONTIER_INDUSTRY_KINDS.filter((entry) => entry !== "other")) assert.ok(expected.has(kind), `a case for ${kind}`);
  assert.ok(expected.has(null), "a control that must carry no kind");
  for (const entry of cases) {
    assert.ok(entry.expect.every((/** @type {unknown} */ kind) => kind === null || FRONTIER_INDUSTRY_KINDS.includes(/** @type {any} */ (kind))), entry.id);
    assert.ok(entry.why && entry.edit.titleRaw && entry.edit.summary && entry.edit.sourceName, entry.id);
  }
  // The runner's two paths, with a model that answers each case as the case expects: the edit's stored kind and the batch call's.
  const lanes = FRONTIER_LANES;
  const byTitle = new Map(cases.map((entry) => [entry.edit.titleRaw, entry]));
  const editModel = async (/** @type {any} */ _deps, /** @type {any} */ call) => {
    const title = /标题：(.+)/.exec(call.body.messages[1].content)?.[1] ?? "";
    const entry = byTitle.get(title);
    assert.ok(entry, title);
    const kind = entry.expect[0];
    return { choices: [{ message: { content: JSON.stringify(answer({ genre: kind === null ? "paper" : "industry", industry_kind: kind ?? "", title_zh: "标题",
      summary_zh: "摘要。", reason_zh: "", lane: "pipeline", evidence_type: "other", scores: { impact: 1, novelty: 1, relevance: 1 } })) } }] };
  };
  const editor = new FrontierEditor(config, { owner, callModel: editModel });
  for (const entry of cases) {
    const edited = await editor.edit({ ...entry.edit, allowedLanes: lanes.filter((lane) => lane !== "mixed"), defaults: { lane: "pipeline" } });
    assert.ok(edited.output, entry.id);
    assert.equal(edited.output.genre === "industry" ? edited.output.industryKind : null, entry.expect[0], entry.id);
  }
  const askable = cases.filter((/** @type {any} */ entry) => !entry.expect.includes(null));
  const { callModel: batchModel } = stubModel([() => ({ items: askable.slice(0, 10).map((/** @type {any} */ entry, index) => ({ n: index + 1, industry_kind: entry.expect[0] })) }),
    () => ({ items: askable.slice(10).map((/** @type {any} */ entry, index) => ({ n: index + 1, industry_kind: entry.expect[0] })) })]);
  const batched = [];
  for (let at = 0; at < askable.length; at += FRONTIER_INDUSTRY_KIND_BATCH) {
    batched.push(...await new FrontierEditor(config, { owner, callModel: batchModel }).classifyIndustryKinds(askable.slice(at, at + FRONTIER_INDUSTRY_KIND_BATCH)
      .map((/** @type {any} */ entry) => ({ sourceName: entry.edit.sourceName, title: entry.edit.titleRaw, excerpt: entry.edit.summary }))));
  }
  assert.deepEqual(batched, askable.map((/** @type {any} */ entry) => entry.expect[0]));
});
