#!/usr/bin/env node
/**
 * Does the runtime image carry the code in this working tree?
 *
 * Hidden knowledge: three of our packages are COPYed into the image and run
 * INSIDE the container — `packages/socket`, and `packages/domain` and
 * `packages/harness-port` beneath its `node_modules`. Everything else the
 * control plane runs is read from disk at start, so restarting it is enough.
 * The two halves are deployed by different actions and nothing said so.
 *
 * On 2026-08-26 a day's worth of delivery-gate fixes passed their tests, synced
 * to the host with every file's md5 verified, and had the control plane
 * restarted — and never ran, because the gate executes in the container and the
 * image predated them. The verification that would have caught it is one
 * `grep` inside the image, and I had done exactly that grep earlier the same
 * day for a different batch. A discipline that only works when someone
 * remembers it is not a discipline.
 *
 * Compares content digests, not timestamps: a rebuild that changed nothing must
 * pass, and a source edit that never reached a rebuild must fail.
 *
 * Usage: node scripts/ops/check-runtime-image-current.mjs [--image <ref>] [--json]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const imageAt = args.indexOf("--image");
const image = imageAt >= 0 ? args[imageAt + 1] : process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE;
const dockerBin = process.env.OPEN_SCIENCE_RUNTIME_CONTAINER_BIN ?? "docker";

/** The three trees the Dockerfile copies, and where they land inside. */
const TREES = [
  { source: "packages/socket", inside: "/opt/evimed/socket" },
  { source: "packages/domain", inside: "/opt/evimed/socket/node_modules/@evimed/domain" },
  { source: "packages/harness-port", inside: "/opt/evimed/socket/node_modules/@evimed/harness-port" },
];

/** Only what the kernel actually loads. `node_modules` inside a copied tree is
 *  installed by the image build, not copied, so comparing it would always
 *  differ; tests and fixtures are not shipped behaviour. */
const SKIP_DIRS = new Set(["node_modules", "test", "tests", ".git", "coverage"]);

function fail(code, message) {
  process.stdout.write(jsonOutput ? `${JSON.stringify({ ok: false, code, message })}\n` : `${code}: ${message}\n`);
  process.exit(1);
}

/** Every shipped source file under `root`, as relPath -> sha256 of its bytes.
 *
 *  Per file, not one digest over the whole directory. The directory-digest
 *  version of this check was always red for `packages/socket`, because the
 *  Dockerfile also `cp -a`s the skill tree into `/opt/evimed/socket/presets`
 *  (deploy/runtime-dsh/Dockerfile:277-281) — 20 shipped files on this side, 175
 *  on that one, and a comparison that can never agree. A check that says
 *  "stale" no matter what you do reads exactly like a check that works, which
 *  is the failure this file was written to prevent.
 *
 *  So the rule is: every file this tree ships must be in the image, byte for
 *  byte. Files the image has and the tree does not are build products, not
 *  staleness. */
async function hashTreeFiles(root) {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(mjs|js|json|yml|yaml|md)$/.test(entry.name)) continue;
      files.push(full);
    }
  };
  await walk(root);
  files.sort();
  const byPath = new Map();
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    byPath.set(rel, createHash("sha256").update(await readFile(file)).digest("hex"));
  }
  return byPath;
}

/** The same per-file hashes, read inside the image.
 *
 *  The script goes in on stdin rather than as an argument: quoted through
 *  Node -> docker -> sh it came back empty, and an empty digest compares
 *  unequal to everything — see the note above on checks that are always red.
 *
 *  A path the image does not have comes back as `MISSING`, never as a silently
 *  dropped line: the whole point is to tell "this file is not in the image"
 *  apart from "I did not look".
 *  @param {string} inside @param {string[]} relPaths
 *  @returns {{hashes?: Map<string, string>, missingRoot?: boolean, error?: string}} */
