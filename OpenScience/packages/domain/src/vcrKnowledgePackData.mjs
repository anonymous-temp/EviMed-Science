/**
 * The curated disease knowledge packs that ship with the platform, each loaded
 * through the pack contract's validator (`validateKnowledgePack`, level
 * `complete`) the moment this module is imported.
 *
 * Hidden knowledge:
 *
 * - **A shipped pack that does not meet its own contract does not load.** The
 *   packs are data files beside this module (`vcr-packs/*.json`), and the
 *   control plane reads them as they are: a pack with an unsourced entry, a
 *   restricted source or a rule outside the grammar would reach every study's
 *   runtime as fact. Failing the import is the same fail-closed stance the
 *   safety rules take (`clinical-safety-rules.json is missing or malformed`),
 *   and `test/vcrKnowledgePack.test.mjs` walks them first, so a bad edit is a
 *   red test before it is a refused start.
 * - **Adding a disease is adding a file and a line here.** Nothing else in the
 *   platform lists diseases.
 *
 * @module @evimed/domain/vcrKnowledgePackData
 */

import { validateKnowledgePack } from './vcrKnowledgePack.mjs'
import breastCancer from './vcr-packs/breast_cancer.json' with { type: 'json' }
import nsclc from './vcr-packs/nsclc.json' with { type: 'json' }

/** @type {readonly Record<string, any>[]} */
const FILES = [nsclc, breastCancer]

/** @param {Record<string, any>} value @returns {any} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Every shipped pack by id, frozen. Validated at `complete` level on import.
 * @type {Readonly<Record<string, Record<string, any>>>}
 */
export const VCR_SHIPPED_PACKS = Object.freeze(Object.fromEntries(FILES.map((pack) => {
  const issues = validateKnowledgePack(pack, { level: 'complete' })
  if (issues.length) {
    throw new Error(`The shipped knowledge pack ${JSON.stringify(pack?.id)} does not meet its contract: ${issues.slice(0, 3).map((issue) => `${issue.field} ${issue.code}`).join('; ')}`)
  }
  return [pack.id, deepFreeze(structuredClone(pack))]
})))
