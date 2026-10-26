import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs'
import { RsiCampaignImporter } from '../src/rsiCampaignImporter.mjs'
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
  const publisher = `rsi_publisher_${randomUUID().replaceAll('-', '')}`
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI adapter test','development')", [owner])
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI publication test','development')", [publisher])
    const documents = new ProductDocuments(database)
    const dependencies = { config: { frontierModel: 'deepseek-flash', frontierSelectThreshold: 65 }, service: { owner: async () => owner }, database, documents, publicationOwnerId: publisher }
    await documents.put(owner, 'knowledge', 'evolution-module-policy-frontier', { status: 'active', policy: { selectionThreshold: 65 } }, { expectedRevision: 0 })
    const serving = createRsiServingAdapters(dependencies)
    assert.equal(serving.publicationOwnerId, publisher)
    const target = await serving.currentTarget('frontier-selection')
    assert.equal(target.qualified, true, target.issues?.join(','))
    const input = { operationId: 'adapter-test', surface: 'frontier-selection', phase: 'stage', files, expectedTarget: target }
    const stage = await serving.adapters.policy.publish(input)
    assert.equal(stage.installed, true)
    const importer = new RsiCampaignImporter({ database, owner: publisher, verificationOptions: async () => ({}), currentTarget: serving.currentTarget, adapters: serving.adapters, activationPolicy: async () => ({ mode: 'shadow' }) })
    await importer.transaction(async client => {
      const contested = await database.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [`rsi-activation:${serving.publicationOwnerId}`])
      assert.equal(contested.rows[0].acquired, false)
      assert.equal((await serving.adapters.policy.inspect({ ...input, transactionClient: client })).revision, stage.revision)
      assert.equal((await serving.currentTarget(input.surface, client)).baselineRevision, target.baselineRevision)
    })
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
    assert.equal((await documents.get(publisher, 'knowledge', witness.id)).payload.arm, 'shadow')
    assert.equal(await documents.get(owner, 'knowledge', witness.id), null)
    await database.transaction(async client => {
      assert.equal((await restarted.verifyObservation({ id: witness.id }, { operationId: input.operationId }, { transactionClient: client })).revision, stage.revision)
    })
    assert.equal(witness.arm, 'shadow')
    assert.ok(witness.incumbentPicks > witness.candidatePicks)
    assert.notEqual(witness.incumbentResultDigest, witness.candidateResultDigest)
    assert.equal((await restarted.verifyObservation({ id: witness.id }, { operationId: input.operationId })).inputHash, witness.inputHash)
    assert.equal(await restarted.verifyObservation({ id: 'model-assertion' }, { operationId: input.operationId }), null)
    restarted.connectImporter({ select: async () => ({ revision: stage.revision, arm: 'candidate', stageIndex: 1, operationId: input.operationId }) })
    witness = null
    const globalResult = await restarted.evaluateFrontierSelection(selectionInput, { executionId: 'mix-global', now: '2026-10-27' })
    assert.deepEqual(globalResult, frontierMixSelect({ ...selectionInput, threshold: 80 }))
    assert.equal(witness.arm, 'candidate')
    assert.equal(witness.stageIndex, 1)
    assert.equal(witness.revision, stage.revision)
    assert.equal(witness.consumerDigest, target.dependencyDigest)
    assert.equal(witness.candidateResultDigest, (await documents.get(publisher, 'knowledge', witness.id)).payload.candidateResultDigest)
    const rollback = await restarted.adapters.policy.rollback({ operationId: 'adapter-test-rollback', surface: input.surface, revision: target.baselineRevision, expectedRevision: stage.revision, dependencyDigest: target.dependencyDigest })
    assert.equal(rollback.revision, target.baselineRevision)
    restarted.connectImporter({ select: async () => ({ revision: stage.revision, arm: 'candidate', operationId: input.operationId }) })
    assert.equal((await restarted.readPolicy('frontier')).policy.selectionThreshold, 65)
    assert.equal((await restarted.currentTarget(input.surface)).baselineRevision, target.baselineRevision)
    assert.equal((await documents.get(owner, 'knowledge', 'evolution-module-policy-frontier')).revision, 1)
    assert.equal((await restarted.currentTarget('capability-skill')).qualified, false)
    await assert.rejects(() => restarted.adapters.skill.publish({}), { code: 'campaign_runtime_scope_unsupported' })
  } finally {
    await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])', [[owner, publisher]])
    await database.close()
  }
})

