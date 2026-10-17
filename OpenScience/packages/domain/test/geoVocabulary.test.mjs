// 「循证 GEO」's shared words: the closed vocabularies every package reads, the
// three runtime tools as published research tools, the error codes they and
// the routes answer with, and how the tools narrate.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_ERROR_CODES,
  GEO_METRICS,
  GEO_METRIC_IDS,
  GEO_METRIC_LABELS_ZH,
  GEO_METRIC_UNITS,
  GEO_ARTICLE_CHANNELS,
  geoMetricId,
  geoMetricName,
  geoMetricUnit,
  geoVisibleQuestion,
  geoVisibleQuestionOfReason,
  ERROR_CODE_FAMILIES,
  GEO_ARTICLE_LAYERS,
  GEO_ARTICLE_LAYER_LABELS_ZH,
  GEO_DEFAULT_ENGINES,
  GEO_ENGINES,
  GEO_ENGINE_LABELS_ZH,
  GEO_FAILURE_MODES,
  GEO_FAILURE_MODE_LABELS_ZH,
  GEO_GAP_CLASSES,
  GEO_GAP_CLASS_LABELS_ZH,
  GEO_VIEW_METRIC_IDS,
  GEO_OVERVIEW_METRICS,
  GEO_OWNED_LINK_PLATFORMS,
  GEO_OWNED_LINK_PLATFORM_LABELS_ZH,
  GEO_POOLS,
  GEO_POOL_LABELS_ZH,
  GEO_READ_WHATS,
  GEO_READ_WHAT_LABELS_ZH,
  GEO_ROUND_KINDS,
  GEO_ROUND_KIND_LABELS_ZH,
  GEO_ROUTE_ERROR_CODES,
  GEO_SOCIAL_PLATFORMS,
  GEO_SOCIAL_PLATFORM_LABELS_ZH,
  GEO_SOURCE_KINDS,
  GEO_SOURCE_KIND_LABELS_ZH,
  GEO_STEPS,
  GEO_STEP_ACTION_LABELS_ZH,
  GEO_STEP_LABELS_ZH,
  GEO_VOCABULARIES,
  GEO_WRITE_WHATS,
  GEO_WRITE_WHAT_LABELS_ZH,
  MCP_TOOL_BASE_NAMES,
  ROOT_VISIBLE_MCP_BASE_NAMES,
  RUNTIME_LEAKAGE_TOOL_TOKENS,
  classifyEvidenceSourceError,
  errorCodeOutcome,
  geoArticlePublishable,
  isGeoValue,
  knownErrorCodeMessage,
  narrateToolCall,
} from "../index.mjs";

test("every GEO vocabulary is a frozen list of distinct plain words, and the walk proves it walked", () => {
  const names = Object.keys(GEO_VOCABULARIES);
  assert.ok(names.length >= 40, `only ${names.length} vocabularies were walked`);
  for (const [name, list] of Object.entries(GEO_VOCABULARIES)) {
    assert.ok(Object.isFrozen(list), `${name} is not frozen`);
    assert.ok(list.length > 0, `${name} is empty`);
    assert.equal(new Set(list).size, list.length, `${name} repeats a word`);
    // The schema splices these into CHECKs: their shape is the safety.
    for (const word of list) assert.match(word, /^[A-Za-z0-9_]+$/, `${name}: ${word}`);
  }
  assert.ok(isGeoValue("pool", "P3"));
  assert.equal(isGeoValue("pool", "P5"), false);
  assert.equal(isGeoValue("no-such-vocabulary", "P1"), false);
});

