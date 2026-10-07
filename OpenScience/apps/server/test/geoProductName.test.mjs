// The module is 「循证传播」 (evidence-flywheel plan §5.6, renamed 2026-10-06); "GEO" is its code
// name and the platform's other GEO is NCBI's expression database, so no sentence a reader or a
// model is given may call the module 「循证 GEO」 again. The web shell has the same guard in
// `retiredWords.test.ts`; this one walks the server's strings, the domain's, the capabilities'
// manifests and skill text, and the runtime tools'.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RETIRED_NAME = /循证\s?GEO/;

/** @param {string} dir @param {RegExp} kind @returns {Promise<string[]>} */
async function walk(dir, kind) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full, kind)));
    else if (kind.test(entry.name)) found.push(full);
  }
  return found;
}

test("no server, domain, capability or runtime-tool text calls the module 循证 GEO", async () => {
  const roots = [
    ["apps/server/src", /\.mjs$/],
    ["packages/domain/src", /\.(mjs|json)$/],
    ["capabilities", /\.(yaml|md)$/],
    ["capability-skills", /\.md$/],
    ["deploy/runtime-dsh/capabilities", /\.json$/],
    ["runtime/mcp/evimed-research", /\.py$/],
    ["packages/harness-port/src", /\.mjs$/],
    ["packages/socket/plugins", /\.mjs$/],
  ];
  let walked = 0;
  const guilty = [];
  for (const [root, kind] of roots) {
    for (const file of await walk(path.join(repoRoot, root), kind)) {
      if (file.includes(`${path.sep}test${path.sep}`)) continue;
      walked += 1;
      if (RETIRED_NAME.test(await readFile(file, "utf8"))) guilty.push(path.relative(repoRoot, file));
    }
  }
  // A walk that read nothing would pass every assertion.
  assert.ok(walked > 300, `walked ${walked} files`);
  assert.deepEqual(guilty, []);
});

test("the four 循证传播 capabilities say the module's name where a reader sees it", async () => {
  for (const id of ["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]) {
    const display = JSON.parse(await readFile(path.join(repoRoot, "packages/domain/src/capability-display.json"), "utf8")).capabilities[id];
    assert.match(display.title, /循证传播/, id);
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "deploy/runtime-dsh/capabilities", `${id}.json`), "utf8"));
    assert.match(manifest.whenToUse, /循证传播/, id);
  }
});
