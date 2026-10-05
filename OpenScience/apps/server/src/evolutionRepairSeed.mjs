import { readEvolutionArtifact, hydrateCandidateFiles } from './evolutionRuns.mjs';
import { HttpError } from './security.mjs';
/** Read a repair parent only through its certified immutable revision, then apply builder isolation.
 * @param {{service:any,supply:any,isolation:any}} dependencies @param {any} card @param {any} identity */
export async function evolutionRepairSeed({ service, supply, isolation }, card, identity) {
  if (!card.repairOf?.toolId) return null;
  const parent = await service.get(card.repairOf.toolId);
  if (!parent || parent.payload.artifactDigest !== card.repairOf.artifactDigest || !card.parentToolIds?.includes(parent.id)) throw new HttpError(409, 'evolution_version_immutable', 'The preserved repair parent changed.');
  const frozen = await supply.candidateForEvaluation({ id: parent.id, digest: parent.payload.artifactDigest, revision: parent.payload.revision });
  return isolation.filter(identity, 'previous-development-candidate', { files: frozen.files, entrypoint: frozen.entrypoint, dependencies: frozen.dependencies, parent: { id: parent.id, digest: frozen.digest, revision: frozen.revision } });
}

/** Invalid generated files are public repair feedback, not a seed for another attempt.
 * Resource, preservation and unexpected failures remain visible to the worker.
 * @param {any} input */
export async function readEvolutionPreviousCandidate({project,run,isolation,identity,limit}) {
  try {
    const output = await readEvolutionArtifact(project,run,'tool-candidate.json',limit);
    const previous = await hydrateCandidateFiles(project,run,output,limit);
    return await isolation.filter(identity,'previous-development-candidate',{files:previous.files,entrypoint:previous.entrypoint});
  } catch(error) {
    if(error?.code === 'evolution_output_invalid' && [400,413,422].includes(error?.status ?? error?.statusCode)) return null;
    throw error;
  }
}
