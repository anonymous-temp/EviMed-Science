#!/usr/bin/env node
/**
 * Does the release's runtime image carry the skill trees its manifest records?
 *
 * The release manifest digests every skill tree of the release's source
 * (`skills[]`: core, curated-scientific, office, community, the GEO method pack
 * and the capability skill bodies). The runtime image is built from that source
 * — in full, or as a delta on the live image — and until 2026-09-27 nothing
 * compared the two. The delta Dockerfile did not copy `core`, `community` or
 * `office` at all, so each of those trees stayed at the base image's copy while
 * the manifest recorded the new digest: on 2026-09-26 production's
 * `publication-figures/openscience.mplstyle` was the pre-token version under a
 * manifest that said otherwise (platform audit I2-4).
 *
 * This reads each tree where the kernel reads it — the preset's
 * system-trusted skill roots, and the capability bodies delegation injects —
 * inside the image, with the manifest's own digest (releaseManifest.mjs
 * `digestDirectory`: relative path, size and sha256 of every file), and fails
 * on any difference. Byte-compiled Python (`__pycache__`, `*.pyc`) is skipped:
 * the full build generates it beside the curated scripts and it is not source.
 *
 * Usage (the release switch runs it after `current` moves):
 *   node scripts/ops/check-runtime-skill-digests.mjs [MANIFEST] [--image <ref>] [--json]
 *
 * Exit 0 when every recorded tree matches, 1 when one does not (each is
 * named), 2 when the check could not run.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), "../..");
const PRESET_SKILLS = "/opt/evimed/socket/presets/evimed-universal/skills";

/**
 * Where each skill tree a manifest can record is read inside the runtime
 * image. A tree the manifest records and this table does not know is a tree
 * the image does not ship, which is itself the finding: a digest-bound tree no
 * run can load is a record of nothing.
 */
export const SKILL_ROOTS_IN_IMAGE = Object.freeze({
  "runtime/skills/core": `${PRESET_SKILLS}/core`,
  "runtime/skills/curated-scientific": `${PRESET_SKILLS}/curated-scientific`,
  "runtime/skills/office": `${PRESET_SKILLS}/office`,
  "runtime/skills/community": `${PRESET_SKILLS}/community`,
  "runtime/skills/geo-private": `${PRESET_SKILLS}/geo-private`,
  "capability-skills": "/opt/evimed/capability-skills",
});

/**
 * The manifest's digest, computed by the image's own Node over the given roots.
 * One JSON line per root: `{path, files, digest}` or `{path, missing: true}`.
 * Plain CommonJS on stdin, so it depends on nothing in the image but `node`.
 */
export const IMAGE_DIGEST_SCRIPT = String.raw`
const fs = require("fs"), path = require("path"), crypto = require("crypto");
for (const root of process.argv.slice(2)) {
  let stat = null;
  try { stat = fs.lstatSync(root); } catch {}
  if (!stat || !stat.isDirectory()) { console.log(JSON.stringify({ path: root, missing: true })); continue; }
  const files = [];
  (function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const full = path.join(dir, entry.name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push({ full, relative: path.relative(root, full).split(path.sep).join("/"), size: st.size });
    }
  })(root);
  const aggregate = crypto.createHash("sha256");
  for (const file of files) {
    aggregate.update(file.relative); aggregate.update("\0");
    aggregate.update(String(file.size)); aggregate.update("\0");
    aggregate.update("sha256:" + crypto.createHash("sha256").update(fs.readFileSync(file.full)).digest("hex"));
    aggregate.update("\n");
  }
  console.log(JSON.stringify({ path: root, files: files.length, digest: "sha256:" + aggregate.digest("hex") }));
}
`;

/**
 * Run the digest script over `roots` with `command` (the image's node through
 * docker in production; the local node in tests).
 * @param {string[]} command argv prefix that runs `node -` with the script on stdin
 * @param {string[]} roots
 * @returns {Map<string, {files?: number, digest?: string, missing?: boolean}>}
 */
export function measureRoots(command, roots) {
  const [bin, ...args] = command;
  const result = spawnSync(bin, [...args, ...roots], { input: IMAGE_DIGEST_SCRIPT, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}`.trim().split("\n").slice(-3).join(" ");
    throw Object.assign(new Error(`the digest script did not run (${result.error?.message ?? `exit ${result.status}`}): ${detail}`), { code: "skill_digest_unmeasured" });
  }
  const measured = new Map();
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    measured.set(row.path, row);
  }
  // A root that produced no line is "I did not look", not "it matches".
  for (const root of roots) {
    if (!measured.has(root)) throw Object.assign(new Error(`no digest came back for ${root}`), { code: "skill_digest_unmeasured" });
  }
  return measured;
}

/**
 * Compare the manifest's `skills[]` with what was measured in the image.
 * @param {ReadonlyArray<{name: string, source: string, files: number, digest: string}>} skills
 * @param {(roots: string[]) => Map<string, {files?: number, digest?: string, missing?: boolean}>} measure
 */
export function compareSkillDigests(skills, measure) {
  if (!Array.isArray(skills) || skills.length === 0) {
    throw Object.assign(new Error("the manifest records no skill trees"), { code: "skill_digest_manifest_empty" });
  }
  const shipped = skills.filter((skill) => Object.hasOwn(SKILL_ROOTS_IN_IMAGE, skill.source));
  const measured = measure(shipped.map((skill) => SKILL_ROOTS_IN_IMAGE[skill.source]));
  const rows = skills.map((skill) => {
    const inside = SKILL_ROOTS_IN_IMAGE[skill.source];
    if (!inside) return { ...skill, inside: null, verdict: "not-in-image" };
    const got = measured.get(inside) ?? { missing: true };
    if (got.missing) return { ...skill, inside, verdict: "missing" };
    const verdict = got.digest === skill.digest && got.files === skill.files ? "match" : "differs";
    return { ...skill, inside, got: { files: got.files, digest: got.digest }, verdict };
  });
  return { ok: rows.every((row) => row.verdict === "match"), rows };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const imageAt = args.indexOf("--image");
  const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--image");
  const manifestFile = path.resolve(positional[0] ?? path.join(repoRoot, "deploy/web/release-manifest.json"));
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const image = imageAt >= 0 ? args[imageAt + 1] : manifest?.runtime?.image;
  if (!image) throw Object.assign(new Error("the manifest names no runtime image; pass --image"), { code: "skill_digest_no_image" });
  const docker = process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_BIN ?? "docker";
  const command = [docker, "run", "--rm", "-i", "--network", "none", "--entrypoint", "node", image, "-"];
  const result = compareSkillDigests(manifest.skills, (roots) => measureRoots(command, roots));
  if (json) process.stdout.write(`${JSON.stringify({ image, ...result })}\n`);
  else {
    for (const row of result.rows) {
      const where = row.inside ?? "(not shipped in the runtime image)";
      const detail = row.verdict === "differs"
        ? ` — manifest ${row.files} files ${row.digest.slice(0, 19)}…, image ${row.got.files} files ${row.got.digest.slice(0, 19)}…`
        : "";
      process.stdout.write(`  ${row.verdict === "match" ? "ok     " : "DIFFERS"} ${row.source} -> ${where} (${row.verdict})${detail}\n`);
    }
    process.stdout.write(result.ok
      ? `every skill tree the manifest records is in ${image}\n`
      : `the runtime image ${image} does not carry the skill trees this release's manifest records\n`);
  }
  return result.ok ? 0 : 1;
}

// By real path: the release switch runs it from inside `current`, a symlink.
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === scriptFile) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error?.code ?? "skill_digest_failed"}: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  });
}
