// `capabilities/<id>/SKILL.md` and `capability-skills/<id>/SKILL.md` are one
// document stored twice: the first is what a person edits, the second is what
// the image ships and a delegated child actually reads. Equality, not a
// tolerance — a tolerance is how they came to disagree in the first place.
//
// They had genuinely diverged, and not in the direction anyone assumed. The
// mirror was the newer one: it told runs that three tools preserve a citable
// artifact while the authored copy still said two, so a run reading the
// authored text would drop a claim for want of an artifact that
// guideline_search had in fact preserved. It also carried the paragraph saying
// where backstage prose is allowed to go, which the authored copy lacked — and
// a prohibition with no destination is one runs satisfy by hiding the same
// sentences in the report.
//
// Merging by direction would have destroyed one of the two. They were merged by
// content and are held equal from here.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("a capability's authored skill and its shipped copy are the same document", async () => {
  const authored = path.join(repoRoot, "capabilities");
  const shipped = path.join(repoRoot, "capability-skills");
  const capabilities = (await readdir(authored, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.ok(capabilities.length >= 10, `only ${capabilities.length} capabilities found — the walk read nothing`);

  let compared = 0;
  const differing = [];
  const unshipped = [];
  for (const name of capabilities) {
    const left = await readFile(path.join(authored, name, "SKILL.md"), "utf8").catch(() => null);
    const right = await readFile(path.join(shipped, name, "SKILL.md"), "utf8").catch(() => null);
    if (left === null) continue;
    if (right === null) { unshipped.push(name); continue; }
    compared += 1;
    if (left !== right) {
      const leftLines = left.split("\n");
      const rightLines = right.split("\n");
      const at = leftLines.findIndex((line, index) => line !== rightLines[index]);
      differing.push(`${name}: first differs at line ${at + 1}`);
    }
  }
  assert.deepEqual(unshipped, [], "a capability whose skill is not in capability-skills/ delegates a child that reads nothing");
  assert.equal(compared, capabilities.length, `${compared} of ${capabilities.length} capabilities compared`);
  assert.deepEqual(
    differing, [],
    "The two copies are one document. Edit capabilities/<id>/SKILL.md and copy it across in the same change — "
    + "when they drift, the one a run reads is the one nobody edited.",
  );
});

test("a shared skill body without a capability of its own is left alone", async () => {
  // capability-skills/ also holds bodies several capabilities name —
  // citation-integrity, manuscript-humanize, deep-research,
  // biomedical-database-search. They own no capability directory, and demanding
  // one would be demanding a capability nobody wants to offer.
  const shipped = path.join(repoRoot, "capability-skills");
  const authored = path.join(repoRoot, "capabilities");
  const shared = [];
  for (const entry of await readdir(shipped, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const own = await readFile(path.join(authored, entry.name, "SKILL.md"), "utf8").catch(() => null);
    if (own === null) shared.push(entry.name);
  }
  assert.ok(shared.length >= 3, `expected the shared bodies, found ${shared.join(", ") || "none"}`);
  for (const name of shared) {
    const body = await readFile(path.join(shipped, name, "SKILL.md"), "utf8");
    assert.ok(body.trim().length > 0, `${name} ships an empty body`);
  }
});
