#!/usr/bin/env node
/**
 * How many characters of skill text a 虚拟临床研究 task reads before it starts (remediation plan C3): the files the model is told to read
 * for the task — the shared operating contract, the protocol skill, the analysis skill with the reference of the task's own part, and the
 * evidence skill where the task needs assumption cards — summed, so that a split of the skills can be shown to cost a task less.
 *
 * A reference that does not exist in the tree being measured is not counted: measured on the revision before the split, every task reads
 * the whole of its skill, which is the point of comparison.
 *
 *   node scripts/dev/vcr-skill-reading.mjs                # the working tree
 *   node scripts/dev/vcr-skill-reading.mjs --rev <rev>    # a revision of this repository (git show), e.g. the one before the split
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (/** @type {string} */ file, /** @type {string | null} */ rev) => {
  try {
    if (rev) return execFileSync("git", ["show", `${rev}:OpenScience/${file}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return fs.readFileSync(path.join(root, file), "utf8");
  } catch { return null; }
};

const CONTRACT = "capabilities/vcr-protocol/references/operating-contract.md";
const PROTOCOL = "capabilities/vcr-protocol/SKILL.md";
const ANALYSIS = "capabilities/vcr-analysis/SKILL.md";
const EVIDENCE = "capabilities/vcr-evidence/SKILL.md";
const PACKAGE = "capabilities/vcr-package/SKILL.md";
const MATCHING = "capabilities/vcr-matching/SKILL.md";
const part = (/** @type {string} */ name) => `capabilities/vcr-analysis/references/${name}.md`;

/** @type {Record<string, string[]>} */
export const TASKS = {
  "design (trial design)": [CONTRACT, PROTOCOL, ANALYSIS, part("trial-design"), EVIDENCE],
  "comparator": [CONTRACT, PROTOCOL, ANALYSIS, part("comparators"), EVIDENCE],
  "population and patients": [CONTRACT, PROTOCOL, ANALYSIS, part("populations-and-patients"), part("models"), EVIDENCE],
  "longitudinal forecasts": [CONTRACT, PROTOCOL, ANALYSIS, part("longitudinal"), part("models")],
  "delivering a report file": [CONTRACT, PROTOCOL, ANALYSIS, part("delivery"), PACKAGE],
  "matching": [CONTRACT, PROTOCOL, MATCHING],
};

export function reading(/** @type {string | null} */ rev) {
  return Object.fromEntries(Object.entries(TASKS).map(([task, files]) => {
    const found = files.map((file) => [file, read(file, rev)]).filter(([, text]) => text !== null);
    return [task, { characters: found.reduce((total, [, text]) => total + [...String(text)].length, 0), files: found.map(([file]) => file) }];
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const named = process.argv.indexOf("--rev");
  const rev = named >= 0 ? process.argv[named + 1] : null;
  for (const [task, { characters, files }] of Object.entries(reading(rev))) {
    process.stdout.write(`${task.padEnd(28)} ${String(characters).padStart(7)} characters  (${files.length} files)\n`);
  }
}
