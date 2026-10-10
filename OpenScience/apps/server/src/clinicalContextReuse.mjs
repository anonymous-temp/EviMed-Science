/**
 * Whether a finished run's work may be copied out of the conversation it happened in: into account-wide memory, a learned
 * method, the graph of evidence or the shared evaluation corpus.
 *
 * Processing a clinical projection does not authorize copying it (the VCR module's rule), and the projection is not text a
 * detector could find in a transcript: the store records which conversations read one (`cloud_reads`), and a conversation that
 * did is not reusable. A deployment with no VCR store has no clinical projection to protect and every run is reusable.
 *
 * Asked for one run when it finishes, and for the selected runs of each of an account's projects when a routine is counted;
 * the second is one question per project (`clinicalContextsHeld`), where it used to be one per run. A store that cannot answer
 * throws, and the caller decides what that means: the run-finished hook reads it as "no" and says so.
 *
 * @module clinicalContextReuse
 */

/** @param {{ id?: string, sessionId?: string }} run @returns {{ sessionId?: string, runId?: string }} */
const contextOf = (run) => ({ sessionId: run.sessionId, runId: run.id });

/**
 * @param {{ store: { hasClinicalContext: (userId: string, projectId: string, contexts: { sessionId?: string, runId?: string }[]) => Promise<boolean>,
 *   clinicalContextsHeld: (userId: string, projectId: string, contexts: { sessionId?: string, runId?: string }[]) => Promise<boolean[]> } | null }} dependencies
 */
export function createClinicalReuse({ store }) {
  /** @param {{ id: string, userId: string }} project @param {{ id?: string, sessionId?: string }} run @returns {Promise<boolean>} */
  const canReuseRun = async (project, run) => !store || !await store.hasClinicalContext(project.userId, project.id, [contextOf(run)]);
  /** @param {{ id: string, userId: string }} project @param {readonly { id?: string, sessionId?: string }[]} runs @returns {Promise<boolean[]>} */
  const canReuseRuns = async (project, runs) => {
    if (!store || runs.length === 0) return runs.map(() => true);
    const held = await store.clinicalContextsHeld(project.userId, project.id, runs.map(contextOf));
    return runs.map((_run, index) => !held[index]);
  };
  return { canReuseRun, canReuseRuns };
}