test("every word a reader can meet has a Chinese label, and no label names a word that does not exist", () => {
  /** @type {Array<[readonly string[], Readonly<Record<string, string>>]>} */
  const pairs = [
    [GEO_POOLS, GEO_POOL_LABELS_ZH], [GEO_ENGINES, GEO_ENGINE_LABELS_ZH], [GEO_STEPS, GEO_STEP_LABELS_ZH],
    [GEO_FAILURE_MODES, GEO_FAILURE_MODE_LABELS_ZH], [GEO_SOURCE_KINDS, GEO_SOURCE_KIND_LABELS_ZH],
    [GEO_ARTICLE_LAYERS, GEO_ARTICLE_LAYER_LABELS_ZH], [GEO_SOCIAL_PLATFORMS, GEO_SOCIAL_PLATFORM_LABELS_ZH],
    [GEO_GAP_CLASSES, GEO_GAP_CLASS_LABELS_ZH], [GEO_ROUND_KINDS, GEO_ROUND_KIND_LABELS_ZH],
    [GEO_READ_WHATS, GEO_READ_WHAT_LABELS_ZH], [GEO_WRITE_WHATS, GEO_WRITE_WHAT_LABELS_ZH],
    [GEO_OWNED_LINK_PLATFORMS, GEO_OWNED_LINK_PLATFORM_LABELS_ZH],
  ];
  for (const [words, labels] of pairs) {
    assert.deepEqual(Object.keys(labels).sort(), [...words].sort());
    for (const word of words) assert.ok(labels[word]?.trim(), word);
    // A reader sees these (the conversation narrates `geo_read` / `geo_write`
    // with them): the spec's word is 结论, and 主张 is retired (§12.4).
    for (const word of words) assert.doesNotMatch(labels[word], /主张/, `${word}: ${labels[word]}`);
  }
});

test("the default engines are measurable engines, the overview reads four metrics, and M-01S is the headline mention", () => {
  for (const engine of GEO_DEFAULT_ENGINES) assert.ok(GEO_ENGINES.includes(engine), engine);
  assert.ok(GEO_ENGINES.includes("baidu"), "文心 carries the owner's yaml id");
  assert.equal(GEO_DEFAULT_ENGINES.includes("baidu"), false, "baidu is measured through the inclusion channel only");
  assert.deepEqual(GEO_OVERVIEW_METRICS.map((entry) => entry.key), ["gvi", "mention", "accuracy", "citation"]);
  assert.deepEqual(GEO_OVERVIEW_METRICS.map((entry) => entry.metricId), ["M-19", "M-01S", "M-06", "M-08"],
    "the index is M-19, mention is M-01S over P2 and P3");
  assert.equal(GEO_OVERVIEW_METRICS[1].metricId, GEO_VIEW_METRIC_IDS.mentionHeadline);
});

test("an article is publishable only with a passed gate and no open safety finding", () => {
  assert.equal(geoArticlePublishable({ gate: "passed", safety: "clear" }), true);
  assert.equal(geoArticlePublishable({ gate: "passed", safety: "released" }), true);
  assert.equal(geoArticlePublishable({ gate: "passed", safety: "open" }), false);
  assert.equal(geoArticlePublishable({ gate: "unverified", safety: "clear" }), false);
  assert.equal(geoArticlePublishable({ gate: "failed", safety: "released" }), false);
  assert.equal(geoArticlePublishable({}), false);
});

test("the three GEO tools are published research tools, delegated rather than root-visible, and banned from report prose", () => {
  for (const tool of ["geo_read", "geo_write", "social_posts_search"]) {
    assert.ok(MCP_TOOL_BASE_NAMES.includes(tool), tool);
    assert.equal(ROOT_VISIBLE_MCP_BASE_NAMES.includes(tool), false, `${tool} rides only the GEO capabilities' children`);
    assert.ok(RUNTIME_LEAKAGE_TOOL_TOKENS.includes(`mcp__evimed__${tool}`), tool);
  }
});

test("the tools narrate in the page's words, and an unknown `what` narrates as data", () => {
  assert.equal(narrateToolCall("mcp__evimed__geo_read", { what: "diagnosis" }).text, "读取循证 GEO 项目：诊断");
  assert.equal(narrateToolCall("mcp__evimed__geo_write", { what: "lock_questions" }).text, "写入循证 GEO 项目：锁定测量问句");
  assert.equal(narrateToolCall("mcp__evimed__geo_write", { what: "toString" }).text, "写入循证 GEO 项目：数据");
  assert.equal(narrateToolCall("mcp__evimed__social_posts_search", { query: "降糖药" }, { data: { posts: [{}, {}] } }).text,
    "采集社媒真实问法：「降糖药」 → 2 条");
});

