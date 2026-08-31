// The roots are a deployment fact stated in two places that must not disagree:
// the Dockerfile that puts the trees there, and the declaration a run is told.
//
// Declaring them at all is new. Before it, every skill body spelled out its own
// absolute path, and when the kernel changed 45 of them kept naming a directory
// that no longer existed — silently, because a wrong path in Markdown fails only
// at the moment a model tries to use it. Moving the paths to one place fixes
// that; keeping the one place honest is what this file is for.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RUNTIME_SKILL_ROOTS, skillRootGuidance } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("every declared root is a tree the image actually copies there", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile"), "utf8");
  const copies = new Map();
  for (const [, source, destination] of dockerfile.matchAll(/^COPY (\S+) (\S+)$/gm)) {
    copies.set(source, destination);
  }
  // A regex that matched nothing would let every assertion below pass.
  assert.ok(copies.size >= 8, `only ${copies.size} COPY lines parsed from the Dockerfile`);

  const wrong = [];
  for (const root of RUNTIME_SKILL_ROOTS) {
    const destination = copies.get(root.source);
    if (destination === undefined) wrong.push(`${root.family}: the image does not copy ${root.source} at all`);
    else if (destination !== root.path) wrong.push(`${root.family}: image puts it at ${destination}, declaration says ${root.path}`);
  }
  assert.deepEqual(wrong, [], "a declared root the image contradicts sends every run to a path that is not there");
});

test("the guidance a run reads names each root exactly once", () => {
  const text = skillRootGuidance();
  for (const root of RUNTIME_SKILL_ROOTS) {
    const occurrences = text.split(root.path).length - 1;
    assert.equal(occurrences, 1, `${root.path} appears ${occurrences} times in the guidance`);
  }
  // The block is read on every run, so it has to stay short enough to finish.
  assert.ok(text.split("\n").length <= 20, "the roots block is growing into a paragraph nobody reads");
});

test("an empty root list produces no block rather than an empty heading", () => {
  // A deployment with no skill trees should say nothing, not print a heading
  // with nothing under it — which reads as "the skills are missing".
  assert.equal(skillRootGuidance([]), "");
});
