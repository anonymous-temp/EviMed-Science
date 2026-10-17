import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CATALOG_DESCRIPTION_MAX_LENGTH,
  CATALOGUE_FRAME,
  IMAGE_EVIMED_PACKAGES,
  catalogDescription,
  catalogueLine,
  catalogueOf,
  escapeText,
  frameChars,
  measure,
  mergeIntoCandidateJson,
  presetRoots,
  readKernel,
  readSkillFrontmatter,
  readSkillRoot,
  renderTable,
} from "../skill-catalogue-size.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The model's skill catalogue is a budget (audit A §6 S7). What a runtime that is not a 循证 GEO project puts in front of the
 * model on every request, measured from the repository's own skill roots — the ones the image carries — is pinned here, so a new
 * skill or a longer description is a decision somebody makes with the figure in front of them and not a thing nobody noticed.
 * LoopX's folders are written into the image from a pinned wheel, an account's own skills are its own, and the GEO method pack is
 * private and mounted only in a GEO project's runtime: none of them is in this figure.
 *
 * Measured 2026-10-17 with the humanizer pair at their current versions: 57 skills.
 * To raise it: run `node scripts/ops/skill-catalogue-size.mjs`, read the table, change the number here and say in the commit
 * what the extra characters buy. To lower it, lower it: a budget that is not tight is not read.
 */
const NON_GEO_BUDGET = Object.freeze({ skills: 57, lineChars: 17_700 });

const withTree = (build) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "catalogue-size-"));
  try { return build(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const writeSkill = (root, folder, frontmatter) => {
  mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, folder, "SKILL.md"), `---\n${frontmatter}\n---\n\nBody.\n`);
};

