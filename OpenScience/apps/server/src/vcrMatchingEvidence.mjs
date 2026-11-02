import { VCR_MATCHING_GAP_REASON_LABELS_ZH } from "@evimed/domain";

/** The same individual criterion projection serves both matching directions. */
const list = (/** @type {any} */ value) => Array.isArray(value) ? value : [];

/**
 * Why a criterion is not decided, in the assessment's own words: the reasons of the gaps that name it (the assessment keeps its gaps by
 * the variable that is missing, each with the criteria it came from). A criterion that is decided has none.
 * @param {any} judgment @param {readonly any[]} gaps
 */
function missingOf(judgment, gaps) {
  if (judgment.state !== "unknown" && judgment.state !== "pending_recheck") return [];
  const labels = /** @type {Record<string, string>} */ (VCR_MATCHING_GAP_REASON_LABELS_ZH);
  return gaps.filter((gap) => list(gap?.criterionIds).map(String).includes(String(judgment.criterionId)))
    .map((gap) => ({ variable: String(gap.variable ?? ""), reason: String(gap.reason ?? "not_recorded"), label: labels[String(gap.reason)] ?? null }));
}
/** @param {{documents:any,study:any,assessment:any,subjectKey:string,viewer?:any}} input */
export async function matchingAssessmentEvidence({ documents, study, assessment, subjectKey, viewer = null }) {
  if (!assessment) return null;
  let supplied = 0, shared = 0;
  const judgments = await Promise.all(list(assessment.judgments).map(async judgment => {
    const original = list(judgment.evidence);
    supplied += original.length;
    const evidence = documents ? (viewer ? await documents.viewEvidence(study, original, subjectKey, viewer)
      : await documents.runtimeEvidence(study, original, subjectKey)) : [];
    shared += evidence.length;
    return { criterionId: judgment.criterionId, state: judgment.state, applicable: judgment.applicable, decidedBy: judgment.decidedBy,
      recheckAt: judgment.recheckAt, overrideState: judgment.overrideState, evidence, missing: missingOf(judgment, list(assessment.evidenceGaps)) };
  }));
  return { summary: assessment.summary, asOf: assessment.asOf, protocolVersionId: assessment.protocolVersionId,
    criteriaCounts: Object.fromEntries(Object.entries(assessment.counts ?? {}).filter(([key]) => ["satisfied", "not_satisfied", "unknown", "pending_recheck", "notApplicable"].includes(key))),
    evidenceGaps: assessment.evidenceGaps, judgments, evidenceCoverage: { supplied, shared, withheld: supplied - shared } };
}
