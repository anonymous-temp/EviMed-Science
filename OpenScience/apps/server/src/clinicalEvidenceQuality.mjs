/**
 * The delivery gate, re-exported.
 *
 * Hidden knowledge: there is exactly one implementation. The rules used to
 * exist twice — here and in the run-side `preflight.py` — and the two drifted
 * three times, each drift costing a finished package. The rules now live in
 * `@evimed/domain`, which the control plane and the socket both import, and
 * this module is the control plane's entry to them. It holds no logic: a rule
 * added here rather than in the domain would be invisible to the run, which is
 * the failure this file exists to make impossible.
 *
 * @module clinicalEvidenceQuality
 */

export {
  clinicalEvidencePackageErrorCode,
  citationIntegrityIssues,
  numberedReferenceNumbers,
  numberedReferenceCount,
  validateClinicalEvidencePackage,
  clinicalCheckTier,
  claimVerification,
} from "@evimed/domain/clinical-evidence";
