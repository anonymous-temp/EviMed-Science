// The generated table of shipped packages: what each one is, where it came from, what it needs and what the runtime
// image offers. The generator reads five places that never agreed on a shape; what these tests pin is that the table
// says only what a source says (unknown stays unknown), that it is current, and that a declared pin is the image's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeSkillPackageRecord, skillDependencyReasons } from "@evimed/domain";
import { IMAGE_RECIPE, SKILL_PACKAGES, skillPackage, skillPackagesNamed } from "@evimed/domain/skill-packages";
import { collectSkillPackages, prune, readArgparse, readImageRecipe, renderSkillPackagesTable, stringify, SKILL_PACKAGES_TABLE } from "../../../scripts/build/generate-skill-packages.mjs";
import { digestDirectory } from "../src/releaseManifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (/** @type {string} */ file) => fs.readFile(path.join(repoRoot, file), "utf8");
const facts = { image: IMAGE_RECIPE, tools: () => ({ offered: true }), deployment: new Set() };
/** @param {string} id */
const record = (id) => /** @type {any} */ (SKILL_PACKAGES.get(id));

test("the committed table is what the generator writes from the trees now", async () => {
  assert.equal(await read(SKILL_PACKAGES_TABLE), await renderSkillPackagesTable(), "run node scripts/build/generate-skill-packages.mjs and commit the result");
});

test("every origin is present and every package the trees ship is a record that reads", async () => {
  const origins = new Set([...SKILL_PACKAGES.values()].map((entry) => entry.origin));
  assert.deepEqual([...origins].sort(), ["capability", "capability-skill", "community", "core", "curated", "evimed", "extension", "office"]);
  const { packages } = await collectSkillPackages(repoRoot);
  assert.equal(SKILL_PACKAGES.size, packages.length, "no row was dropped by the reader");
  for (const entry of SKILL_PACKAGES.values()) assert.deepEqual(normalizeSkillPackageRecord(entry), entry, `${entry.id} is stable under the reader`);
  assert.equal(skillPackagesNamed("statistical-analysis").length, 2, "a curated skill and a capability share a name and stay two packages");
  assert.equal(skillPackage("capability", "statistical-analysis")?.id, "capability/statistical-analysis");
  assert.equal(skillPackage("curated", "no-such-skill"), null);
});

test("the stored form has no absences and loses nothing: pruning then reading is the record", async () => {
  const { packages } = await collectSkillPackages(repoRoot);
  for (const entry of packages) assert.deepEqual(normalizeSkillPackageRecord({ schemaVersion: 1, ...prune(entry) }), entry, entry.id);
  assert.deepEqual(prune({ a: null, b: false, c: [], d: 0, e: "", f: { g: null, h: 1 } }), { d: 0, e: "", f: { h: 1 } });
  const long = { list: Array.from({ length: 6 }, (_, index) => ({ path: `scripts/file-${index}.py`, sha256: "a".repeat(64) })) };
  assert.equal(JSON.parse(stringify(long)).list.length, 6);
  assert.ok(stringify(long).split("\n").length >= 6, "one line per file");
  assert.equal(stringify({ a: [1, 2] }), '{"a":[1,2]}');
});

test("a package's digest is the one the release computes over its directory, not a claim", async () => {
  const dirs = { core: "runtime/skills/core", curated: "runtime/skills/curated-scientific", office: "runtime/skills/office", community: "runtime/skills/community", capability: "capabilities", "capability-skill": "capability-skills" };
  for (const entry of SKILL_PACKAGES.values()) {
    const base = dirs[/** @type {keyof typeof dirs} */ (entry.origin)];
    if (!base) continue;
    const { digest } = await digestDirectory(path.join(repoRoot, base, entry.name));
    assert.equal(entry.digest, digest, entry.id);
    assert.equal(entry.digestAlgorithm, "release-directory-v1");
  }
  assert.match(record("extension/cowork-portable").digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record("extension/cowork-portable").digestAlgorithm, "source-archive-sha256");
});

