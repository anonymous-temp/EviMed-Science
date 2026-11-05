import { array, check, digest, identifier, object, text } from './validation.mjs'
import { validateMatchingResult } from './projection.mjs'

/** Metadata only. Official scorers remain external and retain their own denominators. */
export const METRIC_PROFILES = Object.freeze(Object.fromEntries([
  ['trialgpt-judged-pair-ranking', { task: 'judged-pair-ranking', corpus: 'judged-pairs', aggregation: 'official-profile' }],
  ['trec-full-corpus', { task: 'retrieval', corpus: 'full-corpus', aggregation: 'per-year-official-profile' }],
  ['nih-target-recovery', { task: 'target-recovery', corpus: 'declared-targets', aggregation: 'official-profile' }],
  ['n2c2-official-mapping', { task: 'criterion-classification', corpus: 'official-patient-criteria', aggregation: 'official-profile' }],
  ['clinical-product-behavior', { task: 'product-behavior', corpus: 'frozen-workflow-cases', aggregation: 'declared-case-accounting' }],
].map(([id, profile]) => [id, Object.freeze({ id, ...profile })])))

export function validateMetricProfile(profile) {
  object(profile, 'metricProfile', ['id', 'revision', 'scorer', 'inputManifestDigest', 'corpusDigest', 'aggregation', 'mappingPolicyDigest'])
  check(Object.hasOwn(METRIC_PROFILES, profile.id), 'metricProfile.id', 'unknown metric profile')
  text(profile.revision, 'metricProfile.revision')
  object(profile.scorer, 'metricProfile.scorer', ['id', 'version', 'digest'])
  identifier(profile.scorer.id, 'metricProfile.scorer.id')
  text(profile.scorer.version, 'metricProfile.scorer.version')
  digest(profile.scorer.digest, 'metricProfile.scorer.digest')
  digest(profile.inputManifestDigest, 'metricProfile.inputManifestDigest')
  digest(profile.corpusDigest, 'metricProfile.corpusDigest')
  text(profile.aggregation, 'metricProfile.aggregation')
  digest(profile.mappingPolicyDigest, 'metricProfile.mappingPolicyDigest')
  return profile
}

/** Export the actual saved ordering. No judged-only condensation or rescoring occurs here. */
export function metricInputFromResults(results, profile) {
  validateMetricProfile(profile)
  array(results, 'results', validateMatchingResult)
  return structuredClone({ profile, results: results.map((result) => ({ resultId: result.resultId, revision: result.revision, projectionVersion: result.projectionVersion, scope: result.scope, finalOrder: result.finalOrder, rows: result.rows, counts: result.counts, state: result.state })) })
}
