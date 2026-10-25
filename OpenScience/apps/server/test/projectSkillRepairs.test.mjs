import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeManager } from '../src/runtimeManager.mjs'
import { AgentBayRuntimeProvider } from '../src/agentbay/runtimeProvider.mjs'
import { personalSkillRuntimeIdentity } from '../src/personalSkillRuntimeIdentity.mjs'
import { PersonalSkillGenerationService } from '../src/personalSkillGenerationService.mjs'
import { PersonalSkillGenerationWorker } from '../src/personalSkillGenerationWorker.mjs'
import { ExtensionGenerationService } from '../src/extensionGenerationService.mjs'

test('AgentBay image identity and actual launch environment carry frozen skill and client-plugin policies without Docker', async () => {
  const config = { runtimeProvider: 'agentbay', agentbayImageId: 'imgc-fixed-build', loopxEnabled: true }
  const manager = new RuntimeManager(config, { agentbayClient: {} })
  const identity = await personalSkillRuntimeIdentity(manager)
  assert.match(identity.baseRuntimeImageDigest, /^sha256:[a-f0-9]{64}$/)
  const provider = new AgentBayRuntimeProvider(manager, {})
  const policy = { disabled: ['office:docx'], disabledPlugins: ['annotation'] }
  const environment = provider.kernelEnvironment({ userId: 'owner' }, { gateways: {}, personalSkillGeneration: { platformSkills: policy }, pluginConfig: { revision: 0, enabled: true, settings: { timeoutMs: 15000 } } })
  assert.deepEqual(JSON.parse(environment.EVIMED_DISABLED_PLATFORM_SKILLS), policy.disabled)
  assert.deepEqual(JSON.parse(environment.EVIMED_DISABLED_CLIENT_BUNDLES), policy.disabledPlugins)
})

test('a policy replacement rebases the installed composite rather than dropping its plugin composition', async () => {
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 })
  const project = { id: 'paper', userId: 'owner' }
  const old = { projection: { plugins: [{ extensionId: 'installed-extension' }], personal: { reference: null, pins: [], platformSkills: { disabled: [] } } } }
  const selected = { reference: null, pins: [], platformSkills: { disabled: ['office:docx'] } }
  const rebased = { ...old, projection: { ...old.projection, personal: selected } }
  manager.syncCapsuleMethods = async () => ({ count: 0 })
  manager.personalSkillGenerations = { prepareForRuntime: async () => selected }
  manager.extensionGenerationResolver = async () => old
  manager.prepareGeneration = async () => ({ joined: true })
  manager.rebasePersonalComposite = async (_project, actual) => { assert.equal(actual, selected); return rebased }
  let observed
  manager.provider = { preflight: async () => {}, prepare: async (_project, input) => { observed = input; throw new Error('provider boundary') } }
  await assert.rejects(manager.startKernel(project), /provider boundary/)
  assert.equal(observed.extensionGeneration, rebased)
  assert.equal(observed.extensionGeneration.projection.plugins[0].extensionId, 'installed-extension')
})

/** An in-memory product document store with the revision check the real one makes. */
function memoryDocuments() {
  const rows = new Map(), puts = []
  return { rows, puts,
    async get(owner, kind, id) { return structuredClone(rows.get(`${owner}:${kind}:${id}`) ?? null) },
    async put(owner, kind, id, payload, options) {
      const key = `${owner}:${kind}:${id}`, old = rows.get(key)
      if ((old?.revision ?? 0) !== options.expectedRevision) throw Object.assign(new Error('conflict'), { code: 'product_revision_conflict' })
      const row = { id, payload: structuredClone(payload), revision: options.expectedRevision + 1 }
      rows.set(key, row); puts.push({ kind, id, payload: structuredClone(payload) }); return structuredClone(row)
    },
  }
}

