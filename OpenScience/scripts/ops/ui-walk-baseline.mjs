#!/usr/bin/env node
/**
 * The walk's baseline file from a walk's report (R19, plan §3 S9; audit D §4 S8).
 *
 * `scripts/ops/ui-walk-baseline.json` is what the release walk accepts for now: a finding it does not name fails the walk, and an entry
 * says who owns the debt and the day it stops being accepted. The first walk of a new regime has a long list of findings that nobody can write
 * by hand, so this reads the report of a rehearsal (`rewalk.sh <tag> <candidate walk>`, the owner-view account on the live release) and
 * proposes one entry for each finding that no entry accepted:
 *
 *   - a finding with a number (`type-pairs`, `rows-ceiling`, `axe`, `orphan-sentence`, …) becomes `rule` + `max`: the page may only get better;
 *   - a coverage gap (`not-observable`, `not-walked`) becomes `rule` for the `owner` profile only: a fixture walk accepts no gap;
 *   - anything else becomes the literal part of its sentence after the view;
 *   - a step that did not run (`step-failed`) is never proposed: it is fixed.
 *
 * The owner, the day and the reason are the person's: there is no default for them, because an entry nobody chose is the notice this file
 * replaces. `--write` merges the proposal into the file (an existing entry keeps the larger `max`) and writes the walk's embedded copy.
 *
 *   node scripts/ops/ui-walk-baseline.mjs propose <report.json> --owner <name> --until <YYYY-MM-DD> --why "<reason>" [--rule <rule>[,<rule>]] [--write]
 *
 * `--rule` proposes only the findings of the named rules (`type-pairs`): a debt that has a name, an owner and a day is written alone, and
 * the findings the walk should still fail on stay failures.
 *   node scripts/ops/ui-walk-baseline.mjs check      # the shipped file is valid; entries that run out within 30 days
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baselineProblems, COVERAGE_RULES, UNACCEPTABLE_RULES } from "./ui-walk.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(here, "ui-walk-baseline.json");

/**
 * One entry for each finding of a report that no baseline entry accepted.
 * @param {any} report what the walk wrote (`report.json`)
 * @param {{ owner: string, until: string, why: string }} who
 * @param {{ rules?: string[] | null }} [only] the rules to propose for; every rule when absent
 * @returns {any[]}
 */
export function proposeEntries(report, { owner, until, why }, { rules = null } = {}) {
  const profile = report?.profile ?? "owner";
  /** @type {Map<string, any>} */ const entries = new Map();
  for (const found of report?.findings ?? []) {
    if (found.accepted || UNACCEPTABLE_RULES.has(found.rule)) continue;
    if (rules && !rules.includes(found.rule)) continue;
    /** @type {any} */ let entry;
    if (COVERAGE_RULES.has(found.rule)) {
      if (profile !== "owner") continue;
      entry = { view: found.view, rule: found.rule, profiles: ["owner"] };
    } else if (typeof found.value === "number") {
      entry = { view: found.view, rule: found.rule, max: found.value };
    } else {
      const sentence = String(found.text).startsWith(`${found.view}: `) ? String(found.text).slice(found.view.length + 2) : String(found.text);
      if (!sentence) continue;
      entry = { view: found.view, contains: sentence };
    }
    const key = `${entry.view}|${entry.rule ?? `contains:${entry.contains}`}`;
    const held = entries.get(key);
    if (held && typeof held.max === "number" && typeof entry.max === "number") held.max = Math.max(held.max, entry.max);
    else if (!held) entries.set(key, entry);
  }
  return [...entries.values()].map((entry) => ({ ...entry, owner, until, why }));
}

/**
 * The file with the proposal in it: an entry that names the same view and finding keeps the larger `max` and the later day.
 * @param {{ entries: any[] }} baseline @param {any[]} proposed
 * @returns {{ entries: any[] }}
 */
export function mergeEntries(baseline, proposed) {
  const same = (/** @type {any} */ a, /** @type {any} */ b) => a.view === b.view && a.rule === b.rule && a.contains === b.contains;
  const entries = baseline.entries.map((/** @type {any} */ entry) => ({ ...entry }));
  for (const entry of proposed) {
    const held = entries.find((/** @type {any} */ candidate) => same(candidate, entry));
    if (!held) entries.push(entry);
    else {
      if (typeof entry.max === "number") held.max = Math.max(held.max ?? 0, entry.max);
      if (entry.until > held.until) held.until = entry.until;
    }
  }
  return { ...baseline, entries };
}

/** @param {string[]} args @param {string} name */
const option = (args, name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };

async function main(args) {
  const [command, ...rest] = args;
  const baseline = JSON.parse(await readFile(BASELINE_FILE, "utf8"));
  if (command === "check") {
    const problems = baselineProblems(baseline);
    for (const problem of problems) console.log(`PROBLEM ${problem}`);
    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    for (const entry of baseline.entries.filter((/** @type {any} */ item) => item.until <= soon)) console.log(`EXPIRES ${entry.until} ${entry.view} ${entry.rule ?? `“${entry.contains}”`} (${entry.owner})`);
    console.log(`${baseline.entries.length} entry(ies), ${problems.length} problem(s)`);
    return problems.length ? 1 : 0;
  }
  if (command === "propose") {
    const [file] = rest;
    const owner = option(rest, "--owner");
    const until = option(rest, "--until");
    const why = option(rest, "--why");
    if (!file || !owner || !until || !why) {
      console.error("usage: ui-walk-baseline.mjs propose <report.json> --owner <name> --until <YYYY-MM-DD> --why \"<reason>\" [--rule <rule>[,<rule>]] [--write]");
      return 2;
    }
    const rules = option(rest, "--rule")?.split(",").map((name) => name.trim()).filter(Boolean) ?? null;
    const proposed = proposeEntries(JSON.parse(await readFile(file, "utf8")), { owner, until, why }, { rules });
    const merged = mergeEntries(baseline, proposed);
    const problems = baselineProblems(merged);
    if (problems.length) {
      for (const problem of problems) console.error(`PROBLEM ${problem}`);
      return 2;
    }
    if (rest.includes("--write")) {
      await writeFile(BASELINE_FILE, `${JSON.stringify(merged, null, 2)}\n`);
      execFileSync(process.execPath, [path.join(here, "embed-walk-tables.mjs")], { stdio: "inherit" });
      console.log(`${proposed.length} entry(ies) proposed, ${merged.entries.length} in the file`);
    } else {
      console.log(JSON.stringify(proposed, null, 2));
    }
    return 0;
  }
  console.error("usage: ui-walk-baseline.mjs propose <report.json> --owner … --until … --why … [--write] | check");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(String(error).slice(0, 300)); process.exit(2); });
}
