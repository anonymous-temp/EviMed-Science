/** Pure selection policy. Scores use the declared full scale, never an implicit percentage. */
export const EVOLUTION_SELECTION_OUTCOMES = Object.freeze(['improved', 'cheaper', 'simplified', 'scoped', 'insufficient-evidence', 'regressed', 'invalid-evidence', 'impossible', 'waiting-resource'])
/** @param {number} round @param {number} [rounds] */
export function evolutionMechanismLimit(round, rounds = 10) {
  if (!Number.isInteger(round) || !Number.isInteger(rounds) || round < 1 || rounds < 1 || round > rounds) throw new RangeError('Invalid development round.')
  return round <= Math.ceil(rounds / 3) ? 3 : round <= Math.ceil(2 * rounds / 3) ? 2 : 1
}
/** Three contemporaneous baseline vectors on the same grouped cases. @param {number[][]} runs @param {number} [fullScale] */
export function evolutionNoiseBand(runs, fullScale = 1) {
  if (!(fullScale > 0) || runs.length !== 3 || !runs[0]?.length || runs.some(run => run.length !== runs[0].length || run.some(value => !Number.isFinite(value)))) throw new RangeError('Three complete baseline runs are required.')
  const differences = []
  for (let left = 0; left < 3; left++) for (let right = left + 1; right < 3; right++) for (let index = 0; index < runs[0].length; index++) differences.push(runs[left][index] - runs[right][index])
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length
  const variance = differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (differences.length - 1)
  return Math.max(fullScale * 0.02, 2 * Math.sqrt(variance))
}
/** @param {any} proposal */
export function evolutionProposalIssues(proposal) {
  const issues = []
  if (!Array.isArray(proposal.components) || proposal.components.length !== 1 || new Set(proposal.components).size !== 1) issues.push('one-component-required')
  if (!Array.isArray(proposal.mechanisms) || !proposal.mechanisms.length || new Set(proposal.mechanisms).size !== proposal.mechanisms.length || proposal.mechanisms.length > evolutionMechanismLimit(proposal.round ?? 1, proposal.rounds ?? 10)) issues.push('mechanism-limit')
  for (const key of ['change', 'reason', 'rollbackVersion']) if (typeof proposal[key] !== 'string' || !proposal[key].trim()) issues.push(`${key}-required`)
  if (Array.from(`${proposal.change ?? ''} ${proposal.reason ?? ''}`).length > 200) issues.push('description-too-long')
  if (!Array.isArray(proposal.predictedBenefits) || !Array.isArray(proposal.possibleHarms) || !Number.isFinite(proposal.costChange)) issues.push('prediction-required')
  if (proposal.opportunityKind === 'repair' && proposal.failureReproduced !== true) issues.push('reproducible-failure-required')
  return issues
}
/** Promotion and parent selection deliberately have separate contracts. @param {any} evidence */
export function selectEvolutionCandidate(evidence) {
  /** @param {string} outcome @param {string} reason @param {boolean} [promote] */
  const verdict = (outcome, reason, promote = false) => ({ outcome, reason, promote, scope: promote ? evidence.scope ?? null : null })
  if (evidence.impossible) return verdict('impossible', 'faithful-implementation-impossible')
  if (evidence.resourcePending) return verdict('waiting-resource', 'confirmation-resources-pending')
  if (evidence.leaked || evidence.receiptValid !== true) return verdict('invalid-evidence', 'evidence-integrity')
  if (evidence.confirmatory !== true || evidence.firstAttempt !== true) return verdict('insufficient-evidence', 'fresh-first-attempt-required')
  if (!['exact','published','checklist','model'].includes(evidence.evidenceTier)) return verdict('invalid-evidence','unknown-evidence-tier')
  if (evidence.evidenceTier === 'model' && !(evidence.anchorCalibrated && evidence.deterministicChecksPassed && evidence.modelScoredLabel)) return verdict('invalid-evidence', 'model-score-not-calibrated')
  if (evidence.tool === true) {
    if (!(evidence.hiddenCases >= 2 && evidence.hiddenPassed === evidence.hiddenCases && evidence.crossImplementationPassed !== false)) return verdict('regressed', 'absolute-reference-failed')
    return verdict(evidence.scope ? 'scoped' : 'improved', 'absolute-reference-passed', true)
  }
  const { baseline, score, historicalBest, delta, fullScale = 1, baselineCost, cost } = evidence
  if (![baseline, score, historicalBest, delta, fullScale, baselineCost, cost].every(Number.isFinite) || delta < 0 || fullScale <= 0 || baselineCost < 0 || cost < 0) return verdict('insufficient-evidence', 'measurements-incomplete')
  if (score < historicalBest - delta || score < baseline - delta) return verdict('regressed', 'historical-floor')
  const gain = score - baseline
  if (gain > delta && cost <= baselineCost * (1.1 + 10 * gain / fullScale) + 1e-12) return verdict(evidence.scope ? 'scoped' : 'improved', 'gain-exceeds-noise-and-cost', true)
  if (Math.abs(gain) <= delta) {
    if (evidence.removedMechanisms >= 1 && cost <= baselineCost) return verdict('simplified', 'removal-without-regression', true)
    if ((baselineCost > 0 && cost <= baselineCost * 0.9) || (evidence.baselineContext > 0 && evidence.context <= evidence.baselineContext * 0.9)) return verdict('cheaper', 'ten-percent-saving', true)
  }
  return verdict('insufficient-evidence', 'no-regularized-improvement')
}
/** @param {any[]} versions */
export function selectEvolutionParent(versions) {
  return [...versions].sort((left, right) => (right.promotedDescendants ?? 0) / Math.max(1, right.evaluatedDescendants ?? 0) - (left.promotedDescendants ?? 0) / Math.max(1, left.evaluatedDescendants ?? 0) || String(left.id).localeCompare(String(right.id)))[0] ?? null
}
/** @param {any[]} contributions */
export function evolutionPruningCandidates(contributions) {
  return contributions.filter(item => !item.uniqueCoverage && item.roundGains?.length >= 4 && item.roundGains.slice(-4).every(/** @param {number} gain */ gain => gain <= 0))
}
