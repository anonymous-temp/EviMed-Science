#!/usr/bin/env node
/**
 * Prune superseded release trees and their images.
 *
 * A release leaves two things behind on the host: a directory under
 * `releases/` holding the checked-out source, its manifest and its receipt,
 * and a pair of images tagged with the release id. Neither was ever removed.
 * On 2026-09-07 the host reached 99% of a 178 GB disk with twelve superseded
 * runtime images at 4.12 GB each, which is the same shape as the earlier
 * outage where a candidate build filled the filesystem and the public site
 * answered 502.
 *
 * Two rules decide what stays, and a directory or image is kept if either
 * rule keeps it:
 *
 *   - the newest `keep` releases by directory name, which sorts
 *     chronologically because the id is `evimed-YYYYMMDD-<rev>`; and
 *   - anything a container still references, because a stopped container is
 *     restartable and its bind mounts have to survive. The active release
 *     mounts its own `release-manifest.json`, and a previous one can still be
 *     mounted for a receipt, which is exactly the case a name-only rule
 *     would have deleted out from under a running deployment.
 *
 * Refuses to follow symlinks and refuses to touch `current`.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const RELEASE_RE = /^evimed-\d{8}-[0-9a-f]{7,40}$/;
const IMAGE_REPOS = ["open-science-web", "evimed-runtime-dsh"];

function usage() {
  console.error("Usage: release-retention.mjs prune RELEASES_DIR [--keep N] [--images] [--apply]");
  console.error("  Without --apply the script only reports what it would remove.");
  process.exit(2);
}

/** @param {string} value @returns {number} */
function parseKeep(value) {
  if (!/^\d+$/.test(String(value ?? ""))) throw new Error("--keep must be a positive integer.");
  const keep = Number(value);
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error("--keep must be at least 1.");
  return keep;
}

/** @param {string} dir */
async function assertReleasesDir(dir) {
  const stat = await fsp.lstat(dir);
  if (stat.isSymbolicLink()) throw new Error(`Releases directory must not be a symbolic link: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`Releases path is not a directory: ${dir}`);
}

/**
 * Every release directory a container still names, by any mount source.
 *
 * Read from `docker inspect` over all containers including stopped ones. If
 * docker cannot be reached this throws rather than returning an empty set:
 * an empty set here would read as "nothing is in use" and delete the live
 * release, so the honest failure is to refuse.
 *
 * @param {string} releasesDir @returns {Promise<Set<string>>}
 */
export async function mountedReleases(releasesDir) {
  const { stdout: ids } = await run("docker", ["ps", "-aq"]);
  const containers = ids.split("\n").map((line) => line.trim()).filter(Boolean);
  const held = new Set();
  const prefix = path.resolve(releasesDir) + path.sep;
  for (const container of containers) {
    const { stdout } = await run("docker", [
      "inspect", "-f", "{{range .Mounts}}{{.Source}}\n{{end}}", container,
    ]);
    for (const source of stdout.split("\n")) {
      const value = source.trim();
      if (!value.startsWith(prefix)) continue;
      const name = value.slice(prefix.length).split(path.sep)[0];
      if (name) held.add(name);
    }
  }
  return held;
}

/**
 * @param {string} releasesDir @param {number} keep
 * @param {(dir: string) => Promise<Set<string>>} [heldBy] which releases a container
 *   still names. Injectable so the retention rules can be exercised without a
 *   docker daemon; production always passes the real reader, and a caller that
 *   omits it gets the real reader rather than an empty set.
 */
export async function plan(releasesDir, keep, heldBy = mountedReleases) {
  await assertReleasesDir(releasesDir);
  const entries = await fsp.readdir(releasesDir, { withFileTypes: true });
  const named = entries
    .filter((entry) => entry.isDirectory() && RELEASE_RE.test(entry.name))
    .map((entry) => entry.name);
  const releases = await sortByBuildTime(releasesDir, named);
  const newest = new Set(releases.slice(-keep));
  const held = await heldBy(releasesDir);
  const current = await currentRelease(releasesDir);
  const keptFor = new Map();
  for (const name of releases) {
    const reasons = [];
    if (newest.has(name)) reasons.push("newest");
    if (held.has(name)) reasons.push("mounted");
    if (name === current) reasons.push("current");
    if (reasons.length) keptFor.set(name, reasons.join("+"));
  }
  return { releases, keep: keptFor, remove: releases.filter((name) => !keptFor.has(name)) };
}

/**
 * Oldest first, by the build time each release's own manifest records.
 *
 * The id sorts chronologically only to the day. Three releases were cut on
 * 2026-09-08, and by name `7bd5117` — the morning's — came after `5898a48`,
 * the one that was live until the next cutover; a keep-2 by name would have
 * kept the older one and deleted the rollback target. The manifest's
 * `source.createdAt` is the build timestamp both images are labelled with,
 * so it orders same-day releases as they were actually built. A release
 * without a readable manifest falls back to its name, which still places it
 * on the right day.
 *
 * @param {string} releasesDir @param {readonly string[]} names
 */
async function sortByBuildTime(releasesDir, names) {
  const keyed = await Promise.all(names.map(async (name) => {
    let createdAt = "";
    try {
      const manifest = JSON.parse(await fsp.readFile(path.join(releasesDir, name, "OpenScience/deploy/web/release-manifest.json"), "utf8"));
      createdAt = typeof manifest?.source?.createdAt === "string" ? manifest.source.createdAt : "";
    } catch { /* no manifest, or unreadable: the name decides */ }
    return { name, key: `${name.slice(7, 15)}T${createdAt || "00:00:00.000Z"}#${name}` };
  }));
  return keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((entry) => entry.name);
}

