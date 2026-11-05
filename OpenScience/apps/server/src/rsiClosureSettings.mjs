import { FRONTIER_SCORE_VERSION } from './frontierEditor.mjs'

/**
 * The settings a surface's dependency closure is bound to, for the serving layer and the lab alike, so the two compute one digest. A surface's model decides what it writes;
 * selection also binds the scoring's version (`FRONTIER_SCORE_VERSION`, a hash of the rubric): the threshold is a line on that scale, and the rubric is no file of its closure.
 * @param {string} surface @param {string} [model]
 */
export function rsiClosureSettings(surface, model = 'deepseek-flash') {
  return surface === 'frontier-selection' ? { model, provider: 'deepseek', scoreVersion: FRONTIER_SCORE_VERSION } : { model, provider: 'deepseek' }
}
