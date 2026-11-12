import { array, check, digest, identifier, object, oneOf, strings, text, unique } from './validation.mjs'
import { assertScope, compareSourceRefs, sourceIdentity, validateScope, validateSourceRefs } from './identity.mjs'
import { CLINICAL_ELIGIBILITY, pairIdentity, validateMatchingTask, validatePairDecision } from './contracts.mjs'

export const PROJECTION_VERSION = '1'

function countsOf(rows) {
  const counts = { requested: rows.length, complete: 0, pending: 0, failed: 0, unsupported: 0, stale: 0, eligible: 0, ineligible: 0, uncertain: 0, notAssessed: 0 }
  for (const row of rows) {
    counts[row.state]++
    if (row.current) counts[row.clinicalEligibility === 'not-assessed' ? 'notAssessed' : row.clinicalEligibility]++
  }
  return counts
}

function stateOf(counts) {
  return counts.complete === counts.requested ? 'complete'
    : counts.complete > 0 ? 'partial'
      : counts.pending > 0 ? 'pending'
        : counts.stale > 0 ? 'stale'
          : counts.failed > 0 ? 'failed' : 'unsupported'
}

function refreshReasonsFor(decision, { currentSources, frozenSources, profileDigest, affectedPairs }) {
  const reasons = compareSourceRefs(decision.sourceRefs, currentSources)
  if (decision.profileDigest !== profileDigest) reasons.push({ reason: 'profile-changed' })
  const affected = affectedPairs === null || affectedPairs.some((pair) => pairIdentity(pair) === pairIdentity(decision))
  if (affected) {
    const frozenIds = new Set(frozenSources.map((source) => source.sourceId))
    const boundSources = new Map(decision.sourceRefs.map((source) => [source.sourceId, sourceIdentity(source)]))
    for (const source of currentSources) if (!frozenIds.has(source.sourceId) && boundSources.get(source.sourceId) !== sourceIdentity(source)) {
      reasons.push({ sourceId: source.sourceId, reason: 'source-added' })
    }
  }
  return reasons
}

function invalidationPrecisionOf(rows, affectedPairs) {
  return affectedPairs === null && rows.some((row) => row.staleReasons.some((reason) => reason.reason === 'source-added')) ? 'conservative' : 'exact'
}

/** Excluded pairs sort last; all other clinical labels remain independent of recommendation. */
export function rankMatchingResults(rows, { order = 'input' } = {}) {
  oneOf(order, ['priority', 'input'], 'ranking.order')
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const group = (row) => row.current && row.state === 'complete' ? (row.clinicalEligibility === 'ineligible' ? 2 : 0) : 1
    const byGroup = group(left.row) - group(right.row)
    if (byGroup) return byGroup
    if (order === 'priority') {
      const leftPriority = left.row.recommendation?.priority ?? -1
      const rightPriority = right.row.recommendation?.priority ?? -1
      if (leftPriority !== rightPriority) return rightPriority - leftPriority
    }
    return left.index - right.index
  }).map(({ row }) => row)
}

