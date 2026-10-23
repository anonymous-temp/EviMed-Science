// The MCP adapter for external agents (`runtime/mcp/evimed-memory/server.py`) runs outside the repository's runtime and so carries a
// copy of the API's closed vocabularies. A copy of a closed vocabulary is wrong the first time the vocabulary moves, and this one was:
// three of its six fact kinds were never kinds, and a recall asking for `method` answered 400 (2026-10-23 review). This holds the copy
// to the domain's, by reading the Python source, so the next kind added to the domain cannot be missing from the adapter.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { AGENT_RECALL_MAX_CAPSULES, AGENT_RECALL_METHOD_MODES } from "../src/agentMemoryRecall.mjs";
import { AGENT_SUBJECT_PATTERN } from "../src/agentApiKeys.mjs";

const source = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../runtime/mcp/evimed-memory/server.py"), "utf8");

/** The words of a Python tuple of strings assigned to `name`. @param {string} name */
function tupleOf(name) {
  const match = new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(source);
  assert.ok(match, `${name} is not assigned in server.py`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((word) => word[1]);
}

test("the adapter's fact kinds, method modes and capsule bound are the API's own, in order", () => {
  assert.deepEqual(tupleOf("FACT_KINDS"), [...CAPSULE_FACT_KINDS]);
  assert.deepEqual(tupleOf("METHOD_MODES"), [...AGENT_RECALL_METHOD_MODES]);
  assert.equal(Number(/^MAX_CAPSULE_IDS = (\d+)$/m.exec(source)?.[1]), AGENT_RECALL_MAX_CAPSULES);
});

test("the adapter sends the person a call is for as a header, and bounds the identifier the way the API's own pattern does", () => {
  assert.match(source, /"x-subject": subject/);
  assert.match(source, /"minLength": 1, "maxLength": 128/);
  assert.equal(AGENT_SUBJECT_PATTERN.test("a".repeat(128)), true);
  assert.equal(AGENT_SUBJECT_PATTERN.test("a".repeat(129)), false, "the adapter's 128 is the pattern's 128");
});
