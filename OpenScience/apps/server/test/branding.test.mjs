import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function productionTsxFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await productionTsxFiles(target));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) files.push(target);
  }
  return files;
}

test("all visible application branding uses EviMed", async () => {
  const frontendFiles = await productionTsxFiles(path.join(repoRoot, "apps/desktop/src"));
  const frontend = (await Promise.all(frontendFiles.map((file) => readFile(file, "utf8")))).join("\n");
  const html = await readFile(path.join(repoRoot, "apps/desktop/index.html"), "utf8");
  const tauri = JSON.parse(await readFile(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const mark = await readFile(path.join(repoRoot, "apps/desktop/src/assets/evimed-mark.svg"), "utf8");
  const mockRuntime = await readFile(path.join(repoRoot, "apps/server/src/mockDshRuntime.mjs"), "utf8");

  assert.doesNotMatch(frontend, /Open Science/i);
  assert.doesNotMatch(frontend, /logo\.webp/);
  assert.match(frontend, />\s*EviMed\s*</);
  assert.match(html, /<title>EviMed<\/title>/);
  assert.doesNotMatch(html, /Open Science/i);
  assert.equal(tauri.productName, "EviMed");
  assert.equal(tauri.identifier, "com.evimed.science");
  assert.equal(tauri.app.windows[0].title, "EviMed");
  assert.match(mark, /aria-label="EviMed"/);
  assert.doesNotMatch(mockRuntime, /OPENCODE|OpenCode/);
  assert.match(mockRuntime, /EviMed 测试运行时/);
});

test("public release metadata and documentation identify the product as EviMed", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/build.yml"), "utf8");
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const readmeZh = await readFile(path.join(repoRoot, "README.zh.md"), "utf8");

  assert.equal(packageJson.name, "evimed-science");
  assert.match(packageJson.description, /^EviMed/);
  assert.match(workflow, /releaseName:.*EviMed/);
  assert.match(workflow, /name: evimed-science-\$\{\{ matrix\.target \}\}/);
  assert.doesNotMatch(workflow, /releaseName:.*Open Science/);
  assert.match(readme, /^# EviMed/m);
  assert.match(readmeZh, /^# EviMed/m);
  assert.doesNotMatch(readme, /\/Applications\/Open Science\.app/);
  assert.doesNotMatch(readmeZh, /\/Applications\/Open Science\.app/);
});