/** One projection for readback, native replies, reports, exports and evaluator input. */
export function projectMatchingResult({ task, resultId, revision, decisions, currentSources = task.sources, profileDigest, stageOrders = {}, reportRefs = [], ranking = { order: 'input' }, trialProfiles = [], evidenceBundles = [], affectedPairs }) {
  validateMatchingTask(task)
  identifier(resultId, 'resultId')
  text(revision, 'revision')
  digest(profileDigest, 'profileDigest')
  validateSourceRefs(currentSources, 'currentSources')
  array(decisions, 'decisions')
  unique(decisions, 'decisions', pairIdentity)
  array(trialProfiles, 'trialProfiles')
  unique(trialProfiles, 'trialProfiles', (profile) => profile.trialId)
  array(evidenceBundles, 'evidenceBundles')
  unique(evidenceBundles, 'evidenceBundles', (bundle) => bundle.bundleId)
  if (affectedPairs !== undefined) {
    array(affectedPairs, 'affectedPairs', pairIdentity)
    unique(affectedPairs, 'affectedPairs', pairIdentity)
    for (const pair of affectedPairs) check(task.selectedPairs.some((selected) => pairIdentity(selected) === pairIdentity(pair)), 'affectedPairs', 'pair outside selected scope', 'invalid_id_mapping')
  }
  const refreshContext = { currentSources, frozenSources: task.sources, profileDigest, affectedPairs: affectedPairs ?? null }
  object(ranking, 'ranking', ['order'])
  const resolvedRanking = { order: ranking.order === undefined ? 'input' : ranking.order }
  const byPair = new Map()
  for (const decision of decisions) {
    const trialProfile = trialProfiles.find((profile) => profile.trialId === decision.trialId)
    const evidenceBundle = evidenceBundles.find((bundle) => bundle.bundleId === decision.evidenceBundleId)
    validatePairDecision(decision, { task, trialProfile, evidenceBundle })
    byPair.set(pairIdentity(decision), decision)
  }
  const rows = task.selectedPairs.map((pair) => {
    const decision = byPair.get(pairIdentity(pair))
    if (!decision) return {
      ...pair, decisionId: null, decisionRevision: null, state: 'pending', current: false,
      clinicalEligibility: 'not-assessed', recommendation: { priority: null, rationale: '' },
      criteria: [], sourceRefs: [], staleReasons: [], unresolvedFacts: [], assumptions: [],
      profileDigest: null, producer: null, evidenceBundleId: null,
    }
    const staleReasons = refreshReasonsFor(decision, refreshContext)
    return {
      ...pair, decisionId: decision.decisionId, decisionRevision: decision.revision,
      state: staleReasons.length && decision.state === 'complete' ? 'stale' : decision.state,
      current: staleReasons.length === 0 && decision.state === 'complete',
      clinicalEligibility: decision.clinicalEligibility,
      recommendation: decision.recommendation, criteria: decision.criteria,
      sourceRefs: decision.sourceRefs, staleReasons,
      unresolvedFacts: decision.unresolvedFacts, assumptions: decision.assumptions,
      profileDigest: decision.profileDigest, producer: decision.producer, evidenceBundleId: decision.evidenceBundleId,
    }
  })
  const ordered = rankMatchingResults(rows, resolvedRanking)
  const selected = new Set(task.selectedPairs.map(pairIdentity))
  object(stageOrders, 'stageOrders')
  for (const [stage, order] of Object.entries(stageOrders)) {
    identifier(stage, 'stageOrders.stage')
    strings(order, `stageOrders.${stage}`)
    unique(order, `stageOrders.${stage}`)
    for (const id of order) check(selected.has(id), `stageOrders.${stage}`, 'pair outside selected scope', 'invalid_id_mapping')
  }
  strings(reportRefs, 'reportRefs')
  const counts = countsOf(rows)
  const state = stateOf(counts)
  const openQuestions = openQuestionsOf(rows)
  return structuredClone({
    schemaVersion: '1', projectionVersion: PROJECTION_VERSION, resultId, revision,
    taskId: task.taskId, direction: task.direction, scope: task.scope,
    pluginGeneration: task.pluginGeneration, profileDigest, currentSources,
    frozenSources: task.sources, affectedPairs: refreshContext.affectedPairs,
    selectedPairs: task.selectedPairs, rows: ordered, finalOrder: ordered.map(pairIdentity),
    stageOrders, ranking: resolvedRanking, counts, state, reportRefs,
    invalidationPrecision: invalidationPrecisionOf(rows, refreshContext.affectedPairs),
    openQuestions,
  })
}

/**
 * The facts whose absence keeps criteria unknown, grouped across pairs so the person can be asked once for what decides the most
 * trials. Grouping is by the fact's normalised wording; the model writes each `missingFact` as a short clinical noun phrase.
 * @param {any[]} rows
 * @returns {Array<{ fact: string, pairs: number, trials: string[], subjects: string[], criteria: Array<{ trialId: string, criterionId: string }> }>}
 */
