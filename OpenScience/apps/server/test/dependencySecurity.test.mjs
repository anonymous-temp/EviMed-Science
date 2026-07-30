import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopRequire = createRequire(path.join(repoRoot, "apps/desktop/package.json"));

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

test("the accepted production advisory list stays at the reviewed exception", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(pkg.pnpm?.auditConfig?.ignoreCves, ["CVE-2026-14257"]);
});

test("the shipped web bundle carries no exceljs Node archive dependency", async () => {
  const assets = path.join(repoRoot, "apps", "desktop", "dist", "assets");
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
