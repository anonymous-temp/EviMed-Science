#!/usr/bin/env node
/**
 * What the delivery gate costs, measured on packages that already exist.
 *
 * The blocking-point budget holds at six and nobody has proposed a seventh. But
 * the budget counts *gates*, and what has actually been growing is the required
 * set inside one of them: the clinical contract asked for seven files on
 * 2026-07-23 and asks for eight since 2026-08-15. Every addition is paid for on
 * the first-pass rate, and until now nothing kept that account.
 *
 * So this replays every finished package on disk through the CURRENT gate and
 * separates two very different reasons a package fails:
 *
 *   - it is wrong — a claim without a quote, a citation that does not resolve;
 *   - it is old — it satisfies every rule that existed when it was produced,
 *     and fails only on a file that became required afterwards.
 *
 * The second number is the expansion tax, and it is the one worth watching. A
 * package that would have passed under the rules it was written against, and
 * fails now purely because the list grew, is what a run's repair budget is
 * being spent on.
 *
 * This measures; it decides nothing and blocks nothing. The companion rule —
 * a new required file goes through "notice first" exactly like a new blocking
 * point — is enforced by required-outputs-baseline.json and the test that
 * walks it.
 *
 *   node scripts/ops/gate-health.mjs [--json <file>] [<root>...]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateClinicalEvidencePackage } from "@evimed/domain/clinical-evidence";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baselinePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "required-outputs-baseline.json",
);

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;
const roots = args.filter((value, index) => value !== "--json" && index !== jsonAt + 1);
const searchRoots = roots.length ? roots : [path.join(repoRoot, "uploads")];

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const clinical = baseline.contracts["clinical-evidence-report"];

/** Every directory holding a clinical report, wherever it sits. Packages have
 *  been dropped in three different shapes over two months and a loader that
 *  knew only the newest shape would silently measure a third of the corpus. */
function packageDirs(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "clinical-evidence-report.md")) {
      found.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root, 0);
  return found;
}

/** @param {string} dir @param {any} matrix */
function sourceArtifactsOf(dir, matrix) {
  /** @type {Record<string, string>} */
  const artifacts = {};
  // `.evimed-sources` sits beside the deliverable in a pulled bundle and one
  // level up in a flat drop; both are tried because the corpus has both.
  const bases = [dir, path.dirname(dir), path.dirname(path.dirname(dir))];
  for (const claim of matrix?.claims ?? []) {
    const paths = [claim?.artifactPath, ...((claim?.supportingSources ?? []).map((s) => s?.artifactPath))];
    for (const relative of paths.filter((value) => typeof value === "string" && value)) {
      if (artifacts[relative]) continue;
      for (const base of bases) {
        const absolute = path.join(base, relative);
        if (existsSync(absolute)) {
          artifacts[relative] = readFileSync(absolute, "utf8");
          break;
        }
      }
    }
  }
  return artifacts;
}

const dirs = [...new Set(searchRoots.flatMap(packageDirs))].sort();
if (!dirs.length) {
  console.error(`no clinical packages found under ${searchRoots.join(", ")}`);
  process.exit(1);
}

const rows = [];
for (const dir of dirs) {
  const read = (name) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : "");
  const parse = (name) => {
    try {
      return JSON.parse(read(name) || "null");
    } catch {
      return null;
    }
  };
  const matrix = parse("clinical-evidence-matrix.json");

  // Which required files this package is missing, split by whether the rule
  // existed when it was written. `addedOn` in the baseline is what makes that
  // separable at all.
  const missing = clinical.outputs.filter((output) => output.required && !existsSync(path.join(dir, output.path)));
  const result = validateClinicalEvidencePackage({
    reportText: read("clinical-evidence-report.md"),
    matrix,
    runReceipt: parse("clinical-evidence-run.json"),
    sourceArtifacts: sourceArtifactsOf(dir, matrix),
    searchLogText: read("clinical-evidence-search.json"),
    referencesText: read("references.bib"),
    citationAuditText: read("citation-audit.md"),
    citationLedgerText: read("citation-ledger.csv"),
    questionCoverageText: read("question-coverage.json"),
  });
  const blocking = result.blockingIssues ?? [];
  rows.push({
    package: path.relative(repoRoot, dir),
    ok: blocking.length === 0 && missing.length === 0,
    blockingIssues: blocking.length,
    missingRequired: missing.map((output) => output.path),
    missingAddedAfter: missing.map((output) => output.addedOn),
    issues: blocking.slice(0, 40),
  });
}

/** Three questions, in order, because answering them out of order produces a
 *  headline that is false.
 *
 *  First: can this package be judged from disk at all? A quote check needs the
 *  preserved source, and only 17 of the bundles on disk still carry
 *  `.evimed-sources`. The validator says so plainly — "could not be checked" —
 *  and counting those as content failures is how a replay reports a 6% pass
 *  rate that is really a fact about the replay.
 *
 *  Then, of what remains: is it failing on a rule that existed when it was
 *  written, or on a file that became required afterwards? The second is the
 *  expansion tax and the whole reason this script exists.
 *  @param {{ issues: string[], missingRequired: string[] }} row @param {string} since
 */
