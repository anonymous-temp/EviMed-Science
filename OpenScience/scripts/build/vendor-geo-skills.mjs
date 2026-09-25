#!/usr/bin/env node
/**
 * Puts the owner's GEO method pack into the private skill root the runtime
 * image ships: `runtime/skills/geo-private/`.
 *
 * Hidden knowledge: why this is a local step and never a repository one. The
 * method pack (geo-skills, 51 skills and their shared rules, references and
 * scripts) is proprietary, and the repository is public. So the pack lives
 * outside git — packed at `.evimed-local/geo/dist/geo-skills-<version>.zip`
 * with a `SHA256SUMS` beside it — and this script is the only way it reaches
 * the tree: it verifies the archive's sha256 against that file, then unpacks
 * `skills/` and `shared/` (nothing else from the archive) into the private
 * root. `.gitignore` keeps everything there out of git except the tracked
 * `README.md`, and the image copies the directory the way it copies every other
 * skill root, so a fresh clone builds and runs with the root holding only the
 * README (the GEO capabilities then say the method pack is missing).
 *
 * Idempotent: a root already holding exactly this archive's files is left as
 * it is. Replacing is all or nothing — the new tree is unpacked beside the old
 * one and swapped in only when every entry unpacked and every CRC matched, so
 * an interrupted run leaves the previous pack in place.
 *
 * Standard library only, including the unzip: the release is built on hosts
 * whose tools this cannot assume.
 *
 * Usage:
 *   node scripts/build/vendor-geo-skills.mjs [--dist <dir>] [--target <dir>] [--version <x.y.z>] [--force] [--check]
 *
 *   --dist     where the archives and SHA256SUMS are (default: the workspace's
 *              .evimed-local/geo/dist, or EVIMED_GEO_SKILLS_DIST)
 *   --target   the private root (default: runtime/skills/geo-private)
 *   --version  pin one version; by default the newest one SHA256SUMS lists and
 *              the directory holds
 *   --check    verify only: the archive's sha256, and whether the root holds it
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspaceRoot = path.resolve(repoRoot, "..");

/** What is taken out of the archive, relative to its single top directory. */
export const VENDORED_TREES = Object.freeze(["skills", "shared"]);
/** The stamp the root carries, so a second run can tell it holds this archive. */
export const VENDOR_STAMP = "VENDORED.json";
const ARCHIVE_NAME = /^geo-skills-(\d+\.\d+\.\d+)\.zip$/;

/** @param {string} message @returns {never} */
function fail(message) {
  throw Object.assign(new Error(message), { vendorError: true });
}

/**
 * The archive to vendor, with its expected digest: the one asked for by name
 * or version, otherwise the newest version SHA256SUMS lists whose archive is
 * present — the owner ships a new version beside the old one (3.0.1 beside
 * 3.0.0), and the newest is the one a release should carry.
 * @param {string} sums the SHA256SUMS text @param {string | null} [wanted]
 * @param {(name: string) => boolean} [present] whether an archive is in the dist directory
 * @returns {{ name: string, version: string, sha256: string }}
 */
export function pickArchive(sums, wanted = null, present = () => true) {
  const entries = [];
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (!match) continue;
    const version = ARCHIVE_NAME.exec(match[2])?.[1];
    if (version) entries.push({ name: match[2], version, sha256: match[1] });
  }
  if (wanted) {
    const named = entries.find((entry) => entry.name === wanted || entry.version === wanted);
    if (!named) fail(`SHA256SUMS lists no archive ${wanted}`);
    return named;
  }
  if (!entries.length) fail("SHA256SUMS lists no geo-skills-<version>.zip");
  /** @param {string} version */
  const parts = (version) => version.split(".").map(Number);
  entries.sort((left, right) => {
    const [a, b] = [parts(left.version), parts(right.version)];
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  });
  const newest = entries.find((entry) => present(entry.name));
  if (!newest) fail(`none of the archives SHA256SUMS lists is present (${entries.map((entry) => entry.name).join(", ")})`);
  return newest;
}

/**
 * The files of a zip archive, read with the standard library: the central
 * directory, then each local header, stored or deflated, CRC checked.
 * @param {Buffer} archive
 * @returns {{ name: string, data: Buffer }[]}
 */
export function readZip(archive) {
  const EOCD = 0x06054b50;
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at -= 1) {
    if (archive.readUInt32LE(at) === EOCD) { end = at; break; }
  }
  if (end < 0) fail("not a zip archive: no end-of-central-directory record");
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  /** @type {{ name: string, data: Buffer }[]} */
  const files = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) fail(`central directory entry ${index} is malformed`);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const local = archive.readUInt32LE(cursor + 42);
    // Read as UTF-8: the pack's own packer writes its CJK names that way.
    const name = archive.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (compressedSize === 0xffffffff || size === 0xffffffff) fail(`${name}: zip64 entries are not supported`);
    if (archive.readUInt32LE(local) !== 0x04034b50) fail(`${name}: local header is malformed`);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const raw = archive.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else fail(`${name}: compression method ${method} is not supported`);
    if (data.length !== size || zlib.crc32(data) !== crc) fail(`${name}: CRC or size mismatch — the archive is damaged`);
    files.push({ name, data });
  }
  return files;
}