test("the curated pack: the upstream it was derived from, its licence file by digest, and no commit claimed that no source records", async () => {
  const inventory = JSON.parse(await read("runtime/skills/curated-scientific/inventory.json"));
  const curated = [...SKILL_PACKAGES.values()].filter((entry) => entry.origin === "curated");
  assert.equal(curated.length, inventory.skills.length);
  for (const skill of inventory.skills) {
    const entry = record(`curated/${skill.name}`);
    assert.equal(entry.source.kind, "derived");
    assert.equal(entry.source.package, inventory.source.package);
    assert.equal(entry.source.commit, null, "the inventory records no commit, so none is invented");
    assert.equal(entry.licence.id, inventory.source.license);
    assert.equal(entry.licence.file.sha256, inventory.source.licenseSha256);
    assert.equal(entry.digest, skill.digest, "the table's digest is the inventory's reviewed digest");
  }
  const bytes = await fs.readFile(path.join(repoRoot, "runtime/skills/curated-scientific", record("curated/cheminformatics").licence.file.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), inventory.source.licenseSha256);
});

test("a community skill is bound to the exact repository and commit its source record names", async () => {
  const sources = JSON.parse(await read("runtime/skills/community/sources.json"));
  for (const entry of sources.skills) {
    const found = record(`community/${entry.name}`);
    assert.equal(found.source.kind, "repository");
    assert.equal(found.source.repository, entry.repo);
    assert.equal(found.source.commit, entry.commit);
    assert.equal(found.source.path, entry.subpath);
    assert.equal(found.licence.id, entry.license);
    assert.ok(found.licence.file, "the vendored licence file is recorded by digest");
  }
});

