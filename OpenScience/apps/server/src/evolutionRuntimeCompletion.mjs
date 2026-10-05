import { isEvolutionProject } from './internalProjects.mjs';

/** Preserve observed end evidence while the bounded container still exists.
 * Proof failures are advisory; the existing cleanup always retains its scheduling semantics.
 * @param {any} input */
export async function completeEvolutionRuntime({ config, evolution, project, run, evaluationIsolation, runtimeManager, independentProductWork }) {
  if (!evolution || config.evolutionEnabled !== true || !isEvolutionProject(project.id)) return false;
  await evaluationIsolation.recordCitations(run.id, { artifacts: run.artifacts, reply: run.reply ?? run.summary ?? '' });
  try { await runtimeManager.captureRunEgressProof({ project, runId: run.id, phase: 'end' }); }
  catch { /* Unsupported or failed probes leave exposure unknown and cannot prevent cleanup. */ }
  independentProductWork(() => runtimeManager.endBoundedRuntime(project, run.dispatchId)).catch(() => {});
  return true;
}
