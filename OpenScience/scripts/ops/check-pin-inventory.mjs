#!/usr/bin/env node
/**
 * Every occurrence of the pinned kernel version, classified — and nothing
 * unclassified.
 *
 * Why a classifier and not a rewriter. A rewriter was built for this job and
 * refuted: it swept the tree for the literal old version and reported "rewrote
 * 15 copies" while a whole staging stack, and every pin written as an escaped
 * regex (`0\.1\.2-alpha\.3`, ten of them today), stayed behind. The deeper
 * problem was not coverage, it was the premise — these occurrences are not one
 * kind of thing, and a tool that treats them uniformly corrupts the ones that
 * must never move.
 *
 * Three kinds, and only the first moves in an upgrade:
 *
 *   pin        A version this deployment installs, builds, or asserts equal to
 *              the pin. Moving the pin means moving all of these together, or
 *              the tree installs a mixture of two releases — which has
 *              happened here and cost a debugging round.
 *   provenance A record of what a live kernel actually produced: golden wire
 *              frames, the recorded --dump-config, "confirmed against a
 *              running 0.1.2-alpha.3". Rewriting one claims evidence was
 *              gathered from a binary it never touched. That is the most
 *              damaging edit available in this repository, and a batch replace
 *              has already attempted it once.
 *   history    STATUS lines, progress entries, decision records. The past does
 *              not get re-dated.
 *
 * The guard: every occurrence must match a rule, and one that matches none
 * fails the run. A new file carrying the version is classified by a person
 * before an upgrade, rather than discovered afterwards by whichever category
 * it silently fell into.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");
const workspaceRoot = path.resolve(repoRoot, "..");

/**
 * Ordered; first match wins, so a narrower rule precedes a broader one.
 * `where` matches the path from the workspace root; `line` narrows it when one
 * file holds more than one kind.
 * @type {{ kind: "pin"|"provenance"|"history"|"prose", where: RegExp, line?: RegExp, notCurrentPin?: boolean, why: string }[]}
 */
