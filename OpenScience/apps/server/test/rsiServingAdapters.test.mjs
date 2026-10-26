import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs'
import { ProductDocuments } from '../src/productStore.mjs'
import { createRsiServingAdapters, parseRsiPolicyCandidate } from '../src/rsiServingAdapters.mjs'
import { frontierMixSelect } from '@evimed/domain'

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? ''
if (url) { const target = new URL(url); assert.ok(['localhost', '127.0.0.1', '::1'].includes(target.hostname)); assert.match(target.pathname, /evimed_test/) }
const files = [{ path: 'policy.json', content: '{"selectionThreshold":80}' }]

test('campaign component rejects sibling fields, guardrails, missing component, and executable files', () => {
  assert.deepEqual(parseRsiPolicyCandidate('frontier-selection', files), { selectionThreshold: 80 })
  for (const candidate of [[], [{ path: 'policy.json', content: '{}' }], [{ path: 'policy.json', content: '{"screenInstructions":"override"}' }],
    [{ path: 'policy.json', content: '{"selectionThreshold":80,"guardrails":false}' }], [...files, { path: 'script.mjs', content: 'throw 1' }]]) {
    assert.throws(() => parseRsiPolicyCandidate('frontier-selection', candidate), { code: 'campaign_policy_shape_invalid' })
  }
})

test('real ledger inactive stage, restart inspection, scope activation, frozen shadow projection and exact rollback', { skip: !url }, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 5, databaseConnectionTimeoutMs: 2000 })
  const owner = `rsi_adapter_${randomUUID().replaceAll('-', '')}`
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI adapter test','development')", [owner])
    const documents = new ProductDocuments(database)
    const dependencies = { config: { frontierModel: 'deepseek-flash', frontierSelectThreshold: 65 }, service: { owner: async () => owner }, database, documents }
    const serving = createRsiServingAdapters(dependencies)
    const target = await serving.currentTarget('frontier-selection')
    assert.equal(target.qualified, true, target.issues?.join(','))
    const input = { operationId: 'adapter-test', surface: 'frontier-selection', phase: 'stage', files, expectedTarget: target }
    const stage = await serving.adapters.policy.publish(input)
    assert.equal(stage.installed, true)
    assert.equal((await serving.currentTarget(input.surface)).baselineRevision, target.baselineRevision)
    assert.equal((await serving.readPolicy('frontier')).policy.selectionThreshold, 65)
    const restarted = createRsiServingAdapters(dependencies)
    assert.deepEqual(await restarted.adapters.policy.inspect(input), stage)
    await assert.rejects(() => restarted.adapters.policy.publish({ ...input, files: [{ path: 'policy.json', content: '{"selectionThreshold":81}' }] }), { code: 'campaign_publication_identity_conflict' })
    const activated = await restarted.adapters.policy.publish({ ...input, files: undefined, phase: 'activate', revision: stage.revision })
    assert.equal(activated.phase, 'activate')
    restarted.connectImporter({ select: async () => ({ revision: stage.revision, arm: 'candidate', operationId: input.operationId }) })
    assert.equal((await restarted.readPolicy('frontier', { userId: owner, projectId: 'project' })).policy.selectionThreshold, 80)
    restarted.connectImporter({ select: async () => ({ revision: target.baselineRevision, shadowRevision: stage.revision, arm: 'control', operationId: input.operationId }) })
    let witness
    restarted.setObservationReporter(value => { witness = value })
    const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, genre: 'news', zh: false, score: i < 6 ? 70 : 90, selected: false, rule: null, safety: false, sourceId: `s${i}`, sourceCap: 3, eligible: true, summarized: true, besideSelected: false, eventId: null }))
    const selectionInput = { candidates, threshold: 65, events: {}, congressActive: false, preprintPlaces: 2, preprintMinScore: 60, genreFloors: [] }
    assert.deepEqual(await restarted.evaluateFrontierSelection(selectionInput, { executionId: 'mix-1', now: '2026-10-26' }), frontierMixSelect(selectionInput))
    assert.equal(witness.arm, 'shadow')
    assert.ok(witness.incumbentPicks > witness.candidatePicks)
    assert.notEqual(witness.incumbentResultDigest, witness.candidateResultDigest)
    assert.equal((await restarted.verifyObservation({ id: witness.id }, { operationId: input.operationId })).inputHash, witness.inputHash)
    assert.equal(await restarted.verifyObservation({ id: 'model-assertion' }, { operationId: input.operationId }), null)
    const rollback = await restarted.adapters.policy.rollback({ operationId: 'adapter-test-rollback', surface: input.surface, revision: target.baselineRevision, expectedRevision: stage.revision, dependencyDigest: target.dependencyDigest })
    assert.equal(rollback.revision, target.baselineRevision)
    restarted.connectImporter({ select: async () => ({ revision: stage.revision, arm: 'candidate', operationId: input.operationId }) })
    assert.equal((await restarted.readPolicy('frontier')).policy.selectionThreshold, 65)
    assert.equal((await restarted.currentTarget(input.surface)).baselineRevision, target.baselineRevision)
    assert.equal((await restarted.currentTarget('capability-skill')).qualified, false)
    await assert.rejects(() => restarted.adapters.skill.publish({}), { code: 'campaign_runtime_scope_unsupported' })
  } finally {
    await database.query('DELETE FROM evimed_control.users WHERE id=$1', [owner])
    await database.close()
  }
})
