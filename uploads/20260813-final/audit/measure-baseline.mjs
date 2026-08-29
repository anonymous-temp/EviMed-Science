// Run `git worktree add /tmp/basegate HEAD` first: this arm imports the gate as it stands at HEAD.
// Baseline arm: the gate exactly as it stands at HEAD (no brief input at all),
// fed the same synthesized ledger, over the same 29 packages.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateClinicalEvidencePackage, clinicalEvidencePackageErrorCode } from "/tmp/basegate/OpenScience/apps/server/src/clinicalEvidenceQuality.mjs";

const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const dirs = readdirSync(root).filter((name) => /^RQ-\d+_/.test(name)).sort();
const read = (dir, name) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : "");
const out = {};
for (const name of dirs) {
  const dir = path.join(root, name);
  let matrix = null; let runReceipt = null;
  try { matrix = JSON.parse(read(dir, "clinical-evidence-matrix.json")); } catch { matrix = null; }
  try { runReceipt = JSON.parse(read(dir, "clinical-evidence-run.json")); } catch { runReceipt = null; }
  const sourceArtifacts = {};
  const addQuote = (p, q) => { if (typeof p === "string" && typeof q === "string") sourceArtifacts[p] = `${sourceArtifacts[p] ?? ""}\n\n${q}`; };
  for (const claim of matrix?.claims ?? []) {
    addQuote(claim.artifactPath, claim.supportQuote);
    for (const s of claim.supportingSources ?? []) addQuote(s.artifactPath, s.supportQuote);
  }
  for (const p of runReceipt?.successfulSourceArtifacts ?? []) sourceArtifacts[p] ??= "";
  const searchLogText = read(dir, "clinical-evidence-search.json");
  let queries = null;
  try { queries = (JSON.parse(searchLogText).queries ?? []).map((q) => q.query ?? q.queryString ?? q); } catch { queries = null; }
  const result = validateClinicalEvidencePackage({
    reportText: read(dir, "clinical-evidence-report.md"),
    matrix, runReceipt, sourceArtifacts, executedSearchQueries: queries, searchLogText,
    referencesText: read(dir, "references.bib"),
    citationLedgerText: read(dir, "citation-ledger.csv"),
    citationAuditText: read(dir, "citation-audit.md"),
    questionCoverageText: read(path.join(root, "audit", "coverage"), `${name}.question-coverage.json`),
  });
  out[name] = { valid: result.valid, errorCode: clinicalEvidencePackageErrorCode(result.blockingIssues ?? []), issues: result.issues, blockingIssues: result.blockingIssues };
}
console.log(JSON.stringify(out, null, 1));
