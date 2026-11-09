/**
 * What the frozen evaluation of individual prediction lets a forecast say about itself (plan R33, 2026-11-09).
 *
 * `vcr-individual-evaluation.json` is the finding of `evals/vcr-in-silico/individual/result-20261109.json`, kept as data the runtime can read (the
 * evaluation directory is not in the image): per dataset, whether the individualized forecast beat both plain baselines (the last value carried
 * forward and the person's own straight line) with a paired 95% interval below zero for both, which is the protocol's only licence to say
 * "more accurate". A test holds the two files equal whenever the record is present.
 *
 * Hidden knowledge:
 *
 * - **The finding belongs to a method, not to the word "individualized".** The evaluation ran one method (the linear mixed model with a person's
 *   random intercept and slope updated by their own history). A provider that conditions on history by another method has not been evaluated, so its
 *   sentence is the unevaluated one; only a provider that names the evaluated method (`individualizationMethod`) reads this table.
 * - **The finding belongs to an endpoint family.** Serum bilirubin (one dataset, the primary result: it did NOT help) and CD4 count (two datasets,
 *   both helped). An endpoint the evaluation did not cover, a forecast of anything else, is `null`: the sentence says no comparison was made and
 *   never extends a finding to it. The Alzheimer model's individual posterior was checked by known-truth simulation only and carries no finding here.
 * - **A family's finding is the weakest of its datasets.** `true` only when every dataset of the family helped; one that did not makes it `false`.
 * - **Endpoint codes are matched as written.** A closed list of codes per family, lower-cased and trimmed, nothing fuzzy: a code not on the list is not
 *   covered, and the sentence says so.
 *
 * @module vcrIndividualEvaluation
 */
import evaluation from './vcr-individual-evaluation.json' with { type: 'json' }

/** The evaluated method id a provider names. */
export const VCR_INDIVIDUALIZATION_METHODS = Object.freeze(Object.keys(evaluation.methods))

/** @param {unknown} value */
const norm = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

/**
 * The endpoint family of an evaluated method that an endpoint code belongs to, or null.
 * @param {string | null | undefined} method @param {string | null | undefined} endpointCode
 * @returns {string | null}
 */
export function vcrIndividualEvaluationFamily(method, endpointCode) {
  const entry = /** @type {Record<string, any>} */ (evaluation.methods)[String(method)]
  const code = norm(endpointCode)
  if (!entry || !code) return null
  for (const [family, info] of Object.entries(/** @type {Record<string, any>} */ (entry.endpointFamilies))) {
    if (info.endpointCodes.some((/** @type {string} */ known) => norm(known) === code)) return family
  }
  return null
}

/**
 * Whether individualizing helped, for an evaluated method on an endpoint: `true`, `false`, or `null` when the evaluation did not cover this method
 * or this endpoint. Feed the result to `predictionClaimPremise` as `helped`.
 * @param {{ method?: string | null, endpointCode?: string | null }} request
 * @returns {boolean | null}
 */
export function vcrIndividualizationHelped({ method, endpointCode } = {}) {
  const family = vcrIndividualEvaluationFamily(method, endpointCode)
  if (!family) return null
  const datasets = /** @type {Record<string, any>} */ (evaluation.methods)[String(method)].endpointFamilies[family].datasets
  const found = /** @type {Record<string, { helped: boolean }>} */ (evaluation.datasets)
  return datasets.every((/** @type {string} */ name) => found[name]?.helped === true)
}

/** The evaluation's own identity, for a receipt that says which finding a sentence follows. */
export const VCR_INDIVIDUAL_EVALUATION_RECORD = Object.freeze({ plan: evaluation.plan, record: evaluation.record, sourceCommit: evaluation.sourceCommit })