test('an observation or policy failure never aborts the feed round, and corrupt candidate bytes fall back to the baseline', { skip: !url }, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 5, databaseConnectionTimeoutMs: 2000 })
  const owner = `rsi_isolation_${randomUUID().replaceAll('-', '')}`
  const publisher = `rsi_isolation_pub_${randomUUID().replaceAll('-', '')}`
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI isolation test','development'),($2,'RSI isolation publisher','development')", [owner, publisher])
    const documents = new ProductDocuments(database)
    await documents.put(owner, 'knowledge', 'evolution-module-policy-frontier', { status: 'active', policy: { selectionThreshold: 65 } }, { expectedRevision: 0 })
    const said = []
    const serving = createRsiServingAdapters({ config: { frontierModel: 'deepseek-flash', frontierSelectThreshold: 65 }, service: { owner: async () => owner }, database, documents, publicationOwnerId: publisher, report: code => said.push(code) })
    const target = await serving.currentTarget('frontier-selection')
    const stage = await serving.adapters.policy.publish({ operationId: 'isolation', surface: 'frontier-selection', phase: 'stage', files, expectedTarget: target })
    const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, genre: 'news', zh: false, score: i < 6 ? 70 : 90, selected: false, rule: null, safety: false, sourceId: `s${i}`, sourceCap: 3, eligible: true, summarized: true, besideSelected: false, eventId: null }))
    const input = { candidates, threshold: 65, events: {}, congressActive: false, preprintPlaces: 2, preprintMinScore: 60, genreFloors: [] }
    const halted = []
    const importer = { hasCampaign: async () => true, halt: async (operationId, reason) => { halted.push([operationId, reason]) },
      select: async () => ({ revision: stage.revision, arm: 'candidate', operationId: 'isolation', candidateDigest: stage.candidateDigest }) }
    serving.connectImporter(importer)
    // The journal refused the observation (for instance a record over the product payload limit): the round still selects.
    serving.setObservationReporter(async () => { throw Object.assign(new Error('A product record exceeds 256 KiB.'), { code: 'product_document_too_large' }) })
    assert.deepEqual(await serving.evaluateFrontierSelection(input, { executionId: 'mix-1', now: '2026-10-26' }), frontierMixSelect({ ...input, threshold: 80 }))
    // Resolving the policy failed: the caller's own selection.
    importer.select = async () => { throw new Error('lock timeout') }
    assert.deepEqual(await serving.evaluateFrontierSelection(input, { executionId: 'mix-2', now: '2026-10-26' }), frontierMixSelect(input))
    assert.deepEqual(serving.observationFailures(), { rsi_serving_observation_failed: 1, rsi_serving_policy_unavailable: 1 })
    assert.deepEqual(said, ['rsi_serving_observation_failed', 'rsi_serving_policy_unavailable'])
    assert.deepEqual(halted, [], 'an ordinary observation failure keeps the campaign')
    // A shadow candidate whose installed bytes changed is a corrupt generation: the operation is halted and the next read serves the baseline.
    await database.query("UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{files,0,content}','\"{\\\"selectionThreshold\\\":99}\"') WHERE user_id=$1 AND id=$2", [publisher, stage.revision])
    importer.select = async () => ({ revision: target.baselineRevision, shadowRevision: stage.revision, arm: 'control', operationId: 'isolation', candidateDigest: stage.candidateDigest })
    assert.deepEqual(await serving.evaluateFrontierSelection(input, { executionId: 'mix-3', now: '2026-10-26' }), frontierMixSelect(input))
    assert.deepEqual(halted, [['isolation', 'campaign_observation_unrecorded']])
    // Even with the bytes restored, the halted operation keeps serving the incumbent in this process until stopped durably.
    await database.query("UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{files,0,content}',to_jsonb($3::text)) WHERE user_id=$1 AND id=$2", [publisher, stage.revision, files[0].content])
    importer.select = async () => ({ revision: stage.revision, arm: 'candidate', operationId: 'isolation', candidateDigest: stage.candidateDigest })
    assert.equal((await serving.readPolicy('frontier')).policy.selectionThreshold, 65)
    importer.select = async () => ({ revision: stage.revision, arm: 'candidate', operationId: 'another-operation', candidateDigest: stage.candidateDigest })
    assert.equal((await serving.readPolicy('frontier')).policy.selectionThreshold, 80)
  } finally {
    await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])', [[owner, publisher]])
    await database.close()
  }
})
