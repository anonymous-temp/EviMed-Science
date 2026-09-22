// `frontier_search` in the shared vocabulary: a research tool the answer line
// may call (and a report may never name), a narration line in the reader's
// language, and a verdict for every code it can fail with.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CODE_FAMILIES,
  MCP_TOOL_BASE_NAMES,
  ROOT_VISIBLE_MCP_BASE_NAMES,
  RUNTIME_LEAKAGE_TOOL_TOKENS,
  classifyEvidenceSourceError,
  knownErrorCodeMessage,
  mcpToolBaseName,
  narrateToolCall,
} from "../index.mjs";

test("frontier_search is a published research tool the root answer line is shown, and one report prose may never name", () => {
  assert.ok(MCP_TOOL_BASE_NAMES.includes("frontier_search"));
  // The open-domain answer runs in the root session; a tool its persona may
  // call and the root is not shown would fail exactly the plain questions.
  assert.ok(ROOT_VISIBLE_MCP_BASE_NAMES.includes("frontier_search"));
  for (const spelling of ["frontier_search", "mcp__evimed__frontier_search", "evimed-research_frontier_search", "evimed_frontier_search"]) {
    assert.equal(mcpToolBaseName(spelling), "frontier_search", spelling);
  }
  assert.ok(RUNTIME_LEAKAGE_TOOL_TOKENS.includes("mcp__evimed__frontier_search"));
});

test("a feed lookup narrates as 查前沿动态 with its question, or the filters it was narrowed to", () => {
  /** @param {Record<string, any>} args @param {any} [result] */
  const narrate = (args, result) => narrateToolCall("mcp__evimed__frontier_search", args, result);
  assert.deepEqual(narrate({ q: "GLP-1 心衰" }), { text: "查前沿动态：「GLP-1 心衰」", known: true });
  assert.equal(narrate({ q: "司美格鲁肽", window: "7d" }, { data: { items: [1, 2, 3] } }).text, "查前沿动态：「司美格鲁肽」（近 7 天） → 3 条");
  assert.equal(narrate({ specialty: "cardiology", lane: "evidence" }).text, "查前沿动态：心血管·临床证据");
  assert.equal(narrate({ window: "24h" }).text, "查前沿动态：近 24 小时");
  // A result is narrated without its call's arguments; inventing a subject
  // there would describe a search that never ran.
  assert.equal(narrate({}, { text: "ok\n{}" }).text, "查前沿动态");
  assert.equal(narrate({ q: "x".repeat(60) }).text, `查前沿动态：「${"x".repeat(40)}…」`);
});

test("every way the feed can fail has a verdict: its absence never fails a run, a malformed call is the run's to fix", () => {
  const recoverable = ["frontier_disabled", "frontier_search_unconfigured", "frontier_search_unavailable", "frontier_search_timeout",
    "frontier_search_rate_limited", "frontier_search_upstream_error", "frontier_search_response_invalid",
    "frontier_search_response_too_large", "frontier_search_gateway_token_missing", "frontier_search_gateway_token_invalid"];
  const terminal = ["frontier_search_query_invalid", "frontier_search_lane_invalid", "frontier_search_specialty_invalid",
    "frontier_search_window_invalid", "frontier_search_mode_invalid", "frontier_search_limit_invalid",
    "frontier_search_request_invalid", "frontier_search_request_too_large"];
  for (const code of recoverable) assert.equal(classifyEvidenceSourceError(code), "recoverable", code);
  for (const code of terminal) assert.equal(classifyEvidenceSourceError(code), "terminal", code);
  for (const code of [...recoverable, ...terminal]) {
    assert.match(knownErrorCodeMessage(code) ?? "", /^前沿动态检索这次没能完成/, code);
  }
  // The family is the search's alone: the page's own codes are not a search
  // that failed and must not read as one.
  const [pattern] = ERROR_CODE_FAMILIES.find(([candidate]) => candidate.test("frontier_disabled")) ?? [];
  assert.ok(pattern);
  for (const code of ["frontier_not_enabled", "frontier_query_invalid", "frontier_item_not_found"]) assert.equal(pattern.test(code), false, code);
});
