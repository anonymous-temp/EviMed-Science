import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PASTED_RULE_V1, renderMemoryTemplates } from "../../../deploy/web/openviking/memory-templates-src/build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const build = path.join(root, "deploy/web/openviking/memory-templates-src/build.mjs");
const personal = new Set(["preferences.yaml", "corrections.yaml", "profile.yaml"]);
const unindent = text => text.split("\n").map(line => line.startsWith("  ") ? line.slice(2) : line).join("\n");

test("the pasted-material variant scopes attribution to personal types and keeps the ordinary retention rules", () => {
  const current = renderMemoryTemplates();
  const candidate = renderMemoryTemplates({ pastedRule: "v1" });
  assert.deepEqual(Object.keys(candidate), Object.keys(current));
  for (const [name, text] of Object.entries(candidate)) {
    if (!personal.has(name)) { assert.equal(text, current[name], name); continue; }
    assert.equal(unindent(text).split(PASTED_RULE_V1).length - 1, 1, `${name}: exactly one attribution block`);
    assert.ok(text.indexOf("# Whose instruction is it?") < text.indexOf("# What is never kept"), name);
    assert.ok(text.includes("Uncertainty favors keeping"), `${name}: no usefulness veto`);
    assert.ok(text.includes("in the first conversation"), `${name}: no repetition requirement`);
  }
  assert.match(PASTED_RULE_V1, /even without quotation marks/);
  assert.match(PASTED_RULE_V1, /including a choice they separately adopt from a document/);
  assert.match(PASTED_RULE_V1, /NOTES as "document says"/);
  assert.match(PASTED_RULE_V1, /Contrastive example pair:/);
  assert.throws(() => renderMemoryTemplates({ pastedRule: /** @type {any} */ ("unknown") }), /unknown pasted-rule variant/);
});

test("the CLI renders the candidate only to an explicit lab directory", async () => {
  const refused = spawnSync(process.execPath, [build, "--pasted-rule", "v1"], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /never over the deployed templates/);
  const directory = await mkdtemp(path.join(os.tmpdir(), "pasted-templates-"));
  try {
    const result = spawnSync(process.execPath, [build, "--pasted-rule", "v1", "--out", directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const expected = renderMemoryTemplates({ pastedRule: "v1" });
    assert.deepEqual((await readdir(directory)).sort(), Object.keys(expected).sort());
    for (const [name, text] of Object.entries(expected)) assert.equal(await readFile(path.join(directory, name), "utf8"), text, name);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
