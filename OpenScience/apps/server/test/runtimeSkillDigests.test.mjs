import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { digestDirectory } from "../src/releaseManifest.mjs";
import {
  SKILL_ROOTS_IN_IMAGE,
  compareSkillDigests,
  measureRoots,
} from "../../../scripts/ops/check-runtime-skill-digests.mjs";

// The digest script runs in the runtime image with the image's own node; here
// it runs with this one, which is the same script over the same bytes.
const LOCAL_NODE = [process.execPath, "-"];

async function skillTree(root) {
  await mkdir(path.join(root, "publication-figures"), { recursive: true });
  await writeFile(path.join(root, "publication-figures", "SKILL.md"), "# Figures\n");
  await writeFile(path.join(root, "publication-figures", "openscience.mplstyle"), "axes.prop_cycle: cycler('color', ['0a5dc1'])\n");
  await mkdir(path.join(root, "stats-integrity", "scripts"), { recursive: true });
  await writeFile(path.join(root, "stats-integrity", "scripts", "check.py"), "print('ok')\n");
}

test("the in-image digest is the manifest's digest, byte-compiled Python aside", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-digests-"));
  try {
    const source = path.join(dir, "source");
    const image = path.join(dir, "image");
    await skillTree(source);
    await cp(source, image, { recursive: true });
    // What the full build leaves beside the curated scripts.
    await mkdir(path.join(image, "stats-integrity", "scripts", "__pycache__"));
    await writeFile(path.join(image, "stats-integrity", "scripts", "__pycache__", "check.cpython-311.pyc"), "\0\0");
    const want = await digestDirectory(source);
    const got = measureRoots(LOCAL_NODE, [image]).get(image);
    assert.deepEqual({ files: got.files, digest: got.digest }, { files: want.files, digest: want.digest });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tree the delta left at the base's copy is named, with both digests", async () => {
  // 2026-09-26: production's core tree carried the pre-token mplstyle while
  // the manifest recorded the new one, because Dockerfile.delta never copied
  // `runtime/skills/core`.
  const dir = await mkdtemp(path.join(tmpdir(), "skill-digests-"));
  try {
    const source = path.join(dir, "source");
    const image = path.join(dir, "image");
    await skillTree(source);
    await cp(source, image, { recursive: true });
    await writeFile(path.join(source, "publication-figures", "openscience.mplstyle"), "axes.prop_cycle: cycler('color', ['0a5dc1', '5f686f'])\n");
    const recorded = await digestDirectory(source);
    const skills = [{ name: "core", source: "runtime/skills/core", files: recorded.files, digest: recorded.digest }];
    const result = compareSkillDigests(skills, (roots) => {
      assert.deepEqual(roots, [SKILL_ROOTS_IN_IMAGE["runtime/skills/core"]]);
      return new Map([[roots[0], measureRoots(LOCAL_NODE, [image]).get(image)]]);
    });
    assert.equal(result.ok, false);
    assert.equal(result.rows[0].verdict, "differs");
    assert.equal(result.rows[0].got.files, recorded.files);
    assert.notEqual(result.rows[0].got.digest, recorded.digest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a recorded tree the image does not ship, or a root it lacks, fails rather than passing unread", () => {
  const skills = [
    { name: "core", source: "runtime/skills/core", files: 1, digest: "sha256:a" },
    // The generator used to record this OpenCode-era tree; no DSH image has it.
    { name: "runtime-skills-external-ai4s-skills", source: "runtime/skills/external/ai4s-skills", files: 1, digest: "sha256:b" },
  ];
  const result = compareSkillDigests(skills, (roots) => new Map(roots.map((root) => [root, { path: root, missing: true }])));
  assert.equal(result.ok, false);
  assert.deepEqual(result.rows.map((row) => row.verdict), ["missing", "not-in-image"]);
  assert.throws(() => compareSkillDigests([], () => new Map()), { code: "skill_digest_manifest_empty" });
});

test("a digest run that answers for fewer roots than it was asked about is an error, not a pass", () => {
  assert.throws(() => measureRoots([process.execPath, "-e", "process.exit(0)", "--"], ["/nowhere"]), { code: "skill_digest_unmeasured" });
  assert.throws(() => measureRoots([process.execPath, "-e", "process.exit(3)", "--"], ["/nowhere"]), { code: "skill_digest_unmeasured" });
  assert.equal(measureRoots(LOCAL_NODE, ["/nowhere/at/all"]).get("/nowhere/at/all").missing, true);
});

test("every skill tree the release manifest generator records is one the runtime image ships", async () => {
  const { readFile } = await import("node:fs/promises");
  const generator = await readFile(new URL("../../../scripts/ops/generate-release-manifest.mjs", import.meta.url), "utf8");
  const defaults = generator.slice(generator.indexOf("const defaults = ["), generator.indexOf("];", generator.indexOf("const defaults = [")));
  const recorded = [...defaults.matchAll(/^\s*"([^"]+)",/gm)].map((match) => match[1]);
  assert.ok(recorded.length >= 5, `read the generator's skill list (${recorded.length} entries)`);
  for (const source of recorded) assert.ok(Object.hasOwn(SKILL_ROOTS_IN_IMAGE, source), `${source} is recorded but not shipped in the runtime image`);
});
