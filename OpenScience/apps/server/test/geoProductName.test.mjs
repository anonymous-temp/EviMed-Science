// The module is 「循证 GEO」 (the owner's ruling of 2026-10-07, R10 plan §1): it was called
// 「循证传播」 from 2026-10-06, and that name is retired. No sentence a reader or a model is given may
// use it again, so this walks the server's strings, the domain's, the capabilities' manifests and
// skill text, the runtime tools', the frame's and the alert rules'. A comment may name the old name
// to say why it went, and a line marked `retired-word-ok` holds it as DATA — the search alias in
// `@evimed/domain`'s `retiredNames.mjs`, the earlier placeholder names a project may still carry —
// the same two exemptions the web shell's guard, `retiredWords.test.ts`, allows.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RETIRED_NAME = /循证传播/; // retired-word-ok

/** A comment line, by the file's own comment marker; prose and JSON have none, so every line of them is read. @param {string} file @param {string} line */
function isComment(file, line) {
  if (/\.mjs$/.test(file)) return /^\s*(\/\/|\*|\/\*)/.test(line);
  if (/\.(py|yaml)$/.test(file)) return /^\s*#/.test(line);
  return false;
}

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

test("no server, domain, capability or runtime-tool text calls the module 循证传播", async () => {
  const roots = [
    ["apps/server/src", /\.mjs$/],
    ["packages/domain/src", /\.(mjs|json)$/],
    ["capabilities", /\.(yaml|md)$/],
    ["capability-skills", /\.md$/],
    ["deploy/runtime-dsh/capabilities", /\.json$/],
    ["runtime/mcp/evimed-research", /\.py$/],
    ["packages/harness-port/src", /\.mjs$/],
    ["packages/socket/plugins", /\.mjs$/],
    ["deploy/web/monitoring", /\.json$/],
  ];
  let walked = 0;
  const guilty = [];
  for (const [root, kind] of roots) {
    for (const file of await walk(path.join(repoRoot, root), kind)) {
      if (file.includes(`${path.sep}test${path.sep}`)) continue;
      walked += 1;
      const text = await readFile(file, "utf8");
      if (text.split("\n").some((line) => RETIRED_NAME.test(line) && !isComment(file, line) && !line.includes("retired-word-ok"))) guilty.push(path.relative(repoRoot, file));
    }
  }
  // A walk that read nothing would pass every assertion.
  assert.ok(walked > 300, `walked ${walked} files`);
  assert.deepEqual(guilty, []);
});

test("the four 循证 GEO capabilities say the module's name where a reader sees it", async () => {
  for (const id of ["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]) {
    const display = JSON.parse(await readFile(path.join(repoRoot, "packages/domain/src/capability-display.json"), "utf8")).capabilities[id];
    assert.match(display.title, /循证 GEO/, id);
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "deploy/runtime-dsh/capabilities", `${id}.json`), "utf8"));
    assert.match(manifest.whenToUse, /循证 GEO/, id);
  }
});

test("a project still named by an earlier placeholder is a placeholder, and the brand replaces it", async () => {
  const { GEO_DEFAULT_PROJECT_NAME, geoProjectName, isGeoPlaceholderName } = await import("../src/geoService.mjs");
  // The current one, and the two this module's projects were made with before it was 「循证 GEO」 again:
  // 「新 GEO 项目」 until 2026-10-06 and 「新循证传播项目」 after (retired-word-ok).
  for (const name of [GEO_DEFAULT_PROJECT_NAME, "新 GEO 项目", "新循证传播项目"]) { // retired-word-ok
    assert.equal(isGeoPlaceholderName(name), true, name);
    assert.equal(geoProjectName({ product: { brandName: "信尔美" } }, name), "信尔美", name);
  }
  // A name the researcher chose is theirs, including one that merely resembles a placeholder.
  for (const name of ["信尔美", "新循证 GEO 项目二", ""]) assert.equal(isGeoPlaceholderName(name), false, name);
  assert.equal(geoProjectName({ product: { brandName: "信尔美" } }, "我的波立维项目"), "我的波立维项目");
  assert.equal(isGeoPlaceholderName(undefined), false);
});
