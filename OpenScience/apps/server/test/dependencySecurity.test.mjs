import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopRequire = createRequire(path.join(repoRoot, "apps/web/package.json"));

function dependencyVersion(parent, dependency) {
  const parentPackage = desktopRequire.resolve(`${parent}/package.json`);
  const parentRequire = createRequire(parentPackage);
  return parentRequire(`${dependency}/package.json`).version;
}

test("document preview dependencies resolve to audited ECharts and UUID fixes", () => {
  assert.equal(dependencyVersion("pptx-preview", "echarts"), "6.1.0");
  assert.equal(dependencyVersion("pptx-preview", "uuid"), "11.1.1");
  assert.equal(dependencyVersion("exceljs", "uuid"), "11.1.1");
});

test("no production advisory is accepted, because the last one is now fixable", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  // The brace-expansion chain under exceljs was accepted while the only patched
  // line was 5, which glob 7 cannot consume. Upstream backported the fix within
  // each major line, so it is pinned rather than excused, and the list is empty.
  assert.deepEqual(pkg.pnpm?.auditConfig?.ignoreCves ?? [], []);

  // Assert the property rather than one resolution path: no brace-expansion
  // below its line's patched release may resolve anywhere in the tree.
  const lockfile = await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const resolved = [...new Set(lockfile.match(/brace-expansion@\d+\.\d+\.\d+/g) ?? [])]
    .map((entry) => entry.split("@")[1]);
  assert.ok(resolved.length > 0, "brace-expansion should still be in the tree");
  for (const version of resolved) {
    const [major, minor, patch] = version.split(".").map(Number);
    const vulnerable = (major === 1 && (minor < 1 || (minor === 1 && patch < 18)))
      || (major === 2 && (minor < 1 || (minor === 1 && patch < 4)));
    assert.equal(vulnerable, false, `brace-expansion ${version} is a known-vulnerable release`);
  }
});

test("the shipped web bundle carries no exceljs Node archive dependency", async () => {
  const assets = path.join(repoRoot, "apps", "web", "dist", "assets");
  const entries = await readdir(assets).catch(() => []);
  if (entries.length === 0) return; // build:web has not run in this checkout
  const bundled = [];
  for (const entry of entries.filter((name) => name.endsWith(".js"))) {
    const text = await readFile(path.join(assets, entry), "utf8");
    for (const name of ["archiver", "unzipper", "brace-expansion", "fstream"]) {
      if (text.includes(name)) bundled.push(`${entry}:${name}`);
    }
  }
  assert.deepEqual(bundled, []);
});
