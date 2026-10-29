/** Independent calculations keep their container and exact historical method, never a seven-step study route. */
export function vcrCalculationPath(studyId: string): string { return `/app/capabilities/calculations/${encodeURIComponent(studyId)}`; }
export function vcrMethodPath(methodId: string, options: { studyId?: string; jobId?: string; modelId?: string } = {}): string {
  const query = new URLSearchParams();
  if (options.studyId) query.set("study", options.studyId);
  if (options.jobId) query.set("job", options.jobId);
  if (options.modelId) query.set("model", options.modelId);
  return `/app/capabilities/methods/${encodeURIComponent(methodId)}${query.size ? `?${query}` : ""}`;
}
