// Harness: run the delivery gate over the delivered packages.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateClinicalEvidencePackage, clinicalEvidencePackageErrorCode } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/clinicalEvidenceQuality.mjs";

const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
// The brief the run was dispatched with. The server holds this in memory on the
// run record and hands it to the gate; here it is read from the brief corpus.
const briefRoot = "/home/coder/workspace/EviMedScience/uploads/20260812-sxjxw-33/briefs";
const targets = process.argv.slice(2);
const dirs = targets.length
  ? targets
  : readdirSync(root).filter((name) => /^RQ-\d+_/.test(name)).sort();

const read = (dir, name) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : "");

const out = {};
for (const name of dirs) {
  const dir = path.join(root, name);
  const reportText = read(dir, "clinical-evidence-report.md");
  let matrix = null;
  let runReceipt = null;
  try { matrix = JSON.parse(read(dir, "clinical-evidence-matrix.json")); } catch { matrix = null; }
  try { runReceipt = JSON.parse(read(dir, "clinical-evidence-run.json")); } catch { runReceipt = null; }
  // Preserved artifacts are not in the upload. Synthesize each artifact's text
  // out of the quotes the matrix says it carries, so quote-matching passes and
  // the report-level checks are what we observe.
  const sourceArtifacts = {};
  const addQuote = (p, q) => {
    if (typeof p !== "string" || typeof q !== "string") return;
    sourceArtifacts[p] = `${sourceArtifacts[p] ?? ""}\n\n${q}`;
  };
  for (const claim of matrix?.claims ?? []) {
    addQuote(claim.artifactPath, claim.supportQuote);
    for (const s of claim.supportingSources ?? []) addQuote(s.artifactPath, s.supportQuote);
  }
  for (const p of runReceipt?.successfulSourceArtifacts ?? []) sourceArtifacts[p] ??= "";
  const searchLogText = read(dir, "clinical-evidence-search.json");
  let queries = null;
  try { queries = (JSON.parse(searchLogText).queries ?? []).map((q) => q.query ?? q.queryString ?? q); } catch { queries = null; }
  const result = validateClinicalEvidencePackage({
    reportText,
    matrix,
    runReceipt,
    sourceArtifacts,
    executedSearchQueries: queries,
    searchLogText,
    referencesText: read(dir, "references.bib"),
    citationLedgerText: read(dir, "citation-ledger.csv"),
    citationAuditText: read(dir, "citation-audit.md"),
    questionCoverageText: read(path.join(root, "audit", "coverage"), `${name}.question-coverage.json`),
    briefText: process.env.NOBRIEF ? null : read(briefRoot, `${name.slice(0, 5)}_研究任务.md`) || null,
  });
  out[name] = {
    valid: result.valid,
    errorCode: clinicalEvidencePackageErrorCode(result.blockingIssues ?? result.issues ?? []),
    issues: result.issues,
    blockingIssues: result.blockingIssues,
    coverageDegradedNotice: result.coverageDegradedNotice,
  };
}
console.log(JSON.stringify(out, null, 1));
