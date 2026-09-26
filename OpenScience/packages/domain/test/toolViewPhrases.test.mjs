// The words a tool call wears in a conversation.
//
// The point of the table is that it cannot go stale: the conversation body
// showed `mcp__evimed__drug_label_search` because nothing in the product knew
// what that tool was called in Chinese, and a hand-written list of forty
// names would go back to that one tool at a time. So the table is checked
// against the domain's own tool list, and against the copy-discipline of
// §5.10 — a row is the researcher's language, never the platform's.
import assert from "node:assert/strict";
import test from "node:test";

import {
  KERNEL_TOOL_VIEW_NAMES,
  MCP_TOOL_BASE_NAMES,
  MCP_TOOL_NAMES,
  TOOL_VIEW_PHRASE_NAMES,
  toolViewPhrase,
  toolViewPhraseTable,
} from "../index.mjs";

test("every tool the runtime publishes has a Chinese row, and the table names no tool the runtime does not have", () => {
  const table = toolViewPhraseTable();
  assert.ok(MCP_TOOL_BASE_NAMES.length >= 30, `only ${MCP_TOOL_BASE_NAMES.length} tools were read, so this test walked nothing`);
  for (const name of MCP_TOOL_NAMES) {
    assert.ok(table[name], `${name} has no verb phrase, so its call would show its wire name`);
  }
  for (const name of KERNEL_TOOL_VIEW_NAMES) assert.ok(table[name], `${name} has no verb phrase`);
  const known = new Set([...MCP_TOOL_BASE_NAMES, ...KERNEL_TOOL_VIEW_NAMES]);
  for (const name of TOOL_VIEW_PHRASE_NAMES) {
    assert.ok(known.has(name), `the table gives words to "${name}", which this runtime does not publish`);
  }
  assert.equal(Object.keys(table).length, MCP_TOOL_NAMES.length + KERNEL_TOOL_VIEW_NAMES.length);
});

test("a row is what a researcher did, in their language — never the platform's", () => {
  const table = toolViewPhraseTable();
  // The only Latin a verb may carry is a term a Chinese clinician writes in
  // Latin: the method (Meta), the surfaces measured (AI, GEO).
  const allowed = /\b(?:Meta|AI|GEO)\b/g;
  for (const [name, phrase] of Object.entries(table)) {
    assert.doesNotMatch(phrase.verb.replace(allowed, ""), /[A-Za-z]/, `${name} names itself in Latin: ${phrase.verb}`);
    assert.doesNotMatch(phrase.verb, /调用|请求|接口|网关|工具|服务器|返回/, `${name} explains the system: ${phrase.verb}`);
    assert.equal(phrase.verb.trim(), phrase.verb);
    assert.ok(phrase.verb.length > 0 && phrase.verb.length <= 12, `${name} is too long for one row: ${phrase.verb}`);
    // A subject is read from the call's own arguments, and only from fields a
    // caller names — never a path, an id of ours, or a tool name.
    for (const key of phrase.subject) {
      assert.match(key, /^[a-z][A-Za-z0-9_]*$/, `${name} reads a subject from "${key}"`);
      assert.doesNotMatch(key, /path|artifact|file|token|session|run/i, `${name} would put our own machinery on the row: ${key}`);
    }
    assert.ok(["text", "host"].includes(String(phrase.subjectKind)));
  }
});

test("the kernel's own rows are marked as takeovers, and a lookup answers by the name a row is keyed on", () => {
  const table = toolViewPhraseTable();
  assert.deepEqual([...KERNEL_TOOL_VIEW_NAMES], ["bash"]);
  assert.equal(table.bash.shipped, true, "a key the kernel already draws must be registered below the shipped entry");
  for (const name of MCP_TOOL_NAMES) assert.equal(table[name].shipped, false);
  assert.deepEqual(toolViewPhrase("mcp__evimed__drug_label_search"), { verb: "检索说明书", subject: ["drug", "query"], subjectKind: "text" });
  assert.equal(toolViewPhrase("bash")?.verb, "运行脚本");
  assert.equal(toolViewPhrase("drug_label_search"), null, "a row is keyed on the model-visible name, which is what the kernel hands the slot");
  assert.equal(toolViewPhrase("evimed_plan"), null, "the socket tools have cards of their own");
  assert.equal(toolViewPhrase(""), null);
});