function classify(row, since) {
  const unjudgeable = row.issues.filter((issue) => String(issue).includes("could not be checked"));
  if (unjudgeable.length) return { bucket: "unjudgeable", unjudgeableCount: unjudgeable.length };

  const laterFiles = row.missingRequired.filter((file) => String(outputAddedOn(file)) >= since);
  // Attributed by name, not by counting. A missing required file produces its
  // own blocking issue, so a package whose only complaint is that file reads as
  // a content failure unless the issue is traced back to the file.
  const fromLater = row.issues.filter((issue) => laterFiles.some((file) => String(issue).includes(file)));
  const other = row.issues.filter((issue) => !fromLater.includes(issue));
  const missingEarlier = row.missingRequired.filter((file) => String(outputAddedOn(file)) < since);

  if (!row.issues.length && !row.missingRequired.length) return { bucket: "pass" };
  if (!other.length && !missingEarlier.length && laterFiles.length) return { bucket: "taxed", laterFiles };
  return { bucket: "content", contentIssues: other.length || row.missingRequired.length };
}

/** @param {string} file @returns {string} */
function outputAddedOn(file) {
  return clinical.outputs.find((output) => output.path === file)?.addedOn ?? "1970-01-01";
}

const newestAddition = clinical.outputs.map((output) => output.addedOn).sort().at(-1);
for (const row of rows) Object.assign(row, classify(row, newestAddition));
const bucket = (name) => rows.filter((row) => row.bucket === name);
const judgeable = rows.filter((row) => row.bucket !== "unjudgeable");

console.log(`${rows.length} finished package(s) replayed through today's clinical gate\n`);
console.log(`  cannot be judged from disk   ${String(bucket("unjudgeable").length).padStart(3)}  (preserved sources absent — a limit of this replay, not of the package)`);
console.log(`  judgeable                    ${String(judgeable.length).padStart(3)}`);
if (judgeable.length) {
  const pct = (n) => `${(n / judgeable.length * 100).toFixed(0)}%`.padStart(4);
  console.log(`     would pass as-is          ${String(bucket("pass").length).padStart(3)}  ${pct(bucket("pass").length)} of judgeable`);
  console.log(`     fail on content           ${String(bucket("content").length).padStart(3)}  ${pct(bucket("content").length)} — a claim, a quote, a citation: the gate doing its job`);
  console.log(`     fail ONLY on a later rule ${String(bucket("taxed").length).padStart(3)}  ${pct(bucket("taxed").length)} — complete under the rules they were written against`);
}
const newestFile = clinical.outputs.find((output) => output.addedOn === newestAddition)?.path ?? "?";
const predating = rows.filter((row) => row.missingRequired.includes(newestFile)).length;
console.log(`\n  newest required file: ${newestFile} (required since ${newestAddition})`);
console.log(`  packages predating it: ${predating} / ${rows.length}`);
// A zero in the tax row is not reassurance. It can mean "the addition cost
// nothing", or it can mean "no package on disk is complete except for that
// file, so the question cannot be answered here" — and on this corpus it means
// the second. Saying which is the point of the instrument.
if (bucket("taxed").length === 0 && predating > 0) {
  console.log(
    `\n  The tax row reads 0, and that is NOT evidence the addition was free.`
    + `\n  ${predating} package(s) predate ${newestFile}, but none of them is complete`
    + `\n  except for it — every judgeable one fails on content too, and the rest`
    + `\n  cannot be judged from disk at all. The tax becomes measurable on the first`
    + `\n  package produced under the current list and rejected only by the next`
    + `\n  addition. Until then this row is a question, not an answer.`,
  );
}

const missingCounts = new Map();
for (const row of rows) for (const p of row.missingRequired) missingCounts.set(p, (missingCounts.get(p) ?? 0) + 1);
if (missingCounts.size) {
  console.log("\nrequired file absent from how many packages:");
  for (const [file, count] of [...missingCounts].sort((a, b) => b[1] - a[1])) {
    const added = clinical.outputs.find((output) => output.path === file)?.addedOn;
    console.log(`  ${String(count).padStart(3)} / ${rows.length}   ${file.padEnd(32)} required since ${added}`);
  }
}

const shapes = new Map();
for (const row of rows) {
  if (row.bucket === "unjudgeable") continue;
  for (const issue of row.issues) {
    const shape = String(issue)
      .replace(/claims\[\d+\]/g, "claims[]")
      .replace(/CLM-\d+/g, "CLM-N")
      .replace(/第 \d+ 行/g, "第N行")
      .slice(0, 110);
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
}
if (shapes.size) {
  console.log("\nmost common blocking shapes across the corpus:");
  for (const [shape, count] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${String(count).padStart(3)}  ${shape}`);
  }
}

console.log(
  "\nRead this as a cost, not a verdict. A package failing on content is the gate"
  + "\nworking. A package failing only because the list grew after it was written is"
  + "\nthe expansion tax, and it is the number to watch when someone proposes a ninth"
  + "\nrequired file: the budget that is running out is not the count of gates.",
);

if (jsonOut) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonOut, `${JSON.stringify({ replayed: rows.length, judgeable: judgeable.length, pass: bucket("pass").length, content: bucket("content").length, taxed: bucket("taxed").length, unjudgeable: bucket("unjudgeable").length, rows }, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${jsonOut}`);
}
