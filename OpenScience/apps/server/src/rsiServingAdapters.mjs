import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProductDocuments } from './productStore.mjs'
import { migrateProductStore } from './productPersistence.mjs'
import { HttpError } from './security.mjs'
import { rsiDigest } from './rsiCampaignBundle.mjs'
import { computeRsiDependencyClosure } from './rsiDependencyClosure.mjs'
import { validateModuleEvolutionPolicy } from './moduleEvolutionPolicies.mjs'
import { frontierSelectThreshold } from './frontierPipeline.mjs'
import { frontierMixSelect, PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain'
import { AUTOPILOT_PLANNER_INSTRUCTIONS } from './autopilotNextAction.mjs'

const components = Object.freeze({
  'frontier-selection': ['frontier', 'selectionThreshold'],
  'frontier-screen': ['frontier', 'screenInstructions'],
  'frontier-edit': ['frontier', 'editInstructions'],
  'autopilot-planner': ['autopilot', 'plannerInstructions'],
  'geo-supplements': ['geo', 'supplements'],
})
/** @param {string} code */
function refuse(code) { throw new HttpError(409, code, 'Campaign serving adapter refused.') }
/** A campaign supplies exactly one component; guardrails and neighbouring components are deployment-owned.
 * @param {string} surface @param {any} files */
export function parseRsiPolicyCandidate(surface, files) {
  const component = components[surface]
  if (!component || !Array.isArray(files) || files.length !== 1 || files[0]?.path !== 'policy.json' || typeof files[0]?.content !== 'string') refuse('campaign_policy_shape_invalid')
  let policy
  try { policy = JSON.parse(files[0].content) } catch { refuse('campaign_policy_shape_invalid') }
  if (!validateModuleEvolutionPolicy(component[0], policy) || Object.keys(policy).length !== 1 || !Object.hasOwn(policy, component[1])) refuse('campaign_policy_shape_invalid')
  return policy
}
/** Immutable inactive versions and phase-specific durable publication receipts. Candidate code is never imported.
 * @param {{config:any,service:any,documents?:any,database:any,supply?:any,store?:any,runtimeManager?:any,sourceChanges?:any,publicationOwnerId?:string,report?:(code:string)=>void}} dependencies */
export function createRsiServingAdapters({ config, service, database, documents = new ProductDocuments(database), publicationOwnerId = PLATFORM_PUBLISHER_USER_ID, report = () => {} }) {
  let importer = /** @type {any} */ (null)
  let observationReporter = /** @type {any} */ (null)
  /** @type {Record<string, number>} closed failure code -> count */
  const failures = Object.create(null)
  /** @param {string} code */
  const failed = code => { failures[code] = (failures[code] ?? 0) + 1; report(code) }
  // Operations whose critical observation could not be recorded: served the incumbent here until stopped durably.
  const halted = new Set()
  const rootDir = config.rootDir ?? fileURLToPath(new URL('../../../', import.meta.url))
  const defaults = (/** @type {string} */ moduleId) => moduleId === 'frontier' ? { selectionThreshold: frontierSelectThreshold(config) }
    : moduleId === 'autopilot' ? { plannerInstructions: AUTOPILOT_PLANNER_INSTRUCTIONS } : { supplements: [] }
  const owner = () => publicationOwnerId
  const id = (/** @type {any[]} */ values) => `rsi-serving:${rsiDigest(values)}`
  /** @param {any} client @param {string} recordId @param {string} [recordOwner] */
  async function read(client, recordId, recordOwner = publicationOwnerId) {
    const result = await client.query("SELECT payload, revision FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND id=$2 AND deleted_at IS NULL", [recordOwner, recordId])
    return result.rows[0] ?? null
  }
  /** @param {any} client @param {string} recordId @param {any} payload */
  async function insert(client, recordId, payload) {
    await documents.put(await owner(), 'knowledge', recordId, payload, { expectedRevision: 0, transactionClient: client })
  }
  /** Every publisher takes the same fence. An importer transaction is reused, never nested.
   * @param {any} client @param {(client:any)=>Promise<any>} operation */
  async function fenced(client, operation) {
    if (client) return operation(client)
    await migrateProductStore(database)
    return database.transaction(async transactionClient => {
      await transactionClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rsi-activation:${await owner()}`])
      return operation(transactionClient)
    })
  }
  /** Actual incumbent includes legacy active policy, otherwise the consumer's code defaults.
   * @param {string} moduleId @param {any} client */
  async function incumbent(moduleId, client) {
    const row = await read(client, `evolution-module-policy-${moduleId}`, await service.owner())
    const base = defaults(moduleId)
    if (row?.payload.status === 'active' && validateModuleEvolutionPolicy(moduleId, row.payload.policy)) {
      return { revisionId: `evolution-module-policy-${moduleId}:${row.revision}`, policy: { ...base, ...row.payload.policy } }
    }
    return { revisionId: `default:${rsiDigest(base)}`, policy: base }
  }
  /** @param {string} surface @param {any} client */
  async function currentTarget(surface, client) {
    return fenced(client, async transactionClient => {
      const component = components[surface]
      if (!component) return { surface, qualified: false, dependencyDigest: null, baselineRevision: null, issues: ['campaign_serving_scope_unsupported'] }
      const closure = await computeRsiDependencyClosure({ rootDir: path.resolve(rootDir), surface,
        settings: { model: config.frontierModel ?? config.deepseekModel, provider: 'deepseek' } })
      const baseline = await incumbent(component[0], transactionClient)
      return { surface, ...closure, baselineRevision: baseline.revisionId }
    })
  }
  /** @param {any} input @param {any} client */
  async function inspect(input, client = input.transactionClient) {
    return fenced(client, async transactionClient => {
      const row = await read(transactionClient, id(['receipt', input.operationId, input.surface, input.phase]))
      if (!row) return null
      const version = await read(transactionClient, row.payload.revision)
      if (!version || version.payload.candidateDigest !== row.payload.candidateDigest || rsiDigest(version.payload.files) !== row.payload.candidateDigest) refuse('campaign_installed_bytes_changed')
      parseRsiPolicyCandidate(input.surface, version.payload.files)
      return row.payload
    })
  }
  const policy = {
    inspect,
    /** @param {any} input */
    async publish(input) {
      return fenced(input.transactionClient, async client => {
        if (!['stage', 'activate'].includes(input.phase)) refuse('campaign_publication_phase_invalid')
        if (typeof input.operationId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.operationId)) refuse('campaign_publication_identity_invalid')
        const previous = await inspect(input, client)
        if (previous) {
          if (input.files && rsiDigest(input.files) !== previous.candidateDigest || input.revision && input.revision !== previous.revision) refuse('campaign_publication_identity_conflict')
          return previous
        }
        const target = await currentTarget(input.surface, client)
        if (!target.qualified || target.dependencyDigest !== input.expectedTarget?.dependencyDigest || target.baselineRevision !== input.expectedTarget?.baselineRevision) refuse('campaign_target_changed')
        let version
        if (input.phase === 'stage') {
          const parsed = parseRsiPolicyCandidate(input.surface, input.files)
          const candidateDigest = rsiDigest(input.files)
          const revision = id(['version', input.operationId, input.surface, candidateDigest])
          version = { revision, candidateDigest, files: input.files, policy: parsed, surface: input.surface, operationId: input.operationId }
          await insert(client, revision, { ...version, recordType: 'rsi-serving-version' })
        } else {
          // Activation only admits this immutable revision to importer selection. It never rewrites the incumbent.
          const staged = await inspect({ ...input, phase: 'stage' }, client)
          if (!staged || staged.revision !== input.revision) refuse('campaign_stage_missing')
          version = (await read(client, staged.revision)).payload
        }
        const receipt = { installed: true, phase: input.phase, operationId: input.operationId, candidateDigest: version.candidateDigest, revision: version.revision, recordType: 'rsi-serving-receipt' }
        await insert(client, id(['receipt', input.operationId, input.surface, input.phase]), receipt)
        return receipt
      })
    },
    /** Removing admission is importer-owned; incumbent bytes were never overwritten. @param {any} input */
    async rollback(input) {
      return fenced(input.transactionClient, async client => {
        const target = await currentTarget(input.surface, client)
        if (!target.qualified || target.dependencyDigest !== input.dependencyDigest || target.baselineRevision !== input.revision) refuse('campaign_rollback_incompatible')
        const candidate = await read(client, input.expectedRevision)
        if (!candidate || candidate.payload.surface !== input.surface) refuse('campaign_rollback_identity_invalid')
        const revokedId = id(['revoked', input.surface, input.expectedRevision])
        if (!await read(client, revokedId)) await insert(client, revokedId, { revision: input.expectedRevision, recordType: 'rsi-serving-revocation' })
        const receipt = { installed: true, operationId: input.operationId, revision: input.revision, dependencyDigest: input.dependencyDigest }
        const receiptId = id(['rollback', input.operationId, input.surface])
        const previous = await read(client, receiptId)
        if (previous && rsiDigest(previous.payload) !== rsiDigest(receipt)) refuse('campaign_publication_identity_conflict')
        if (!previous) await insert(client, receiptId, receipt)
        return receipt
      })
    },
  }
  /** @param {string} moduleId @param {any} context */
  async function readPolicy(moduleId, context = {}) {
    const surface = Object.keys(components).find(key => components[key][0] === moduleId && (moduleId !== 'frontier' || key === 'frontier-selection'))
    // No campaign on this surface: an ordinary read, never the publication fence.
    if (!importer || !surface || importer.hasCampaign && !await importer.hasCampaign(surface)) { await migrateProductStore(database); return incumbent(moduleId, database) }
    const baseline = await fenced(null, client => incumbent(moduleId, client))
    const selection = await importer.select(surface, context)
    if (selection.operationId && halted.has(selection.operationId)) return baseline
    // Null is an explicit refusal of an unsafe pointer. No legacy fallback may revive it.
    if (!selection.revision) return { revisionId: `default:${rsiDigest(defaults(moduleId))}`, policy: defaults(moduleId) }
    if (selection.revision === baseline.revisionId) return { ...baseline, selection }
    const revoked = await fenced(null, client => read(client, id(['revoked', surface, selection.revision])))
    if (revoked) return baseline
    const version = await fenced(null, client => read(client, selection.revision))
    if (!version || version.payload.surface !== surface || rsiDigest(version.payload.files) !== version.payload.candidateDigest) return baseline
    return { revisionId: selection.revision, policy: { ...baseline.policy, ...parseRsiPolicyCandidate(surface, version.payload.files) }, selection }
  }
  /** Same frozen pool, actual selector, incumbent-only publication for a shared feed.
   * @param {any} input @param {any} context */
  async function evaluateFrontierSelection(input, context = {}) {
    const frozen = structuredClone(input)
    if (!importer) return frontierMixSelect(frozen)
    // The feed's round never depends on the campaign layer staying healthy: any failure here is counted under a
    // closed code and the round gets a selection — the caller's own input when no policy could be resolved.
    let admitted
    try { admitted = await readPolicy('frontier', context) } catch { failed('rsi_serving_policy_unavailable'); return frontierMixSelect(frozen) }
    const selection = admitted.selection
    const result = frontierMixSelect({ ...frozen, threshold: admitted.policy.selectionThreshold })
    if (!selection?.operationId) return result
    let witness, incumbentResult
    try {
      ({ witness, incumbentResult } = await observedSelection(frozen, selection, context, result))
    } catch (error) {
      failed('rsi_serving_witness_unavailable')
      if (error?.code === 'campaign_installed_bytes_changed') await halt(selection.operationId)
      return result
    }
    if (!witness) return result
    try {
      await fenced(null, async client => { if (!await read(client, witness.id)) await insert(client, witness.id, { ...witness, recordType: 'rsi-consumer-witness' }) })
      if (observationReporter) await observationReporter(witness)
    } catch {
      failed('rsi_serving_observation_failed')
      // A regression the campaign never heard of must not keep its candidate serving: fail safe to the incumbent.
      if (witness.outcome === 'critical') await halt(selection.operationId)
    }
    return witness.outcome === 'critical' ? incumbentResult : result
  }
  /** @param {string} operationId */
  async function halt(operationId) {
    halted.add(operationId)
    try { await importer?.halt?.(operationId, 'campaign_observation_unrecorded') } catch { failed('rsi_serving_halt_unrecorded') }
  }
  /** Same frozen pool, actual selector: the witness of one execution, or none when there is nothing to observe.
   * @param {any} frozen @param {any} selection @param {any} context @param {any} result */
  async function observedSelection(frozen, selection, context, result) {
    const candidateRevision = selection.shadowRevision ?? (selection.arm === 'candidate' ? selection.revision : null)
    const consumerTarget = await currentTarget('frontier-selection', null)
    if (!consumerTarget.qualified) return {}
    let version, candidateResult = result
    if (candidateRevision) {
      const revoked = await fenced(null, client => read(client, id(['revoked', 'frontier-selection', candidateRevision])))
      if (revoked) return {}
      version = await fenced(null, client => read(client, candidateRevision))
      if (!version || version.payload.surface !== 'frontier-selection' || rsiDigest(version.payload.files) !== version.payload.candidateDigest) refuse('campaign_installed_bytes_changed')
      const candidate = parseRsiPolicyCandidate('frontier-selection', version.payload.files)
      if (selection.shadowRevision) candidateResult = frontierMixSelect({ ...structuredClone(frozen), threshold: candidate.selectionThreshold })
    }
    // A control observation must still bind the candidate under observation. The
    // importer supplies its immutable identity, never the model or the client.
    const candidateDigest = version?.payload.candidateDigest ?? selection.candidateDigest
    if (!candidateDigest) return {}
    const baseline = await fenced(null, client => incumbent('frontier', client))
    const incumbentResult = frontierMixSelect({ ...structuredClone(frozen), threshold: baseline.policy.selectionThreshold })
    const protectedIds = new Set(frozen.candidates.filter(row => row.safety).map(row => row.id))
    const candidateIds = new Set(candidateResult.picks.map(row => row.id))
    const regression = incumbentResult.picks.some(row => protectedIds.has(row.id) && !candidateIds.has(row.id))
    const arm = selection.shadowRevision ? 'shadow' : selection.arm
    const witness = { id: `rsi-witness:${rsiDigest([selection.operationId, selection.stageIndex ?? 0, context.executionId, frozen])}`, operationId: selection.operationId,
      candidateDigest, revision: candidateRevision ?? selection.revision, arm, outcome: regression ? 'critical' : 'ok',
      ...(regression ? { criticalCode: 'deterministic-regression' } : {}), stageIndex: selection.stageIndex ?? 0,
      day: new Date(context.now ?? Date.now()).toISOString().slice(0, 10), inputHash: rsiDigest(frozen),
      consumerDigest: consumerTarget.dependencyDigest,
      consumerSourceDigest: rsiDigest(consumerTarget.entries.filter(entry => ['apps/server/src/frontierPipeline.mjs', 'packages/domain/src/frontierMix.mjs'].includes(entry.path))),
      incumbentRevision: baseline.revisionId, incumbentResultDigest: rsiDigest(incumbentResult), candidateResultDigest: rsiDigest(candidateResult),
      incumbentPicks: incumbentResult.picks.length, candidatePicks: candidateResult.picks.length }
    return { witness, incumbentResult }
  }

  const unsupported = { async publish() { refuse('campaign_runtime_scope_unsupported') }, async inspect() { return null }, async rollback() { refuse('campaign_runtime_scope_unsupported') } }
  return { publicationOwnerId, currentTarget, evaluateFrontierSelection,
    /** Counts by closed code of what the serving path could not do; selection went on each time. */
    observationFailures: () => ({ ...failures }),
    /** @param {any} reporter */ setObservationReporter(reporter) { observationReporter = reporter },
    /** A submitted model assertion cannot become a witness. @param {any} proof @param {any} row @param {{transactionClient?:any}} [options] */
    async verifyObservation(proof, row, options = {}) {
      if (!proof?.id) return null
      const stored = await read(options.transactionClient ?? database, proof.id)
      return stored?.payload.operationId === row.operationId ? stored.payload : null
    },
    adapters: { policy, skill: unsupported, 'isolated-tool': unsupported }, readPolicy,
    /** @param {any} value */ connectImporter(value) { importer = value },
    /** @param {string} moduleId @param {any} _defaults @param {any} context */
    async resolvePolicy(moduleId, _defaults, context = {}) { return readPolicy(moduleId, context) },
  }
}
