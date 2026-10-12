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
/** The longest `change` and `reason` of a proposal may be together, in characters (code points; Chinese and English alike), counted as `change + ' ' + reason`.
 * The plan asks for a change that can be told in a short description (2026-10-06 plan, section 7): a short account is one another agent can reproduce. The proposer is
 * asked for a budget per field, well inside the whole, because a model does not count its own characters. */
export const EVOLUTION_PROPOSAL_DESCRIPTION_LIMIT = 200
/** What each field is asked to stay inside: `change` 100, `reason` 90, so a proposer that overshoots a little is still inside the whole. */
export const EVOLUTION_PROPOSAL_FIELD_BUDGET = Object.freeze({ change: 100, reason: 90 })
/** @param {any} proposal */
export function evolutionProposalDescriptionLength(proposal) {
  return Array.from(`${proposal?.change ?? ''} ${proposal?.reason ?? ''}`).length
}
/** @param {string} text @param {number} limit */
function clipDescription(text, limit) {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  const head = chars.slice(0, limit - 1)
  // Back to the last whole sentence when one ends in the second half of what fits; the closing marks are the only language knowledge used.
  const stop = head.findLastIndex((char) => '。！？.!?；;'.includes(char))
  return (stop >= Math.floor(head.length / 2) ? head.slice(0, stop + 1) : [...head, '…']).join('')
}
/**
 * The proposal as the contract reads it: the parts of its form a proposer cannot be asked to get exactly right are put right by code, and nothing it says changes.
 * Live (2026-10-07 to 12) 6 of 15 rejected proposals were refused for `description-too-long` alone, five attempts in a row for one mission: the repair prompt
 * gave neither the limit nor the length, a model cannot count characters, and a refusal costs a whole proposal round. So an account over the limit is shortened
 * here (each field to its share, at a sentence end where one fits) and says so (`descriptionShortened`), the lists and the cost figure are read in their plain
 * forms (a single string for a list of one, a numeric string for a number), and the proposer's text is otherwise left alone. What the contract still refuses is
 * what only the proposer can supply: the component, the mechanisms, the prediction itself.
 * @param {any} proposal
 */
export function evolutionNormalizeProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal
  const next = { ...proposal }
  for (const key of ['change', 'reason', 'rollbackVersion']) if (typeof next[key] === 'string') next[key] = next[key].trim()
  for (const key of ['predictedBenefits', 'possibleHarms']) if (typeof next[key] === 'string' && next[key].trim()) next[key] = [next[key].trim()]
  if (typeof next.costChange === 'string' && next.costChange.trim() !== '' && Number.isFinite(Number(next.costChange))) next.costChange = Number(next.costChange)
  if (typeof next.change === 'string' && typeof next.reason === 'string' && evolutionProposalDescriptionLength(next) > EVOLUTION_PROPOSAL_DESCRIPTION_LIMIT) {
    const from = evolutionProposalDescriptionLength(next)
    // `reason` keeps what `change` leaves of the whole (at least its own budget when `change` is short), and `change` is cut to its budget only when it alone overflows.
    const changeLength = Array.from(next.change).length, reasonLength = Array.from(next.reason).length
    const changeRoom = Math.min(changeLength, Math.max(EVOLUTION_PROPOSAL_FIELD_BUDGET.change, EVOLUTION_PROPOSAL_DESCRIPTION_LIMIT - 1 - reasonLength))
    next.change = clipDescription(next.change, changeRoom)
    next.reason = clipDescription(next.reason, EVOLUTION_PROPOSAL_DESCRIPTION_LIMIT - 1 - Array.from(next.change).length)
    next.descriptionShortened = { fromCharacters: from, limit: EVOLUTION_PROPOSAL_DESCRIPTION_LIMIT }
  }
  return next
}
/** @param {any} proposal */
export function evolutionProposalIssues(proposal) {
  const issues = []
  if (!Array.isArray(proposal.components) || proposal.components.length !== 1 || new Set(proposal.components).size !== 1) issues.push('one-component-required')
  if (!Array.isArray(proposal.mechanisms) || !proposal.mechanisms.length || new Set(proposal.mechanisms).size !== proposal.mechanisms.length || proposal.mechanisms.length > evolutionMechanismLimit(proposal.round ?? 1, proposal.rounds ?? 10)) issues.push('mechanism-limit')
  for (const key of ['change', 'reason', 'rollbackVersion']) if (typeof proposal[key] !== 'string' || !proposal[key].trim()) issues.push(`${key}-required`)
  if (evolutionProposalDescriptionLength(proposal) > EVOLUTION_PROPOSAL_DESCRIPTION_LIMIT) issues.push('description-too-long')
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
  if (evidence.evidenceTier === 'model') {
    if (!(evidence.anchorCalibrated && evidence.modelScoredLabel)) return verdict('invalid-evidence', 'model-score-not-calibrated')
    // The deterministic checks (numbers, units, quotations) must have run on every unit and the candidate must be no worse on them than the version it
    // replaces, within the noise of that version's own repeats. Not that every unit came out perfect: the score already carries each unit's failure, and a
    // candidate that is no worse than what serves today is not made unpromotable by the units the incumbent also gets wrong.
    if (evidence.deterministicChecksPassed !== true) return evidence.deterministicChecksRegressed === true ? verdict('regressed', 'deterministic-check-regressed') : verdict('invalid-evidence', 'deterministic-checks-missing')
  }
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
