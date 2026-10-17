import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const openScience = fileURLToPath(new URL("../../../", import.meta.url));
const coreRoot = path.join(openScience, "runtime/skills/core");
const record = JSON.parse(await readFile(path.join(coreRoot, "sources.json"), "utf8"));
const sha256 = (/** @type {Buffer | string} */ bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every file under a directory, as paths relative to it, without the byte-compiled Python the full image build writes. */
async function filesUnder(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "__pycache__") found.push(...await filesUnder(full, base)); }
    else found.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return found.sort();
}

test("a vendored core skill is exactly the upstream files the record pins, byte for byte", async () => {
  assert.ok(record.skills.length >= 2);
  for (const skill of record.skills) {
    const dir = path.join(coreRoot, skill.name);
    assert.deepEqual(await filesUnder(dir), skill.files.map((/** @type {{ path: string }} */ file) => file.path).sort(),
      `${skill.name}: the folder holds the files the record says were taken and no other (a local edit or addition is a decision for this file)`);
    for (const file of skill.files) {
      assert.equal(sha256(await readFile(path.join(dir, file.path))), file.sha256,
        `${skill.name}/${file.path} is not the upstream bytes at ${skill.commit}; a vendored file is never edited in place`);
    }
  }
});

test("the record names where each skill came from and which pin it replaced", () => {
  for (const skill of record.skills) {
    assert.match(skill.repo, /^[\w.-]+\/[\w.-]+$/, `${skill.name}.repo`);
    assert.match(skill.commit, /^[0-9a-f]{40}$/, `${skill.name}.commit is a full commit`);
    assert.ok(Number.isFinite(Date.parse(skill.committedAt)), `${skill.name}.committedAt`);
    assert.ok(skill.license && skill.reviewedOn && skill.why, `${skill.name}: licence, review date and the reason are part of the record`);
    assert.match(skill.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(skill.replaced && typeof skill.replaced === "object", `${skill.name}.replaced: what the previous pin was`);
  }
  assert.equal(new Set(record.skills.map((/** @type {{ name: string }} */ skill) => skill.name)).size, record.skills.length);
});

test("the version a SKILL.md states is the tag it was taken at", async () => {
  for (const skill of record.skills.filter((/** @type {{ tag: string | null }} */ entry) => entry.tag)) {
    const text = await readFile(path.join(coreRoot, skill.name, "SKILL.md"), "utf8");
    const version = /^\s+version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?\s*$/m.exec(text.split(/\n---\n/)[0])?.[1];
    assert.equal(`v${version}`, skill.tag, `${skill.name}: metadata.version is ${version}`);
  }
});

test("the package record the product reads carries the same repository and commit", async () => {
  const table = JSON.parse(await readFile(path.join(openScience, "packages/domain/src/skill-packages.json"), "utf8"));
  const packages = Array.isArray(table) ? table : (table.packages ?? Object.values(table));
  for (const skill of record.skills) {
    const entry = packages.find((/** @type {{ id?: string }} */ item) => item.id === `core/${skill.name}`);
    assert.ok(entry, `core/${skill.name} is in skill-packages.json`);
    assert.deepEqual({ kind: entry.source.kind, repository: entry.source.repository, commit: entry.source.commit },
      { kind: "repository", repository: skill.repo, commit: skill.commit },
      "regenerate with node scripts/build/generate-skill-packages.mjs");
  }
});
