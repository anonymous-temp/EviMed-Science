import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HOST_ABI, HOST_PORT_METHODS, SCHEMA_VERSIONS, contentDigest, profileIdentity,
  createSourceProfileCache, sourceIdentity, validateReleaseManifest, assertReleaseCompatibility,
  validatePairDecision, validateCriterionMapping, validateEvidenceBundle, verifyEvidencePassage,
  validateTrialProfile, validateComputationReceipt, projectMatchingResult, validateMatchingResult,
  reportInputFromResult, pairIdentity, planReassessment, createHostClient, validateHostPorts,
  metricInputFromResults, canonicalJson,
} from '../index.mjs'

const scope = { tenantId: 'tenant-a', projectId: 'project-a', actorId: 'actor-a', conversationId: 'conversation-a' }
const source = { sourceId: 'patient-source', revision: '1', digest: contentDigest('patient evidence'), kind: 'patient' }
const profileDigest = profileIdentity({ profile: 'flash-only', revision: '1' })
const pair = { subjectKey: 'patient-a', trialId: 'trial-a' }
const task = (pairs = [pair]) => ({ schemaVersion: '1', taskId: 'task-a', direction: 'patient-to-trials', objective: 'Find appropriate trials', scope, pluginGeneration: 'generation-a', sources: [source], selectedPairs: pairs, budgets: { maxPairs: 50, maxEvidenceReads: 10, maxModelCalls: 5 } })
const decision = (overrides = {}) => ({ schemaVersion: '1', decisionId: 'decision-a', revision: '1', scope, ...pair, state: 'complete', clinicalEligibility: 'eligible', recommendation: { priority: 0.1, rationale: 'Low clinical priority' }, criteria: [{ criterionId: 'c1', kind: 'inclusion', verdict: 'satisfied', basis: 'stated', evidenceIds: ['e1'], assumptions: [], reason: 'Model assessment' }], sourceRefs: [source], profileDigest, producer: { kind: 'model', modelProfileDigest: profileDigest, executionId: 'execution-a' }, evidenceBundleId: 'evidence-a', unresolvedFacts: [], assumptions: [], ...overrides })
const project = (decisions = [decision()], extra = {}) => projectMatchingResult({ task: task(), resultId: 'result-a', revision: '1', decisions, profileDigest, ...extra })
const errorCode = (code) => (error) => error.code === code