test("the platform's own packages say they came with the release and name a licence only where their own frontmatter declares one", async () => {
  for (const entry of SKILL_PACKAGES.values()) {
    if (!["core", "capability", "capability-skill", "evimed"].includes(entry.origin)) continue;
    assert.equal(entry.source.kind, "release", entry.id);
    // A licence name appears only where the package's own frontmatter declares one; a bare LICENSE file is not "MIT".
    if (entry.licence?.id) assert.equal(entry.licence.basis, "declared", `${entry.id}: a licence name is declared only where a source declares one`);
    else if (entry.licence) assert.equal(entry.licence.basis, "file-present", entry.id);
  }
  // Read from the manifest, never pinned here: a capability's version moves with every edit of its skill.
  const declared = /^version:\s*(\S+)\s*$/m.exec(await read("capabilities/statistical-analysis/capability.yaml"))?.[1];
  assert.match(declared ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(record("capability/statistical-analysis").version, declared, "a capability's version is its manifest's");
  assert.equal(record("office/xlsx").licence.id, "MIT");
  assert.equal(record("extension/cowork-portable").licence.id, "MIT");
  assert.equal(record("extension/cowork-portable").source.commit, "2ae5cf755c4294a1e988eebf3b12dd062425d84c");
});

test("no package's declared pin differs from what the image installs, and what it does not carry is named", () => {
  /** @type {Record<string, string[]>} */ const required = {};
  for (const entry of SKILL_PACKAGES.values()) {
    for (const reason of skillDependencyReasons(entry, facts)) {
      assert.notEqual(reason.code, "dependency-version-differs", `${entry.id} pins ${reason.detail} differently from the image`);
      assert.notEqual(reason.code, "dependency-unchecked", `${entry.id}: ${reason.detail} could not be checked`);
      if (!reason.optional) (required[entry.id] ??= []).push(`${reason.code}:${reason.detail}`);
    }
  }
  assert.deepEqual(required, {
    "curated/biosequence-analysis": ["dependency-software-missing:biopython"],
    "curated/cheminformatics": ["dependency-software-missing:rdkit"],
    "curated/pathway-enrichment": ["dependency-software-missing:gseapy"],
    "curated/single-cell-analysis": ["dependency-software-missing:anndata", "dependency-software-missing:scanpy"],
  });
  // Software read from a script's own guarded import or an instruction's code fence is a note, not a block.
  const largeFile = skillDependencyReasons(record("core/large-file"), facts);
  assert.ok(largeFile.length >= 5 && largeFile.every((reason) => reason.optional));
  assert.ok(record("core/large-file").dependencies.every((/** @type {any} */ dependency) => dependency.basis === "observed" && dependency.evidence));
});

test("every method dependency a curated skill declares quotes a mention that is in that skill's own files", async () => {
  const inventory = JSON.parse(await read("runtime/skills/curated-scientific/inventory.json"));
  const declared = inventory.policy.delivery.methodDependencies;
  const names = Object.keys(declared).filter((name) => !name.startsWith("$"));
  assert.ok(names.length >= 5);
  for (const name of names) {
    const dir = path.join(repoRoot, "runtime/skills/curated-scientific", name);
    const text = (await Promise.all((await fs.readdir(dir, { recursive: true })).map((file) => fs.readFile(path.join(dir, file), "utf8").catch(() => "")))).join("\n").toLowerCase();
    for (const dependency of declared[name]) {
      assert.ok(text.includes(dependency.mention.toLowerCase()), `${name} declares ${dependency.name} but never mentions ${dependency.mention}`);
      assert.ok(dependency.evidence.length > 20);
      assert.ok(record(`curated/${name}`).dependencies.some((/** @type {any} */ entry) => entry.name === dependency.name && entry.basis === "declared"));
    }
  }
});

test("the image recipe is what install-runtime.sh pins and installs", async () => {
  const script = await read("deploy/runtime-dsh/install-runtime.sh");
  const recipe = readImageRecipe(script);
  assert.deepEqual(IMAGE_RECIPE.python, recipe.python);
  for (const [name, version] of Object.entries(recipe.python)) assert.ok(new RegExp(`^\\s+${name}==${version.replaceAll(".", "\\.")}`, "imu").test(script.replace(/Pillow/u, "pillow")) || name === "pillow", `${name}==${version}`);
  assert.equal(recipe.python.numpy, "2.2.6");
  for (const tool of ["pandoc", "chromium", "rg", "python", "Rscript", "node", "uv", "git"]) assert.ok(recipe.tools.includes(tool), tool);
  for (const apt of ["python3", "r-base-core", "r-recommended", "fonts-noto-cjk", "ripgrep"]) assert.ok(recipe.apt.includes(apt), apt);
  assert.ok(recipe.rPackages.includes("survival"));
  assert.ok(Object.keys(recipe.python).every((name) => recipe.modules[name]?.length), "every pinned distribution lists the modules it provides");
  assert.throws(() => readImageRecipe(script.replace("scipy==1.15.3", "mystery-distribution==1.0")), /mystery-distribution/);
  assert.throws(() => readImageRecipe("system() {\n  set -x\n}\n  system) system ;;\n"), /pins no python package/);
});

test("argument parsers are read as call syntax: flags, types, required, defaults, closed values and exclusive groups", () => {
  const source = [
    "import argparse",
    "parser = argparse.ArgumentParser()",
    'parser.add_argument("--title", required=True, help="the title")',
    'parser.add_argument("--rows", type=int, default=5)',
    'parser.add_argument("--ratio", type=float)',
    'parser.add_argument("--output", required=True, type=Path)',
    'parser.add_argument("--mode", choices=["fast", "slow"], default="fast")',
    'parser.add_argument("--dry", action="store_true")',
    'source = parser.add_mutually_exclusive_group(required=True)',
    'source.add_argument("--input", type=Path)',
    'source.add_argument("--text")',
    'parser.add_argument("positional")',
    'parser.add_argument("--note", help="has (parentheses) and, commas")',
  ].join("\n");
  const { params, groups } = readArgparse(source);
  const by = Object.fromEntries(params.map((param) => [param.name, param]));
  assert.deepEqual(Object.keys(by), ["--title", "--rows", "--ratio", "--output", "--mode", "--dry", "--input", "--text", "--note"], "a positional is not a flag");
  assert.equal(by["--title"].required, true);
  assert.equal(by["--title"].description, "the title");
  assert.deepEqual([by["--rows"].type, by["--rows"].default], ["integer", 5]);
  assert.equal(by["--ratio"].type, "number");
  assert.equal(by["--output"].type, "path");
  assert.deepEqual(by["--mode"].values, ["fast", "slow"]);
  assert.equal(by["--dry"].type, "boolean");
  assert.equal(by["--input"].required, undefined, "a member of an exclusive group is not required on its own");
  assert.deepEqual(groups, [{ required: true, flags: ["--input", "--text"] }]);
  assert.equal(by["--note"].description, "has (parentheses) and, commas");
});

test("the curated executor's operation is read from the executor: its flags, its bounds, and a description for none that it lacks", async () => {
  const source = await read("runtime/skills/curated-scientific/_runtime/execute_skill.py");
  const template = JSON.parse(await read("runtime/skills/curated-scientific/_runtime/operations.json"));
  const { params } = readArgparse(source);
  assert.deepEqual(params.map((param) => param.name), ["--skill", "--input", "--output-dir", "--smoke"]);
  for (const described of template.operation.params) assert.ok(params.some((param) => param.name === described.name), `${described.name} is a flag of the executor`);
  for (const [name, value] of Object.entries(template.operation.limitsConstants)) {
    const found = new RegExp(`^${name}\\s*=\\s*([0-9_ *]+)$`, "mu").exec(source)?.[1];
    assert.ok(found, `${name} is in the executor`);
    assert.equal(Function(`return ${found.replaceAll("_", "")}`)(), value, `${name} is the executor's`);
  }
  const operation = record("curated/cheminformatics").operations[0];
  assert.equal(operation.entrypoint, "_runtime/execute_skill.py");
  assert.deepEqual(operation.params.find((/** @type {any} */ param) => param.name === "--skill").values, ["cheminformatics"]);
  assert.ok(operation.limits.some((/** @type {string} */ limit) => limit.includes("32 MiB")));
  assert.deepEqual(operation.produces, ["results.json", "cheminformatics-report.md", "execution-receipt.json"]);
});

test("an office exporter's operation is read from its own flags, with the exclusive group stated", () => {
  const docx = record("office/docx").operations[0];
  assert.deepEqual(docx.params.map((/** @type {any} */ param) => param.name), ["--input", "--text", "--output"]);
  assert.ok(docx.limits.includes("必须且只能给出其中一个：--input、--text"));
  assert.equal(docx.entrypoint, "scripts/create_docx.py");
  assert.deepEqual(docx.produces, ["document.docx"]);
  assert.equal(record("office/xlsx").operations[0].params.find((/** @type {any} */ param) => param.name === "--sheet").default, "Sheet1");
});

test("the document tools' record carries the operation schema the bridge builds its help from", async () => {
  const { COWORK_OPERATIONS } = await import("../../../packages/socket/extensions/cowork/operations.mjs");
  const entry = record("extension/cowork-portable");
  assert.deepEqual(entry.operations.map((/** @type {any} */ operation) => operation.name), COWORK_OPERATIONS.map((operation) => operation.name));
  assert.equal(entry.operations[0].params.find((/** @type {any} */ param) => param.name === "options.rows").max, 100);
  assert.equal(entry.version, "2ae5cf755c42");
});

test("a capability's record names the platform tools its manifest declares, and its scripts' imports as observed", () => {
  const statistical = record("capability/statistical-analysis");
  assert.ok(statistical.dependencies.some((/** @type {any} */ dependency) => dependency.kind === "platform-tool" && dependency.name === "dataset_semantics"));
  const imports = statistical.dependencies.filter((/** @type {any} */ dependency) => dependency.basis === "observed").map((/** @type {any} */ dependency) => dependency.name);
  assert.ok(imports.includes("numpy") || imports.includes("statsmodels") || imports.includes("pandas"), JSON.stringify(imports));
  assert.deepEqual(statistical.operations[0].name, "statistical-analysis-package");
  assert.ok(statistical.operations[0].produces.includes("statistical-report.md"));
});