export function hashInsideImage(inside, relPaths) {
  const DELIM = "EVIMED_PATHS_EOF";
  const unusable = relPaths.find((rel) => rel.includes("\n") || rel === DELIM);
  if (unusable) return { error: `path ${JSON.stringify(unusable)} cannot be sent through the shell list` };
  const script = [
    "set -u",
    `cd "${inside}" 2>/dev/null || exit 3`,
    "while IFS= read -r f; do",
    '  if [ -f "$f" ]; then printf "%s %s\n" "$(sha256sum "$f" | cut -d" " -f1)" "$f";',
    '  else printf "MISSING %s\n" "$f"; fi',
    `done <<'${DELIM}'`,
    ...relPaths,
    DELIM,
  ].join("\n");
  const result = spawnSync(dockerBin, ["run", "--rm", "-i", "--entrypoint", "sh", image], {
    input: script,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status === 3) return { missingRoot: true };
  if (result.status !== 0) return { error: String(result.stderr ?? "").trim().slice(0, 300) };
  const hashes = new Map();
  for (const line of String(result.stdout).split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(" ");
    if (at < 0) return { error: `unparsable line from the image: ${JSON.stringify(line.slice(0, 60))}` };
    const [value, rel] = [line.slice(0, at), line.slice(at + 1)];
    if (value !== "MISSING" && !/^[a-f0-9]{64}$/.test(value)) {
      return { error: `the image gave no usable hash for ${rel} (got ${JSON.stringify(value.slice(0, 40))})` };
    }
    hashes.set(rel, value);
  }
  // Answering about fewer files than were asked about is an error, not a pass.
  // Every earlier version of this bug looked like a clean run over an empty set.
  const unanswered = relPaths.filter((rel) => !hashes.has(rel));
  if (unanswered.length) {
    return { error: `the image answered for ${hashes.size} of ${relPaths.length} files; first unanswered: ${unanswered[0]}` };
  }
  return { hashes };
}

/** Which of the tree's files the image does not carry byte for byte.
 *
 *  Asymmetric on purpose. Missing or different -> stale. Present only in the
 *  image -> not stale: the build lands the skill tree inside `/opt/evimed/socket`
 *  itself, so "the image has more" is the normal case, and treating it as drift
 *  is what made the first version of this check red for every image ever built.
 *  @param {Map<string,string>} here @param {Map<string,string>} there
 *  @returns {string[]} */
export function differingFiles(here, there) {
  return [...here.keys()].filter((rel) => there.get(rel) !== here.get(rel));
}

async function main() {
  if (!image) fail("runtime_image_not_named", "Pass --image or set OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE.");
  const stale = [];
  const checked = [];
  for (const tree of TREES) {
    const here = await hashTreeFiles(path.join(repoRoot, tree.source));
    if (here.size === 0) fail("runtime_image_source_missing", `${tree.source} has no shipped files; the comparison would pass by being empty.`);
    const relPaths = [...here.keys()];
    const there = hashInsideImage(tree.inside, relPaths);
    if (there.missingRoot) { stale.push({ ...tree, reason: "the image does not contain this tree" }); continue; }
    if (there.error) fail("runtime_image_unreadable", `Could not read ${tree.inside} in ${image}: ${there.error}`);
    const differing = differingFiles(here, there.hashes);
    checked.push({ source: tree.source, files: relPaths.length });
    if (differing.length) {
      const shown = differing.slice(0, 5).map((rel) => `${rel}${there.hashes.get(rel) === "MISSING" ? " (not in the image)" : ""}`);
      const more = differing.length > shown.length ? `, and ${differing.length - shown.length} more` : "";
      stale.push({ ...tree, reason: `${differing.length} of ${relPaths.length} files differ: ${shown.join(", ")}${more}` });
    }
  }
  if (stale.length) {
    const detail = stale.map((s) => `  ${s.source} -> ${s.inside}: ${s.reason}`).join("\n");
    fail(
      "runtime_image_stale",
      `The runtime image does not carry this working tree. The delivery gate runs INSIDE the container, so these\n`
      + `changes cannot take effect until the image is rebuilt — restarting the control plane is not enough.\n${detail}`,
    );
  }
  const result = { ok: true, image, trees: checked };
  process.stdout.write(jsonOutput ? `${JSON.stringify(result)}\n` : `runtime image carries this working tree (${checked.map((c) => `${c.source}:${c.files}`).join(", ")})\n`);
}

// Importing this file must not run it: its test drives the real functions above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

