/** Newest assessment per subject. Unknown and deferred evidence remain candidates for research re-evaluation. */
/** @param {{ studyId: string, assessments: readonly any[], includeInsufficient?: boolean }} input */
export function matchingCandidates({ studyId, assessments, includeInsufficient = true }) {
  /** @type {Map<string, any>} */
  const newest = new Map();
  for (const assessment of assessments ?? []) {
    const key = String(assessment?.subjectKey ?? "");
    if (!key) continue;
    const held = newest.get(key);
    const at = Date.parse(String(assessment?.asOf ?? "")) || 0;
    const heldAt = held ? Date.parse(String(held.asOf ?? "")) || 0 : -1;
    const created = Date.parse(String(assessment?.createdAt ?? "")) || 0;
    const heldCreated = held ? Date.parse(String(held.createdAt ?? "")) || 0 : -1;
    if (!held || at > heldAt || (at === heldAt && created > heldCreated)) newest.set(key, assessment);
  }
  return [...newest.values()]
    .filter((assessment) => assessment?.summary === "eligible"
      || assessment?.summary === "pending"
      || (includeInsufficient && assessment?.summary === "insufficient_evidence"))
    .map((assessment) => ({
      studyId,
      subjectKey: assessment.subjectKey,
      assessmentId: assessment.id ?? null,
      eligibilitySummary: assessment.summary,
    }));
}