test("the tool codes are classified for a run, the route codes are registered, and each family answers only its own", () => {
  const recoverable = ["geo_disabled", "geo_no_project", "geo_unconfigured", "geo_gateway_unreachable", "geo_gateway_unavailable",
    "geo_gateway_timeout", "geo_gateway_rate_limited", "geo_gateway_token_missing", "geo_gateway_token_invalid", "geo_upstream_error",
    "geo_response_invalid", "geo_response_too_large", "social_posts_unconfigured"];
  const terminal = ["geo_request_invalid", "geo_request_too_large", "geo_read_what_invalid", "geo_read_filter_invalid", "geo_write_what_invalid",
    "geo_write_payload_invalid", "geo_write_rejected", "social_posts_query_invalid", "social_posts_platform_invalid", "social_posts_sort_invalid", "social_posts_limit_invalid"];
  for (const code of recoverable) assert.equal(classifyEvidenceSourceError(code), "recoverable", code);
  for (const code of terminal) assert.equal(classifyEvidenceSourceError(code), "terminal", code);
  const [toolFamily] = ERROR_CODE_FAMILIES.find(([pattern]) => pattern.test("geo_disabled")) ?? [];
  assert.ok(toolFamily, "the tool codes have a family");
  for (const code of [...recoverable, ...terminal]) assert.ok(toolFamily.test(code), `${code} falls outside the tool family`);
  assert.ok(GEO_ROUTE_ERROR_CODES.length >= 20);
  for (const code of GEO_ROUTE_ERROR_CODES) {
    assert.ok(ALL_ERROR_CODES.includes(code), code);
    assert.equal(toolFamily.test(code), false, `${code} is a page's code, not a run's`);
    assert.ok(knownErrorCodeMessage(code), code);
    assert.equal(errorCodeOutcome(code), "upstream", code);
    assert.equal(classifyEvidenceSourceError(code), "unknown", `${code} must never reach a run's verdict`);
  }
  // The probe's own family is untouched.
  assert.match(knownErrorCodeMessage("geo_probe_timeout") ?? "", /可见度探测/);
});

test('members: the owner may do everything, each member role only what it names, and several roles are the union of theirs', async () => {
  const { GEO_ABILITIES, GEO_MEMBER_ROLES, GEO_ROLE_ABILITIES, geoAbilitiesOf, geoRoleAllows } = await import('../index.mjs')
  assert.deepEqual([...GEO_MEMBER_ROLES], ['editor', 'medical_reviewer', 'viewer'], 'the owner is not a member role: it is the project row')
  assert.deepEqual([...GEO_ROLE_ABILITIES.owner], [...GEO_ABILITIES])
  assert.deepEqual(geoAbilitiesOf(['viewer']), ['read'])
  assert.deepEqual(geoAbilitiesOf(['editor']), ['read', 'edit', 'run'])
  assert.deepEqual(geoAbilitiesOf(['medical_reviewer']), ['read', 'review'])
  assert.deepEqual(geoAbilitiesOf(['editor', 'medical_reviewer']), ['read', 'edit', 'run', 'review'], 'the union, in the order of the abilities')
  for (const role of GEO_MEMBER_ROLES) {
    for (const money of ['manage_money', 'manage_members', 'delete']) assert.equal(geoRoleAllows(role, money), false, `${role} ${money}`)
  }
  assert.equal(geoRoleAllows('medical_reviewer', 'run'), false, 'the reviewer does not run the programme')
  assert.equal(geoRoleAllows('editor', 'review'), false, 'an editor does not release a safety stop')
  assert.equal(geoRoleAllows('intruder', 'read'), false)
  assert.deepEqual(geoAbilitiesOf([]), [])
})

