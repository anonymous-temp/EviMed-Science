#!/usr/bin/env node
/**
 * Re-pins the curated-skill inventory digests.
 *
 * Hidden knowledge: what those digests attest to, and what may change without
 * invalidating the attestation. Each entry records that a vendored third-party
 * skill was security-reviewed at exactly that content. A migration that edits
 * the prose — the kernel's name, a path a skill hardcoded — does not change the
 * security posture, but it does change the content, and a digest that no longer
 * matches is a review record that has silently stopped being checked.
 *
 * So the digests are re-pinned deliberately, by a script that says why, rather
 * than by relaxing the check. Three properties make the re-pin auditable, and
 * each exists because the obvious implementation loses it:
 *
 * 1. The edit is surgical. Re-serialising the parsed inventory reformatted a
 *    hand-indented block and turned a 36-line change into a 684-line one, which
 *    is the same as not showing the change at all. Only the digest *strings* are
 *    rewritten, in place, so the diff is exactly the claim being made.
 * 2. The security fields (`security`, `reviewed`, `derivedFrom`, `fills`) are
 *    never touched, and a test proves it: this rewrites what the content is,
 *    never what was concluded about it.
 * 3. Every move is appended to `digest-repins.jsonl` with a mandatory reason.
 *    "Say it in the PR" is a rule that survives exactly as long as the PR is
 *    open; the ledger is what a reviewer two years from now can actually read,
 *    and `--check` verifies each skill's current digest is the last thing the
 *    ledger recorded for it.
 *
 * Usage:
 *   node scripts/build/repin-curated-skill-digests.mjs --check
 *   node scripts/build/repin-curated-skill-digests.mjs --reason "<why the content changed>"
 */

import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digestDirectory } from "../../apps/server/src/releaseManifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Fields a re-pin may never touch: they record a conclusion, not a content. */
export const ATTESTATION_FIELDS = Object.freeze(["security", "reviewed", "derivedFrom", "fills"]);

/**
 * Replaces one digest string in place, refusing anything ambiguous.
 *
 * A digest is a content hash, so two skills sharing one means two skills with
 * identical content — possible, and a case where a blind replace would silently
 * re-pin the wrong entry. It fails instead.
 *
 * @param {string} source @param {string} from @param {string} to @param {string} skill
 * @returns {string}
 */
export function replaceDigest(source, from, to, skill) {
  const needle = `"digest": "${from}"`;
  const occurrences = source.split(needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(`digest for ${skill} appears ${occurrences} times in the inventory; refusing to re-pin ambiguously`);
  }
  return source.replace(needle, `"digest": "${to}"`);
}

/**
 * @param {string} curatedRoot
 * @returns {Promise<{ name: string, from: string, to: string }[]>}
 */
export async function movedDigests(curatedRoot) {
  const inventory = JSON.parse(await readFile(path.join(curatedRoot, "inventory.json"), "utf8"));
  /** @type {{ name: string, from: string, to: string }[]} */
  const moved = [];
  for (const skill of inventory.skills) {
    const { digest } = await digestDirectory(path.join(curatedRoot, skill.name));
    if (digest !== skill.digest) moved.push({ name: skill.name, from: skill.digest, to: digest });
  }
  return moved;
}

/**
 * Reads the append-only ledger.
 * @param {string} ledgerPath
 * @returns {Promise<{ at: string, skill: string, from: string, to: string, reason: string }[]>}
 */
export async function readRepinLedger(ledgerPath) {
  let text = "";
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/**
 * Whether the ledger accounts for where each digest is now.
 *
 * The rule is the one a hand-edit breaks: for any skill the ledger mentions,
 * the digest recorded by its last entry must be the digest the inventory
 * carries. A skill the ledger never mentions is still on its original pin,
 * which needs no explanation.
 *
 * @param {{ name: string, digest: string }[]} skills
 * @param {{ skill: string, from: string, to: string }[]} ledger
 * @returns {{ skill: string, expected: string, actual: string }[]}
 */
export function unexplainedDigests(skills, ledger) {
  /** @type {Map<string, string>} */
  const last = new Map();
  for (const entry of ledger) last.set(entry.skill, entry.to);
  /** @type {{ skill: string, expected: string, actual: string }[]} */
  const unexplained = [];
  for (const skill of skills) {
    const expected = last.get(skill.name);
    if (expected != null && expected !== skill.digest) {
      unexplained.push({ skill: skill.name, expected, actual: skill.digest });
    }
  }
  return unexplained;
}

// The module is importable so the tests can exercise the rules above against a
// fixture rather than against the real inventory.
if (import.meta.url === `file://${process.argv[1]}`) {
  const curatedRoot = path.join(repoRoot, "runtime/skills/curated-scientific");
  const inventoryPath = path.join(curatedRoot, "inventory.json");
  const ledgerPath = path.join(curatedRoot, "digest-repins.jsonl");
  const check = process.argv.includes("--check");
  const reasonIndex = process.argv.indexOf("--reason");
  const reason = reasonIndex >= 0 ? String(process.argv[reasonIndex + 1] ?? "").trim() : "";
  const stampIndex = process.argv.indexOf("--at");
  const stamp = stampIndex >= 0 ? String(process.argv[stampIndex + 1] ?? "").trim() : new Date().toISOString();

  const moved = await movedDigests(curatedRoot);
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const unexplained = unexplainedDigests(inventory.skills, await readRepinLedger(ledgerPath));

  if (unexplained.length) {
    process.stderr.write(`${unexplained.length} digest(s) moved without a ledger entry:\n`);
    for (const entry of unexplained) process.stderr.write(`  ${entry.skill}\n`);
    process.exitCode = 1;
  } else if (!moved.length) {
    process.stdout.write("curated skill digests are current\n");
  } else if (check) {
    process.stderr.write(`${moved.length} curated skill digest(s) are stale:\n`);
    for (const entry of moved) process.stderr.write(`  ${entry.name}\n`);
    process.stderr.write('run `node scripts/build/repin-curated-skill-digests.mjs --reason "<why the content changed>"`\n');
    process.exitCode = 1;
  } else if (!reason) {
    process.stderr.write("a re-pin needs --reason: the ledger records why the content moved, not just that it did\n");
    process.exitCode = 1;
  } else {
    let source = await readFile(inventoryPath, "utf8");
    for (const entry of moved) source = replaceDigest(source, entry.from, entry.to, entry.name);
    await writeFile(inventoryPath, source, "utf8");
    const lines = moved.map((entry) => `${JSON.stringify({ at: stamp, skill: entry.name, from: entry.from, to: entry.to, reason })}\n`);
    await appendFile(ledgerPath, lines.join(""), "utf8");
    process.stdout.write(`re-pinned ${moved.length} curated skill digest(s):\n`);
    for (const entry of moved) process.stdout.write(`  ${entry.name}: ${entry.from.slice(7, 15)} → ${entry.to.slice(7, 15)}\n`);
  }
}
