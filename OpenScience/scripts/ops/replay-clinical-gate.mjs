/**
 * Replays finished clinical packages through the real delivery gate.
 *
 * Why this exists: every gate-reporting defect found so far was found by
 * dispatching a live run, waiting 40-70 minutes, and reading what came back —
 * one defect per run, at the cost of a run. The packages those runs produced
 * are on disk. Feeding them back through the same validator finds the same
 * class of defect in seconds, and finds all of them at once instead of the
 * first one the run happened to hit.
 *
 * It is not a second implementation: it imports `validateClinicalEvidencePackage`
 * and `sourceArtifacts` are read from the bundle's own `.evimed-sources`, which
 * is what the run-side join hands the gate when it works.
 *
 * The output that matters is the SHAPE census. A message repeated across many
 * claims of one package is one decision reported N times — the defect family
 * that cost three runs their attempt budget — so any shape recurring three or
 * more times within a single package is reported as a suspected reporting
 * defect rather than as N findings. That threshold is the same one
 * `collapseClaimFieldIssues` enforces, so a clean census here is evidence the
 * collapse is actually reaching production shapes.
 *
 *   node scripts/ops/replay-clinical-gate.mjs <bundle-dir>...
 *   node scripts/ops/replay-clinical-gate.mjs --json <bundle-dir>...
 *
 * A bundle dir is a pulled workspace: `deliverables/<id>/*` plus optionally
 * `.evimed-sources/`. Exit 1 when any suspected reporting defect is found, so
 * this can gate a change the way a test does.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateClinicalEvidencePackage } from "@evimed/domain/clinical-evidence";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dirs = args.filter((value) => value !== "--json");
if (!dirs.length) {
  console.error("usage: replay-clinical-gate.mjs [--json] <bundle-dir>...");
  process.exit(2);
}

/** @param {string} dir @returns {string | null} */
function soleDeliverable(dir) {
  const root = join(dir, "deliverables");
  if (!existsSync(root)) return null;
  const found = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory());
  return found[0] ?? null;
}

/** Every artifact path the matrix names, resolved against the bundle. This is
 *  the map the run-side join builds from the evidence ledger; reading it from
 *  disk here asks "would the gate accept this package if the join worked",
 *  which is the question a replay can answer and a live run cannot isolate.
 *  @param {string} dir @param {any} matrix @returns {Record<string, string>} */
function sourceArtifactsOf(dir, matrix) {
  /** @type {Record<string, string>} */
  const artifacts = {};
  for (const claim of matrix?.claims ?? []) {
    const paths = [claim?.artifactPath, ...((claim?.supportingSources ?? []).map((source) => source?.artifactPath))];
    for (const path of paths.filter((value) => typeof value === "string" && value)) {
      if (artifacts[path]) continue;
      const absolute = join(dir, path);
      if (existsSync(absolute)) artifacts[path] = readFileSync(absolute, "utf8");
    }
  }
  return artifacts;
}

/** The message with the parts that vary between claims removed, so "the same
 *  complaint about claim 3 and claim 11" collapses to one shape. Digits inside
 *  quoted values are kept: `"regulatory_record"` and `"source-quotes.md"` are
 *  different decisions and must not merge.
 *  @param {string} message @returns {string} */
function shapeOf(message) {
  return String(message)
    .replace(/claims\[\d+\]/g, "claims[]")
    .replace(/supportingSources\[\d+\]/g, "supportingSources[]")
    .replace(/(?:^|\s)第 \d+ 行/g, " 第N行")
    .replace(/Report line \d+/g, "Report line N")
    .replace(/条目 [\d.]+/g, "条目 N")
    .slice(0, 200);
}

const report = [];
let suspected = 0;

for (const dir of dirs) {
  const deliverableId = soleDeliverable(dir);
  if (!deliverableId) {
    report.push({ dir, error: "no deliverables/<id> directory" });
    continue;
  }
  const base = join(dir, "deliverables", deliverableId);
  const read = (name) => (existsSync(join(base, name)) ? readFileSync(join(base, name), "utf8") : "");
  let matrix = null;
  try {
    matrix = JSON.parse(read("clinical-evidence-matrix.json") || "null");
  } catch {
    matrix = null;
  }
  let runReceipt = null;
  try {
    runReceipt = JSON.parse(read("clinical-evidence-run.json") || "null");
  } catch {
    runReceipt = null;
  }

  const result = validateClinicalEvidencePackage({
    reportText: read("clinical-evidence-report.md"),
    matrix,
    runReceipt,
    sourceArtifacts: sourceArtifactsOf(dir, matrix),
    searchLogText: read("clinical-evidence-search.json"),
    referencesText: read("references.bib"),
    citationLedgerText: read("citation-ledger.csv"),
    citationAuditText: read("citation-audit.md"),
    questionCoverageText: read("question-coverage.json"),
  });

  const blocking = new Set(result.blockingIssues ?? []);
  /** @type {Map<string, number>} */
  const census = new Map();
  for (const issue of result.issues ?? []) {
    const shape = shapeOf(issue);
    census.set(shape, (census.get(shape) ?? 0) + 1);
  }
  const repeated = [...census.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]);
  suspected += repeated.length;

  report.push({
    dir,
    deliverableId,
    required: (result.blockingIssues ?? []).length,
    advisory: (result.issues ?? []).length - blocking.size,
    total: (result.issues ?? []).length,
    repeated: repeated.map(([shape, count]) => ({ count, shape })),
    requiredMessages: (result.blockingIssues ?? []).slice(0, 8).map((issue) => String(issue).slice(0, 160)),
  });
}

if (asJson) {
  console.log(JSON.stringify({ suspectedReportingDefects: suspected, runs: report }, null, 2));
} else {
  for (const entry of report) {
    if (entry.error) {
      console.log(`${entry.dir}: ${entry.error}`);
      continue;
    }
    console.log(`\n=== ${entry.dir} (${entry.deliverableId}) ===`);
    console.log(`  required=${entry.required}  advisory=${entry.advisory}  total=${entry.total}`);
    for (const message of entry.requiredMessages) console.log(`    REQ  ${message}`);
    for (const { count, shape } of entry.repeated) {
      console.log(`    x${count} SHAPE  ${shape.slice(0, 150)}`);
    }
  }
  console.log(
    suspected
      ? `\n${suspected} shape(s) repeat 3+ times inside one package: one decision reported many times, which is a reporting defect, not that many findings.`
      : "\nNo shape repeats 3+ times inside any package: every finding is its own fact.",
  );
}

process.exit(suspected ? 1 : 0);
