/** A refused recheck is skippable only when production certifies that no completed
 * development run exists. Other contract, integrity and infrastructure failures stay fatal.
 * This helper never calls a normal build or creates a missing project.
 * @param {any} error */
export function isEvolutionRecheckWithoutCandidate(error) {
  return error?.code === 'evolution_evaluation_invalid'
    && (error.status ?? error.statusCode) === 409
    && error.message === 'Rechecking cannot dispatch new development work.';
}
/** @param {(job:any)=>Promise<any>} perform @param {any} job */
export async function recheckEvolutionAcceptanceCandidate(perform, job) {
  if (job?.kind !== 'evolution-build' || job?.payload?.action !== 'recheck-candidate' || !Number.isInteger(job.payload.attempt) || job.payload.attempt < 0) throw new Error('Acceptance recheck requires an explicit preserved candidate attempt.');
  try { return await perform(job); }
  catch (error) {
    if (!isEvolutionRecheckWithoutCandidate(error)) throw error;
    return { status: 'no-preserved-candidate', skipped: true, reasonCode: 'no-completed-development-run', productionCode: error.code };
  }
}
