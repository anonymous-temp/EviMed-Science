// Baseline-vs-after tally for the question-coverage class.
//
// Baseline is the gate as it stood before this change (HEAD's
// clinicalEvidenceQuality.mjs, copied in beside the real one so its
// clinical-safety-rules.json import still resolves). "After" is the new gate.
//
// Two arms, counted separately as the acceptance criterion requires:
//   missing  — the ledger is absent, which is every delivered package, since
//              none of them were written when the deliverable existed;
//   present  — the synthesized honest ledger is supplied, which is the arm the
//              content checks are measured on.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateClinicalEvidencePackage, clinicalEvidencePackageErrorCode } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/clinicalEvidenceQuality.mjs";
import { validateClinicalEvidencePackage as validateBaseline } from "/home/coder/workspace/EviMedScience/OpenScience/apps/server/src/baselineClinicalEvidenceQuality.mjs";

const root = "/home/coder/workspace/EviMedScience/uploads/20260813-final";
const dirs = readdirSync(root).filter((name) => (
  /^RQ-\d+_/.test(name) && existsSync(path.join(root, name, "clinical-evidence-report.md"))
)).sort();
const read = (dir, name) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : "");

function inputs(name, withLedger) {
  const dir = path.join(root, name);
  const reportText = read(dir, "clinical-evidence-report.md");
  let matrix = null;
  let runReceipt = null;
  try { matrix = JSON.parse(read(dir, "clinical-evidence-matrix.json")); } catch { matrix = null; }
  try { runReceipt = JSON.parse(read(dir, "clinical-evidence-run.json")); } catch { runReceipt = null; }
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
  return {
    reportText,
    matrix,
    runReceipt,
    sourceArtifacts,
    executedSearchQueries: queries,
    searchLogText,
    referencesText: read(dir, "references.bib"),
    citationLedgerText: read(dir, "citation-ledger.csv"),
    citationAuditText: read(dir, "citation-audit.md"),
    questionCoverageText: withLedger ? read(path.join(root, "audit", "coverage"), `${name}.question-coverage.json`) : "",
  };
}

const report = { packages: dirs.length, missingArm: [], added: 0, removed: 0, blocked: [], cleanToBlocked: [], detail: [] };
for (const name of dirs) {
  const base = validateBaseline(inputs(name, true));
  const withLedger = validateClinicalEvidencePackage(inputs(name, true));
  const withoutLedger = validateClinicalEvidencePackage(inputs(name, false));
  const baseSet = new Set(base.blockingIssues);
  const added = withLedger.blockingIssues.filter((issue) => !baseSet.has(issue));
  const removed = base.blockingIssues.filter((issue) => !withLedger.blockingIssues.includes(issue));
  const missing = withoutLedger.blockingIssues.filter((issue) => !baseSet.has(issue));
  if (missing.length) {
    report.missingArm.push({
      name,
      errorCode: clinicalEvidencePackageErrorCode(withoutLedger.blockingIssues),
      issue: missing[0].slice(0, 80),
    });
  }
  report.added += added.length;
  report.removed += removed.length;
  if (added.length) {
    report.blocked.push(name);
    if (!baseSet.size) report.cleanToBlocked.push(name);
    report.detail.push({ name, wasClean: !baseSet.size, errorCode: clinicalEvidencePackageErrorCode(withLedger.blockingIssues), added });
  }
}
console.log(JSON.stringify({
  packages: report.packages,
  missingArmPackages: report.missingArm.length,
  missingArmCodes: [...new Set(report.missingArm.map((entry) => entry.errorCode))],
  added: report.added,
  blockedPackages: report.blocked.length,
  cleanToBlocked: report.cleanToBlocked,
  removed: report.removed,
  detail: report.detail,
}, null, 1));