export function openQuestionsOf(rows) {
  const groups = new Map()
  const add = (fact, row, criterionId) => {
    const wording = String(fact ?? '').trim().replace(/\s+/g, ' ')
    if (!wording) return
    const key = wording.toLowerCase().replace(/[.;:,!?。；：，]+$/u, '')
    const group = groups.get(key) ?? { fact: wording, pairKeys: new Set(), trials: new Set(), subjects: new Set(), criteria: [] }
    group.pairKeys.add(pairIdentity(row)); group.trials.add(row.trialId); group.subjects.add(row.subjectKey)
    if (criterionId) group.criteria.push({ trialId: row.trialId, criterionId })
    groups.set(key, group)
  }
  for (const row of rows) {
    if (row.state !== 'complete' && row.state !== 'stale') continue
    for (const criterion of row.criteria ?? []) if (criterion.verdict === 'unknown' && criterion.missingFact) add(criterion.missingFact, row, criterion.criterionId)
  }
  return [...groups.values()]
    .map((group) => ({ fact: group.fact, pairs: group.pairKeys.size, trials: [...group.trials], subjects: [...group.subjects], criteria: group.criteria.slice(0, 50) }))
    .sort((a, b) => b.pairs - a.pairs || a.fact.localeCompare(b.fact))
    .slice(0, 12)
}

/** Read a saved artifact without rerunning clinical judgment or changing its saved order.
 * @param {any} result @param {{scope?:any}} [options]
 */
