// 「循证 GEO」's shared words: the closed vocabularies every package reads, the
// three runtime tools as published research tools, the error codes they and
// the routes answer with, and how the tools narrate.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_ERROR_CODES,
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
  ];
  for (const [words, labels] of pairs) {
    assert.deepEqual(Object.keys(labels).sort(), [...words].sort());
    for (const word of words) assert.ok(labels[word]?.trim(), word);
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
  assert.equal(narrateToolCall("mcp__evimed__geo_read", { what: "diagnosis" }).text, "读取 GEO 项目：诊断");
  assert.equal(narrateToolCall("mcp__evimed__geo_write", { what: "lock_questions" }).text, "写入 GEO 项目：锁定测量问句");
  assert.equal(narrateToolCall("mcp__evimed__geo_write", { what: "toString" }).text, "写入 GEO 项目：数据");
  assert.equal(narrateToolCall("mcp__evimed__social_posts_search", { query: "降糖药" }, { data: { posts: [{}, {}] } }).text,
    "采集社媒真实问法：「降糖药」 → 2 条");
});

test("the tool codes are classified for a run, the route codes are registered, and each family answers only its own", () => {
  const recoverable = ["geo_disabled", "geo_no_project", "geo_unconfigured", "geo_gateway_unreachable", "geo_gateway_unavailable",
    "geo_gateway_timeout", "geo_gateway_rate_limited", "geo_gateway_token_missing", "geo_gateway_token_invalid", "geo_upstream_error",
    "geo_response_invalid", "geo_response_too_large", "social_posts_unconfigured"];
  const terminal = ["geo_request_invalid", "geo_request_too_large", "geo_read_what_invalid", "geo_read_filter_invalid", "geo_write_what_invalid",
    "geo_write_payload_invalid", "social_posts_query_invalid", "social_posts_platform_invalid", "social_posts_sort_invalid", "social_posts_limit_invalid"];
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
