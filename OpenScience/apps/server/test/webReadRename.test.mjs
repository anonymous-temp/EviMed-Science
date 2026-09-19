// `official_page_fetch` became `web_read` on 2026-09-20 (contract X4): one
// tool, extended and renamed, not two. A name left anywhere a run, a skill, a
// manifest, a test or a script reads it is a tool the kernel no longer mounts —
// a skill telling a run to call it degrades that run silently. So the old name
// may survive only in history: the changelog, recorded runs and wire captures,
// and the one alias that keeps ledgers written before the rename readable.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mcpToolBaseName } from "@evimed/domain";

const openScience = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RETIRED = "official_page_fetch";

/** Directories that are records of what happened, not instructions. */
const HISTORY_DIRS = new Set([
  "evals/capability-audit/results",   // recorded tool probes
  "evals/method-quality/results",     // recorded evaluation runs
  "evals/title-to-paper/runs",        // recorded evaluation runs
  "apps/server/test/fixtures/dsh",    // golden frames recorded from the live wire
]);

/** Files that may name it, and why. */
const HISTORY_FILES = new Map([
  ["PROGRESS.md", "the changelog"],
  ["packages/domain/src/toolNames.mjs", "the retired-name alias that keeps pre-rename ledgers readable"],
  ["packages/domain/test/vocabulary.test.mjs", "the test of that alias"],
  ["runtime/mcp/evimed-research/web_read.py", "the module's account of what it was renamed from"],
  ["apps/server/test/webReadRename.test.mjs", "this test"],
]);

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".pytest_cache", "coverage"]);
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|xlsx|docx|pptx|db|sqlite|woff2?|ttf|otf|wasm|parquet|pkl|npz|npy|bin)$/i;

async function* files(dir, relative = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name) || HISTORY_DIRS.has(rel)) continue;
      yield* files(path.join(dir, entry.name), rel);
    } else if (entry.isFile() && !BINARY.test(entry.name)) {
      yield rel;
    }
  }
}

test("the retired tool name survives only in history", async () => {
  const survivors = [];
  const seen = new Set();
  for await (const rel of files(openScience)) {
    seen.add(rel);
    const text = await readFile(path.join(openScience, rel), "utf8").catch(() => "");
    if (text.includes(RETIRED) && !HISTORY_FILES.has(rel)) survivors.push(rel);
  }
  // The walk has to have walked: a broken walk would pass forever.
  for (const expected of [
    "runtime/mcp/evimed-research/server.py",
    "packages/domain/src/toolNames.mjs",
    "capabilities/clinical-evidence-synthesis/SKILL.md",
    "deploy/runtime-dsh/capabilities/clinical-evidence-synthesis.json",
    "evals/tool-graph/tdg.clinical-evidence-synthesis.json",
  ]) {
    assert.ok(seen.has(expected), `the scan never reached ${expected}; it is not reading the tree`);
  }
  assert.ok(seen.size > 500, `the scan read only ${seen.size} files`);
  assert.deepEqual(survivors, [], `these still name ${RETIRED}: ${survivors.join(", ")}`);
});

test("history written before the rename still reads as the tool it recorded", () => {
  for (const spelling of [RETIRED, `mcp__evimed__${RETIRED}`, `evimed_${RETIRED}`, `evimed-research_evimed_${RETIRED}`]) {
    assert.equal(mcpToolBaseName(spelling), "web_read", spelling);
  }
  assert.equal(mcpToolBaseName("mcp__evimed__web_read"), "web_read");
});
