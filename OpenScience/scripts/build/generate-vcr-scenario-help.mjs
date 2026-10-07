#!/usr/bin/env node
/**
 * Writes `runtime/mcp/evimed-research/vcr_scenario_help.json`: for every engine
 * method, every key its scenario reads (type, unit, range, default, required or
 * optional, the endpoint or design that gates it) and one valid example,
 * rendered out of the domain's scenario schemas — the ones the validator and
 * the engine enforce.
 *
 * Hidden knowledge: the schemas are JavaScript and the tool a run reads them
 * through is Python, in a runtime image that carries no Node. A description typed
 * into the tool drifts (a run wrote `accrual.months` on 2026-10-04 because the
 * description gave `accrual?` no keys), so the tool renders this file instead and
 * the file is generated, never edited. `--check` is what CI runs: it fails when
 * the file is not what the schemas now say, and it fails when an example is a
 * scenario the validator refuses.
 *
 * Usage:
 *   node scripts/build/generate-vcr-scenario-help.mjs            # write
 *   node scripts/build/generate-vcr-scenario-help.mjs --check    # what CI runs
 *   ... --file <path>                                            # another target (the tests'), same rules
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VCR_SCENARIO_EXAMPLES, validateScenario, vcrScenarioHelp } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The file's path, relative to the repository root. */
export const VCR_SCENARIO_HELP_FILE = "runtime/mcp/evimed-research/vcr_scenario_help.json";

/**
 * One row, one example, one condition per line, so a change to one key touches
 * one line and two branches that each change a different method merge cleanly.
 * @param {any} value @param {number} [depth] @returns {string}
 */
export function stringify(value, depth = 0) {
  const flat = JSON.stringify(value);
  if (flat === undefined || !value || typeof value !== "object" || flat.length <= 160) return flat ?? "null";
  const pad = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  if (Array.isArray(value)) return `[\n${value.map((item) => `${pad}${stringify(item, depth + 1)}`).join(",\n")}\n${close}]`;
  return `{\n${Object.entries(value).map(([key, item]) => `${pad}${JSON.stringify(key)}: ${stringify(item, depth + 1)}`).join(",\n")}\n${close}}`;
}

/**
 * The file as the schemas now say it. Throws when an example is a scenario its
 * own method's validator refuses: an example that cannot be run is worse than none.
 * @returns {string}
 */
export function renderVcrScenarioHelp() {
  for (const [method, examples] of Object.entries(VCR_SCENARIO_EXAMPLES)) {
    for (const example of examples) {
      const issues = validateScenario(method, example.scenario);
      if (issues.length) {
        throw new Error(`the example "${example.label}" of ${method} is refused by the validator: ${issues.map((issue) => `${issue.code}@${issue.field}`).join(", ")}`);
      }
    }
  }
  return `${stringify(vcrScenarioHelp())}\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  const named = process.argv.indexOf("--file");
  const target = named >= 0 && process.argv[named + 1] ? path.resolve(process.argv[named + 1]) : path.join(repoRoot, VCR_SCENARIO_HELP_FILE);
  const rendered = renderVcrScenarioHelp();
  const methods = Object.keys(JSON.parse(rendered).methods).length;
  if (check) {
    const current = await fs.readFile(target, "utf8").catch(() => null);
    if (current !== rendered) {
      process.stderr.write(`out of date: ${path.relative(repoRoot, target)}\nrun \`node scripts/build/generate-vcr-scenario-help.mjs\` and commit the result\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${methods} scenario help entries up to date\n`);
    return;
  }
  await fs.writeFile(target, rendered, "utf8");
  process.stdout.write(`${methods} scenario help entries written to ${path.relative(repoRoot, target)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