test("a catalogue line is the kernel's own: whitespace collapsed, the description cut with an ellipsis, & < > escaped", () => {
  assert.equal(catalogDescription("  one\n\n two\t three  "), "one two three");
  const long = `${"a ".repeat(300)}end`;
  const cut = catalogDescription(long);
  assert.equal(cut.length, CATALOG_DESCRIPTION_MAX_LENGTH);
  assert.ok(cut.endsWith("..."));
  assert.equal(catalogDescription("short", 5), "short");
  assert.equal(catalogDescription("exactly", 6), "exa...");
  assert.equal(escapeText("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  assert.equal(catalogueLine({ name: "x-y", description: "Does <it>." }), "- `x-y`: Does &lt;it&gt;.");
});

test("a SKILL.md is read the way the kernel reads one, and the model's catalogue leaves out what the model may not invoke", () => {
  assert.deepEqual(readSkillFrontmatter("---\nname: good-name\ndescription: >\n  Folded\n  text.\n---\nBody"), { name: "good-name", description: "Folded text.\n", modelInvocable: true });
  assert.equal(readSkillFrontmatter("---\nname: hidden\ndescription: x\ndisable-model-invocation: true\n---\n")?.modelInvocable, false);
  for (const text of ["no frontmatter", "---\nname: Bad_Name\ndescription: x\n---\n", "---\nname: ok\n---\n", "---\ndescription: x\n---\n", "---\nname: [unclosed\n---\n"]) {
    assert.equal(readSkillFrontmatter(text), null, JSON.stringify(text));
  }
  withTree((dir) => {
    writeSkill(dir, "b-skill", "name: b-skill\ndescription: Second.");
    writeSkill(dir, "a-skill", "name: a-skill\ndescription: First.");
    writeSkill(dir, "hidden", "name: hidden\ndescription: Not for the model.\ndisable-model-invocation: true");
    mkdirSync(path.join(dir, "not-a-skill"));
    writeFileSync(path.join(dir, "loose.md"), "---\nname: loose\ndescription: A markdown file at the top of a root is a skill too.\n---\n");
    writeFileSync(path.join(dir, "README.txt"), "not markdown");
    const skills = readSkillRoot(dir);
    assert.deepEqual(skills.map((skill) => skill.name), ["a-skill", "b-skill", "hidden", "loose"], "sorted the way the loader sorts a root");
    assert.deepEqual(readSkillRoot(dir, { only: ["b-skill"] }).map((skill) => skill.name), ["b-skill"]);
    assert.deepEqual(readSkillRoot(path.join(dir, "missing")), [], "a root that is not there holds no skills");
    const total = catalogueOf([{ id: "root", skills }]);
    assert.equal(total.skills, 3, "the hidden skill is not in the catalogue");
    const lines = skills.filter((skill) => skill.modelInvocable).map((skill) => catalogueLine(skill).length + 1);
    assert.equal(total.chars, lines.reduce((a, b) => a + b, 0));
  });
});

test("the first root to name a skill keeps it, as in the kernel's registry", () => {
  const skill = (name, description) => ({ name, description, modelInvocable: true });
  const total = catalogueOf([
    { id: "first", skills: [skill("shared", "Wins.")] },
    { id: "second", skills: [skill("shared", "Shadowed by a very much longer description than the winner has."), skill("own", "Counts.")] },
  ]);
  assert.deepEqual(total.roots, [
    { id: "first", skills: 1, chars: catalogueLine(skill("shared", "Wins.")).length + 1, shadowed: 0 },
    { id: "second", skills: 1, chars: catalogueLine(skill("own", "Counts.")).length + 1, shadowed: 1 },
  ]);
});

test("the frame around the lines is counted once and is the kernel's text", () => {
  const rendered = [...CATALOGUE_FRAME.head, "LINE", ...CATALOGUE_FRAME.tail].join("\n");
  assert.equal(frameChars(), rendered.length - "LINE".length - 1, "the frame is everything but the lines and their newlines");
  assert.equal(catalogueOf([]).total, frameChars());
});

test("the GEO method pack is in the catalogue of a GEO project's runtime and in no other", () => {
  const roots = presetRoots();
  const geoRoot = roots.find((root) => root.id === "geo-private");
  assert.equal(geoRoot?.gate, "geoProject", "the preset mounts the pack only where EVIMED_GEO_SKILLS says so");
  assert.deepEqual(roots.filter((root) => root.gate).map((root) => [root.id, root.gate]), [["geo-private", "geoProject"], ["loopx", "loopxEnabled"]]);
  withTree((dir) => {
    mkdirSync(path.join(dir, "skills"), { recursive: true });
    writeSkill(path.join(dir, "skills"), "geo-demo", "name: geo-demo\ndescription: Pack skill.");
    writeSkill(path.join(dir, "skills"), "geo-two", "name: geo-two\ndescription: Another pack skill.");
    const result = measure(presetRoots({ geoPack: dir }));
    assert.ok(result.geo, "a GEO catalogue is measured when the pack is given");
    assert.equal(result.nonGeo.roots.some((root) => root.id === "geo-private"), false, "a runtime that is not a GEO project does not mount the root");
    assert.equal(result.geo.roots.find((root) => root.id === "geo-private")?.skills, 2);
    assert.equal(result.geo.skills, result.nonGeo.skills + 2);
    assert.equal(result.geo.chars - result.nonGeo.chars, catalogueLine({ name: "geo-demo", description: "Pack skill." }).length + 1 + catalogueLine({ name: "geo-two", description: "Another pack skill." }).length + 1);
    assert.match(renderTable(result), /A GEO project's runtime:[\s\S]*geo-private\s+2 skills/);
  });
  // Without the pack (a clone, CI) the GEO figure is not measured and nothing is guessed.
  const absent = measure(presetRoots({ geoPack: path.join(os.tmpdir(), "no-such-pack-root") }));
  assert.equal(absent.geo, null);
  assert.match(absent.geoNotMeasured ?? "", /pass --geo-pack/);
});

test("what a runtime that is not a GEO project puts in the model's catalogue stays inside the pinned budget", () => {
  const result = measure(presetRoots());
  const nonGeo = result.nonGeo;
  const counted = nonGeo.roots.filter((root) => root.skills > 0).map((root) => root.id);
  assert.deepEqual(counted, ["core", "evimed", "curated-scientific", "office", "community"], "the roots the repository can measure");
  assert.ok(nonGeo.skills >= 40, `read ${nonGeo.skills} skills; the extractor has stopped matching`);
  const detail = nonGeo.roots.map((root) => `${root.id} ${root.skills}/${root.chars}`).join(", ");
  assert.ok(nonGeo.skills <= NON_GEO_BUDGET.skills,
    `${nonGeo.skills} skills in the catalogue of a runtime that is not a GEO project, budget ${NON_GEO_BUDGET.skills} (${detail}). A new skill is paid for in every request of every conversation: run node scripts/ops/skill-catalogue-size.mjs, then raise the budget in this file and say what the skill buys.`);
  assert.ok(nonGeo.chars <= NON_GEO_BUDGET.lineChars,
    `${nonGeo.chars} characters of catalogue lines, budget ${NON_GEO_BUDGET.lineChars} (${detail}). Shorten the description, or raise the budget in this file and say what the extra characters buy.`);
  // And tight: a budget that is far above the measurement stops being a budget.
  assert.ok(NON_GEO_BUDGET.lineChars - nonGeo.chars < 200, `the budget (${NON_GEO_BUDGET.lineChars}) is more than 200 characters above the measurement (${nonGeo.chars}); lower it`);
  assert.equal(NON_GEO_BUDGET.skills, nonGeo.skills, "the skill count is pinned exactly");
});

test("the image carries exactly the evimed packages this measure counts", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  const copied = [...dockerfile.matchAll(/^COPY runtime\/skills\/evimed\/(\S+) /gm)].map((match) => match[1]);
  assert.deepEqual([...IMAGE_EVIMED_PACKAGES], copied);
});

test("the preset sets no description limit of its own, so the kernel's default is the limit", () => {
  const preset = readFileSync(path.join(repoRoot, "packages/socket/presets/evimed-universal/agent.cordis.yml"), "utf8");
  const row = /- id: tool-skill\n([\s\S]*?)(?=\n\S|\n- id: |\n\n)/.exec(preset)?.[0] ?? "";
  assert.match(row, /name: '@deepseek-ai\/dsh-tool-skill'/);
  assert.doesNotMatch(row, /catalogDescriptionMaxLength/);
});

test("the totals are merged into a candidate-check document and nothing else in it moves", () => {
  withTree((dir) => {
    const file = path.join(dir, "candidate-check.json");
    const result = measure(presetRoots());
    assert.equal(mergeIntoCandidateJson(file, result), false, "no document, nothing written");
    assert.equal(existsSync(file), false);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, candidates: [{ version: "x" }], pins: [], unknown: [] }));
    assert.equal(mergeIntoCandidateJson(file, result), true);
    const merged = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(merged), ["schemaVersion", "candidates", "pins", "unknown", "skillCatalogue"]);
    assert.deepEqual(merged.candidates, [{ version: "x" }]);
    assert.equal(merged.skillCatalogue.nonGeo.skills, result.nonGeo.skills);
    assert.equal(merged.skillCatalogue.nonGeo.total, result.nonGeo.total);
    assert.equal(merged.skillCatalogue.descriptionMax, CATALOG_DESCRIPTION_MAX_LENGTH);
  });
});

test("the installed kernel's limit and frame are the ones measured here (opt-in: EVIMED_KERNEL_CLOSURE=<node_modules>)", (t) => {
  const modules = process.env.EVIMED_KERNEL_CLOSURE;
  if (!modules) { t.skip("EVIMED_KERNEL_CLOSURE is not set; the kernel-seams workflow installs a closure, a local run passes one"); return; }
  const kernel = readKernel(modules);
  assert.equal(kernel.descriptionMax, CATALOG_DESCRIPTION_MAX_LENGTH);
  assert.deepEqual(kernel.frameDrift, []);
});