function release() {
  const model = (provider, modelId) => ({ provider, model: modelId, revision: 'revision-a', digest: profileDigest })
  const artifact = (name) => ({ package: name, version: '0.1.0', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` })
  return { schemaVersion: '1', plugin: { id: 'patient-matching', version: '0.1.0' }, artifacts: { core: artifact('@evimed/patient-matching-core'), bundle: artifact('@evimed/dsh-patient-matching'), worker: { image: `registry.example/evimed/worker@sha256:${'a'.repeat(64)}` }, resources: [] }, host: { abi: HOST_ABI, ports: HOST_PORT_METHODS }, kernel: { version: '0.0.1-test.1', seamDigest: profileDigest }, schemas: SCHEMA_VERSIONS, profiles: { reasoning: { ...model('deepseek', 'deepseek-flash'), efforts: ['medium', 'high'] }, embedding: { ...model('bailian', 'qwen3.7-text-embedding'), dimensions: 1024 }, rerank: model('bailian', 'qwen3.7-text-rerank'), algorithm: { id: 'algorithm-a', version: '0.1.0', digest: profileDigest }, skill: { id: 'skill-a', version: '0.1.0', digest: profileDigest } }, resources: { trialIndex: { generation: 'index-a', embeddingProfileDigest: profileDigest, dimensions: 1024 }, knowledgeRequired: false }, verification: { receipts: [] }, upgrade: { readableSchemaVersions: ['1'], rollbackGenerations: [] } }
}

test('Flash-only closed release binds exact artifacts, host ABI and vector dimensions', () => {
  const valid = release()
  assert.equal(validateReleaseManifest(valid), valid)
  assert.equal(assertReleaseCompatibility(valid, { hostAbi: HOST_ABI, kernelVersion: valid.kernel.version, seamDigest: profileDigest }), true)
  for (const mutate of [
    (value) => { value.profiles.reasoning.model = 'deepseek-v4-pro' },
    (value) => { value.profiles.reasoning.apiKey = 'not-a-real-key' },
    (value) => { value.artifacts.bundle.version = '^0.1.0' },
    (value) => { value.artifacts.worker.image = 'worker:latest' },
    (value) => { value.resources.trialIndex.dimensions = 768 },
    (value) => { value.artifacts.worker.path = '/private/runtime' },
    (value) => { value.host.ports.ExecutionPort = [] },
  ]) {
    const invalid = structuredClone(valid)
    mutate(invalid)
    assert.throws(() => validateReleaseManifest(invalid))
  }
  assert.throws(() => assertReleaseCompatibility(valid, { hostAbi: HOST_ABI, kernelVersion: '9.0.0', seamDigest: profileDigest }), errorCode('unsupported_kernel'))
})

test('optional priority is exactly the Jev 1.14 profile and does not change clinical schema', () => {
  const value = release()
  value.profiles.priority = { provider: 'typesafe', model: 'jev-1.14.0', revision: 'pinned', digest: profileDigest }
  validateReleaseManifest(value)
  value.profiles.priority.model = 'jev-latest'
  assert.throws(() => validateReleaseManifest(value))
})

test('low recommendation remains eligible; explicit exclusion stays ineligible at favorable priority', () => {
  const other = { subjectKey: 'patient-a', trialId: 'trial-b' }
  const excluded = decision({ ...other, decisionId: 'decision-b', clinicalEligibility: 'ineligible', recommendation: { priority: 1, rationale: 'Favorable priority but contraindicated by criterion' }, criteria: [{ criterionId: 'x1', kind: 'exclusion', verdict: 'satisfied', basis: 'stated', evidenceIds: ['e1'], reason: 'Explicit exclusion', assumptions: [] }] })
  const result = project([excluded, decision()], { task: task([pair, other]) })
  assert.equal(result.rows[0].clinicalEligibility, 'eligible')
  assert.equal(result.rows[0].recommendation.priority, 0.1)
  assert.equal(result.rows[1].clinicalEligibility, 'ineligible')
  assert.equal(result.counts.eligible, 1)
  assert.equal(result.counts.ineligible, 1)
})

test('stable tie ordering, input-order option and no mutating returned artifacts', () => {
  const pairs = [pair, { ...pair, trialId: 'trial-b' }, { ...pair, trialId: 'trial-c' }]
  const decisions = pairs.map((item, index) => decision({ ...item, decisionId: `decision-${index}` }))
  const result = project(decisions, { task: task(pairs) })
  assert.deepEqual(result.finalOrder, pairs.map(pairIdentity))
  result.rows[0].recommendation.priority = 1
  assert.equal(decisions[0].recommendation.priority, 0.1)
  decisions[2].recommendation.priority = 1
  assert.deepEqual(project(decisions, { task: task(pairs) }).finalOrder, pairs.map(pairIdentity))
  assert.deepEqual(project(decisions, { task: task(pairs), ranking: { order: 'input' } }).finalOrder, pairs.map(pairIdentity))
  assert.equal(project(decisions, { task: task(pairs), ranking: { order: 'priority' } }).rows[0].trialId, 'trial-c')
  const defaultedRanking = project(decisions, { task: task(pairs), ranking: {} })
  assert.deepEqual(defaultedRanking.ranking, { order: 'input' })
  validateMatchingResult(defaultedRanking)
})

test('every roster member is accounted for; pending/failed/unsupported are never complete', () => {
  const pairs = [pair, { ...pair, subjectKey: 'patient-b' }, { ...pair, subjectKey: 'patient-c' }, { ...pair, subjectKey: 'patient-d' }]
  const result = project([
    decision(),
    decision({ ...pairs[1], decisionId: 'failed-a', state: 'failed', clinicalEligibility: 'not-assessed' }),
    decision({ ...pairs[2], decisionId: 'unsupported-a', state: 'unsupported', clinicalEligibility: 'not-assessed' }),
  ], { task: task(pairs) })
  assert.equal(result.state, 'partial')
  assert.deepEqual([result.counts.complete, result.counts.pending, result.counts.failed, result.counts.unsupported], [1, 1, 1, 1])
  assert.equal(project([]).state, 'pending')
  assert.throws(() => validatePairDecision(decision({ state: 'pending' })))
  const tampered = structuredClone(result)
  tampered.state = 'complete'
  assert.throws(() => validateMatchingResult(tampered))
})

test('source revision/hash/removal and profile change preserve old labels with explicit stale state', () => {
  for (const extra of [
    { currentSources: [{ ...source, revision: '2' }] },
    { currentSources: [{ ...source, digest: contentDigest('changed') }] },
    { currentSources: [] },
    { profileDigest: contentDigest('new-profile') },
    { currentSources: [source, { ...source, sourceId: 'new-lab' }] },
  ]) {
    const result = project([decision()], extra)
    assert.equal(result.state, 'stale')
    assert.equal(result.counts.eligible, 0)
    assert.equal(result.rows[0].clinicalEligibility, 'eligible')
    assert.equal(result.rows[0].current, false)
  }
})

test('known new-source ownership isolates affected pairs; unknown ownership is conservative', () => {
  const other = { ...pair, subjectKey: 'patient-b' }
  const input = { task: task([pair, other]), currentSources: [source, { ...source, sourceId: 'new-lab' }] }
  const decisions = [decision(), decision({ ...other, decisionId: 'decision-b' })]
  const exact = project(decisions, { ...input, affectedPairs: [pair] })
  assert.equal(exact.invalidationPrecision, 'exact')
  assert.equal(exact.rows.find((row) => row.subjectKey === 'patient-b').current, true)
  validateMatchingResult(exact)
  const conservative = project(decisions, input)
  assert.equal(conservative.invalidationPrecision, 'conservative')
  assert.equal(conservative.counts.stale, 2)
  validateMatchingResult(conservative)
})

test('saved readers derive added-source staleness from frozen sources and precise ownership', () => {
  const other = { ...pair, subjectKey: 'patient-b' }
  const newLab = { ...source, sourceId: 'new-lab', revision: '2' }
  const pairs = [pair, other]
  const decisions = [decision(), decision({ ...other, decisionId: 'decision-b' })]
  for (const ownership of [{}, { affectedPairs: [pair] }]) {
    const saved = project(decisions, { task: task(pairs), currentSources: [source, newLab], ...ownership })
    assert.deepEqual(saved.frozenSources, [source])
    assert.deepEqual(saved.affectedPairs, ownership.affectedPairs ?? null)
    validateMatchingResult(saved)
    const corrupted = structuredClone(saved)
    for (const row of corrupted.rows) Object.assign(row, { staleReasons: [], state: 'complete', current: true })
    Object.assign(corrupted.counts, { complete: 2, stale: 0, eligible: 2 })
    corrupted.state = 'complete'
    corrupted.invalidationPrecision = 'exact'
    assert.throws(() => validateMatchingResult(corrupted), errorCode('source_mismatch'))
    assert.throws(() => reportInputFromResult(corrupted, scope), errorCode('source_mismatch'))
    const refreshed = decisions.map((item) => item.subjectKey === pair.subjectKey || !ownership.affectedPairs ? { ...item, sourceRefs: [source, newLab], revision: '2' } : item)
    const current = project(refreshed, { task: task(pairs), currentSources: [source, newLab], ...ownership })
    assert.equal(current.state, 'complete')
    validateMatchingResult(current)
    const missingContext = structuredClone(saved)
    delete missingContext.frozenSources
    assert.throws(() => validateMatchingResult(missingContext))
    const invalidOwnership = structuredClone(saved)
    invalidOwnership.affectedPairs = [{ ...pair, subjectKey: 'outside-task' }]
    assert.throws(() => validateMatchingResult(invalidOwnership), errorCode('invalid_id_mapping'))
  }
})

test('a refreshed decision becomes current when it binds the exact new source on the same frozen task', () => {
  const newSource = { ...source, sourceId: 'new-lab', revision: '2', digest: contentDigest('new laboratory evidence') }
  const input = { task: task(), currentSources: [source, newSource] }
  for (const ownership of [{}, { affectedPairs: [pair] }]) {
    const old = project([decision()], { ...input, ...ownership })
    assert.equal(old.state, 'stale')
    assert.deepEqual(old.rows[0].staleReasons, [{ sourceId: 'new-lab', reason: 'source-added' }])
    const refreshed = project([decision({ decisionId: 'decision-refreshed', revision: '2', sourceRefs: [source, newSource] })], { ...input, ...ownership })
    assert.equal(refreshed.taskId, old.taskId)
    assert.equal(refreshed.state, 'complete')
    assert.equal(refreshed.rows[0].current, true)
    assert.deepEqual(refreshed.rows[0].staleReasons, [])
    assert.equal(refreshed.counts.eligible, 1)
    assert.equal(refreshed.invalidationPrecision, 'exact')
    for (const mismatchedSource of [{ ...newSource, revision: '1' }, { ...newSource, digest: source.digest }]) {
      const mismatched = project([decision({ sourceRefs: [source, mismatchedSource] })], { ...input, ...ownership })
      assert.equal(mismatched.rows[0].current, false)
      assert.equal(mismatched.state, 'stale')
    }
  }
})

test('invalid patient/trial/criterion mappings and cross-scope decisions are rejected', () => {
  assert.throws(() => project([decision({ trialId: 'invented-trial' })]), errorCode('invalid_id_mapping'))
  assert.throws(() => project([decision({ scope: { ...scope, tenantId: 'tenant-b' } })]), errorCode('scope_mismatch'))
  assert.throws(() => validateCriterionMapping([{ criterionId: 'invented' }], ['c1']), errorCode('invalid_id_mapping'))
  assert.throws(() => validateCriterionMapping([{ criterionId: 'c1' }, { criterionId: 'c1' }], ['c1']), errorCode('duplicate_identity'))
  assert.throws(() => validateCriterionMapping([], ['c1']), errorCode('invalid_id_mapping'))
})

test('source/profile cache reuses unchanged context and isolates revisions, scope and output mutations', () => {
  const cache = createSourceProfileCache({ maxEntries: 2 })
  const key = { scope, sources: [source], profile: { version: '1', model: 'deepseek-flash' } }
  cache.set(key, { verdict: 'eligible', evidenceIds: ['e1'] })
  assert.equal(cache.get({ ...key, profile: { model: 'deepseek-flash', version: '1' } }).verdict, 'eligible')
  cache.get(key).evidenceIds.push('mutated')
  assert.deepEqual(cache.get(key).evidenceIds, ['e1'])
  assert.equal(cache.get({ ...key, scope: { ...scope, actorId: 'other-actor' } }), undefined)
  assert.equal(cache.get({ ...key, sources: [{ ...source, revision: '2' }] }), undefined)
  assert.equal(cache.get({ ...key, profile: { version: '2' } }), undefined)
  assert.notEqual(sourceIdentity(source), sourceIdentity({ ...source, kind: 'protocol' }))
  assert.throws(() => canonicalJson({ value: undefined }))
  assert.throws(() => canonicalJson([, 'sparse']))
})

test('evidence addressing checks exact preserved text without clinical language heuristics', () => {
  const passage = { evidenceId: 'e1', subjectKey: pair.subjectKey, source, text: 'patient evidence', span: { start: 0, end: 16 } }
  const bundle = { schemaVersion: '1', bundleId: 'evidence-a', scope, sources: [source], patientPassages: [passage], knowledgePassages: [], limitations: [] }
  validateEvidenceBundle(bundle)
  assert.equal(verifyEvidencePassage(passage, { source, sourceText: 'patient evidence' }), true)
  assert.throws(() => verifyEvidencePassage(passage, { source, sourceText: 'changed evidence' }), errorCode('source_mismatch'))
  assert.throws(() => validatePairDecision(decision({ criteria: [{ ...decision().criteria[0], evidenceIds: ['fabricated'] }] }), { evidenceBundle: bundle }), errorCode('invalid_id_mapping'))
  const anotherSubject = structuredClone(bundle)
  anotherSubject.patientPassages[0].subjectKey = 'patient-b'
  assert.throws(() => validatePairDecision(decision(), { evidenceBundle: anotherSubject }), errorCode('scope_mismatch'))
})

test('trial graph retains arm/reference identity and rejects unknown or duplicated criterion ids', () => {
  const profile = { schemaVersion: '1', scope, trialId: pair.trialId, source: { ...source, sourceId: 'protocol-source', kind: 'protocol' }, profileDigest, criteria: [{ criterionId: 'c1', kind: 'inclusion', text: 'Criterion', span: { start: 0, end: 9 } }], arms: [{ armId: 'arm-a', criterionIds: ['c1'] }], logic: { operator: 'or', children: [{ operator: 'criterion', criterionId: 'c1' }] } }
  validateTrialProfile(profile)
  validatePairDecision(decision({ sourceRefs: [source, profile.source] }), { trialProfile: profile })
  profile.logic.children[0].criterionId = 'invented'
  assert.throws(() => validateTrialProfile(profile), errorCode('invalid_id_mapping'))
})

test('completed decisions bind the supplied protocol identity so revision/removal cannot stay current', () => {
  const protocol = { sourceId: 'protocol-source', revision: '1', digest: contentDigest('protocol version one'), kind: 'protocol' }
  const profile = { schemaVersion: '1', scope, trialId: pair.trialId, source: protocol, profileDigest, criteria: [{ criterionId: 'c1', kind: 'inclusion', text: 'Criterion', span: { start: 0, end: 9 } }], arms: [] }
  const frozenTask = { ...task(), sources: [source, protocol] }
  const options = { task: frozenTask, trialProfiles: [profile] }
  assert.throws(() => project([decision()], options), errorCode('source_mismatch'))
  assert.throws(() => project([decision({ sourceRefs: [source, { ...protocol, revision: '0' }] })], options), errorCode('source_mismatch'))
  const bound = decision({ sourceRefs: [source, protocol] })
  const current = project([bound], options)
  assert.equal(current.rows[0].current, true)
  validateMatchingResult(current)
  for (const currentSources of [[source, { ...protocol, revision: '2' }], [source]]) {
    const refreshedView = project([bound], { ...options, currentSources })
    assert.equal(refreshedView.state, 'stale')
    assert.equal(refreshedView.rows[0].current, false)
    assert.equal(refreshedView.counts.eligible, 0)
    validateMatchingResult(refreshedView)
  }
})

test('completed decisions bind all sources in the supplied consumed evidence context', () => {
  const knowledge = { sourceId: 'knowledge-source', revision: '1', digest: contentDigest('knowledge'), kind: 'knowledge' }
  const bundle = { schemaVersion: '1', bundleId: 'evidence-a', scope, sources: [source, knowledge], patientPassages: [{ evidenceId: 'e1', subjectKey: pair.subjectKey, source, text: 'patient evidence', span: { start: 0, end: 16 } }], knowledgePassages: [{ evidenceId: 'knowledge-e1', source: knowledge, text: 'knowledge', span: { start: 0, end: 9 } }], limitations: [] }
  const options = { task: { ...task(), sources: [source, knowledge] }, evidenceBundles: [bundle] }
  // Knowledge was part of the consumed context, even though the criterion cites only the patient passage.
  assert.throws(() => project([decision()], options), errorCode('source_mismatch'))
  const bound = decision({ sourceRefs: [source, knowledge] })
  assert.equal(project([bound], options).rows[0].current, true)
  for (const currentSources of [[source, { ...knowledge, revision: '2' }], [source]]) {
    const result = project([bound], { ...options, currentSources })
    assert.equal(result.rows[0].current, false)
    assert.equal(result.state, 'stale')
  }
})

test('saved readers enforce decision bindings and recompute every count and aggregate work state', () => {
  const complete = project()
  const pending = project([])
  const stale = project([decision()], { currentSources: [{ ...source, revision: '2' }] })
  const failed = project([decision({ state: 'failed', clinicalEligibility: 'not-assessed' })])
  const unsupported = project([decision({ state: 'unsupported', clinicalEligibility: 'not-assessed' })])
  const pendingWithOldProfile = project([decision({ state: 'pending', clinicalEligibility: 'not-assessed' })], { profileDigest: contentDigest('updated profile') })
  for (const valid of [complete, pending, stale, failed, unsupported, pendingWithOldProfile]) validateMatchingResult(valid)
  assert.equal(pendingWithOldProfile.rows[0].state, 'pending')
  const invalids = []
  const corrupt = (base, mutate) => { const value = structuredClone(base); mutate(value); invalids.push(value) }
  corrupt(pending, (value) => {
    Object.assign(value.rows[0], { state: 'complete', current: true, clinicalEligibility: 'eligible' })
    Object.assign(value.counts, { complete: 1, pending: 0, eligible: 1 })
    value.state = 'complete'
  })
  corrupt(complete, (value) => { value.rows[0].decisionRevision = null })
  corrupt(complete, (value) => { value.rows[0].sourceRefs = [] })
  corrupt(complete, (value) => { value.rows[0].producer = null })
  corrupt(complete, (value) => { value.rows[0].profileDigest = contentDigest('different profile') })
  corrupt(complete, (value) => { value.currentSources = [{ ...source, revision: '2' }] })
  corrupt(complete, (value) => { value.state = 'arbitrary' })
  corrupt(complete, (value) => { value.state = 'pending' })
  corrupt(complete, (value) => { value.counts.pending = 1 })
  corrupt(stale, (value) => { value.rows[0].staleReasons = [] })
  corrupt(stale, (value) => { value.rows[0].sourceRefs = [] })
  const metric = { id: 'clinical-product-behavior', revision: '1', scorer: { id: 'case-accounting', version: '1', digest: profileDigest }, inputManifestDigest: profileDigest, corpusDigest: profileDigest, aggregation: 'frozen cases', mappingPolicyDigest: profileDigest }
  for (const invalid of invalids) {
    assert.throws(() => validateMatchingResult(invalid))
    assert.throws(() => reportInputFromResult(invalid, scope))
    assert.throws(() => metricInputFromResults([invalid], metric))
  }
})

test('incomplete calculations cannot report a value and completed calculations cannot hide missing operands', () => {
  const receipt = { schemaVersion: '1', scope, receiptId: 'receipt-a', calculator: { id: 'calculator-a', version: '1', digest: profileDigest }, state: 'complete', operands: [{ name: 'weight', value: 70, unit: 'kg', source, evidenceId: 'e1' }], result: { value: 70, unit: 'kg' }, missingInputs: [], exactCheck: 'verified', cacheIdentity: profileDigest }
  validateComputationReceipt(receipt)
  assert.throws(() => validateComputationReceipt({ ...receipt, state: 'pending' }))
  assert.throws(() => validateComputationReceipt({ ...receipt, missingInputs: ['age'] }))
  assert.throws(() => validateComputationReceipt({ ...receipt, result: { value: Number.NaN, unit: 'kg' } }))
})

test('dependency changes invalidate descendants only, with whole-pair fallback for incomplete coverage', () => {
  const node = (id, kind, dependsOn, extra = {}) => ({ id, kind, dependsOn, scope, dependencyCoverage: 'complete', pair, ...extra })
  const nodes = [node('source-a', 'source', [], { source }), node('calculation-a', 'computation', ['source-a']), node('criterion-a', 'criterion', ['calculation-a']), node('decision-a', 'decision', ['criterion-a']), node('report-a', 'report', ['decision-a']), node('unrelated', 'decision', [], { pair: { ...pair, subjectKey: 'other-patient' } })]
  assert.deepEqual(planReassessment({ scope, nodes, previousSources: [source], currentSources: [source] }).invalidatedNodeIds, [])
  const changed = { ...source, revision: '2' }
  const plan = planReassessment({ scope, nodes, previousSources: [source], currentSources: [changed] })
  assert.deepEqual(plan.invalidatedNodeIds, ['source-a', 'calculation-a', 'criterion-a', 'decision-a', 'report-a'])
  assert.equal(plan.precise, true)
  nodes[2].dependencyCoverage = 'partial'
  assert.equal(planReassessment({ scope, nodes, previousSources: [source], currentSources: [changed] }).precise, false)
  assert.throws(() => planReassessment({ scope, nodes: [], previousSources: [], currentSources: [source] }), errorCode('missing_dependency_scope'))
  assert.deepEqual(planReassessment({ scope, nodes: [], previousSources: [], currentSources: [source], affectedPairs: [pair] }).reassessPairs, [pair])
  nodes[0].scope = { ...scope, projectId: 'other-project' }
  assert.throws(() => planReassessment({ scope, nodes, previousSources: [source], currentSources: [changed] }), errorCode('scope_mismatch'))
})

test('host calls authorize each request with immutable scope; failure stays explicit', async () => {
  let authorizations = 0
  const host = { abi: HOST_ABI, ports: Object.fromEntries(Object.entries(HOST_PORT_METHODS).map(([name, methods]) => [name, Object.fromEntries(methods.map((method) => [method, async () => ({ status: 'unsupported', summary: 'Explicitly unsupported operation', data: null, artifacts: [] })]))])) }
  host.ports.IdentityPort.authorize = async (envelope) => { authorizations++; return { allowed: true, scope: envelope.scope } }
  host.ports.PatientDataPort.read = async (envelope) => ({ status: 'complete', summary: 'Scoped source', data: { scope: envelope.scope, source }, artifacts: [] })
  const client = createHostClient(host, scope)
  assert.equal((await client.call('PatientDataPort', 'read', { sourceId: source.sourceId })).status, 'complete')
  assert.equal((await client.call('ExecutionPort', 'assess', {})).status, 'unsupported')
  assert.equal(authorizations, 2)
  await assert.rejects(() => client.call('PatientDataPort', 'read', { scope: { ...scope, tenantId: 'other' } }), errorCode('scope_mismatch'))
  host.ports.IdentityPort.authorize = async () => ({ allowed: false })
  await assert.rejects(() => client.call('PatientDataPort', 'read'), errorCode('access_denied'))
  assert.throws(() => validateHostPorts({ ...host, abi: 'future' }), errorCode('unsupported_host_abi'))
})

test('reports and evaluator receive the exact saved clinical labels/order without official-metric reimplementation', () => {
  const result = project()
  const profile = { id: 'trec-full-corpus', revision: '2026-frozen', scorer: { id: 'official-trec-scorer', version: 'pinned', digest: profileDigest }, inputManifestDigest: profileDigest, corpusDigest: profileDigest, aggregation: 'per-year official macro', mappingPolicyDigest: profileDigest }
  const input = metricInputFromResults([result], profile)
  assert.deepEqual(input.results[0].finalOrder, result.finalOrder)
  assert.deepEqual(reportInputFromResult(result, scope).rows, input.results[0].rows)
  assert.throws(() => reportInputFromResult(result, { ...scope, actorId: 'someone-else' }), errorCode('scope_mismatch'))
})