export function validateMatchingResult(result, { scope } = {}) {
  object(result, 'result')
  check(result.schemaVersion === '1' && result.projectionVersion === PROJECTION_VERSION, 'result', 'unsupported saved projection', 'unsupported_schema')
  validateScope(result.scope, 'result.scope')
  if (scope) assertScope(scope, result.scope, 'result.scope')
  identifier(result.resultId, 'result.resultId')
  text(result.revision, 'result.revision')
  identifier(result.taskId, 'result.taskId')
  identifier(result.pluginGeneration, 'result.pluginGeneration')
  oneOf(result.direction, ['patient-to-trials', 'protocol-to-patients', 'specified-pair'], 'result.direction')
  digest(result.profileDigest, 'result.profileDigest')
  validateSourceRefs(result.currentSources, 'result.currentSources')
  validateSourceRefs(result.frozenSources, 'result.frozenSources')
  object(result.ranking, 'result.ranking', ['order'])
  oneOf(result.ranking.order, ['input', 'priority'], 'result.ranking.order')
  strings(result.reportRefs, 'result.reportRefs')
  oneOf(result.invalidationPrecision, ['exact', 'conservative'], 'result.invalidationPrecision')
  array(result.selectedPairs, 'result.selectedPairs', pairIdentity)
  unique(result.selectedPairs, 'result.selectedPairs', pairIdentity)
  array(result.rows, 'result.rows', pairIdentity)
  unique(result.rows, 'result.rows', pairIdentity)
  strings(result.finalOrder, 'result.finalOrder')
  const selected = new Set(result.selectedPairs.map(pairIdentity))
  if (result.affectedPairs !== null) {
    array(result.affectedPairs, 'result.affectedPairs', pairIdentity)
    unique(result.affectedPairs, 'result.affectedPairs', pairIdentity)
    for (const pair of result.affectedPairs) check(selected.has(pairIdentity(pair)), 'result.affectedPairs', 'pair outside selected scope', 'invalid_id_mapping')
  }
  check(result.rows.length === selected.size && result.rows.every((row) => selected.has(pairIdentity(row))), 'result.rows', 'selected scope differs from saved rows', 'invalid_id_mapping')
  check(result.finalOrder.length === result.rows.length && result.finalOrder.every((id, index) => id === pairIdentity(result.rows[index])), 'result.finalOrder', 'order differs from saved projection', 'invalid_id_mapping')
  object(result.stageOrders, 'result.stageOrders')
  for (const [stage, order] of Object.entries(result.stageOrders)) {
    identifier(stage, 'result.stageOrders.stage')
    strings(order, `result.stageOrders.${stage}`)
    unique(order, `result.stageOrders.${stage}`)
    for (const id of order) check(selected.has(id), `result.stageOrders.${stage}`, 'pair outside selected scope', 'invalid_id_mapping')
  }
  for (const row of result.rows) {
    object(row, 'result.rows')
    oneOf(row.state, ['complete', 'pending', 'failed', 'unsupported', 'stale'], 'result.rows.state')
    oneOf(row.clinicalEligibility, CLINICAL_ELIGIBILITY, 'result.rows.clinicalEligibility')
    check(row.current === (row.state === 'complete'), 'result.rows.current', 'current flag differs from work state')
    array(row.staleReasons, 'result.rows.staleReasons', (reason, path) => {
      object(reason, path, ['reason', 'sourceId'])
      oneOf(reason.reason, ['source-unavailable', 'source-changed', 'source-added', 'profile-changed'], `${path}.reason`)
      if (reason.reason === 'profile-changed') check(reason.sourceId === undefined, `${path}.sourceId`, 'profile reason cannot carry source identity')
      else identifier(reason.sourceId, `${path}.sourceId`)
    })
    unique(row.staleReasons, 'result.rows.staleReasons', (reason) => JSON.stringify([reason.reason, reason.sourceId ?? null]))
    if (row.decisionId === null) {
      check(row.decisionRevision === null && row.profileDigest === null && row.producer === null && row.evidenceBundleId === null,
        'result.rows', 'unassessed pair cannot carry a partial decision identity')
      check(row.state === 'pending' && row.current === false && row.clinicalEligibility === 'not-assessed', 'result.rows', 'pair without a decision must remain pending')
      object(row.recommendation, 'result.rows.recommendation', ['priority', 'rationale'])
      check(row.recommendation.priority === null && row.recommendation.rationale === '', 'result.rows.recommendation', 'pair without a decision cannot carry recommendation')
      for (const key of ['criteria', 'sourceRefs', 'staleReasons', 'unresolvedFacts', 'assumptions']) {
        array(row[key], `result.rows.${key}`)
        check(row[key].length === 0, `result.rows.${key}`, 'pair without a decision cannot carry assessment data')
      }
      continue
    }
    // A stale row preserves a completed historical decision. Other states keep their actual work state.
    validatePairDecision({ schemaVersion: '1', scope: result.scope, decisionId: row.decisionId, revision: row.decisionRevision,
      subjectKey: row.subjectKey, trialId: row.trialId, ...(row.armId === undefined ? {} : { armId: row.armId }),
      state: row.state === 'stale' ? 'complete' : row.state, clinicalEligibility: row.clinicalEligibility, recommendation: row.recommendation,
      criteria: row.criteria, sourceRefs: row.sourceRefs, profileDigest: row.profileDigest, producer: row.producer,
      evidenceBundleId: row.evidenceBundleId, unresolvedFacts: row.unresolvedFacts, assumptions: row.assumptions })
    const expectedReasons = refreshReasonsFor(row, result)
    check(row.staleReasons.length === expectedReasons.length, 'result.rows.staleReasons', 'refresh reasons differ from frozen/current source context', 'source_mismatch')
    for (const expected of expectedReasons) check(row.staleReasons.some((reason) => reason.reason === expected.reason && reason.sourceId === expected.sourceId), 'result.rows.staleReasons', 'missing source/profile refresh reason', 'source_mismatch')
    if (row.state === 'complete') check(row.staleReasons.length === 0, 'result.rows.state', 'source/profile mismatch cannot be current', 'source_mismatch')
    if (row.state === 'stale') check(row.staleReasons.length > 0, 'result.rows.state', 'stale decision requires a source/profile refresh reason')
  }
  const counts = countsOf(result.rows)
  object(result.counts, 'result.counts', Object.keys(counts))
  for (const [key, expected] of Object.entries(counts)) check(result.counts[key] === expected, `result.counts.${key}`, 'saved count differs from projection')
  oneOf(result.state, ['complete', 'partial', 'pending', 'stale', 'failed', 'unsupported'], 'result.state')
  check(result.state === stateOf(counts), 'result.state', 'saved state differs from projection')
  check(result.invalidationPrecision === invalidationPrecisionOf(result.rows, result.affectedPairs), 'result.invalidationPrecision', 'precision differs from source ownership context')
  return result
}

export function reportInputFromResult(result, scope) {
  validateMatchingResult(result, { scope })
  return structuredClone({ resultId: result.resultId, revision: result.revision, projectionVersion: result.projectionVersion, scope: result.scope, rows: result.rows, finalOrder: result.finalOrder, counts: result.counts, state: result.state })
}
