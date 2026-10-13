// The official OpenViking memory plugin's five tools, as the platform's vocabulary knows them.
import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENVIKING_MCP_TOOL_PREFIX,
  OPENVIKING_MEMORY_TOOL_BASE_NAMES,
  OPENVIKING_MEMORY_TOOL_NAMES,
  isEviMedToolName,
  isMcpToolName,
  isOpenVikingMemoryToolName,
  isOpenVikingToolName,
  narrateToolCall,
} from "../index.mjs";

test("exactly the memory gateway's five tools are admitted, under the name the model sees", () => {
  assert.deepEqual([...OPENVIKING_MEMORY_TOOL_BASE_NAMES], ["search", "read", "list", "remember", "forget"]);
  assert.deepEqual(OPENVIKING_MEMORY_TOOL_NAMES.map((name) => name.slice(OPENVIKING_MCP_TOOL_PREFIX.length)), [...OPENVIKING_MEMORY_TOOL_BASE_NAMES]);
  assert.equal(OPENVIKING_MCP_TOOL_PREFIX, "mcp__openviking__");
  for (const name of OPENVIKING_MEMORY_TOOL_NAMES) assert.ok(isOpenVikingMemoryToolName(name), name);
  // The plugin's server advertises more (add a resource, add a skill, write a file): none of them is a memory tool.
  for (const other of ["add_resource", "add_skill", "find", "grep", "store", "recall"]) {
    assert.equal(isOpenVikingMemoryToolName(`${OPENVIKING_MCP_TOOL_PREFIX}${other}`), false, other);
    assert.equal(isOpenVikingToolName(`${OPENVIKING_MCP_TOOL_PREFIX}${other}`), true, other);
  }
  assert.equal(isOpenVikingMemoryToolName("search"), false, "a bare name is not the model-visible one");
});

test("they are not the research server's: calling one is not research work", () => {
  for (const name of OPENVIKING_MEMORY_TOOL_NAMES) {
    assert.equal(isMcpToolName(name), false, name);
    assert.equal(isEviMedToolName(name), false, name);
  }
});

test("a reader is told what was asked of their memory, never an address", () => {
  const search = narrateToolCall("mcp__openviking__search", { query: "我的统计偏好" }, { results: [1, 2] });
  assert.deepEqual(search, { text: "查记忆：「我的统计偏好」 → 2 条", known: true });
  assert.equal(narrateToolCall("mcp__openviking__read", { uris: ["viking://user/u1/memories/preferences/a.md"] }).text, "读记忆");
  assert.equal(narrateToolCall("mcp__openviking__list", { uri: "viking://user/u1/memories" }).text, "翻记忆");
  assert.equal(narrateToolCall("mcp__openviking__remember", { messages: [{ role: "user", content: "记住我只用 R 做生存分析" }] }).text, "记住：记住我只用 R 做生存分析");
  assert.equal(narrateToolCall("mcp__openviking__forget", { uri: "viking://user/u1/memories/preferences/a.md" }).text, "忘记一条记忆");
  for (const call of ["read", "list", "forget"]) assert.ok(!/viking/.test(narrateToolCall(`mcp__openviking__${call}`, { uri: "viking://x", uris: ["viking://x"] }).text));
  // A tool outside the five is the generic, counted unknown.
  assert.equal(narrateToolCall("mcp__openviking__add_resource", {}).known, false);
});
