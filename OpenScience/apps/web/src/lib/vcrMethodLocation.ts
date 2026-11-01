/** Independent calculations keep their container and exact historical method, never a seven-step study route. */
export function vcrCalculationPath(studyId: string): string { return `/app/capabilities/calculations/${encodeURIComponent(studyId)}`; }
/**
 * A view of an independent calculation's frame (资料与证据, 入排匹配, the cohort…). A calculation has one address for each, under its own
 * container: the header links used the study's address (`/app/virtual-research/:id/data`) while the view switch used this one, so the
 * same page was two addresses and the sidebar and Back knew only one of them.
 */
export function vcrCalculationViewPath(studyId: string, view: string): string { return `${vcrCalculationPath(studyId)}/${encodeURIComponent(view)}`; }
/** Where a new piece of research is started: the module's home with its form open, the one place that fills a draft for the conversation. */
export const VCR_NEW_STUDY_PATH = "/app/virtual-research?new=1";
export function vcrMethodPath(methodId: string, options: { studyId?: string; jobId?: string; modelId?: string } = {}): string {
  const query = new URLSearchParams();
  if (options.studyId) query.set("study", options.studyId);
  if (options.jobId) query.set("job", options.jobId);
  if (options.modelId) query.set("model", options.modelId);
  return `/app/capabilities/methods/${encodeURIComponent(methodId)}${query.size ? `?${query}` : ""}`;
}