test("a metric id has one reader name and a name one id: the table every page, report and tool reads", () => {
  // The web kept two tables (by id, and by the overview's four keys) and named M-01S two ways, so 「品牌提及率 目标 12%」 stood beside
  // 「品牌提及率（增量）目标 20%」 and read as a contradiction. There is one table now, and this walks it both ways.
  const ids = [...GEO_METRIC_IDS, "NET", "NOISE"];
  const labels = /** @type {Record<string, string>} */ (GEO_METRIC_LABELS_ZH);
  const units = /** @type {Record<string, string>} */ (GEO_METRIC_UNITS);
  for (const id of ids) {
    assert.ok(typeof labels[id] === "string" && labels[id].length > 0, `${id} has no reader name`);
    assert.ok(["percent", "index", "count"].includes(units[id]), `${id} has no unit`);
  }
  assert.deepEqual(Object.keys(GEO_METRIC_LABELS_ZH).sort(), [...ids].sort(), "the table names exactly the metrics there are");
  const names = Object.values(GEO_METRIC_LABELS_ZH);
  assert.equal(new Set(names).size, names.length, "no name stands for two ids");
  assert.equal(GEO_METRIC_LABELS_ZH["M-01"], "品牌提及率");
  assert.equal(GEO_METRIC_LABELS_ZH["M-01S"], "品类问题可见率");
  assert.notEqual(GEO_METRIC_LABELS_ZH["M-01S"], GEO_METRIC_LABELS_ZH["M-01"], "mention over a pool and mention over the category questions are not one name");
  // a reader asking by the overview's key gets the id's name
  for (const { key, metricId } of GEO_OVERVIEW_METRICS) {
    assert.equal(geoMetricName(key), labels[metricId], key);
    assert.equal(geoMetricId(key), metricId);
  }
  assert.equal(geoMetricName("retrieval"), labels["M-10"]);
  assert.equal(geoMetricName("M-06"), "事实准确率");
  assert.equal(geoMetricName("constructor"), null, "a word that is not a metric is never printed");
  assert.equal(geoMetricName(null), null);
  assert.equal(geoMetricUnit("M-19"), "index");
  assert.equal(geoMetricUnit("M-07"), "count");
  assert.equal(geoMetricUnit("gvi"), "index");
  assert.equal(geoMetricUnit("nope"), "percent");
  // the unit agrees with the catalogue where the catalogue has one that is a rate or a count
  for (const metric of GEO_METRICS.metrics) {
    if (metric.unit === "percent") assert.equal(units[metric.id], "percent", metric.id);
    if (metric.unit === "count") assert.equal(units[metric.id], "count", metric.id);
  }
});

test("an article's channel is an owned platform of the brand or the media market, never free text", () => {
  assert.deepEqual(GEO_ARTICLE_CHANNELS, [...GEO_OWNED_LINK_PLATFORMS, "media_market"]);
});

test("a programme run is asked in a sentence of the person's words: one verb and one object per step, the batch, the document, the question", () => {
  // The step's own verb is the table's, and the table names every step there is (the page's step buttons read it too).
  assert.deepEqual(Object.keys(GEO_STEP_ACTION_LABELS_ZH).sort(), [...GEO_STEPS].sort());
  const actions = /** @type {Record<string, string>} */ (GEO_STEP_ACTION_LABELS_ZH);
  for (const step of GEO_STEPS) assert.equal(geoVisibleQuestion({ purpose: step, steps: [step] }), actions[step], step);
  // The insight run covers steps one to three in the order of the programme, whatever order they come in; the strategy run is the sources step.
  assert.equal(geoVisibleQuestion({ purpose: "insight", steps: ["questions", "evidence", "journey"] }), "整理产品证据、绘制患者旅程、列出测量问题");
  assert.equal(geoVisibleQuestion({ purpose: "insight", steps: ["journey"] }), "绘制患者旅程");
  assert.equal(geoVisibleQuestion({ purpose: "strategy", steps: ["sources"] }), "分析引用的信源");
  // A content batch is told by its number; the round after a weekly report has none.
  assert.equal(geoVisibleQuestion({ purpose: "content", steps: ["content"], batch: 2 }), "写第 2 批稿件");
  assert.equal(geoVisibleQuestion({ purpose: "content", steps: ["content"], batch: "第 2026-10-12 周之后的一批" }), "写下一批稿件");
  assert.equal(geoVisibleQuestion({ purpose: "content", steps: ["content"], batch: 0 }), "写下一批稿件");
  // The documents the platform writes; the week is the Monday it names.
  assert.equal(geoVisibleQuestion({ purpose: "export", exportKind: "weekly", week: "2026-10-12" }), "生成10月12日这一周的周报");
  assert.equal(geoVisibleQuestion({ purpose: "export", exportKind: "weekly" }), "生成周报");
  assert.equal(geoVisibleQuestion({ purpose: "export", exportKind: "weekly", week: "next Monday" }), "生成周报", "a week that is not a date is not printed");
  assert.equal(geoVisibleQuestion({ purpose: "export", exportKind: "proposal" }), "生成提案资料包");
  // A research task is its own question, on one line and not longer than a title.
  assert.equal(geoVisibleQuestion({ purpose: "research", question: "玛仕度肽的\n心血管获益\t证据" }), "做专题研究：玛仕度肽的 心血管获益 证据");
  assert.equal(geoVisibleQuestion({ purpose: "research", question: "  " }), "做专题研究");
  const longQuestion = geoVisibleQuestion({ purpose: "research", question: "证据".repeat(80) });
  assert.ok([...longQuestion].length <= 70 && longQuestion.endsWith("…"), longQuestion);
  // Total: whatever is missing reads as the project's work, never as a machine instruction.
  for (const input of [undefined, {}, { purpose: "nonsense" }, { purpose: null, steps: [] }, { purpose: "insight" }]) {
    assert.equal(geoVisibleQuestion(/** @type {any} */ (input)), "推进项目", JSON.stringify(input));
  }
});

