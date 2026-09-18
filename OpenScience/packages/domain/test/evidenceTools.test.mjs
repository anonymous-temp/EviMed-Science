import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_TOOL_BASE_NAMES,
  ROOT_VISIBLE_MCP_BASE_NAMES,
  mcpToolBaseName,
  narrateToolCall,
  phaseOfToolCall,
} from "../index.mjs";

test("locate_quote is a research tool the children use, not the orchestrator", () => {
  assert.ok(MCP_TOOL_BASE_NAMES.includes("locate_quote"));
  assert.equal(mcpToolBaseName("mcp__evimed__locate_quote"), "locate_quote");
  // Claim work happens in the delegated child that read the source; the root
  // plans and delegates, and every schema it carries is paid on each request.
  assert.equal(ROOT_VISIBLE_MCP_BASE_NAMES.includes("locate_quote"), false);
  assert.equal(phaseOfToolCall("mcp__evimed__locate_quote"), "claims");
});

test("a quotation check narrates its verdict in the reader's language", () => {
  const found = narrateToolCall("mcp__evimed__locate_quote", { quote: "low-dose aspirin did not prolong survival" }, { data: { found: true } });
  assert.equal(found.known, true);
  assert.match(found.text, /^核对引文：「low-dose aspirin did not…」 → 原文中有$/);
  assert.match(narrateToolCall("mcp__evimed__locate_quote", { quote: "x" }, { found: false }).text, /原文中未找到$/);
  assert.equal(narrateToolCall("mcp__evimed__locate_quote", { quote: "x" }).text, "核对引文：「x」");
});

test("reading what a search found is narrated and phased as reading", () => {
  const label = { labelId: "label:国药准字J20130078", sections: ["contraindications"] };
  assert.equal(narrateToolCall("mcp__evimed__drug_label_search", label).text, "读说明书：国药准字J20130078");
  assert.equal(
    narrateToolCall("mcp__evimed__drug_label_search", label, { data: { label: { genericName: "阿司匹林肠溶片" } } }).text,
    "读说明书：阿司匹林肠溶片（国药准字J20130078）",
  );
  assert.equal(narrateToolCall("mcp__evimed__drug_label_search", { drug: "阿司匹林" }, { items: [1, 2] }).text, "查说明书：阿司匹林 → 2 条");
  assert.equal(narrateToolCall("mcp__evimed__literature_search", { pmids: ["1", "2", "3"] }).text, "读摘要：3 篇 PubMed 记录");
  assert.equal(phaseOfToolCall("mcp__evimed__drug_label_search", label), "fulltext");
  assert.equal(phaseOfToolCall("mcp__evimed__drug_label_search", { drug: "阿司匹林" }), "search");
  assert.equal(phaseOfToolCall("mcp__evimed__literature_search", { pmids: ["1"] }), "screen");
  assert.equal(phaseOfToolCall("mcp__evimed__literature_search", { query: "aspirin" }), "search");
});