/**
 * The release `current` points at, beside the releases directory, if any.
 * It is kept whatever the other rules say: a cutover that has just moved the
 * link and not yet recreated every container is the one moment neither the
 * name rule nor the mount rule is guaranteed to protect it.
 *
 * @param {string} releasesDir
 */
async function currentRelease(releasesDir) {
  try {
    const target = await fsp.realpath(path.join(path.dirname(releasesDir), "current"));
    const name = path.basename(target);
    return path.dirname(target) === (await fsp.realpath(releasesDir)) && RELEASE_RE.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** @param {string} dir @param {string} name */
async function removeRelease(dir, name) {
  const target = path.join(dir, name);
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to delete symbolic link: ${target}`);
  if (!stat.isDirectory()) throw new Error(`Refusing to delete non-directory release: ${target}`);
  await fsp.rm(target, { recursive: true, force: true });
}

/**
 * Remove the image pair of every release that is going away.
 *
 * `docker rmi` refuses an image a container references, so a tag that is
 * still in use survives this loop and is reported rather than forced. That is
 * the intended behaviour: the directory rule and the image rule are allowed
 * to disagree, and docker is the authority on the second one.
 *
 * @param {readonly string[]} removable @param {boolean} apply
 */
async function pruneImages(removable, apply) {
  const removed = [];
  const refused = [];
  for (const release of removable) {
    for (const repo of IMAGE_REPOS) {
      const tag = `${repo}:${release}`;
      if (!apply) { removed.push(tag); continue; }
      try {
        await run("docker", ["rmi", tag]);
        removed.push(tag);
      } catch (error) {
        const message = String(error?.stderr ?? error?.message ?? "");
        if (/No such image/i.test(message)) continue;
        refused.push(`${tag} (${message.trim().split("\n")[0]})`);
      }
    }
  }
  return { removed, refused };
}

/** @returns {boolean} true when this module was started as a program, not imported by a test. */
function invokedDirectly() {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === new URL(`file://${path.resolve(entry)}`).href;
}

async function main() {
  const [command, releasesDir, ...rest] = process.argv.slice(2);
  if (command !== "prune" || !releasesDir) usage();
  let keep = 2;
  let apply = false;
  let images = false;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--keep") { keep = parseKeep(rest[index + 1]); index += 1; }
    else if (rest[index] === "--apply") apply = true;
    else if (rest[index] === "--images") images = true;
    else usage();
  }

  const result = await plan(releasesDir, keep);
  for (const [name, reason] of result.keep) console.log(`keep    ${name} (${reason})`);
  for (const name of result.remove) console.log(`${apply ? "removed" : "would remove"} ${name}`);
  if (apply) for (const name of result.remove) await removeRelease(releasesDir, name);

  if (images) {
    const { removed, refused } = await pruneImages(result.remove, apply);
    for (const tag of removed) console.log(`${apply ? "removed" : "would remove"} image ${tag}`);
    for (const tag of refused) console.log(`kept    image ${tag}`);
  }

  console.log(`${result.releases.length} releases, ${result.keep.size} kept, ${result.remove.length} ${apply ? "removed" : "removable"}`);
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
