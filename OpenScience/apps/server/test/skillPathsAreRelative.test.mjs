// A skill body may not name a deployment path.
//
// 45 shipped skills pointed at `$XDG_CONFIG_HOME/opencode/skills/...`, a
// directory that does not exist in the DSH image at all — so this was not a
// portability wart, it was live DSH runs referencing a path that had been gone
// since the kernel changed. Nothing noticed, because a wrong path in a Markdown
// body fails at the moment a model tries to use it and nowhere else.
//
// The convention now: bodies carry paths relative to the skill root (the Agent
// Skills standard), and the absolute roots — which are a deployment fact and
// differ per family — are declared in one place by the runtime. That keeps the
// bodies portable to any harness following the standard, and keeps the three
// roots from being copied into 45 files where they will drift apart.
//
// This is a closed vocabulary: three literal prefixes the platform owns. That
// is what makes it a code check rather than a judgment about prose.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Every tree the DSH image COPYs. `runtime/skills/evimed` is deliberately
// absent: it is the OpenCode rollback kernel, the image takes only
// open-domain-answer from it, and the plan deletes the rest at the kernel flip.
const SHIPPED_TREES = ["runtime/skills/curated-scientific", "runtime/skills/core", "runtime/skills/office", "capability-skills", "capabilities"];

const FORBIDDEN = [
  "$XDG_CONFIG_HOME/opencode",   // the retired kernel's config root
  "/opt/evimed",                 // DSH image root for core + capabilities
  "/usr/local/share/evimed",     // DSH image root for curated-scientific
];

async function markdownUnder(relative) {
  const root = path.join(repoRoot, relative);
  const found = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".md")) found.push(full);
    }
  };
  await walk(root);
  return found;
}

test("no shipped skill body names a deployment path", async () => {
  const files = (await Promise.all(SHIPPED_TREES.map(markdownUnder))).flat();
  // A walk that read nothing reports a clean tree, which is the same shape as a
  // clean tree — the defect this repository keeps rediscovering.
  assert.ok(files.length >= 100, `only ${files.length} skill bodies scanned; the walk found nothing`);

  const offenders = [];
  for (const file of files) {
    const body = await readFile(file, "utf8");
    for (const token of FORBIDDEN) {
      if (body.includes(token)) offenders.push(`${path.relative(repoRoot, file)} names ${token}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    "A skill body must reference its scripts relative to the skill root. The absolute roots are a "
    + "deployment fact and belong in the one place that generates them, not copied into skill bodies "
    + "where they drift — which is how 45 of them ended up pointing at a directory the image does not have.",
  );
});

test("the curated family's shared executor is reachable from a skill that calls it", async () => {
  // `../_runtime/execute_skill.py` is only correct because `_runtime` is a real
  // sibling inside the family root, and the family is copied whole. If that
  // stops being true the relative form silently becomes wrong again.
  const family = path.join(repoRoot, "runtime/skills/curated-scientific");
  const entries = await readdir(family, { withFileTypes: true });
  assert.ok(entries.some((entry) => entry.isDirectory() && entry.name === "_runtime"),
    "_runtime must be a sibling of the skills that reference it as ../_runtime");

  const callers = [];
  for (const entry of entries.filter((item) => item.isDirectory() && item.name !== "_runtime")) {
    const body = await readFile(path.join(family, entry.name, "SKILL.md"), "utf8").catch(() => "");
    if (body.includes("../_runtime/execute_skill.py")) callers.push(entry.name);
  }
  assert.ok(callers.length >= 30, `only ${callers.length} skills reference the shared executor; expected the curated family`);
});