test('a cold startup that cannot prepare the saved choices starts on the ordinary baseline and records them as not in effect', async () => {
  const project = { userId: 'owner', id: 'paper' }, selected = { revision: 4, payload: { skills: [], disabledPlatformSkills: ['office:docx'], disabledBuiltinPlugins: ['mermaid'] } }
  const documents = memoryDocuments()
  const effective = { reference: { generationHash: 'a'.repeat(64) }, selectionRevision: 2, platformSkills: { disabled: [] } }
  await documents.put('owner', 'extension-generation', 'personal-skills:project:paper', { phase: 'effective', runtimeGeneration: 'old', desired: effective, effective, lastGood: effective }, { expectedRevision: 0 })
  const service = new PersonalSkillGenerationService(null, { config: {}, skillService: { projectSelections: async () => selected, requireProject: async () => {} }, pluginService: {},
    resolveUser: async () => ({ id: project.userId }), identities: async () => ({}), documents })
  service.reconcile = async () => { throw Object.assign(new Error('storage full'), { code: 'extension_storage_capacity' }) }
  const started = await service.prepareForRuntime(project)
  assert.equal(started.reference, null, 'a choice that cannot be prepared never blocks the start')
  assert.deepEqual(started.pins, [])
  const recorded = (await service.current(project)).payload
  assert.equal(recorded.phase, 'waiting')
  assert.equal(recorded.error, 'runtime_composition_unavailable')
  assert.equal(recorded.desired.selectionRevision, 4)
  assert.equal(recorded.desired.reference, null)
  assert.deepEqual(recorded.desired.platformSkills, { disabled: ['office:docx'], disabledPlugins: ['mermaid'] })
  assert.deepEqual(recorded.effective, effective, 'the last proven generation is kept as it was')
  // The same refusal again writes nothing new.
  await service.prepareForRuntime(project)
  assert.equal(documents.puts.length, 2)
  // And a start whose recording itself fails still starts.
  service.recordUnavailable = async () => { throw new Error('database unavailable') }
  assert.equal((await service.prepareForRuntime(project)).reference, null)
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 })
  manager.personalSkillGenerations = service; manager.syncCapsuleMethods = async () => ({ count: 0 })
  let observed
  manager.provider = { preflight: async () => {}, prepare: async (_project, input) => { observed = input; throw new Error('provider boundary') } }
  await assert.rejects(manager.startKernel(project), /provider boundary/)
  assert.equal(observed.personalSkillGeneration.reference, null, 'the project starts on the ordinary baseline')
  // Even a preparation that throws outright (no state could be read) starts the project without optional bytes.
  service.prepareForRuntime = async () => { throw Object.assign(new Error('unavailable'), { preserveSkillPolicy: true }) }
  await assert.rejects(manager.startKernel(project), /provider boundary/)
  assert.equal(observed.personalSkillGeneration, null)
})

test('a failed proof of an optional preference restores the baseline and never stops the serving runtime', async () => {
  const project = { userId: 'owner', id: 'paper' }
  const candidate = { reference: { generationHash: 'b'.repeat(64) }, pins: [], selectionRevision: 5, platformSkills: { disabled: ['office:docx'], disabledPlugins: ['annotation'] } }
  const documents = memoryDocuments()
  await documents.put('owner', 'extension-generation', 'personal-skills:project:paper', { phase: 'waiting', runtimeGeneration: null, desired: candidate, effective: null, lastGood: null }, { expectedRevision: 0 })
  const finished = [], failed = []
  const client = { query: async text => ({ rows: /pg_try_advisory_xact_lock/.test(text) ? [{ acquired: true }] : [], rowCount: 0 }) }
  const database = { transaction: async work => work(client), withTransactionClient: async (_client, work) => work() }
  const job = { id: 'job', userId: 'owner', projectId: 'paper', leaseToken: 'lease', payload: { generationHash: candidate.reference.generationHash, selectionRevision: 5, accountCreatedAt: 'a', projectCreatedAt: 'p' } }
  const jobs = { claim: async () => job, renew: async () => true, finish: async (_user, _id, _lease, result) => { finished.push(result); return result },
    fail: async (_user, _id, _lease, error) => { failed.push(error) }, finishWithLease: async () => assert.fail('an unproven candidate is never marked effective') }
  const service = { jobs, database, documents, current: async () => documents.get('owner', 'extension-generation', 'personal-skills:project:paper'),
    resolveUser: async () => ({ id: 'owner' }), skills: { projectSelections: async () => ({ revision: 5 }) },
    plugins: { scope: async () => ({ accountCreatedAt: 'a', projectCreatedAt: 'p' }), hasPendingPrompts: async () => false } }
  const replaced = [], stopped = []
  const runtime = { runtimeGeneration: () => 'live', runtimePersonalSkillGeneration: () => null, pluginRuntimeBusy: async () => false,
    replacePersonalSkillRuntime: async (_project, value) => { replaced.push(value) },
    probePersonalSkillGeneration: async (_project, expected) => { if (expected.reference) throw new Error('native proof failed'); return { generation: 'baseline-runtime', pendingSession: false } },
    stop: async value => { stopped.push(value) } }
  const worker = new PersonalSkillGenerationWorker({ service, runtime, resolveProject: async () => project, ledgerBusy: async () => false })
  await worker.run()
  assert.deepEqual(stopped, [], 'a serving runtime is never stopped because an optional preference could not be proven')
  assert.equal(replaced.length, 2)
  assert.deepEqual(replaced[0], candidate)
  assert.equal(replaced[1].reference, null, 'the ordinary baseline replaces the unproven candidate')
  assert.deepEqual(failed, [])
  assert.equal(finished.at(-1).phase, 'failed')
  const state = (await service.current()).payload
  assert.equal(state.phase, 'failed')
  assert.equal(state.runtimeGeneration, 'baseline-runtime')
})

