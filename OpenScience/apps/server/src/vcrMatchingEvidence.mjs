/** The same individual criterion projection serves both matching directions. */
const list = (/** @type {any} */ value) => Array.isArray(value) ? value : [];
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
      recheckAt: judgment.recheckAt, overrideState: judgment.overrideState, evidence };
  }));
  return { summary: assessment.summary, asOf: assessment.asOf, protocolVersionId: assessment.protocolVersionId,
    criteriaCounts: Object.fromEntries(Object.entries(assessment.counts ?? {}).filter(([key]) => ["satisfied", "not_satisfied", "unknown", "pending_recheck", "notApplicable"].includes(key))),
    evidenceGaps: assessment.evidenceGaps, judgments, evidenceCoverage: { supplied, shared, withheld: supplied - shared } };
}