/**
 * The archive entries this root takes, as paths inside the root: under the
 * archive's one top directory, inside `skills/` or `shared/`, and none that
 * could step outside the root.
 *
 * Left out: compiled caches, and the pack's own test suite
 * (`shared/scripts/tests/`). A run never executes the pack's tests, and their
 * fixtures carry key-shaped strings the repository's secret audit — which
 * reads this directory on disk — rightly refuses to tell from real ones.
 * @param {{ name: string, data: Buffer }[]} files
 * @returns {{ path: string, data: Buffer }[]}
 */
export function selectVendoredFiles(files) {
  /** @type {{ path: string, data: Buffer }[]} */
  const out = [];
  for (const file of files) {
    const parts = file.name.split("/");
    if (file.name.startsWith("/") || file.name.includes("\\") || parts.some((part) => part === ".." || part === ".")) {
      fail(`archive entry ${JSON.stringify(file.name)} would leave the root`);
    }
    const inside = parts.slice(1);
    if (!VENDORED_TREES.includes(inside[0] ?? "")) continue;
    if (inside.includes("__pycache__") || file.name.endsWith(".pyc")) continue;
    if (inside.slice(0, 3).join("/") === "shared/scripts/tests") continue;
    out.push({ path: inside.join("/"), data: file.data });
  }
  if (!out.some((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.path))) fail("the archive holds no skills/<name>/SKILL.md");
  return out.sort((left, right) => left.path.localeCompare(right.path));
}

/** @param {{ path: string, data: Buffer }[]} files @returns {string} */
function treeDigest(files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${createHash("sha256").update(file.data).digest("hex")}\n`);
  return hash.digest("hex");
}

/**
 * Whether the root already holds exactly this archive's files.
 * @param {string} target @param {{ name: string, sha256: string }} archive @param {{ path: string, data: Buffer }[]} files
 * @returns {Promise<boolean>}
 */
async function holds(target, archive, files) {
  const stamp = JSON.parse(await fs.readFile(path.join(target, VENDOR_STAMP), "utf8").catch(() => "null"));
  if (!stamp || stamp.sha256 !== archive.sha256 || stamp.tree !== treeDigest(files)) return false;
  for (const file of files) {
    const current = await fs.readFile(path.join(target, file.path)).catch(() => null);
    if (!current || !current.equals(file.data)) return false;
  }
  return true;
}

/**
 * @param {{ dist: string, target: string, version?: string | null, force?: boolean, check?: boolean }} options
 * @returns {Promise<{ status: 'vendored' | 'unchanged' | 'verified' | 'stale', archive: string, version: string, files: number }>}
 */
export async function vendorGeoSkills({ dist, target, version = null, force = false, check = false }) {
  const sums = await fs.readFile(path.join(dist, "SHA256SUMS"), "utf8").catch(() => fail(`no SHA256SUMS in ${dist}`));
  const archive = pickArchive(sums, version, (name) => existsSync(path.join(dist, name)));
  const bytes = await fs.readFile(path.join(dist, archive.name)).catch(() => fail(`${archive.name} is not in ${dist}`));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== archive.sha256) fail(`${archive.name}: sha256 ${actual} does not match SHA256SUMS (${archive.sha256}); refusing to unpack`);
  const files = selectVendoredFiles(readZip(bytes));
  const current = await holds(target, archive, files);
  if (check) return { status: current ? "verified" : "stale", archive: archive.name, version: archive.version, files: files.length };
  if (current && !force) return { status: "unchanged", archive: archive.name, version: archive.version, files: files.length };

  // Unpack beside the root, then swap: an interrupted run keeps the old pack.
  await fs.mkdir(target, { recursive: true });
  const staging = await fs.mkdtemp(path.join(target, ".vendor-"));
  try {
    for (const file of files) {
      const destination = path.join(staging, file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.data);
    }
    for (const tree of VENDORED_TREES) {
      await fs.rm(path.join(target, tree), { recursive: true, force: true });
      if (existsSync(path.join(staging, tree))) await fs.rename(path.join(staging, tree), path.join(target, tree));
    }
    const stamp = { package: "geo-skills", version: archive.version, archive: archive.name, sha256: archive.sha256, tree: treeDigest(files), files: files.length };
    await fs.writeFile(path.join(target, VENDOR_STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return { status: "vendored", archive: archive.name, version: archive.version, files: files.length };
}

/** @param {string[]} argv @returns {Record<string, string | boolean>} */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { args[token.slice(2)] = next; index += 1; } else args[token.slice(2)] = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dist = path.resolve(String(args.dist ?? process.env.EVIMED_GEO_SKILLS_DIST ?? path.join(workspaceRoot, ".evimed-local/geo/dist")));
  const target = path.resolve(String(args.target ?? path.join(repoRoot, "runtime/skills/geo-private")));
  try {
    const result = await vendorGeoSkills({
      dist,
      target,
      version: typeof args.version === "string" ? args.version : null,
      force: Boolean(args.force),
      check: Boolean(args.check),
    });
    process.stdout.write(`${result.status}: ${result.archive} (${result.files} files) -> ${path.relative(repoRoot, target) || target}\n`);
    if (result.status === "stale") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`vendor-geo-skills: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