test('a refused composite rebase releases every temporary override before the next authoritative startup', async () => {
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 }), project = { id: 'paper', userId: 'owner' }
  manager.rebasePersonalComposite = async () => { throw new Error('plugin selection changed') }
  await assert.rejects(manager.replacePersonalSkillRuntime(project, { reference: { generationHash: 'old' } }), /plugin selection changed/)
  assert.equal(manager.personalSkillOverrides.has(manager.key(project)), false)
  assert.equal(manager.extensionGenerationOverrides.has(manager.key(project)), false)
  let observed = false
  manager.rebasePersonalComposite = null
  manager.syncCapsuleMethods = async () => ({ count: 0 })
  manager.personalSkillGenerations = { prepareForRuntime: async () => { observed = true; return null } }
  manager.provider = { preflight: async () => {}, prepare: async () => { throw new Error('provider boundary') } }
  await assert.rejects(manager.startKernel(project), /provider boundary/)
  assert.equal(observed, true)
})

test('a retired installer account is reauthorized through the owner, and unavailable owner authority still refuses', async () => {
  const actors = [], fake = {
    database: { transaction: async work => work({}), withTransactionClient: async (_client, work) => work() },
    current: async () => ({ payload: { effective: { reference: {}, scope: { actorId: 'retired-installer', actorAccountCreatedAt: 'old' } } } }),
    verifyManifest: async () => {},
    snapshot: async actor => { actors.push(actor.id); throw Object.assign(new Error('unavailable'), { status: actor.id === 'owner' ? 403 : 401 }) },
  }
  await assert.rejects(ExtensionGenerationService.prototype.rebasePersonal.call(fake, { id: 'paper', userId: 'owner' }, {}), { status: 403 })
  assert.deepEqual(actors, ['retired-installer', 'owner'])
})

test('a start never fails on a composite rebase: a refused or failed rebase starts with the personal generation alone, recorded', async () => {
  const project = { id: 'paper', userId: 'owner' }
  const personal = { reference: { generationHash: 'c'.repeat(64) }, pins: [], platformSkills: { disabled: ['office:docx'], disabledPlugins: [] } }
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 })
  manager.syncCapsuleMethods = async () => ({ count: 0 })
  manager.personalSkillGenerations = { prepareForRuntime: async () => personal }
  let observed
  manager.provider = { preflight: async () => {}, prepare: async (_project, input) => { observed = input; throw new Error('provider boundary') } }
  // The resolver has nothing to mount (a rolled-back or failed plugin apply): the desired plugins differ from the installed ones.
  manager.extensionGenerationResolver = async () => null
  const calls = []
  manager.rebasePersonalComposite = async (_project, candidate, options) => { calls.push(options); throw Object.assign(new Error('Project plugins changed before the skill update.'), { status: 409, code: 'product_revision_conflict' }) }
  await assert.rejects(manager.startKernel(project), /provider boundary/)
  assert.deepEqual(calls, [{ whenUnchanged: true }], 'a start asks for a rebase only of an unchanged plugin selection')
  assert.equal(observed.extensionGeneration, null)
  assert.equal(observed.personalSkillGeneration, personal)
  assert.equal(manager.startFindingCounts.get('extension_composite_rebase_failed'), 1)
  assert.equal(manager.lastStartFindings.get(manager.key(project)).cause, 'product_revision_conflict')
  // An installed composite stamped with other personal skills: its rebase fails and the extension waits, the start goes on.
  manager.extensionGenerationResolver = async () => ({ projection: { plugins: [], personal: { reference: null, pins: [{ skillId: 'old', revision: 1, digest: 'sha256:x' }] } } })
  manager.prepareGeneration = async () => ({})
  await assert.rejects(manager.startKernel(project), /provider boundary/)
  assert.equal(observed.extensionGeneration, null)
  assert.equal(observed.personalSkillGeneration, personal)
  assert.equal(manager.startFindingCounts.get('extension_composite_rebase_failed'), 2)
  // A rebase that answers nothing (the selection changed) is no failure either.
  manager.rebasePersonalComposite = async () => null
  await assert.rejects(manager.startKernel(project), /provider boundary/)
  assert.equal(observed.extensionGeneration, null)
  assert.equal(manager.startFindingCounts.get('extension_composite_rebase_failed'), 2)
})

