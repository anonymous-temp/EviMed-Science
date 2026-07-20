import assert from "node:assert/strict";
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
