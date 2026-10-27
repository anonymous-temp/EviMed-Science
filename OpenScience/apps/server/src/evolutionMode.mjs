import { createEvolution } from './evolutionComposition.mjs';
import { createEvolutionServing } from './evolutionServing.mjs';

/**
 * Which evolution the control plane composes: the one decision `OPEN_SCIENCE_EVOLUTION_SERVING_ONLY` makes.
 * Off (the default) is the full composition with the arguments it has always been given, the search pause its own lever. On is the
 * serving composition, the one cutover of queued experimental work (`config.mjs`). Either returns the flat names the control plane
 * reads: the full composition keeps its loops under `loops`, and the names serving exposes directly are aliased over it.
 * @param {any} dependencies the union of what either composition takes; each reads its own
 * @param {{createFull?: typeof createEvolution, createServing?: typeof createEvolutionServing}} [compositions] replaceable by tests
 */
export function composeEvolution(dependencies, { createFull = createEvolution, createServing = createEvolutionServing } = {}) {
  if (dependencies.config.evolutionServingOnly === true) return createServing(dependencies);
  const full = createFull(dependencies);
  if (!full) return null;
  const { signals, policyBasis, observe, recordResumedResearchCompleted } = full.loops;
  return { ...full, signals, policyBasis, observe, recordResumedResearchCompleted };
}
