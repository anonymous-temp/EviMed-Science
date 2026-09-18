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
