/**
 * Every code the 「虚拟临床研究」 module emits is registered.
 *
 * The merge review of 2026-09-29 found 86 codes the module's sources raised and
 * `@evimed/domain`'s registry had never heard of: each rendered to a person as a
 * bare English identifier (or worse, as the family's 「稍后再试」 for a refusal
 * that retrying can never clear), and none was classified for the run. A code is
 * a promise about a sentence and a next step; this test holds every literal the
 * module's sources contain to that promise, so a code added anywhere in it
 * without a registry row goes red here rather than in front of a reader.
 *
 * The scan reads the sources as text — the codes are string literals at a
 * `throw`, a `refuse(...)`, an `issue(...)` or a table row, so the literals are
 * the codes. What the pattern cannot tell from a code is listed in
 * `NOT_CODES`, each with the reason; anything else that matches is a code.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  ALL_ERROR_CODES,
  MCP_TOOL_BASE_NAMES,
  VCR_MODULE_ERROR_CODES,
  VCR_WRITE_ISSUE_CODES,
  errorCodeMessage,
  errorCodeOutcome,
  knownErrorCodeMessage,
} from "@evimed/domain";

const SRC = new URL("../src/", import.meta.url);
const PYTHON_TOOL = new URL("../../../runtime/mcp/evimed-research/vcr_platform.py", import.meta.url);

/** Identifiers that match the pattern and are not codes. */
const NOT_CODES = new Map([
  // `trialRegistryClient.mjs` labels a table row `kind: "registry_field"`.
  ["registry_field", "a row kind in the registry record's table, never emitted as an error"],
]);

/** The pattern is the brief's; a code is a snake_case word starting `vcr_` or `registry_`. */
const CODE = /["'`]((?:vcr|registry)_[a-z0-9_]+)["'`]/g;

/**
 * @returns {Promise<Map<string, Set<string>>>} code → the files that spell it
 */
async function literalsInSources() {
  const files = (await readdir(SRC))
    .filter((name) => /^vcr.*\.mjs$/.test(name) || name === "trialRegistryClient.mjs")
    .sort()
    .map((name) => ({ name, url: new URL(name, SRC) }));
  files.push({ name: "runtime/mcp/evimed-research/vcr_platform.py", url: PYTHON_TOOL });
  /** @type {Map<string, Set<string>>} */
  const found = new Map();
  for (const file of files) {
    const text = await readFile(file.url, "utf8");
    for (const match of text.matchAll(CODE)) {
      const code = match[1];
      if (!found.has(code)) found.set(code, new Set());
      /** @type {Set<string>} */ (found.get(code)).add(file.name);
    }
  }
  return found;
}

/**
 * The MCP tool base names are not codes even where they start `vcr_`. Read from
 * the domain's list, not typed here, so a sixth tool needs no edit to this file.
 */
const toolNames = new Set(/** @type {readonly string[]} */ (MCP_TOOL_BASE_NAMES));

test("every code the module's sources spell is registered, and the walk proves it walked", async () => {
  const found = await literalsInSources();
  const registered = new Set(ALL_ERROR_CODES);
  const codes = [...found.keys()].filter((code) => !toolNames.has(code) && !NOT_CODES.has(code));

  // A scan that found a handful would be reporting a clean tree it never read.
  assert.ok(codes.length >= 50, `only ${codes.length} codes were found; the scan did not run`);
  assert.ok(found.has("vcr_study_paused"), "the routes' codes were read");
  assert.ok(found.has("vcr_engine_unreachable"), "the engine channel's codes were read");
  assert.ok(found.has("vcr_write_value_invalid"), "the gateway's per-item codes were read");
  assert.ok(found.has("registry_not_found"), "the registry client's codes were read");
  assert.ok(found.has("vcr_read"), "the tool names were matched by the pattern and then excluded, not missed");

  const unregistered = codes.filter((code) => !registered.has(code)).sort();
  assert.deepEqual(unregistered,
    [],
    `emitted but not registered in @evimed/domain's errorCodes.mjs:\n${unregistered.map((code) => `  ${code}  (${[...(found.get(code) ?? [])].join(", ")})`).join("\n")}`);
});

test("every exclusion is real: a tool name or a listed non-code, never a code that hides", async () => {
  const found = await literalsInSources();
  for (const [code, reason] of NOT_CODES) {
    assert.ok(found.has(code), `${code} is excluded but no longer appears in the sources (${reason}): drop it from NOT_CODES`);
    assert.equal(ALL_ERROR_CODES.includes(code), false, `${code} is excluded as a non-code but is registered as one`);
  }
  for (const name of toolNames) {
    if (name.startsWith("vcr_")) assert.equal(ALL_ERROR_CODES.includes(name), false, `${name} is a tool name and must not be an error code`);
  }
});

test("every code the module emits has a sentence of its own and is not a bare identifier", async () => {
  const found = await literalsInSources();
  const codes = [...found.keys()].filter((code) => !toolNames.has(code) && !NOT_CODES.has(code));
  const wordless = codes.filter((code) => !knownErrorCodeMessage(code));
  assert.deepEqual(wordless, [], "a code with no sentence renders as a bare identifier");
  // 「稍后再试」 is the family's answer for a code it does not know; a refusal that
  // retrying cannot clear must say what to do instead.
  const permanent = codes.filter((code) => /_(?:invalid|forbidden|unknown|not_found|not_approved|forbids)$/.test(code));
  assert.ok(permanent.length >= 15, `only ${permanent.length} permanent refusals were found`);
  const retrying = permanent.filter((code) => /稍后再试/.test(errorCodeMessage(code)));
  assert.deepEqual(retrying, [], "a permanent refusal is told to retry");
  for (const code of ["vcr_study_paused", "vcr_forbidden", "vcr_unavailable"]) {
    assert.ok(codes.includes(code) || ALL_ERROR_CODES.includes(code), code);
  }
  assert.equal(errorCodeMessage("vcr_study_paused"), "这个研究已暂停，继续之后再让 AI 做。");
  assert.equal(errorCodeMessage("vcr_forbidden"), "你在这个研究里没有做这件事的权限。");
  assert.equal(errorCodeMessage("vcr_unavailable"), "这个操作在当前部署里还没有开放。");
});

test("the module's codes are about the module, never a verdict on a run", () => {
  for (const code of [...VCR_MODULE_ERROR_CODES, ...VCR_WRITE_ISSUE_CODES]) {
    assert.equal(errorCodeOutcome(code), "upstream", code);
  }
});