export const RULES = [
  {
    // Scratch from a past analysis. Kept out of the product's inventory
    // deliberately: `uploads/` is ephemeral and is an input to nothing.
    kind: "history",
    where: /^uploads\//,
    why: "a saved artifact of a past run, and an input to no build",
  },
  {
    kind: "provenance",
    where: /^OpenScience\/apps\/server\/test\/fixtures\/dsh\/golden-frames\.json$/,
    why: "the frames were recorded off this exact binary; re-dating them claims evidence from a kernel they never saw",
  },
  {
    kind: "provenance",
    where: /^OpenScience\/apps\/server\/src\/(dshMux|dshRuntimeAdapter|mockDshRuntime)\.mjs$/,
    why: "the wire these modules implement was read off the running kernel named here",
  },
  {
    kind: "provenance",
    where: /^OpenScience\/scripts\/ops\/check-kernel-defaults\.mjs$/,
    why: "records which version produced the stored --dump-config baseline; it moves when the baseline is re-recorded, not when the pin moves",
  },
  {
    kind: "provenance",
    where: /^OpenScience\/(apps|packages|scripts)\//,
    line: /recorded|confirmed against|probed against|Booted|booting|live from|a live |a running |newest published/,
    why: "a statement about what a running kernel produced, or an assertion about that statement",
  },

  {
    // A fourth kind, found by sweeping every version rather than only the pin:
    // a comment that names a version while explaining what happened at it.
    // "DSH 0.1.2-alpha.4 deleted this package" is neither a pin nor a record
    // of recorded evidence — it is the reason a line of code exists, and it
    // stops being true if it is moved forward. Placed first because it is the
    // narrowest test: a comment line, in code, naming a version.
    kind: "prose",
    where: /^OpenScience\/(apps|packages|scripts|deploy)\//,
    // Also a quoted YAML comment: the profile-patch generator emits its own
    // comments as JS string literals, so the marker sits one character in.
    line: /^\s*(\/\/|\*|#|"#)/,
    notCurrentPin: true,
    why: "explanatory prose naming the version something happened at; moving it forward makes the explanation false",
  },
  { kind: "history", where: /^STATUS$/, why: "an execution log entry" },
  { kind: "history", where: /PROGRESS\.md$/, why: "a milestone entry, dated when it happened" },
  { kind: "history", where: /^docs\/superpowers\//, why: "a dated design or decision record" },
  { kind: "history", where: /^(AGENTS|CLAUDE)\.md$/, why: "orientation prose; moves with a documentation pass, not with the pin" },
  { kind: "history", where: /^OpenScience\/AGENTS\.md$/, why: "orientation prose; moves with a documentation pass, not with the pin" },

  { kind: "pin", where: /^OpenScience\/deps-version\.json$/, why: "the single definition" },
  { kind: "pin", where: /^OpenScience\/package\.json$/, why: "pnpm overrides that hold the whole tree on one release" },
  { kind: "pin", where: /^OpenScience\/packages\/harness-port\/package\.json$/, why: "the anti-corruption layer's own dependencies and peers" },
  { kind: "pin", where: /^OpenScience\/packages\/harness-port\/seam-manifest\.json$/, why: "the manifest names the version its contents were verified against" },
  { kind: "pin", where: /^OpenScience\/packages\/harness-port\/test\//, why: "the lockfile-pin tests assert the tree installs exactly one release" },
  { kind: "pin", where: /^OpenScience\/deploy\/runtime-dsh\//, why: "the image builds this version" },
  { kind: "pin", where: /^OpenScience\/deploy\/web\//, why: "the deployed stack runs this version" },
  { kind: "pin", where: /^OpenScience\/docs\/WEB_DEPLOYMENT\.md$/, why: "operator instructions must name the version being deployed" },
  { kind: "pin", where: /^OpenScience\/apps\/server\/src\/config\.mjs$/, why: "the control plane refuses a runtime that is not this version" },
  { kind: "pin", where: /^OpenScience\/apps\/server\/test\//, why: "a fixture or an assertion that a derived copy equals the pin; moves with them" },
  { kind: "pin", where: /^OpenScience\/apps\/web\/src\//, why: "frontend commentary naming the kernel it decodes" },
];

/**
 * Occurrences in both spellings this repository uses: the literal, and the
 * regex-escaped form a pin assertion is written in. The escaped form is what
 * the refuted rewriter never saw.
 * @param {string} version
 * @returns {Promise<{ file: string, line: number, text: string }[]>}
 */
export async function findOccurrences(version) {
  /** @type {Map<string, { file: string, line: number, text: string }>} */
  const found = new Map();
  const spellings = [version, version.replace(/\./g, "\\.")];
  for (const pattern of spellings) {
    let stdout = "";
    try {
      ({ stdout } = await run("git", ["grep", "-nI", "--fixed-strings", pattern], { cwd: workspaceRoot, maxBuffer: 32 * 1024 * 1024 }));
    } catch (error) {
      // git grep exits 1 for "no matches", which is an answer. Anything else
      // is a failure and must not be read as an empty tree.
      if (Number(/** @type {any} */ (error)?.code) === 1) continue;
      throw error;
    }
    for (const row of stdout.split("\n")) {
      if (!row.trim()) continue;
      const match = /^([^:]+):(\d+):(.*)$/.exec(row);
      if (!match) throw new Error(`git grep produced a line this parser cannot read: ${JSON.stringify(row)}`);
      if (match[1].endsWith("pnpm-lock.yaml")) continue;
      found.set(`${match[1]}:${match[2]}`, { file: match[1], line: Number(match[2]), text: match[3] });
    }
  }
  return [...found.values()].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

/**
 * @param {{ file: string, line: number, text: string }} occurrence
 * @returns {{ kind: "pin"|"provenance"|"history", why: string } | null}
 */
export function classify(occurrence, options = {}) {
  for (const rule of RULES) {
    if (!rule.where.test(occurrence.file)) continue;
    if (rule.line && !rule.line.test(occurrence.text)) continue;
    // A comment is only prose when it names a version that is *not* the pin.
    // A Dockerfile comment restating the pin has to move with it or it starts
    // lying about the line beneath it; a comment naming the release that
    // deleted a package must never move or the explanation becomes false.
    // That is the whole difference, and it is decidable.
    if (rule.notCurrentPin && options.pin && occurrence.text.includes(options.pin)) continue;
    return { kind: rule.kind, why: rule.why };
  }
  return null;
}

/** @param {{ version?: string }} [options] */
/**
 * Every kernel version still written down anywhere, not only the current one.
 *
 * The first version of this swept the pin alone, and an upgrade made it blind
 * to exactly what it was built to protect: after repinning to alpha.5 the
 * inventory reported 0 provenance, because the thirteen provenance sites still
 * say alpha.3 and the sweep no longer looked for it. The next upgrade would
 * have walked past all of them.
 *
 * A version counts as this dependency's when it is written on a line that also
 * names the kernel — mechanical, and narrow enough to leave the tree's other
 * prereleases (`1.0.0-rc.18` and friends) alone.
 * @returns {Promise<string[]>}
 */
export async function kernelVersionsPresent(currentPin) {
  const versions = new Set([currentPin]);
  let stdout = "";
  try {
    ({ stdout } = await run("git", ["grep", "-hInE", "[0-9]+\\.[0-9]+\\.[0-9]+-(rc|alpha|beta)\\.[0-9]+"], { cwd: workspaceRoot, maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    if (Number(/** @type {any} */ (error)?.code) !== 1) throw error;
  }
  for (const row of stdout.split("\n")) {
    if (!/dsh|deepseek/i.test(row)) continue;
    for (const match of row.matchAll(/\b\d+\.\d+\.\d+-(?:rc|alpha|beta)\.\d+\b/g)) versions.add(match[0]);
  }
  return [...versions].sort();
}

export async function checkPinInventory(options = {}) {
  const pinsText = await readFile(path.join(repoRoot, "deps-version.json"), "utf8");
  const pin = JSON.parse(pinsText)?.dsh?.version;
  if (!pin) throw new Error("deps-version.json carries no dsh.version; there is nothing to inventory");
  const version = options.version ?? pin;
  const versions = options.version ? [options.version] : await kernelVersionsPresent(pin);

  /** @type {{ file: string, line: number, text: string }[]} */
  const collected = [];
  const seen = new Set();
  for (const candidate of versions) {
    for (const occurrence of await findOccurrences(candidate)) {
      const key = `${occurrence.file}:${occurrence.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(occurrence);
    }
  }
  const occurrences = collected.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  // An empty sweep is the failure this file exists to make impossible: the pin
  // is in deps-version.json at minimum, so a near-zero count means the search
  // broke rather than that the tree is clean.
  if (occurrences.length < 2) {
    throw new Error(`only ${occurrences.length} occurrence(s) of ${version} found; the search is broken, not the tree`);
  }

  const classified = occurrences.map((occurrence) => ({ ...occurrence, verdict: classify(occurrence, { pin }) }));
  /** @type {Record<string, number>} */
  const counts = { pin: 0, provenance: 0, history: 0, prose: 0 };
  for (const entry of classified) if (entry.verdict) counts[entry.verdict.kind] += 1;

  return { version, versions, occurrences: classified, unclassified: classified.filter((entry) => entry.verdict === null), counts };
}

/** @param {Awaited<ReturnType<typeof checkPinInventory>>} report @returns {string} */
export function formatReport(report) {
  const lines = [
    `pin inventory: ${report.occurrences.length} occurrences of ${(report.versions ?? [report.version]).join(", ")}`,
    `  ${report.counts.pin} pin (move together on an upgrade), ${report.counts.provenance} provenance (never rewritten), ${report.counts.history} history, ${report.counts.prose} prose`,
  ];
  if (report.unclassified.length) {
    lines.push("", `${report.unclassified.length} occurrence(s) no rule claims:`);
    for (const entry of report.unclassified) lines.push(`  ${entry.file}:${entry.line}  ${entry.text.trim().slice(0, 100)}`);
    lines.push(
      "",
      "Classify each in RULES before upgrading. An occurrence nobody classified becomes whichever kind it",
      "happens to be treated as, and the expensive mistake is rewriting a recorded provenance string.",
    );
  } else {
    lines.push("", "every occurrence is classified.");
  }
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const versionArg = process.argv.slice(2).find((argument) => !argument.startsWith("-"));
  const report = await checkPinInventory(versionArg ? { version: versionArg } : {});
  console.log(formatReport(report));
  if (report.unclassified.length) process.exitCode = 1;
}