test('a shared 循证 GEO context start never rebases or publishes a composite it would discard', async () => {
  const project = { id: 'geo', userId: 'owner' }
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 })
  manager.contextPolicyFor = async () => ({ kind: 'geo-project' })
  manager.prepareSharedContext = async () => ({ mounted: { count: 0 } })
  manager.personalSkillOverrides.set(manager.key(project), { reference: { generationHash: 'd'.repeat(64) }, pins: [] })
  manager.extensionGenerationResolver = async () => assert.fail('a shared context resolves no extension')
  let rebased = false
  manager.rebasePersonalComposite = async () => { rebased = true; return { projection: { plugins: [], personal: {} } } }
  manager.provider = { preflight: async () => {}, prepare: async () => { throw new Error('provider boundary') } }
  await manager.startKernel(project).catch(() => null)
  assert.equal(rebased, false)
})

test('a rebase asked for at a start answers nothing when the selected plugins differ from the installed ones', async () => {
  const installed = { reference: {}, scope: { actorId: 'owner', actorAccountCreatedAt: 'a' }, projection: { plugins: [{ extensionId: 'kept' }] }, bindings: { installations: [] } }
  const fake = {
    database: { transaction: async work => work({}), withTransactionClient: async (_client, work) => work() },
    current: async () => ({ payload: { effective: installed } }), verifyManifest: async () => {},
    snapshot: async () => ({ manifest: { projection: { plugins: [{ extensionId: 'rejected' }] }, bindings: { installations: [] }, findings: [] }, qualification: null }),
    publish: async () => assert.fail('nothing is published for a changed selection'),
  }
  assert.equal(await ExtensionGenerationService.prototype.rebasePersonal.call(fake, { id: 'paper', userId: 'owner' }, null, { whenUnchanged: true }), null)
  await assert.rejects(ExtensionGenerationService.prototype.rebasePersonal.call(fake, { id: 'paper', userId: 'owner' }, null), { status: 409 })
})

test('a generation is published without a disabled id the platform no longer ships, and the proof never fails on one', async () => {
  const { selectPersonalSkillMounts } = await import('../src/personalSkillMount.mjs')
  const user = { id: 'owner' }, project = { id: 'paper', userId: 'owner' }
  const selection = { revision: 3, payload: { skills: [], disabledPlatformSkills: ['community:gone', 'office:docx'], disabledBuiltinPlugins: [] } }
  const service = { requireProject: async () => {}, projectSelections: async () => selection, platformSkillIds: async () => new Set(['office:docx', 'office:xlsx']) }
  const selected = await selectPersonalSkillMounts({ service, user, project })
  assert.deepEqual(selected.platformSkills.disabled, ['office:docx'])
  assert.deepEqual(selected.findings, [{ platformSkillId: 'community:gone', code: 'platform_skill_stale' }])
  // A list that cannot be read keeps the saved ids, and the runtime proof tolerates one it does not list.
  service.platformSkillIds = async () => null
  assert.deepEqual((await selectPersonalSkillMounts({ service, user, project })).platformSkills.disabled, ['community:gone', 'office:docx'])
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 })
  const expected = { reference: { generationHash: 'e'.repeat(64) }, pins: [], platformSkills: { disabled: ['community:gone', 'office:docx'] } }
  manager.runtimes.set(manager.key(project), { modelGatewayTokenJti: 'live', personalSkillGeneration: expected })
  let listed = [{ name: 'docx', invocation: { userInvocable: false, modelInvocable: false } }]
  manager.callKernel = async (_runtime, _project, method) => method === 'session/list' ? { items: [{ sessionId: 's1' }] }
    : method === 'skills/list' ? { skills: [] } : method === 'evimedSkills/list' ? { complete: true, items: listed } : assert.fail(method)
  const proof = await manager.probePersonalSkillGeneration(project, expected)
  assert.equal(proof.pendingSession, false)
  assert.deepEqual(proof.absentDisabled, ['community:gone'])
  // A skill the runtime lists and still serves is a failed proof, as before.
  listed = [{ name: 'docx', invocation: { userInvocable: true, modelInvocable: false } }]
  await assert.rejects(manager.probePersonalSkillGeneration(project, expected), { status: 502 })
})
