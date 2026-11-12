import { VCR_MATCHING_GAP_REASON_LABELS_ZH } from "@evimed/domain";

/** The same individual criterion projection serves both matching directions. */
const list = (/** @type {any} */ value) => Array.isArray(value) ? value : [];
const labels = /** @type {Record<string, string>} */ (VCR_MATCHING_GAP_REASON_LABELS_ZH);

/** @param {readonly any[]} gaps */
const labelled = gaps => gaps.map(gap => ({
  variable: String(gap.variable ?? ""), reason: String(gap.reason ?? "not_recorded"), label: labels[String(gap.reason)] ?? null,
}));

/**
 * Why a criterion is not decided, in the assessment's own words: the reasons of the gaps that name it (the assessment keeps its gaps by
 * the variable that is missing, each with the criteria it came from). Historical rows only carry assessment-level gaps.
 * @param {any} judgment @param {readonly any[]} gaps
 */
function missingOf(judgment, gaps) {
  if (Array.isArray(judgment.missing)) return labelled(judgment.missing);
  if (judgment.state !== "unknown" && judgment.state !== "pending_recheck") return [];
  return labelled(gaps.filter(gap => list(gap?.criterionIds).map(String).includes(String(judgment.criterionId))));
}
/** @param {{documents:any,study:any,assessment:any,subjectKey:string,viewer?:any}} input */
export async function matchingAssessmentEvidence({ documents, study, assessment, subjectKey, viewer = null }) {
  if (!assessment) return null;
  let supplied = 0, shared = 0;
  const judgments = await Promise.all(list(assessment.judgments).map(async judgment => {
    const original = [...list(judgment.evidence),
      ...list(judgment.applicabilityEvidence).map(item => ({ ...item, evaluationAxis: "applicability" }))];
    supplied += original.length;
    const evidence = documents ? (viewer ? await documents.viewEvidence(study, original, subjectKey, viewer)
      : await documents.runtimeEvidence(study, original, subjectKey)) : [];
    shared += evidence.length;
    return { criterionId: judgment.criterionId, state: judgment.state, applicable: judgment.applicable, decidedBy: judgment.decidedBy,
      recheckAt: judgment.recheckAt, overrideState: judgment.overrideState,
      evidence: evidence.filter(item => item.evaluationAxis !== "applicability"),
      missing: missingOf(judgment, list(assessment.evidenceGaps)),
      ...(judgment.applicabilityState == null ? {} : {
        applicabilityState: judgment.applicabilityState, requirementState: judgment.requirementState,
        applicabilityEvidence: evidence.filter(item => item.evaluationAxis === "applicability").map(({ evaluationAxis: _axis, ...item }) => item),
        applicabilityMissing: labelled(list(judgment.applicabilityMissing)), applicabilityRecheckAt: judgment.applicabilityRecheckAt,
        requirementMissing: labelled(list(judgment.requirementMissing)),
      }),
    };
  }));
  return { summary: assessment.summary, asOf: assessment.asOf, protocolVersionId: assessment.protocolVersionId,
    ...(assessment.provenance?.matchingEvaluatorVersion ? { matchingEvaluatorVersion: assessment.provenance.matchingEvaluatorVersion } : {}),
    criteriaCounts: Object.fromEntries(Object.entries(assessment.counts ?? {}).filter(([key]) => ["satisfied", "not_satisfied", "unknown", "pending_recheck", "notApplicable"].includes(key))),
    evidenceGaps: assessment.evidenceGaps, judgments, evidenceCoverage: { supplied, shared, withheld: supplied - shared } };
}