test("no sentence a run is asked in carries the platform's own words, and each is one short line", () => {
  // The closed inputs: the only free text in any sentence is a research task's own question, which is the task's and is cut at a title's length.
  const inputs = [
    ...GEO_STEPS.map((step) => ({ purpose: step, steps: [step] })),
    { purpose: "insight", steps: ["evidence", "journey", "questions"] }, { purpose: "strategy", steps: ["sources"] },
    { purpose: "content", batch: 1 }, { purpose: "content", batch: "第 2026-10-12 周之后的一批" },
    { purpose: "export", exportKind: "weekly", week: "2026-10-12" }, { purpose: "export", exportKind: "proposal" },
    { purpose: "research" }, { purpose: "research", question: "玛仕度肽在肥胖合并高血压人群里的血压获益有多大" }, {},
  ];
  const reasons = [...GEO_STEPS.map((step) => `geo:${step}`), "geo:content", "geo:research", "geo:export-weekly", "geo:export-proposal", "geo:future", "geo:", "", null];
  assert.ok(inputs.length >= 17 && reasons.length >= 13, "the walk walked");
  const sentences = [...inputs.map((input) => geoVisibleQuestion(input)), ...reasons.map((reason) => geoVisibleQuestionOfReason(reason))];
  for (const sentence of sentences) {
    assert.ok(sentence.trim() && !/[\r\n]/.test(sentence) && [...sentence].length <= 70, sentence);
    assert.doesNotMatch(sentence, /geo_|evimed|mcp__|deliverable|<|>/, sentence);
  }
});

test("a run is named from its route reason alone: old runs and new, the first step for a run of several", () => {
  assert.equal(geoVisibleQuestionOfReason("geo:evidence"), "整理产品证据");
  assert.equal(geoVisibleQuestionOfReason("geo:journey"), "绘制患者旅程");
  assert.equal(geoVisibleQuestionOfReason("geo:questions"), "列出测量问题");
  assert.equal(geoVisibleQuestionOfReason("geo:sources"), "分析引用的信源");
  assert.equal(geoVisibleQuestionOfReason("geo:content"), "写一批稿件");
  assert.equal(geoVisibleQuestionOfReason("geo:research"), "做专题研究");
  assert.equal(geoVisibleQuestionOfReason("geo:export-weekly"), "生成周报");
  assert.equal(geoVisibleQuestionOfReason("geo:export-proposal"), "生成提案资料包");
  for (const other of ["vcr:definition", "session-binding", "geo:unheard-of", "geo:", "", null, undefined]) {
    assert.equal(geoVisibleQuestionOfReason(other), "推进项目", String(other));
  }
});
